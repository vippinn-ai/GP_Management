-- Normalized-only maintenance actions that previously fell through full app-state saves.
-- Apply only after the phase-4 operational helpers/schema are installed.

alter table public.profiles
  add column if not exists tab_permissions jsonb;

create or replace function public.edit_pause_log(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org text := nullif(payload->>'organization_id', '');
  v_mutation_id text := nullif(payload->>'mutation_id', '');
  v_actor uuid := auth.uid();
  v_body jsonb := coalesce(payload->'payload', '{}'::jsonb);
  v_session_id text := nullif(v_body->>'sessionId', '');
  v_pause jsonb := coalesce(v_body->'pauseLog', '{}'::jsonb);
  v_pause_id text := nullif(v_pause->>'id', '');
  v_paused_at timestamptz := nullif(v_pause->>'pausedAt', '')::timestamptz;
  v_resumed_at timestamptz := nullif(v_pause->>'resumedAt', '')::timestamptz;
  v_audit jsonb := coalesce(v_body->'auditLog', '{}'::jsonb);
  v_session_started_at timestamptz;
  v_station_name text;
  v_audit_message text;
  v_event_at timestamptz := now();
  v_event_id text;
  v_existing jsonb;
begin
  if v_actor is null or v_org is null or not public.current_user_has_org_access(v_org)
    or nullif(payload->>'user_id', '') is distinct from v_actor::text
  then
    perform public.raise_operational_rpc_error('organization_access_denied', 'You do not have access to edit this pause log.', '{}'::jsonb);
  end if;
  if v_mutation_id is null or v_session_id is null or v_pause_id is null or v_paused_at is null
    or nullif(v_audit->>'id', '') is null or v_audit->>'entityId' <> v_session_id
    or v_audit->>'entityType' <> 'session' or v_audit->>'action' <> 'pause_log_edited'
  then
    perform public.raise_operational_rpc_error('invalid_payload', 'Pause-log edit data is incomplete.', '{}'::jsonb);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_org || ':' || v_mutation_id, 0));
  select jsonb_build_object(
    'mutation_id', metadata->>'mutation_id', 'organization_id', organization_id,
    'entity_type', entity_type, 'entity_id', entity_id, 'event_id', id,
    'server_time', created_at, 'changed_rows', metadata->'changed_rows'
  ) into v_existing
  from public.operational_events
  where organization_id = v_org and metadata->>'mutation_id' = v_mutation_id
  order by created_at desc limit 1;
  if v_existing is not null then return v_existing; end if;

  select started_at, station_name_snapshot into v_session_started_at, v_station_name
  from public.sessions where organization_id = v_org and id = v_session_id and status <> 'closed' for update;
  if not found then perform public.raise_operational_rpc_error('session_not_open', 'The session is no longer open.', '{}'::jsonb); end if;
  if v_session_started_at is not null and v_paused_at < v_session_started_at then
    perform public.raise_operational_rpc_error('invalid_pause_interval', 'Pause time cannot be before the session start time.', '{}'::jsonb);
  end if;
  perform 1 from public.session_pause_logs where organization_id = v_org and id = v_pause_id and session_id = v_session_id for update;
  if not found then perform public.raise_operational_rpc_error('pause_log_not_found', 'The pause log no longer exists.', '{}'::jsonb); end if;
  if v_resumed_at is not null and v_resumed_at <= v_paused_at then
    perform public.raise_operational_rpc_error('invalid_pause_interval', 'Resume time must be after pause time.', '{}'::jsonb);
  end if;
  if exists (
    select 1 from public.session_pause_logs
    where organization_id = v_org and session_id = v_session_id and id <> v_pause_id
      and v_paused_at < coalesce(resumed_at, 'infinity'::timestamptz)
      and paused_at < coalesce(v_resumed_at, 'infinity'::timestamptz)
  ) then
    perform public.raise_operational_rpc_error('pause_interval_overlap', 'Pause intervals cannot overlap.', '{}'::jsonb);
  end if;

  update public.session_pause_logs set
    paused_at = v_paused_at, resumed_at = v_resumed_at,
    raw_data = coalesce(raw_data, '{}'::jsonb) || jsonb_build_object('pausedAt', v_paused_at, 'resumedAt', v_resumed_at),
    updated_at = v_event_at
  where organization_id = v_org and id = v_pause_id;
  v_audit_message := 'Edited pause log entry for ' || coalesce(nullif(v_station_name, ''), 'session') || '.';
  insert into public.audit_logs (organization_id, id, action, entity_type, entity_id, message, audit_at, user_id, raw_data)
  values (v_org, v_audit->>'id', 'pause_log_edited', 'session', v_session_id, v_audit_message, v_event_at, v_actor::text,
    jsonb_build_object('id', v_audit->>'id', 'action', 'pause_log_edited', 'entityType', 'session', 'entityId', v_session_id, 'message', v_audit_message, 'createdAt', v_event_at, 'userId', v_actor::text));
  insert into public.operational_events (organization_id, event_type, entity_type, entity_id, created_by, metadata)
  values (v_org, 'edit_pause_log', 'session', v_session_id, v_actor::text,
    jsonb_build_object('mutation_id', v_mutation_id, 'changed_rows', jsonb_build_object('sessions', jsonb_build_array(v_session_id), 'session_pause_logs', jsonb_build_array(v_pause_id), 'audit_logs', jsonb_build_array(v_audit->>'id'))))
  returning id into v_event_id;
  return jsonb_build_object('mutation_id', v_mutation_id, 'organization_id', v_org, 'entity_type', 'session', 'entity_id', v_session_id, 'event_id', v_event_id, 'server_time', v_event_at, 'changed_rows', jsonb_build_object('sessions', jsonb_build_array(v_session_id), 'session_pause_logs', jsonb_build_array(v_pause_id), 'audit_logs', jsonb_build_array(v_audit->>'id')));
end;
$$;

create or replace function public.delete_pause_log(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org text := nullif(payload->>'organization_id', '');
  v_mutation_id text := nullif(payload->>'mutation_id', '');
  v_actor uuid := auth.uid();
  v_body jsonb := coalesce(payload->'payload', '{}'::jsonb);
  v_session_id text := nullif(v_body->>'sessionId', '');
  v_pause_id text := nullif(v_body->>'pauseLogId', '');
  v_audit jsonb := coalesce(v_body->'auditLog', '{}'::jsonb);
  v_was_open boolean;
  v_station_name text;
  v_audit_message text;
  v_event_at timestamptz := now();
  v_event_id text;
  v_existing jsonb;
begin
  if v_actor is null or v_org is null or not public.current_user_has_org_access(v_org)
    or nullif(payload->>'user_id', '') is distinct from v_actor::text
  then perform public.raise_operational_rpc_error('organization_access_denied', 'You do not have access to delete this pause log.', '{}'::jsonb); end if;
  if v_mutation_id is null or v_session_id is null or v_pause_id is null or nullif(v_audit->>'id', '') is null or v_audit->>'entityId' <> v_session_id
    or v_audit->>'entityType' <> 'session' or v_audit->>'action' <> 'pause_log_deleted'
  then perform public.raise_operational_rpc_error('invalid_payload', 'Pause-log delete data is incomplete.', '{}'::jsonb); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_org || ':' || v_mutation_id, 0));
  select jsonb_build_object('mutation_id', metadata->>'mutation_id', 'organization_id', organization_id, 'entity_type', entity_type, 'entity_id', entity_id, 'event_id', id, 'server_time', created_at, 'changed_rows', metadata->'changed_rows') into v_existing
  from public.operational_events where organization_id = v_org and metadata->>'mutation_id' = v_mutation_id order by created_at desc limit 1;
  if v_existing is not null then return v_existing; end if;
  select station_name_snapshot into v_station_name from public.sessions where organization_id = v_org and id = v_session_id and status <> 'closed' for update;
  if not found then perform public.raise_operational_rpc_error('session_not_open', 'The session is no longer open.', '{}'::jsonb); end if;
  select resumed_at is null into v_was_open from public.session_pause_logs where organization_id = v_org and id = v_pause_id and session_id = v_session_id for update;
  if not found then perform public.raise_operational_rpc_error('pause_log_not_found', 'The pause log no longer exists.', '{}'::jsonb); end if;
  delete from public.session_pause_logs where organization_id = v_org and id = v_pause_id;
  update public.sessions set
    pause_log_ids = coalesce((select jsonb_agg(value) from jsonb_array_elements_text(coalesce(pause_log_ids, '[]'::jsonb)) as source(value) where value <> v_pause_id), '[]'::jsonb),
    status = case when v_was_open and status = 'paused' then 'active' else status end,
    raw_data = jsonb_set(jsonb_set(coalesce(raw_data, '{}'::jsonb), '{pauseLogIds}', coalesce((select jsonb_agg(value) from jsonb_array_elements_text(coalesce(pause_log_ids, '[]'::jsonb)) as source(value) where value <> v_pause_id), '[]'::jsonb), true), '{status}', to_jsonb(case when v_was_open and status = 'paused' then 'active' else status end), true),
    updated_at = v_event_at
  where organization_id = v_org and id = v_session_id;
  v_audit_message := 'Deleted pause log entry for ' || coalesce(nullif(v_station_name, ''), 'session') || '.';
  insert into public.audit_logs (organization_id, id, action, entity_type, entity_id, message, audit_at, user_id, raw_data)
  values (v_org, v_audit->>'id', 'pause_log_deleted', 'session', v_session_id, v_audit_message, v_event_at, v_actor::text,
    jsonb_build_object('id', v_audit->>'id', 'action', 'pause_log_deleted', 'entityType', 'session', 'entityId', v_session_id, 'message', v_audit_message, 'createdAt', v_event_at, 'userId', v_actor::text));
  insert into public.operational_events (organization_id, event_type, entity_type, entity_id, created_by, metadata)
  values (v_org, 'delete_pause_log', 'session', v_session_id, v_actor::text, jsonb_build_object('mutation_id', v_mutation_id, 'changed_rows', jsonb_build_object('sessions', jsonb_build_array(v_session_id), 'session_pause_logs', jsonb_build_array(v_pause_id), 'audit_logs', jsonb_build_array(v_audit->>'id')))) returning id into v_event_id;
  return jsonb_build_object('mutation_id', v_mutation_id, 'organization_id', v_org, 'entity_type', 'session', 'entity_id', v_session_id, 'event_id', v_event_id, 'server_time', v_event_at, 'changed_rows', jsonb_build_object('sessions', jsonb_build_array(v_session_id), 'session_pause_logs', jsonb_build_array(v_pause_id), 'audit_logs', jsonb_build_array(v_audit->>'id')));
end;
$$;

create or replace function public.record_session_audit(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org text := nullif(payload->>'organization_id', '');
  v_mutation_id text := nullif(payload->>'mutation_id', '');
  v_session_id text := nullif(payload->>'entity_id', '');
  v_actor uuid := auth.uid();
  v_audit jsonb := coalesce(payload #> '{payload,auditLog}', '{}'::jsonb);
  v_station_name text;
  v_audit_message text;
  v_event_at timestamptz := now();
  v_event_id text;
  v_existing jsonb;
begin
  if v_actor is null or v_org is null or not public.current_user_has_org_access(v_org)
    or nullif(payload->>'user_id', '') is distinct from v_actor::text
  then perform public.raise_operational_rpc_error('organization_access_denied', 'You do not have access to record this session action.', '{}'::jsonb); end if;
  if v_mutation_id is null or v_session_id is null or nullif(v_audit->>'id', '') is null or v_audit->>'entityId' <> v_session_id
    or v_audit->>'entityType' <> 'session' or v_audit->>'action' <> 'hop_continuation_detached'
  then perform public.raise_operational_rpc_error('invalid_payload', 'Session audit data is incomplete.', '{}'::jsonb); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_org || ':' || v_mutation_id, 0));
  select jsonb_build_object('mutation_id', metadata->>'mutation_id', 'organization_id', organization_id, 'entity_type', entity_type, 'entity_id', entity_id, 'event_id', id, 'server_time', created_at, 'changed_rows', metadata->'changed_rows') into v_existing
  from public.operational_events where organization_id = v_org and metadata->>'mutation_id' = v_mutation_id order by created_at desc limit 1;
  if v_existing is not null then return v_existing; end if;
  select station_name_snapshot into v_station_name from public.sessions where organization_id = v_org and id = v_session_id for update;
  if not found then perform public.raise_operational_rpc_error('session_not_found', 'The session no longer exists.', '{}'::jsonb); end if;
  v_audit_message := 'Detached post-hop continuation from ' || coalesce(nullif(v_station_name, ''), 'session') || '.';
  insert into public.audit_logs (organization_id, id, action, entity_type, entity_id, message, audit_at, user_id, raw_data)
  values (v_org, v_audit->>'id', 'hop_continuation_detached', 'session', v_session_id, v_audit_message, v_event_at, v_actor::text,
    jsonb_build_object('id', v_audit->>'id', 'action', 'hop_continuation_detached', 'entityType', 'session', 'entityId', v_session_id, 'message', v_audit_message, 'createdAt', v_event_at, 'userId', v_actor::text));
  insert into public.operational_events (organization_id, event_type, entity_type, entity_id, created_by, metadata)
  values (v_org, 'record_session_audit', 'session', v_session_id, v_actor::text, jsonb_build_object('mutation_id', v_mutation_id, 'changed_rows', jsonb_build_object('audit_logs', jsonb_build_array(v_audit->>'id')))) returning id into v_event_id;
  return jsonb_build_object('mutation_id', v_mutation_id, 'organization_id', v_org, 'entity_type', 'session', 'entity_id', v_session_id, 'event_id', v_event_id, 'server_time', v_event_at, 'changed_rows', jsonb_build_object('audit_logs', jsonb_build_array(v_audit->>'id')));
end;
$$;

revoke all on function public.edit_pause_log(jsonb) from public, anon;
revoke all on function public.delete_pause_log(jsonb) from public, anon;
revoke all on function public.record_session_audit(jsonb) from public, anon;
grant execute on function public.edit_pause_log(jsonb) to authenticated;
grant execute on function public.delete_pause_log(jsonb) to authenticated;
grant execute on function public.record_session_audit(jsonb) to authenticated;
