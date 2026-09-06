begin transaction isolation level repeatable read read only;

with expected_sources as (
  select organization_id, 'audit_log'::text as source_kind, id as source_id
  from public.audit_logs
  union all
  select organization_id, 'operational_event'::text, id
  from public.operational_events event
  where not (
    coalesce(nullif(event.metadata->>'audit_log_id', ''), '') <> ''
    or jsonb_typeof(event.metadata #> '{changed_rows,audit_logs}') = 'array'
       and jsonb_array_length(event.metadata #> '{changed_rows,audit_logs}') > 0
  )
), duplicate_sources as (
  select organization_id, source_kind, source_id, count(*) as row_count
  from public.activity_events
  group by organization_id, source_kind, source_id
  having count(*) > 1
), missing_sources as (
  select expected.*
  from expected_sources expected
  left join public.activity_events activity
    on activity.organization_id = expected.organization_id
   and activity.source_kind = expected.source_kind
   and activity.source_id = expected.source_id
  where activity.id is null
), unsafe_detail_keys as (
  select id
  from public.activity_events
  where details ?| array['password', 'token', 'authorization', 'auth_email', 'apikey', 'secret']
)
select jsonb_build_object(
  'checked_at', now(),
  'table_present', to_regclass('public.activity_events') is not null,
  'reader_present', to_regprocedure('public.list_activity_events(jsonb)') is not null,
  'trigger_count', (
    select count(*)
    from pg_trigger trigger
    where trigger.tgrelid in ('public.audit_logs'::regclass, 'public.operational_events'::regclass)
      and not trigger.tgisinternal
      and trigger.tgname in (
        'audit_logs_canonical_identity',
        'audit_logs_append_activity',
        'zz_audit_logs_preserve_immutable',
        'operational_events_canonical_identity',
        'operational_events_append_activity'
      )
  ),
  'activity_rows', (select count(*) from public.activity_events),
  'expected_source_rows', (select count(*) from expected_sources),
  'missing_source_rows', (select count(*) from missing_sources),
  'duplicate_source_rows', (select count(*) from duplicate_sources),
  'unsafe_detail_key_rows', (select count(*) from unsafe_detail_keys),
  'authenticated_can_select_activity', has_table_privilege('authenticated', 'public.activity_events', 'select'),
  'authenticated_can_insert_activity', has_table_privilege('authenticated', 'public.activity_events', 'insert'),
  'authenticated_can_mutate_audit',
    has_table_privilege('authenticated', 'public.audit_logs', 'insert')
    or has_table_privilege('authenticated', 'public.audit_logs', 'update')
    or has_table_privilege('authenticated', 'public.audit_logs', 'delete'),
  'authenticated_can_mutate_operational_event',
    has_table_privilege('authenticated', 'public.operational_events', 'insert')
    or has_table_privilege('authenticated', 'public.operational_events', 'update')
    or has_table_privilege('authenticated', 'public.operational_events', 'delete'),
  'reader_execute_authenticated', has_function_privilege('authenticated', 'public.list_activity_events(jsonb)', 'execute'),
  'reader_execute_anon', has_function_privilege('anon', 'public.list_activity_events(jsonb)', 'execute'),
  'app_state_unchanged_by_this_probe', true
) as activity_feed_verification;

rollback;
