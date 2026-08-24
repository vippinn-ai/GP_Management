-- Staging-only guarded repair for the quarantined 20260824183400 QA continuation chain.
-- Do not run in production. Every precondition is exact and the transaction fails closed.
-- PREPARATION ONLY: a separately approved second attempt must replace the sentinel and all attempt identities.

begin;

set local time zone 'UTC';
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare
  v_organization_id constant text := 'org-primary';
  v_source_session_id constant text := 'session-9ef998d5-e5a9-44f9-b68a-f815df023b7a';
  v_rejected_consumer_id constant text := 'session-4f9e640d-877d-4817-a005-bc08e6d3a76c';
  -- This is the designated staging maintenance actor recorded in the repair evidence.
  -- It identifies the approved QA owner; it does not claim to be the SQL Editor operator.
  v_designated_maintenance_actor constant uuid := '61cc2f83-69d1-46ab-9d89-9df7f7b1e497'::uuid;
  v_audit_id constant text := 'audit-qa-continuation-repair-20260825-0015';
  v_event_id constant text := 'event-qa-continuation-repair-20260825-0015';
  v_mutation_id constant text := 'maintenance-qa-continuation-repair-20260825-0015';
  v_second_attempt_authorization constant text := 'NOT_AUTHORIZED';
  v_expected_app_state_version constant integer := 624;
  v_expected_app_state_hash constant text := '22368f8e74c3026017685fbc096f4281deb5c71277778c4b42691758ad743e51';
  v_expected_set_updated_at_hash constant text := '00a8c647f5ea99964b50a2c0499bda024e3644d6fcb32dbe215f7b644de8b31b';
  -- The deployed sessions/app_state triggers canonicalize updated_at to now().
  -- Use the same transaction timestamp for every typed, raw, and event timestamp.
  v_now timestamptz := now();
  v_app_state_data jsonb;
  v_app_state_version integer;
  v_source public.sessions%rowtype;
  v_consumer public.sessions%rowtype;
  v_repaired_consumer jsonb;
  v_compatibility_consumer jsonb;
  v_repaired_compatibility_consumer jsonb;
  v_audit jsonb;
  v_next_app_state_data jsonb;
  v_reference_count integer;
begin
  if v_second_attempt_authorization <> 'APPROVED_WITH_FRESH_IDENTITIES' then
    raise exception using errcode = 'QA028', message = 'Second staging repair attempt is not explicitly authorized.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_organization_id || chr(31) || v_mutation_id, 0));

  if (
    select count(*)
    from pg_trigger trigger_row
    join pg_class table_row on table_row.oid = trigger_row.tgrelid
    join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
    join pg_proc procedure_row on procedure_row.oid = trigger_row.tgfoid
    where not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'
      and namespace_row.nspname = 'public'
      and (
        (table_row.relname = 'app_state' and trigger_row.tgname = 'app_state_set_updated_at')
        or (table_row.relname = 'sessions' and trigger_row.tgname = 'sessions_set_updated_at')
      )
      and procedure_row.proname = 'set_updated_at'
      and encode(digest(pg_get_functiondef(procedure_row.oid), 'sha256'), 'hex') = v_expected_set_updated_at_hash
  ) <> 2 then
    raise exception using errcode = 'QA029', message = 'Expected staging updated_at trigger definitions changed; repair refused.';
  end if;

  perform 1
    from public.organization_members member_row
    where member_row.organization_id = v_organization_id
      and member_row.user_id = v_designated_maintenance_actor
      and member_row.active = true
      and member_row.role = 'admin'::public.app_role
    for share;
  if not found then
    raise exception using errcode = 'QA030', message = 'Expected staging repair actor is not an active admin.';
  end if;

  -- Match the documented operational RPC lock order: lock all involved sessions
  -- deterministically before reading either row into a working variable.
  perform 1
  from public.sessions
  where organization_id = v_organization_id
    and id in (v_source_session_id, v_rejected_consumer_id)
  order by id
  for update;

  select * into v_source
  from public.sessions
  where organization_id = v_organization_id and id = v_source_session_id;

  select * into v_consumer
  from public.sessions
  where organization_id = v_organization_id and id = v_rejected_consumer_id;

  select app_state.data, app_state.version
  into v_app_state_data, v_app_state_version
  from public.app_state
  where app_state.id = 'primary'
  for update;

  if v_source.id is null
    or v_source.status <> 'closed'
    or v_source.close_disposition is distinct from 'hopped'
    or v_source.closed_bill_id is not null
    or v_source.customer_name is distinct from 'QA Multi Hop Race 20260824183400'
    or v_source.station_name_snapshot is distinct from 'Playstation'
    or v_source.started_at is distinct from '2026-08-24T12:49:00+00:00'::timestamptz
    or v_source.ended_at is distinct from '2026-08-24T12:52:00+00:00'::timestamptz
  then
    raise exception using errcode = 'QA031', message = 'Quarantined source session no longer matches the reviewed state.';
  end if;

  if v_consumer.id is null
    or v_consumer.status <> 'closed'
    or v_consumer.close_disposition is distinct from 'rejected'
    or v_consumer.closed_bill_id is not null
    or v_consumer.customer_name is distinct from 'QA Multi Hop Race 20260824183400'
    or v_consumer.station_name_snapshot is distinct from 'Playstation'
    or v_consumer.started_at is distinct from '2026-08-24T13:01:19.238+00:00'::timestamptz
    or v_consumer.ended_at is distinct from '2026-08-24T13:01:39.879+00:00'::timestamptz
    or v_consumer.continued_from_session_ids is distinct from jsonb_build_array(v_source_session_id)
    or v_consumer.raw_data->'continuedFromSessionIds' is distinct from jsonb_build_array(v_source_session_id)
  then
    raise exception using errcode = 'QA032', message = 'Quarantined rejected consumer no longer matches the reviewed state.';
  end if;

  if v_app_state_data is null
    or v_app_state_version <> v_expected_app_state_version
    or encode(digest(v_app_state_data::text, 'sha256'), 'hex') <> v_expected_app_state_hash
  then
    raise exception using errcode = 'QA033', message = 'Compatibility state changed after the reviewed preflight.';
  end if;

  if (
    select count(*)
    from jsonb_array_elements(coalesce(v_app_state_data->'sessions', '[]'::jsonb)) session_entry
    where session_entry->>'id' = v_source_session_id
      and session_entry->>'status' = 'closed'
      and session_entry->>'closeDisposition' = 'hopped'
      and nullif(session_entry->>'closedBillId', '') is null
  ) <> 1 then
    raise exception using errcode = 'QA034', message = 'Compatibility source session does not match the reviewed quarantine.';
  end if;

  if (
    select count(*)
    from jsonb_array_elements(coalesce(v_app_state_data->'sessions', '[]'::jsonb)) session_entry
    where session_entry->>'id' = v_rejected_consumer_id
      and session_entry->>'status' = 'closed'
      and session_entry->>'closeDisposition' = 'rejected'
      and nullif(session_entry->>'closedBillId', '') is null
      and session_entry->'continuedFromSessionIds' = jsonb_build_array(v_source_session_id)
  ) <> 1 then
    raise exception using errcode = 'QA035', message = 'Compatibility rejected consumer does not match the reviewed quarantine.';
  end if;

  select session_entry
  into v_compatibility_consumer
  from jsonb_array_elements(coalesce(v_app_state_data->'sessions', '[]'::jsonb)) session_entry
  where session_entry->>'id' = v_rejected_consumer_id;

  if exists (
    select 1 from public.bill_lines
    where organization_id = v_organization_id
      and linked_session_id in (v_source_session_id, v_rejected_consumer_id)
  ) then
    raise exception using errcode = 'QA036', message = 'A quarantined session acquired a bill line; repair refused.';
  end if;

  select
    (select count(*) from public.sessions session_row
      where session_row.organization_id = v_organization_id
        and case when jsonb_typeof(coalesce(session_row.continued_from_session_ids, '[]'::jsonb)) = 'array'
          then coalesce(session_row.continued_from_session_ids, '[]'::jsonb) @> jsonb_build_array(v_source_session_id)
          else false end) +
    (select count(*) from public.customer_tabs tab_row
      where tab_row.organization_id = v_organization_id
        and case when jsonb_typeof(coalesce(tab_row.continued_from_session_ids, '[]'::jsonb)) = 'array'
          then coalesce(tab_row.continued_from_session_ids, '[]'::jsonb) @> jsonb_build_array(v_source_session_id)
          else false end)
  into v_reference_count;

  if v_reference_count <> 1 then
    raise exception using errcode = 'QA037', message = 'Quarantined source has an unexpected continuation reference count.';
  end if;

  if exists (select 1 from public.audit_logs where organization_id = v_organization_id and id = v_audit_id)
    or exists (select 1 from public.operational_events where id = v_event_id)
    or exists (
      select 1
      from jsonb_array_elements(coalesce(v_app_state_data->'auditLogs', '[]'::jsonb)) audit_entry
      where audit_entry->>'id' = v_audit_id
    )
    or exists (
      select 1 from public.operational_events
      where organization_id = v_organization_id and metadata->>'mutation_id' = v_mutation_id
    )
  then
    raise exception using errcode = 'QA038', message = 'Guarded repair identity is already in use.';
  end if;

  v_repaired_consumer := jsonb_set(v_consumer.raw_data, '{continuedFromSessionIds}', '[]'::jsonb, true);
  -- Patch the locked compatibility object itself. Never overwrite it with the
  -- normalized raw_data representation, which may omit compatibility-only fields.
  v_repaired_compatibility_consumer := jsonb_set(
    v_compatibility_consumer,
    '{continuedFromSessionIds}',
    '[]'::jsonb,
    true
  );
  v_audit := jsonb_build_object(
    'id', v_audit_id,
    'action', 'qa_continuation_repair',
    'entityType', 'session',
    'entityId', v_rejected_consumer_id,
    'message', 'Staging QA repair: designated maintenance actor released one stale hopped-session continuation from a closed rejected consumer.',
    'createdAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'userId', v_designated_maintenance_actor::text
  );

  update public.sessions
  set continued_from_session_ids = '[]'::jsonb,
      raw_data = v_repaired_consumer,
      updated_at = v_now
  where organization_id = v_organization_id and id = v_rejected_consumer_id;

  insert into public.audit_logs (
    organization_id, id, action, entity_type, entity_id, message, audit_at, user_id, raw_data
  ) values (
    v_organization_id, v_audit_id, v_audit->>'action', v_audit->>'entityType', v_audit->>'entityId',
    v_audit->>'message', v_now, v_designated_maintenance_actor::text, v_audit
  );

  v_next_app_state_data := jsonb_set(
    v_app_state_data,
    '{sessions}',
    public.patch_app_state_array_by_id(
      v_app_state_data->'sessions',
      jsonb_build_array(v_repaired_compatibility_consumer)
    ),
    true
  );
  v_next_app_state_data := jsonb_set(
    v_next_app_state_data,
    '{auditLogs}',
    public.patch_app_state_array_by_id(v_next_app_state_data->'auditLogs', jsonb_build_array(v_audit)),
    true
  );

  update public.app_state
  set data = v_next_app_state_data,
      version = v_app_state_version + 1,
      updated_at = v_now,
      updated_by = v_designated_maintenance_actor
  where id = 'primary';

  insert into public.operational_events (
    organization_id, id, event_type, entity_type, entity_id, created_by, created_at, metadata
  ) values (
    v_organization_id,
    v_event_id,
    'qa_continuation_repair',
    'session',
    v_rejected_consumer_id,
    v_designated_maintenance_actor::text,
    v_now,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', 'qaContinuationRepair',
      'actor_attribution', 'designated_staging_maintenance_actor',
      'released_continued_from_session_ids', jsonb_build_array(v_source_session_id),
      'app_state_version', v_app_state_version + 1,
      'changed_rows', jsonb_build_object(
        'sessions', jsonb_build_array(v_rejected_consumer_id),
        'audit_logs', jsonb_build_array(v_audit_id),
        'operational_events', jsonb_build_array(v_event_id)
      )
    )
  );

  if exists (
    select 1 from public.sessions
    where organization_id = v_organization_id and id = v_rejected_consumer_id
      and (
        continued_from_session_ids <> '[]'::jsonb
        or raw_data is distinct from v_repaired_consumer
      )
  ) or (
    select count(*) from jsonb_array_elements(
      coalesce((select data->'sessions' from public.app_state where id = 'primary'), '[]'::jsonb)
    ) session_entry
    where session_entry->>'id' = v_rejected_consumer_id
      and session_entry = v_repaired_compatibility_consumer
  ) <> 1 then
    raise exception using errcode = 'QA039', message = 'Guarded repair did not clear normalized and compatibility continuation links.';
  end if;

  if not exists (
    select 1
    from public.app_state
    where id = 'primary'
      and version = v_app_state_version + 1
      and data = v_next_app_state_data
      and updated_by = v_designated_maintenance_actor
      and updated_at = v_now
  ) then
    raise exception using errcode = 'QA040', message = 'Guarded repair compatibility state verification failed.';
  end if;

  if not exists (
    select 1
    from public.audit_logs
    where organization_id = v_organization_id
      and id = v_audit_id
      and action = v_audit->>'action'
      and entity_type = v_audit->>'entityType'
      and entity_id = v_audit->>'entityId'
      and message = v_audit->>'message'
      and audit_at = v_now
      and user_id = v_designated_maintenance_actor::text
      and raw_data = v_audit
  ) or (
    select count(*)
    from jsonb_array_elements(
      coalesce((select data->'auditLogs' from public.app_state where id = 'primary'), '[]'::jsonb)
    ) audit_entry
    where audit_entry = v_audit
  ) <> 1
  then
    raise exception using errcode = 'QA043', message = 'Guarded repair normalized or compatibility audit verification failed.';
  end if;

  if not exists (
    select 1
    from public.operational_events
    where organization_id = v_organization_id
      and id = v_event_id
      and event_type = 'qa_continuation_repair'
      and entity_type = 'session'
      and entity_id = v_rejected_consumer_id
      and created_by = v_designated_maintenance_actor::text
      and created_at = v_now
      and metadata->>'mutation_id' = v_mutation_id
      and metadata->>'mutation_kind' = 'qaContinuationRepair'
      and metadata->>'actor_attribution' = 'designated_staging_maintenance_actor'
      and metadata->'released_continued_from_session_ids' = jsonb_build_array(v_source_session_id)
      and (metadata->>'app_state_version')::integer = v_app_state_version + 1
      and metadata->'changed_rows' = jsonb_build_object(
        'sessions', jsonb_build_array(v_rejected_consumer_id),
        'audit_logs', jsonb_build_array(v_audit_id),
        'operational_events', jsonb_build_array(v_event_id)
      )
  ) then
    raise exception using errcode = 'QA041', message = 'Guarded repair operational event verification failed.';
  end if;

  if not exists (
    select 1
    from public.sessions
    where organization_id = v_organization_id
      and id = v_rejected_consumer_id
      and updated_at = v_now
  ) or not exists (
    select 1
    from public.organization_members member_row
    where member_row.organization_id = v_organization_id
      and member_row.user_id = v_designated_maintenance_actor
      and member_row.active = true
      and member_row.role = 'admin'::public.app_role
  ) then
    raise exception using errcode = 'QA042', message = 'Guarded repair timestamp or designated maintenance actor verification failed.';
  end if;
end;
$$;

commit;

select
  'passed' as repair_result,
  app_state.version as repaired_app_state_version,
  encode(digest(app_state.data::text, 'sha256'), 'hex') as repaired_app_state_sha256,
  session_row.continued_from_session_ids as normalized_continuation_ids,
  session_row.raw_data->'continuedFromSessionIds' as raw_continuation_ids,
  'audit-qa-continuation-repair-20260825-0015' as audit_id,
  'event-qa-continuation-repair-20260825-0015' as event_id
from public.app_state
join public.sessions session_row
  on session_row.organization_id = 'org-primary'
 and session_row.id = 'session-4f9e640d-877d-4817-a005-bc08e6d3a76c'
where app_state.id = 'primary';
