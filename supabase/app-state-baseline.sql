-- Diagnostic query for the current single-row app_state architecture.
-- Run manually in the Supabase SQL editor for staging/production before and after sync changes.
-- This file is read-only diagnostics; it does not mutate data.

select
  pg_column_size(data) as app_state_bytes,
  pg_size_pretty(pg_column_size(data)::bigint) as app_state_size,
  jsonb_array_length(coalesce(data->'inventoryCategories', '[]'::jsonb)) as inventory_categories,
  jsonb_array_length(coalesce(data->'stations', '[]'::jsonb)) as stations,
  jsonb_array_length(coalesce(data->'pricingRules', '[]'::jsonb)) as pricing_rules,
  jsonb_array_length(coalesce(data->'sessions', '[]'::jsonb)) as sessions,
  jsonb_array_length(coalesce(data->'sessionPauseLogs', '[]'::jsonb)) as session_pause_logs,
  jsonb_array_length(coalesce(data->'customers', '[]'::jsonb)) as customers,
  jsonb_array_length(coalesce(data->'customerTabs', '[]'::jsonb)) as customer_tabs,
  jsonb_array_length(coalesce(data->'inventoryItems', '[]'::jsonb)) as inventory_items,
  jsonb_array_length(coalesce(data->'combos', '[]'::jsonb)) as combos,
  jsonb_array_length(coalesce(data->'stockMovements', '[]'::jsonb)) as stock_movements,
  jsonb_array_length(coalesce(data->'bills', '[]'::jsonb)) as bills,
  jsonb_array_length(coalesce(data->'payments', '[]'::jsonb)) as payments,
  jsonb_array_length(coalesce(data->'auditLogs', '[]'::jsonb)) as audit_logs,
  jsonb_array_length(coalesce(data->'expenses', '[]'::jsonb)) as expenses,
  jsonb_array_length(coalesce(data->'expenseTemplates', '[]'::jsonb)) as expense_templates,
  jsonb_array_length(coalesce(data->'expenseTemplateOverrides', '[]'::jsonb)) as expense_template_overrides,
  version,
  updated_at
from public.app_state
where id = 'primary';
