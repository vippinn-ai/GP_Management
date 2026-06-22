-- Phase 4 normalized write RPCs for rejecting live sessions/customer tabs.
--
-- Run after the base Phase 4 RPC scripts. This script also creates the
-- compatibility patch helper used by Phase 5 so it is safe to run in projects
-- where Phase 5 has not been installed yet.

create or replace function public.patch_app_state_array_by_id(
  target_array jsonb,
  patch_array jsonb
)
returns jsonb
language sql
as $$
  with target_entries as (
    select
      item.value,
      item.ordinality,
      nullif(item.value->>'id', '') as id
    from jsonb_array_elements(
      case when jsonb_typeof(target_array) = 'array' then target_array else '[]'::jsonb end
    ) with ordinality as item(value, ordinality)
  ),
  patch_entries as (
    select
      item.value,
      item.ordinality,
      nullif(item.value->>'id', '') as id
    from jsonb_array_elements(
      case when jsonb_typeof(patch_array) = 'array' then patch_array else '[]'::jsonb end
    ) with ordinality as item(value, ordinality)
  ),
  first_patch_by_id as (
    select distinct on (id)
      id,
      value
    from patch_entries
    where id is not null
    order by id, ordinality
  ),
  target_ids as (
    select distinct id
    from target_entries
    where id is not null
  ),
  missing_patches as (
    select
      0 as section_order,
      patch_entries.ordinality,
      patch_entries.value
    from patch_entries
    where patch_entries.id is not null
      and not exists (
        select 1
        from target_ids
        where target_ids.id = patch_entries.id
      )
  ),
  patched_target as (
    select
      1 as section_order,
      target_entries.ordinality,
      coalesce(first_patch_by_id.value, target_entries.value) as value
    from target_entries
    left join first_patch_by_id
      on first_patch_by_id.id = target_entries.id
  ),
  combined_entries as (
    select section_order, ordinality, value from missing_patches
    union all
    select section_order, ordinality, value from patched_target
  )
  select coalesce(jsonb_agg(value order by section_order, ordinality), '[]'::jsonb)
  from combined_entries;
$$;

revoke all on function public.patch_app_state_array_by_id(jsonb, jsonb) from public;
revoke execute on function public.patch_app_state_array_by_id(jsonb, jsonb) from anon;
revoke execute on function public.patch_app_state_array_by_id(jsonb, jsonb) from authenticated;

create or replace function public.reject_session(payload jsonb)
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

  if v_mutation_id is null or v_mutation_kind <> 'rejectSession' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The reject session payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_session_id is null or v_session->>'status' <> 'closed' or v_session->>'closeDisposition' <> 'rejected' then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The reject session payload is missing a closed rejected session.',
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

  perform pg_advisory_xact_lock(hashtext(v_organization_id || ':reject-session:' || v_session_id));

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
    close_disposition = 'rejected',
    close_reason = nullif(v_session->>'closeReason', ''),
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
      coalesce(nullif(v_audit_log->>'action', ''), 'session_rejected'),
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
    'reject_session',
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

revoke all on function public.reject_session(jsonb) from public;
revoke execute on function public.reject_session(jsonb) from anon;
grant execute on function public.reject_session(jsonb) to authenticated;

create or replace function public.reject_customer_tab(payload jsonb)
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
  v_tab jsonb := coalesce(payload #> '{payload,tab}', '{}'::jsonb);
  v_audit_log jsonb := payload #> '{payload,auditLog}';
  v_customer_tab_id text := nullif(v_tab->>'id', '');
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

  if v_mutation_id is null or v_mutation_kind <> 'rejectCustomerTab' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The reject customer tab payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_customer_tab_id is null or v_tab->>'status' <> 'closed' or v_tab->>'closeDisposition' <> 'rejected' then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The reject customer tab payload is missing a closed rejected tab.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id)
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
      'entity_type', 'customer_tab',
      'entity_id', v_customer_tab_id,
      'app_state_version', nullif(v_event_metadata->>'app_state_version', '')::integer,
      'event_id', v_event_id,
      'server_time', timezone('utc', now()),
      'server_duration_ms', nullif(v_event_metadata->>'server_duration_ms', '')::numeric,
      'idempotent', true,
      'changed_rows', coalesce(v_event_metadata->'changed_rows', '{}'::jsonb)
    );
  end if;

  perform pg_advisory_xact_lock(hashtext(v_organization_id || ':reject-customer-tab:' || v_customer_tab_id));

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

  select customer_tabs.status
  into v_current_status
  from public.customer_tabs
  where customer_tabs.organization_id = v_organization_id
    and customer_tabs.id = v_customer_tab_id
  for update;

  if v_current_status is null or v_current_status <> 'open' then
    perform public.raise_operational_rpc_error(
      'customer_tab_not_open',
      'The customer tab is no longer open.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id)
    );
  end if;

  update public.customer_tabs
  set
    status = 'closed',
    closed_at = nullif(v_tab->>'closedAt', '')::timestamptz,
    closed_bill_id = nullif(v_tab->>'closedBillId', ''),
    close_disposition = 'rejected',
    close_reason = nullif(v_tab->>'closeReason', ''),
    raw_data = v_tab,
    updated_at = timezone('utc', now())
  where customer_tabs.organization_id = v_organization_id
    and customer_tabs.id = v_customer_tab_id;

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
      coalesce(nullif(v_audit_log->>'action', ''), 'customer_tab_rejected'),
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
    '{customerTabs}',
    public.patch_app_state_array_by_id(v_next_app_state_data->'customerTabs', jsonb_build_array(v_tab)),
    true
  );
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
    'customer_tabs', jsonb_build_array(v_customer_tab_id),
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
    'reject_customer_tab',
    'customer_tab',
    v_customer_tab_id,
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
    'entity_type', 'customer_tab',
    'entity_id', v_customer_tab_id,
    'app_state_version', v_next_app_state_version,
    'event_id', v_event_id,
    'server_time', timezone('utc', now()),
    'server_duration_ms', v_server_duration_ms,
    'changed_rows', v_changed_rows || jsonb_build_object('operational_events', jsonb_build_array(v_event_id))
  );
end;
$$;

revoke all on function public.reject_customer_tab(jsonb) from public;
revoke execute on function public.reject_customer_tab(jsonb) from anon;
grant execute on function public.reject_customer_tab(jsonb) to authenticated;
