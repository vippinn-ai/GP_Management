-- Phase 5 normalized financial RPC: commit_financial_adjustment.
--
-- Run after phase5-financial-checkout-rpc.sql. This keeps the current
-- app_state compatibility path, but avoids uploading the full app_state blob
-- for supported pending receivable and issued-bill adjustment actions.

create or replace function public.commit_financial_adjustment(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started_at timestamptz := clock_timestamp();
  v_organization_id text := nullif(payload->>'organization_id', '');
  v_mutation_id text := nullif(payload->>'mutation_id', '');
  v_mutation_kind text := nullif(payload->>'mutation_kind', '');
  v_entity_type text := nullif(payload->>'entity_type', '');
  v_entity_id text := nullif(payload->>'entity_id', '');
  v_user_id text := nullif(payload->>'user_id', '');
  v_client_created_at timestamptz := coalesce(nullif(payload->>'client_created_at', '')::timestamptz, timezone('utc', now()));
  v_expected_version integer := nullif(payload->>'base_app_state_version', '')::integer;
  v_patch jsonb := coalesce(payload->'payload', '{}'::jsonb);
  v_bills jsonb := case when jsonb_typeof(v_patch->'bills') = 'array' then v_patch->'bills' else '[]'::jsonb end;
  v_payments jsonb := case when jsonb_typeof(v_patch->'payments') = 'array' then v_patch->'payments' else '[]'::jsonb end;
  v_stock_movements jsonb := case when jsonb_typeof(v_patch->'stockMovements') = 'array' then v_patch->'stockMovements' else '[]'::jsonb end;
  v_audit_logs jsonb := case when jsonb_typeof(v_patch->'auditLogs') = 'array' then v_patch->'auditLogs' else '[]'::jsonb end;
  v_inventory_items jsonb := case when jsonb_typeof(v_patch->'inventoryItems') = 'array' then v_patch->'inventoryItems' else '[]'::jsonb end;
  v_bill_ids text[] := array[]::text[];
  v_event_id text;
  v_event_metadata jsonb := '{}'::jsonb;
  v_app_state_data jsonb;
  v_next_app_state_data jsonb;
  v_app_state_version integer;
  v_next_app_state_version integer;
  v_updated_by uuid;
  v_server_duration_ms numeric;
begin
  if v_organization_id is null then
    perform public.raise_operational_rpc_error('invalid_payload', 'The financial adjustment payload is missing an organization.', '{}'::jsonb);
  end if;

  if not (select public.current_user_has_org_access(v_organization_id)) then
    perform public.raise_operational_rpc_error(
      'organization_access_denied',
      'You do not have access to this organization.',
      jsonb_build_object('organization_id', v_organization_id)
    );
  end if;

  if v_mutation_id is null
    or v_mutation_kind not in ('settlePendingBills', 'writeOffPendingBills', 'voidBill', 'refundBill')
    or v_user_id is null
  then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The financial adjustment payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_entity_type not in ('bill', 'bill_group') or v_entity_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The financial adjustment entity is invalid.',
      jsonb_build_object('entity_type', v_entity_type, 'entity_id', v_entity_id)
    );
  end if;

  select coalesce(array_agg(distinct nullif(bill.value->>'id', '')), array[]::text[])
  into v_bill_ids
  from jsonb_array_elements(v_bills) as bill(value)
  where nullif(bill.value->>'id', '') is not null;

  if coalesce(array_length(v_bill_ids, 1), 0) = 0 then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The financial adjustment payload is missing bill updates.',
      jsonb_build_object('mutation_kind', v_mutation_kind)
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
      'mutation_kind', coalesce(v_event_metadata->>'mutation_kind', v_mutation_kind),
      'organization_id', v_organization_id,
      'entity_type', v_entity_type,
      'entity_id', v_entity_id,
      'app_state_version', nullif(v_event_metadata->>'app_state_version', '')::integer,
      'event_id', v_event_id,
      'server_time', timezone('utc', now()),
      'server_duration_ms', nullif(v_event_metadata->>'server_duration_ms', '')::numeric,
      'idempotent', true,
      'changed_rows', coalesce(v_event_metadata->'changed_rows', '{}'::jsonb)
    );
  end if;

  perform pg_advisory_xact_lock(hashtext(v_organization_id || ':financial-adjustment:' || v_mutation_kind || ':' || v_entity_type || ':' || v_entity_id));

  select app_state.data, app_state.version
  into v_app_state_data, v_app_state_version
  from public.app_state
  where app_state.id = 'primary'
  for update;

  if v_app_state_data is null then
    perform public.raise_operational_rpc_error('app_state_missing', 'App state is not initialized.', '{}'::jsonb);
  end if;

  if v_expected_version is not null and v_app_state_version <> v_expected_version then
    perform public.raise_operational_rpc_error(
      'app_state_conflict',
      'Remote data changed in another browser. Refreshing latest data.',
      jsonb_build_object('expected_version', v_expected_version, 'actual_version', v_app_state_version)
    );
  end if;

  perform 1
  from public.bills
  where bills.organization_id = v_organization_id
    and bills.id = any(v_bill_ids)
  for update;

  if exists (
    select 1
    from unnest(v_bill_ids) as requested_bill(id)
    left join public.bills
      on bills.organization_id = v_organization_id
      and bills.id = requested_bill.id
    where bills.id is null
  ) then
    perform public.raise_operational_rpc_error(
      'bill_not_found',
      'One or more bills no longer exist. Refresh and try again.',
      jsonb_build_object('bill_ids', to_jsonb(v_bill_ids))
    );
  end if;

  if v_mutation_kind in ('settlePendingBills', 'writeOffPendingBills') and exists (
    select 1
    from public.bills
    where bills.organization_id = v_organization_id
      and bills.id = any(v_bill_ids)
      and bills.status <> 'pending'
  ) then
    perform public.raise_operational_rpc_error(
      'bill_not_pending',
      'One or more pending bills were already changed. Refresh and try again.',
      jsonb_build_object('bill_ids', to_jsonb(v_bill_ids))
    );
  end if;

  if v_mutation_kind in ('voidBill', 'refundBill') and exists (
    select 1
    from public.bills
    where bills.organization_id = v_organization_id
      and bills.id = any(v_bill_ids)
      and bills.status <> 'issued'
  ) then
    perform public.raise_operational_rpc_error(
      'bill_not_issued',
      'This bill was already changed. Refresh and try again.',
      jsonb_build_object('bill_ids', to_jsonb(v_bill_ids))
    );
  end if;

  if v_mutation_kind = 'settlePendingBills' and exists (
    select 1
    from jsonb_array_elements(v_bills) as bill(value)
    where coalesce(nullif(bill.value->>'status', ''), 'pending') not in ('pending', 'issued')
  ) then
    perform public.raise_operational_rpc_error('invalid_payload', 'Settlement bill status is invalid.', '{}'::jsonb);
  end if;

  if v_mutation_kind = 'writeOffPendingBills' and exists (
    select 1
    from jsonb_array_elements(v_bills) as bill(value)
    where coalesce(nullif(bill.value->>'status', ''), '') <> 'voided'
  ) then
    perform public.raise_operational_rpc_error('invalid_payload', 'Write-off bill status is invalid.', '{}'::jsonb);
  end if;

  if v_mutation_kind = 'voidBill' and exists (
    select 1
    from jsonb_array_elements(v_bills) as bill(value)
    where coalesce(nullif(bill.value->>'status', ''), '') <> 'voided'
  ) then
    perform public.raise_operational_rpc_error('invalid_payload', 'Void bill status is invalid.', '{}'::jsonb);
  end if;

  if v_mutation_kind = 'refundBill' and exists (
    select 1
    from jsonb_array_elements(v_bills) as bill(value)
    where coalesce(nullif(bill.value->>'status', ''), '') <> 'refunded'
  ) then
    perform public.raise_operational_rpc_error('invalid_payload', 'Refund bill status is invalid.', '{}'::jsonb);
  end if;

  if v_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_updated_by := v_user_id::uuid;
  end if;

  insert into public.inventory_items (
    organization_id,
    id,
    name,
    category,
    price,
    stock_qty,
    low_stock_threshold,
    unit,
    is_reusable,
    barcode,
    active,
    archived_at,
    archived_by_user_id,
    archive_reason,
    sell_base_item,
    cigarette_pack,
    raw_data
  )
  select
    v_organization_id,
    item->>'id',
    coalesce(nullif(item->>'name', ''), item->>'id'),
    nullif(item->>'category', ''),
    coalesce(nullif(item->>'price', '')::numeric, 0),
    coalesce(nullif(item->>'stockQty', '')::numeric, 0),
    coalesce(nullif(item->>'lowStockThreshold', '')::numeric, 0),
    coalesce(nullif(item->>'unit', ''), 'piece'),
    coalesce(nullif(item->>'isReusable', '')::boolean, false),
    nullif(item->>'barcode', ''),
    coalesce(nullif(item->>'active', '')::boolean, true),
    nullif(item->>'archivedAt', '')::timestamptz,
    nullif(item->>'archivedByUserId', ''),
    nullif(item->>'archiveReason', ''),
    coalesce(nullif(item->>'sellBaseItem', '')::boolean, true),
    item->'cigarettePack',
    item
  from jsonb_array_elements(v_inventory_items) as source(item)
  where item ? 'id'
  on conflict (organization_id, id) do update
  set
    name = excluded.name,
    category = excluded.category,
    price = excluded.price,
    stock_qty = excluded.stock_qty,
    low_stock_threshold = excluded.low_stock_threshold,
    unit = excluded.unit,
    is_reusable = excluded.is_reusable,
    barcode = excluded.barcode,
    active = excluded.active,
    archived_at = excluded.archived_at,
    archived_by_user_id = excluded.archived_by_user_id,
    archive_reason = excluded.archive_reason,
    sell_base_item = excluded.sell_base_item,
    cigarette_pack = excluded.cigarette_pack,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

  insert into public.bills (
    organization_id,
    id,
    bill_number,
    status,
    created_at_source,
    issued_at,
    issued_by_user_id,
    customer_id,
    customer_name,
    customer_phone,
    payment_mode,
    station_id,
    session_id,
    amount_paid,
    amount_due,
    subtotal,
    total_discount_amount,
    bill_discount_amount,
    round_off_enabled,
    round_off_amount,
    total,
    receipt_type,
    replacement_of_bill_id,
    replaced_by_bill_id,
    replaced_at,
    replaced_by_user_id,
    replace_reason,
    voided_at,
    voided_by_user_id,
    void_reason,
    settled_at,
    settled_by_user_id,
    raw_data
  )
  select
    v_organization_id,
    bill->>'id',
    coalesce(nullif(bill->>'billNumber', ''), bill->>'id'),
    coalesce(nullif(bill->>'status', ''), 'issued'),
    nullif(bill->>'createdAt', '')::timestamptz,
    nullif(bill->>'issuedAt', '')::timestamptz,
    nullif(bill->>'issuedByUserId', ''),
    nullif(bill->>'customerId', ''),
    nullif(bill->>'customerName', ''),
    nullif(bill->>'customerPhone', ''),
    nullif(bill->>'paymentMode', ''),
    nullif(bill->>'stationId', ''),
    nullif(bill->>'sessionId', ''),
    coalesce(nullif(bill->>'amountPaid', '')::numeric, 0),
    coalesce(nullif(bill->>'amountDue', '')::numeric, 0),
    coalesce(nullif(bill->>'subtotal', '')::numeric, 0),
    coalesce(nullif(bill->>'totalDiscountAmount', '')::numeric, 0),
    coalesce(nullif(bill->>'billDiscountAmount', '')::numeric, 0),
    coalesce(nullif(bill->>'roundOffEnabled', '')::boolean, false),
    coalesce(nullif(bill->>'roundOffAmount', '')::numeric, 0),
    coalesce(nullif(bill->>'total', '')::numeric, 0),
    nullif(bill->>'receiptType', ''),
    nullif(bill->>'replacementOfBillId', ''),
    nullif(bill->>'replacedByBillId', ''),
    nullif(bill->>'replacedAt', '')::timestamptz,
    nullif(bill->>'replacedByUserId', ''),
    nullif(bill->>'replaceReason', ''),
    nullif(bill->>'voidedAt', '')::timestamptz,
    nullif(bill->>'voidedByUserId', ''),
    nullif(bill->>'voidReason', ''),
    nullif(bill->>'settledAt', '')::timestamptz,
    nullif(bill->>'settledByUserId', ''),
    bill
  from jsonb_array_elements(v_bills) as source(bill)
  where bill ? 'id'
  on conflict (organization_id, id) do update
  set
    bill_number = excluded.bill_number,
    status = excluded.status,
    created_at_source = excluded.created_at_source,
    issued_at = excluded.issued_at,
    issued_by_user_id = excluded.issued_by_user_id,
    customer_id = excluded.customer_id,
    customer_name = excluded.customer_name,
    customer_phone = excluded.customer_phone,
    payment_mode = excluded.payment_mode,
    station_id = excluded.station_id,
    session_id = excluded.session_id,
    amount_paid = excluded.amount_paid,
    amount_due = excluded.amount_due,
    subtotal = excluded.subtotal,
    total_discount_amount = excluded.total_discount_amount,
    bill_discount_amount = excluded.bill_discount_amount,
    round_off_enabled = excluded.round_off_enabled,
    round_off_amount = excluded.round_off_amount,
    total = excluded.total,
    receipt_type = excluded.receipt_type,
    replacement_of_bill_id = excluded.replacement_of_bill_id,
    replaced_by_bill_id = excluded.replaced_by_bill_id,
    replaced_at = excluded.replaced_at,
    replaced_by_user_id = excluded.replaced_by_user_id,
    replace_reason = excluded.replace_reason,
    voided_at = excluded.voided_at,
    voided_by_user_id = excluded.voided_by_user_id,
    void_reason = excluded.void_reason,
    settled_at = excluded.settled_at,
    settled_by_user_id = excluded.settled_by_user_id,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

  insert into public.payments (
    organization_id,
    id,
    bill_id,
    mode,
    amount,
    paid_at,
    received_by_user_id,
    settlement_group_id,
    related_checkout_bill_id,
    raw_data
  )
  select
    v_organization_id,
    payment->>'id',
    nullif(payment->>'billId', ''),
    coalesce(nullif(payment->>'mode', ''), 'cash'),
    coalesce(nullif(payment->>'amount', '')::numeric, 0),
    nullif(payment->>'createdAt', '')::timestamptz,
    nullif(payment->>'receivedByUserId', ''),
    nullif(payment->>'settlementGroupId', ''),
    nullif(payment->>'relatedCheckoutBillId', ''),
    payment
  from jsonb_array_elements(v_payments) as source(payment)
  where payment ? 'id'
  on conflict (organization_id, id) do update
  set
    bill_id = excluded.bill_id,
    mode = excluded.mode,
    amount = excluded.amount,
    paid_at = excluded.paid_at,
    received_by_user_id = excluded.received_by_user_id,
    settlement_group_id = excluded.settlement_group_id,
    related_checkout_bill_id = excluded.related_checkout_bill_id,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

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
  from jsonb_array_elements(v_stock_movements) as source(movement)
  where movement ? 'id'
  on conflict (organization_id, id) do update
  set
    item_id = excluded.item_id,
    type = excluded.type,
    quantity = excluded.quantity,
    reason = excluded.reason,
    movement_at = excluded.movement_at,
    user_id = excluded.user_id,
    related_bill_id = excluded.related_bill_id,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

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
  from jsonb_array_elements(v_audit_logs) as source(audit)
  where audit ? 'id'
  on conflict (organization_id, id) do update
  set
    action = excluded.action,
    entity_type = excluded.entity_type,
    entity_id = excluded.entity_id,
    message = excluded.message,
    audit_at = excluded.audit_at,
    user_id = excluded.user_id,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

  v_next_app_state_data := coalesce(v_app_state_data, '{}'::jsonb);
  v_next_app_state_data := jsonb_set(v_next_app_state_data, '{inventoryItems}', public.patch_app_state_array_by_id(v_next_app_state_data->'inventoryItems', v_inventory_items), true);
  v_next_app_state_data := jsonb_set(v_next_app_state_data, '{bills}', public.patch_app_state_array_by_id(v_next_app_state_data->'bills', v_bills), true);
  v_next_app_state_data := jsonb_set(v_next_app_state_data, '{payments}', public.patch_app_state_array_by_id(v_next_app_state_data->'payments', v_payments), true);
  v_next_app_state_data := jsonb_set(v_next_app_state_data, '{stockMovements}', public.patch_app_state_array_by_id(v_next_app_state_data->'stockMovements', v_stock_movements), true);
  v_next_app_state_data := jsonb_set(v_next_app_state_data, '{auditLogs}', public.patch_app_state_array_by_id(v_next_app_state_data->'auditLogs', v_audit_logs), true);

  update public.app_state
  set
    data = v_next_app_state_data,
    version = v_app_state_version + 1,
    updated_at = timezone('utc', now()),
    updated_by = v_updated_by
  where app_state.id = 'primary'
  returning app_state.version into v_next_app_state_version;

  v_server_duration_ms := round((extract(epoch from (clock_timestamp() - v_started_at)) * 1000)::numeric, 3);

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
    'financial_adjustment_committed',
    v_entity_type,
    v_entity_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'client_created_at', v_client_created_at,
      'app_state_version', v_next_app_state_version,
      'server_duration_ms', v_server_duration_ms,
      'changed_rows', jsonb_build_object(
        'bills', coalesce((select jsonb_agg(entry.value->>'id') from jsonb_array_elements(v_bills) as entry(value) where entry.value ? 'id'), '[]'::jsonb),
        'payments', coalesce((select jsonb_agg(entry.value->>'id') from jsonb_array_elements(v_payments) as entry(value) where entry.value ? 'id'), '[]'::jsonb),
        'stock_movements', coalesce((select jsonb_agg(entry.value->>'id') from jsonb_array_elements(v_stock_movements) as entry(value) where entry.value ? 'id'), '[]'::jsonb),
        'audit_logs', coalesce((select jsonb_agg(entry.value->>'id') from jsonb_array_elements(v_audit_logs) as entry(value) where entry.value ? 'id'), '[]'::jsonb),
        'inventory_items', coalesce((select jsonb_agg(entry.value->>'id') from jsonb_array_elements(v_inventory_items) as entry(value) where entry.value ? 'id'), '[]'::jsonb)
      )
    )
  )
  returning id, metadata into v_event_id, v_event_metadata;

  return jsonb_build_object(
    'mutation_id', v_mutation_id,
    'mutation_kind', v_mutation_kind,
    'organization_id', v_organization_id,
    'entity_type', v_entity_type,
    'entity_id', v_entity_id,
    'app_state_version', v_next_app_state_version,
    'event_id', v_event_id,
    'server_time', timezone('utc', now()),
    'server_duration_ms', v_server_duration_ms,
    'changed_rows', v_event_metadata->'changed_rows'
  );
end;
$$;

revoke all on function public.commit_financial_adjustment(jsonb) from public;
revoke execute on function public.commit_financial_adjustment(jsonb) from anon;
grant execute on function public.commit_financial_adjustment(jsonb) to authenticated;
