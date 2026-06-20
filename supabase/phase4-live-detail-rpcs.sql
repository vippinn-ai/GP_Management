-- Phase 4 normalized write RPCs for live session/customer tab detail edits.
--
-- Run after supabase/phase4-customer-tab-rpcs.sql because these functions
-- reuse public.resolve_operational_customer and public.raise_operational_rpc_error.

create or replace function public.save_live_session_details(payload jsonb)
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
  v_customer jsonb := payload #> '{payload,customer}';
  v_customer_name text := nullif(trim(coalesce(payload #>> '{payload,customerName}', '')), '');
  v_customer_phone text := nullif(trim(coalesce(payload #>> '{payload,customerPhone}', '')), '');
  v_started_at_text text := nullif(payload #>> '{payload,startedAt}', '');
  v_audit_log jsonb := payload #> '{payload,auditLog}';
  v_session_status text;
  v_resolved_customer_id text;
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

  if v_mutation_id is null or v_mutation_kind <> 'saveLiveSessionDetails' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_session_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The save session details payload is missing a session id.',
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
        'customers', case
          when v_event_metadata->>'customer_id' is null then '[]'::jsonb
          else jsonb_build_array(v_event_metadata->>'customer_id')
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
        'customers', case
          when v_event_metadata->>'customer_id' is null then '[]'::jsonb
          else jsonb_build_array(v_event_metadata->>'customer_id')
        end,
        'audit_logs', case
          when coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id))
        end,
        'operational_events', jsonb_build_array(v_event_id)
      )
    );
  end if;

  v_resolved_customer_id := public.resolve_operational_customer(v_organization_id, v_customer);

  update public.sessions
  set
    customer_id = v_resolved_customer_id,
    customer_name = v_customer_name,
    customer_phone = v_customer_phone,
    started_at = coalesce(v_started_at_text::timestamptz, sessions.started_at),
    raw_data = jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            coalesce(sessions.raw_data, '{}'::jsonb),
            '{customerId}',
            coalesce(to_jsonb(v_resolved_customer_id), 'null'::jsonb),
            true
          ),
          '{customerName}',
          coalesce(to_jsonb(v_customer_name), 'null'::jsonb),
          true
        ),
        '{customerPhone}',
        coalesce(to_jsonb(v_customer_phone), 'null'::jsonb),
        true
      ),
      '{startedAt}',
      to_jsonb(coalesce(v_started_at_text, sessions.started_at::text)),
      true
    ),
    updated_at = timezone('utc', now())
  where sessions.organization_id = v_organization_id
    and sessions.id = v_session_id;

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
      coalesce(nullif(v_audit_log->>'action', ''), 'session_details_updated'),
      nullif(v_audit_log->>'entityType', ''),
      nullif(v_audit_log->>'entityId', ''),
      nullif(v_audit_log->>'message', ''),
      nullif(v_audit_log->>'createdAt', '')::timestamptz,
      nullif(v_audit_log->>'userId', ''),
      v_audit_log
    )
    on conflict (organization_id, id) do nothing;
  end if;

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
    'save_live_session_details',
    'session',
    v_session_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'customer_id', v_resolved_customer_id,
      'audit_log_id', v_audit_log_id
    )
  )
  returning id into v_event_id;

  return jsonb_build_object(
    'mutation_id', v_mutation_id,
    'organization_id', v_organization_id,
    'entity_type', 'session',
    'entity_id', v_session_id,
    'event_id', v_event_id,
    'server_time', timezone('utc', now()),
    'changed_rows', jsonb_build_object(
      'sessions', jsonb_build_array(v_session_id),
      'customers', case when v_resolved_customer_id is null then '[]'::jsonb else jsonb_build_array(v_resolved_customer_id) end,
      'audit_logs', case when v_audit_log_id is null then '[]'::jsonb else jsonb_build_array(v_audit_log_id) end,
      'operational_events', jsonb_build_array(v_event_id)
    )
  );
end;
$$;

revoke all on function public.save_live_session_details(jsonb) from public;
revoke execute on function public.save_live_session_details(jsonb) from anon;
grant execute on function public.save_live_session_details(jsonb) to authenticated;

create or replace function public.save_live_customer_tab_details(payload jsonb)
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
  v_customer_tab_id text := nullif(payload #>> '{payload,customerTabId}', '');
  v_customer jsonb := payload #> '{payload,customer}';
  v_customer_name text := nullif(trim(coalesce(payload #>> '{payload,customerName}', '')), '');
  v_customer_phone text := nullif(trim(coalesce(payload #>> '{payload,customerPhone}', '')), '');
  v_audit_log jsonb := payload #> '{payload,auditLog}';
  v_tab_status text;
  v_resolved_customer_id text;
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

  if v_mutation_id is null or v_mutation_kind <> 'saveLiveCustomerTabDetails' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_customer_tab_id is null or v_customer_name is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The save customer tab details payload is missing a tab id or customer name.',
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
      'event_id', v_event_id,
      'server_time', timezone('utc', now()),
      'idempotent', true,
      'changed_rows', jsonb_build_object(
        'customer_tabs', jsonb_build_array(v_customer_tab_id),
        'customers', case
          when v_event_metadata->>'customer_id' is null then '[]'::jsonb
          else jsonb_build_array(v_event_metadata->>'customer_id')
        end,
        'audit_logs', case
          when coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id))
        end,
        'operational_events', jsonb_build_array(v_event_id)
      )
    );
  end if;

  select customer_tabs.status
  into v_tab_status
  from public.customer_tabs
  where customer_tabs.organization_id = v_organization_id
    and customer_tabs.id = v_customer_tab_id
  for update;

  if v_tab_status is null or v_tab_status <> 'open' then
    perform public.raise_operational_rpc_error(
      'customer_tab_not_open',
      'The customer tab is no longer open.',
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
      'event_id', v_event_id,
      'server_time', timezone('utc', now()),
      'idempotent', true,
      'changed_rows', jsonb_build_object(
        'customer_tabs', jsonb_build_array(v_customer_tab_id),
        'customers', case
          when v_event_metadata->>'customer_id' is null then '[]'::jsonb
          else jsonb_build_array(v_event_metadata->>'customer_id')
        end,
        'audit_logs', case
          when coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id) is null then '[]'::jsonb
          else jsonb_build_array(coalesce(v_event_metadata->>'audit_log_id', v_audit_log_id))
        end,
        'operational_events', jsonb_build_array(v_event_id)
      )
    );
  end if;

  v_resolved_customer_id := public.resolve_operational_customer(v_organization_id, v_customer);

  update public.customer_tabs
  set
    customer_id = v_resolved_customer_id,
    customer_name = v_customer_name,
    customer_phone = v_customer_phone,
    raw_data = jsonb_set(
      jsonb_set(
        jsonb_set(
          coalesce(customer_tabs.raw_data, '{}'::jsonb),
          '{customerId}',
          coalesce(to_jsonb(v_resolved_customer_id), 'null'::jsonb),
          true
        ),
        '{customerName}',
        coalesce(to_jsonb(v_customer_name), 'null'::jsonb),
        true
      ),
      '{customerPhone}',
      coalesce(to_jsonb(v_customer_phone), 'null'::jsonb),
      true
    ),
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
      coalesce(nullif(v_audit_log->>'action', ''), 'customer_tab_details_updated'),
      nullif(v_audit_log->>'entityType', ''),
      nullif(v_audit_log->>'entityId', ''),
      nullif(v_audit_log->>'message', ''),
      nullif(v_audit_log->>'createdAt', '')::timestamptz,
      nullif(v_audit_log->>'userId', ''),
      v_audit_log
    )
    on conflict (organization_id, id) do nothing;
  end if;

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
    'save_live_customer_tab_details',
    'customer_tab',
    v_customer_tab_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'customer_id', v_resolved_customer_id,
      'audit_log_id', v_audit_log_id
    )
  )
  returning id into v_event_id;

  return jsonb_build_object(
    'mutation_id', v_mutation_id,
    'organization_id', v_organization_id,
    'entity_type', 'customer_tab',
    'entity_id', v_customer_tab_id,
    'event_id', v_event_id,
    'server_time', timezone('utc', now()),
    'changed_rows', jsonb_build_object(
      'customer_tabs', jsonb_build_array(v_customer_tab_id),
      'customers', case when v_resolved_customer_id is null then '[]'::jsonb else jsonb_build_array(v_resolved_customer_id) end,
      'audit_logs', case when v_audit_log_id is null then '[]'::jsonb else jsonb_build_array(v_audit_log_id) end,
      'operational_events', jsonb_build_array(v_event_id)
    )
  );
end;
$$;

revoke all on function public.save_live_customer_tab_details(jsonb) from public;
revoke execute on function public.save_live_customer_tab_details(jsonb) from anon;
grant execute on function public.save_live_customer_tab_details(jsonb) to authenticated;
