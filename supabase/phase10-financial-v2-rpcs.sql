-- Phase 10: normalized-only, idempotent financial mutations.
--
-- This migration is additive. The v1 RPCs remain installed for rollback.
-- Neither v2 RPC reads, locks, expands, patches, or updates public.app_state.

create table if not exists public.financial_mutations (
  organization_id text not null,
  mutation_id text not null,
  mutation_kind text not null,
  entity_type text not null,
  entity_id text not null,
  actor_user_id uuid not null,
  request_hash text not null,
  status text not null check (status in ('processing', 'committed')),
  canonical_result jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  committed_at timestamptz,
  primary key (organization_id, mutation_id)
);

create index if not exists financial_mutations_actor_created_idx
  on public.financial_mutations (actor_user_id, created_at desc);

alter table public.financial_mutations enable row level security;

drop policy if exists financial_mutations_select_org_members on public.financial_mutations;
create policy financial_mutations_select_org_members
  on public.financial_mutations
  for select
  to authenticated
  using (public.current_user_has_org_access(organization_id));

revoke all on table public.financial_mutations from public, anon, authenticated;

create or replace function public.assert_financial_v2_actor_free(payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_patch jsonb := coalesce(payload->'payload', '{}'::jsonb);
begin
  if payload ? 'user_id'
    or payload ? 'base_app_state_version'
    or jsonb_path_exists(v_patch, '$.**.issuedByUserId')
    or jsonb_path_exists(v_patch, '$.**.receivedByUserId')
    or jsonb_path_exists(v_patch, '$.**.appliedByUserId')
    or jsonb_path_exists(v_patch, '$.**.replacedByUserId')
    or jsonb_path_exists(v_patch, '$.**.voidedByUserId')
    or jsonb_path_exists(v_patch, '$.**.settledByUserId')
    or jsonb_path_exists(v_patch, '$.**.userId')
  then
    perform public.raise_operational_rpc_error(
      'actor_spoof_rejected',
      'Financial actor fields are server-controlled.',
      '{}'::jsonb
    );
  end if;
end;
$$;

revoke all on function public.assert_financial_v2_actor_free(jsonb) from public, anon, authenticated;

create or replace function public.get_financial_mutation_result(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id text := nullif(payload->>'organization_id', '');
  v_mutation_id text := nullif(payload->>'mutation_id', '');
  v_mutation_kind text := nullif(payload->>'mutation_kind', '');
  v_result jsonb;
begin
  if auth.uid() is null
    or v_organization_id is null
    or v_mutation_id is null
    or not public.current_user_has_org_access(v_organization_id)
  then
    perform public.raise_operational_rpc_error(
      'organization_access_denied',
      'You do not have access to this financial mutation.',
      jsonb_build_object('organization_id', v_organization_id)
    );
  end if;

  select canonical_result
  into v_result
  from public.financial_mutations
  where organization_id = v_organization_id
    and mutation_id = v_mutation_id
    and actor_user_id = auth.uid()
    and status = 'committed'
    and (v_mutation_kind is null or mutation_kind = v_mutation_kind);

  return v_result;
end;
$$;

revoke all on function public.get_financial_mutation_result(jsonb) from public, anon;
grant execute on function public.get_financial_mutation_result(jsonb) to authenticated;

create or replace function public.apply_financial_v2_rows(
  p_organization_id text,
  p_actor_user_id uuid,
  p_transaction_at timestamptz,
  p_mutation_kind text,
  p_new_bill_id text,
  p_bills jsonb,
  p_payments jsonb,
  p_stock_movements jsonb,
  p_audit_logs jsonb,
  p_sessions jsonb,
  p_customer_tabs jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Existing bills may change only financial lifecycle fields. All immutable
  -- price, customer, issue, and line data remains server-side.
  update public.bills as target
  set
    status = coalesce(nullif(source.bill->>'status', ''), target.status),
    amount_paid = coalesce(nullif(source.bill->>'amountPaid', '')::numeric, target.amount_paid),
    amount_due = coalesce(nullif(source.bill->>'amountDue', '')::numeric, target.amount_due),
    replaced_by_bill_id = case when p_mutation_kind = 'commitCheckoutBill' and target.status = 'issued' and source.bill->>'status' = 'replaced' then nullif(source.bill->>'replacedByBillId', '') else target.replaced_by_bill_id end,
    replaced_at = case when p_mutation_kind = 'commitCheckoutBill' and target.status = 'issued' and source.bill->>'status' = 'replaced' then p_transaction_at else target.replaced_at end,
    replaced_by_user_id = case when p_mutation_kind = 'commitCheckoutBill' and target.status = 'issued' and source.bill->>'status' = 'replaced' then p_actor_user_id::text else target.replaced_by_user_id end,
    replace_reason = case when p_mutation_kind = 'commitCheckoutBill' and target.status = 'issued' and source.bill->>'status' = 'replaced' then nullif(source.bill->>'replaceReason', '') else target.replace_reason end,
    voided_at = case when p_mutation_kind in ('writeOffPendingBills', 'voidBill', 'refundBill') then p_transaction_at else target.voided_at end,
    voided_by_user_id = case when p_mutation_kind in ('writeOffPendingBills', 'voidBill', 'refundBill') then p_actor_user_id::text else target.voided_by_user_id end,
    void_reason = case when p_mutation_kind in ('writeOffPendingBills', 'voidBill', 'refundBill') then nullif(source.bill->>'voidReason', '') else target.void_reason end,
    settled_at = case when p_mutation_kind in ('commitCheckoutBill', 'settlePendingBills') and target.status = 'pending' and source.bill->>'status' = 'issued' then p_transaction_at else target.settled_at end,
    settled_by_user_id = case when p_mutation_kind in ('commitCheckoutBill', 'settlePendingBills') and target.status = 'pending' and source.bill->>'status' = 'issued' then p_actor_user_id::text else target.settled_by_user_id end,
    raw_data = coalesce(target.raw_data, '{}'::jsonb) || jsonb_strip_nulls(
      jsonb_build_object(
        'status', coalesce(nullif(source.bill->>'status', ''), target.status),
        'amountPaid', coalesce(nullif(source.bill->>'amountPaid', '')::numeric, target.amount_paid),
        'amountDue', coalesce(nullif(source.bill->>'amountDue', '')::numeric, target.amount_due),
        'replacedByBillId', case when p_mutation_kind = 'commitCheckoutBill' and target.status = 'issued' and source.bill->>'status' = 'replaced' then nullif(source.bill->>'replacedByBillId', '') else target.replaced_by_bill_id end,
        'replacedAt', case when p_mutation_kind = 'commitCheckoutBill' and target.status = 'issued' and source.bill->>'status' = 'replaced' then p_transaction_at::text else target.replaced_at::text end,
        'replacedByUserId', case when p_mutation_kind = 'commitCheckoutBill' and target.status = 'issued' and source.bill->>'status' = 'replaced' then p_actor_user_id::text else target.replaced_by_user_id end,
        'replaceReason', case when p_mutation_kind = 'commitCheckoutBill' and target.status = 'issued' and source.bill->>'status' = 'replaced' then nullif(source.bill->>'replaceReason', '') else target.replace_reason end,
        'voidedAt', case when p_mutation_kind in ('writeOffPendingBills', 'voidBill', 'refundBill') then p_transaction_at::text else target.voided_at::text end,
        'voidedByUserId', case when p_mutation_kind in ('writeOffPendingBills', 'voidBill', 'refundBill') then p_actor_user_id::text else target.voided_by_user_id end,
        'voidReason', case when p_mutation_kind in ('writeOffPendingBills', 'voidBill', 'refundBill') then nullif(source.bill->>'voidReason', '') else target.void_reason end,
        'settledAt', case when p_mutation_kind in ('commitCheckoutBill', 'settlePendingBills') and target.status = 'pending' and source.bill->>'status' = 'issued' then p_transaction_at::text else target.settled_at::text end,
        'settledByUserId', case when p_mutation_kind in ('commitCheckoutBill', 'settlePendingBills') and target.status = 'pending' and source.bill->>'status' = 'issued' then p_actor_user_id::text else target.settled_by_user_id end
      )
    ),
    updated_at = timezone('utc', now())
  from jsonb_array_elements(p_bills) as source(bill)
  where target.organization_id = p_organization_id
    and target.id = source.bill->>'id'
    and (p_new_bill_id is null or target.id <> p_new_bill_id);

  if p_new_bill_id is not null then
    insert into public.bills (
      organization_id, id, bill_number, status, created_at_source, issued_at,
      issued_by_user_id, customer_id, customer_name, customer_phone,
      payment_mode, station_id, session_id, amount_paid, amount_due, subtotal,
      total_discount_amount, bill_discount_amount, round_off_enabled,
      round_off_amount, total, receipt_type, replacement_of_bill_id,
      replace_reason, raw_data
    )
    select
      p_organization_id,
      bill->>'id',
      bill->>'billNumber',
      coalesce(nullif(bill->>'status', ''), 'issued'),
      p_transaction_at,
      p_transaction_at,
      p_actor_user_id::text,
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
      coalesce(nullif(bill->>'receiptType', ''), 'digital'),
      nullif(bill->>'replacementOfBillId', ''),
      nullif(bill->>'replaceReason', ''),
      (
        bill
        - 'replacedByBillId' - 'replacedAt' - 'replacedByUserId'
        - 'voidedAt' - 'voidedByUserId' - 'voidReason'
        - 'settledAt' - 'settledByUserId'
      ) || jsonb_build_object(
        'createdAt', p_transaction_at, 'issuedAt', p_transaction_at,
        'issuedByUserId', p_actor_user_id::text
      )
    from jsonb_array_elements(p_bills) as source(bill)
    where bill->>'id' = p_new_bill_id;

    insert into public.bill_lines (
      organization_id, bill_id, id, type, description, quantity, unit_price,
      subtotal, discount_amount, total, linked_session_id, inventory_item_id,
      sold_as_pack_of, sale_variant_id, stock_units_per_sale,
      combo_application_id, combo_id, raw_data
    )
    select
      p_organization_id, bill->>'id', line->>'id',
      coalesce(nullif(line->>'type', ''), 'manual_charge'),
      coalesce(nullif(line->>'description', ''), 'Bill line'),
      coalesce(nullif(line->>'quantity', '')::numeric, 0),
      coalesce(nullif(line->>'unitPrice', '')::numeric, 0),
      coalesce(nullif(line->>'subtotal', '')::numeric, 0),
      coalesce(nullif(line->>'discountAmount', '')::numeric, 0),
      coalesce(nullif(line->>'total', '')::numeric, 0),
      nullif(line->>'linkedSessionId', ''), nullif(line->>'inventoryItemId', ''),
      nullif(line->>'soldAsPackOf', '')::numeric, nullif(line->>'saleVariantId', ''),
      nullif(line->>'stockUnitsPerSale', '')::numeric,
      nullif(line->>'comboApplicationId', ''), nullif(line->>'comboId', ''), line
    from jsonb_array_elements(p_bills) as source(bill)
    cross join lateral jsonb_array_elements(coalesce(bill->'lines', '[]'::jsonb)) as line_source(line)
    where bill->>'id' = p_new_bill_id and line ? 'id';

    insert into public.bill_line_discounts (
      organization_id, bill_id, id, target_id, discount_type, value, amount,
      reason, applied_by_user_id, applied_at, raw_data
    )
    select
      p_organization_id, bill->>'id', discount->>'id',
      nullif(discount->>'targetId', ''), nullif(discount->>'type', ''),
      coalesce(nullif(discount->>'value', '')::numeric, 0),
      coalesce(nullif(discount->>'amount', '')::numeric, 0),
      nullif(discount->>'reason', ''), p_actor_user_id::text,
      p_transaction_at,
      discount || jsonb_build_object('appliedAt', p_transaction_at, 'appliedByUserId', p_actor_user_id::text)
    from jsonb_array_elements(p_bills) as source(bill)
    cross join lateral jsonb_array_elements(coalesce(bill->'lineDiscounts', '[]'::jsonb)) as discount_source(discount)
    where bill->>'id' = p_new_bill_id and discount ? 'id';

    insert into public.bill_discounts (
      organization_id, bill_id, id, discount_type, value, amount, reason,
      applied_by_user_id, applied_at, raw_data
    )
    select
      p_organization_id, bill->>'id', bill->'billDiscount'->>'id',
      nullif(bill->'billDiscount'->>'type', ''),
      coalesce(nullif(bill->'billDiscount'->>'value', '')::numeric, 0),
      coalesce(nullif(bill->'billDiscount'->>'amount', '')::numeric, 0),
      nullif(bill->'billDiscount'->>'reason', ''), p_actor_user_id::text,
      p_transaction_at,
      bill->'billDiscount' || jsonb_build_object('appliedAt', p_transaction_at, 'appliedByUserId', p_actor_user_id::text)
    from jsonb_array_elements(p_bills) as source(bill)
    where bill->>'id' = p_new_bill_id
      and jsonb_typeof(bill->'billDiscount') = 'object'
      and bill->'billDiscount' ? 'id';
  end if;

  insert into public.payments (
    organization_id, id, bill_id, mode, amount, paid_at,
    received_by_user_id, settlement_group_id, related_checkout_bill_id, raw_data
  )
  select
    p_organization_id, payment->>'id', nullif(payment->>'billId', ''),
    coalesce(nullif(payment->>'mode', ''), 'cash'),
    coalesce(nullif(payment->>'amount', '')::numeric, 0),
    p_transaction_at, p_actor_user_id::text,
    nullif(payment->>'settlementGroupId', ''),
    nullif(payment->>'relatedCheckoutBillId', ''),
    payment || jsonb_build_object('createdAt', p_transaction_at, 'receivedByUserId', p_actor_user_id::text)
  from jsonb_array_elements(p_payments) as source(payment)
  where payment ? 'id';

  insert into public.stock_movements (
    organization_id, id, item_id, type, quantity, reason, movement_at,
    user_id, related_bill_id, raw_data
  )
  select
    p_organization_id, movement->>'id', nullif(movement->>'itemId', ''),
    coalesce(nullif(movement->>'type', ''), 'adjustment'),
    coalesce(nullif(movement->>'quantity', '')::numeric, 0),
    nullif(movement->>'reason', ''), p_transaction_at,
    p_actor_user_id::text, nullif(movement->>'relatedBillId', ''),
    movement || jsonb_build_object('createdAt', p_transaction_at, 'userId', p_actor_user_id::text)
  from jsonb_array_elements(p_stock_movements) as source(movement)
  where movement ? 'id';

  insert into public.audit_logs (
    organization_id, id, action, entity_type, entity_id, message, audit_at,
    user_id, raw_data
  )
  select
    p_organization_id, audit->>'id', coalesce(nullif(audit->>'action', ''), 'unknown'),
    nullif(audit->>'entityType', ''), nullif(audit->>'entityId', ''),
    canonical.message, p_transaction_at,
    p_actor_user_id::text, audit || jsonb_build_object(
      'message', canonical.message, 'createdAt', p_transaction_at, 'userId', p_actor_user_id::text
    )
  from jsonb_array_elements(p_audit_logs) as source(audit)
  cross join lateral (
    select case audit->>'action'
      when 'bill_issued' then 'Issued ' || coalesce((select bill_number from public.bills where organization_id = p_organization_id and id = audit->>'entityId'), audit->>'entityId') || '.'
      when 'bill_pending' then coalesce((select bill_number from public.bills where organization_id = p_organization_id and id = audit->>'entityId'), audit->>'entityId')
        || ' issued as pending (due Rs ' || coalesce((select to_char(amount_due, 'FM999999999999990.00') from public.bills where organization_id = p_organization_id and id = audit->>'entityId'), '0.00') || ').'
      when 'bill_replaced' then 'Issued replacement '
        || coalesce((select bill_number from public.bills where organization_id = p_organization_id and id = audit->>'entityId'), audit->>'entityId')
        || ' for ' || coalesce((
          select original.bill_number
          from public.bills as replacement
          join public.bills as original
            on original.organization_id = replacement.organization_id and original.id = replacement.replacement_of_bill_id
          where replacement.organization_id = p_organization_id and replacement.id = audit->>'entityId'
        ), 'the original bill')
        || '. Reason: ' || coalesce((
          select replace_reason from public.bills
          where organization_id = p_organization_id and id = audit->>'entityId'
        ), 'Not provided') || '.'
      when 'bill_settled' then 'Settled Rs '
        || coalesce((
          select to_char(sum((payment->>'amount')::numeric), 'FM999999999999990.00')
          from jsonb_array_elements(p_payments) as payment_source(payment)
          where payment->>'billId' = audit->>'entityId'
        ), '0.00')
        || ' on ' || coalesce((select bill_number from public.bills where organization_id = p_organization_id and id = audit->>'entityId'), audit->>'entityId')
        || case when p_new_bill_id is not null then ' during checkout ' || coalesce((select bill_number from public.bills where organization_id = p_organization_id and id = p_new_bill_id), p_new_bill_id) else '' end
        || '. Remaining due: Rs ' || coalesce((select to_char(amount_due, 'FM999999999999990.00') from public.bills where organization_id = p_organization_id and id = audit->>'entityId'), '0.00') || '.'
      when 'bill_voided_bad_debt' then 'Voided pending bill ' || coalesce((select bill_number from public.bills where organization_id = p_organization_id and id = audit->>'entityId'), audit->>'entityId')
        || ' as bad debt. Reason: ' || coalesce((select void_reason from public.bills where organization_id = p_organization_id and id = audit->>'entityId'), 'Not provided') || '.'
      when 'bill_voided' then 'Voided ' || coalesce((select bill_number from public.bills where organization_id = p_organization_id and id = audit->>'entityId'), audit->>'entityId')
        || '. Reason: ' || coalesce((select void_reason from public.bills where organization_id = p_organization_id and id = audit->>'entityId'), 'Not provided') || '.'
      when 'bill_refunded' then 'Refunded ' || coalesce((select bill_number from public.bills where organization_id = p_organization_id and id = audit->>'entityId'), audit->>'entityId')
        || '. Reason: ' || coalesce((select void_reason from public.bills where organization_id = p_organization_id and id = audit->>'entityId'), 'Not provided') || '.'
      when 'session_hop_billed' then 'Included carried session from '
        || coalesce((select station_name_snapshot from public.sessions where organization_id = p_organization_id and id = audit->>'entityId'), 'station')
        || ' in bill ' || coalesce((select bill_number from public.bills where organization_id = p_organization_id and id = p_new_bill_id), p_new_bill_id) || '.'
      when 'session_checkout_details_updated' then 'Updated during checkout: ' || coalesce((
        select concat_ws('; ',
          case when (update_row.value->>'startedAt')::timestamptz is distinct from current_session.started_at
            then 'start time: ' || coalesce(current_session.started_at::text, 'not set') || ' -> ' || coalesce(update_row.value->>'startedAt', 'not set') end,
          case when nullif(update_row.value->>'customerName', '') is distinct from current_session.customer_name
            then 'customer name: ' || coalesce(current_session.customer_name, 'not set') || ' -> ' || coalesce(nullif(update_row.value->>'customerName', ''), 'not set') end,
          case when nullif(update_row.value->>'customerPhone', '') is distinct from current_session.customer_phone
            then 'customer phone: ' || coalesce(current_session.customer_phone, 'not set') || ' -> ' || coalesce(nullif(update_row.value->>'customerPhone', ''), 'not set') end
        )
        from public.sessions as current_session
        join jsonb_array_elements(p_sessions) as update_row(value) on update_row.value->>'id' = current_session.id
        where current_session.organization_id = p_organization_id and current_session.id = audit->>'entityId'
      ), 'session details updated') || '.'
      when 'customer_tab_checkout_details_updated' then 'Updated during checkout: ' || coalesce((
        select concat_ws('; ',
          case when nullif(update_row.value->>'customerName', '') is distinct from current_tab.customer_name
            then 'customer name: ' || coalesce(current_tab.customer_name, 'not set') || ' -> ' || coalesce(nullif(update_row.value->>'customerName', ''), 'not set') end,
          case when nullif(update_row.value->>'customerPhone', '') is distinct from current_tab.customer_phone
            then 'customer phone: ' || coalesce(current_tab.customer_phone, 'not set') || ' -> ' || coalesce(nullif(update_row.value->>'customerPhone', ''), 'not set') end
        )
        from public.customer_tabs as current_tab
        join jsonb_array_elements(p_customer_tabs) as update_row(value) on update_row.value->>'id' = current_tab.id
        where current_tab.organization_id = p_organization_id and current_tab.id = audit->>'entityId'
      ), 'customer-tab details updated') || '.'
      when 'ltp_discount_applied' then 'Applied the verified LTP win discount to '
        || coalesce((select station_name_snapshot from public.sessions where organization_id = p_organization_id and id = audit->>'entityId'), 'station') || '.'
      else coalesce(nullif(audit->>'message', ''), 'Recorded financial action.')
    end as message
  ) as canonical
  where audit ? 'id';
end;
$$;

revoke all on function public.apply_financial_v2_rows(text, uuid, timestamptz, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;

create or replace function public.format_financial_minutes_v2(p_minutes numeric)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  with safe as (
    select greatest(coalesce(p_minutes, 0), 0) as minutes
  ), parts as (
    select floor(minutes / 60)::integer as hours,
      round(mod(minutes, 60))::integer as remaining_minutes
    from safe
  )
  select case
    when hours = 0 then remaining_minutes::text || ' min'
    when remaining_minutes = 0 then hours::text || ' hr'
    else hours::text || ' hr ' || remaining_minutes::text || ' min'
  end
  from parts;
$$;

revoke all on function public.format_financial_minutes_v2(numeric)
  from public, anon, authenticated;

create or replace function public.calculate_financial_session_charge_v2(
  p_organization_id text,
  p_session_id text,
  p_started_at timestamptz,
  p_ended_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.sessions%rowtype;
  v_local_minute integer;
  v_elapsed_minutes numeric := 0;
  v_pause_minutes numeric := 0;
  v_billed_minutes numeric := 0;
  v_included_minutes numeric := 0;
  v_extra_minutes numeric := 0;
  v_hourly_rate numeric := 0;
  v_combo_count integer := 0;
begin
  select * into v_session
  from public.sessions
  where organization_id = p_organization_id and id = p_session_id;

  if not found or p_started_at is null or p_ended_at is null or p_started_at > p_ended_at then
    return jsonb_build_object('valid', false);
  end if;

  v_elapsed_minutes := extract(epoch from (p_ended_at - p_started_at)) / 60;
  select coalesce(sum(greatest(
    extract(epoch from (
      least(coalesce(resumed_at, p_ended_at), p_ended_at)
      - greatest(paused_at, p_started_at)
    )) / 60,
    0
  )), 0)
  into v_pause_minutes
  from public.session_pause_logs
  where organization_id = p_organization_id
    and session_id = p_session_id
    and paused_at < p_ended_at
    and coalesce(resumed_at, p_ended_at) > p_started_at;

  v_billed_minutes := greatest(v_elapsed_minutes - v_pause_minutes, 0);
  v_local_minute := extract(hour from (p_started_at at time zone 'Asia/Kolkata'))::integer * 60
    + extract(minute from (p_started_at at time zone 'Asia/Kolkata'))::integer;

  select coalesce((rule->>'hourlyRate')::numeric, 0)
  into v_hourly_rate
  from jsonb_array_elements(coalesce(v_session.pricing_snapshot, '[]'::jsonb)) with ordinality as source(rule, ordinal)
  where coalesce((rule->>'startMinute')::integer, 0) = coalesce((rule->>'endMinute')::integer, 0)
    or (
      coalesce((rule->>'startMinute')::integer, 0) < coalesce((rule->>'endMinute')::integer, 0)
      and v_local_minute >= coalesce((rule->>'startMinute')::integer, 0)
      and v_local_minute < coalesce((rule->>'endMinute')::integer, 0)
    )
    or (
      coalesce((rule->>'startMinute')::integer, 0) > coalesce((rule->>'endMinute')::integer, 0)
      and (v_local_minute >= coalesce((rule->>'startMinute')::integer, 0)
        or v_local_minute < coalesce((rule->>'endMinute')::integer, 0))
    )
  order by ordinal
  limit 1;
  v_hourly_rate := coalesce(v_hourly_rate, 0);

  select coalesce(sum(included_minutes), 0), count(*)
  into v_included_minutes, v_combo_count
  from public.session_combo_applications
  where organization_id = p_organization_id and session_id = p_session_id;

  v_extra_minutes := greatest(v_billed_minutes - v_included_minutes, 0);
  return jsonb_build_object(
    'valid', true,
    'billed_minutes', v_billed_minutes,
    'included_minutes', v_included_minutes,
    'extra_minutes', v_extra_minutes,
    'combo_count', v_combo_count,
    'hourly_rate', v_hourly_rate,
    'charge', (v_extra_minutes / 60) * v_hourly_rate
  );
end;
$$;

revoke all on function public.calculate_financial_session_charge_v2(text, text, timestamptz, timestamptz)
  from public, anon, authenticated;

create or replace function public.commit_checkout_bill_v2(payload jsonb)
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
  v_client_created_at timestamptz := coalesce(nullif(payload->>'client_created_at', '')::timestamptz, timezone('utc', now()));
  v_actor_user_id uuid := auth.uid();
  v_patch jsonb := coalesce(payload->'payload', '{}'::jsonb);
  v_mode text := nullif(v_patch->>'mode', '');
  v_bill jsonb := coalesce(v_patch->'primary_bill', '{}'::jsonb);
  v_bill_id text := nullif(v_bill->>'id', '');
  v_bill_number text := nullif(v_bill->>'billNumber', '');
  v_bills jsonb := case when jsonb_typeof(v_patch->'bill_updates') = 'array' then v_patch->'bill_updates' else '[]'::jsonb end;
  v_payments jsonb := case when jsonb_typeof(v_patch->'payments') = 'array' then v_patch->'payments' else '[]'::jsonb end;
  v_stock_movements jsonb := case when jsonb_typeof(v_patch->'stock_movements') = 'array' then v_patch->'stock_movements' else '[]'::jsonb end;
  v_audit_logs jsonb := case when jsonb_typeof(v_patch->'audit_logs') = 'array' then v_patch->'audit_logs' else '[]'::jsonb end;
  v_customers jsonb := case when jsonb_typeof(v_patch->'customers') = 'array' then v_patch->'customers' else '[]'::jsonb end;
  v_sessions jsonb := case when jsonb_typeof(v_patch->'session_updates') = 'array' then v_patch->'session_updates' else '[]'::jsonb end;
  v_customer_tabs jsonb := case when jsonb_typeof(v_patch->'customer_tab_updates') = 'array' then v_patch->'customer_tab_updates' else '[]'::jsonb end;
  v_source_session_ids text[] := coalesce(array(select distinct jsonb_array_elements_text(coalesce(v_patch->'source_session_ids', '[]'::jsonb)) order by 1), array[]::text[]);
  v_source_tab_ids text[] := coalesce(array(select distinct jsonb_array_elements_text(coalesce(v_patch->'source_customer_tab_ids', '[]'::jsonb)) order by 1), array[]::text[]);
  v_settlement_expectations jsonb := case when jsonb_typeof(v_patch->'settlement_expectations') = 'array' then v_patch->'settlement_expectations' else '[]'::jsonb end;
  v_inventory_expectations jsonb := case when jsonb_typeof(v_patch->'inventory_expectations') = 'array' then v_patch->'inventory_expectations' else '[]'::jsonb end;
  v_inventory_deltas jsonb := '[]'::jsonb;
  v_request_hash text := md5(payload::text);
  v_existing_mutation public.financial_mutations%rowtype;
  v_lock_id text;
  v_event_id text;
  v_server_duration_ms numeric;
  v_changed_rows jsonb;
  v_result jsonb;
begin
  if v_actor_user_id is null
    or v_organization_id is null
    or not public.current_user_has_org_access(v_organization_id)
  then
    perform public.raise_operational_rpc_error(
      'organization_access_denied',
      'You do not have access to this organization.',
      jsonb_build_object('organization_id', v_organization_id)
    );
  end if;

  perform public.assert_financial_v2_actor_free(payload);

  if v_mutation_id is null or v_mutation_kind <> 'commitCheckoutBill'
    or v_bill_id is null or v_bill_number is null or v_entity_id is null
    or not (
      (v_entity_type = 'session' and v_mode = 'session')
      or (v_entity_type = 'customer_tab' and v_mode = 'customer_tab')
      or (v_entity_type = 'bill' and v_mode = 'bill_replacement')
    )
  then
    perform public.raise_operational_rpc_error('invalid_payload', 'The v2 checkout payload is incomplete.', '{}'::jsonb);
  end if;

  insert into public.financial_mutations (
    organization_id, mutation_id, mutation_kind, entity_type, entity_id,
    actor_user_id, request_hash, status
  ) values (
    v_organization_id, v_mutation_id, v_mutation_kind, v_entity_type, v_entity_id,
    v_actor_user_id, v_request_hash, 'processing'
  ) on conflict (organization_id, mutation_id) do nothing;

  select * into v_existing_mutation
  from public.financial_mutations
  where organization_id = v_organization_id and mutation_id = v_mutation_id
  for update;

  if v_existing_mutation.actor_user_id = v_actor_user_id
    and v_existing_mutation.mutation_kind = v_mutation_kind
    and v_existing_mutation.entity_type = v_entity_type
    and v_existing_mutation.entity_id = v_entity_id
    and v_existing_mutation.status = 'committed'
  then
    return v_existing_mutation.canonical_result;
  end if;

  if v_existing_mutation.actor_user_id <> v_actor_user_id
    or v_existing_mutation.mutation_kind <> v_mutation_kind
    or v_existing_mutation.entity_type <> v_entity_type
    or v_existing_mutation.entity_id <> v_entity_id
    or v_existing_mutation.request_hash <> v_request_hash
  then
    perform public.raise_operational_rpc_error(
      'mutation_payload_mismatch',
      'This mutation ID is already associated with a different checkout.',
      jsonb_build_object('mutation_id', v_mutation_id)
    );
  end if;

  if (select count(*) from jsonb_array_elements(v_bills) as row(value) where row.value->>'id' = v_bill_id and row.value = v_bill) <> 1
    or exists (select 1 from jsonb_array_elements(v_bills) as row(value) where row.value->>'id' = v_bill_id and row.value <> v_bill)
  then
    perform public.raise_operational_rpc_error('invalid_payload', 'The primary bill must appear exactly once.', '{}'::jsonb);
  end if;

  if v_mode = 'bill_replacement' and public.current_user_org_role(v_organization_id) <> 'admin'::public.app_role then
    perform public.raise_operational_rpc_error('role_access_denied', 'Only an administrator can replace an issued bill.', '{}'::jsonb);
  end if;

  if exists (
    select 1 from public.bills
    where organization_id = v_organization_id
      and (id = v_bill_id or bill_number = v_bill_number)
  ) then
    perform public.raise_operational_rpc_error(
      'duplicate_bill_number',
      'The bill ID or number already exists.',
      jsonb_build_object('bill_id', v_bill_id, 'bill_number', v_bill_number)
    );
  end if;

  -- Lock source sessions, tabs, existing bills, and inventory in one stable order.
  foreach v_lock_id in array v_source_session_ids loop
    perform 1 from public.sessions
    where organization_id = v_organization_id and id = v_lock_id
    for update;
    if not found then
      perform public.raise_operational_rpc_error('session_not_found', 'A source session no longer exists.', jsonb_build_object('session_id', v_lock_id));
    end if;
  end loop;

  foreach v_lock_id in array v_source_tab_ids loop
    perform 1 from public.customer_tabs
    where organization_id = v_organization_id and id = v_lock_id
    for update;
    if not found then
      perform public.raise_operational_rpc_error('customer_tab_not_found', 'A source tab no longer exists.', jsonb_build_object('customer_tab_id', v_lock_id));
    end if;
  end loop;

  for v_lock_id in
    select distinct id from (
      select value->>'id' as id from jsonb_array_elements(v_bills)
      union all
      select value->>'billId' as id from jsonb_array_elements(v_settlement_expectations)
      union all
      select case when v_mode = 'bill_replacement' then v_entity_id end
    ) as requested where id is not null and id <> v_bill_id order by id
  loop
    perform 1 from public.bills
    where organization_id = v_organization_id and id = v_lock_id
    for update;
    if not found then
      perform public.raise_operational_rpc_error('bill_not_found', 'A referenced bill no longer exists.', jsonb_build_object('bill_id', v_lock_id));
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('itemId', item_id, 'delta', delta) order by item_id), '[]'::jsonb)
  into v_inventory_deltas
  from (
    select item_id, sum(delta) as delta
    from (
      select session_items.inventory_item_id as item_id,
        -sum(session_items.quantity * coalesce(session_items.stock_units_per_sale, session_items.sold_as_pack_of, 1)) as delta
      from public.session_items
      join public.inventory_items on inventory_items.organization_id = session_items.organization_id and inventory_items.id = session_items.inventory_item_id
      where v_mode <> 'bill_replacement'
        and session_items.organization_id = v_organization_id
        and session_items.session_id = any(v_source_session_ids)
        and session_items.inventory_item_id is not null
        and not inventory_items.is_reusable
      group by session_items.inventory_item_id
      union all
      select customer_tab_items.inventory_item_id as item_id,
        -sum(customer_tab_items.quantity * coalesce(customer_tab_items.stock_units_per_sale, customer_tab_items.sold_as_pack_of, 1)) as delta
      from public.customer_tab_items
      join public.inventory_items on inventory_items.organization_id = customer_tab_items.organization_id and inventory_items.id = customer_tab_items.inventory_item_id
      where v_mode <> 'bill_replacement'
        and customer_tab_items.organization_id = v_organization_id
        and customer_tab_items.customer_tab_id = any(v_source_tab_ids)
        and customer_tab_items.inventory_item_id is not null
        and not inventory_items.is_reusable
      group by customer_tab_items.inventory_item_id
      union all
      select item_id, sum(quantity) as delta
      from (
        select lines.inventory_item_id as item_id,
          lines.quantity * coalesce(lines.stock_units_per_sale, lines.sold_as_pack_of, 1) as quantity
        from public.bill_lines as lines
        join public.inventory_items on inventory_items.organization_id = lines.organization_id and inventory_items.id = lines.inventory_item_id
        where v_mode = 'bill_replacement' and lines.organization_id = v_organization_id
          and lines.bill_id = v_entity_id and lines.inventory_item_id is not null and not inventory_items.is_reusable
        union all
        select line->>'inventoryItemId' as item_id,
          -(coalesce((line->>'quantity')::numeric, 0) * coalesce(
            original_line.stock_units_per_sale,
            original_line.sold_as_pack_of,
            variant.stock_units_per_sale,
            1
          )) as quantity
        from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as replacement(line)
        join public.inventory_items on inventory_items.organization_id = v_organization_id and inventory_items.id = line->>'inventoryItemId'
        left join public.bill_lines as original_line
          on original_line.organization_id = v_organization_id
          and original_line.bill_id = v_entity_id
          and original_line.id = line->>'id'
        left join public.sale_variants as variant
          on original_line.id is null
          and variant.organization_id = v_organization_id
          and variant.inventory_item_id = line->>'inventoryItemId'
          and variant.id = line->>'saleVariantId'
        where v_mode = 'bill_replacement' and nullif(line->>'inventoryItemId', '') is not null and not inventory_items.is_reusable
      ) as replacement_delta
      group by item_id
    ) as all_deltas
    group by item_id
    having abs(sum(delta)) > 0.0001
  ) as effective_deltas;

  for v_lock_id in
    select distinct value->>'itemId' from jsonb_array_elements(v_inventory_deltas)
    where nullif(value->>'itemId', '') is not null order by 1
  loop
    perform 1 from public.inventory_items
    where organization_id = v_organization_id and id = v_lock_id
    for update;
    if not found then
      perform public.raise_operational_rpc_error('inventory_item_not_found', 'An inventory item no longer exists.', jsonb_build_object('item_id', v_lock_id));
    end if;
  end loop;

  if exists (
    select 1 from jsonb_array_elements(v_bills) as source(value)
    where source.value->>'id' <> v_bill_id
      and not (v_mode = 'bill_replacement' and source.value->>'id' = v_entity_id)
      and not exists (
        select 1 from jsonb_array_elements(v_settlement_expectations) as expected(value)
        where expected.value->>'billId' = source.value->>'id'
      )
  ) or exists (
    select 1 from jsonb_array_elements(v_payments) as source(value)
    where source.value->>'billId' <> v_bill_id
      and not exists (
        select 1 from jsonb_array_elements(v_settlement_expectations) as expected(value)
        where expected.value->>'billId' = source.value->>'billId'
      )
  ) then
    perform public.raise_operational_rpc_error('out_of_scope_financial_rows', 'The checkout contains unrelated bill or payment updates.', '{}'::jsonb);
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_settlement_expectations) as expected(value)
    group by expected.value->>'billId'
    having count(*) <> 1
  ) or exists (
    select 1 from jsonb_array_elements(v_settlement_expectations) as expected(value)
    where (select count(*) from jsonb_array_elements(v_bills) as bill(value) where bill.value->>'id' = expected.value->>'billId') <> 1
  ) then
    perform public.raise_operational_rpc_error('invalid_settlement_scope', 'Each settlement expectation requires exactly one bill update.', '{}'::jsonb);
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_payments) as source(value)
    where coalesce((source.value->>'amount')::numeric, 0) <= 0
  ) then
    perform public.raise_operational_rpc_error('invalid_payments', 'Checkout payments must be positive.', '{}'::jsonb);
  end if;

  -- Entity state is rechecked after all locks are held.
  if v_mode = 'session' then
    if not (v_entity_id = any(v_source_session_ids)) then
      perform public.raise_operational_rpc_error('invalid_payload', 'Primary session is missing from source IDs.', '{}'::jsonb);
    end if;
    if exists (
      select 1 from public.sessions
      where organization_id = v_organization_id and id = v_entity_id
        and (closed_bill_id is not null or (status = 'closed' and coalesce(close_disposition, '') <> 'hopped'))
    ) then
      perform public.raise_operational_rpc_error('session_not_billable', 'The primary session is no longer billable.', jsonb_build_object('session_id', v_entity_id));
    end if;
  elsif v_mode = 'customer_tab' then
    if not (v_entity_id = any(v_source_tab_ids)) then
      perform public.raise_operational_rpc_error('invalid_payload', 'Primary customer tab is missing from source IDs.', '{}'::jsonb);
    end if;
    if exists (
      select 1 from public.customer_tabs
      where organization_id = v_organization_id and id = v_entity_id
        and (status <> 'open' or closed_bill_id is not null)
    ) then
      perform public.raise_operational_rpc_error('customer_tab_not_billable', 'The customer tab is no longer billable.', jsonb_build_object('customer_tab_id', v_entity_id));
    end if;
  else
    if nullif(v_bill->>'replacementOfBillId', '') <> v_entity_id
      or nullif(v_bill->>'replaceReason', '') is null
      or not exists (
        select 1 from public.bills
        where organization_id = v_organization_id and id = v_entity_id
          and status = 'issued' and replaced_by_bill_id is null
      )
    then
      perform public.raise_operational_rpc_error('bill_not_replaceable', 'The original bill is no longer replaceable.', jsonb_build_object('bill_id', v_entity_id));
    end if;
    if not exists (
      select 1 from jsonb_array_elements(v_bills) as source(value)
      where source.value->>'id' = v_entity_id
        and source.value->>'status' = 'replaced'
        and source.value->>'replacedByBillId' = v_bill_id
        and nullif(source.value->>'replacedAt', '') is not null
        and nullif(btrim(source.value->>'replaceReason'), '') is not null
    ) then
      perform public.raise_operational_rpc_error('invalid_replacement_link', 'The original bill must be marked replaced and linked to the new bill.', '{}'::jsonb);
    end if;
  end if;

  if (v_mode = 'bill_replacement' and (cardinality(v_source_session_ids) <> 0 or cardinality(v_source_tab_ids) <> 0))
    or (v_mode = 'session' and (cardinality(v_source_tab_ids) <> 0 or not (v_entity_id = any(v_source_session_ids))))
    or (v_mode = 'customer_tab' and (cardinality(v_source_tab_ids) <> 1 or v_source_tab_ids[1] <> v_entity_id))
  then
    perform public.raise_operational_rpc_error('invalid_source_scope', 'Checkout source arrays do not match the selected mode and primary entity.', '{}'::jsonb);
  end if;

  if v_mode in ('session', 'customer_tab') and exists (
    select 1
    from public.sessions as carried
    where carried.organization_id = v_organization_id
      and carried.id = any(v_source_session_ids)
      and carried.id <> case when v_mode = 'session' then v_entity_id else '' end
      and not (
        carried.id = any(coalesce(
          case when v_mode = 'session' then (
            select array(select jsonb_array_elements_text(coalesce(primary_session.continued_from_session_ids, '[]'::jsonb)))
            from public.sessions as primary_session
            where primary_session.organization_id = v_organization_id and primary_session.id = v_entity_id
          ) else (
            select array(select jsonb_array_elements_text(coalesce(primary_tab.continued_from_session_ids, '[]'::jsonb)))
            from public.customer_tabs as primary_tab
            where primary_tab.organization_id = v_organization_id and primary_tab.id = v_entity_id
          ) end,
          array[]::text[]
        ))
        or exists (
          select 1
          from (
            select customer_id, customer_name, customer_phone from public.sessions
            where v_mode = 'session' and organization_id = v_organization_id and id = v_entity_id
            union all
            select customer_id, customer_name, customer_phone from public.customer_tabs
            where v_mode = 'customer_tab' and organization_id = v_organization_id and id = v_entity_id
          ) as primary_customer
          where (primary_customer.customer_id is not null and carried.customer_id = primary_customer.customer_id)
            or (nullif(regexp_replace(coalesce(primary_customer.customer_phone, ''), '[^0-9+]', '', 'g'), '') is not null
              and regexp_replace(coalesce(carried.customer_phone, ''), '[^0-9+]', '', 'g') = regexp_replace(primary_customer.customer_phone, '[^0-9+]', '', 'g'))
            or (nullif(lower(btrim(primary_customer.customer_name)), '') is not null
              and lower(btrim(coalesce(carried.customer_name, ''))) = lower(btrim(primary_customer.customer_name)))
        )
      )
  ) then
    perform public.raise_operational_rpc_error('unrelated_carried_session', 'A carried session is not linked to the primary entity or matching customer.', '{}'::jsonb);
  end if;

  if exists (
    select 1 from public.sessions
    where organization_id = v_organization_id
      and id = any(v_source_session_ids)
      and id <> case when v_mode = 'session' then v_entity_id else '' end
      and not (status = 'closed' and close_disposition = 'hopped' and closed_bill_id is null)
  ) then
    perform public.raise_operational_rpc_error('carried_session_not_billable', 'A carried session was already billed or changed.', '{}'::jsonb);
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_sessions) as source(value)
    where not (source.value->>'id' = any(v_source_session_ids))
      or source.value->>'status' <> 'closed'
      or source.value->>'closeDisposition' <> 'billed'
      or source.value->>'closedBillId' <> v_bill_id
  ) or exists (
    select 1 from unnest(v_source_session_ids) as requested(id)
    where not exists (select 1 from jsonb_array_elements(v_sessions) as source(value) where source.value->>'id' = requested.id)
  ) then
    perform public.raise_operational_rpc_error('invalid_session_updates', 'Session closure updates do not match the locked sources.', '{}'::jsonb);
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_customer_tabs) as source(value)
    where not (source.value->>'id' = any(v_source_tab_ids))
      or source.value->>'status' <> 'closed'
      or source.value->>'closeDisposition' <> 'billed'
      or source.value->>'closedBillId' <> v_bill_id
  ) or exists (
    select 1 from unnest(v_source_tab_ids) as requested(id)
    where not exists (select 1 from jsonb_array_elements(v_customer_tabs) as source(value) where source.value->>'id' = requested.id)
  ) then
    perform public.raise_operational_rpc_error('invalid_customer_tab_updates', 'Customer-tab closure updates do not match the locked sources.', '{}'::jsonb);
  end if;

  if v_mode <> 'bill_replacement' and exists (
    select 1
    from jsonb_array_elements(v_sessions) as source(value)
    join public.sessions as current_session
      on current_session.organization_id = v_organization_id and current_session.id = source.value->>'id'
    where nullif(source.value->>'startedAt', '') is null
      or nullif(source.value->>'endedAt', '') is null
      or (source.value->>'startedAt')::timestamptz > (source.value->>'endedAt')::timestamptz
      or (source.value->>'endedAt')::timestamptz > timezone('utc', now()) + interval '1 minute'
      or (
        current_session.id <> case when v_mode = 'session' then v_entity_id else '' end
        and (
          (source.value->>'startedAt')::timestamptz is distinct from current_session.started_at
          or (source.value->>'endedAt')::timestamptz is distinct from current_session.ended_at
        )
      )
      or (
        current_session.id = case when v_mode = 'session' then v_entity_id else '' end
        and public.current_user_org_role(v_organization_id) <> 'admin'::public.app_role
        and (
          (source.value->>'startedAt')::timestamptz is distinct from current_session.started_at
          or (
            current_session.ended_at is not null
            and (source.value->>'endedAt')::timestamptz is distinct from current_session.ended_at
          )
        )
      )
  ) then
    perform public.raise_operational_rpc_error('invalid_session_timing', 'Session timing changes are invalid or not authorized.', '{}'::jsonb);
  end if;

  if v_mode = 'customer_tab' and exists (
    select 1 from jsonb_array_elements(v_customer_tabs) as source(value)
    where nullif(source.value->>'closedAt', '') is null
      or (source.value->>'closedAt')::timestamptz > timezone('utc', now()) + interval '1 minute'
  ) then
    perform public.raise_operational_rpc_error('invalid_customer_tab_timing', 'The customer tab close time is invalid.', '{}'::jsonb);
  end if;

  if nullif(v_bill->>'status', '') is null or v_bill->>'status' not in ('issued', 'pending')
    or nullif(v_bill->>'paymentMode', '') is null or v_bill->>'paymentMode' not in ('cash', 'upi', 'split', 'deferred')
    or nullif(v_bill->>'receiptType', '') is null or v_bill->>'receiptType' <> 'digital'
    or (coalesce((v_bill->>'amountDue')::numeric, 0) > 0.01 and v_bill->>'status' <> 'pending')
    or (coalesce((v_bill->>'amountDue')::numeric, 0) <= 0.01 and v_bill->>'status' <> 'issued')
    or (v_bill->>'paymentMode' <> 'deferred' and coalesce((v_bill->>'amountDue')::numeric, 0) > 0.01)
    or exists (
      select 1 from jsonb_array_elements(v_payments) as source(value)
      where nullif(source.value->>'mode', '') is null or source.value->>'mode' not in ('cash', 'upi')
    )
    or (v_bill->>'paymentMode' = 'cash' and exists (
      select 1 from jsonb_array_elements(v_payments) as source(value)
      where source.value->>'billId' = v_bill_id and source.value->>'mode' <> 'cash'
    ))
    or (v_bill->>'paymentMode' = 'upi' and exists (
      select 1 from jsonb_array_elements(v_payments) as source(value)
      where source.value->>'billId' = v_bill_id and source.value->>'mode' <> 'upi'
    ))
  then
    perform public.raise_operational_rpc_error('invalid_bill_state', 'Bill status, payment mode, or receipt state is invalid.', jsonb_build_object('bill_id', v_bill_id));
  end if;

  if v_mode = 'session' and (
    nullif(v_bill->>'sessionId', '') <> v_entity_id
    or nullif(v_bill->>'stationId', '') is distinct from (
      select station_id from public.sessions where organization_id = v_organization_id and id = v_entity_id
    )
  ) then
    perform public.raise_operational_rpc_error('invalid_bill_source', 'The bill does not reference the locked primary session.', '{}'::jsonb);
  elsif v_mode = 'customer_tab' and (
    nullif(v_bill->>'sessionId', '') is not null or nullif(v_bill->>'stationId', '') is not null
  ) then
    perform public.raise_operational_rpc_error('invalid_bill_source', 'A customer-tab bill cannot claim a station session.', '{}'::jsonb);
  end if;

  if (
    nullif(v_bill->>'customerId', '') is null and (
      nullif(v_bill->>'customerName', '') is not null
      or nullif(v_bill->>'customerPhone', '') is not null
      or jsonb_array_length(v_customers) <> 0
    )
  ) or (
    nullif(v_bill->>'customerId', '') is not null and (
      jsonb_array_length(v_customers) > 1
      or not (
        exists (
          select 1 from jsonb_array_elements(v_customers) as customer(value)
          where customer.value->>'id' = v_bill->>'customerId'
            and coalesce(nullif(customer.value->>'name', ''), nullif(customer.value->>'phone', ''))
              is not distinct from coalesce(nullif(v_bill->>'customerName', ''), nullif(v_bill->>'customerPhone', ''))
            and nullif(customer.value->>'phone', '') is not distinct from nullif(v_bill->>'customerPhone', '')
        )
        or (
          jsonb_array_length(v_customers) = 0 and exists (
            select 1 from public.customers as current_customer
            where current_customer.organization_id = v_organization_id
              and current_customer.id = v_bill->>'customerId'
              and current_customer.name is not distinct from coalesce(nullif(v_bill->>'customerName', ''), nullif(v_bill->>'customerPhone', ''))
              and current_customer.phone is not distinct from nullif(v_bill->>'customerPhone', '')
          )
        )
      )
    )
  ) or (
    v_mode = 'session' and exists (
      select 1 from jsonb_array_elements(v_sessions) as update_row(value)
      where update_row.value->>'id' = v_entity_id and (
        nullif(update_row.value->>'customerId', '') is distinct from nullif(v_bill->>'customerId', '')
        or nullif(update_row.value->>'customerName', '') is distinct from nullif(v_bill->>'customerName', '')
        or nullif(update_row.value->>'customerPhone', '') is distinct from nullif(v_bill->>'customerPhone', '')
      )
    )
  ) or (
    v_mode = 'customer_tab' and exists (
      select 1 from jsonb_array_elements(v_customer_tabs) as update_row(value)
      where update_row.value->>'id' = v_entity_id and (
        nullif(update_row.value->>'customerId', '') is distinct from nullif(v_bill->>'customerId', '')
        or nullif(update_row.value->>'customerName', '') is distinct from nullif(v_bill->>'customerName', '')
        or nullif(update_row.value->>'customerPhone', '') is distinct from nullif(v_bill->>'customerPhone', '')
      )
    )
  ) then
    perform public.raise_operational_rpc_error(
      'invalid_customer_scope',
      'The bill, primary source, and customer profile identity do not agree.',
      jsonb_build_object('bill_id', v_bill_id)
    );
  end if;

  -- Inventory and combo bill rows must match the locked server snapshots exactly.
  if v_mode <> 'bill_replacement' and exists (
    with expected as (
      select inventory_item_id, sale_variant_id, combo_application_id, combo_id,
        sold_as_pack_of, stock_units_per_sale, expected_description, sum(quantity) as quantity, unit_price
      from (
        select item.inventory_item_id, item.sale_variant_id, item.combo_application_id, item.combo_id,
          item.sold_as_pack_of, item.stock_units_per_sale, item.quantity, item.unit_price,
          case
            when item.combo_application_id is not null then item.name || ' (included in ' || combo.combo_name || ')'
            when item.sold_as_pack_of is not null then item.name || ' (Pack of ' || to_char(item.sold_as_pack_of, 'FM999999999999990.###') || ')'
            else item.name
          end as expected_description
        from public.session_items as item
        left join public.session_combo_applications as combo
          on combo.organization_id = item.organization_id
          and combo.session_id = item.session_id
          and combo.id = item.combo_application_id
        where item.organization_id = v_organization_id and item.session_id = any(v_source_session_ids)
        union all
        select item.inventory_item_id, item.sale_variant_id, item.combo_application_id, item.combo_id,
          item.sold_as_pack_of, item.stock_units_per_sale, item.quantity, item.unit_price,
          case
            when item.combo_application_id is not null then item.name || ' (included in ' || combo.combo_name || ')'
            when item.sold_as_pack_of is not null then item.name || ' (Pack of ' || to_char(item.sold_as_pack_of, 'FM999999999999990.###') || ')'
            else item.name
          end as expected_description
        from public.customer_tab_items as item
        left join public.customer_tab_combo_applications as combo
          on combo.organization_id = item.organization_id
          and combo.customer_tab_id = item.customer_tab_id
          and combo.id = item.combo_application_id
        where item.organization_id = v_organization_id and item.customer_tab_id = any(v_source_tab_ids)
      ) as source_items
      group by inventory_item_id, sale_variant_id, combo_application_id, combo_id,
        sold_as_pack_of, stock_units_per_sale, expected_description, unit_price
    ), actual as (
      select nullif(line->>'inventoryItemId', '') as inventory_item_id,
        nullif(line->>'saleVariantId', '') as sale_variant_id,
        nullif(line->>'comboApplicationId', '') as combo_application_id,
        nullif(line->>'comboId', '') as combo_id,
        nullif(line->>'soldAsPackOf', '')::numeric as sold_as_pack_of,
        nullif(line->>'stockUnitsPerSale', '')::numeric as stock_units_per_sale,
        nullif(line->>'description', '') as actual_description,
        sum(coalesce((line->>'quantity')::numeric, 0)) as quantity,
        coalesce((line->>'unitPrice')::numeric, 0) as unit_price
      from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)
      where line->>'type' = 'inventory_item'
      group by nullif(line->>'inventoryItemId', ''), nullif(line->>'saleVariantId', ''),
        nullif(line->>'comboApplicationId', ''), nullif(line->>'comboId', ''),
        nullif(line->>'soldAsPackOf', '')::numeric, nullif(line->>'stockUnitsPerSale', '')::numeric,
        nullif(line->>'description', ''),
        coalesce((line->>'unitPrice')::numeric, 0)
    )
    select 1
    from expected full join actual
      on actual.inventory_item_id is not distinct from expected.inventory_item_id
      and actual.sale_variant_id is not distinct from expected.sale_variant_id
      and actual.combo_application_id is not distinct from expected.combo_application_id
      and actual.combo_id is not distinct from expected.combo_id
      and actual.sold_as_pack_of is not distinct from expected.sold_as_pack_of
      and actual.stock_units_per_sale is not distinct from expected.stock_units_per_sale
      and actual.actual_description is not distinct from expected.expected_description
      and actual.unit_price is not distinct from expected.unit_price
    where expected.inventory_item_id is null or actual.inventory_item_id is null
      or abs(expected.quantity - actual.quantity) > 0.0001
  ) then
    perform public.raise_operational_rpc_error('source_item_mismatch', 'Bill inventory rows do not match the locked session or tab items.', '{}'::jsonb);
  end if;

  -- A replacement may change/remove original inventory quantities and add a
  -- currently sellable catalog option. Immutable snapshot/conversion fields
  -- come from the original bill line or normalized catalog, never the client.
  if v_mode = 'bill_replacement' and exists (
    select 1
    from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)
    left join public.bill_lines as original_line
      on original_line.organization_id = v_organization_id
      and original_line.bill_id = v_entity_id
      and original_line.id = line->>'id'
    left join public.inventory_items as catalog_item
      on catalog_item.organization_id = v_organization_id
      and catalog_item.id = line->>'inventoryItemId'
    left join public.sale_variants as catalog_variant
      on catalog_variant.organization_id = v_organization_id
      and catalog_variant.inventory_item_id = line->>'inventoryItemId'
      and catalog_variant.id = line->>'saleVariantId'
    where (
      original_line.id is not null and (
        nullif(line->>'type', '') is distinct from original_line.type
        or nullif(line->>'description', '') is distinct from original_line.description
        or coalesce((line->>'unitPrice')::numeric, 0) is distinct from original_line.unit_price
        or nullif(line->>'linkedSessionId', '') is distinct from original_line.linked_session_id
        or nullif(line->>'inventoryItemId', '') is distinct from original_line.inventory_item_id
        or nullif(line->>'soldAsPackOf', '')::numeric is distinct from original_line.sold_as_pack_of
        or nullif(line->>'saleVariantId', '') is distinct from original_line.sale_variant_id
        or nullif(line->>'stockUnitsPerSale', '')::numeric is distinct from original_line.stock_units_per_sale
        or nullif(line->>'comboApplicationId', '') is distinct from original_line.combo_application_id
        or nullif(line->>'comboId', '') is distinct from original_line.combo_id
        or (original_line.type <> 'inventory_item' and coalesce((line->>'quantity')::numeric, 0) is distinct from original_line.quantity)
      )
    ) or (
      original_line.id is null and (
        nullif(line->>'type', '') is distinct from 'inventory_item'
        or nullif(line->>'inventoryItemId', '') is null
        or nullif(line->>'linkedSessionId', '') is not null
        or nullif(line->>'comboApplicationId', '') is not null
        or nullif(line->>'comboId', '') is not null
        or nullif(line->>'soldAsPackOf', '') is not null
        or catalog_item.id is null
        or not catalog_item.active
        or (
          nullif(line->>'saleVariantId', '') is null and (
            not catalog_item.sell_base_item
            or nullif(line->>'description', '') is distinct from catalog_item.name
            or coalesce((line->>'unitPrice')::numeric, 0) is distinct from catalog_item.price
            or nullif(line->>'stockUnitsPerSale', '') is not null
          )
        )
        or (
          nullif(line->>'saleVariantId', '') is not null and (
            catalog_variant.id is null
            or not catalog_variant.active
            or nullif(line->>'description', '') is distinct from catalog_variant.name
            or coalesce((line->>'unitPrice')::numeric, 0) is distinct from catalog_variant.price
            or nullif(line->>'stockUnitsPerSale', '')::numeric is distinct from catalog_variant.stock_units_per_sale
          )
        )
      )
    )
  ) then
    perform public.raise_operational_rpc_error(
      'replacement_source_mismatch',
      'Replacement lines do not match the original bill snapshots or current normalized catalog.',
      jsonb_build_object('original_bill_id', v_entity_id)
    );
  end if;

  if v_mode <> 'bill_replacement' and exists (
    with expected as (
      select id as combo_application_id, combo_id, combo_name as expected_description,
        price as unit_price, session_id as linked_session_id
      from public.session_combo_applications
      where organization_id = v_organization_id and session_id = any(v_source_session_ids)
      union all
      select id, combo_id, combo_name, price, null::text
      from public.customer_tab_combo_applications
      where organization_id = v_organization_id and customer_tab_id = any(v_source_tab_ids)
    ), actual as (
      select nullif(line->>'comboApplicationId', '') as combo_application_id,
        nullif(line->>'comboId', '') as combo_id,
        nullif(line->>'description', '') as actual_description,
        coalesce((line->>'unitPrice')::numeric, 0) as unit_price,
        nullif(line->>'linkedSessionId', '') as linked_session_id,
        count(*) as row_count,
        sum(coalesce((line->>'quantity')::numeric, 0)) as quantity
      from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)
      where line->>'type' = 'combo_package'
      group by nullif(line->>'comboApplicationId', ''), nullif(line->>'comboId', ''), nullif(line->>'description', ''),
        coalesce((line->>'unitPrice')::numeric, 0), nullif(line->>'linkedSessionId', '')
    )
    select 1
    from expected full join actual
      on actual.combo_application_id is not distinct from expected.combo_application_id
      and actual.combo_id is not distinct from expected.combo_id
      and actual.actual_description is not distinct from expected.expected_description
      and actual.unit_price is not distinct from expected.unit_price
      and actual.linked_session_id is not distinct from expected.linked_session_id
    where expected.combo_application_id is null or actual.combo_application_id is null
      or actual.row_count <> 1 or abs(actual.quantity - 1) > 0.0001
  ) then
    perform public.raise_operational_rpc_error('source_combo_mismatch', 'Bill combo rows do not match the locked combo snapshots.', '{}'::jsonb);
  end if;

  if v_mode <> 'bill_replacement' and (
    exists (
      select 1 from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)
      where line->>'type' = 'combo_detail'
        and (
          coalesce((line->>'quantity')::numeric, 0) <> 1
          or coalesce((line->>'unitPrice')::numeric, 0) <> 0
          or line->>'id' <> 'line-combo-' || (line->>'comboApplicationId') || '-game'
          or line->>'description' is distinct from (
            select public.format_financial_minutes_v2(combo.included_minutes)
              || ' ' || current_session.station_name_snapshot || ' play included'
            from public.session_combo_applications as combo
            join public.sessions as current_session
              on current_session.organization_id = combo.organization_id and current_session.id = combo.session_id
            where combo.organization_id = v_organization_id
              and combo.session_id = line->>'linkedSessionId'
              and combo.id = line->>'comboApplicationId'
          )
          or not exists (
            select 1 from public.session_combo_applications
            where organization_id = v_organization_id
              and session_id = line->>'linkedSessionId'
              and id = line->>'comboApplicationId'
              and session_id = any(v_source_session_ids)
          )
        )
    )
    or exists (
      select 1 from public.session_combo_applications as combo
      where combo.organization_id = v_organization_id and combo.session_id = any(v_source_session_ids)
        and (select count(*) from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)
          where line->>'type' = 'combo_detail'
            and line->>'linkedSessionId' = combo.session_id
            and line->>'comboApplicationId' = combo.id) <> 1
    )
  ) then
    perform public.raise_operational_rpc_error('source_combo_detail_mismatch', 'Bill combo detail rows do not match the locked session combo snapshots.', '{}'::jsonb);
  end if;

  if v_mode <> 'bill_replacement' and (
    exists (
      select 1
      from public.sessions as current_session
      join jsonb_array_elements(v_sessions) as update_row(value) on update_row.value->>'id' = current_session.id
      cross join lateral public.calculate_financial_session_charge_v2(
        v_organization_id,
        current_session.id,
        (update_row.value->>'startedAt')::timestamptz,
        (update_row.value->>'endedAt')::timestamptz
      ) as expected(charge)
      where current_session.organization_id = v_organization_id and current_session.id = any(v_source_session_ids)
        and current_session.mode = 'timed'
        and (
          (select count(*) from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)
            where line->>'type' = 'session_charge' and line->>'linkedSessionId' = current_session.id)
          <> case when coalesce((expected.charge->>'combo_count')::integer, 0) = 0
              or coalesce((expected.charge->>'extra_minutes')::numeric, 0) > 0.0001 then 1 else 0 end
          or exists (
            select 1 from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)
            where line->>'type' = 'session_charge' and line->>'linkedSessionId' = current_session.id
              and (
                line->>'id' <> 'line-session-' || current_session.id
                or coalesce((line->>'quantity')::numeric, 0) <> 1
                or abs(coalesce((line->>'unitPrice')::numeric, 0) - coalesce((expected.charge->>'charge')::numeric, 0)) > 0.01
                or line->>'description' is distinct from case
                  when coalesce((expected.charge->>'combo_count')::integer, 0) > 0 then
                    current_session.station_name_snapshot || ' extra time ('
                      || public.format_financial_minutes_v2((expected.charge->>'extra_minutes')::numeric) || ')'
                  else current_session.station_name_snapshot || ' session ('
                    || public.format_financial_minutes_v2((expected.charge->>'billed_minutes')::numeric) || ')'
                end
              )
          )
        )
    )
    or exists (
      select 1 from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)
      where line->>'type' = 'session_charge'
        and not exists (
          select 1 from public.sessions
          where organization_id = v_organization_id and id = line->>'linkedSessionId'
            and id = any(v_source_session_ids) and mode = 'timed'
        )
    )
  ) then
    perform public.raise_operational_rpc_error('session_charge_mismatch', 'Bill timing charges do not match the locked sessions, pauses, combos, and pricing snapshots.', '{}'::jsonb);
  end if;

  -- Reconcile bill arithmetic to one paisa without changing business rules.
  if abs(coalesce((v_bill->>'subtotal')::numeric, 0) - coalesce((select sum((line->>'subtotal')::numeric) from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)), 0)) > 0.01
    or abs(coalesce((v_bill->>'totalDiscountAmount')::numeric, 0) - (
      coalesce((select sum((line->>'discountAmount')::numeric) from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)), 0)
      + coalesce((v_bill->>'billDiscountAmount')::numeric, 0)
    )) > 0.01
    or abs(coalesce((v_bill->>'total')::numeric, 0) - (
      coalesce((v_bill->>'subtotal')::numeric, 0)
      - coalesce((v_bill->>'totalDiscountAmount')::numeric, 0)
      + coalesce((v_bill->>'roundOffAmount')::numeric, 0)
    )) > 0.01
    or abs(coalesce((v_bill->>'amountPaid')::numeric, 0) + coalesce((v_bill->>'amountDue')::numeric, 0) - coalesce((v_bill->>'total')::numeric, 0)) > 0.01
    or coalesce((v_bill->>'amountPaid')::numeric, 0) < 0
    or coalesce((v_bill->>'amountDue')::numeric, 0) < 0
    or coalesce((v_bill->>'subtotal')::numeric, 0) < 0
    or coalesce((v_bill->>'total')::numeric, 0) < 0
    or (coalesce((v_bill->>'subtotal')::numeric, 0) = 0 and coalesce((v_bill->>'total')::numeric, 0) = 0)
  then
    perform public.raise_operational_rpc_error('bill_totals_mismatch', 'Bill totals do not reconcile.', jsonb_build_object('bill_id', v_bill_id));
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)
    where nullif(line->>'type', '') is null
      or line->>'type' not in ('session_charge', 'inventory_item', 'manual_charge', 'combo_package', 'combo_detail')
      or (v_mode <> 'bill_replacement' and line->>'type' = 'manual_charge')
      or nullif(line->>'id', '') is null
      or nullif(line->>'description', '') is null
      or coalesce((line->>'quantity')::numeric, 0) <= 0
      or coalesce((line->>'unitPrice')::numeric, 0) < 0
      or coalesce((line->>'discountAmount')::numeric, 0) < 0
      or coalesce((line->>'discountAmount')::numeric, 0) > coalesce((line->>'subtotal')::numeric, 0) + 0.01
      or abs(coalesce((line->>'subtotal')::numeric, 0) - coalesce((line->>'quantity')::numeric, 0) * coalesce((line->>'unitPrice')::numeric, 0)) > 0.01
      or abs(coalesce((line->>'total')::numeric, 0) - (coalesce((line->>'subtotal')::numeric, 0) - coalesce((line->>'discountAmount')::numeric, 0))) > 0.01
      or (nullif(line->>'linkedSessionId', '') is not null and not (line->>'linkedSessionId' = any(v_source_session_ids)))
  ) or exists (
    select 1
    from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)
    group by line->>'id'
    having count(*) <> 1
  ) or exists (
    select 1 from jsonb_array_elements(coalesce(v_bill->'lineDiscounts', '[]'::jsonb)) as source(discount)
    left join lateral (
      select line
      from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as bill_line(line)
      where bill_line.line->>'id' = discount->>'targetId'
      limit 1
    ) as target on true
    where nullif(discount->>'id', '') is null
      or nullif(discount->>'scope', '') is null or discount->>'scope' <> 'line'
      or target.line is null
      or nullif(discount->>'type', '') is null or discount->>'type' not in ('amount', 'percentage')
      or coalesce((discount->>'value')::numeric, 0) <= 0
      or (discount->>'type' = 'percentage' and coalesce((discount->>'value')::numeric, 0) > 100)
      or coalesce((discount->>'amount')::numeric, 0) <= 0
      or nullif(btrim(discount->>'reason'), '') is null
      or abs(
        coalesce((discount->>'amount')::numeric, 0)
        - least(
          coalesce((target.line->>'subtotal')::numeric, 0),
          case when discount->>'type' = 'percentage'
            then coalesce((target.line->>'subtotal')::numeric, 0) * coalesce((discount->>'value')::numeric, 0) / 100
            else coalesce((discount->>'value')::numeric, 0)
          end
        )
      ) > 0.01
      or abs(coalesce((target.line->>'discountAmount')::numeric, 0) - coalesce((discount->>'amount')::numeric, 0)) > 0.01
  ) or exists (
    select 1
    from jsonb_array_elements(coalesce(v_bill->'lineDiscounts', '[]'::jsonb)) as source(discount)
    group by discount->>'targetId'
    having count(*) <> 1
  ) or exists (
    select 1 from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)
    where (
      coalesce((line->>'discountAmount')::numeric, 0) > 0.01
      and not exists (
        select 1 from jsonb_array_elements(coalesce(v_bill->'lineDiscounts', '[]'::jsonb)) as source(discount)
        where discount->>'targetId' = line->>'id'
      )
    ) or (
      coalesce((line->>'discountAmount')::numeric, 0) <= 0.01
      and exists (
        select 1 from jsonb_array_elements(coalesce(v_bill->'lineDiscounts', '[]'::jsonb)) as source(discount)
        where discount->>'targetId' = line->>'id'
      )
    )
  ) or (
    jsonb_typeof(v_bill->'billDiscount') = 'object'
    and (
      nullif(v_bill->'billDiscount'->>'id', '') is null
      or nullif(v_bill->'billDiscount'->>'scope', '') is null or v_bill->'billDiscount'->>'scope' <> 'bill'
      or nullif(v_bill->'billDiscount'->>'targetId', '') is null or v_bill->'billDiscount'->>'targetId' <> v_bill_id
      or nullif(v_bill->'billDiscount'->>'type', '') is null or v_bill->'billDiscount'->>'type' not in ('amount', 'percentage')
      or coalesce((v_bill->'billDiscount'->>'value')::numeric, 0) <= 0
      or (v_bill->'billDiscount'->>'type' = 'percentage' and coalesce((v_bill->'billDiscount'->>'value')::numeric, 0) > 100)
      or nullif(btrim(v_bill->'billDiscount'->>'reason'), '') is null
      or abs(
        coalesce((v_bill->'billDiscount'->>'amount')::numeric, 0)
        - least(
          coalesce((v_bill->>'subtotal')::numeric, 0)
            - coalesce((select sum((line->>'discountAmount')::numeric) from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)), 0),
          case when v_bill->'billDiscount'->>'type' = 'percentage'
            then (
              coalesce((v_bill->>'subtotal')::numeric, 0)
                - coalesce((select sum((line->>'discountAmount')::numeric) from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)), 0)
            ) * coalesce((v_bill->'billDiscount'->>'value')::numeric, 0) / 100
            else coalesce((v_bill->'billDiscount'->>'value')::numeric, 0)
          end
        )
      ) > 0.01
      or abs(coalesce((v_bill->'billDiscount'->>'amount')::numeric, 0) - coalesce((v_bill->>'billDiscountAmount')::numeric, 0)) > 0.01
    )
  ) or (
    coalesce(jsonb_typeof(v_bill->'billDiscount'), 'null') <> 'object'
    and coalesce((v_bill->>'billDiscountAmount')::numeric, 0) > 0.01
  ) then
    perform public.raise_operational_rpc_error('invalid_bill_lines', 'Bill lines or discount reasons are invalid.', jsonb_build_object('bill_id', v_bill_id));
  end if;

  if exists (
    select 1
    from public.sessions as current_session
    join jsonb_array_elements(v_sessions) as update_row(value) on update_row.value->>'id' = current_session.id
    where current_session.organization_id = v_organization_id
      and current_session.id = any(v_source_session_ids)
      and (
        (
          current_session.ltp_eligible and current_session.play_mode = 'solo'
          and (nullif(update_row.value->>'ltpOutcome', '') is null or update_row.value->>'ltpOutcome' not in ('won', 'lost'))
        )
        or (
          not (current_session.ltp_eligible and current_session.play_mode = 'solo')
          and (nullif(update_row.value->>'ltpOutcome', '') is not null or coalesce((update_row.value->>'ltpDiscountApplied')::boolean, false))
        )
        or coalesce((update_row.value->>'ltpDiscountApplied')::boolean, false)
          <> (current_session.ltp_eligible and current_session.play_mode = 'solo' and update_row.value->>'ltpOutcome' = 'won')
        or (
          current_session.ltp_eligible and current_session.play_mode = 'solo' and update_row.value->>'ltpOutcome' = 'won'
          and exists (
            select 1 from jsonb_array_elements(coalesce(v_bill->'lines', '[]'::jsonb)) as source(line)
            where line->>'id' = 'line-session-' || current_session.id
              and not exists (
                select 1 from jsonb_array_elements(coalesce(v_bill->'lineDiscounts', '[]'::jsonb)) as source(discount)
                where discount->>'targetId' = line->>'id'
                  and discount->>'type' = 'amount'
                  and abs(coalesce((discount->>'amount')::numeric, 0) - coalesce((line->>'subtotal')::numeric, 0)) <= 0.01
                  and discount->>'reason' = 'LTP win - game charge waived'
              )
          )
        )
      )
  ) then
    perform public.raise_operational_rpc_error('invalid_ltp_result', 'The LTP result or discount does not match the locked session.', '{}'::jsonb);
  end if;

  if abs(coalesce((v_bill->>'roundOffAmount')::numeric, 0) - case
      when coalesce((v_bill->>'roundOffEnabled')::boolean, false)
        then round(coalesce((v_bill->>'subtotal')::numeric, 0) - coalesce((v_bill->>'totalDiscountAmount')::numeric, 0))
          - (coalesce((v_bill->>'subtotal')::numeric, 0) - coalesce((v_bill->>'totalDiscountAmount')::numeric, 0))
      else 0
    end) > 0.01
  then
    perform public.raise_operational_rpc_error('invalid_rounding', 'The bill round-off does not match the selected rule.', '{}'::jsonb);
  end if;

  if abs(
    coalesce((select sum((payment->>'amount')::numeric) from jsonb_array_elements(v_payments) as source(payment) where payment->>'billId' = v_bill_id), 0)
    - coalesce((v_bill->>'amountPaid')::numeric, 0)
  ) > 0.01 then
    perform public.raise_operational_rpc_error('payment_totals_mismatch', 'Payments do not match the new bill amount paid.', jsonb_build_object('bill_id', v_bill_id));
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_payments) as source(payment)
    where (
      payment->>'billId' = v_bill_id
      and (nullif(payment->>'relatedCheckoutBillId', '') is not null or nullif(payment->>'settlementGroupId', '') is not null)
    ) or (
      payment->>'billId' <> v_bill_id
      and (
        not exists (
          select 1 from jsonb_array_elements(v_settlement_expectations) as expected(value)
          where expected.value->>'billId' = payment->>'billId'
        )
        or payment->>'relatedCheckoutBillId' is distinct from v_bill_id
        or nullif(payment->>'settlementGroupId', '') is null
      )
    )
  ) or (
    exists (select 1 from jsonb_array_elements(v_payments) as source(payment) where payment->>'billId' <> v_bill_id)
    and (select count(distinct payment->>'settlementGroupId') from jsonb_array_elements(v_payments) as source(payment) where payment->>'billId' <> v_bill_id) <> 1
  ) then
    perform public.raise_operational_rpc_error('invalid_settlement_linkage', 'Checkout payment linkage does not match the new bill and settlement group.', '{}'::jsonb);
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_payments) as source(value)
    where nullif(source.value->>'id', '') is null or nullif(source.value->>'billId', '') is null
  ) or exists (
    select 1 from jsonb_array_elements(v_payments) as source(value)
    group by source.value->>'id'
    having count(*) <> 1
  ) or exists (
    select 1 from jsonb_array_elements(v_stock_movements) as source(value)
    where nullif(source.value->>'id', '') is null
      or nullif(source.value->>'itemId', '') is null
      or nullif(source.value->>'type', '') is null
      or (
        v_mode <> 'bill_replacement' and source.value->>'type' <> 'sale'
      )
      or (
        v_mode = 'bill_replacement' and not (
          (coalesce((source.value->>'quantity')::numeric, 0) < 0 and source.value->>'type' = 'sale')
          or (coalesce((source.value->>'quantity')::numeric, 0) > 0 and source.value->>'type' = 'void_refund_reversal')
        )
      )
      or nullif(btrim(source.value->>'reason'), '') is null
  ) or exists (
    select 1 from jsonb_array_elements(v_stock_movements) as source(value)
    group by source.value->>'id'
    having count(*) <> 1
  ) or exists (
    select 1 from jsonb_array_elements(v_audit_logs) as source(value)
    where nullif(source.value->>'id', '') is null
      or nullif(source.value->>'action', '') is null
      or nullif(source.value->>'entityType', '') is null
      or nullif(source.value->>'entityId', '') is null
      or nullif(btrim(source.value->>'message'), '') is null
  ) or exists (
    select 1 from jsonb_array_elements(v_audit_logs) as source(value)
    group by source.value->>'id'
    having count(*) <> 1
  ) or exists (
    select 1 from jsonb_array_elements(v_customers) as source(value)
    where nullif(source.value->>'id', '') is null
  ) then
    perform public.raise_operational_rpc_error('missing_financial_row_identity', 'Every financial row must have a unique server-persistable identity.', '{}'::jsonb);
  end if;

  if (
    select count(*) from jsonb_array_elements(v_audit_logs) as source(value)
    where source.value->>'entityType' = 'bill' and source.value->>'entityId' = v_bill_id
      and source.value->>'action' = case when v_mode = 'bill_replacement' then 'bill_replaced' else 'bill_issued' end
  ) <> 1 or (
    v_bill->>'status' = 'pending' and (
      select count(*) from jsonb_array_elements(v_audit_logs) as source(value)
      where source.value->>'entityType' = 'bill' and source.value->>'entityId' = v_bill_id and source.value->>'action' = 'bill_pending'
    ) <> 1
  ) or (
    v_bill->>'status' <> 'pending' and exists (
      select 1 from jsonb_array_elements(v_audit_logs) as source(value)
      where source.value->>'entityType' = 'bill' and source.value->>'entityId' = v_bill_id and source.value->>'action' = 'bill_pending'
    )
  ) or exists (
    select 1 from jsonb_array_elements(v_audit_logs) as source(value)
    where not (
      (source.value->>'entityType' = 'bill' and source.value->>'entityId' = v_bill_id and (
        source.value->>'action' = case when v_mode = 'bill_replacement' then 'bill_replaced' else 'bill_issued' end
        or (v_bill->>'status' = 'pending' and source.value->>'action' = 'bill_pending')
      ))
      or (source.value->>'entityType' = 'bill' and source.value->>'action' = 'bill_settled' and exists (
        select 1 from jsonb_array_elements(v_settlement_expectations) as expected(value)
        where expected.value->>'billId' = source.value->>'entityId'
      ))
      or (source.value->>'entityType' = 'session' and source.value->>'action' = 'session_hop_billed'
        and source.value->>'entityId' = any(v_source_session_ids) and source.value->>'entityId' <> v_entity_id
        and exists (
          select 1 from public.sessions as current_session
          where current_session.organization_id = v_organization_id and current_session.id = source.value->>'entityId'
            and current_session.status = 'closed' and current_session.close_disposition = 'hopped'
            and current_session.closed_bill_id is null
        ))
      or (v_mode = 'session' and source.value->>'entityType' = 'session' and source.value->>'entityId' = v_entity_id
        and (
          (source.value->>'action' = 'ltp_discount_applied' and exists (
            select 1 from public.sessions as current_session
            join jsonb_array_elements(v_sessions) as update_row(value) on update_row.value->>'id' = current_session.id
            where current_session.organization_id = v_organization_id and current_session.id = v_entity_id
              and current_session.ltp_eligible and current_session.play_mode = 'solo'
              and update_row.value->>'ltpOutcome' = 'won'
              and coalesce((update_row.value->>'ltpDiscountApplied')::boolean, false)
          ))
          or (source.value->>'action' = 'session_checkout_details_updated' and exists (
            select 1 from public.sessions as current_session
            join jsonb_array_elements(v_sessions) as update_row(value) on update_row.value->>'id' = current_session.id
            where current_session.organization_id = v_organization_id and current_session.id = v_entity_id
              and (
                (update_row.value->>'startedAt')::timestamptz is distinct from current_session.started_at
                or nullif(update_row.value->>'customerName', '') is distinct from current_session.customer_name
                or nullif(update_row.value->>'customerPhone', '') is distinct from current_session.customer_phone
              )
          ))
        ))
      or (v_mode = 'customer_tab' and source.value->>'entityType' = 'customer_tab' and source.value->>'entityId' = v_entity_id
        and source.value->>'action' = 'customer_tab_checkout_details_updated' and exists (
          select 1 from public.customer_tabs as current_tab
          join jsonb_array_elements(v_customer_tabs) as update_row(value) on update_row.value->>'id' = current_tab.id
          where current_tab.organization_id = v_organization_id and current_tab.id = v_entity_id
            and (
              nullif(update_row.value->>'customerName', '') is distinct from current_tab.customer_name
              or nullif(update_row.value->>'customerPhone', '') is distinct from current_tab.customer_phone
            )
        ))
    )
  ) or exists (
    select 1 from jsonb_array_elements(v_audit_logs) as source(value)
    group by source.value->>'entityType', source.value->>'entityId', source.value->>'action'
    having count(*) <> 1
  ) or exists (
    select 1 from unnest(v_source_session_ids) as carried(id)
    where carried.id <> case when v_mode = 'session' then v_entity_id else '' end
      and (
        select count(*) from jsonb_array_elements(v_audit_logs) as audit(value)
        where audit.value->>'entityType' = 'session' and audit.value->>'entityId' = carried.id
          and audit.value->>'action' = 'session_hop_billed'
      ) <> 1
  ) then
    perform public.raise_operational_rpc_error('invalid_audit_scope', 'Checkout audit rows are missing or outside the mutation scope.', '{}'::jsonb);
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_settlement_expectations) as expected(value)
    where not exists (
      select 1 from jsonb_array_elements(v_audit_logs) as audit(value)
      where audit.value->>'entityType' = 'bill'
        and audit.value->>'entityId' = expected.value->>'billId'
        and audit.value->>'action' = 'bill_settled'
    )
  ) or exists (
    select 1 from jsonb_array_elements(v_customers) as customer(value)
    where nullif(v_bill->>'customerId', '') is null
      or customer.value->>'id' <> v_bill->>'customerId'
  ) then
    perform public.raise_operational_rpc_error('missing_financial_evidence', 'Settlement audit or customer scope is incomplete.', '{}'::jsonb);
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_settlement_expectations) as source(expectation)
    join public.bills as current_bill
      on current_bill.organization_id = v_organization_id and current_bill.id = expectation->>'billId'
    left join lateral (
      select updated.value
      from jsonb_array_elements(v_bills) as updated(value)
      where updated.value->>'id' = expectation->>'billId'
      limit 1
    ) as updated_bill on true
    where current_bill.status <> expectation->>'expectedStatus'
      or abs(current_bill.amount_due - coalesce((expectation->>'expectedAmountDue')::numeric, 0)) > 0.01
      or coalesce((expectation->>'settlementAmount')::numeric, 0) < 0
      or coalesce((expectation->>'intendedAmountDue')::numeric, 0) < 0
      or abs(current_bill.amount_due - coalesce((expectation->>'intendedAmountDue')::numeric, 0) - coalesce((expectation->>'settlementAmount')::numeric, 0)) > 0.01
      or updated_bill.value is null
      or abs(coalesce((updated_bill.value->>'amountPaid')::numeric, 0) - current_bill.amount_paid - coalesce((expectation->>'settlementAmount')::numeric, 0)) > 0.01
      or abs(coalesce((updated_bill.value->>'amountDue')::numeric, 0) - coalesce((expectation->>'intendedAmountDue')::numeric, 0)) > 0.01
      or (coalesce((updated_bill.value->>'amountDue')::numeric, 0) = 0 and updated_bill.value->>'status' <> 'issued')
      or (coalesce((updated_bill.value->>'amountDue')::numeric, 0) = 0 and nullif(updated_bill.value->>'settledAt', '') is null)
      or (coalesce((updated_bill.value->>'amountDue')::numeric, 0) > 0 and updated_bill.value->>'status' <> 'pending')
      or abs(
        coalesce((select sum((payment->>'amount')::numeric) from jsonb_array_elements(v_payments) as pay(payment) where pay.payment->>'billId' = expectation->>'billId'), 0)
        - coalesce((expectation->>'settlementAmount')::numeric, 0)
      ) > 0.01
  ) then
    perform public.raise_operational_rpc_error('settlement_conflict', 'A pending bill changed before checkout.', '{}'::jsonb);
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_inventory_deltas) as source(delta)
    join public.inventory_items as current_item
      on current_item.organization_id = v_organization_id and current_item.id = delta->>'itemId'
    where current_item.stock_qty + coalesce((delta->>'delta')::numeric, 0) < 0
      or current_item.stock_qty + coalesce((delta->>'delta')::numeric, 0) <
        coalesce((
          select sum(session_items.quantity * coalesce(session_items.stock_units_per_sale, session_items.sold_as_pack_of, 1))
          from public.session_items join public.sessions
            on sessions.organization_id = session_items.organization_id and sessions.id = session_items.session_id
          where session_items.organization_id = v_organization_id
            and session_items.inventory_item_id = delta->>'itemId'
            and sessions.status <> 'closed' and not (session_items.session_id = any(v_source_session_ids))
        ), 0)
        + coalesce((
          select sum(customer_tab_items.quantity * coalesce(customer_tab_items.stock_units_per_sale, customer_tab_items.sold_as_pack_of, 1))
          from public.customer_tab_items join public.customer_tabs
            on customer_tabs.organization_id = customer_tab_items.organization_id and customer_tabs.id = customer_tab_items.customer_tab_id
          where customer_tab_items.organization_id = v_organization_id
            and customer_tab_items.inventory_item_id = delta->>'itemId'
            and customer_tabs.status = 'open' and not (customer_tab_items.customer_tab_id = any(v_source_tab_ids))
        ), 0)
  ) then
    perform public.raise_operational_rpc_error('inventory_conflict', 'Current stock cannot satisfy this checkout and the remaining reservations.', '{}'::jsonb);
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_stock_movements) as source(movement)
    left join lateral (
      select value from jsonb_array_elements(v_inventory_deltas) as expected(value)
      where expected.value->>'itemId' = movement->>'itemId' limit 1
    ) as expected on true
    where movement->>'relatedBillId' <> v_bill_id
      or expected.value is null
      or coalesce((movement->>'quantity')::numeric, 0) = 0
      or coalesce((movement->>'quantity')::numeric, 0) * coalesce((expected.value->>'delta')::numeric, 0) <= 0
  ) or exists (
    select 1 from jsonb_array_elements(v_inventory_deltas) as expected(value)
    where abs(
      coalesce((expected.value->>'delta')::numeric, 0)
      - coalesce((select sum((movement->>'quantity')::numeric) from jsonb_array_elements(v_stock_movements) as move(movement) where move.movement->>'itemId' = expected.value->>'itemId'), 0)
    ) > 0.0001
  )
  then
    perform public.raise_operational_rpc_error('invalid_stock_movements', 'Stock movements do not match the server-derived checkout delta.', '{}'::jsonb);
  end if;

  insert into public.customers (organization_id, id, name, phone, first_seen_at, last_visit_at, raw_data)
  select
    v_organization_id, customer->>'id',
    coalesce(nullif(customer->>'name', ''), nullif(customer->>'phone', ''), 'Walk-in'),
    nullif(customer->>'phone', ''), nullif(customer->>'createdAt', '')::timestamptz,
    nullif(customer->>'lastVisitAt', '')::timestamptz, customer
  from jsonb_array_elements(v_customers) as source(customer)
  where customer ? 'id'
  on conflict (organization_id, id) do update set
    name = excluded.name, phone = excluded.phone,
    first_seen_at = coalesce(customers.first_seen_at, excluded.first_seen_at),
    last_visit_at = greatest(customers.last_visit_at, excluded.last_visit_at),
    raw_data = coalesce(customers.raw_data, '{}'::jsonb) || jsonb_build_object(
      'name', excluded.name, 'phone', excluded.phone, 'lastVisitAt', excluded.last_visit_at
    ),
    updated_at = timezone('utc', now());

  -- Persist financial rows and their server-generated audit evidence while the
  -- locked session/tab rows still contain the pre-checkout values. This keeps
  -- old-to-new forensic detail available without trusting client messages.
  begin
    perform public.apply_financial_v2_rows(
      v_organization_id, v_actor_user_id, v_started_at, v_mutation_kind, v_bill_id, v_bills,
      v_payments, v_stock_movements, v_audit_logs, v_sessions, v_customer_tabs
    );
  exception when unique_violation then
    perform public.raise_operational_rpc_error(
      'duplicate_financial_row',
      'A bill number or financial row was committed concurrently. Reconcile this mutation before retrying.',
      jsonb_build_object('bill_id', v_bill_id, 'bill_number', v_bill_number, 'mutation_id', v_mutation_id)
    );
  end;

  update public.sessions as target set
    started_at = coalesce(nullif(source.value->>'startedAt', '')::timestamptz, target.started_at),
    ended_at = nullif(source.value->>'endedAt', '')::timestamptz,
    status = 'closed', customer_id = nullif(source.value->>'customerId', ''),
    customer_name = nullif(source.value->>'customerName', ''),
    customer_phone = nullif(source.value->>'customerPhone', ''),
    ltp_outcome = nullif(source.value->>'ltpOutcome', ''),
    ltp_discount_applied = nullif(source.value->>'ltpDiscountApplied', '')::boolean,
    closed_bill_id = v_bill_id, close_disposition = 'billed',
    close_reason = nullif(source.value->>'closeReason', ''),
    raw_data = coalesce(target.raw_data, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'startedAt', source.value->>'startedAt', 'endedAt', source.value->>'endedAt',
      'status', 'closed', 'customerId', source.value->>'customerId',
      'customerName', source.value->>'customerName', 'customerPhone', source.value->>'customerPhone',
      'ltpOutcome', source.value->>'ltpOutcome', 'ltpDiscountApplied', source.value->'ltpDiscountApplied',
      'closedBillId', v_bill_id, 'closeDisposition', 'billed', 'closeReason', source.value->>'closeReason'
    )), updated_at = timezone('utc', now())
  from jsonb_array_elements(v_sessions) as source(value)
  where target.organization_id = v_organization_id and target.id = source.value->>'id';

  update public.customer_tabs as target set
    customer_id = nullif(source.value->>'customerId', ''),
    customer_name = coalesce(nullif(source.value->>'customerName', ''), target.customer_name),
    customer_phone = nullif(source.value->>'customerPhone', ''), status = 'closed',
    closed_at = nullif(source.value->>'closedAt', '')::timestamptz,
    closed_bill_id = v_bill_id, close_disposition = 'billed',
    close_reason = nullif(source.value->>'closeReason', ''),
    raw_data = coalesce(target.raw_data, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'customerId', source.value->>'customerId', 'customerName', source.value->>'customerName',
      'customerPhone', source.value->>'customerPhone', 'status', 'closed',
      'closedAt', source.value->>'closedAt', 'closedBillId', v_bill_id,
      'closeDisposition', 'billed', 'closeReason', source.value->>'closeReason'
    )), updated_at = timezone('utc', now())
  from jsonb_array_elements(v_customer_tabs) as source(value)
  where target.organization_id = v_organization_id and target.id = source.value->>'id';

  update public.inventory_items as target set
    stock_qty = target.stock_qty + (source.value->>'delta')::numeric,
    raw_data = jsonb_set(coalesce(target.raw_data, '{}'::jsonb), '{stockQty}', to_jsonb(target.stock_qty + (source.value->>'delta')::numeric), true),
    updated_at = timezone('utc', now())
  from jsonb_array_elements(v_inventory_deltas) as source(value)
  where target.organization_id = v_organization_id and target.id = source.value->>'itemId';

  v_changed_rows := jsonb_build_object(
    'bills', coalesce((select jsonb_agg(value->>'id') from jsonb_array_elements(v_bills)), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(value->>'id') from jsonb_array_elements(v_payments)), '[]'::jsonb),
    'stock_movements', coalesce((select jsonb_agg(value->>'id') from jsonb_array_elements(v_stock_movements)), '[]'::jsonb),
    'audit_logs', coalesce((select jsonb_agg(value->>'id') from jsonb_array_elements(v_audit_logs)), '[]'::jsonb),
    'sessions', to_jsonb(v_source_session_ids), 'customer_tabs', to_jsonb(v_source_tab_ids),
    'customers', coalesce((select jsonb_agg(value->>'id') from jsonb_array_elements(v_customers)), '[]'::jsonb),
    'inventory_items', coalesce((select jsonb_agg(value->>'itemId') from jsonb_array_elements(v_inventory_deltas)), '[]'::jsonb)
  );
  v_server_duration_ms := round((extract(epoch from (clock_timestamp() - v_started_at)) * 1000)::numeric, 3);

  insert into public.operational_events (organization_id, event_type, entity_type, entity_id, created_by, metadata)
  values (
    v_organization_id, 'financial_checkout_committed_v2', v_entity_type, v_entity_id, v_actor_user_id::text,
    jsonb_build_object(
      'mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind,
      'bill_id', v_bill_id, 'bill_number', v_bill_number,
      'client_created_at', v_client_created_at, 'server_duration_ms', v_server_duration_ms,
      'changed_rows', v_changed_rows
    )
  ) returning id into v_event_id;

  v_result := jsonb_build_object(
    'mutation_id', v_mutation_id, 'organization_id', v_organization_id,
    'entity_type', v_entity_type, 'entity_id', v_entity_id,
    'bill_id', v_bill_id, 'bill_number', v_bill_number,
    'event_id', v_event_id, 'server_time', timezone('utc', now()),
    'server_duration_ms', v_server_duration_ms, 'changed_rows', v_changed_rows,
    'canonical_bill', (
      select bill.raw_data
        || jsonb_build_object(
          'lineDiscounts', coalesce((
            select jsonb_agg(discount.raw_data order by discount.applied_at, discount.id)
            from public.bill_line_discounts as discount
            where discount.organization_id = v_organization_id and discount.bill_id = v_bill_id
          ), '[]'::jsonb)
        )
        || case when exists (
          select 1 from public.bill_discounts
          where organization_id = v_organization_id and bill_id = v_bill_id
        ) then jsonb_build_object(
          'billDiscount', (
            select discount.raw_data from public.bill_discounts as discount
            where discount.organization_id = v_organization_id and discount.bill_id = v_bill_id
            order by discount.applied_at, discount.id limit 1
          )
        ) else '{}'::jsonb end
      from public.bills as bill
      where bill.organization_id = v_organization_id and bill.id = v_bill_id
    ),
    'canonical_payments', coalesce((
      select jsonb_agg(raw_data order by paid_at, id)
      from public.payments where organization_id = v_organization_id and bill_id = v_bill_id
    ), '[]'::jsonb)
  );

  update public.financial_mutations set
    status = 'committed', canonical_result = v_result,
    committed_at = timezone('utc', now()), updated_at = timezone('utc', now())
  where organization_id = v_organization_id and mutation_id = v_mutation_id;

  return v_result;
end;
$$;

revoke all on function public.commit_checkout_bill_v2(jsonb) from public, anon;
grant execute on function public.commit_checkout_bill_v2(jsonb) to authenticated;

create or replace function public.commit_financial_adjustment_v2(payload jsonb)
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
  v_actor_user_id uuid := auth.uid();
  v_patch jsonb := coalesce(payload->'payload', '{}'::jsonb);
  v_bills jsonb := case when jsonb_typeof(v_patch->'bill_updates') = 'array' then v_patch->'bill_updates' else '[]'::jsonb end;
  v_payments jsonb := case when jsonb_typeof(v_patch->'payments') = 'array' then v_patch->'payments' else '[]'::jsonb end;
  v_stock_movements jsonb := case when jsonb_typeof(v_patch->'stock_movements') = 'array' then v_patch->'stock_movements' else '[]'::jsonb end;
  v_audit_logs jsonb := case when jsonb_typeof(v_patch->'audit_logs') = 'array' then v_patch->'audit_logs' else '[]'::jsonb end;
  v_bill_expectations jsonb := case when jsonb_typeof(v_patch->'bill_expectations') = 'array' then v_patch->'bill_expectations' else '[]'::jsonb end;
  v_inventory_expectations jsonb := case when jsonb_typeof(v_patch->'inventory_expectations') = 'array' then v_patch->'inventory_expectations' else '[]'::jsonb end;
  v_inventory_deltas jsonb := '[]'::jsonb;
  v_request_hash text := md5(payload::text);
  v_existing_mutation public.financial_mutations%rowtype;
  v_lock_id text;
  v_event_id text;
  v_server_duration_ms numeric;
  v_changed_rows jsonb;
  v_result jsonb;
begin
  if v_actor_user_id is null
    or v_organization_id is null
    or not public.current_user_has_org_access(v_organization_id)
  then
    perform public.raise_operational_rpc_error('organization_access_denied', 'You do not have access to this organization.', jsonb_build_object('organization_id', v_organization_id));
  end if;
  perform public.assert_financial_v2_actor_free(payload);

  if v_mutation_id is null
    or v_mutation_kind not in ('settlePendingBills', 'writeOffPendingBills', 'voidBill', 'refundBill')
    or v_entity_type not in ('bill', 'bill_group') or v_entity_id is null
    or jsonb_array_length(v_bills) = 0
  then
    perform public.raise_operational_rpc_error('invalid_payload', 'The v2 financial adjustment payload is incomplete.', '{}'::jsonb);
  end if;

  insert into public.financial_mutations (
    organization_id, mutation_id, mutation_kind, entity_type, entity_id,
    actor_user_id, request_hash, status
  ) values (
    v_organization_id, v_mutation_id, v_mutation_kind, v_entity_type, v_entity_id,
    v_actor_user_id, v_request_hash, 'processing'
  ) on conflict (organization_id, mutation_id) do nothing;

  select * into v_existing_mutation
  from public.financial_mutations
  where organization_id = v_organization_id and mutation_id = v_mutation_id
  for update;

  if v_existing_mutation.actor_user_id = v_actor_user_id
    and v_existing_mutation.mutation_kind = v_mutation_kind
    and v_existing_mutation.entity_type = v_entity_type
    and v_existing_mutation.entity_id = v_entity_id
    and v_existing_mutation.status = 'committed'
  then
    return v_existing_mutation.canonical_result;
  end if;

  if v_existing_mutation.actor_user_id <> v_actor_user_id
    or v_existing_mutation.mutation_kind <> v_mutation_kind
    or v_existing_mutation.entity_type <> v_entity_type
    or v_existing_mutation.entity_id <> v_entity_id
    or v_existing_mutation.request_hash <> v_request_hash
  then
    perform public.raise_operational_rpc_error('mutation_payload_mismatch', 'This mutation ID is already associated with a different financial adjustment.', jsonb_build_object('mutation_id', v_mutation_id));
  end if;
  if v_mutation_kind <> 'settlePendingBills'
    and public.current_user_org_role(v_organization_id) <> 'admin'::public.app_role
  then
    perform public.raise_operational_rpc_error('role_access_denied', 'Only an administrator can void, refund, or write off bills.', '{}'::jsonb);
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_bills) as source(value)
    where not exists (
      select 1 from jsonb_array_elements(v_bill_expectations) as expected(value)
      where expected.value->>'billId' = source.value->>'id'
    )
  ) or exists (
    select 1 from jsonb_array_elements(v_bill_expectations) as expected(value)
    where not exists (
      select 1 from jsonb_array_elements(v_bills) as source(value)
      where source.value->>'id' = expected.value->>'billId'
    )
  ) then
    perform public.raise_operational_rpc_error('invalid_bill_scope', 'Bill updates and expectations do not match.', '{}'::jsonb);
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_bills) as source(value)
    where nullif(source.value->>'id', '') is null
      or nullif(source.value->>'billNumber', '') is null
      or nullif(source.value->>'status', '') is null
      or source.value->>'status' not in ('issued', 'pending', 'voided', 'refunded')
      or jsonb_typeof(source.value->'amountPaid') is distinct from 'number'
      or jsonb_typeof(source.value->'amountDue') is distinct from 'number'
      or jsonb_typeof(source.value->'subtotal') is distinct from 'number'
      or jsonb_typeof(source.value->'totalDiscountAmount') is distinct from 'number'
      or jsonb_typeof(source.value->'billDiscountAmount') is distinct from 'number'
      or jsonb_typeof(source.value->'roundOffAmount') is distinct from 'number'
      or jsonb_typeof(source.value->'total') is distinct from 'number'
  ) or exists (
    select 1 from jsonb_array_elements(v_bills) as source(value)
    group by source.value->>'id'
    having count(*) <> 1
  ) or exists (
    select 1 from jsonb_array_elements(v_bill_expectations) as source(value)
    where nullif(source.value->>'billId', '') is null
      or nullif(source.value->>'expectedStatus', '') is null
      or source.value->>'expectedStatus' not in ('issued', 'pending', 'voided', 'refunded', 'replaced')
      or jsonb_typeof(source.value->'expectedAmountPaid') is distinct from 'number'
      or jsonb_typeof(source.value->'expectedAmountDue') is distinct from 'number'
      or (source.value->>'expectedAmountPaid')::numeric < 0
      or (source.value->>'expectedAmountDue')::numeric < 0
  ) or exists (
    select 1 from jsonb_array_elements(v_bill_expectations) as source(value)
    group by source.value->>'billId'
    having count(*) <> 1
  ) or exists (
    select 1 from jsonb_array_elements(v_payments) as source(value)
    where nullif(source.value->>'id', '') is null
      or nullif(source.value->>'billId', '') is null
      or nullif(source.value->>'mode', '') is null
      or source.value->>'mode' not in ('cash', 'upi')
  ) or exists (
    select 1 from jsonb_array_elements(v_payments) as source(value)
    group by source.value->>'id'
    having count(*) <> 1
  ) or (v_mutation_kind <> 'settlePendingBills' and jsonb_array_length(v_payments) <> 0)
    or exists (
      select 1 from jsonb_array_elements(v_stock_movements) as source(value)
      where nullif(source.value->>'id', '') is null
        or nullif(source.value->>'itemId', '') is null
        or nullif(source.value->>'type', '') is null
        or source.value->>'type' <> 'void_refund_reversal'
        or nullif(btrim(source.value->>'reason'), '') is null
    )
    or exists (
      select 1 from jsonb_array_elements(v_stock_movements) as source(value)
      group by source.value->>'id'
      having count(*) <> 1
    )
    or exists (
      select 1 from jsonb_array_elements(v_audit_logs) as source(value)
      where nullif(source.value->>'id', '') is null
        or nullif(source.value->>'action', '') is null
        or nullif(source.value->>'entityId', '') is null
        or nullif(btrim(source.value->>'message'), '') is null
    )
    or exists (
      select 1 from jsonb_array_elements(v_audit_logs) as source(value)
      group by source.value->>'id'
      having count(*) <> 1
    )
  then
    perform public.raise_operational_rpc_error('missing_financial_row_identity', 'Every adjustment row must have a unique server-persistable identity and allowed type.', '{}'::jsonb);
  end if;

  for v_lock_id in
    select distinct value->>'billId' from jsonb_array_elements(v_bill_expectations)
    where nullif(value->>'billId', '') is not null order by 1
  loop
    perform 1 from public.bills where organization_id = v_organization_id and id = v_lock_id for update;
    if not found then
      perform public.raise_operational_rpc_error('bill_not_found', 'A financial-adjustment bill no longer exists.', jsonb_build_object('bill_id', v_lock_id));
    end if;
  end loop;

  if v_mutation_kind in ('voidBill', 'refundBill') then
    select coalesce(jsonb_agg(jsonb_build_object('itemId', item_id, 'delta', delta) order by item_id), '[]'::jsonb)
    into v_inventory_deltas
    from (
      select lines.inventory_item_id as item_id,
        sum(lines.quantity * coalesce(lines.stock_units_per_sale, lines.sold_as_pack_of, 1)) as delta
      from public.bill_lines as lines
      join public.inventory_items
        on inventory_items.organization_id = lines.organization_id and inventory_items.id = lines.inventory_item_id
      where lines.organization_id = v_organization_id
        and lines.bill_id = any(array(select value->>'billId' from jsonb_array_elements(v_bill_expectations)))
        and lines.inventory_item_id is not null and not inventory_items.is_reusable
      group by lines.inventory_item_id
    ) as reversal;
  end if;

  for v_lock_id in
    select distinct value->>'itemId' from jsonb_array_elements(v_inventory_deltas)
    where nullif(value->>'itemId', '') is not null order by 1
  loop
    perform 1 from public.inventory_items where organization_id = v_organization_id and id = v_lock_id for update;
    if not found then
      perform public.raise_operational_rpc_error('inventory_item_not_found', 'An adjustment inventory item no longer exists.', jsonb_build_object('item_id', v_lock_id));
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(v_bill_expectations) as source(expectation)
    join public.bills as current_bill
      on current_bill.organization_id = v_organization_id and current_bill.id = expectation->>'billId'
    where current_bill.status is distinct from expectation->>'expectedStatus'
      or abs(current_bill.amount_paid - (expectation->>'expectedAmountPaid')::numeric) > 0.01
      or abs(current_bill.amount_due - (expectation->>'expectedAmountDue')::numeric) > 0.01
  ) then
    perform public.raise_operational_rpc_error('financial_adjustment_conflict', 'A bill changed before the financial adjustment was committed.', '{}'::jsonb);
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_bills) as source(updated_bill)
    join public.bills as current_bill
      on current_bill.organization_id = v_organization_id and current_bill.id = updated_bill->>'id'
    where updated_bill->>'billNumber' <> current_bill.bill_number
      or abs(coalesce((updated_bill->>'subtotal')::numeric, 0) - current_bill.subtotal) > 0.01
      or abs(coalesce((updated_bill->>'totalDiscountAmount')::numeric, 0) - current_bill.total_discount_amount) > 0.01
      or abs(coalesce((updated_bill->>'billDiscountAmount')::numeric, 0) - current_bill.bill_discount_amount) > 0.01
      or abs(coalesce((updated_bill->>'roundOffAmount')::numeric, 0) - current_bill.round_off_amount) > 0.01
      or abs(coalesce((updated_bill->>'total')::numeric, 0) - current_bill.total) > 0.01
      or coalesce((updated_bill->>'amountPaid')::numeric, 0) < 0
      or coalesce((updated_bill->>'amountDue')::numeric, 0) < 0
      or abs(coalesce((updated_bill->>'amountPaid')::numeric, 0) + coalesce((updated_bill->>'amountDue')::numeric, 0) - current_bill.total) > 0.01
      or (v_mutation_kind <> 'settlePendingBills' and (
        abs(coalesce((updated_bill->>'amountPaid')::numeric, 0) - current_bill.amount_paid) > 0.01
        or abs(coalesce((updated_bill->>'amountDue')::numeric, 0) - current_bill.amount_due) > 0.01
      ))
  ) then
    perform public.raise_operational_rpc_error('immutable_bill_mismatch', 'The adjustment attempted to change immutable bill financial data.', '{}'::jsonb);
  end if;

  if (v_mutation_kind in ('settlePendingBills', 'writeOffPendingBills') and exists (
      select 1 from jsonb_array_elements(v_bill_expectations) as source(value)
      where value->>'expectedStatus' is distinct from 'pending'
    ))
    or (v_mutation_kind in ('voidBill', 'refundBill') and exists (
      select 1 from jsonb_array_elements(v_bill_expectations) as source(value)
      where value->>'expectedStatus' is distinct from 'issued'
    ))
    or (v_mutation_kind = 'writeOffPendingBills' and exists (
      select 1 from jsonb_array_elements(v_bills) as source(value) where value->>'status' is distinct from 'voided'
    ))
    or (v_mutation_kind = 'voidBill' and exists (
      select 1 from jsonb_array_elements(v_bills) as source(value) where value->>'status' is distinct from 'voided'
    ))
    or (v_mutation_kind = 'refundBill' and exists (
      select 1 from jsonb_array_elements(v_bills) as source(value) where value->>'status' is distinct from 'refunded'
    ))
    or (v_mutation_kind = 'settlePendingBills' and exists (
      select 1 from jsonb_array_elements(v_bills) as source(value)
      where value->>'status' not in ('pending', 'issued')
        or (coalesce((value->>'amountDue')::numeric, 0) > 0.01 and value->>'status' is distinct from 'pending')
        or (coalesce((value->>'amountDue')::numeric, 0) <= 0.01 and value->>'status' is distinct from 'issued')
        or (coalesce((value->>'amountDue')::numeric, 0) <= 0.01 and nullif(value->>'settledAt', '') is null)
    ))
  then
    perform public.raise_operational_rpc_error('invalid_status_transition', 'The requested bill status transition is invalid.', '{}'::jsonb);
  end if;

  if v_mutation_kind in ('writeOffPendingBills', 'voidBill', 'refundBill') and exists (
    select 1 from jsonb_array_elements(v_bills) as source(value)
    where nullif(btrim(value->>'voidReason'), '') is null
      or nullif(value->>'voidedAt', '') is null
      or (value->>'voidedAt')::timestamptz > timezone('utc', now()) + interval '1 minute'
  ) then
    perform public.raise_operational_rpc_error('invalid_void_evidence', 'Void, refund, and write-off operations require a reason and valid timestamp.', '{}'::jsonb);
  end if;

  if v_mutation_kind = 'settlePendingBills' and exists (
    select 1
    from jsonb_array_elements(v_bills) as source(updated_bill)
    join jsonb_array_elements(v_bill_expectations) as expected(value)
      on expected.value->>'billId' = updated_bill->>'id'
    where coalesce((updated_bill->>'amountPaid')::numeric, 0) < coalesce((expected.value->>'expectedAmountPaid')::numeric, 0)
      or coalesce((updated_bill->>'amountDue')::numeric, 0) < 0
      or abs(
        coalesce((updated_bill->>'amountPaid')::numeric, 0) - coalesce((expected.value->>'expectedAmountPaid')::numeric, 0)
        - coalesce((select sum((payment->>'amount')::numeric) from jsonb_array_elements(v_payments) as pay(payment) where pay.payment->>'billId' = updated_bill->>'id'), 0)
      ) > 0.01
      or abs(
        coalesce((expected.value->>'expectedAmountDue')::numeric, 0) - coalesce((updated_bill->>'amountDue')::numeric, 0)
        - coalesce((select sum((payment->>'amount')::numeric) from jsonb_array_elements(v_payments) as pay(payment) where pay.payment->>'billId' = updated_bill->>'id'), 0)
      ) > 0.01
  ) then
    perform public.raise_operational_rpc_error('settlement_totals_mismatch', 'Settlement payments do not reconcile to the bill changes.', '{}'::jsonb);
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_payments) as source(value)
    where coalesce((value->>'amount')::numeric, 0) <= 0
      or not exists (select 1 from jsonb_array_elements(v_bills) as bill(value) where bill.value->>'id' = source.value->>'billId')
  ) then
    perform public.raise_operational_rpc_error('invalid_payments', 'The adjustment contains an invalid or unrelated payment.', '{}'::jsonb);
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_payments) as source(value)
    where nullif(value->>'relatedCheckoutBillId', '') is not null
      or (
        jsonb_array_length(v_bills) = 1 and nullif(value->>'settlementGroupId', '') is not null
      )
      or (
        jsonb_array_length(v_bills) > 1 and nullif(value->>'settlementGroupId', '') is null
      )
  ) or (
    jsonb_array_length(v_bills) > 1 and jsonb_array_length(v_payments) > 0
    and (select count(distinct value->>'settlementGroupId') from jsonb_array_elements(v_payments) as source(value)) <> 1
  ) then
    perform public.raise_operational_rpc_error('invalid_settlement_linkage', 'Adjustment payment linkage or settlement grouping is invalid.', '{}'::jsonb);
  end if;

  if jsonb_array_length(v_audit_logs) <> jsonb_array_length(v_bills) or exists (
    select 1 from jsonb_array_elements(v_bills) as bill(value)
    where (
      select count(*) from jsonb_array_elements(v_audit_logs) as audit(value)
      where audit.value->>'entityType' = 'bill'
        and audit.value->>'entityId' = bill.value->>'id'
        and audit.value->>'action' = case v_mutation_kind
          when 'settlePendingBills' then 'bill_settled'
          when 'writeOffPendingBills' then 'bill_voided_bad_debt'
          when 'voidBill' then 'bill_voided'
          when 'refundBill' then 'bill_refunded'
        end
    ) <> 1
  ) or exists (
    select 1 from jsonb_array_elements(v_audit_logs) as audit(value)
    where audit.value->>'entityType' <> 'bill'
      or audit.value->>'action' is distinct from case v_mutation_kind
        when 'settlePendingBills' then 'bill_settled'
        when 'writeOffPendingBills' then 'bill_voided_bad_debt'
        when 'voidBill' then 'bill_voided'
        when 'refundBill' then 'bill_refunded'
      end
      or not exists (select 1 from jsonb_array_elements(v_bills) as bill(value) where bill.value->>'id' = audit.value->>'entityId')
  ) then
    perform public.raise_operational_rpc_error('invalid_audit_scope', 'The financial adjustment is missing its required bill audit or contains unrelated audit rows.', '{}'::jsonb);
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_inventory_deltas) as source(delta)
    join public.inventory_items as current_item
      on current_item.organization_id = v_organization_id and current_item.id = delta->>'itemId'
    where current_item.stock_qty + coalesce((delta->>'delta')::numeric, 0) < 0
      or abs(
        coalesce((delta->>'delta')::numeric, 0)
        - coalesce((select sum((movement->>'quantity')::numeric) from jsonb_array_elements(v_stock_movements) as move(movement) where move.movement->>'itemId' = delta->>'itemId'), 0)
      ) > 0.0001
  ) or exists (
    select 1 from jsonb_array_elements(v_stock_movements) as source(value)
    where not exists (select 1 from jsonb_array_elements(v_inventory_deltas) as expected(value) where expected.value->>'itemId' = source.value->>'itemId')
      or not exists (select 1 from jsonb_array_elements(v_bills) as bill(value) where bill.value->>'id' = source.value->>'relatedBillId')
      or coalesce((source.value->>'quantity')::numeric, 0) <= 0
  ) or (v_mutation_kind not in ('voidBill', 'refundBill') and jsonb_array_length(v_stock_movements) <> 0)
  then
    perform public.raise_operational_rpc_error('invalid_stock_movements', 'Adjustment stock movements do not match the server-derived reversal.', '{}'::jsonb);
  end if;

  update public.inventory_items as target set
    stock_qty = target.stock_qty + (source.value->>'delta')::numeric,
    raw_data = jsonb_set(coalesce(target.raw_data, '{}'::jsonb), '{stockQty}', to_jsonb(target.stock_qty + (source.value->>'delta')::numeric), true),
    updated_at = timezone('utc', now())
  from jsonb_array_elements(v_inventory_deltas) as source(value)
  where target.organization_id = v_organization_id and target.id = source.value->>'itemId';

  begin
    perform public.apply_financial_v2_rows(
      v_organization_id, v_actor_user_id, v_started_at, v_mutation_kind, null, v_bills,
      v_payments, v_stock_movements, v_audit_logs, '[]'::jsonb, '[]'::jsonb
    );
  exception when unique_violation then
    perform public.raise_operational_rpc_error(
      'duplicate_financial_row',
      'A financial row was committed concurrently. Reconcile this mutation before retrying.',
      jsonb_build_object('mutation_id', v_mutation_id)
    );
  end;

  v_changed_rows := jsonb_build_object(
    'bills', coalesce((select jsonb_agg(value->>'id') from jsonb_array_elements(v_bills)), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(value->>'id') from jsonb_array_elements(v_payments)), '[]'::jsonb),
    'stock_movements', coalesce((select jsonb_agg(value->>'id') from jsonb_array_elements(v_stock_movements)), '[]'::jsonb),
    'audit_logs', coalesce((select jsonb_agg(value->>'id') from jsonb_array_elements(v_audit_logs)), '[]'::jsonb),
    'inventory_items', coalesce((select jsonb_agg(value->>'itemId') from jsonb_array_elements(v_inventory_deltas)), '[]'::jsonb)
  );
  v_server_duration_ms := round((extract(epoch from (clock_timestamp() - v_started_at)) * 1000)::numeric, 3);

  insert into public.operational_events (organization_id, event_type, entity_type, entity_id, created_by, metadata)
  values (
    v_organization_id, 'financial_adjustment_committed_v2', v_entity_type, v_entity_id, v_actor_user_id::text,
    jsonb_build_object(
      'mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind,
      'server_duration_ms', v_server_duration_ms, 'changed_rows', v_changed_rows
    )
  ) returning id into v_event_id;

  v_result := jsonb_build_object(
    'mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind,
    'organization_id', v_organization_id, 'entity_type', v_entity_type,
    'entity_id', v_entity_id, 'event_id', v_event_id,
    'server_time', timezone('utc', now()), 'server_duration_ms', v_server_duration_ms,
    'changed_rows', v_changed_rows
  );

  update public.financial_mutations set
    status = 'committed', canonical_result = v_result,
    committed_at = timezone('utc', now()), updated_at = timezone('utc', now())
  where organization_id = v_organization_id and mutation_id = v_mutation_id;

  return v_result;
end;
$$;

revoke all on function public.commit_financial_adjustment_v2(jsonb) from public, anon;
grant execute on function public.commit_financial_adjustment_v2(jsonb) to authenticated;
