-- Phase 3 normalized read performance evidence probes.
--
-- Run in staging first after:
--   1. supabase/phase1-normalized-schema.sql
--   2. supabase/phase1-backfill-from-app-state.sql
--   3. supabase/phase1-parity-checks-single-result.sql
--   4. supabase/phase3-read-performance-indexes.sql
--
-- This script is read-only. It returns a compact summary first, followed by
-- EXPLAIN ANALYZE result sets for the normalized read paths that replace
-- full app_state history reads. Times from EXPLAIN ANALYZE are environment
-- dependent; the important proof points are bounded row counts, index usage,
-- and no full app_state JSON download for historical screens. Bill/payment
-- probes use the app's 7 AM business day; expense probes mirror the current
-- Analytics local-date expense window.

set statement_timeout = '30s';

with
clock as (
  select timezone('Asia/Kolkata', now()) as local_now
),
business_day as (
  select
    case
      when local_now::time >= time '07:00'
        then local_now::date
      else local_now::date - 1
    end as current_business_day
  from clock
),
active_org as (
  select id as organization_id
  from public.organizations
  where active = true
  order by created_at asc
  limit 1
),
params as (
  select
    active_org.organization_id,
    current_business_day,
    ((current_business_day - 14) + time '07:00') at time zone 'Asia/Kolkata' as recent_from,
    ((current_business_day + 1) + time '07:00') at time zone 'Asia/Kolkata' as recent_to,
    ((current_business_day - 90) + time '07:00') at time zone 'Asia/Kolkata' as older_from,
    ((current_business_day - 14) + time '07:00') at time zone 'Asia/Kolkata' as older_to
  from active_org
  cross join business_day
),
recent_bill_page as (
  select b.*
  from public.bills b
  cross join params p
  where b.organization_id = p.organization_id
    and b.issued_at >= p.recent_from
    and b.issued_at < p.recent_to
  order by b.issued_at desc, b.id desc
  limit 51
),
older_search_seed as (
  select
    coalesce(
      nullif(b.customer_phone, ''),
      nullif(b.customer_name, ''),
      nullif(b.bill_number, ''),
      'NO_MATCH_SEARCH_TOKEN'
    ) as search_term
  from public.bills b
  cross join params p
  where b.organization_id = p.organization_id
    and b.issued_at >= p.older_from
    and b.issued_at < p.older_to
  order by b.issued_at desc, b.id desc
  limit 1
)
select *
from (
  select
    'active_organization_id' as metric,
    p.organization_id as value,
    'organization used by all probes' as interpretation
  from params p

  union all

  select
    'current_business_day',
    p.current_business_day::text,
    '7 AM Asia/Kolkata business-day key'
  from params p

  union all

  select
    'recent_window',
    p.recent_from::text || ' to ' || p.recent_to::text,
    'last 15 business days, inclusive of current business day'
  from params p

  union all

  select
    'older_search_window',
    p.older_from::text || ' to ' || p.older_to::text,
    'older sample window used to prove historical search remains possible'
  from params p

  union all

  select
    'app_state_bytes',
    coalesce((select pg_column_size(data)::text from public.app_state where id = 'primary'), 'missing'),
    'full JSON payload currently avoided by normalized history probes'

  union all

  select
    'recent_bills_count',
    (select count(*)::text from public.bills b cross join params p where b.organization_id = p.organization_id and b.issued_at >= p.recent_from and b.issued_at < p.recent_to),
    'bounded bill count for recent default history screens'

  union all

  select
    'recent_bill_page_count',
    (select count(*)::text from recent_bill_page),
    'normalized bill register reads only one page plus one cursor row'

  union all

  select
    'recent_bill_page_json_bytes',
    coalesce((select pg_column_size(coalesce(jsonb_agg(to_jsonb(recent_bill_page)), '[]'::jsonb))::text from recent_bill_page), '0'),
    'approximate selected recent bill page payload before line/payment detail rows'

  union all

  select
    'recent_bill_line_count_for_page',
    (
      select count(*)::text
      from public.bill_lines l
      cross join params p
      where l.organization_id = p.organization_id
        and l.bill_id in (select id from recent_bill_page)
    ),
    'bill line detail rows fetched only for the current bill page'

  union all

  select
    'recent_payment_count',
    (select count(*)::text from public.payments pay cross join params p where pay.organization_id = p.organization_id and pay.paid_at >= p.recent_from and pay.paid_at < p.recent_to),
    'bounded payment rows for normalized Analytics reads'

  union all

  select
    'recent_session_activity_count',
    (select count(*)::text from public.sessions s cross join params p where s.organization_id = p.organization_id and s.closed_bill_id is not null and s.started_at >= p.recent_from and s.started_at < p.recent_to),
    'bounded session activity rows for normalized Analytics business dates'

  union all

  select
    'recent_customer_tab_activity_count',
    (select count(*)::text from public.customer_tabs t cross join params p where t.organization_id = p.organization_id and t.closed_bill_id is not null and t.opened_at >= p.recent_from and t.opened_at < p.recent_to),
    'bounded customer-tab activity rows for normalized Analytics business dates'

  union all

  select
    'older_search_seed',
    coalesce((select search_term from older_search_seed), 'NO_OLDER_ROWS_IN_SAMPLE_WINDOW'),
    'search term used by older-history EXPLAIN block below'
) evidence
order by metric;

-- Probe 1: normalized Bill Register recent first page.
-- Expected plan: uses bills_org_issued_idx or an equivalent organization_id /
-- issued_at index and returns at most 51 rows.
explain (analyze, buffers, format text)
with
clock as (
  select timezone('Asia/Kolkata', now()) as local_now
),
business_day as (
  select case when local_now::time >= time '07:00' then local_now::date else local_now::date - 1 end as current_business_day
  from clock
),
params as (
  select
    o.id as organization_id,
    ((current_business_day - 14) + time '07:00') at time zone 'Asia/Kolkata' as recent_from,
    ((current_business_day + 1) + time '07:00') at time zone 'Asia/Kolkata' as recent_to
  from public.organizations o
  cross join business_day
  where o.active = true
  order by o.created_at asc
  limit 1
)
select
  b.id,
  b.bill_number,
  b.status,
  b.issued_at,
  b.customer_name,
  b.customer_phone,
  b.payment_mode,
  b.amount_paid,
  b.amount_due,
  b.total
from public.bills b
cross join params p
where b.organization_id = p.organization_id
  and b.issued_at >= p.recent_from
  and b.issued_at < p.recent_to
order by b.issued_at desc, b.id desc
limit 51;

-- Probe 2: normalized Bill Register current-page detail rows.
-- Expected plan: bill_lines_org_bill_idx / primary-key prefix and
-- payments_org_bill_idx for only the page bill IDs.
explain (analyze, buffers, format text)
with
clock as (
  select timezone('Asia/Kolkata', now()) as local_now
),
business_day as (
  select case when local_now::time >= time '07:00' then local_now::date else local_now::date - 1 end as current_business_day
  from clock
),
params as (
  select
    o.id as organization_id,
    ((current_business_day - 14) + time '07:00') at time zone 'Asia/Kolkata' as recent_from,
    ((current_business_day + 1) + time '07:00') at time zone 'Asia/Kolkata' as recent_to
  from public.organizations o
  cross join business_day
  where o.active = true
  order by o.created_at asc
  limit 1
),
page_bills as (
  select b.id
  from public.bills b
  cross join params p
  where b.organization_id = p.organization_id
    and b.issued_at >= p.recent_from
    and b.issued_at < p.recent_to
  order by b.issued_at desc, b.id desc
  limit 50
)
select
  'bill_lines' as detail_type,
  count(*) as row_count
from public.bill_lines l
cross join params p
where l.organization_id = p.organization_id
  and l.bill_id in (select id from page_bills)
union all
select
  'payments' as detail_type,
  count(*) as row_count
from public.payments pay
cross join params p
where pay.organization_id = p.organization_id
  and pay.bill_id in (select id from page_bills);

-- Probe 3: normalized Analytics/Reports recent date-filtered rows.
-- Expected plan: bills_org_issued_idx, payments_org_paid_idx,
-- sessions_org_started_closed_bill_idx, customer_tabs_org_opened_closed_bill_idx,
-- and expenses_org_spent_idx.
explain (analyze, buffers, format text)
with
clock as (
  select timezone('Asia/Kolkata', now()) as local_now
),
business_day as (
  select case when local_now::time >= time '07:00' then local_now::date else local_now::date - 1 end as current_business_day
  from clock
),
params as (
  select
    o.id as organization_id,
    ((current_business_day - 14) + time '07:00') at time zone 'Asia/Kolkata' as recent_from,
    ((current_business_day + 1) + time '07:00') at time zone 'Asia/Kolkata' as recent_to,
    (current_business_day - 14)::timestamp at time zone 'Asia/Kolkata' as expense_from,
    (current_business_day + 1)::timestamp at time zone 'Asia/Kolkata' as expense_to
  from public.organizations o
  cross join business_day
  where o.active = true
  order by o.created_at asc
  limit 1
)
select
  'bills' as source_table,
  count(*) as row_count
from public.bills b
cross join params p
where b.organization_id = p.organization_id
  and b.issued_at >= p.recent_from
  and b.issued_at < p.recent_to
union all
select
  'payments' as source_table,
  count(*) as row_count
from public.payments pay
cross join params p
where pay.organization_id = p.organization_id
  and pay.paid_at >= p.recent_from
  and pay.paid_at < p.recent_to
union all
select
  'closed_sessions' as source_table,
  count(*) as row_count
from public.sessions s
cross join params p
where s.organization_id = p.organization_id
  and s.closed_bill_id is not null
  and s.started_at >= p.recent_from
  and s.started_at < p.recent_to
union all
select
  'closed_customer_tabs' as source_table,
  count(*) as row_count
from public.customer_tabs t
cross join params p
where t.organization_id = p.organization_id
  and t.closed_bill_id is not null
  and t.opened_at >= p.recent_from
  and t.opened_at < p.recent_to
union all
select
  'expenses' as source_table,
  count(*) as row_count
from public.expenses e
cross join params p
where e.organization_id = p.organization_id
  and e.spent_at >= p.expense_from
  and e.spent_at < p.expense_to;

-- Probe 4: older Bill Register search.
-- Expected behavior: still paginated and bounded to normalized bills, with no
-- app_state JSON load. Current v1 uses ILIKE, so very large future datasets may
-- need a dedicated search_vector/trigram index if this exceeds the target.
explain (analyze, buffers, format text)
with
clock as (
  select timezone('Asia/Kolkata', now()) as local_now
),
business_day as (
  select case when local_now::time >= time '07:00' then local_now::date else local_now::date - 1 end as current_business_day
  from clock
),
params as (
  select
    o.id as organization_id,
    ((current_business_day - 90) + time '07:00') at time zone 'Asia/Kolkata' as older_from,
    ((current_business_day - 14) + time '07:00') at time zone 'Asia/Kolkata' as older_to
  from public.organizations o
  cross join business_day
  where o.active = true
  order by o.created_at asc
  limit 1
),
search_seed as (
  select
    coalesce(
      nullif(b.customer_phone, ''),
      nullif(b.customer_name, ''),
      nullif(b.bill_number, ''),
      'NO_MATCH_SEARCH_TOKEN'
    ) as search_term
  from public.bills b
  cross join params p
  where b.organization_id = p.organization_id
    and b.issued_at >= p.older_from
    and b.issued_at < p.older_to
  order by b.issued_at desc, b.id desc
  limit 1
)
select
  b.id,
  b.bill_number,
  b.status,
  b.issued_at,
  b.customer_name,
  b.customer_phone,
  b.total
from public.bills b
cross join params p
cross join search_seed s
where b.organization_id = p.organization_id
  and b.issued_at >= p.older_from
  and b.issued_at < p.older_to
  and (
    b.bill_number ilike '%' || s.search_term || '%'
    or b.customer_name ilike '%' || s.search_term || '%'
    or b.customer_phone ilike '%' || s.search_term || '%'
  )
order by b.issued_at desc, b.id desc
limit 50;
