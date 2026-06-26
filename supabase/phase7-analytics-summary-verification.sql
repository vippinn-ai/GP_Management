-- Phase 7 Analytics summary verification.
-- Run after supabase/phase7-analytics-summary-rpc.sql and after a backfill.

with expected_tables(table_name) as (
  values
    ('analytics_daily_summary'),
    ('analytics_daily_channels'),
    ('analytics_daily_expense_categories'),
    ('analytics_daily_paid_bills'),
    ('analytics_dirty_dates')
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
  'load_analytics_summary' as metric,
  jsonb_build_object(
    'anon_can_execute', has_function_privilege('anon', 'public.load_analytics_summary(text,date,date,date,date)', 'EXECUTE'),
    'authenticated_can_execute', has_function_privilege('authenticated', 'public.load_analytics_summary(text,date,date,date,date)', 'EXECUTE'),
    'anon_can_refresh', has_function_privilege('anon', 'public.refresh_analytics_for_business_dates(text,date[])', 'EXECUTE'),
    'authenticated_can_refresh', has_function_privilege('authenticated', 'public.refresh_analytics_for_business_dates(text,date[])', 'EXECUTE'),
    'anon_can_backfill', has_function_privilege('anon', 'public.backfill_analytics_daily_summary(text,date,date)', 'EXECUTE'),
    'authenticated_can_backfill', has_function_privilege('authenticated', 'public.backfill_analytics_daily_summary(text,date,date)', 'EXECUTE')
  )::text as value,
  case
    when not has_function_privilege('anon', 'public.load_analytics_summary(text,date,date,date,date)', 'EXECUTE')
     and has_function_privilege('authenticated', 'public.load_analytics_summary(text,date,date,date,date)', 'EXECUTE')
     and not has_function_privilege('anon', 'public.refresh_analytics_for_business_dates(text,date[])', 'EXECUTE')
     and not has_function_privilege('authenticated', 'public.refresh_analytics_for_business_dates(text,date[])', 'EXECUTE')
     and not has_function_privilege('anon', 'public.backfill_analytics_daily_summary(text,date,date)', 'EXECUTE')
     and not has_function_privilege('authenticated', 'public.backfill_analytics_daily_summary(text,date,date)', 'EXECUTE')
    then 'pass'
    else 'fail'
  end as status;

select
  'summary_rows' as check_group,
  'analytics_daily_summary' as metric,
  count(*)::text as value,
  max(refreshed_at)::text as status
from public.analytics_daily_summary;

select
  'dirty_dates' as check_group,
  'analytics_dirty_dates' as metric,
  count(*)::text as value,
  coalesce(max(updated_at)::text, 'none') as status
from public.analytics_dirty_dates;

select
  'recent_summary' as check_group,
  business_date::text as metric,
  jsonb_build_object(
    'gross_revenue', gross_revenue,
    'paid_bill_count', paid_bill_count,
    'pending_revenue', pending_revenue,
    'one_time_expenses', one_time_expenses,
    'payment_cash', payment_cash,
    'payment_upi', payment_upi
  )::text as value,
  refreshed_at::text as status
from public.analytics_daily_summary
order by business_date desc
limit 10;
