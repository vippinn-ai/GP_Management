-- Phase 5 normalized financial RPC: commit_checkout_bill.
--
-- Run after all Phase 4 operational RPC scripts. This keeps the current
-- app_state compatibility path, but avoids uploading the full app_state blob
-- for supported issue-bill checkouts.

create or replace function public.patch_app_state_array_by_id(
  target_array jsonb,
  patch_array jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_target jsonb := case when jsonb_typeof(target_array) = 'array' then target_array else '[]'::jsonb end;
  v_patches jsonb := case when jsonb_typeof(patch_array) = 'array' then patch_array else '[]'::jsonb end;
  v_result jsonb := '[]'::jsonb;
  v_existing_ids text[] := array[]::text[];
  v_entry jsonb;
  v_entry_id text;
  v_patch jsonb;
  v_missing jsonb := '[]'::jsonb;
begin
  for v_entry in
    select item.value
    from jsonb_array_elements(v_target) as item(value)
  loop
    v_entry_id := nullif(v_entry->>'id', '');
    v_patch := null;

    if v_entry_id is not null then
      v_existing_ids := array_append(v_existing_ids, v_entry_id);
      select patch.value
      into v_patch
      from jsonb_array_elements(v_patches) with ordinality as patch(value, ordinality)
      where patch.value->>'id' = v_entry_id
      order by patch.ordinality
      limit 1;
    end if;

    v_result := v_result || jsonb_build_array(coalesce(v_patch, v_entry));
  end loop;

  select coalesce(jsonb_agg(patch.value order by patch.ordinality), '[]'::jsonb)
  into v_missing
  from jsonb_array_elements(v_patches) with ordinality as patch(value, ordinality)
  where nullif(patch.value->>'id', '') is not null
    and not ((patch.value->>'id') = any(v_existing_ids));

  return coalesce(v_missing, '[]'::jsonb) || v_result;
end;
$$;

revoke all on function public.patch_app_state_array_by_id(jsonb, jsonb) from public;
revoke execute on function public.patch_app_state_array_by_id(jsonb, jsonb) from anon;
revoke execute on function public.patch_app_state_array_by_id(jsonb, jsonb) from authenticated;

create or replace function public.commit_checkout_bill(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id text := nullif(payload->>'organization_id', '');
  v_mutation_id text := nullif(payload->>'mutation_id', '');
  v_mutation_kind text := nullif(payload->>'mutation_kind', '');
  v_entity_type text := nullif(payload->>'entity_type', '');
  v_entity_id text := nullif(payload->>'entity_id', '');
  v_user_id text := nullif(payload->>'user_id', '');
  v_client_created_at timestamptz := coalesce(nullif(payload->>'client_created_at', '')::timestamptz, timezone('utc', now()));
  v_expected_version integer := nullif(payload->>'base_app_state_version', '')::integer;
  v_patch jsonb := coalesce(payload->'payload', '{}'::jsonb);
  v_mode text := nullif(v_patch->>'mode', '');
  v_bill jsonb := coalesce(v_patch->'bill', '{}'::jsonb);
  v_bill_id text := nullif(v_bill->>'id', '');
  v_bill_number text := nullif(v_bill->>'billNumber', '');
  v_bills jsonb := case
    when jsonb_typeof(v_patch->'bills') = 'array' and jsonb_array_length(v_patch->'bills') > 0 then v_patch->'bills'
    when jsonb_typeof(v_bill) = 'object' and v_bill ? 'id' then jsonb_build_array(v_bill)
    else '[]'::jsonb
  end;
  v_payments jsonb := coalesce(v_patch->'payments', '[]'::jsonb);
  v_stock_movements jsonb := coalesce(v_patch->'stockMovements', '[]'::jsonb);
  v_audit_logs jsonb := coalesce(v_patch->'auditLogs', '[]'::jsonb);
  v_customers jsonb := coalesce(v_patch->'customers', '[]'::jsonb);
  v_sessions jsonb := coalesce(v_patch->'sessions', '[]'::jsonb);
  v_customer_tabs jsonb := coalesce(v_patch->'customerTabs', '[]'::jsonb);
  v_inventory_items jsonb := coalesce(v_patch->'inventoryItems', '[]'::jsonb);
  v_event_id text;
  v_event_metadata jsonb := '{}'::jsonb;
  v_app_state_data jsonb;
  v_next_app_state_data jsonb;
  v_app_state_version integer;
  v_next_app_state_version integer;
  v_updated_by uuid;
  v_session_status text;
  v_session_closed_bill_id text;
  v_session_close_disposition text;
  v_tab_status text;
  v_tab_closed_bill_id text;
  v_row jsonb;
begin
  if v_organization_id is null then
    perform public.raise_operational_rpc_error('invalid_payload', 'The checkout payload is missing an organization.', '{}'::jsonb);
  end if;

  if not (select public.current_user_has_org_access(v_organization_id)) then
    perform public.raise_operational_rpc_error(
      'organization_access_denied',
      'You do not have access to this organization.',
      jsonb_build_object('organization_id', v_organization_id)
    );
  end if;

  if v_mutation_id is null or v_mutation_kind <> 'commitCheckoutBill' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The checkout payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_entity_type not in ('session', 'customer_tab') or v_mode not in ('session', 'customer_tab') or v_entity_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The checkout entity is invalid.',
      jsonb_build_object('entity_type', v_entity_type, 'entity_id', v_entity_id, 'mode', v_mode)
    );
  end if;

  if v_bill_id is null or v_bill_number is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The checkout payload is missing bill details.',
      jsonb_build_object('bill_id', v_bill_id, 'bill_number', v_bill_number)
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
      'entity_type', v_entity_type,
      'entity_id', v_entity_id,
      'bill_id', coalesce(v_event_metadata->>'bill_id', v_bill_id),
      'bill_number', coalesce(v_event_metadata->>'bill_number', v_bill_number),
      'app_state_version', nullif(v_event_metadata->>'app_state_version', '')::integer,
      'event_id', v_event_id,
      'server_time', timezone('utc', now()),
      'idempotent', true,
      'changed_rows', coalesce(v_event_metadata->'changed_rows', '{}'::jsonb)
    );
  end if;

  perform pg_advisory_xact_lock(hashtext(v_organization_id || ':checkout:' || v_entity_type || ':' || v_entity_id));

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

  if exists (
    select 1
    from public.bills
    where bills.organization_id = v_organization_id
      and bills.bill_number = v_bill_number
      and bills.id <> v_bill_id
  ) then
    perform public.raise_operational_rpc_error(
      'duplicate_bill_number',
      'Another bill was issued with this bill number. Refresh and try again.',
      jsonb_build_object('bill_id', v_bill_id, 'bill_number', v_bill_number)
    );
  end if;

  if v_entity_type = 'session' then
    select sessions.status, sessions.closed_bill_id, sessions.close_disposition
    into v_session_status, v_session_closed_bill_id, v_session_close_disposition
    from public.sessions
    where sessions.organization_id = v_organization_id
      and sessions.id = v_entity_id
    for update;

    if v_session_status is null then
      perform public.raise_operational_rpc_error(
        'session_not_found',
        'This session no longer exists.',
        jsonb_build_object('session_id', v_entity_id)
      );
    end if;

    if v_session_closed_bill_id is not null and v_session_closed_bill_id <> v_bill_id then
      perform public.raise_operational_rpc_error(
        'session_already_billed',
        'This session was already billed from another browser.',
        jsonb_build_object('session_id', v_entity_id, 'closed_bill_id', v_session_closed_bill_id)
      );
    end if;

    if v_session_status = 'closed' and coalesce(v_session_close_disposition, '') <> 'hopped' and v_session_closed_bill_id is null then
      perform public.raise_operational_rpc_error(
        'session_already_closed',
        'This session was already closed from another browser.',
        jsonb_build_object('session_id', v_entity_id)
      );
    end if;
  else
    select customer_tabs.status, customer_tabs.closed_bill_id
    into v_tab_status, v_tab_closed_bill_id
    from public.customer_tabs
    where customer_tabs.organization_id = v_organization_id
      and customer_tabs.id = v_entity_id
    for update;

    if v_tab_status is null then
      perform public.raise_operational_rpc_error(
        'customer_tab_not_found',
        'This consumables tab no longer exists.',
        jsonb_build_object('customer_tab_id', v_entity_id)
      );
    end if;

    if v_tab_closed_bill_id is not null and v_tab_closed_bill_id <> v_bill_id then
      perform public.raise_operational_rpc_error(
        'customer_tab_already_billed',
        'This consumables tab was already billed from another browser.',
        jsonb_build_object('customer_tab_id', v_entity_id, 'closed_bill_id', v_tab_closed_bill_id)
      );
    end if;

    if v_tab_status = 'closed' and v_tab_closed_bill_id is null then
      perform public.raise_operational_rpc_error(
        'customer_tab_already_closed',
        'This consumables tab was already closed from another browser.',
        jsonb_build_object('customer_tab_id', v_entity_id)
      );
    end if;
  end if;

  if v_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_updated_by := v_user_id::uuid;
  end if;

  insert into public.customers (
    organization_id,
    id,
    name,
    phone,
    first_seen_at,
    last_visit_at,
    notes,
    raw_data
  )
  select
    v_organization_id,
    customer->>'id',
    coalesce(nullif(customer->>'name', ''), nullif(customer->>'phone', ''), 'Walk-in'),
    nullif(customer->>'phone', ''),
    nullif(customer->>'createdAt', '')::timestamptz,
    nullif(customer->>'lastVisitAt', '')::timestamptz,
    nullif(customer->>'notes', ''),
    customer
  from jsonb_array_elements(v_customers) as source(customer)
  where customer ? 'id'
  on conflict (organization_id, id) do update
  set
    name = excluded.name,
    phone = excluded.phone,
    first_seen_at = coalesce(customers.first_seen_at, excluded.first_seen_at),
    last_visit_at = excluded.last_visit_at,
    notes = excluded.notes,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

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
  select
    v_organization_id,
    session_row->>'id',
    nullif(session_row->>'stationId', ''),
    nullif(session_row->>'stationNameSnapshot', ''),
    coalesce(nullif(session_row->>'mode', ''), 'timed'),
    nullif(session_row->>'startedAt', '')::timestamptz,
    nullif(session_row->>'endedAt', '')::timestamptz,
    coalesce(nullif(session_row->>'status', ''), 'active'),
    nullif(session_row->>'customerId', ''),
    nullif(session_row->>'customerName', ''),
    nullif(session_row->>'customerPhone', ''),
    coalesce(nullif(session_row->>'playMode', ''), 'group'),
    coalesce(nullif(session_row->>'ltpEligible', '')::boolean, false),
    nullif(session_row->>'ltpOutcome', ''),
    nullif(session_row->>'ltpDiscountApplied', '')::boolean,
    coalesce(session_row->'pricingSnapshot', '[]'::jsonb),
    coalesce(session_row->'pauseLogIds', '[]'::jsonb),
    session_row->'continuedFromSessionIds',
    nullif(session_row->>'closedBillId', ''),
    nullif(session_row->>'closeDisposition', ''),
    nullif(session_row->>'closeReason', ''),
    session_row
  from jsonb_array_elements(v_sessions) as source(session_row)
  where session_row ? 'id'
  on conflict (organization_id, id) do update
  set
    station_id = excluded.station_id,
    station_name_snapshot = excluded.station_name_snapshot,
    mode = excluded.mode,
    started_at = excluded.started_at,
    ended_at = excluded.ended_at,
    status = excluded.status,
    customer_id = excluded.customer_id,
    customer_name = excluded.customer_name,
    customer_phone = excluded.customer_phone,
    play_mode = excluded.play_mode,
    ltp_eligible = excluded.ltp_eligible,
    ltp_outcome = excluded.ltp_outcome,
    ltp_discount_applied = excluded.ltp_discount_applied,
    pricing_snapshot = excluded.pricing_snapshot,
    pause_log_ids = excluded.pause_log_ids,
    continued_from_session_ids = excluded.continued_from_session_ids,
    closed_bill_id = excluded.closed_bill_id,
    close_disposition = excluded.close_disposition,
    close_reason = excluded.close_reason,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

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
  select
    v_organization_id,
    tab->>'id',
    nullif(tab->>'customerId', ''),
    coalesce(nullif(tab->>'customerName', ''), 'Walk-in'),
    nullif(tab->>'customerPhone', ''),
    coalesce(nullif(tab->>'status', ''), 'open'),
    nullif(tab->>'createdAt', '')::timestamptz,
    nullif(tab->>'closedAt', '')::timestamptz,
    tab->'continuedFromSessionIds',
    nullif(tab->>'closedBillId', ''),
    nullif(tab->>'closeDisposition', ''),
    nullif(tab->>'closeReason', ''),
    tab
  from jsonb_array_elements(v_customer_tabs) as source(tab)
  where tab ? 'id'
  on conflict (organization_id, id) do update
  set
    customer_id = excluded.customer_id,
    customer_name = excluded.customer_name,
    customer_phone = excluded.customer_phone,
    status = excluded.status,
    opened_at = excluded.opened_at,
    closed_at = excluded.closed_at,
    continued_from_session_ids = excluded.continued_from_session_ids,
    closed_bill_id = excluded.closed_bill_id,
    close_disposition = excluded.close_disposition,
    close_reason = excluded.close_reason,
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

  insert into public.bill_lines (
    organization_id,
    bill_id,
    id,
    type,
    description,
    quantity,
    unit_price,
    subtotal,
    discount_amount,
    total,
    linked_session_id,
    inventory_item_id,
    sold_as_pack_of,
    sale_variant_id,
    stock_units_per_sale,
    combo_application_id,
    combo_id,
    raw_data
  )
  select
    v_organization_id,
    bill->>'id',
    line->>'id',
    coalesce(nullif(line->>'type', ''), 'manual_charge'),
    coalesce(nullif(line->>'description', ''), 'Bill line'),
    coalesce(nullif(line->>'quantity', '')::numeric, 0),
    coalesce(nullif(line->>'unitPrice', '')::numeric, 0),
    coalesce(nullif(line->>'subtotal', '')::numeric, 0),
    coalesce(nullif(line->>'discountAmount', '')::numeric, 0),
    coalesce(nullif(line->>'total', '')::numeric, 0),
    nullif(line->>'linkedSessionId', ''),
    nullif(line->>'inventoryItemId', ''),
    nullif(line->>'soldAsPackOf', '')::numeric,
    nullif(line->>'saleVariantId', ''),
    nullif(line->>'stockUnitsPerSale', '')::numeric,
    nullif(line->>'comboApplicationId', ''),
    nullif(line->>'comboId', ''),
    line
  from jsonb_array_elements(v_bills) as source(bill)
  cross join lateral jsonb_array_elements(coalesce(bill->'lines', '[]'::jsonb)) as line_source(line)
  where bill ? 'id'
    and line ? 'id'
  on conflict (organization_id, bill_id, id) do update
  set
    type = excluded.type,
    description = excluded.description,
    quantity = excluded.quantity,
    unit_price = excluded.unit_price,
    subtotal = excluded.subtotal,
    discount_amount = excluded.discount_amount,
    total = excluded.total,
    linked_session_id = excluded.linked_session_id,
    inventory_item_id = excluded.inventory_item_id,
    sold_as_pack_of = excluded.sold_as_pack_of,
    sale_variant_id = excluded.sale_variant_id,
    stock_units_per_sale = excluded.stock_units_per_sale,
    combo_application_id = excluded.combo_application_id,
    combo_id = excluded.combo_id,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

  insert into public.bill_line_discounts (
    organization_id,
    bill_id,
    id,
    target_id,
    discount_type,
    value,
    amount,
    reason,
    applied_by_user_id,
    applied_at,
    raw_data
  )
  select
    v_organization_id,
    bill->>'id',
    discount->>'id',
    nullif(discount->>'targetId', ''),
    nullif(discount->>'type', ''),
    coalesce(nullif(discount->>'value', '')::numeric, 0),
    coalesce(nullif(discount->>'amount', '')::numeric, 0),
    nullif(discount->>'reason', ''),
    nullif(discount->>'appliedByUserId', ''),
    nullif(discount->>'appliedAt', '')::timestamptz,
    discount
  from jsonb_array_elements(v_bills) as source(bill)
  cross join lateral jsonb_array_elements(coalesce(bill->'lineDiscounts', '[]'::jsonb)) as discount_source(discount)
  where bill ? 'id'
    and discount ? 'id'
  on conflict (organization_id, bill_id, id) do update
  set
    target_id = excluded.target_id,
    discount_type = excluded.discount_type,
    value = excluded.value,
    amount = excluded.amount,
    reason = excluded.reason,
    applied_by_user_id = excluded.applied_by_user_id,
    applied_at = excluded.applied_at,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

  insert into public.bill_discounts (
    organization_id,
    bill_id,
    id,
    discount_type,
    value,
    amount,
    reason,
    applied_by_user_id,
    applied_at,
    raw_data
  )
  select
    v_organization_id,
    bill->>'id',
    bill->'billDiscount'->>'id',
    nullif(bill->'billDiscount'->>'type', ''),
    coalesce(nullif(bill->'billDiscount'->>'value', '')::numeric, 0),
    coalesce(nullif(bill->'billDiscount'->>'amount', '')::numeric, 0),
    nullif(bill->'billDiscount'->>'reason', ''),
    nullif(bill->'billDiscount'->>'appliedByUserId', ''),
    nullif(bill->'billDiscount'->>'appliedAt', '')::timestamptz,
    bill->'billDiscount'
  from jsonb_array_elements(v_bills) as source(bill)
  where bill ? 'id'
    and jsonb_typeof(bill->'billDiscount') = 'object'
    and bill->'billDiscount' ? 'id'
  on conflict (organization_id, bill_id, id) do update
  set
    discount_type = excluded.discount_type,
    value = excluded.value,
    amount = excluded.amount,
    reason = excluded.reason,
    applied_by_user_id = excluded.applied_by_user_id,
    applied_at = excluded.applied_at,
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
  v_next_app_state_data := jsonb_set(v_next_app_state_data, '{customers}', public.patch_app_state_array_by_id(v_next_app_state_data->'customers', v_customers), true);
  v_next_app_state_data := jsonb_set(v_next_app_state_data, '{inventoryItems}', public.patch_app_state_array_by_id(v_next_app_state_data->'inventoryItems', v_inventory_items), true);
  v_next_app_state_data := jsonb_set(v_next_app_state_data, '{sessions}', public.patch_app_state_array_by_id(v_next_app_state_data->'sessions', v_sessions), true);
  v_next_app_state_data := jsonb_set(v_next_app_state_data, '{customerTabs}', public.patch_app_state_array_by_id(v_next_app_state_data->'customerTabs', v_customer_tabs), true);
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
    'financial_checkout_committed',
    v_entity_type,
    v_entity_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'bill_id', v_bill_id,
      'bill_number', v_bill_number,
      'app_state_version', v_next_app_state_version,
      'changed_rows', jsonb_build_object(
        'bills', coalesce((select jsonb_agg(entry.value->>'id') from jsonb_array_elements(v_bills) as entry(value) where entry.value ? 'id'), '[]'::jsonb),
        'payments', coalesce((select jsonb_agg(entry.value->>'id') from jsonb_array_elements(v_payments) as entry(value) where entry.value ? 'id'), '[]'::jsonb),
        'stock_movements', coalesce((select jsonb_agg(entry.value->>'id') from jsonb_array_elements(v_stock_movements) as entry(value) where entry.value ? 'id'), '[]'::jsonb),
        'audit_logs', coalesce((select jsonb_agg(entry.value->>'id') from jsonb_array_elements(v_audit_logs) as entry(value) where entry.value ? 'id'), '[]'::jsonb),
        'sessions', coalesce((select jsonb_agg(entry.value->>'id') from jsonb_array_elements(v_sessions) as entry(value) where entry.value ? 'id'), '[]'::jsonb),
        'customer_tabs', coalesce((select jsonb_agg(entry.value->>'id') from jsonb_array_elements(v_customer_tabs) as entry(value) where entry.value ? 'id'), '[]'::jsonb),
        'customers', coalesce((select jsonb_agg(entry.value->>'id') from jsonb_array_elements(v_customers) as entry(value) where entry.value ? 'id'), '[]'::jsonb),
        'inventory_items', coalesce((select jsonb_agg(entry.value->>'id') from jsonb_array_elements(v_inventory_items) as entry(value) where entry.value ? 'id'), '[]'::jsonb)
      )
    )
  )
  returning id, metadata into v_event_id, v_event_metadata;

  return jsonb_build_object(
    'mutation_id', v_mutation_id,
    'organization_id', v_organization_id,
    'entity_type', v_entity_type,
    'entity_id', v_entity_id,
    'bill_id', v_bill_id,
    'bill_number', v_bill_number,
    'app_state_version', v_next_app_state_version,
    'event_id', v_event_id,
    'server_time', timezone('utc', now()),
    'changed_rows', v_event_metadata->'changed_rows'
  );
end;
$$;

revoke all on function public.commit_checkout_bill(jsonb) from public;
revoke execute on function public.commit_checkout_bill(jsonb) from anon;
grant execute on function public.commit_checkout_bill(jsonb) to authenticated;
