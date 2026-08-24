-- Phase 4 operational RPC: link a hopped game session into an existing customer tab.
--
-- Run after phase4-customer-tab-rpcs.sql and phase4-hop-session-rpc.sql.

create or replace function public.link_customer_tab_continuation(payload jsonb)
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
  v_session_ids_payload jsonb := coalesce(payload #> '{payload,continuedFromSessionIds}', '[]'::jsonb);
  v_audit_logs jsonb := coalesce(payload #> '{payload,auditLogs}', '[]'::jsonb);
  v_session_ids text[];
  v_current_session_ids text[];
  v_unlinked_session_ids text[];
  v_invalid_session_ids text[];
  v_already_continued_session_ids text[];
  v_next_continuation_ids jsonb;
  v_audit_log_ids jsonb := '[]'::jsonb;
  v_changed_rows jsonb;
  v_event_id text;
  v_event_metadata jsonb := '{}'::jsonb;
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

  if v_mutation_id is null or v_mutation_kind <> 'linkCustomerTabContinuation' or v_user_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The operational change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind)
    );
  end if;

  if v_customer_tab_id is null then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The customer tab continuation payload is missing a tab id.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id)
    );
  end if;

  if jsonb_typeof(v_session_ids_payload) <> 'array' then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The customer tab continuation payload has invalid session ids.',
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
      'changed_rows', coalesce(v_event_metadata->'changed_rows', jsonb_build_object(
        'customer_tabs', jsonb_build_array(v_customer_tab_id),
        'sessions', coalesce(v_event_metadata->'session_ids', '[]'::jsonb),
        'audit_logs', coalesce(v_event_metadata->'audit_log_ids', '[]'::jsonb),
        'operational_events', jsonb_build_array(v_event_id)
      ))
    );
  end if;

  select coalesce(array_agg(session_id order by ordinality), array[]::text[])
  into v_session_ids
  from (
    select nullif(trim(value), '') as session_id, ordinality
    from jsonb_array_elements_text(v_session_ids_payload) with ordinality as session_values(value, ordinality)
  ) session_values
  where session_id is not null;

  if coalesce(array_length(v_session_ids, 1), 0) = 0 then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'No hopped session was selected for this customer tab.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id)
    );
  end if;

  perform 1
  from public.customer_tabs
  where customer_tabs.organization_id = v_organization_id
    and customer_tabs.id = v_customer_tab_id
    and customer_tabs.status = 'open'
  for update;

  if not found then
    perform public.raise_operational_rpc_error(
      'customer_tab_unavailable',
      'The customer tab is no longer open.',
      jsonb_build_object('customer_tab_id', v_customer_tab_id)
    );
  end if;

  select coalesce(array_agg(current_session_id order by ordinality), array[]::text[])
  into v_current_session_ids
  from (
    select nullif(trim(value), '') as current_session_id, ordinality
    from public.customer_tabs,
      jsonb_array_elements_text(
        case
          when jsonb_typeof(coalesce(customer_tabs.continued_from_session_ids, '[]'::jsonb)) = 'array'
            then coalesce(customer_tabs.continued_from_session_ids, '[]'::jsonb)
          else '[]'::jsonb
        end
      ) with ordinality as current_values(value, ordinality)
    where customer_tabs.organization_id = v_organization_id
      and customer_tabs.id = v_customer_tab_id
  ) current_values
  where current_session_id is not null;

  select coalesce(array_agg(session_id), array[]::text[])
  into v_unlinked_session_ids
  from unnest(v_session_ids) as session_ids(session_id)
  where not (session_id = any(v_current_session_ids));

  if coalesce(array_length(v_unlinked_session_ids, 1), 0) > 0 then
    perform 1
    from public.sessions
    join unnest(v_unlinked_session_ids) as requested(session_id)
      on sessions.organization_id = v_organization_id
      and sessions.id = requested.session_id
    order by sessions.id
    for update;

    select coalesce(array_agg(requested.session_id), array[]::text[])
    into v_invalid_session_ids
    from unnest(v_unlinked_session_ids) as requested(session_id)
    left join public.sessions
      on sessions.organization_id = v_organization_id
      and sessions.id = requested.session_id
    where sessions.id is null
      or sessions.status <> 'closed'
      or sessions.close_disposition <> 'hopped'
      or sessions.closed_bill_id is not null;

    if coalesce(array_length(v_invalid_session_ids, 1), 0) > 0 then
      perform public.raise_operational_rpc_error(
        'hopped_session_unavailable',
        'The hopped session is no longer available for this customer tab.',
        jsonb_build_object('customer_tab_id', v_customer_tab_id, 'session_ids', v_invalid_session_ids)
      );
    end if;

    select coalesce(array_agg(requested.session_id), array[]::text[])
    into v_already_continued_session_ids
    from unnest(v_unlinked_session_ids) as requested(session_id)
    where exists (
      select 1
      from public.sessions child
      where child.organization_id = v_organization_id
        and not (child.id = any(v_session_ids))
        and not (
          child.status = 'closed'
          and child.close_disposition is not distinct from 'rejected'
          and child.closed_bill_id is null
        )
        and case
          when jsonb_typeof(coalesce(child.continued_from_session_ids, '[]'::jsonb)) = 'array'
            then coalesce(child.continued_from_session_ids, '[]'::jsonb) @> jsonb_build_array(requested.session_id)
          else false
        end
    )
    or exists (
      select 1
      from public.customer_tabs consumer_tab
      where consumer_tab.organization_id = v_organization_id
        and consumer_tab.id <> v_customer_tab_id
        and not (
          consumer_tab.status = 'closed'
          and consumer_tab.close_disposition is not distinct from 'rejected'
          and consumer_tab.closed_bill_id is null
        )
        and case
          when jsonb_typeof(coalesce(consumer_tab.continued_from_session_ids, '[]'::jsonb)) = 'array'
            then coalesce(consumer_tab.continued_from_session_ids, '[]'::jsonb) @> jsonb_build_array(requested.session_id)
          else false
        end
    );

    if coalesce(array_length(v_already_continued_session_ids, 1), 0) > 0 then
      perform public.raise_operational_rpc_error(
        'hopped_session_already_continued',
        'A hopped session has already been linked to another continuation.',
        jsonb_build_object(
          'customer_tab_id',
          v_customer_tab_id,
          'session_ids',
          v_already_continued_session_ids
        )
      );
    end if;
  end if;

  select coalesce(jsonb_agg(to_jsonb(session_id) order by first_seen), '[]'::jsonb)
  into v_next_continuation_ids
  from (
    select session_id, min(first_seen) as first_seen
    from (
      select session_id, ordinality as first_seen
      from unnest(v_current_session_ids) with ordinality as current_ids(session_id, ordinality)
      union all
      select session_id, 100000 + ordinality as first_seen
      from unnest(v_session_ids) with ordinality as requested_ids(session_id, ordinality)
    ) combined_ids
    where session_id is not null and trim(session_id) <> ''
    group by session_id
  ) unique_ids;

  update public.customer_tabs
  set
    continued_from_session_ids = v_next_continuation_ids,
    raw_data = jsonb_set(
      coalesce(raw_data, '{}'::jsonb),
      '{continuedFromSessionIds}',
      v_next_continuation_ids,
      true
    ),
    updated_at = timezone('utc', now())
  where customer_tabs.organization_id = v_organization_id
    and customer_tabs.id = v_customer_tab_id;

  if jsonb_typeof(v_audit_logs) = 'array' then
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
    select
      v_organization_id,
      audit_log->>'id',
      coalesce(nullif(audit_log->>'action', ''), 'customer_tab_continuation_linked'),
      nullif(audit_log->>'entityType', ''),
      nullif(audit_log->>'entityId', ''),
      nullif(audit_log->>'message', ''),
      nullif(audit_log->>'createdAt', '')::timestamptz,
      nullif(audit_log->>'userId', ''),
      audit_log
    from jsonb_array_elements(v_audit_logs) as audit_values(audit_log)
    where nullif(audit_log->>'id', '') is not null
    on conflict (organization_id, id) do nothing;

    select coalesce(jsonb_agg(audit_log->>'id'), '[]'::jsonb)
    into v_audit_log_ids
    from jsonb_array_elements(v_audit_logs) as audit_values(audit_log)
    where nullif(audit_log->>'id', '') is not null;
  end if;

  v_changed_rows := jsonb_build_object(
    'customer_tabs', jsonb_build_array(v_customer_tab_id),
    'sessions', coalesce((select jsonb_agg(session_id) from unnest(v_session_ids) as session_values(session_id)), '[]'::jsonb),
    'audit_logs', v_audit_log_ids,
    'operational_events', '[]'::jsonb
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
    'link_customer_tab_continuation',
    'customer_tab',
    v_customer_tab_id,
    v_user_id,
    jsonb_build_object(
      'mutation_id', v_mutation_id,
      'mutation_kind', v_mutation_kind,
      'customer_tab_id', v_customer_tab_id,
      'session_ids', coalesce((select jsonb_agg(session_id) from unnest(v_session_ids) as session_values(session_id)), '[]'::jsonb),
      'audit_log_ids', v_audit_log_ids,
      'changed_rows', v_changed_rows
    )
  )
  returning id into v_event_id;

  v_changed_rows := jsonb_set(v_changed_rows, '{operational_events}', jsonb_build_array(v_event_id), true);

  update public.operational_events
  set metadata = jsonb_set(metadata, '{changed_rows}', v_changed_rows, true)
  where operational_events.organization_id = v_organization_id
    and operational_events.id = v_event_id;

  return jsonb_build_object(
    'mutation_id', v_mutation_id,
    'organization_id', v_organization_id,
    'entity_type', 'customer_tab',
    'entity_id', v_customer_tab_id,
    'event_id', v_event_id,
    'server_time', timezone('utc', now()),
    'changed_rows', v_changed_rows
  );
end;
$$;

revoke all on function public.link_customer_tab_continuation(jsonb) from public;
revoke execute on function public.link_customer_tab_continuation(jsonb) from anon;
grant execute on function public.link_customer_tab_continuation(jsonb) to authenticated;

-- Verification query:
-- select
--   has_function_privilege('anon', 'public.link_customer_tab_continuation(jsonb)', 'execute') as anon_can_link_customer_tab_continuation,
--   has_function_privilege('authenticated', 'public.link_customer_tab_continuation(jsonb)', 'execute') as authenticated_can_link_customer_tab_continuation;
