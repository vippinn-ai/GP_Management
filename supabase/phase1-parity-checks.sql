-- Phase 1 parity checks.
-- Run after phase1-normalized-schema.sql and phase1-backfill-from-app-state.sql.
-- Every row in the first result set should have delta = 0 before considering any read cutover.

with state as (
  select data
  from public.app_state
  where id = 'primary'
),
app_counts as (
  select 'inventory_categories' as collection, count(*)::bigint as app_count
  from (
    select distinct nullif(trim(category_name), '') as name
    from state
    cross join lateral jsonb_array_elements_text(coalesce(data->'inventoryCategories', '[]'::jsonb)) as category_values(category_name)
    union
    select distinct nullif(trim(item->>'category'), '') as name
    from state
    cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
  ) categories
  where name is not null
  union all
  select 'stations', jsonb_array_length(coalesce(data->'stations', '[]'::jsonb)) from state
  union all
  select 'pricing_rules', jsonb_array_length(coalesce(data->'pricingRules', '[]'::jsonb)) from state
  union all
  select 'customers', count(distinct customer->>'id')::bigint
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'customers', '[]'::jsonb)) as customer
  where customer ? 'id'
  union all
  select 'inventory_items', jsonb_array_length(coalesce(data->'inventoryItems', '[]'::jsonb)) from state
  union all
  select 'sale_variants', coalesce(sum(jsonb_array_length(coalesce(item->'saleVariants', '[]'::jsonb))), 0)::bigint
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
  union all
  select 'combos', jsonb_array_length(coalesce(data->'combos', '[]'::jsonb)) from state
  union all
  select 'combo_station_targets', coalesce(sum(jsonb_array_length(coalesce(combo->'stationIds', '[]'::jsonb))), 0)::bigint
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'combos', '[]'::jsonb)) as combo
  union all
  select 'combo_fixed_items', coalesce(sum(jsonb_array_length(coalesce(combo->'fixedItems', '[]'::jsonb))), 0)::bigint
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'combos', '[]'::jsonb)) as combo
  union all
  select 'combo_choice_groups', coalesce(sum(jsonb_array_length(coalesce(combo->'choiceGroups', '[]'::jsonb))), 0)::bigint
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'combos', '[]'::jsonb)) as combo
  union all
  select 'combo_choice_options', coalesce(sum(jsonb_array_length(coalesce(choice_group->'optionIds', '[]'::jsonb))), 0)::bigint
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'combos', '[]'::jsonb)) as combo
  cross join lateral jsonb_array_elements(coalesce(combo->'choiceGroups', '[]'::jsonb)) as choice_group
  union all
  select 'sessions', jsonb_array_length(coalesce(data->'sessions', '[]'::jsonb)) from state
  union all
  select 'session_pause_logs', jsonb_array_length(coalesce(data->'sessionPauseLogs', '[]'::jsonb)) from state
  union all
  select 'session_items', coalesce(sum(jsonb_array_length(coalesce(session->'items', '[]'::jsonb))), 0)::bigint
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'sessions', '[]'::jsonb)) as session
  union all
  select 'session_combo_applications', coalesce(sum(jsonb_array_length(coalesce(session->'comboApplications', '[]'::jsonb))), 0)::bigint
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'sessions', '[]'::jsonb)) as session
  union all
  select 'customer_tabs', jsonb_array_length(coalesce(data->'customerTabs', '[]'::jsonb)) from state
  union all
  select 'customer_tab_items', coalesce(sum(jsonb_array_length(coalesce(tab->'items', '[]'::jsonb))), 0)::bigint
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'customerTabs', '[]'::jsonb)) as tab
  union all
  select 'customer_tab_combo_applications', coalesce(sum(jsonb_array_length(coalesce(tab->'comboApplications', '[]'::jsonb))), 0)::bigint
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'customerTabs', '[]'::jsonb)) as tab
  union all
  select 'bills', jsonb_array_length(coalesce(data->'bills', '[]'::jsonb)) from state
  union all
  select 'bill_lines', coalesce(sum(jsonb_array_length(coalesce(bill->'lines', '[]'::jsonb))), 0)::bigint
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'bills', '[]'::jsonb)) as bill
  union all
  select 'bill_line_discounts', coalesce(sum(jsonb_array_length(coalesce(bill->'lineDiscounts', '[]'::jsonb))), 0)::bigint
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'bills', '[]'::jsonb)) as bill
  union all
  select 'bill_discounts', count(*)::bigint
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'bills', '[]'::jsonb)) as bill
  where jsonb_typeof(bill->'billDiscount') = 'object'
    and bill->'billDiscount' ? 'id'
  union all
  select 'payments', jsonb_array_length(coalesce(data->'payments', '[]'::jsonb)) from state
  union all
  select 'stock_movements', jsonb_array_length(coalesce(data->'stockMovements', '[]'::jsonb)) from state
  union all
  select 'audit_logs', jsonb_array_length(coalesce(data->'auditLogs', '[]'::jsonb)) from state
  union all
  select 'expenses', jsonb_array_length(coalesce(data->'expenses', '[]'::jsonb)) from state
  union all
  select 'expense_templates', jsonb_array_length(coalesce(data->'expenseTemplates', '[]'::jsonb)) from state
  union all
  select 'expense_template_overrides', jsonb_array_length(coalesce(data->'expenseTemplateOverrides', '[]'::jsonb)) from state
),
normalized_counts as (
  select 'inventory_categories' as collection, count(*)::bigint as normalized_count from public.inventory_categories where organization_id = 'org-primary'
  union all select 'stations', count(*) from public.stations where organization_id = 'org-primary'
  union all select 'pricing_rules', count(*) from public.pricing_rules where organization_id = 'org-primary'
  union all select 'customers', count(*) from public.customers where organization_id = 'org-primary'
  union all select 'inventory_items', count(*) from public.inventory_items where organization_id = 'org-primary'
  union all select 'sale_variants', count(*) from public.sale_variants where organization_id = 'org-primary'
  union all select 'combos', count(*) from public.combos where organization_id = 'org-primary'
  union all select 'combo_station_targets', count(*) from public.combo_station_targets where organization_id = 'org-primary'
  union all select 'combo_fixed_items', count(*) from public.combo_fixed_items where organization_id = 'org-primary'
  union all select 'combo_choice_groups', count(*) from public.combo_choice_groups where organization_id = 'org-primary'
  union all select 'combo_choice_options', count(*) from public.combo_choice_options where organization_id = 'org-primary'
  union all select 'sessions', count(*) from public.sessions where organization_id = 'org-primary'
  union all select 'session_pause_logs', count(*) from public.session_pause_logs where organization_id = 'org-primary'
  union all select 'session_items', count(*) from public.session_items where organization_id = 'org-primary'
  union all select 'session_combo_applications', count(*) from public.session_combo_applications where organization_id = 'org-primary'
  union all select 'customer_tabs', count(*) from public.customer_tabs where organization_id = 'org-primary'
  union all select 'customer_tab_items', count(*) from public.customer_tab_items where organization_id = 'org-primary'
  union all select 'customer_tab_combo_applications', count(*) from public.customer_tab_combo_applications where organization_id = 'org-primary'
  union all select 'bills', count(*) from public.bills where organization_id = 'org-primary'
  union all select 'bill_lines', count(*) from public.bill_lines where organization_id = 'org-primary'
  union all select 'bill_line_discounts', count(*) from public.bill_line_discounts where organization_id = 'org-primary'
  union all select 'bill_discounts', count(*) from public.bill_discounts where organization_id = 'org-primary'
  union all select 'payments', count(*) from public.payments where organization_id = 'org-primary'
  union all select 'stock_movements', count(*) from public.stock_movements where organization_id = 'org-primary'
  union all select 'audit_logs', count(*) from public.audit_logs where organization_id = 'org-primary'
  union all select 'expenses', count(*) from public.expenses where organization_id = 'org-primary'
  union all select 'expense_templates', count(*) from public.expense_templates where organization_id = 'org-primary'
  union all select 'expense_template_overrides', count(*) from public.expense_template_overrides where organization_id = 'org-primary'
)
select
  app_counts.collection,
  app_counts.app_count,
  normalized_counts.normalized_count,
  normalized_counts.normalized_count - app_counts.app_count as delta
from app_counts
join normalized_counts using (collection)
order by collection;

with state as (
  select data
  from public.app_state
  where id = 'primary'
),
app_totals as (
  select
    coalesce(sum(coalesce(nullif(bill->>'total', '')::numeric, 0)), 0) as bill_total,
    coalesce(sum(coalesce(nullif(bill->>'amountPaid', '')::numeric, 0)), 0) as bill_amount_paid,
    coalesce(sum(coalesce(nullif(bill->>'amountDue', '')::numeric, 0)), 0) as bill_amount_due
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'bills', '[]'::jsonb)) as bill
),
app_payments as (
  select coalesce(sum(coalesce(nullif(payment->>'amount', '')::numeric, 0)), 0) as payment_amount
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'payments', '[]'::jsonb)) as payment
),
app_stock as (
  select coalesce(sum(coalesce(nullif(movement->>'quantity', '')::numeric, 0)), 0) as stock_quantity
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'stockMovements', '[]'::jsonb)) as movement
),
normalized_totals as (
  select
    coalesce(sum(total), 0) as bill_total,
    coalesce(sum(amount_paid), 0) as bill_amount_paid,
    coalesce(sum(amount_due), 0) as bill_amount_due
  from public.bills
  where organization_id = 'org-primary'
),
normalized_payments as (
  select coalesce(sum(amount), 0) as payment_amount
  from public.payments
  where organization_id = 'org-primary'
),
normalized_stock as (
  select coalesce(sum(quantity), 0) as stock_quantity
  from public.stock_movements
  where organization_id = 'org-primary'
)
select
  metric,
  app_value,
  normalized_value,
  normalized_value - app_value as delta
from (
  select 'bill_total' as metric, app_totals.bill_total as app_value, normalized_totals.bill_total as normalized_value
  from app_totals, normalized_totals
  union all
  select 'bill_amount_paid', app_totals.bill_amount_paid, normalized_totals.bill_amount_paid
  from app_totals, normalized_totals
  union all
  select 'bill_amount_due', app_totals.bill_amount_due, normalized_totals.bill_amount_due
  from app_totals, normalized_totals
  union all
  select 'payment_amount', app_payments.payment_amount, normalized_payments.payment_amount
  from app_payments, normalized_payments
  union all
  select 'stock_quantity', app_stock.stock_quantity, normalized_stock.stock_quantity
  from app_stock, normalized_stock
) totals
order by metric;

with state as (
  select data
  from public.app_state
  where id = 'primary'
),
app_summary as (
  select
    (
      select count(*)
      from jsonb_array_elements(coalesce(data->'sessions', '[]'::jsonb)) as session
      where coalesce(session->>'status', '') <> 'closed'
    )::bigint as open_sessions,
    (
      select count(*)
      from jsonb_array_elements(coalesce(data->'customerTabs', '[]'::jsonb)) as tab
      where coalesce(tab->>'status', '') = 'open'
    )::bigint as open_customer_tabs,
    (
      select count(*)
      from jsonb_array_elements(coalesce(data->'bills', '[]'::jsonb)) as bill
      where coalesce(bill->>'status', '') = 'pending'
    )::bigint as pending_bills
  from state
),
normalized_summary as (
  select
    (select count(*) from public.sessions where organization_id = 'org-primary' and status <> 'closed')::bigint as open_sessions,
    (select count(*) from public.customer_tabs where organization_id = 'org-primary' and status = 'open')::bigint as open_customer_tabs,
    (select count(*) from public.bills where organization_id = 'org-primary' and status = 'pending')::bigint as pending_bills
)
select
  metric,
  app_value,
  normalized_value,
  normalized_value - app_value as delta
from (
  select 'open_sessions' as metric, app_summary.open_sessions as app_value, normalized_summary.open_sessions as normalized_value
  from app_summary, normalized_summary
  union all
  select 'open_customer_tabs', app_summary.open_customer_tabs, normalized_summary.open_customer_tabs
  from app_summary, normalized_summary
  union all
  select 'pending_bills', app_summary.pending_bills, normalized_summary.pending_bills
  from app_summary, normalized_summary
) summary
order by metric;
