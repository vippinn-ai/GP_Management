-- Phase 9 Inventory Report summary verification.
-- Run after supabase/phase9-inventory-report-summary-rpc.sql and after a backfill.

with expected_tables(table_name) as (
  values
    ('inventory_daily_item_summary'),
    ('inventory_report_movements'),
    ('inventory_report_dirty_dates'),
    ('inventory_report_refreshed_dates')
)
select
  'rls' as check_group,
  expected_tables.table_name as metric,
  coalesce(pg_class.relrowsecurity, false)::text as value,
  case when coalesce(pg_class.relrowsecurity, false) then 'pass' else 'fail' end as status
from expected_tables
left join pg_class on pg_class.relname = expected_tables.table_name
left join pg_namespace on pg_namespace.oid = pg_class.relnamespace
where pg_namespace.nspname = 'public'
order by expected_tables.table_name;

select
  'function_grant' as check_group,
  'load_inventory_report_summary' as metric,
  jsonb_build_object(
    'anon_can_execute', has_function_privilege('anon', 'public.load_inventory_report_summary(text,date,date,text,integer)', 'EXECUTE'),
    'authenticated_can_execute', has_function_privilege('authenticated', 'public.load_inventory_report_summary(text,date,date,text,integer)', 'EXECUTE'),
    'anon_can_refresh', has_function_privilege('anon', 'public.refresh_inventory_report_for_business_dates(text,date[])', 'EXECUTE'),
    'authenticated_can_refresh', has_function_privilege('authenticated', 'public.refresh_inventory_report_for_business_dates(text,date[])', 'EXECUTE'),
    'anon_can_backfill', has_function_privilege('anon', 'public.backfill_inventory_report_summary(text,date,date)', 'EXECUTE'),
    'authenticated_can_backfill', has_function_privilege('authenticated', 'public.backfill_inventory_report_summary(text,date,date)', 'EXECUTE')
  )::text as value,
  case
    when not has_function_privilege('anon', 'public.load_inventory_report_summary(text,date,date,text,integer)', 'EXECUTE')
     and has_function_privilege('authenticated', 'public.load_inventory_report_summary(text,date,date,text,integer)', 'EXECUTE')
     and not has_function_privilege('anon', 'public.refresh_inventory_report_for_business_dates(text,date[])', 'EXECUTE')
     and not has_function_privilege('authenticated', 'public.refresh_inventory_report_for_business_dates(text,date[])', 'EXECUTE')
     and not has_function_privilege('anon', 'public.backfill_inventory_report_summary(text,date,date)', 'EXECUTE')
     and not has_function_privilege('authenticated', 'public.backfill_inventory_report_summary(text,date,date)', 'EXECUTE')
    then 'pass'
    else 'fail'
  end as status;

select
  'summary_rows' as check_group,
  'inventory_daily_item_summary' as metric,
  count(*)::text as value,
  coalesce(max(refreshed_at)::text, 'none') as status
from public.inventory_daily_item_summary;

select
  'movement_rows' as check_group,
  'inventory_report_movements' as metric,
  count(*)::text as value,
  coalesce(max(refreshed_at)::text, 'none') as status
from public.inventory_report_movements;

select
  'refreshed_dates' as check_group,
  'inventory_report_refreshed_dates' as metric,
  count(*)::text as value,
  coalesce(max(refreshed_at)::text, 'none') as status
from public.inventory_report_refreshed_dates;

select
  'dirty_dates' as check_group,
  'inventory_report_dirty_dates' as metric,
  count(*)::text as value,
  coalesce(max(updated_at)::text, 'none') as status
from public.inventory_report_dirty_dates;

select
  'movement_type_counts' as check_group,
  type as metric,
  count(*)::text as value,
  max(movement_at)::text as status
from public.inventory_report_movements
group by type
order by type;

select
  'recent_summary' as check_group,
  business_date::text || ':' || item_id as metric,
  jsonb_build_object(
    'added', added,
    'deducted', deducted,
    'manual_adjustments', manual_adjustments,
    'reversals', reversals,
    'net_change', net_change,
    'movement_count', movement_count
  )::text as value,
  refreshed_at::text as status
from public.inventory_daily_item_summary
order by business_date desc, movement_count desc, item_id asc
limit 10;
