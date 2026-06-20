-- Phase 4 normalized write RPCs for combo repeat/apply operations.
--
-- Run after supabase/phase4-start-session-rpc.sql because these functions
-- reuse public.raise_operational_rpc_error.

create or replace function public.repeat_session_combo(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id text := nullif(payload->>'organization_id', '');
  v_mutation_id text := nullif(payload->>'mutation_id', '');
  v_mutation_kind text := nullif(payload->>'mutation_kind', '');
  v_user_id text := nullif(payload->>'user_id', '');
  v_session_id text := nullif(payload #>> '{payload,sessionId}', '');
  v_combo_application jsonb := coalesce(payload #> '{payload,comboApplication}', '{}'::jsonb);
  v_items jsonb := coalesce(payload #> '{payload,items}', '[]'::jsonb);
  v_stock_movements jsonb := coalesce(payload #> '{payload,stockMovements}', '[]'::jsonb);
  v_audit_log jsonb := coalesce(payload #> '{payload,auditLog}', '{}'::jsonb);
  v_combo_application_id text := nullif(v_combo_application->>'id', '');
  v_session_status text;
  v_required_stock jsonb := '[]'::jsonb;
  v_required record;
  v_item_name text;
  v_item_stock numeric;
  v_session_reserved numeric := 0;
  v_tab_reserved numeric := 0;
  v_available numeric := 0;
  v_session_item_ids jsonb := '[]'::jsonb;
  v_stock_movement_ids jsonb := '[]'::jsonb;
  v_event_id text;
  v_event_metadata jsonb := '{}'::jsonb;
  v_audit_log_id text := nullif(v_audit_log->>'id', '');
begin
  if v_organization_id is null then
    perform public.raise_operational_rpc_error('invalid_payload', 'The operational change is missing an organization.', '{}'::jsonb);
  end if;

  if not (select public.current_user_has_org_access(v_organization_id)) then
    perform public.raise_operational_rpc_error(
      'organization_access_denied',
      'You do not have access to this organization.',
      jsonb_build_object('organization_id', v_organization_id)
    );
  end if;

  if v_mutation_id is null or v_mutation_kind <> 'repeatSessionCombo' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_session_id is null or v_combo_application_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The repeat combo payload is missing a session or combo application id.',
      jsonb_build_object('session_id', v_session_id, 'combo_application_id', v_combo_application_id)
    );
  end if;

  if jsonb_typeof(v_items) <> 'array' or jsonb_typeof(v_stock_movements) <> 'array' then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The repeat combo payload has invalid item or stock movement data.',
      jsonb_build_object('session_id', v_session_id, 'combo_application_id', v_combo_application_id)
    );
  end if;

  select operational_events.id, operational_events.metadata
  into v_event_id, v_event_metadata
  from public.operational_events
  where operational_events.organization_id = v_organization_id
    and operational_events.metadata->>'mutation_id' = v_mutation_id
  order by operational_events.created_at desc
  limit 1;

  if v_event_id is not null then
    return jsonb_build_object(
      'mutation_id', v_mutation_id,
      'organization_id', v_organization_id,
      'entity_type', 'session',
      'entity_id', v_session_id,
      'event_id', v_event_id,
      'server_time', timezone('utc', now()),
      'idempotent', true,
      'changed_rows', jsonb_build_object(
        'sessions', jsonb_build_array(v_session_id),
        'session_combo_applications', jsonb_build_array(coalesce(v_event_metadata->>'combo_application_id', v_combo_application_id)),
        'session_items', coalesce(v_event_metadata->'session_item_ids', '[]'::jsonb),
        'stock_movements', coalesce(v_event_metadata->'stock_movement_ids', '[]'::jsonb),
        'audit_logs', case
          when coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id))
        end,
        'operational_events', jsonb_build_array(v_event_id)
      )
    );
  end if;

  select sessions.status
  into v_session_status
  from public.sessions
  where sessions.organization_id = v_organization_id
    and sessions.id = v_session_id
  for update;

  if v_session_status is null or v_session_status = 'closed' then
    perform public.raise_operational_rpc_error(
      'session_not_open',
      'The session is no longer open.',
      jsonb_build_object('session_id', v_session_id)
    );
  end if;

  select operational_events.id, operational_events.metadata
  into v_event_id, v_event_metadata
  from public.operational_events
  where operational_events.organization_id = v_organization_id
    and operational_events.metadata->>'mutation_id' = v_mutation_id
  order by operational_events.created_at desc
  limit 1;

  if v_event_id is not null then
    return jsonb_build_object(
      'mutation_id', v_mutation_id,
      'organization_id', v_organization_id,
      'entity_type', 'session',
      'entity_id', v_session_id,
      'event_id', v_event_id,
      'server_time', timezone('utc', now()),
      'idempotent', true,
      'changed_rows', jsonb_build_object(
        'sessions', jsonb_build_array(v_session_id),
        'session_combo_applications', jsonb_build_array(coalesce(v_event_metadata->>'combo_application_id', v_combo_application_id)),
        'session_items', coalesce(v_event_metadata->'session_item_ids', '[]'::jsonb),
        'stock_movements', coalesce(v_event_metadata->'stock_movement_ids', '[]'::jsonb),
        'audit_logs', case
          when coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id))
        end,
        'operational_events', jsonb_build_array(v_event_id)
      )
    );
  end if;

  if exists (
    select 1
    from public.session_combo_applications
    where session_combo_applications.organization_id = v_organization_id
      and session_combo_applications.session_id = v_session_id
      and session_combo_applications.id = v_combo_application_id
  ) then
    return jsonb_build_object(
      'mutation_id', v_mutation_id,
      'organization_id', v_organization_id,
      'entity_type', 'session',
      'entity_id', v_session_id,
      'event_id', null,
      'server_time', timezone('utc', now()),
      'idempotent', true,
      'changed_rows', jsonb_build_object(
        'sessions', jsonb_build_array(v_session_id),
        'session_combo_applications', jsonb_build_array(v_combo_application_id),
        'session_items', '[]'::jsonb,
        'stock_movements', '[]'::jsonb,
        'audit_logs', '[]'::jsonb,
        'operational_events', '[]'::jsonb
      )
    );
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('item_id', required.item_id, 'required_quantity', required.required_quantity)
      order by required.item_id
    ),
    '[]'::jsonb
  )
  into v_required_stock
  from (
    select
      item->>'inventoryItemId' as item_id,
      sum(
        coalesce(nullif(item->>'quantity', '')::numeric, 0) *
        coalesce(
          nullif(item->>'stockUnitsPerSale', '')::numeric,
          nullif(item->>'soldAsPackOf', '')::numeric,
          1
        )
      ) as required_quantity
    from jsonb_array_elements(v_items) as item
    where nullif(item->>'inventoryItemId', '') is not null
    group by item->>'inventoryItemId'
  ) required;

  for v_required in
    select item_id, required_quantity
    from jsonb_to_recordset(v_required_stock) as stock(item_id text, required_quantity numeric)
    order by item_id
  loop
    select inventory_items.name, inventory_items.stock_qty
    into v_item_name, v_item_stock
    from public.inventory_items
    where inventory_items.organization_id = v_organization_id
      and inventory_items.id = v_required.item_id
    for update;

    if v_item_name is null then
      perform public.raise_operational_rpc_error(
        'inventory_item_missing',
        'An inventory item used by this combo no longer exists.',
        jsonb_build_object('item_id', v_required.item_id)
      );
    end if;

    select coalesce(
      sum(session_items.quantity * coalesce(session_items.stock_units_per_sale, session_items.sold_as_pack_of, 1)),
      0
    )
    into v_session_reserved
    from public.session_items
    join public.sessions
      on sessions.organization_id = session_items.organization_id
     and sessions.id = session_items.session_id
    where session_items.organization_id = v_organization_id
      and session_items.inventory_item_id = v_required.item_id
      and sessions.status <> 'closed'
      and sessions.id <> v_session_id;

    select coalesce(
      sum(customer_tab_items.quantity * coalesce(customer_tab_items.stock_units_per_sale, customer_tab_items.sold_as_pack_of, 1)),
      0
    )
    into v_tab_reserved
    from public.customer_tab_items
    join public.customer_tabs
      on customer_tabs.organization_id = customer_tab_items.organization_id
     and customer_tabs.id = customer_tab_items.customer_tab_id
    where customer_tab_items.organization_id = v_organization_id
      and customer_tab_items.inventory_item_id = v_required.item_id
      and customer_tabs.status = 'open';

    v_available := greatest(0, v_item_stock - v_session_reserved - v_tab_reserved);

    if v_required.required_quantity > v_available then
      perform public.raise_operational_rpc_error(
        'insufficient_stock',
        v_item_name || ' no longer has enough available stock.',
        jsonb_build_object(
          'item_id', v_required.item_id,
          'item_name', v_item_name,
          'required_quantity', v_required.required_quantity,
          'available_quantity', v_available
        )
      );
    end if;
  end loop;

  insert into public.session_combo_applications (
    organization_id,
    session_id,
    id,
    combo_id,
    combo_name,
    price,
    included_minutes,
    applied_at,
    fixed_items,
    choices,
    raw_data
  )
  values (
    v_organization_id,
    v_session_id,
    v_combo_application_id,
    nullif(v_combo_application->>'comboId', ''),
    coalesce(nullif(v_combo_application->>'comboName', ''), 'Combo'),
    coalesce(nullif(v_combo_application->>'price', '')::numeric, 0),
    coalesce(nullif(v_combo_application->>'includedMinutes', '')::integer, 0),
    nullif(v_combo_application->>'appliedAt', '')::timestamptz,
    coalesce(v_combo_application->'fixedItems', '[]'::jsonb),
    coalesce(v_combo_application->'choices', '[]'::jsonb),
    v_combo_application
  );

  insert into public.session_items (
    organization_id,
    session_id,
    id,
    inventory_item_id,
    name,
    quantity,
    unit_price,
    added_at,
    sold_as_pack_of,
    sale_variant_id,
    stock_units_per_sale,
    combo_application_id,
    combo_id,
    raw_data
  )
  select
    v_organization_id,
    v_session_id,
    item->>'id',
    nullif(item->>'inventoryItemId', ''),
    coalesce(nullif(item->>'name', ''), 'Combo item'),
    coalesce(nullif(item->>'quantity', '')::numeric, 0),
    coalesce(nullif(item->>'unitPrice', '')::numeric, 0),
    nullif(item->>'addedAt', '')::timestamptz,
    nullif(item->>'soldAsPackOf', '')::numeric,
    nullif(item->>'saleVariantId', ''),
    nullif(item->>'stockUnitsPerSale', '')::numeric,
    nullif(item->>'comboApplicationId', ''),
    nullif(item->>'comboId', ''),
    item
  from jsonb_array_elements(v_items) as item
  where item ? 'id'
  on conflict (organization_id, session_id, id) do nothing;

  select coalesce(jsonb_agg(item->>'id' order by item->>'id'), '[]'::jsonb)
  into v_session_item_ids
  from jsonb_array_elements(v_items) as item
  where item ? 'id';

  insert into public.stock_movements (
    organization_id,
    id,
    item_id,
    type,
    quantity,
    reason,
    movement_at,
    user_id,
    related_bill_id,
    raw_data
  )
  select
    v_organization_id,
    movement->>'id',
    nullif(movement->>'itemId', ''),
    coalesce(nullif(movement->>'type', ''), 'session_reservation'),
    coalesce(nullif(movement->>'quantity', '')::numeric, 0),
    nullif(movement->>'reason', ''),
    nullif(movement->>'createdAt', '')::timestamptz,
    nullif(movement->>'userId', ''),
    nullif(movement->>'relatedBillId', ''),
    movement
  from jsonb_array_elements(v_stock_movements) as movement
  where movement ? 'id'
  on conflict (organization_id, id) do nothing;

  select coalesce(jsonb_agg(movement->>'id' order by movement->>'id'), '[]'::jsonb)
  into v_stock_movement_ids
  from jsonb_array_elements(v_stock_movements) as movement
  where movement ? 'id';

  update public.sessions
  set
    raw_data = jsonb_set(
      jsonb_set(
        coalesce(sessions.raw_data, '{}'::jsonb),
        '{comboApplications}',
        coalesce(sessions.raw_data->'comboApplications', '[]'::jsonb) || jsonb_build_array(v_combo_application),
        true
      ),
      '{items}',
      coalesce(sessions.raw_data->'items', '[]'::jsonb) || v_items,
      true
    ),
    updated_at = timezone('utc', now())
  where sessions.organization_id = v_organization_id
    and sessions.id = v_session_id;

  if v_audit_log_id is not null then
    insert into public.audit_logs (
      organization_id,
      id,
      action,
      entity_type,
      entity_id,
      message,
      audit_at,
      user_id,
      raw_data
    )
    values (
      v_organization_id,
      v_audit_log_id,
      coalesce(nullif(v_audit_log->>'action', ''), 'combo_repeated'),
      nullif(v_audit_log->>'entityType', ''),
      nullif(v_audit_log->>'entityId', ''),
      nullif(v_audit_log->>'message', ''),
      nullif(v_audit_log->>'createdAt', '')::timestamptz,
      nullif(v_audit_log->>'userId', ''),
      v_audit_log
    )
    on conflict (organization_id, id) do nothing;
  end if;

  insert into public.operational_events (
    organization_id,
    event_type,
    entity_type,
    entity_id,
    created_by,
    metadata
  )
  values (
    v_organization_id,
    'repeat_session_combo',
    'session',
    v_session_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'combo_application_id', v_combo_application_id,
      'session_item_ids', v_session_item_ids,
      'stock_movement_ids', v_stock_movement_ids,
      'audit_log_id', v_audit_log_id
    )
  )
  returning id into v_event_id;

  return jsonb_build_object(
    'mutation_id', v_mutation_id,
    'organization_id', v_organization_id,
    'entity_type', 'session',
    'entity_id', v_session_id,
    'event_id', v_event_id,
    'server_time', timezone('utc', now()),
    'changed_rows', jsonb_build_object(
      'sessions', jsonb_build_array(v_session_id),
      'session_combo_applications', jsonb_build_array(v_combo_application_id),
      'session_items', v_session_item_ids,
      'stock_movements', v_stock_movement_ids,
      'audit_logs', case when v_audit_log_id is null then '[]'::jsonb else jsonb_build_array(v_audit_log_id) end,
      'operational_events', jsonb_build_array(v_event_id)
    )
  );
end;
$$;

revoke all on function public.repeat_session_combo(jsonb) from public;
revoke execute on function public.repeat_session_combo(jsonb) from anon;
grant execute on function public.repeat_session_combo(jsonb) to authenticated;

create or replace function public.apply_customer_tab_combo(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id text := nullif(payload->>'organization_id', '');
  v_mutation_id text := nullif(payload->>'mutation_id', '');
  v_mutation_kind text := nullif(payload->>'mutation_kind', '');
  v_user_id text := nullif(payload->>'user_id', '');
  v_customer_tab_id text := nullif(payload #>> '{payload,customerTabId}', '');
  v_combo_application jsonb := coalesce(payload #> '{payload,comboApplication}', '{}'::jsonb);
  v_items jsonb := coalesce(payload #> '{payload,items}', '[]'::jsonb);
  v_audit_log jsonb := coalesce(payload #> '{payload,auditLog}', '{}'::jsonb);
  v_combo_application_id text := nullif(v_combo_application->>'id', '');
  v_tab_status text;
  v_required_stock jsonb := '[]'::jsonb;
  v_required record;
  v_item_name text;
  v_item_stock numeric;
  v_session_reserved numeric := 0;
  v_tab_reserved numeric := 0;
  v_available numeric := 0;
  v_customer_tab_item_ids jsonb := '[]'::jsonb;
  v_event_id text;
  v_event_metadata jsonb := '{}'::jsonb;
  v_audit_log_id text := nullif(v_audit_log->>'id', '');
begin
  if v_organization_id is null then
    perform public.raise_operational_rpc_error('invalid_payload', 'The operational change is missing an organization.', '{}'::jsonb);
  end if;

  if not (select public.current_user_has_org_access(v_organization_id)) then
    perform public.raise_operational_rpc_error(
      'organization_access_denied',
      'You do not have access to this organization.',
      jsonb_build_object('organization_id', v_organization_id)
    );
  end if;

  if v_mutation_id is null or v_mutation_kind <> 'applyCustomerTabCombo' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_customer_tab_id is null or v_combo_application_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The customer tab combo payload is missing a tab or combo application id.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id, 'combo_application_id', v_combo_application_id)
    );
  end if;

  if jsonb_typeof(v_items) <> 'array' then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The customer tab combo payload has invalid item data.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id, 'combo_application_id', v_combo_application_id)
    );
  end if;

  select operational_events.id, operational_events.metadata
  into v_event_id, v_event_metadata
  from public.operational_events
  where operational_events.organization_id = v_organization_id
    and operational_events.metadata->>'mutation_id' = v_mutation_id
  order by operational_events.created_at desc
  limit 1;

  if v_event_id is not null then
    return jsonb_build_object(
      'mutation_id', v_mutation_id,
      'organization_id', v_organization_id,
      'entity_type', 'customer_tab',
      'entity_id', v_customer_tab_id,
      'event_id', v_event_id,
      'server_time', timezone('utc', now()),
      'idempotent', true,
      'changed_rows', jsonb_build_object(
        'customer_tabs', jsonb_build_array(v_customer_tab_id),
        'customer_tab_combo_applications', jsonb_build_array(coalesce(v_event_metadata->>'combo_application_id', v_combo_application_id)),
        'customer_tab_items', coalesce(v_event_metadata->'customer_tab_item_ids', '[]'::jsonb),
        'audit_logs', case
          when coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id))
        end,
        'operational_events', jsonb_build_array(v_event_id)
      )
    );
  end if;

  select customer_tabs.status
  into v_tab_status
  from public.customer_tabs
  where customer_tabs.organization_id = v_organization_id
    and customer_tabs.id = v_customer_tab_id
  for update;

  if v_tab_status is null or v_tab_status <> 'open' then
    perform public.raise_operational_rpc_error(
      'customer_tab_not_open',
      'The customer tab is no longer open.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id)
    );
  end if;

  select operational_events.id, operational_events.metadata
  into v_event_id, v_event_metadata
  from public.operational_events
  where operational_events.organization_id = v_organization_id
    and operational_events.metadata->>'mutation_id' = v_mutation_id
  order by operational_events.created_at desc
  limit 1;

  if v_event_id is not null then
    return jsonb_build_object(
      'mutation_id', v_mutation_id,
      'organization_id', v_organization_id,
      'entity_type', 'customer_tab',
      'entity_id', v_customer_tab_id,
      'event_id', v_event_id,
      'server_time', timezone('utc', now()),
      'idempotent', true,
      'changed_rows', jsonb_build_object(
        'customer_tabs', jsonb_build_array(v_customer_tab_id),
        'customer_tab_combo_applications', jsonb_build_array(coalesce(v_event_metadata->>'combo_application_id', v_combo_application_id)),
        'customer_tab_items', coalesce(v_event_metadata->'customer_tab_item_ids', '[]'::jsonb),
        'audit_logs', case
          when coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id))
        end,
        'operational_events', jsonb_build_array(v_event_id)
      )
    );
  end if;

  if exists (
    select 1
    from public.customer_tab_combo_applications
    where customer_tab_combo_applications.organization_id = v_organization_id
      and customer_tab_combo_applications.customer_tab_id = v_customer_tab_id
      and customer_tab_combo_applications.id = v_combo_application_id
  ) then
    return jsonb_build_object(
      'mutation_id', v_mutation_id,
      'organization_id', v_organization_id,
      'entity_type', 'customer_tab',
      'entity_id', v_customer_tab_id,
      'event_id', null,
      'server_time', timezone('utc', now()),
      'idempotent', true,
      'changed_rows', jsonb_build_object(
        'customer_tabs', jsonb_build_array(v_customer_tab_id),
        'customer_tab_combo_applications', jsonb_build_array(v_combo_application_id),
        'customer_tab_items', '[]'::jsonb,
        'audit_logs', '[]'::jsonb,
        'operational_events', '[]'::jsonb
      )
    );
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('item_id', required.item_id, 'required_quantity', required.required_quantity)
      order by required.item_id
    ),
    '[]'::jsonb
  )
  into v_required_stock
  from (
    select
      item->>'inventoryItemId' as item_id,
      sum(
        coalesce(nullif(item->>'quantity', '')::numeric, 0) *
        coalesce(
          nullif(item->>'stockUnitsPerSale', '')::numeric,
          nullif(item->>'soldAsPackOf', '')::numeric,
          1
        )
      ) as required_quantity
    from jsonb_array_elements(v_items) as item
    where nullif(item->>'inventoryItemId', '') is not null
    group by item->>'inventoryItemId'
  ) required;

  for v_required in
    select item_id, required_quantity
    from jsonb_to_recordset(v_required_stock) as stock(item_id text, required_quantity numeric)
    order by item_id
  loop
    select inventory_items.name, inventory_items.stock_qty
    into v_item_name, v_item_stock
    from public.inventory_items
    where inventory_items.organization_id = v_organization_id
      and inventory_items.id = v_required.item_id
    for update;

    if v_item_name is null then
      perform public.raise_operational_rpc_error(
        'inventory_item_missing',
        'An inventory item used by this combo no longer exists.',
        jsonb_build_object('item_id', v_required.item_id)
      );
    end if;

    select coalesce(
      sum(session_items.quantity * coalesce(session_items.stock_units_per_sale, session_items.sold_as_pack_of, 1)),
      0
    )
    into v_session_reserved
    from public.session_items
    join public.sessions
      on sessions.organization_id = session_items.organization_id
     and sessions.id = session_items.session_id
    where session_items.organization_id = v_organization_id
      and session_items.inventory_item_id = v_required.item_id
      and sessions.status <> 'closed';

    select coalesce(
      sum(customer_tab_items.quantity * coalesce(customer_tab_items.stock_units_per_sale, customer_tab_items.sold_as_pack_of, 1)),
      0
    )
    into v_tab_reserved
    from public.customer_tab_items
    join public.customer_tabs
      on customer_tabs.organization_id = customer_tab_items.organization_id
     and customer_tabs.id = customer_tab_items.customer_tab_id
    where customer_tab_items.organization_id = v_organization_id
      and customer_tab_items.inventory_item_id = v_required.item_id
      and customer_tabs.status = 'open';

    v_available := greatest(0, v_item_stock - v_session_reserved - v_tab_reserved);

    if v_required.required_quantity > v_available then
      perform public.raise_operational_rpc_error(
        'insufficient_stock',
        v_item_name || ' no longer has enough available stock.',
        jsonb_build_object(
          'item_id', v_required.item_id,
          'item_name', v_item_name,
          'required_quantity', v_required.required_quantity,
          'available_quantity', v_available
        )
      );
    end if;
  end loop;

  insert into public.customer_tab_combo_applications (
    organization_id,
    customer_tab_id,
    id,
    combo_id,
    combo_name,
    price,
    included_minutes,
    applied_at,
    fixed_items,
    choices,
    raw_data
  )
  values (
    v_organization_id,
    v_customer_tab_id,
    v_combo_application_id,
    nullif(v_combo_application->>'comboId', ''),
    coalesce(nullif(v_combo_application->>'comboName', ''), 'Combo'),
    coalesce(nullif(v_combo_application->>'price', '')::numeric, 0),
    coalesce(nullif(v_combo_application->>'includedMinutes', '')::integer, 0),
    nullif(v_combo_application->>'appliedAt', '')::timestamptz,
    coalesce(v_combo_application->'fixedItems', '[]'::jsonb),
    coalesce(v_combo_application->'choices', '[]'::jsonb),
    v_combo_application
  );

  insert into public.customer_tab_items (
    organization_id,
    customer_tab_id,
    id,
    inventory_item_id,
    name,
    quantity,
    unit_price,
    added_at,
    sold_as_pack_of,
    sale_variant_id,
    stock_units_per_sale,
    combo_application_id,
    combo_id,
    raw_data
  )
  select
    v_organization_id,
    v_customer_tab_id,
    item->>'id',
    nullif(item->>'inventoryItemId', ''),
    coalesce(nullif(item->>'name', ''), 'Combo item'),
    coalesce(nullif(item->>'quantity', '')::numeric, 0),
    coalesce(nullif(item->>'unitPrice', '')::numeric, 0),
    nullif(item->>'addedAt', '')::timestamptz,
    nullif(item->>'soldAsPackOf', '')::numeric,
    nullif(item->>'saleVariantId', ''),
    nullif(item->>'stockUnitsPerSale', '')::numeric,
    nullif(item->>'comboApplicationId', ''),
    nullif(item->>'comboId', ''),
    item
  from jsonb_array_elements(v_items) as item
  where item ? 'id'
  on conflict (organization_id, customer_tab_id, id) do nothing;

  select coalesce(jsonb_agg(item->>'id' order by item->>'id'), '[]'::jsonb)
  into v_customer_tab_item_ids
  from jsonb_array_elements(v_items) as item
  where item ? 'id';

  update public.customer_tabs
  set
    raw_data = jsonb_set(
      jsonb_set(
        coalesce(customer_tabs.raw_data, '{}'::jsonb),
        '{comboApplications}',
        coalesce(customer_tabs.raw_data->'comboApplications', '[]'::jsonb) || jsonb_build_array(v_combo_application),
        true
      ),
      '{items}',
      coalesce(customer_tabs.raw_data->'items', '[]'::jsonb) || v_items,
      true
    ),
    updated_at = timezone('utc', now())
  where customer_tabs.organization_id = v_organization_id
    and customer_tabs.id = v_customer_tab_id;

  if v_audit_log_id is not null then
    insert into public.audit_logs (
      organization_id,
      id,
      action,
      entity_type,
      entity_id,
      message,
      audit_at,
      user_id,
      raw_data
    )
    values (
      v_organization_id,
      v_audit_log_id,
      coalesce(nullif(v_audit_log->>'action', ''), 'customer_tab_combo_applied'),
      nullif(v_audit_log->>'entityType', ''),
      nullif(v_audit_log->>'entityId', ''),
      nullif(v_audit_log->>'message', ''),
      nullif(v_audit_log->>'createdAt', '')::timestamptz,
      nullif(v_audit_log->>'userId', ''),
      v_audit_log
    )
    on conflict (organization_id, id) do nothing;
  end if;

  insert into public.operational_events (
    organization_id,
    event_type,
    entity_type,
    entity_id,
    created_by,
    metadata
  )
  values (
    v_organization_id,
    'apply_customer_tab_combo',
    'customer_tab',
    v_customer_tab_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'combo_application_id', v_combo_application_id,
      'customer_tab_item_ids', v_customer_tab_item_ids,
      'audit_log_id', v_audit_log_id
    )
  )
  returning id into v_event_id;

  return jsonb_build_object(
    'mutation_id', v_mutation_id,
    'organization_id', v_organization_id,
    'entity_type', 'customer_tab',
    'entity_id', v_customer_tab_id,
    'event_id', v_event_id,
    'server_time', timezone('utc', now()),
    'changed_rows', jsonb_build_object(
      'customer_tabs', jsonb_build_array(v_customer_tab_id),
      'customer_tab_combo_applications', jsonb_build_array(v_combo_application_id),
      'customer_tab_items', v_customer_tab_item_ids,
      'audit_logs', case when v_audit_log_id is null then '[]'::jsonb else jsonb_build_array(v_audit_log_id) end,
      'operational_events', jsonb_build_array(v_event_id)
    )
  );
end;
$$;

revoke all on function public.apply_customer_tab_combo(jsonb) from public;
revoke execute on function public.apply_customer_tab_combo(jsonb) from anon;
grant execute on function public.apply_customer_tab_combo(jsonb) to authenticated;
