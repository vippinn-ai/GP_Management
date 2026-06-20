-- Phase 4 normalized write RPCs: add_session_item and remove_session_item.
--
-- Run after supabase/phase4-start-session-rpc.sql because these functions
-- reuse public.raise_operational_rpc_error.

create or replace function public.add_session_item(payload jsonb)
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
  v_item jsonb := coalesce(payload #> '{payload,item}', '{}'::jsonb);
  v_stock_movement jsonb := payload #> '{payload,stockMovement}';
  v_audit_log jsonb := coalesce(payload #> '{payload,auditLog}', '{}'::jsonb);
  v_session_item_id text := nullif(v_item->>'id', '');
  v_inventory_item_id text := nullif(v_item->>'inventoryItemId', '');
  v_quantity numeric := coalesce(nullif(v_item->>'quantity', '')::numeric, 0);
  v_stock_units_per_sale numeric := coalesce(
    nullif(v_item->>'stockUnitsPerSale', '')::numeric,
    nullif(v_item->>'soldAsPackOf', '')::numeric,
    1
  );
  v_required_quantity numeric := v_quantity * v_stock_units_per_sale;
  v_session_status text;
  v_item_name text;
  v_item_stock numeric;
  v_session_reserved numeric := 0;
  v_tab_reserved numeric := 0;
  v_available numeric := 0;
  v_event_id text;
  v_event_metadata jsonb := '{}'::jsonb;
  v_stock_movement_id text := nullif(v_stock_movement->>'id', '');
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

  if v_mutation_id is null or v_mutation_kind <> 'addSessionItem' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_session_id is null or v_session_item_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The session item payload is missing a session or item id.',
      jsonb_build_object('session_id', v_session_id, 'session_item_id', v_session_item_id)
    );
  end if;

  if v_quantity <= 0 or v_stock_units_per_sale <= 0 then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The session item quantity is invalid.',
      jsonb_build_object(
        'session_id', v_session_id,
        'session_item_id', v_session_item_id,
        'quantity', v_quantity,
        'stock_units_per_sale', v_stock_units_per_sale
      )
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
        'session_items', jsonb_build_array(coalesce(v_event_metadata->>'session_item_id', v_session_item_id)),
        'stock_movements', case
          when coalesce(v_event_metadata->>'stock_movement_id', v_stock_movement_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'stock_movement_id', v_stock_movement_id))
        end,
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
        'session_items', jsonb_build_array(coalesce(v_event_metadata->>'session_item_id', v_session_item_id)),
        'stock_movements', case
          when coalesce(v_event_metadata->>'stock_movement_id', v_stock_movement_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'stock_movement_id', v_stock_movement_id))
        end,
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
    from public.session_items
    where session_items.organization_id = v_organization_id
      and session_items.session_id = v_session_id
      and session_items.id = v_session_item_id
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
        'session_items', jsonb_build_array(v_session_item_id),
        'stock_movements', '[]'::jsonb,
        'audit_logs', '[]'::jsonb,
        'operational_events', '[]'::jsonb
      )
    );
  end if;

  if v_inventory_item_id is not null then
    select inventory_items.name, inventory_items.stock_qty
    into v_item_name, v_item_stock
    from public.inventory_items
    where inventory_items.organization_id = v_organization_id
      and inventory_items.id = v_inventory_item_id
    for update;

    if v_item_name is null then
      perform public.raise_operational_rpc_error(
        'inventory_item_missing',
        'An inventory item used by this session item no longer exists.',
        jsonb_build_object('item_id', v_inventory_item_id)
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
      and session_items.inventory_item_id = v_inventory_item_id
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
      and customer_tab_items.inventory_item_id = v_inventory_item_id
      and customer_tabs.status = 'open';

    v_available := greatest(0, v_item_stock - v_session_reserved - v_tab_reserved);

    if v_required_quantity > v_available then
      perform public.raise_operational_rpc_error(
        'insufficient_stock',
        v_item_name || ' no longer has enough available stock.',
        jsonb_build_object(
          'item_id', v_inventory_item_id,
          'item_name', v_item_name,
          'required_quantity', v_required_quantity,
          'available_quantity', v_available
        )
      );
    end if;
  end if;

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
  values (
    v_organization_id,
    v_session_id,
    v_session_item_id,
    v_inventory_item_id,
    coalesce(nullif(v_item->>'name', ''), 'Session item'),
    v_quantity,
    coalesce(nullif(v_item->>'unitPrice', '')::numeric, 0),
    nullif(v_item->>'addedAt', '')::timestamptz,
    nullif(v_item->>'soldAsPackOf', '')::numeric,
    nullif(v_item->>'saleVariantId', ''),
    nullif(v_item->>'stockUnitsPerSale', '')::numeric,
    nullif(v_item->>'comboApplicationId', ''),
    nullif(v_item->>'comboId', ''),
    v_item
  );

  update public.sessions
  set
    raw_data = jsonb_set(
      coalesce(sessions.raw_data, '{}'::jsonb),
      '{items}',
      coalesce(sessions.raw_data->'items', '[]'::jsonb) || jsonb_build_array(v_item),
      true
    ),
    updated_at = timezone('utc', now())
  where sessions.organization_id = v_organization_id
    and sessions.id = v_session_id;

  if jsonb_typeof(v_stock_movement) = 'object' and v_stock_movement_id is not null then
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
    values (
      v_organization_id,
      v_stock_movement_id,
      nullif(v_stock_movement->>'itemId', ''),
      coalesce(nullif(v_stock_movement->>'type', ''), 'session_reservation'),
      coalesce(nullif(v_stock_movement->>'quantity', '')::numeric, 0),
      nullif(v_stock_movement->>'reason', ''),
      nullif(v_stock_movement->>'createdAt', '')::timestamptz,
      nullif(v_stock_movement->>'userId', ''),
      nullif(v_stock_movement->>'relatedBillId', ''),
      v_stock_movement
    )
    on conflict (organization_id, id) do nothing;
  end if;

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
      coalesce(nullif(v_audit_log->>'action', ''), 'session_item_added'),
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
    'add_session_item',
    'session',
    v_session_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'session_item_id', v_session_item_id,
      'stock_movement_id', v_stock_movement_id,
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
      'session_items', jsonb_build_array(v_session_item_id),
      'stock_movements', case when v_stock_movement_id is null then '[]'::jsonb else jsonb_build_array(v_stock_movement_id) end,
      'audit_logs', case when v_audit_log_id is null then '[]'::jsonb else jsonb_build_array(v_audit_log_id) end,
      'operational_events', jsonb_build_array(v_event_id)
    )
  );
end;
$$;

revoke all on function public.add_session_item(jsonb) from public;
revoke execute on function public.add_session_item(jsonb) from anon;
grant execute on function public.add_session_item(jsonb) to authenticated;

create or replace function public.remove_session_item(payload jsonb)
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
  v_session_item_id text := nullif(payload #>> '{payload,sessionItemId}', '');
  v_stock_movement jsonb := payload #> '{payload,stockMovement}';
  v_audit_log jsonb := payload #> '{payload,auditLog}';
  v_session_status text;
  v_existing_item_id text;
  v_event_id text;
  v_event_metadata jsonb := '{}'::jsonb;
  v_stock_movement_id text := nullif(v_stock_movement->>'id', '');
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

  if v_mutation_id is null or v_mutation_kind <> 'removeSessionItem' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_session_id is null or v_session_item_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The remove session item payload is missing a session or item id.',
      jsonb_build_object('session_id', v_session_id, 'session_item_id', v_session_item_id)
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
        'session_items', jsonb_build_array(coalesce(v_event_metadata->>'session_item_id', v_session_item_id)),
        'stock_movements', case
          when coalesce(v_event_metadata->>'stock_movement_id', v_stock_movement_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'stock_movement_id', v_stock_movement_id))
        end,
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
        'session_items', jsonb_build_array(coalesce(v_event_metadata->>'session_item_id', v_session_item_id)),
        'stock_movements', case
          when coalesce(v_event_metadata->>'stock_movement_id', v_stock_movement_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'stock_movement_id', v_stock_movement_id))
        end,
        'audit_logs', case
          when coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id))
        end,
        'operational_events', jsonb_build_array(v_event_id)
      )
    );
  end if;

  select session_items.id
  into v_existing_item_id
  from public.session_items
  where session_items.organization_id = v_organization_id
    and session_items.session_id = v_session_id
    and session_items.id = v_session_item_id
  for update;

  if v_existing_item_id is null then
    perform public.raise_operational_rpc_error(
      'session_item_missing',
      'The session item is no longer available.',
      jsonb_build_object('session_id', v_session_id, 'session_item_id', v_session_item_id)
    );
  end if;

  delete from public.session_items
  where session_items.organization_id = v_organization_id
    and session_items.session_id = v_session_id
    and session_items.id = v_session_item_id;

  update public.sessions
  set
    raw_data = jsonb_set(
      coalesce(sessions.raw_data, '{}'::jsonb),
      '{items}',
      (
        select coalesce(jsonb_agg(entry), '[]'::jsonb)
        from jsonb_array_elements(coalesce(sessions.raw_data->'items', '[]'::jsonb)) as entry
        where entry->>'id' <> v_session_item_id
      ),
      true
    ),
    updated_at = timezone('utc', now())
  where sessions.organization_id = v_organization_id
    and sessions.id = v_session_id;

  if jsonb_typeof(v_stock_movement) = 'object' and v_stock_movement_id is not null then
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
    values (
      v_organization_id,
      v_stock_movement_id,
      nullif(v_stock_movement->>'itemId', ''),
      coalesce(nullif(v_stock_movement->>'type', ''), 'session_reservation_void'),
      coalesce(nullif(v_stock_movement->>'quantity', '')::numeric, 0),
      nullif(v_stock_movement->>'reason', ''),
      nullif(v_stock_movement->>'createdAt', '')::timestamptz,
      nullif(v_stock_movement->>'userId', ''),
      nullif(v_stock_movement->>'relatedBillId', ''),
      v_stock_movement
    )
    on conflict (organization_id, id) do nothing;
  end if;

  if jsonb_typeof(v_audit_log) = 'object' and v_audit_log_id is not null then
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
      coalesce(nullif(v_audit_log->>'action', ''), 'session_item_removed'),
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
    'remove_session_item',
    'session',
    v_session_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'session_item_id', v_session_item_id,
      'stock_movement_id', v_stock_movement_id,
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
      'session_items', jsonb_build_array(v_session_item_id),
      'stock_movements', case when v_stock_movement_id is null then '[]'::jsonb else jsonb_build_array(v_stock_movement_id) end,
      'audit_logs', case when v_audit_log_id is null then '[]'::jsonb else jsonb_build_array(v_audit_log_id) end,
      'operational_events', jsonb_build_array(v_event_id)
    )
  );
end;
$$;

revoke all on function public.remove_session_item(jsonb) from public;
revoke execute on function public.remove_session_item(jsonb) from anon;
grant execute on function public.remove_session_item(jsonb) to authenticated;
