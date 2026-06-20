-- Phase 4 normalized write RPCs: pause_session and resume_session.
--
-- Run after supabase/phase4-start-session-rpc.sql because these functions
-- reuse public.raise_operational_rpc_error.

create or replace function public.pause_session(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id text := nullif(payload->>'organization_id', '');
  v_mutation_id text := nullif(payload->>'mutation_id', '');
  v_mutation_kind text := nullif(payload->>'mutation_kind', '');
  v_user_id text := nullif(payload->>'user_id', '');
  v_session_id text := nullif(payload #>> '{payload,sessionId}', '');
  v_pause_log jsonb := coalesce(payload #> '{payload,pauseLog}', '{}'::jsonb);
  v_audit_log jsonb := coalesce(payload #> '{payload,auditLog}', '{}'::jsonb);
  v_pause_log_id text := nullif(v_pause_log->>'id', '');
  v_paused_at timestamptz := nullif(v_pause_log->>'pausedAt', '')::timestamptz;
  v_session_status text;
  v_pause_log_ids jsonb;
  v_event_id text;
  v_event_metadata jsonb := '{}'::jsonb;
  v_audit_log_id text := nullif(v_audit_log->>'id', '');
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

  if v_mutation_id is null or v_mutation_kind <> 'pauseSession' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_session_id is null or v_pause_log_id is null or v_paused_at is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The pause payload is missing a session, pause log, or pause time.',
      jsonb_build_object('session_id', v_session_id, 'pause_log_id', v_pause_log_id)
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
      'event_id', v_event_id,
      'server_time', timezone('utc', now()),
      'idempotent', true,
      'changed_rows', jsonb_build_object(
        'sessions', jsonb_build_array(v_session_id),
        'session_pause_logs', jsonb_build_array(coalesce(v_event_metadata->>'pause_log_id', v_pause_log_id)),
        'audit_logs', case
          when coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id))
        end,
        'operational_events', jsonb_build_array(v_event_id)
      )
    );
  end if;

  select sessions.status, coalesce(sessions.pause_log_ids, '[]'::jsonb)
  into v_session_status, v_pause_log_ids
  from public.sessions
  where sessions.organization_id = v_organization_id
    and sessions.id = v_session_id
  for update;

  if v_session_status is null or v_session_status = 'closed' then
    perform public.raise_operational_rpc_error(
      'session_not_open',
      'The session is no longer open.',
      jsonb_build_object('session_id', v_session_id)
    );
  end if;

  if v_session_status <> 'active' and not (v_pause_log_ids ? v_pause_log_id) then
    perform public.raise_operational_rpc_error(
      'session_not_active',
      'The session is not active.',
      jsonb_build_object('session_id', v_session_id, 'status', v_session_status)
    );
  end if;

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
    v_paused_at,
    nullif(v_pause_log->>'resumedAt', '')::timestamptz,
    v_pause_log
  )
  on conflict (organization_id, id) do nothing;

  if not (v_pause_log_ids ? v_pause_log_id) then
    v_pause_log_ids := v_pause_log_ids || jsonb_build_array(v_pause_log_id);
  end if;

  update public.sessions
  set
    status = 'paused',
    pause_log_ids = v_pause_log_ids,
    raw_data = jsonb_set(
      jsonb_set(coalesce(raw_data, '{}'::jsonb), '{status}', to_jsonb('paused'::text), true),
      '{pauseLogIds}',
      v_pause_log_ids,
      true
    ),
    updated_at = timezone('utc', now())
  where sessions.organization_id = v_organization_id
    and sessions.id = v_session_id;

  if v_audit_log_id is not null then
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
      coalesce(nullif(v_audit_log->>'action', ''), 'session_paused'),
      nullif(v_audit_log->>'entityType', ''),
      nullif(v_audit_log->>'entityId', ''),
      nullif(v_audit_log->>'message', ''),
      nullif(v_audit_log->>'createdAt', '')::timestamptz,
      nullif(v_audit_log->>'userId', ''),
      v_audit_log
    )
    on conflict (organization_id, id) do nothing;
  end if;

  if v_event_id is null then
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
      'pause_session',
      'session',
      v_session_id,
      v_user_id,
      jsonb_build_object(
        'mutation_id', v_mutation_id,
        'mutation_kind', v_mutation_kind,
        'pause_log_id', v_pause_log_id,
        'audit_log_id', v_audit_log_id
      )
    )
    returning id into v_event_id;
  end if;

  return jsonb_build_object(
    'mutation_id', v_mutation_id,
    'organization_id', v_organization_id,
    'entity_type', 'session',
    'entity_id', v_session_id,
    'event_id', v_event_id,
    'server_time', timezone('utc', now()),
    'changed_rows', jsonb_build_object(
      'sessions', jsonb_build_array(v_session_id),
      'session_pause_logs', jsonb_build_array(v_pause_log_id),
      'audit_logs', case when v_audit_log_id is null then '[]'::jsonb else jsonb_build_array(v_audit_log_id) end,
      'operational_events', case when v_event_id is null then '[]'::jsonb else jsonb_build_array(v_event_id) end
    )
  );
end;
$$;

revoke all on function public.pause_session(jsonb) from public;
revoke execute on function public.pause_session(jsonb) from anon;
grant execute on function public.pause_session(jsonb) to authenticated;

create or replace function public.resume_session(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id text := nullif(payload->>'organization_id', '');
  v_mutation_id text := nullif(payload->>'mutation_id', '');
  v_mutation_kind text := nullif(payload->>'mutation_kind', '');
  v_user_id text := nullif(payload->>'user_id', '');
  v_session_id text := nullif(payload #>> '{payload,sessionId}', '');
  v_pause_log_id text := nullif(payload #>> '{payload,pauseLogId}', '');
  v_resumed_at_text text := nullif(payload #>> '{payload,resumedAt}', '');
  v_resumed_at timestamptz := v_resumed_at_text::timestamptz;
  v_audit_log jsonb := coalesce(payload #> '{payload,auditLog}', '{}'::jsonb);
  v_session_status text;
  v_resolved_pause_log_id text;
  v_event_id text;
  v_event_metadata jsonb := '{}'::jsonb;
  v_audit_log_id text := nullif(v_audit_log->>'id', '');
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

  if v_mutation_id is null or v_mutation_kind <> 'resumeSession' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_session_id is null or v_resumed_at is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The resume payload is missing a session or resume time.',
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
      'event_id', v_event_id,
      'server_time', timezone('utc', now()),
      'idempotent', true,
      'changed_rows', jsonb_build_object(
        'sessions', jsonb_build_array(v_session_id),
        'session_pause_logs', case
          when coalesce(v_event_metadata->>'pause_log_id', v_pause_log_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'pause_log_id', v_pause_log_id))
        end,
        'audit_logs', case
          when coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id))
        end,
        'operational_events', jsonb_build_array(v_event_id)
      )
    );
  end if;

  select sessions.status
  into v_session_status
  from public.sessions
  where sessions.organization_id = v_organization_id
    and sessions.id = v_session_id
  for update;

  if v_session_status is null or v_session_status = 'closed' then
    perform public.raise_operational_rpc_error(
      'session_not_open',
      'The session is no longer open.',
      jsonb_build_object('session_id', v_session_id)
    );
  end if;

  if v_session_status not in ('paused', 'active') then
    perform public.raise_operational_rpc_error(
      'session_cannot_resume',
      'The session cannot be resumed.',
      jsonb_build_object('session_id', v_session_id, 'status', v_session_status)
    );
  end if;

  if v_pause_log_id is not null then
    select session_pause_logs.id
    into v_resolved_pause_log_id
    from public.session_pause_logs
    where session_pause_logs.organization_id = v_organization_id
      and session_pause_logs.id = v_pause_log_id
      and session_pause_logs.session_id = v_session_id
    for update;
  end if;

  if v_resolved_pause_log_id is null then
    select session_pause_logs.id
    into v_resolved_pause_log_id
    from public.session_pause_logs
    where session_pause_logs.organization_id = v_organization_id
      and session_pause_logs.session_id = v_session_id
      and session_pause_logs.resumed_at is null
    order by session_pause_logs.paused_at desc nulls last, session_pause_logs.created_at desc
    limit 1
    for update;
  end if;

  if v_resolved_pause_log_id is not null then
    update public.session_pause_logs
    set
      resumed_at = coalesce(resumed_at, v_resumed_at),
      raw_data = jsonb_set(coalesce(raw_data, '{}'::jsonb), '{resumedAt}', to_jsonb(v_resumed_at_text), true),
      updated_at = timezone('utc', now())
    where session_pause_logs.organization_id = v_organization_id
      and session_pause_logs.id = v_resolved_pause_log_id;
  end if;

  update public.sessions
  set
    status = 'active',
    raw_data = jsonb_set(coalesce(raw_data, '{}'::jsonb), '{status}', to_jsonb('active'::text), true),
    updated_at = timezone('utc', now())
  where sessions.organization_id = v_organization_id
    and sessions.id = v_session_id;

  if v_audit_log_id is not null then
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
      coalesce(nullif(v_audit_log->>'action', ''), 'session_resumed'),
      nullif(v_audit_log->>'entityType', ''),
      nullif(v_audit_log->>'entityId', ''),
      nullif(v_audit_log->>'message', ''),
      nullif(v_audit_log->>'createdAt', '')::timestamptz,
      nullif(v_audit_log->>'userId', ''),
      v_audit_log
    )
    on conflict (organization_id, id) do nothing;
  end if;

  if v_event_id is null then
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
      'resume_session',
      'session',
      v_session_id,
      v_user_id,
      jsonb_build_object(
        'mutation_id', v_mutation_id,
        'mutation_kind', v_mutation_kind,
        'pause_log_id', v_resolved_pause_log_id,
        'audit_log_id', v_audit_log_id
      )
    )
    returning id into v_event_id;
  end if;

  return jsonb_build_object(
    'mutation_id', v_mutation_id,
    'organization_id', v_organization_id,
    'entity_type', 'session',
    'entity_id', v_session_id,
    'event_id', v_event_id,
    'server_time', timezone('utc', now()),
    'changed_rows', jsonb_build_object(
      'sessions', jsonb_build_array(v_session_id),
      'session_pause_logs', case when v_resolved_pause_log_id is null then '[]'::jsonb else jsonb_build_array(v_resolved_pause_log_id) end,
      'audit_logs', case when v_audit_log_id is null then '[]'::jsonb else jsonb_build_array(v_audit_log_id) end,
      'operational_events', case when v_event_id is null then '[]'::jsonb else jsonb_build_array(v_event_id) end
    )
  );
end;
$$;

revoke all on function public.resume_session(jsonb) from public;
revoke execute on function public.resume_session(jsonb) from anon;
grant execute on function public.resume_session(jsonb) to authenticated;
