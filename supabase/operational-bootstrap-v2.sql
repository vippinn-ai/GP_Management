-- Additive, read-only critical bootstrap for the operational performance rollout.
-- It never accepts actor or tenant input and never reads public.app_state.data.

create or replace function public.load_operational_bootstrap_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_profile jsonb;
  v_organization_id text;
  v_organization jsonb;
  v_membership_count integer;
  v_membership_role text;
  v_result jsonb;
begin
  if v_actor_id is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication is required.';
  end if;

  select jsonb_build_object(
    'id', profile.id,
    'name', profile.name,
    'username', profile.username,
    'role', profile.role,
    'active', profile.active,
    'tabPermissions', profile.tab_permissions
  )
  into v_actor_profile
  from public.profiles as profile
  where profile.id = v_actor_id;

  if v_actor_profile is null or coalesce((v_actor_profile ->> 'active')::boolean, false) is not true then
    return jsonb_build_object(
      'contract_version', 1,
      'status', 'inactive-or-missing',
      'actor_id', v_actor_id::text
    );
  end if;

  select count(*), min(organization.id), min(membership.role::text)
  into v_membership_count, v_organization_id, v_membership_role
  from public.organization_members as membership
  join public.organizations as organization
    on organization.id = membership.organization_id
   and organization.active = true
  where membership.user_id = v_actor_id
    and membership.active = true;

  if v_membership_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = 'Operational bootstrap organization access is ambiguous.',
      detail = jsonb_build_object(
        'code', 'bootstrap_organization_ambiguous',
        'active_memberships', v_membership_count
      )::text;
  end if;

  if v_membership_role is distinct from (v_actor_profile ->> 'role') then
    raise exception using
      errcode = 'P0001',
      message = 'Operational bootstrap role assignment is inconsistent.',
      detail = jsonb_build_object('code', 'bootstrap_role_mismatch')::text;
  end if;

  select jsonb_build_object(
    'id', organization.id,
    'name', organization.name,
    'business_profile', organization.business_profile
  )
  into strict v_organization
  from public.organizations as organization
  where organization.id = v_organization_id
    and organization.active = true;

  if (select count(*) from public.organization_members where organization_id = v_organization_id) > 100
    or (select count(*) from public.inventory_categories where organization_id = v_organization_id) > 100
    or (select count(*) from public.stations where organization_id = v_organization_id) > 100
    or (select count(*) from public.pricing_rules where organization_id = v_organization_id) > 500
    or (select count(*) from public.inventory_items where organization_id = v_organization_id) > 2000
    or (select count(*) from public.sale_variants where organization_id = v_organization_id) > 5000
    or (select count(*) from public.combos where organization_id = v_organization_id) > 1000
    or (select count(*) from public.combo_station_targets where organization_id = v_organization_id) > 5000
    or (select count(*) from public.combo_fixed_items where organization_id = v_organization_id) > 5000
    or (select count(*) from public.combo_choice_groups where organization_id = v_organization_id) > 5000
    or (select count(*) from public.combo_choice_options where organization_id = v_organization_id) > 10000
    or (
      select count(*)
      from public.sessions
      where organization_id = v_organization_id
        and (status <> 'closed' or (status = 'closed' and close_disposition = 'hopped' and closed_bill_id is null))
    ) > 500
    or (select count(*) from public.session_pause_logs where organization_id = v_organization_id and session_id in (
      select id from public.sessions where organization_id = v_organization_id
        and (status <> 'closed' or (status = 'closed' and close_disposition = 'hopped' and closed_bill_id is null))
    )) > 5000
    or (select count(*) from public.session_items where organization_id = v_organization_id and session_id in (
      select id from public.sessions where organization_id = v_organization_id
        and (status <> 'closed' or (status = 'closed' and close_disposition = 'hopped' and closed_bill_id is null))
    )) > 5000
    or (select count(*) from public.session_combo_applications where organization_id = v_organization_id and session_id in (
      select id from public.sessions where organization_id = v_organization_id
        and (status <> 'closed' or (status = 'closed' and close_disposition = 'hopped' and closed_bill_id is null))
    )) > 5000
    or (select count(*) from public.customer_tabs where organization_id = v_organization_id and status = 'open') > 500
    or (select count(*) from public.customer_tab_items where organization_id = v_organization_id and customer_tab_id in (
      select id from public.customer_tabs where organization_id = v_organization_id and status = 'open'
    )) > 5000
    or (select count(*) from public.customer_tab_combo_applications where organization_id = v_organization_id and customer_tab_id in (
      select id from public.customer_tabs where organization_id = v_organization_id and status = 'open'
    )) > 5000
  then
    raise exception using
      errcode = 'P0001',
      message = 'Operational bootstrap exceeded a safe collection limit.',
      detail = jsonb_build_object('code', 'bootstrap_collection_limit_exceeded')::text;
  end if;

  -- Keep the compatibility field in the fixed wire contract, but do not ship
  -- duplicated or QA-only legacy JSON. Every mapper-consumed value below has
  -- a validated normalized column or normalized child collection.
  v_result := jsonb_build_object(
    'contract_version', 1,
    'status', 'active',
    'actor_id', v_actor_id::text,
    'organization_id', v_organization_id,
    'actor_profile', v_actor_profile,
    'organization', v_organization,
    'app_state_metadata', coalesce((
      select jsonb_build_object('version', state.version, 'updated_at', state.updated_at)
      from public.app_state as state
      where state.id = 'primary'
    ), jsonb_build_object('version', 0, 'updated_at', null)),
    'profiles', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.name, row_data.id)
      from (
        select membership.organization_id, profile.id, profile.name, profile.username, profile.role, profile.active,
          profile.tab_permissions as "tabPermissions"
        from public.organization_members as membership
        join public.profiles as profile on profile.id = membership.user_id
        where membership.organization_id = v_organization_id
        order by profile.name, profile.id
      ) as row_data
    ), '[]'::jsonb),
    'inventory_categories', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.name)
      from (
        select category.organization_id, category.name
        from public.inventory_categories as category
        where category.organization_id = v_organization_id
        order by category.name
      ) as row_data
    ), '[]'::jsonb),
    'stations', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.name, row_data.id)
      from (
        select station.organization_id, station.id, station.name, station.mode, station.active, station.ltp_enabled, station.notes,
          '{}'::jsonb as raw_data
        from public.stations as station
        where station.organization_id = v_organization_id
        order by station.name, station.id
      ) as row_data
    ), '[]'::jsonb),
    'pricing_rules', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.station_id, row_data.start_minute, row_data.id)
      from (
        select rule.organization_id, rule.id, rule.station_id, rule.label, rule.start_minute, rule.end_minute, rule.hourly_rate,
          '{}'::jsonb as raw_data
        from public.pricing_rules as rule
        where rule.organization_id = v_organization_id
        order by rule.station_id, rule.start_minute, rule.id
      ) as row_data
    ), '[]'::jsonb),
    'inventory_items', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.category, row_data.name, row_data.id)
      from (
        select item.organization_id, item.id, item.name, item.category, item.price, item.stock_qty, item.low_stock_threshold,
          item.unit, item.is_reusable, item.barcode, item.active, item.archived_at,
          item.archived_by_user_id, item.archive_reason, item.sell_base_item, item.cigarette_pack,
          '{}'::jsonb as raw_data
        from public.inventory_items as item
        where item.organization_id = v_organization_id
        order by item.category, item.name, item.id
      ) as row_data
    ), '[]'::jsonb),
    'sale_variants', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.inventory_item_id, row_data.name, row_data.id)
      from (
        select variant.organization_id, variant.inventory_item_id, variant.id, variant.name, variant.price,
          variant.stock_units_per_sale, variant.barcode, variant.active, '{}'::jsonb as raw_data
        from public.sale_variants as variant
        where variant.organization_id = v_organization_id
        order by variant.inventory_item_id, variant.name, variant.id
      ) as row_data
    ), '[]'::jsonb),
    'combos', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.name, row_data.id)
      from (
        select combo.organization_id, combo.id, combo.name, combo.type, combo.active, combo.price,
          combo.included_minutes, '{}'::jsonb as raw_data, combo.created_at, combo.updated_at
        from public.combos as combo
        where combo.organization_id = v_organization_id
        order by combo.name, combo.id
      ) as row_data
    ), '[]'::jsonb),
    'combo_station_targets', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.combo_id, row_data.station_id)
      from (
        select target.organization_id, target.combo_id, target.station_id
        from public.combo_station_targets as target
        where target.organization_id = v_organization_id
        order by target.combo_id, target.station_id
      ) as row_data
    ), '[]'::jsonb),
    'combo_fixed_items', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.combo_id, row_data.created_at, row_data.id)
      from (
        select fixed.organization_id, fixed.combo_id, fixed.id, fixed.sellable_option_id, fixed.quantity,
          '{}'::jsonb as raw_data, fixed.created_at
        from public.combo_fixed_items as fixed
        where fixed.organization_id = v_organization_id
        order by fixed.combo_id, fixed.created_at, fixed.id
      ) as row_data
    ), '[]'::jsonb),
    'combo_choice_groups', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.combo_id, row_data.created_at, row_data.id)
      from (
        select choice_group.organization_id, choice_group.combo_id, choice_group.id, choice_group.label,
          choice_group.required_quantity, '{}'::jsonb as raw_data, choice_group.created_at
        from public.combo_choice_groups as choice_group
        where choice_group.organization_id = v_organization_id
        order by choice_group.combo_id, choice_group.created_at, choice_group.id
      ) as row_data
    ), '[]'::jsonb),
    'combo_choice_options', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.combo_id, row_data.choice_group_id, row_data.option_id)
      from (
        select choice_option.organization_id, choice_option.combo_id, choice_option.choice_group_id, choice_option.option_id
        from public.combo_choice_options as choice_option
        where choice_option.organization_id = v_organization_id
        order by choice_option.combo_id, choice_option.choice_group_id, choice_option.option_id
      ) as row_data
    ), '[]'::jsonb),
    'sessions', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.started_at desc, row_data.id desc)
      from (
        select session.organization_id, session.id, session.station_id, session.station_name_snapshot, session.mode,
          session.started_at, session.ended_at, session.status, session.customer_id,
          session.customer_name, session.customer_phone, session.play_mode, session.ltp_eligible,
          session.ltp_outcome, session.ltp_discount_applied, session.pricing_snapshot,
          session.pause_log_ids, session.continued_from_session_ids, session.closed_bill_id,
          session.close_disposition, session.close_reason, '{}'::jsonb as raw_data, session.created_at
        from public.sessions as session
        where session.organization_id = v_organization_id
          and (session.status <> 'closed' or (session.status = 'closed' and session.close_disposition = 'hopped' and session.closed_bill_id is null))
        order by session.started_at desc, session.id desc
      ) as row_data
    ), '[]'::jsonb),
    'session_pause_logs', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.session_id, row_data.paused_at, row_data.id)
      from (
        select pause.organization_id, pause.id, pause.session_id, pause.paused_at, pause.resumed_at,
          '{}'::jsonb as raw_data, pause.created_at
        from public.session_pause_logs as pause
        where pause.organization_id = v_organization_id
          and pause.session_id in (
            select session.id from public.sessions as session
            where session.organization_id = v_organization_id
              and (session.status <> 'closed' or (session.status = 'closed' and session.close_disposition = 'hopped' and session.closed_bill_id is null))
          )
        order by pause.session_id, pause.paused_at, pause.id
      ) as row_data
    ), '[]'::jsonb),
    'session_items', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.session_id, row_data.added_at, row_data.id)
      from (
        select item.organization_id, item.session_id, item.id, item.inventory_item_id, item.name, item.quantity,
          item.unit_price, item.added_at, item.sold_as_pack_of, item.sale_variant_id,
          item.stock_units_per_sale, item.combo_application_id, item.combo_id, '{}'::jsonb as raw_data, item.created_at
        from public.session_items as item
        where item.organization_id = v_organization_id
          and item.session_id in (
            select session.id from public.sessions as session
            where session.organization_id = v_organization_id
              and (session.status <> 'closed' or (session.status = 'closed' and session.close_disposition = 'hopped' and session.closed_bill_id is null))
          )
        order by item.session_id, item.added_at, item.id
      ) as row_data
    ), '[]'::jsonb),
    'session_combo_applications', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.session_id, row_data.applied_at, row_data.id)
      from (
        select applied.organization_id, applied.session_id, applied.id, applied.combo_id, applied.combo_name, applied.price,
          applied.included_minutes, applied.applied_at, applied.fixed_items, applied.choices,
          '{}'::jsonb as raw_data, applied.created_at
        from public.session_combo_applications as applied
        where applied.organization_id = v_organization_id
          and applied.session_id in (
            select session.id from public.sessions as session
            where session.organization_id = v_organization_id
              and (session.status <> 'closed' or (session.status = 'closed' and session.close_disposition = 'hopped' and session.closed_bill_id is null))
          )
        order by applied.session_id, applied.applied_at, applied.id
      ) as row_data
    ), '[]'::jsonb),
    'customer_tabs', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.opened_at desc, row_data.id desc)
      from (
        select tab.organization_id, tab.id, tab.customer_id, tab.customer_name, tab.customer_phone, tab.status,
          tab.opened_at, tab.closed_at, tab.continued_from_session_ids, tab.closed_bill_id,
          tab.close_disposition, tab.close_reason, '{}'::jsonb as raw_data, tab.created_at
        from public.customer_tabs as tab
        where tab.organization_id = v_organization_id and tab.status = 'open'
        order by tab.opened_at desc, tab.id desc
      ) as row_data
    ), '[]'::jsonb),
    'customer_tab_items', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.customer_tab_id, row_data.added_at, row_data.id)
      from (
        select item.organization_id, item.customer_tab_id, item.id, item.inventory_item_id, item.name, item.quantity,
          item.unit_price, item.added_at, item.sold_as_pack_of, item.sale_variant_id,
          item.stock_units_per_sale, item.combo_application_id, item.combo_id, '{}'::jsonb as raw_data, item.created_at
        from public.customer_tab_items as item
        where item.organization_id = v_organization_id
          and item.customer_tab_id in (
            select tab.id from public.customer_tabs as tab
            where tab.organization_id = v_organization_id and tab.status = 'open'
          )
        order by item.customer_tab_id, item.added_at, item.id
      ) as row_data
    ), '[]'::jsonb),
    'customer_tab_combo_applications', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.customer_tab_id, row_data.applied_at, row_data.id)
      from (
        select applied.organization_id, applied.customer_tab_id, applied.id, applied.combo_id, applied.combo_name,
          applied.price, applied.included_minutes, applied.applied_at, applied.fixed_items,
          applied.choices, '{}'::jsonb as raw_data, applied.created_at
        from public.customer_tab_combo_applications as applied
        where applied.organization_id = v_organization_id
          and applied.customer_tab_id in (
            select tab.id from public.customer_tabs as tab
            where tab.organization_id = v_organization_id and tab.status = 'open'
          )
        order by applied.customer_tab_id, applied.applied_at, applied.id
      ) as row_data
    ), '[]'::jsonb)
  );

  if octet_length(v_result::text) > 160992 then
    raise exception using
      errcode = 'P0001',
      message = 'Operational bootstrap response exceeded the safe payload limit.',
      detail = jsonb_build_object('code', 'bootstrap_payload_limit_exceeded')::text;
  end if;

  return v_result;
end;
$$;

do $acl$
declare
  function_owner text;
  grantee_name text;
begin
  select pg_get_userbyid(p.proowner)
  into strict function_owner
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'load_operational_bootstrap_v2'
    and pg_get_function_identity_arguments(p.oid) = '';

  for grantee_name in
    select distinct case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where n.nspname = 'public'
      and p.proname = 'load_operational_bootstrap_v2'
      and pg_get_function_identity_arguments(p.oid) = ''
  loop
    if grantee_name = 'PUBLIC' then
      execute 'revoke all privileges on function public.load_operational_bootstrap_v2() from public';
    else
      execute format(
        'revoke all privileges on function public.load_operational_bootstrap_v2() from %I',
        grantee_name
      );
    end if;
  end loop;

  execute format(
    'grant execute on function public.load_operational_bootstrap_v2() to %I',
    function_owner
  );
end;
$acl$;

revoke all on function public.load_operational_bootstrap_v2() from public;
revoke all on function public.load_operational_bootstrap_v2() from anon;
revoke all on function public.load_operational_bootstrap_v2() from service_role;
grant execute on function public.load_operational_bootstrap_v2() to authenticated;
