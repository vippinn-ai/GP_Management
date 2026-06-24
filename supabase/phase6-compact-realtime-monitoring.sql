-- Phase 6 compact realtime monitoring.
-- Read-only checks for egress/cache rollout validation.

select
  'app_state_size' as section,
  pg_column_size(data)::text as value,
  pg_size_pretty(pg_column_size(data)::bigint) as detail,
  version::text as version,
  updated_at::text as observed_at
from public.app_state
where id = 'primary'

union all

select
  'realtime_publication' as section,
  tablename as value,
  schemaname as detail,
  null as version,
  now()::text as observed_at
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename in ('app_state', 'operational_events')

union all

select
  'recent_operational_events' as section,
  event_type || ':' || entity_type as value,
  count(*)::text as detail,
  null as version,
  max(created_at)::text as observed_at
from public.operational_events
where created_at >= now() - interval '1 day'
group by event_type, entity_type
order by section, value;
