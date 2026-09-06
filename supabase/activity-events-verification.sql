begin transaction isolation level repeatable read read only;

with expected_sources as (
  select organization_id, 'audit_log'::text as source_kind, id as source_id
  from public.audit_logs
  union all
  select organization_id, 'operational_event'::text, id
  from public.operational_events event
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
), reference_mismatches as (
  select activity.id
  from public.activity_events activity
  join public.operational_events event
    on event.organization_id = activity.organization_id
   and event.id = activity.source_id
  where activity.source_kind = 'operational_event'
    and activity.audit_reference_ids <> public.extract_activity_audit_reference_ids(event.metadata)
), correlated_audits as (
  select distinct audit.id
  from public.activity_events audit
  join public.activity_events operational
    on operational.organization_id = audit.organization_id
   and operational.source_kind = 'operational_event'
   and operational.audit_reference_ids @> array[audit.source_id]
  where audit.source_kind = 'audit_log'
    and (
      (audit.legacy and operational.legacy)
      or (
        not audit.legacy
        and not operational.legacy
        and audit.actor_user_id is not null
        and operational.actor_user_id = audit.actor_user_id
        and operational.occurred_at = audit.occurred_at
      )
    )
), presented_sources as (
  select event.*
  from public.activity_events event
  where not (
    event.source_kind = 'audit_log'
    and exists (
      select 1
      from public.activity_events operational
      where operational.organization_id = event.organization_id
        and operational.source_kind = 'operational_event'
        and operational.audit_reference_ids @> array[event.source_id]
        and (
          (event.legacy and operational.legacy)
          or (
            not operational.legacy
            and event.actor_user_id is not null
            and operational.actor_user_id = event.actor_user_id
            and operational.occurred_at = event.occurred_at
          )
        )
    )
  )
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
        'zz_audit_logs_prevent_delete',
        'operational_events_canonical_identity',
        'operational_events_append_activity',
        'zz_operational_events_prevent_delete'
      )
  ),
  'trigger_count_valid', (
    select count(*) = 7
    from pg_trigger trigger
    where trigger.tgrelid in ('public.audit_logs'::regclass, 'public.operational_events'::regclass)
      and not trigger.tgisinternal
      and trigger.tgname in (
        'audit_logs_canonical_identity',
        'audit_logs_append_activity',
        'zz_audit_logs_preserve_immutable',
        'zz_audit_logs_prevent_delete',
        'operational_events_canonical_identity',
        'operational_events_append_activity',
        'zz_operational_events_prevent_delete'
      )
  ),
  'activity_rows', (select count(*) from public.activity_events),
  'presented_activity_rows', (select count(*) from presented_sources),
  'suppressed_correlated_audit_rows', (select count(*) from correlated_audits),
  'expected_source_rows', (select count(*) from expected_sources),
  'missing_source_rows', (select count(*) from missing_sources),
  'duplicate_source_rows', (select count(*) from duplicate_sources),
  'reference_mismatch_rows', (select count(*) from reference_mismatches),
  'audit_reference_extractor_valid',
    public.extract_activity_audit_reference_ids(null) = '{}'::text[]
    and public.extract_activity_audit_reference_ids('{}'::jsonb) = '{}'::text[]
    and public.extract_activity_audit_reference_ids('{"audit_log_id":"audit-a"}'::jsonb) = array['audit-a']
    and public.extract_activity_audit_reference_ids('{"audit_log_ids":["audit-b","audit-a"]}'::jsonb) = array['audit-a','audit-b']
    and public.extract_activity_audit_reference_ids('{"changed_rows":{"audit_logs":["audit-c"]}}'::jsonb) = array['audit-c']
    and public.extract_activity_audit_reference_ids('{"audit_log_id":7,"audit_log_ids":{},"changed_rows":{"audit_logs":"bad"}}'::jsonb) = array['7'],
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
