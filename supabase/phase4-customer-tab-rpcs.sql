-- Phase 4 normalized write RPCs for customer tabs.
--
-- Run after supabase/phase4-start-session-rpc.sql because these functions
-- reuse public.raise_operational_rpc_error.

create or replace function public.resolve_operational_inventory_item(
  target_organization_id text,
  target_item_id text
)
returns table(item_name text, stock_qty numeric)
language sql
security definer
set search_path = public
as $$
  select inventory_items.name, inventory_items.stock_qty
  from public.inventory_items
  where inventory_items.organization_id = target_organization_id
    and inventory_items.id = target_item_id
  limit 1
  for update;
$$;

revoke all on function public.resolve_operational_inventory_item(text, text) from public;
revoke execute on function public.resolve_operational_inventory_item(text, text) from anon;
revoke execute on function public.resolve_operational_inventory_item(text, text) from authenticated;

create or replace function public.resolve_operational_customer(
  target_organization_id text,
  customer_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_name text;
  v_customer_phone text;
  v_customer_phone_key text;
  v_customer_name_key text;
  v_resolved_customer_id text;
begin
  if jsonb_typeof(customer_payload) <> 'object' then
    return null;
  end if;

  v_customer_name := nullif(trim(coalesce(customer_payload->>'name', '')), '');
  v_customer_phone := nullif(trim(coalesce(customer_payload->>'phone', '')), '');
  v_customer_phone_key := nullif(regexp_replace(coalesce(v_customer_phone, ''), '\D', '', 'g'), '');
  v_customer_name_key := nullif(lower(regexp_replace(coalesce(v_customer_name, ''), '\s+', ' ', 'g')), '');

  if v_customer_name is null and v_customer_phone is null then
    return null;
  end if;

  if v_customer_phone_key is not null then
    select customers.id
    into v_resolved_customer_id
    from public.customers
    where customers.organization_id = target_organization_id
      and regexp_replace(coalesce(customers.phone, ''), '\D', '', 'g') = v_customer_phone_key
    order by customers.last_visit_at desc nulls last, customers.created_at desc
    limit 1;
  end if;

  if v_resolved_customer_id is null and v_customer_name_key is not null then
    select customers.id
    into v_resolved_customer_id
    from public.customers
    where customers.organization_id = target_organization_id
      and nullif(regexp_replace(coalesce(customers.phone, ''), '\D', '', 'g'), '') is null
      and lower(regexp_replace(trim(coalesce(customers.name, '')), '\s+', ' ', 'g')) = v_customer_name_key
    order by customers.last_visit_at desc nulls last, customers.created_at desc
    limit 1;
  end if;

  if v_resolved_customer_id is null then
    v_resolved_customer_id := coalesce(nullif(customer_payload->>'id', ''), 'customer-' || gen_random_uuid()::text);
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
      target_organization_id,
      v_resolved_customer_id,
      coalesce(v_customer_name, v_customer_phone, 'Walk-in'),
      v_customer_phone,
      nullif(customer_payload->>'visitAt', '')::timestamptz,
      nullif(customer_payload->>'visitAt', '')::timestamptz,
      customer_payload
    )
    on conflict (organization_id, id) do update
    set
      name = excluded.name,
      phone = coalesce(excluded.phone, customers.phone),
      last_visit_at = excluded.last_visit_at,
      raw_data = excluded.raw_data,
      updated_at = timezone('utc', now());
    return v_resolved_customer_id;
  end if;

  update public.customers
  set
    name = coalesce(v_customer_name, v_customer_phone, customers.name),
    phone = coalesce(v_customer_phone, customers.phone),
    last_visit_at = coalesce(nullif(customer_payload->>'visitAt', '')::timestamptz, customers.last_visit_at),
    raw_data = coalesce(customers.raw_data, '{}'::jsonb) || customer_payload,
    updated_at = timezone('utc', now())
  where customers.organization_id = target_organization_id
    and customers.id = v_resolved_customer_id;

  return v_resolved_customer_id;
end;
$$;

revoke all on function public.resolve_operational_customer(text, jsonb) from public;
revoke execute on function public.resolve_operational_customer(text, jsonb) from anon;
revoke execute on function public.resolve_operational_customer(text, jsonb) from authenticated;

create or replace function public.open_customer_tab(payload jsonb)
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
  v_tab jsonb := coalesce(payload #> '{payload,tab}', '{}'::jsonb);
  v_customer jsonb := payload #> '{payload,customer}';
  v_audit_log jsonb := coalesce(payload #> '{payload,auditLog}', '{}'::jsonb);
  v_customer_tab_id text := nullif(v_tab->>'id', '');
  v_customer_name text := nullif(trim(coalesce(v_tab->>'customerName', '')), '');
  v_customer_phone text := nullif(trim(coalesce(v_tab->>'customerPhone', '')), '');
  v_customer_id_hint text := nullif(v_customer->>'id', '');
  v_customer_phone_key text := nullif(regexp_replace(coalesce(v_customer_phone, ''), '\D', '', 'g'), '');
  v_customer_name_key text := nullif(lower(regexp_replace(trim(coalesce(v_customer_name, '')), '\s+', ' ', 'g')), '');
  v_customer_lock_key text;
  v_resolved_customer_id text;
  v_matching_tab_id text;
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

  if v_mutation_id is null or v_mutation_kind <> 'openCustomerTab' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_customer_tab_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The customer tab payload is missing a tab id.',
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
        'customer_tabs', jsonb_build_array(coalesce(v_event_metadata->>'customer_tab_id', v_customer_tab_id)),
        'customers', case
          when v_event_metadata->>'customer_id' is null then '[]'::jsonb
          else jsonb_build_array(v_event_metadata->>'customer_id')
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
    from public.customer_tabs
    where customer_tabs.organization_id = v_organization_id
      and customer_tabs.id = v_customer_tab_id
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
        'customers', '[]'::jsonb,
        'audit_logs', '[]'::jsonb,
        'operational_events', '[]'::jsonb
      )
    );
  end if;

  v_customer_lock_key := coalesce(v_customer_phone_key, v_customer_name_key, v_customer_id_hint, v_customer_tab_id);
  perform pg_advisory_xact_lock(hashtext(v_organization_id || ':customer-tab:' || v_customer_lock_key));

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
        'customer_tabs', jsonb_build_array(coalesce(v_event_metadata->>'customer_tab_id', v_customer_tab_id)),
        'customers', case
          when v_event_metadata->>'customer_id' is null then '[]'::jsonb
          else jsonb_build_array(v_event_metadata->>'customer_id')
        end,
        'audit_logs', case
          when coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id))
        end,
        'operational_events', jsonb_build_array(v_event_id)
      )
    );
  end if;

  v_resolved_customer_id := public.resolve_operational_customer(v_organization_id, v_customer);

  select customer_tabs.id
  into v_matching_tab_id
  from public.customer_tabs
  where customer_tabs.organization_id = v_organization_id
    and customer_tabs.status = 'open'
    and (
      (v_resolved_customer_id is not null and customer_tabs.customer_id = v_resolved_customer_id)
      or (v_customer_phone_key is not null and regexp_replace(coalesce(customer_tabs.customer_phone, ''), '\D', '', 'g') = v_customer_phone_key)
      or (
        v_customer_name_key is not null
        and lower(regexp_replace(trim(coalesce(customer_tabs.customer_name, '')), '\s+', ' ', 'g')) = v_customer_name_key
      )
    )
  order by customer_tabs.opened_at desc nulls last, customer_tabs.created_at desc
  limit 1;

  if v_matching_tab_id is not null then
    perform public.raise_operational_rpc_error(
      'matching_customer_tab_open',
      'A matching customer tab is already open.',
      jsonb_build_object('customer_tab_id', v_matching_tab_id)
    );
  end if;

  insert into public.customer_tabs (
    organization_id,
    id,
    customer_id,
    customer_name,
    customer_phone,
    status,
    opened_at,
    closed_at,
    continued_from_session_ids,
    closed_bill_id,
    close_disposition,
    close_reason,
    raw_data
  )
  values (
    v_organization_id,
    v_customer_tab_id,
    v_resolved_customer_id,
    coalesce(v_customer_name, 'Walk-in customer'),
    v_customer_phone,
    coalesce(nullif(v_tab->>'status', ''), 'open'),
    nullif(v_tab->>'createdAt', '')::timestamptz,
    nullif(v_tab->>'closedAt', '')::timestamptz,
    v_tab->'continuedFromSessionIds',
    nullif(v_tab->>'closedBillId', ''),
    nullif(v_tab->>'closeDisposition', ''),
    nullif(v_tab->>'closeReason', ''),
    v_tab || jsonb_build_object('customerId', v_resolved_customer_id)
  );

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
      coalesce(nullif(v_audit_log->>'action', ''), 'customer_tab_opened'),
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
    'open_customer_tab',
    'customer_tab',
    v_customer_tab_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'customer_tab_id', v_customer_tab_id,
      'customer_id', v_resolved_customer_id,
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
      'customers', case when v_resolved_customer_id is null then '[]'::jsonb else jsonb_build_array(v_resolved_customer_id) end,
      'audit_logs', case when v_audit_log_id is null then '[]'::jsonb else jsonb_build_array(v_audit_log_id) end,
      'operational_events', jsonb_build_array(v_event_id)
    )
  );
end;
$$;

revoke all on function public.open_customer_tab(jsonb) from public;
revoke execute on function public.open_customer_tab(jsonb) from anon;
grant execute on function public.open_customer_tab(jsonb) to authenticated;

create or replace function public.add_customer_tab_item(payload jsonb)
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
  v_line jsonb := coalesce(payload #> '{payload,line}', '{}'::jsonb);
  v_audit_log jsonb := coalesce(payload #> '{payload,auditLog}', '{}'::jsonb);
  v_line_id text := nullif(v_line->>'id', '');
  v_inventory_item_id text := nullif(v_line->>'inventoryItemId', '');
  v_quantity_delta numeric := coalesce(nullif(payload #>> '{payload,quantityDelta}', '')::numeric, 0);
  v_stock_units_per_sale numeric := coalesce(
    nullif(v_line->>'stockUnitsPerSale', '')::numeric,
    nullif(v_line->>'soldAsPackOf', '')::numeric,
    1
  );
  v_required_quantity numeric := v_quantity_delta * v_stock_units_per_sale;
  v_tab_status text;
  v_item_name text;
  v_item_stock numeric;
  v_session_reserved numeric := 0;
  v_tab_reserved numeric := 0;
  v_available numeric := 0;
  v_existing_line_id text;
  v_changed_line_id text;
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

  if v_mutation_id is null or v_mutation_kind <> 'addCustomerTabItem' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_customer_tab_id is null or v_line_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The customer tab item payload is missing a tab or line id.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id, 'line_id', v_line_id)
    );
  end if;

  if v_quantity_delta <= 0 or v_stock_units_per_sale <= 0 then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The customer tab item quantity is invalid.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id, 'line_id', v_line_id, 'quantity_delta', v_quantity_delta)
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
        'customer_tab_items', jsonb_build_array(coalesce(v_event_metadata->>'line_id', v_line_id)),
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
        'customer_tab_items', jsonb_build_array(coalesce(v_event_metadata->>'line_id', v_line_id)),
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
    from public.customer_tab_items
    where customer_tab_items.organization_id = v_organization_id
      and customer_tab_items.customer_tab_id = v_customer_tab_id
      and customer_tab_items.id = v_line_id
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
        'customer_tab_items', jsonb_build_array(v_line_id),
        'audit_logs', '[]'::jsonb,
        'operational_events', '[]'::jsonb
      )
    );
  end if;

  if v_inventory_item_id is not null then
    select item_snapshot.item_name, item_snapshot.stock_qty
    into v_item_name, v_item_stock
    from public.resolve_operational_inventory_item(v_organization_id, v_inventory_item_id) as item_snapshot;

    if v_item_name is null then
      perform public.raise_operational_rpc_error(
        'inventory_item_missing',
        'An inventory item used by this customer tab item no longer exists.',
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

  select customer_tab_items.id
  into v_existing_line_id
  from public.customer_tab_items
  where customer_tab_items.organization_id = v_organization_id
    and customer_tab_items.customer_tab_id = v_customer_tab_id
    and customer_tab_items.inventory_item_id is not distinct from v_inventory_item_id
    and customer_tab_items.sold_as_pack_of is not distinct from nullif(v_line->>'soldAsPackOf', '')::numeric
    and customer_tab_items.sale_variant_id is not distinct from nullif(v_line->>'saleVariantId', '')
    and customer_tab_items.combo_application_id is not distinct from nullif(v_line->>'comboApplicationId', '')
    and customer_tab_items.combo_id is not distinct from nullif(v_line->>'comboId', '')
  order by customer_tab_items.added_at nulls last, customer_tab_items.created_at
  limit 1
  for update;

  if v_existing_line_id is not null then
    update public.customer_tab_items
    set
      quantity = quantity + v_quantity_delta,
      raw_data = jsonb_set(
        coalesce(raw_data, '{}'::jsonb),
        '{quantity}',
        to_jsonb(quantity + v_quantity_delta),
        true
      ),
      updated_at = timezone('utc', now())
    where customer_tab_items.organization_id = v_organization_id
      and customer_tab_items.customer_tab_id = v_customer_tab_id
      and customer_tab_items.id = v_existing_line_id;
    v_changed_line_id := v_existing_line_id;
  else
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
    values (
      v_organization_id,
      v_customer_tab_id,
      v_line_id,
      v_inventory_item_id,
      coalesce(nullif(v_line->>'name', ''), 'Tab item'),
      coalesce(nullif(v_line->>'quantity', '')::numeric, v_quantity_delta),
      coalesce(nullif(v_line->>'unitPrice', '')::numeric, 0),
      nullif(v_line->>'addedAt', '')::timestamptz,
      nullif(v_line->>'soldAsPackOf', '')::numeric,
      nullif(v_line->>'saleVariantId', ''),
      nullif(v_line->>'stockUnitsPerSale', '')::numeric,
      nullif(v_line->>'comboApplicationId', ''),
      nullif(v_line->>'comboId', ''),
      v_line
    );
    v_changed_line_id := v_line_id;
  end if;

  update public.customer_tabs
  set updated_at = timezone('utc', now())
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
      coalesce(nullif(v_audit_log->>'action', ''), 'customer_tab_item_added'),
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
    'add_customer_tab_item',
    'customer_tab',
    v_customer_tab_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'line_id', v_changed_line_id,
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
      'customer_tab_items', jsonb_build_array(v_changed_line_id),
      'audit_logs', case when v_audit_log_id is null then '[]'::jsonb else jsonb_build_array(v_audit_log_id) end,
      'operational_events', jsonb_build_array(v_event_id)
    )
  );
end;
$$;

revoke all on function public.add_customer_tab_item(jsonb) from public;
revoke execute on function public.add_customer_tab_item(jsonb) from anon;
grant execute on function public.add_customer_tab_item(jsonb) to authenticated;

create or replace function public.update_customer_tab_item_quantity(payload jsonb)
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
  v_line_id text := nullif(payload #>> '{payload,lineId}', '');
  v_quantity numeric := coalesce(nullif(payload #>> '{payload,quantity}', '')::numeric, 0);
  v_tab_status text;
  v_inventory_item_id text;
  v_line_name text;
  v_sold_as_pack_of numeric;
  v_sale_variant_id text;
  v_stock_units_per_sale numeric;
  v_combo_application_id text;
  v_item_name text;
  v_item_stock numeric;
  v_session_reserved numeric := 0;
  v_tab_reserved numeric := 0;
  v_available numeric := 0;
  v_required_quantity numeric;
  v_event_id text;
  v_event_metadata jsonb := '{}'::jsonb;
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

  if v_mutation_id is null or v_mutation_kind <> 'updateCustomerTabItemQuantity' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_customer_tab_id is null or v_line_id is null or v_quantity <= 0 then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The customer tab item quantity payload is invalid.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id, 'line_id', v_line_id, 'quantity', v_quantity)
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
        'customer_tab_items', jsonb_build_array(coalesce(v_event_metadata->>'line_id', v_line_id)),
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
        'customer_tab_items', jsonb_build_array(coalesce(v_event_metadata->>'line_id', v_line_id)),
        'operational_events', jsonb_build_array(v_event_id)
      )
    );
  end if;

  select
    customer_tab_items.inventory_item_id,
    customer_tab_items.name,
    customer_tab_items.sold_as_pack_of,
    customer_tab_items.sale_variant_id,
    coalesce(customer_tab_items.stock_units_per_sale, customer_tab_items.sold_as_pack_of, 1),
    customer_tab_items.combo_application_id
  into
    v_inventory_item_id,
    v_line_name,
    v_sold_as_pack_of,
    v_sale_variant_id,
    v_stock_units_per_sale,
    v_combo_application_id
  from public.customer_tab_items
  where customer_tab_items.organization_id = v_organization_id
    and customer_tab_items.customer_tab_id = v_customer_tab_id
    and customer_tab_items.id = v_line_id
  for update;

  if v_inventory_item_id is null then
    perform public.raise_operational_rpc_error(
      'customer_tab_item_missing',
      'The customer tab item is no longer available.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id, 'line_id', v_line_id)
    );
  end if;

  if v_combo_application_id is not null then
    perform public.raise_operational_rpc_error(
      'combo_item_locked',
      'Included combo items cannot be edited directly.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id, 'line_id', v_line_id)
    );
  end if;

  select item_snapshot.item_name, item_snapshot.stock_qty
  into v_item_name, v_item_stock
  from public.resolve_operational_inventory_item(v_organization_id, v_inventory_item_id) as item_snapshot;

  if v_item_name is null then
    perform public.raise_operational_rpc_error(
      'inventory_item_missing',
      'An inventory item used by this customer tab item no longer exists.',
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
    and customer_tab_items.inventory_item_id = v_inventory_item_id
    and customer_tabs.status = 'open'
    and not (
      customer_tabs.id = v_customer_tab_id
      and customer_tab_items.id = v_line_id
    );

  v_required_quantity := v_quantity * v_stock_units_per_sale;
  v_available := greatest(0, v_item_stock - v_session_reserved - v_tab_reserved);

  if v_required_quantity > v_available then
    perform public.raise_operational_rpc_error(
      'insufficient_stock',
      v_item_name || ' no longer has enough available stock.',
      jsonb_build_object(
        'item_id', v_inventory_item_id,
        'item_name', v_item_name,
        'line_name', v_line_name,
        'required_quantity', v_required_quantity,
        'available_quantity', v_available
      )
    );
  end if;

  update public.customer_tab_items
  set
    quantity = v_quantity,
    raw_data = jsonb_set(coalesce(raw_data, '{}'::jsonb), '{quantity}', to_jsonb(v_quantity), true),
    updated_at = timezone('utc', now())
  where customer_tab_items.organization_id = v_organization_id
    and customer_tab_items.customer_tab_id = v_customer_tab_id
    and customer_tab_items.id = v_line_id;

  update public.customer_tabs
  set updated_at = timezone('utc', now())
  where customer_tabs.organization_id = v_organization_id
    and customer_tabs.id = v_customer_tab_id;

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
    'update_customer_tab_item_quantity',
    'customer_tab',
    v_customer_tab_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'line_id', v_line_id,
      'quantity', v_quantity
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
      'customer_tab_items', jsonb_build_array(v_line_id),
      'operational_events', jsonb_build_array(v_event_id)
    )
  );
end;
$$;

revoke all on function public.update_customer_tab_item_quantity(jsonb) from public;
revoke execute on function public.update_customer_tab_item_quantity(jsonb) from anon;
grant execute on function public.update_customer_tab_item_quantity(jsonb) to authenticated;

create or replace function public.remove_customer_tab_item(payload jsonb)
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
  v_line_id text := nullif(payload #>> '{payload,lineId}', '');
  v_audit_log jsonb := payload #> '{payload,auditLog}';
  v_tab_status text;
  v_existing_line_id text;
  v_combo_application_id text;
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

  if v_mutation_id is null or v_mutation_kind <> 'removeCustomerTabItem' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_customer_tab_id is null or v_line_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The remove customer tab item payload is missing a tab or line id.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id, 'line_id', v_line_id)
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
        'customer_tab_items', jsonb_build_array(coalesce(v_event_metadata->>'line_id', v_line_id)),
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
        'customer_tab_items', jsonb_build_array(coalesce(v_event_metadata->>'line_id', v_line_id)),
        'audit_logs', case
          when coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id))
        end,
        'operational_events', jsonb_build_array(v_event_id)
      )
    );
  end if;

  select customer_tab_items.id, customer_tab_items.combo_application_id
  into v_existing_line_id, v_combo_application_id
  from public.customer_tab_items
  where customer_tab_items.organization_id = v_organization_id
    and customer_tab_items.customer_tab_id = v_customer_tab_id
    and customer_tab_items.id = v_line_id
  for update;

  if v_existing_line_id is null then
    perform public.raise_operational_rpc_error(
      'customer_tab_item_missing',
      'The customer tab item is no longer available.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id, 'line_id', v_line_id)
    );
  end if;

  if v_combo_application_id is not null then
    perform public.raise_operational_rpc_error(
      'combo_item_locked',
      'Included combo items cannot be removed directly.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id, 'line_id', v_line_id)
    );
  end if;

  delete from public.customer_tab_items
  where customer_tab_items.organization_id = v_organization_id
    and customer_tab_items.customer_tab_id = v_customer_tab_id
    and customer_tab_items.id = v_line_id;

  update public.customer_tabs
  set updated_at = timezone('utc', now())
  where customer_tabs.organization_id = v_organization_id
    and customer_tabs.id = v_customer_tab_id;

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
      coalesce(nullif(v_audit_log->>'action', ''), 'customer_tab_item_removed'),
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
    'remove_customer_tab_item',
    'customer_tab',
    v_customer_tab_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'line_id', v_line_id,
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
      'customer_tab_items', jsonb_build_array(v_line_id),
      'audit_logs', case when v_audit_log_id is null then '[]'::jsonb else jsonb_build_array(v_audit_log_id) end,
      'operational_events', jsonb_build_array(v_event_id)
    )
  );
end;
$$;

revoke all on function public.remove_customer_tab_item(jsonb) from public;
revoke execute on function public.remove_customer_tab_item(jsonb) from anon;
grant execute on function public.remove_customer_tab_item(jsonb) to authenticated;
