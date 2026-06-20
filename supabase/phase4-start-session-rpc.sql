-- Phase 4 normalized write RPC: start_session.
--
-- This is side-by-side with app_state. It creates the RPC needed by the
-- feature-flagged VITE_BACKEND_RPC_OPERATIONAL_WRITES path, but it does not
-- enable that flag and does not change the current production write path.

create or replace function public.raise_operational_rpc_error(
  error_code text,
  error_message text,
  error_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
as $$
begin
  raise exception
    using
      errcode = 'P0001',
      message = error_message,
      detail = jsonb_build_object(
        'code', error_code,
        'message', error_message,
        'details', coalesce(error_details, '{}'::jsonb)
      )::text;
end;
$$;

revoke all on function public.raise_operational_rpc_error(text, text, jsonb) from public;

create or replace function public.start_session(payload jsonb)
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
  v_session jsonb := coalesce(payload #> '{payload,session}', '{}'::jsonb);
  v_customer jsonb := payload #> '{payload,customer}';
  v_stock_movements jsonb := coalesce(payload #> '{payload,stockMovements}', '[]'::jsonb);
  v_audit_logs jsonb := coalesce(payload #> '{payload,auditLogs}', '[]'::jsonb);
  v_session_id text := nullif(v_session->>'id', '');
  v_station_id text := nullif(v_session->>'stationId', '');
  v_station_name text;
  v_customer_name text;
  v_customer_phone text;
  v_customer_phone_key text;
  v_customer_name_key text;
  v_resolved_customer_id text;
  v_customer_ids jsonb := '[]'::jsonb;
  v_session_item_ids jsonb := '[]'::jsonb;
  v_combo_application_ids jsonb := '[]'::jsonb;
  v_stock_movement_ids jsonb := '[]'::jsonb;
  v_audit_log_ids jsonb := '[]'::jsonb;
  v_required_stock jsonb := '[]'::jsonb;
  v_required record;
  v_item_name text;
  v_item_stock numeric;
  v_session_reserved numeric;
  v_tab_reserved numeric;
  v_available numeric;
  v_event_id text;
begin
  if v_organization_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change is missing an organization.',
      '{}'::jsonb
    );
  end if;

  if not (select public.current_user_has_org_access(v_organization_id)) then
    perform public.raise_operational_rpc_error(
      'organization_access_denied',
      'You do not have access to this organization.',
      jsonb_build_object('organization_id', v_organization_id)
    );
  end if;

  if v_mutation_id is null or v_mutation_kind <> 'startSession' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_session_id is null or v_station_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The session payload is missing a session or station id.',
      jsonb_build_object('session_id', v_session_id, 'station_id', v_station_id)
    );
  end if;

  perform pg_advisory_xact_lock(hashtext(v_organization_id || ':station:' || v_station_id));

  select operational_events.id
  into v_event_id
  from public.operational_events
  where operational_events.organization_id = v_organization_id
    and operational_events.metadata->>'mutation_id' = v_mutation_id
  order by operational_events.created_at desc
  limit 1;

  if exists (
    select 1
    from public.sessions
    where sessions.organization_id = v_organization_id
      and sessions.id = v_session_id
  ) then
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
        'customers', '[]'::jsonb,
        'session_items', '[]'::jsonb,
        'session_combo_applications', '[]'::jsonb,
        'stock_movements', '[]'::jsonb,
        'audit_logs', '[]'::jsonb,
        'operational_events', case when v_event_id is null then '[]'::jsonb else jsonb_build_array(v_event_id) end
      )
    );
  end if;

  select stations.name
  into v_station_name
  from public.stations
  where stations.organization_id = v_organization_id
    and stations.id = v_station_id
    and stations.active = true;

  if v_station_name is null then
    perform public.raise_operational_rpc_error(
      'station_unavailable',
      'The selected station is no longer available.',
      jsonb_build_object('station_id', v_station_id)
    );
  end if;

  if exists (
    select 1
    from public.sessions
    where sessions.organization_id = v_organization_id
      and sessions.station_id = v_station_id
      and sessions.status <> 'closed'
  ) then
    perform public.raise_operational_rpc_error(
      'station_occupied',
      'This station was started on another device.',
      jsonb_build_object('station_id', v_station_id, 'station_name', v_station_name)
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
      line->>'inventoryItemId' as item_id,
      sum(
        coalesce(nullif(line->>'quantity', '')::numeric, 0) *
        coalesce(
          nullif(line->>'stockUnitsPerSale', '')::numeric,
          nullif(line->>'soldAsPackOf', '')::numeric,
          1
        )
      ) as required_quantity
    from jsonb_array_elements(coalesce(v_session->'items', '[]'::jsonb)) as line
    where nullif(line->>'inventoryItemId', '') is not null
    group by line->>'inventoryItemId'
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
        'An inventory item used by this session no longer exists.',
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

  if jsonb_typeof(v_customer) = 'object' then
    v_customer_name := nullif(trim(coalesce(v_customer->>'name', '')), '');
    v_customer_phone := nullif(trim(coalesce(v_customer->>'phone', '')), '');
    v_customer_phone_key := nullif(regexp_replace(coalesce(v_customer_phone, ''), '\D', '', 'g'), '');
    v_customer_name_key := nullif(lower(regexp_replace(coalesce(v_customer_name, ''), '\s+', ' ', 'g')), '');

    if v_customer_phone_key is not null then
      select customers.id
      into v_resolved_customer_id
      from public.customers
      where customers.organization_id = v_organization_id
        and regexp_replace(coalesce(customers.phone, ''), '\D', '', 'g') = v_customer_phone_key
      order by customers.last_visit_at desc nulls last, customers.created_at desc
      limit 1;
    end if;

    if v_resolved_customer_id is null and v_customer_name_key is not null then
      select customers.id
      into v_resolved_customer_id
      from public.customers
      where customers.organization_id = v_organization_id
        and nullif(regexp_replace(coalesce(customers.phone, ''), '\D', '', 'g'), '') is null
        and lower(regexp_replace(trim(coalesce(customers.name, '')), '\s+', ' ', 'g')) = v_customer_name_key
      order by customers.last_visit_at desc nulls last, customers.created_at desc
      limit 1;
    end if;

    if (v_customer_name is not null or v_customer_phone is not null) and v_resolved_customer_id is null then
      v_resolved_customer_id := coalesce(nullif(v_customer->>'id', ''), 'customer-' || gen_random_uuid()::text);
      insert into public.customers (
        organization_id,
        id,
        name,
        phone,
        first_seen_at,
        last_visit_at,
        raw_data
      )
      values (
        v_organization_id,
        v_resolved_customer_id,
        coalesce(v_customer_name, v_customer_phone, 'Walk-in'),
        v_customer_phone,
        nullif(v_customer->>'visitAt', '')::timestamptz,
        nullif(v_customer->>'visitAt', '')::timestamptz,
        v_customer
      )
      on conflict (organization_id, id) do update
      set
        name = excluded.name,
        phone = coalesce(excluded.phone, customers.phone),
        last_visit_at = excluded.last_visit_at,
        raw_data = excluded.raw_data,
        updated_at = timezone('utc', now());
      v_customer_ids := jsonb_build_array(v_resolved_customer_id);
    elsif v_resolved_customer_id is not null then
      update public.customers
      set
        name = coalesce(v_customer_name, v_customer_phone, customers.name),
        phone = coalesce(v_customer_phone, customers.phone),
        last_visit_at = coalesce(nullif(v_customer->>'visitAt', '')::timestamptz, customers.last_visit_at),
        raw_data = customers.raw_data || v_customer,
        updated_at = timezone('utc', now())
      where customers.organization_id = v_organization_id
        and customers.id = v_resolved_customer_id;
      v_customer_ids := jsonb_build_array(v_resolved_customer_id);
    end if;
  end if;

  insert into public.sessions (
    organization_id,
    id,
    station_id,
    station_name_snapshot,
    mode,
    started_at,
    ended_at,
    status,
    customer_id,
    customer_name,
    customer_phone,
    play_mode,
    ltp_eligible,
    ltp_outcome,
    ltp_discount_applied,
    pricing_snapshot,
    pause_log_ids,
    continued_from_session_ids,
    closed_bill_id,
    close_disposition,
    close_reason,
    raw_data
  )
  values (
    v_organization_id,
    v_session_id,
    v_station_id,
    coalesce(nullif(v_session->>'stationNameSnapshot', ''), v_station_name),
    coalesce(nullif(v_session->>'mode', ''), 'timed'),
    coalesce(nullif(v_session->>'startedAt', '')::timestamptz, timezone('utc', now())),
    nullif(v_session->>'endedAt', '')::timestamptz,
    coalesce(nullif(v_session->>'status', ''), 'active'),
    v_resolved_customer_id,
    nullif(v_session->>'customerName', ''),
    nullif(v_session->>'customerPhone', ''),
    coalesce(nullif(v_session->>'playMode', ''), 'group'),
    coalesce(nullif(v_session->>'ltpEligible', '')::boolean, false),
    nullif(v_session->>'ltpOutcome', ''),
    nullif(v_session->>'ltpDiscountApplied', '')::boolean,
    coalesce(v_session->'pricingSnapshot', '[]'::jsonb),
    coalesce(v_session->'pauseLogIds', '[]'::jsonb),
    v_session->'continuedFromSessionIds',
    nullif(v_session->>'closedBillId', ''),
    nullif(v_session->>'closeDisposition', ''),
    nullif(v_session->>'closeReason', ''),
    v_session || jsonb_build_object('customerId', v_resolved_customer_id)
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
    coalesce(nullif(item->>'name', ''), 'Session item'),
    coalesce(nullif(item->>'quantity', '')::numeric, 0),
    coalesce(nullif(item->>'unitPrice', '')::numeric, 0),
    nullif(item->>'addedAt', '')::timestamptz,
    nullif(item->>'soldAsPackOf', '')::numeric,
    nullif(item->>'saleVariantId', ''),
    nullif(item->>'stockUnitsPerSale', '')::numeric,
    nullif(item->>'comboApplicationId', ''),
    nullif(item->>'comboId', ''),
    item
  from jsonb_array_elements(coalesce(v_session->'items', '[]'::jsonb)) as item
  where item ? 'id'
  on conflict (organization_id, session_id, id) do nothing;

  select coalesce(jsonb_agg(item->>'id' order by item->>'id'), '[]'::jsonb)
  into v_session_item_ids
  from jsonb_array_elements(coalesce(v_session->'items', '[]'::jsonb)) as item
  where item ? 'id';

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
  select
    v_organization_id,
    v_session_id,
    combo_app->>'id',
    nullif(combo_app->>'comboId', ''),
    coalesce(nullif(combo_app->>'comboName', ''), 'Combo'),
    coalesce(nullif(combo_app->>'price', '')::numeric, 0),
    coalesce(nullif(combo_app->>'includedMinutes', '')::integer, 0),
    nullif(combo_app->>'appliedAt', '')::timestamptz,
    coalesce(combo_app->'fixedItems', '[]'::jsonb),
    coalesce(combo_app->'choices', '[]'::jsonb),
    combo_app
  from jsonb_array_elements(coalesce(v_session->'comboApplications', '[]'::jsonb)) as combo_app
  where combo_app ? 'id'
  on conflict (organization_id, session_id, id) do nothing;

  select coalesce(jsonb_agg(combo_app->>'id' order by combo_app->>'id'), '[]'::jsonb)
  into v_combo_application_ids
  from jsonb_array_elements(coalesce(v_session->'comboApplications', '[]'::jsonb)) as combo_app
  where combo_app ? 'id';

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
    coalesce(nullif(movement->>'type', ''), 'adjustment'),
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
  select
    v_organization_id,
    audit->>'id',
    coalesce(nullif(audit->>'action', ''), 'unknown'),
    nullif(audit->>'entityType', ''),
    nullif(audit->>'entityId', ''),
    nullif(audit->>'message', ''),
    nullif(audit->>'createdAt', '')::timestamptz,
    nullif(audit->>'userId', ''),
    audit
  from jsonb_array_elements(v_audit_logs) as audit
  where audit ? 'id'
  on conflict (organization_id, id) do nothing;

  select coalesce(jsonb_agg(audit->>'id' order by audit->>'id'), '[]'::jsonb)
  into v_audit_log_ids
  from jsonb_array_elements(v_audit_logs) as audit
  where audit ? 'id';

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
    'start_session',
    'session',
    v_session_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'station_id', v_station_id,
      'customer_id', v_resolved_customer_id,
      'session_item_ids', v_session_item_ids,
      'stock_movement_ids', v_stock_movement_ids,
      'audit_log_ids', v_audit_log_ids
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
      'customers', v_customer_ids,
      'session_items', v_session_item_ids,
      'session_combo_applications', v_combo_application_ids,
      'stock_movements', v_stock_movement_ids,
      'audit_logs', v_audit_log_ids,
      'operational_events', jsonb_build_array(v_event_id)
    )
  );
end;
$$;

revoke all on function public.start_session(jsonb) from public;
grant execute on function public.start_session(jsonb) to authenticated;
