-- Phase 1 parity checks, single-result version for Supabase SQL Editor.
-- Run after phase1-normalized-schema.sql and phase1-backfill-from-app-state.sql.
-- Every row should have delta = 0 before considering any read cutover.

with state as (
  select data
  from public.app_state
  where id = 'primary'
),
app_counts as (
  select 'inventory_categories' as metric, count(*)::numeric as app_value
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
  union all select 'stations', jsonb_array_length(coalesce(data->'stations', '[]'::jsonb))::numeric from state
  union all select 'pricing_rules', jsonb_array_length(coalesce(data->'pricingRules', '[]'::jsonb))::numeric from state
  union all select 'customers', jsonb_array_length(coalesce(data->'customers', '[]'::jsonb))::numeric from state
  union all select 'inventory_items', jsonb_array_length(coalesce(data->'inventoryItems', '[]'::jsonb))::numeric from state
  union all
  select 'sale_variants', coalesce(sum(jsonb_array_length(coalesce(item->'saleVariants', '[]'::jsonb))), 0)::numeric
  from state cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
  union all select 'combos', jsonb_array_length(coalesce(data->'combos', '[]'::jsonb))::numeric from state
  union all
  select 'combo_station_targets', coalesce(sum(jsonb_array_length(coalesce(combo->'stationIds', '[]'::jsonb))), 0)::numeric
  from state cross join lateral jsonb_array_elements(coalesce(data->'combos', '[]'::jsonb)) as combo
  union all
  select 'combo_fixed_items', coalesce(sum(jsonb_array_length(coalesce(combo->'fixedItems', '[]'::jsonb))), 0)::numeric
  from state cross join lateral jsonb_array_elements(coalesce(data->'combos', '[]'::jsonb)) as combo
  union all
  select 'combo_choice_groups', coalesce(sum(jsonb_array_length(coalesce(combo->'choiceGroups', '[]'::jsonb))), 0)::numeric
  from state cross join lateral jsonb_array_elements(coalesce(data->'combos', '[]'::jsonb)) as combo
  union all
  select 'combo_choice_options', coalesce(sum(jsonb_array_length(coalesce(choice_group->'optionIds', '[]'::jsonb))), 0)::numeric
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'combos', '[]'::jsonb)) as combo
  cross join lateral jsonb_array_elements(coalesce(combo->'choiceGroups', '[]'::jsonb)) as choice_group
  union all select 'sessions', jsonb_array_length(coalesce(data->'sessions', '[]'::jsonb))::numeric from state
  union all select 'session_pause_logs', jsonb_array_length(coalesce(data->'sessionPauseLogs', '[]'::jsonb))::numeric from state
  union all
  select 'session_items', coalesce(sum(jsonb_array_length(coalesce(session->'items', '[]'::jsonb))), 0)::numeric
  from state cross join lateral jsonb_array_elements(coalesce(data->'sessions', '[]'::jsonb)) as session
  union all
  select 'session_combo_applications', coalesce(sum(jsonb_array_length(coalesce(session->'comboApplications', '[]'::jsonb))), 0)::numeric
  from state cross join lateral jsonb_array_elements(coalesce(data->'sessions', '[]'::jsonb)) as session
  union all select 'customer_tabs', jsonb_array_length(coalesce(data->'customerTabs', '[]'::jsonb))::numeric from state
  union all
  select 'customer_tab_items', coalesce(sum(jsonb_array_length(coalesce(tab->'items', '[]'::jsonb))), 0)::numeric
  from state cross join lateral jsonb_array_elements(coalesce(data->'customerTabs', '[]'::jsonb)) as tab
  union all
  select 'customer_tab_combo_applications', coalesce(sum(jsonb_array_length(coalesce(tab->'comboApplications', '[]'::jsonb))), 0)::numeric
  from state cross join lateral jsonb_array_elements(coalesce(data->'customerTabs', '[]'::jsonb)) as tab
  union all select 'bills', jsonb_array_length(coalesce(data->'bills', '[]'::jsonb))::numeric from state
  union all
  select 'bill_lines', coalesce(sum(jsonb_array_length(coalesce(bill->'lines', '[]'::jsonb))), 0)::numeric
  from state cross join lateral jsonb_array_elements(coalesce(data->'bills', '[]'::jsonb)) as bill
  union all
  select 'bill_line_discounts', coalesce(sum(jsonb_array_length(coalesce(bill->'lineDiscounts', '[]'::jsonb))), 0)::numeric
  from state cross join lateral jsonb_array_elements(coalesce(data->'bills', '[]'::jsonb)) as bill
  union all
  select 'bill_discounts', count(*)::numeric
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'bills', '[]'::jsonb)) as bill
  where jsonb_typeof(bill->'billDiscount') = 'object'
    and bill->'billDiscount' ? 'id'
  union all select 'payments', jsonb_array_length(coalesce(data->'payments', '[]'::jsonb))::numeric from state
  union all select 'stock_movements', jsonb_array_length(coalesce(data->'stockMovements', '[]'::jsonb))::numeric from state
  union all select 'audit_logs', jsonb_array_length(coalesce(data->'auditLogs', '[]'::jsonb))::numeric from state
  union all select 'expenses', jsonb_array_length(coalesce(data->'expenses', '[]'::jsonb))::numeric from state
  union all select 'expense_templates', jsonb_array_length(coalesce(data->'expenseTemplates', '[]'::jsonb))::numeric from state
  union all select 'expense_template_overrides', jsonb_array_length(coalesce(data->'expenseTemplateOverrides', '[]'::jsonb))::numeric from state
),
normalized_counts as (
  select 'inventory_categories' as metric, count(*)::numeric as normalized_value from public.inventory_categories where organization_id = 'org-primary'
  union all select 'stations', count(*)::numeric from public.stations where organization_id = 'org-primary'
  union all select 'pricing_rules', count(*)::numeric from public.pricing_rules where organization_id = 'org-primary'
  union all select 'customers', count(*)::numeric from public.customers where organization_id = 'org-primary'
  union all select 'inventory_items', count(*)::numeric from public.inventory_items where organization_id = 'org-primary'
  union all select 'sale_variants', count(*)::numeric from public.sale_variants where organization_id = 'org-primary'
  union all select 'combos', count(*)::numeric from public.combos where organization_id = 'org-primary'
  union all select 'combo_station_targets', count(*)::numeric from public.combo_station_targets where organization_id = 'org-primary'
  union all select 'combo_fixed_items', count(*)::numeric from public.combo_fixed_items where organization_id = 'org-primary'
  union all select 'combo_choice_groups', count(*)::numeric from public.combo_choice_groups where organization_id = 'org-primary'
  union all select 'combo_choice_options', count(*)::numeric from public.combo_choice_options where organization_id = 'org-primary'
  union all select 'sessions', count(*)::numeric from public.sessions where organization_id = 'org-primary'
  union all select 'session_pause_logs', count(*)::numeric from public.session_pause_logs where organization_id = 'org-primary'
  union all select 'session_items', count(*)::numeric from public.session_items where organization_id = 'org-primary'
  union all select 'session_combo_applications', count(*)::numeric from public.session_combo_applications where organization_id = 'org-primary'
  union all select 'customer_tabs', count(*)::numeric from public.customer_tabs where organization_id = 'org-primary'
  union all select 'customer_tab_items', count(*)::numeric from public.customer_tab_items where organization_id = 'org-primary'
  union all select 'customer_tab_combo_applications', count(*)::numeric from public.customer_tab_combo_applications where organization_id = 'org-primary'
  union all select 'bills', count(*)::numeric from public.bills where organization_id = 'org-primary'
  union all select 'bill_lines', count(*)::numeric from public.bill_lines where organization_id = 'org-primary'
  union all select 'bill_line_discounts', count(*)::numeric from public.bill_line_discounts where organization_id = 'org-primary'
  union all select 'bill_discounts', count(*)::numeric from public.bill_discounts where organization_id = 'org-primary'
  union all select 'payments', count(*)::numeric from public.payments where organization_id = 'org-primary'
  union all select 'stock_movements', count(*)::numeric from public.stock_movements where organization_id = 'org-primary'
  union all select 'audit_logs', count(*)::numeric from public.audit_logs where organization_id = 'org-primary'
  union all select 'expenses', count(*)::numeric from public.expenses where organization_id = 'org-primary'
  union all select 'expense_templates', count(*)::numeric from public.expense_templates where organization_id = 'org-primary'
  union all select 'expense_template_overrides', count(*)::numeric from public.expense_template_overrides where organization_id = 'org-primary'
),
collection_rows as (
  select
    'collection_count' as check_group,
    app_counts.metric,
    app_counts.app_value,
    normalized_counts.normalized_value,
    normalized_counts.normalized_value - app_counts.app_value as delta
  from app_counts
  join normalized_counts using (metric)
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
),
total_rows as (
  select 'totals' as check_group, 'bill_total' as metric, app_totals.bill_total as app_value, normalized_totals.bill_total as normalized_value
  from app_totals, normalized_totals
  union all
  select 'totals', 'bill_amount_paid', app_totals.bill_amount_paid, normalized_totals.bill_amount_paid
  from app_totals, normalized_totals
  union all
  select 'totals', 'bill_amount_due', app_totals.bill_amount_due, normalized_totals.bill_amount_due
  from app_totals, normalized_totals
  union all
  select 'totals', 'payment_amount', app_payments.payment_amount, normalized_payments.payment_amount
  from app_payments, normalized_payments
  union all
  select 'totals', 'stock_quantity', app_stock.stock_quantity, normalized_stock.stock_quantity
  from app_stock, normalized_stock
),
app_summary as (
  select
    (
      select count(*)
      from jsonb_array_elements(coalesce(data->'sessions', '[]'::jsonb)) as session
      where coalesce(session->>'status', '') <> 'closed'
    )::numeric as open_sessions,
    (
      select count(*)
      from jsonb_array_elements(coalesce(data->'customerTabs', '[]'::jsonb)) as tab
      where coalesce(tab->>'status', '') = 'open'
    )::numeric as open_customer_tabs,
    (
      select count(*)
      from jsonb_array_elements(coalesce(data->'bills', '[]'::jsonb)) as bill
      where coalesce(bill->>'status', '') = 'pending'
    )::numeric as pending_bills
  from state
),
normalized_summary as (
  select
    (select count(*) from public.sessions where organization_id = 'org-primary' and status <> 'closed')::numeric as open_sessions,
    (select count(*) from public.customer_tabs where organization_id = 'org-primary' and status = 'open')::numeric as open_customer_tabs,
    (select count(*) from public.bills where organization_id = 'org-primary' and status = 'pending')::numeric as pending_bills
),
summary_rows as (
  select 'live_summary' as check_group, 'open_sessions' as metric, app_summary.open_sessions as app_value, normalized_summary.open_sessions as normalized_value
  from app_summary, normalized_summary
  union all
  select 'live_summary', 'open_customer_tabs', app_summary.open_customer_tabs, normalized_summary.open_customer_tabs
  from app_summary, normalized_summary
  union all
  select 'live_summary', 'pending_bills', app_summary.pending_bills, normalized_summary.pending_bills
  from app_summary, normalized_summary
)
select
  check_group,
  metric,
  app_value,
  normalized_value,
  normalized_value - app_value as delta
from (
  select check_group, metric, app_value, normalized_value from collection_rows
  union all
  select check_group, metric, app_value, normalized_value from total_rows
  union all
  select check_group, metric, app_value, normalized_value from summary_rows
) parity
order by
  case check_group
    when 'collection_count' then 1
    when 'totals' then 2
    when 'live_summary' then 3
    else 4
  end,
  metric;
