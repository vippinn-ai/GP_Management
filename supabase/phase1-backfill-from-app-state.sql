-- Phase 1 shadow backfill from public.app_state into normalized tables.
-- Run only after supabase/phase1-normalized-schema.sql.
-- This resets and repopulates the default shadow organization from app_state.
-- Do not run this after normalized tables become the production source of truth.

do $$
begin
  if not exists (select 1 from public.app_state where id = 'primary') then
    raise exception 'public.app_state primary row does not exist';
  end if;
end
$$;

delete from public.organizations where id = 'org-primary';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
insert into public.organizations (id, name, business_profile, active)
select
  'org-primary',
  coalesce(nullif(data #>> '{businessProfile,name}', ''), 'BreakPerfect Gaming Lounge'),
  coalesce(data->'businessProfile', '{}'::jsonb),
  true
from state;

insert into public.organization_members (organization_id, user_id, role, active)
select
  'org-primary',
  profiles.id,
  profiles.role,
  profiles.active
from public.profiles
on conflict (organization_id, user_id) do update
set
  role = excluded.role,
  active = excluded.active;

with state as (
  select data
  from public.app_state
  where id = 'primary'
),
categories as (
  select distinct nullif(trim(category_name), '') as name
  from state
  cross join lateral jsonb_array_elements_text(coalesce(data->'inventoryCategories', '[]'::jsonb)) as category_values(category_name)
  union
  select distinct nullif(trim(item->>'category'), '') as name
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
)
insert into public.inventory_categories (organization_id, id, name)
select
  'org-primary',
  'category-' || md5(name),
  name
from categories
where name is not null
on conflict (organization_id, id) do update
set name = excluded.name;

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
insert into public.stations (organization_id, id, name, mode, active, ltp_enabled, notes, raw_data)
select
  'org-primary',
  station->>'id',
  coalesce(nullif(station->>'name', ''), 'Unnamed station'),
  coalesce(nullif(station->>'mode', ''), 'timed'),
  coalesce(nullif(station->>'active', '')::boolean, true),
  coalesce(nullif(station->>'ltpEnabled', '')::boolean, false),
  nullif(station->>'notes', ''),
  station
from state
cross join lateral jsonb_array_elements(coalesce(data->'stations', '[]'::jsonb)) as station
where station ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
insert into public.pricing_rules (
  organization_id,
  id,
  station_id,
  label,
  start_minute,
  end_minute,
  hourly_rate,
  raw_data
)
select
  'org-primary',
  rule->>'id',
  nullif(rule->>'stationId', ''),
  coalesce(nullif(rule->>'label', ''), 'Pricing rule'),
  coalesce(nullif(rule->>'startMinute', '')::integer, 0),
  coalesce(nullif(rule->>'endMinute', '')::integer, 0),
  coalesce(nullif(rule->>'hourlyRate', '')::numeric, 0),
  rule
from state
cross join lateral jsonb_array_elements(coalesce(data->'pricingRules', '[]'::jsonb)) as rule
where rule ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
  customer->>'id',
  coalesce(nullif(customer->>'name', ''), 'Walk-in customer'),
  nullif(customer->>'phone', ''),
  nullif(customer->>'createdAt', '')::timestamptz,
  nullif(customer->>'lastVisitAt', '')::timestamptz,
  nullif(customer->>'notes', ''),
  customer
from state
cross join lateral jsonb_array_elements(coalesce(data->'customers', '[]'::jsonb)) as customer
where customer ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
  item->>'id',
  coalesce(nullif(item->>'name', ''), 'Unnamed item'),
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
from state
cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
where item ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
insert into public.sale_variants (
  organization_id,
  inventory_item_id,
  id,
  name,
  price,
  stock_units_per_sale,
  barcode,
  active,
  raw_data
)
select
  'org-primary',
  item->>'id',
  variant->>'id',
  coalesce(nullif(variant->>'name', ''), 'Unnamed variant'),
  coalesce(nullif(variant->>'price', '')::numeric, 0),
  coalesce(nullif(variant->>'stockUnitsPerSale', '')::numeric, 1),
  nullif(variant->>'barcode', ''),
  coalesce(nullif(variant->>'active', '')::boolean, true),
  variant
from state
cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
cross join lateral jsonb_array_elements(coalesce(item->'saleVariants', '[]'::jsonb)) as variant
where item ? 'id'
  and variant ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
insert into public.combos (
  organization_id,
  id,
  name,
  type,
  active,
  price,
  included_minutes,
  raw_data,
  created_at,
  updated_at
)
select
  'org-primary',
  combo->>'id',
  coalesce(nullif(combo->>'name', ''), 'Unnamed combo'),
  coalesce(nullif(combo->>'type', ''), 'game'),
  coalesce(nullif(combo->>'active', '')::boolean, true),
  coalesce(nullif(combo->>'price', '')::numeric, 0),
  coalesce(nullif(combo->>'includedMinutes', '')::integer, 0),
  combo,
  coalesce(nullif(combo->>'createdAt', '')::timestamptz, timezone('utc', now())),
  coalesce(nullif(combo->>'updatedAt', '')::timestamptz, timezone('utc', now()))
from state
cross join lateral jsonb_array_elements(coalesce(data->'combos', '[]'::jsonb)) as combo
where combo ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
insert into public.combo_station_targets (organization_id, combo_id, station_id)
select
  'org-primary',
  combo->>'id',
  station_id
from state
cross join lateral jsonb_array_elements(coalesce(data->'combos', '[]'::jsonb)) as combo
cross join lateral jsonb_array_elements_text(coalesce(combo->'stationIds', '[]'::jsonb)) as station_values(station_id)
where combo ? 'id'
  and nullif(station_id, '') is not null;

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
insert into public.combo_fixed_items (organization_id, combo_id, id, sellable_option_id, quantity, raw_data)
select
  'org-primary',
  combo->>'id',
  fixed_item->>'id',
  coalesce(nullif(fixed_item->>'sellableOptionId', ''), ''),
  coalesce(nullif(fixed_item->>'quantity', '')::numeric, 1),
  fixed_item
from state
cross join lateral jsonb_array_elements(coalesce(data->'combos', '[]'::jsonb)) as combo
cross join lateral jsonb_array_elements(coalesce(combo->'fixedItems', '[]'::jsonb)) as fixed_item
where combo ? 'id'
  and fixed_item ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
insert into public.combo_choice_groups (organization_id, combo_id, id, label, required_quantity, raw_data)
select
  'org-primary',
  combo->>'id',
  choice_group->>'id',
  coalesce(nullif(choice_group->>'label', ''), 'Choice group'),
  coalesce(nullif(choice_group->>'requiredQuantity', '')::integer, 1),
  choice_group
from state
cross join lateral jsonb_array_elements(coalesce(data->'combos', '[]'::jsonb)) as combo
cross join lateral jsonb_array_elements(coalesce(combo->'choiceGroups', '[]'::jsonb)) as choice_group
where combo ? 'id'
  and choice_group ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
insert into public.combo_choice_options (organization_id, combo_id, choice_group_id, option_id)
select
  'org-primary',
  combo->>'id',
  choice_group->>'id',
  option_id
from state
cross join lateral jsonb_array_elements(coalesce(data->'combos', '[]'::jsonb)) as combo
cross join lateral jsonb_array_elements(coalesce(combo->'choiceGroups', '[]'::jsonb)) as choice_group
cross join lateral jsonb_array_elements_text(coalesce(choice_group->'optionIds', '[]'::jsonb)) as option_values(option_id)
where combo ? 'id'
  and choice_group ? 'id'
  and nullif(option_id, '') is not null;

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
  session->>'id',
  nullif(session->>'stationId', ''),
  nullif(session->>'stationNameSnapshot', ''),
  coalesce(nullif(session->>'mode', ''), 'timed'),
  nullif(session->>'startedAt', '')::timestamptz,
  nullif(session->>'endedAt', '')::timestamptz,
  coalesce(nullif(session->>'status', ''), 'active'),
  nullif(session->>'customerId', ''),
  nullif(session->>'customerName', ''),
  nullif(session->>'customerPhone', ''),
  coalesce(nullif(session->>'playMode', ''), 'group'),
  coalesce(nullif(session->>'ltpEligible', '')::boolean, false),
  nullif(session->>'ltpOutcome', ''),
  nullif(session->>'ltpDiscountApplied', '')::boolean,
  coalesce(session->'pricingSnapshot', '[]'::jsonb),
  coalesce(session->'pauseLogIds', '[]'::jsonb),
  session->'continuedFromSessionIds',
  nullif(session->>'closedBillId', ''),
  nullif(session->>'closeDisposition', ''),
  nullif(session->>'closeReason', ''),
  session
from state
cross join lateral jsonb_array_elements(coalesce(data->'sessions', '[]'::jsonb)) as session
where session ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
insert into public.session_pause_logs (organization_id, id, session_id, paused_at, resumed_at, raw_data)
select
  'org-primary',
  pause_log->>'id',
  nullif(pause_log->>'sessionId', ''),
  nullif(pause_log->>'pausedAt', '')::timestamptz,
  nullif(pause_log->>'resumedAt', '')::timestamptz,
  pause_log
from state
cross join lateral jsonb_array_elements(coalesce(data->'sessionPauseLogs', '[]'::jsonb)) as pause_log
where pause_log ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
  session->>'id',
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
from state
cross join lateral jsonb_array_elements(coalesce(data->'sessions', '[]'::jsonb)) as session
cross join lateral jsonb_array_elements(coalesce(session->'items', '[]'::jsonb)) as item
where session ? 'id'
  and item ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
  session->>'id',
  combo_app->>'id',
  nullif(combo_app->>'comboId', ''),
  coalesce(nullif(combo_app->>'comboName', ''), 'Combo'),
  coalesce(nullif(combo_app->>'price', '')::numeric, 0),
  coalesce(nullif(combo_app->>'includedMinutes', '')::integer, 0),
  nullif(combo_app->>'appliedAt', '')::timestamptz,
  coalesce(combo_app->'fixedItems', '[]'::jsonb),
  coalesce(combo_app->'choices', '[]'::jsonb),
  combo_app
from state
cross join lateral jsonb_array_elements(coalesce(data->'sessions', '[]'::jsonb)) as session
cross join lateral jsonb_array_elements(coalesce(session->'comboApplications', '[]'::jsonb)) as combo_app
where session ? 'id'
  and combo_app ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
  tab->>'id',
  nullif(tab->>'customerId', ''),
  coalesce(nullif(tab->>'customerName', ''), 'Walk-in customer'),
  nullif(tab->>'customerPhone', ''),
  coalesce(nullif(tab->>'status', ''), 'open'),
  nullif(tab->>'createdAt', '')::timestamptz,
  nullif(tab->>'closedAt', '')::timestamptz,
  tab->'continuedFromSessionIds',
  nullif(tab->>'closedBillId', ''),
  nullif(tab->>'closeDisposition', ''),
  nullif(tab->>'closeReason', ''),
  tab
from state
cross join lateral jsonb_array_elements(coalesce(data->'customerTabs', '[]'::jsonb)) as tab
where tab ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
  tab->>'id',
  item->>'id',
  nullif(item->>'inventoryItemId', ''),
  coalesce(nullif(item->>'name', ''), 'Tab item'),
  coalesce(nullif(item->>'quantity', '')::numeric, 0),
  coalesce(nullif(item->>'unitPrice', '')::numeric, 0),
  nullif(item->>'addedAt', '')::timestamptz,
  nullif(item->>'soldAsPackOf', '')::numeric,
  nullif(item->>'saleVariantId', ''),
  nullif(item->>'stockUnitsPerSale', '')::numeric,
  nullif(item->>'comboApplicationId', ''),
  nullif(item->>'comboId', ''),
  item
from state
cross join lateral jsonb_array_elements(coalesce(data->'customerTabs', '[]'::jsonb)) as tab
cross join lateral jsonb_array_elements(coalesce(tab->'items', '[]'::jsonb)) as item
where tab ? 'id'
  and item ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
select
  'org-primary',
  tab->>'id',
  combo_app->>'id',
  nullif(combo_app->>'comboId', ''),
  coalesce(nullif(combo_app->>'comboName', ''), 'Combo'),
  coalesce(nullif(combo_app->>'price', '')::numeric, 0),
  coalesce(nullif(combo_app->>'includedMinutes', '')::integer, 0),
  nullif(combo_app->>'appliedAt', '')::timestamptz,
  coalesce(combo_app->'fixedItems', '[]'::jsonb),
  coalesce(combo_app->'choices', '[]'::jsonb),
  combo_app
from state
cross join lateral jsonb_array_elements(coalesce(data->'customerTabs', '[]'::jsonb)) as tab
cross join lateral jsonb_array_elements(coalesce(tab->'comboApplications', '[]'::jsonb)) as combo_app
where tab ? 'id'
  and combo_app ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
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
from state
cross join lateral jsonb_array_elements(coalesce(data->'bills', '[]'::jsonb)) as bill
where bill ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
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
from state
cross join lateral jsonb_array_elements(coalesce(data->'bills', '[]'::jsonb)) as bill
cross join lateral jsonb_array_elements(coalesce(bill->'lines', '[]'::jsonb)) as line
where bill ? 'id'
  and line ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
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
from state
cross join lateral jsonb_array_elements(coalesce(data->'bills', '[]'::jsonb)) as bill
cross join lateral jsonb_array_elements(coalesce(bill->'lineDiscounts', '[]'::jsonb)) as discount
where bill ? 'id'
  and discount ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
  bill->>'id',
  bill->'billDiscount'->>'id',
  nullif(bill->'billDiscount'->>'type', ''),
  coalesce(nullif(bill->'billDiscount'->>'value', '')::numeric, 0),
  coalesce(nullif(bill->'billDiscount'->>'amount', '')::numeric, 0),
  nullif(bill->'billDiscount'->>'reason', ''),
  nullif(bill->'billDiscount'->>'appliedByUserId', ''),
  nullif(bill->'billDiscount'->>'appliedAt', '')::timestamptz,
  bill->'billDiscount'
from state
cross join lateral jsonb_array_elements(coalesce(data->'bills', '[]'::jsonb)) as bill
where bill ? 'id'
  and jsonb_typeof(bill->'billDiscount') = 'object'
  and bill->'billDiscount' ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
  payment->>'id',
  nullif(payment->>'billId', ''),
  coalesce(nullif(payment->>'mode', ''), 'cash'),
  coalesce(nullif(payment->>'amount', '')::numeric, 0),
  nullif(payment->>'createdAt', '')::timestamptz,
  nullif(payment->>'receivedByUserId', ''),
  nullif(payment->>'settlementGroupId', ''),
  nullif(payment->>'relatedCheckoutBillId', ''),
  payment
from state
cross join lateral jsonb_array_elements(coalesce(data->'payments', '[]'::jsonb)) as payment
where payment ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
  movement->>'id',
  nullif(movement->>'itemId', ''),
  coalesce(nullif(movement->>'type', ''), 'adjustment'),
  coalesce(nullif(movement->>'quantity', '')::numeric, 0),
  nullif(movement->>'reason', ''),
  nullif(movement->>'createdAt', '')::timestamptz,
  nullif(movement->>'userId', ''),
  nullif(movement->>'relatedBillId', ''),
  movement
from state
cross join lateral jsonb_array_elements(coalesce(data->'stockMovements', '[]'::jsonb)) as movement
where movement ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
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
  'org-primary',
  audit->>'id',
  coalesce(nullif(audit->>'action', ''), 'unknown'),
  nullif(audit->>'entityType', ''),
  nullif(audit->>'entityId', ''),
  nullif(audit->>'message', ''),
  nullif(audit->>'createdAt', '')::timestamptz,
  nullif(audit->>'userId', ''),
  audit
from state
cross join lateral jsonb_array_elements(coalesce(data->'auditLogs', '[]'::jsonb)) as audit
where audit ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
insert into public.expenses (
  organization_id,
  id,
  title,
  category,
  amount,
  payment_mode,
  cash_amount,
  upi_amount,
  spent_at,
  notes,
  created_by_user_id,
  raw_data
)
select
  'org-primary',
  expense->>'id',
  coalesce(nullif(expense->>'title', ''), 'Expense'),
  nullif(expense->>'category', ''),
  coalesce(nullif(expense->>'amount', '')::numeric, 0),
  nullif(expense->>'paymentMode', ''),
  nullif(expense->>'cashAmount', '')::numeric,
  nullif(expense->>'upiAmount', '')::numeric,
  nullif(expense->>'spentAt', '')::timestamptz,
  nullif(expense->>'notes', ''),
  nullif(expense->>'createdByUserId', ''),
  expense
from state
cross join lateral jsonb_array_elements(coalesce(data->'expenses', '[]'::jsonb)) as expense
where expense ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
insert into public.expense_templates (
  organization_id,
  id,
  title,
  category,
  amount,
  frequency,
  start_month,
  active,
  notes,
  created_by_user_id,
  raw_data
)
select
  'org-primary',
  template->>'id',
  coalesce(nullif(template->>'title', ''), 'Expense template'),
  nullif(template->>'category', ''),
  coalesce(nullif(template->>'amount', '')::numeric, 0),
  coalesce(nullif(template->>'frequency', ''), 'monthly'),
  nullif(template->>'startMonth', ''),
  coalesce(nullif(template->>'active', '')::boolean, true),
  nullif(template->>'notes', ''),
  nullif(template->>'createdByUserId', ''),
  template
from state
cross join lateral jsonb_array_elements(coalesce(data->'expenseTemplates', '[]'::jsonb)) as template
where template ? 'id';

with state as (
  select data
  from public.app_state
  where id = 'primary'
)
insert into public.expense_template_overrides (
  organization_id,
  id,
  template_id,
  month_key,
  amount,
  skip_reason,
  notes,
  created_by_user_id,
  updated_at_source,
  raw_data
)
select
  'org-primary',
  override_row->>'id',
  nullif(override_row->>'templateId', ''),
  nullif(override_row->>'monthKey', ''),
  nullif(override_row->>'amount', '')::numeric,
  nullif(override_row->>'skipReason', ''),
  nullif(override_row->>'notes', ''),
  nullif(override_row->>'createdByUserId', ''),
  nullif(override_row->>'updatedAt', '')::timestamptz,
  override_row
from state
cross join lateral jsonb_array_elements(coalesce(data->'expenseTemplateOverrides', '[]'::jsonb)) as override_row
where override_row ? 'id';
