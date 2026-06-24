-- Phase 4 normalized write RPC for game-hop session closes.
--
-- Run after phase4-reject-rpcs.sql so patch_app_state_array_by_id and
-- raise_operational_rpc_error already exist.

create or replace function public.hop_session(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started_at timestamptz := clock_timestamp();
  v_organization_id text := nullif(payload->>'organization_id', '');
  v_mutation_id text := nullif(payload->>'mutation_id', '');
  v_mutation_kind text := nullif(payload->>'mutation_kind', '');
  v_user_id text := nullif(payload->>'user_id', '');
  v_expected_version integer := nullif(payload->>'base_app_state_version', '')::integer;
  v_session jsonb := coalesce(payload #> '{payload,session}', '{}'::jsonb);
  v_pause_log jsonb := payload #> '{payload,pauseLog}';
  v_audit_log jsonb := payload #> '{payload,auditLog}';
  v_session_id text := nullif(v_session->>'id', '');
  v_pause_log_id text := nullif(v_pause_log->>'id', '');
  v_audit_log_id text := nullif(v_audit_log->>'id', '');
  v_event_id text;
  v_event_metadata jsonb := '{}'::jsonb;
  v_app_state_data jsonb;
  v_next_app_state_data jsonb;
  v_app_state_version integer;
  v_next_app_state_version integer;
  v_updated_by uuid;
  v_current_status text;
  v_server_duration_ms numeric;
  v_changed_rows jsonb;
begin
  if v_organization_id is null then
    perform public.raise_operational_rpc_error('invalid_payload', 'The operational change is missing an organization.', '{}'::jsonb);
  end if;

  if not (select public.current_user_has_org_access(v_organization_id)) then
    perform public.raise_operational_rpc_error(
      'organization_access_denied',
      'You do not have access to this organization.',
      jsonb_build_object('organization_id', v_organization_id)
    );
  end if;

  if v_mutation_id is null or v_mutation_kind <> 'hopSession' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The hop session payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_session_id is null or v_session->>'status' <> 'closed' or v_session->>'closeDisposition' <> 'hopped' then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The hop session payload is missing a closed hopped session.',
      jsonb_build_object('session_id', v_session_id)
    );
  end if;

  select operational_events.id, operational_events.metadata
  into v_event_id, v_event_metadata
  from public.operational_events
  where operational_events.organization_id = v_organization_id
    and operational_events.metadata->>'mutation_id' = v_mutation_id
  order by operational_events.created_at desc
  limit 1;

  if v_event_id is not null then
    return jsonb_build_object(
      'mutation_id', v_mutation_id,
      'organization_id', v_organization_id,
      'entity_type', 'session',
      'entity_id', v_session_id,
      'app_state_version', nullif(v_event_metadata->>'app_state_version', '')::integer,
      'event_id', v_event_id,
      'server_time', timezone('utc', now()),
      'server_duration_ms', nullif(v_event_metadata->>'server_duration_ms', '')::numeric,
      'idempotent', true,
      'changed_rows', coalesce(v_event_metadata->'changed_rows', '{}'::jsonb)
    );
  end if;

  perform pg_advisory_xact_lock(hashtext(v_organization_id || ':hop-session:' || v_session_id));

  select app_state.data, app_state.version
  into v_app_state_data, v_app_state_version
  from public.app_state
  where app_state.id = 'primary'
  for update;

  if v_app_state_data is null then
    perform public.raise_operational_rpc_error('app_state_missing', 'App state is not initialized.', '{}'::jsonb);
  end if;

  if v_expected_version is not null and v_app_state_version <> v_expected_version then
    perform public.raise_operational_rpc_error(
      'app_state_conflict',
      'Remote data changed in another browser. Refreshing latest data.',
      jsonb_build_object('expected_version', v_expected_version, 'actual_version', v_app_state_version)
    );
  end if;

  select sessions.status
  into v_current_status
  from public.sessions
  where sessions.organization_id = v_organization_id
    and sessions.id = v_session_id
  for update;

  if v_current_status is null or v_current_status = 'closed' then
    perform public.raise_operational_rpc_error(
      'session_not_open',
      'The session is no longer open.',
      jsonb_build_object('session_id', v_session_id)
    );
  end if;

  update public.sessions
  set
    ended_at = nullif(v_session->>'endedAt', '')::timestamptz,
    status = 'closed',
    closed_bill_id = nullif(v_session->>'closedBillId', ''),
    close_disposition = 'hopped',
    close_reason = null,
    raw_data = v_session,
    updated_at = timezone('utc', now())
  where sessions.organization_id = v_organization_id
    and sessions.id = v_session_id;

  if jsonb_typeof(v_pause_log) = 'object' and v_pause_log_id is not null then
    insert into public.session_pause_logs (
      organization_id,
      id,
      session_id,
      paused_at,
      resumed_at,
      raw_data
    )
    values (
      v_organization_id,
      v_pause_log_id,
      v_session_id,
      nullif(v_pause_log->>'pausedAt', '')::timestamptz,
      nullif(v_pause_log->>'resumedAt', '')::timestamptz,
      v_pause_log
    )
    on conflict (organization_id, id) do update
    set
      resumed_at = excluded.resumed_at,
      raw_data = excluded.raw_data,
      updated_at = timezone('utc', now());
  end if;

  if jsonb_typeof(v_audit_log) = 'object' and v_audit_log_id is not null then
    insert into public.audit_logs (
      organization_id,
      id,
      action,
      entity_type,
      entity_id,
      message,
      audit_at,
      user_id,
      raw_data
    )
    values (
      v_organization_id,
      v_audit_log_id,
      coalesce(nullif(v_audit_log->>'action', ''), 'session_hopped'),
      nullif(v_audit_log->>'entityType', ''),
      nullif(v_audit_log->>'entityId', ''),
      nullif(v_audit_log->>'message', ''),
      nullif(v_audit_log->>'createdAt', '')::timestamptz,
      nullif(v_audit_log->>'userId', ''),
      v_audit_log
    )
    on conflict (organization_id, id) do nothing;
  end if;

  v_next_app_state_data := coalesce(v_app_state_data, '{}'::jsonb);
  v_next_app_state_data := jsonb_set(
    v_next_app_state_data,
    '{sessions}',
    public.patch_app_state_array_by_id(v_next_app_state_data->'sessions', jsonb_build_array(v_session)),
    true
  );
  if jsonb_typeof(v_pause_log) = 'object' and v_pause_log_id is not null then
    v_next_app_state_data := jsonb_set(
      v_next_app_state_data,
      '{sessionPauseLogs}',
      public.patch_app_state_array_by_id(v_next_app_state_data->'sessionPauseLogs', jsonb_build_array(v_pause_log)),
      true
    );
  end if;
  if jsonb_typeof(v_audit_log) = 'object' and v_audit_log_id is not null then
    v_next_app_state_data := jsonb_set(
      v_next_app_state_data,
      '{auditLogs}',
      public.patch_app_state_array_by_id(v_next_app_state_data->'auditLogs', jsonb_build_array(v_audit_log)),
      true
    );
  end if;

  if v_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_updated_by := v_user_id::uuid;
  end if;

  update public.app_state
  set
    data = v_next_app_state_data,
    version = v_app_state_version + 1,
    updated_at = timezone('utc', now()),
    updated_by = v_updated_by
  where app_state.id = 'primary'
  returning app_state.version into v_next_app_state_version;

  v_server_duration_ms := round((extract(epoch from (clock_timestamp() - v_started_at)) * 1000)::numeric, 3);
  v_changed_rows := jsonb_build_object(
    'sessions', jsonb_build_array(v_session_id),
    'session_pause_logs', case when v_pause_log_id is null then '[]'::jsonb else jsonb_build_array(v_pause_log_id) end,
    'audit_logs', case when v_audit_log_id is null then '[]'::jsonb else jsonb_build_array(v_audit_log_id) end
  );

  insert into public.operational_events (
    organization_id,
    event_type,
    entity_type,
    entity_id,
    created_by,
    metadata
  )
  values (
    v_organization_id,
    'hop_session',
    'session',
    v_session_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'app_state_version', v_next_app_state_version,
      'server_duration_ms', v_server_duration_ms,
      'changed_rows', v_changed_rows
    )
  )
  returning id into v_event_id;

  return jsonb_build_object(
    'mutation_id', v_mutation_id,
    'organization_id', v_organization_id,
    'entity_type', 'session',
    'entity_id', v_session_id,
    'app_state_version', v_next_app_state_version,
    'event_id', v_event_id,
    'server_time', timezone('utc', now()),
    'server_duration_ms', v_server_duration_ms,
    'changed_rows', v_changed_rows || jsonb_build_object('operational_events', jsonb_build_array(v_event_id))
  );
end;
$$;

revoke all on function public.hop_session(jsonb) from public;
revoke execute on function public.hop_session(jsonb) from anon;
grant execute on function public.hop_session(jsonb) to authenticated;

