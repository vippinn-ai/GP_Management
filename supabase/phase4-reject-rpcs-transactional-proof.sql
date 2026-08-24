-- QA_REJECT_RPC_PROOF_BODY
-- This body is embedded after the exact production definitions by
-- scripts/build-reject-rpc-transactional-proof.mjs. The wrapper owns the savepoint rollback.
-- Nested PL/pgSQL exception blocks provide rollback savepoints for every expected failure.

create or replace function pg_temp.qa_assert(ok boolean, failure_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(ok, false) then
    raise exception using errcode = 'QA001', message = failure_message;
  end if;
end;
$$;

create temp table qa_reject_rpc_context on commit drop as
select
  'org-primary'::text as organization_id,
  member.user_id as actor_id,
  state.version as initial_app_state_version,
  'qa-reject-proof-source-session'::text as source_session_id,
  'qa-reject-proof-consumer-session'::text as consumer_session_id,
  'qa-reject-proof-source-tab'::text as source_tab_session_id,
  'qa-reject-proof-consumer-tab'::text as consumer_tab_id,
  'qa-reject-proof-stale-session'::text as stale_session_id,
  'qa-reject-proof-spoof-session'::text as spoof_session_id,
  'qa-reject-proof-audit-session'::text as audit_collision_session_id,
  'qa-reject-proof-malformed-session'::text as malformed_session_id,
  'qa-reject-proof-start-source'::text as start_source_session_id,
  'qa-reject-proof-start-stale-consumer'::text as start_stale_consumer_session_id,
  'qa-reject-proof-start-new-consumer'::text as start_new_session_id,
  'qa-reject-proof-start-station'::text as start_station_id,
  'qa-reject-proof-link-source'::text as link_source_session_id,
  'qa-reject-proof-link-stale-consumer'::text as link_stale_consumer_tab_id,
  'qa-reject-proof-link-target'::text as link_target_tab_id
from public.organization_members member
join public.profiles profile_row on profile_row.id = member.user_id and profile_row.active = true
join public.app_state state on state.id = 'primary'
where member.organization_id = 'org-primary'
  and member.active = true
  and member.role = 'admin'::public.app_role
order by member.created_at, member.user_id
limit 1;

select pg_temp.qa_assert(
  (select count(*) = 1 from qa_reject_rpc_context),
  'The proof requires one active authoritative org-primary admin and app_state.'
);

select pg_temp.qa_assert(
  not exists (
    select 1
    from public.sessions session_row
    cross join qa_reject_rpc_context context
    where session_row.organization_id = context.organization_id
      and session_row.id in (
        context.source_session_id,
        context.consumer_session_id,
        context.source_tab_session_id,
        context.stale_session_id,
        context.spoof_session_id,
        context.audit_collision_session_id,
        context.malformed_session_id,
        context.start_source_session_id,
        context.start_stale_consumer_session_id,
        context.start_new_session_id,
        context.link_source_session_id
      )
  ) and not exists (
    select 1
    from public.customer_tabs tab_row
    cross join qa_reject_rpc_context context
    where tab_row.organization_id = context.organization_id
      and tab_row.id in (
        context.consumer_tab_id,
        context.link_stale_consumer_tab_id,
        context.link_target_tab_id
      )
  ) and not exists (
    select 1
    from public.stations station_row
    cross join qa_reject_rpc_context context
    where station_row.organization_id = context.organization_id
      and station_row.id = context.start_station_id
  ) and not exists (
    select 1
    from public.audit_logs audit_row
    cross join qa_reject_rpc_context context
    where audit_row.organization_id = context.organization_id
      and (
        audit_row.id in (
          'qa-reject-proof-existing-audit',
          'qa-reject-proof-session-audit',
          'qa-reject-proof-tab-audit',
          'qa-reject-proof-stale-audit',
          'qa-reject-proof-spoof-audit',
          'qa-reject-proof-malformed-audit',
          'qa-reject-proof-inactive-audit'
        )
        or audit_row.entity_id in (
          context.source_session_id,
          context.consumer_session_id,
          context.source_tab_session_id,
          context.consumer_tab_id,
          context.stale_session_id,
          context.spoof_session_id,
          context.audit_collision_session_id,
          context.malformed_session_id,
          context.start_source_session_id,
          context.start_stale_consumer_session_id,
          context.start_new_session_id,
          context.link_source_session_id,
          context.link_stale_consumer_tab_id,
          context.link_target_tab_id
        )
      )
  ) and not exists (
    select 1
    from public.operational_events event_row
    cross join qa_reject_rpc_context context
    where event_row.organization_id = context.organization_id
      and (
        event_row.entity_id in (
          context.source_session_id,
          context.consumer_session_id,
          context.source_tab_session_id,
          context.consumer_tab_id,
          context.stale_session_id,
          context.spoof_session_id,
          context.audit_collision_session_id,
          context.malformed_session_id,
          context.start_source_session_id,
          context.start_stale_consumer_session_id,
          context.start_new_session_id,
          context.link_source_session_id,
          context.link_stale_consumer_tab_id,
          context.link_target_tab_id
        )
        or event_row.metadata->>'mutation_id' in (
          'qa-reject-proof-session-mutation',
          'qa-reject-proof-tab-mutation',
          'qa-reject-proof-stale-mutation',
          'qa-reject-proof-spoof-mutation',
          'qa-reject-proof-audit-collision-mutation',
          'qa-reject-proof-malformed-mutation',
          'qa-reject-proof-inactive-mutation',
          'qa-reject-proof-start-mutation',
          'qa-reject-proof-link-mutation'
        )
      )
  ) and not exists (
    select 1
    from public.app_state state
    cross join qa_reject_rpc_context context
    cross join lateral jsonb_array_elements(
      coalesce(state.data->'sessions', '[]'::jsonb) ||
      coalesce(state.data->'customerTabs', '[]'::jsonb) ||
      coalesce(state.data->'auditLogs', '[]'::jsonb) ||
      coalesce(state.data->'stations', '[]'::jsonb)
    ) entry
    where state.id = 'primary'
      and entry->>'id' in (
        context.source_session_id,
        context.consumer_session_id,
        context.source_tab_session_id,
        context.consumer_tab_id,
        context.stale_session_id,
        context.spoof_session_id,
        context.audit_collision_session_id,
        context.malformed_session_id,
        context.start_source_session_id,
        context.start_stale_consumer_session_id,
        context.start_new_session_id,
        context.link_source_session_id,
        context.link_stale_consumer_tab_id,
        context.link_target_tab_id,
        'qa-reject-proof-existing-audit',
        'qa-reject-proof-session-audit',
        'qa-reject-proof-tab-audit',
        'qa-reject-proof-stale-audit',
        'qa-reject-proof-spoof-audit',
        'qa-reject-proof-malformed-audit',
        'qa-reject-proof-inactive-audit',
        context.start_station_id
      )
  ),
  'A guarded proof fixture ID already exists.'
);

with fixture as (
  select context.*, timezone('utc', now()) as proof_at
  from qa_reject_rpc_context context
), session_rows as (
  select
    organization_id,
    source_session_id as id,
    'qa-proof-station-source'::text as station_id,
    'QA Proof Source'::text as station_name_snapshot,
    proof_at - interval '20 minutes' as started_at,
    proof_at - interval '10 minutes' as ended_at,
    'closed'::text as status,
    'hopped'::text as close_disposition,
    '[]'::jsonb as continued_from_session_ids
  from fixture
  union all
  select organization_id, consumer_session_id, 'qa-proof-station-consumer', 'QA Proof Consumer',
    proof_at - interval '9 minutes', null, 'active', null, jsonb_build_array(source_session_id)
  from fixture
  union all
  select organization_id, source_tab_session_id, 'qa-proof-station-tab-source', 'QA Proof Tab Source',
    proof_at - interval '18 minutes', proof_at - interval '8 minutes', 'closed', 'hopped', '[]'::jsonb
  from fixture
  union all
  select organization_id, stale_session_id, 'qa-proof-station-stale', 'QA Proof Stale',
    proof_at - interval '7 minutes', null, 'active', null, jsonb_build_array(source_session_id)
  from fixture
  union all
  select organization_id, spoof_session_id, 'qa-proof-station-spoof', 'QA Proof Spoof',
    proof_at - interval '6 minutes', null, 'active', null, jsonb_build_array(source_session_id)
  from fixture
  union all
  select organization_id, audit_collision_session_id, 'qa-proof-station-audit', 'QA Proof Audit',
    proof_at - interval '5 minutes', null, 'active', null, jsonb_build_array(source_session_id)
  from fixture
  union all
  select organization_id, malformed_session_id, 'qa-proof-station-malformed', 'QA Proof Malformed',
    proof_at - interval '4 minutes', null, 'active', null, '{}'::jsonb
  from fixture
  union all
  select organization_id, start_source_session_id, 'qa-proof-station-start-source', 'QA Proof Start Source',
    proof_at - interval '30 minutes', proof_at - interval '25 minutes', 'closed', 'hopped', '[]'::jsonb
  from fixture
  union all
  select organization_id, start_stale_consumer_session_id, 'qa-proof-station-start-stale', 'QA Proof Start Stale Consumer',
    proof_at - interval '24 minutes', proof_at - interval '23 minutes', 'closed', 'rejected', jsonb_build_array(start_source_session_id)
  from fixture
  union all
  select organization_id, link_source_session_id, 'qa-proof-station-link-source', 'QA Proof Link Source',
    proof_at - interval '22 minutes', proof_at - interval '21 minutes', 'closed', 'hopped', '[]'::jsonb
  from fixture
)
insert into public.sessions (
  organization_id, id, station_id, station_name_snapshot, mode, started_at, ended_at,
  status, customer_name, play_mode, ltp_eligible, pricing_snapshot, pause_log_ids,
  continued_from_session_ids, close_disposition, raw_data
)
select
  organization_id,
  id,
  station_id,
  station_name_snapshot,
  'timed',
  started_at,
  ended_at,
  status,
  'QA Reject RPC Proof',
  'group',
  false,
  '[]'::jsonb,
  '[]'::jsonb,
  continued_from_session_ids,
  close_disposition,
  jsonb_build_object(
    'id', id,
    'stationId', station_id,
    'stationNameSnapshot', station_name_snapshot,
    'mode', 'timed',
    'startedAt', started_at,
    'endedAt', ended_at,
    'status', status,
    'customerName', 'QA Reject RPC Proof',
    'playMode', 'group',
    'ltpEligible', false,
    'pricingSnapshot', '[]'::jsonb,
    'items', '[]'::jsonb,
    'pauseLogIds', '[]'::jsonb,
    'continuedFromSessionIds', continued_from_session_ids,
    'closeDisposition', close_disposition
  )
from session_rows;

insert into public.stations (organization_id, id, name, mode, active, ltp_enabled, raw_data)
select
  context.organization_id,
  context.start_station_id,
  'QA Reject Proof Start Station',
  'timed',
  true,
  false,
  jsonb_build_object(
    'id', context.start_station_id,
    'name', 'QA Reject Proof Start Station',
    'mode', 'timed',
    'active', true,
    'ltpEnabled', false
  )
from qa_reject_rpc_context context;

insert into public.customer_tabs (
  organization_id, id, customer_name, status, opened_at, continued_from_session_ids, raw_data
)
select
  context.organization_id,
  context.consumer_tab_id,
  'QA Reject RPC Proof',
  'open',
  timezone('utc', now()) - interval '7 minutes',
  jsonb_build_array(context.source_tab_session_id),
  jsonb_build_object(
    'id', context.consumer_tab_id,
    'customerName', 'QA Reject RPC Proof',
    'status', 'open',
    'createdAt', timezone('utc', now()) - interval '7 minutes',
    'items', '[]'::jsonb,
    'continuedFromSessionIds', jsonb_build_array(context.source_tab_session_id)
  )
from qa_reject_rpc_context context;

insert into public.customer_tabs (
  organization_id, id, customer_name, status, opened_at, closed_at,
  continued_from_session_ids, close_disposition, raw_data
)
select
  context.organization_id,
  context.link_stale_consumer_tab_id,
  'QA Reject RPC Proof',
  'closed',
  timezone('utc', now()) - interval '20 minutes',
  timezone('utc', now()) - interval '19 minutes',
  jsonb_build_array(context.link_source_session_id),
  'rejected',
  jsonb_build_object(
    'id', context.link_stale_consumer_tab_id,
    'customerName', 'QA Reject RPC Proof',
    'status', 'closed',
    'createdAt', timezone('utc', now()) - interval '20 minutes',
    'closedAt', timezone('utc', now()) - interval '19 minutes',
    'items', '[]'::jsonb,
    'continuedFromSessionIds', jsonb_build_array(context.link_source_session_id),
    'closeDisposition', 'rejected',
    'closedBillId', null
  )
from qa_reject_rpc_context context
union all
select
  context.organization_id,
  context.link_target_tab_id,
  'QA Reject RPC Proof',
  'open',
  timezone('utc', now()) - interval '2 minutes',
  null,
  '[]'::jsonb,
  null,
  jsonb_build_object(
    'id', context.link_target_tab_id,
    'customerName', 'QA Reject RPC Proof',
    'status', 'open',
    'createdAt', timezone('utc', now()) - interval '2 minutes',
    'items', '[]'::jsonb,
    'continuedFromSessionIds', '[]'::jsonb
  )
from qa_reject_rpc_context context;

insert into public.audit_logs (
  organization_id, id, action, entity_type, entity_id, message, audit_at, user_id, raw_data
)
select
  context.organization_id,
  'qa-reject-proof-existing-audit',
  'proof_existing',
  'session',
  context.audit_collision_session_id,
  'Pre-existing audit used to prove collision rollback.',
  timezone('utc', now()),
  context.actor_id::text,
  jsonb_build_object('id', 'qa-reject-proof-existing-audit', 'action', 'proof_existing')
from qa_reject_rpc_context context;

update public.app_state state
set data = jsonb_set(
  jsonb_set(
    state.data,
    '{sessions}',
    case when jsonb_typeof(state.data->'sessions') = 'array' then state.data->'sessions' else '[]'::jsonb end ||
      coalesce((
        select jsonb_agg(session_row.raw_data order by session_row.id)
        from public.sessions session_row
        cross join qa_reject_rpc_context context
        where session_row.organization_id = context.organization_id
          and session_row.id in (
            context.source_session_id,
            context.consumer_session_id,
            context.source_tab_session_id,
            context.stale_session_id,
            context.spoof_session_id,
            context.audit_collision_session_id,
            context.malformed_session_id,
            context.start_source_session_id,
            context.start_stale_consumer_session_id,
            context.link_source_session_id
          )
      ), '[]'::jsonb),
    true
  ),
  '{customerTabs}',
  case when jsonb_typeof(state.data->'customerTabs') = 'array' then state.data->'customerTabs' else '[]'::jsonb end ||
    coalesce((
      select jsonb_agg(tab_row.raw_data order by tab_row.id)
      from public.customer_tabs tab_row
      cross join qa_reject_rpc_context context
      where tab_row.organization_id = context.organization_id
        and tab_row.id in (
          context.consumer_tab_id,
          context.link_stale_consumer_tab_id,
          context.link_target_tab_id
        )
    ), '[]'::jsonb),
  true
)
where state.id = 'primary';

create or replace function pg_temp.qa_session_reject_payload(
  target_session_id text,
  target_mutation_id text,
  target_audit_id text,
  target_user_id text,
  target_base_version integer
)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'organization_id', context.organization_id,
    'mutation_id', target_mutation_id,
    'mutation_kind', 'rejectSession',
    'user_id', target_user_id,
    'base_app_state_version', target_base_version,
    'payload', jsonb_build_object(
      'session', coalesce(session_row.raw_data, '{}'::jsonb) || jsonb_build_object(
        'status', 'closed',
        'endedAt', timezone('utc', now()),
        'closeDisposition', 'rejected',
        'closeReason', 'Transactional proof rejection',
        'continuedFromSessionIds', '[]'::jsonb,
        'closedBillId', null
      ),
      'auditLog', jsonb_build_object(
        'id', target_audit_id,
        'action', 'session_rejected',
        'entityType', 'session',
        'entityId', target_session_id,
        'message', 'Client message must be replaced by the server.',
        'createdAt', timezone('utc', now()),
        'userId', target_user_id
      )
    )
  )
  from qa_reject_rpc_context context
  join public.sessions session_row
    on session_row.organization_id = context.organization_id
    and session_row.id = target_session_id;
$$;

create or replace function pg_temp.qa_tab_reject_payload(
  target_tab_id text,
  target_mutation_id text,
  target_audit_id text,
  target_user_id text,
  target_base_version integer
)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'organization_id', context.organization_id,
    'mutation_id', target_mutation_id,
    'mutation_kind', 'rejectCustomerTab',
    'user_id', target_user_id,
    'base_app_state_version', target_base_version,
    'payload', jsonb_build_object(
      'tab', coalesce(tab_row.raw_data, '{}'::jsonb) || jsonb_build_object(
        'status', 'closed',
        'closedAt', timezone('utc', now()),
        'closeDisposition', 'rejected',
        'closeReason', 'Transactional proof rejection',
        'continuedFromSessionIds', '[]'::jsonb,
        'closedBillId', null
      ),
      'auditLog', jsonb_build_object(
        'id', target_audit_id,
        'action', 'customer_tab_rejected',
        'entityType', 'customer_tab',
        'entityId', target_tab_id,
        'message', 'Client message must be replaced by the server.',
        'createdAt', timezone('utc', now()),
        'userId', target_user_id
      )
    )
  )
  from qa_reject_rpc_context context
  join public.customer_tabs tab_row
    on tab_row.organization_id = context.organization_id
    and tab_row.id = target_tab_id;
$$;

grant select on qa_reject_rpc_context to authenticated;
select set_config('request.jwt.claim.sub', (select actor_id::text from qa_reject_rpc_context), true);
select set_config(
  'request.jwt.claims',
  (select jsonb_build_object('sub', actor_id::text, 'role', 'authenticated')::text from qa_reject_rpc_context),
  true
);
set local role authenticated;

do $$
declare
  context qa_reject_rpc_context%rowtype;
  first_result jsonb;
  replay_result jsonb;
  tab_result jsonb;
  malformed_result jsonb;
  start_result jsonb;
  link_result jsonb;
  version_after_first integer;
  version_after_tab integer;
  app_state_hash_before_normalized_writes text;
  error_detail text;
begin
  select * into strict context from qa_reject_rpc_context;

  first_result := public.reject_session(pg_temp.qa_session_reject_payload(
    context.consumer_session_id,
    'qa-reject-proof-session-mutation',
    'qa-reject-proof-session-audit',
    context.actor_id::text,
    context.initial_app_state_version
  ));
  select version into version_after_first from public.app_state where id = 'primary';
  perform pg_temp.qa_assert(version_after_first = context.initial_app_state_version + 1, 'Session reject did not advance app_state exactly once.');
  perform pg_temp.qa_assert(
    exists (
      select 1 from public.sessions session_row
      where session_row.organization_id = context.organization_id
        and session_row.id = context.consumer_session_id
        and session_row.status = 'closed'
        and session_row.close_disposition = 'rejected'
        and session_row.closed_bill_id is null
        and session_row.continued_from_session_ids = '[]'::jsonb
        and session_row.raw_data->'continuedFromSessionIds' = '[]'::jsonb
        and session_row.raw_data->'closedBillId' = 'null'::jsonb
    ),
    'Session typed/raw rejection release is incorrect.'
  );
  perform pg_temp.qa_assert(
    exists (
      select 1 from jsonb_array_elements((select data->'sessions' from public.app_state where id = 'primary')) entry
      where entry->>'id' = context.consumer_session_id
        and entry->'continuedFromSessionIds' = '[]'::jsonb
        and entry->'closedBillId' = 'null'::jsonb
    ),
    'Session compatibility release is incorrect.'
  );
  perform pg_temp.qa_assert(
    exists (
      select 1 from public.audit_logs audit_row
      where audit_row.organization_id = context.organization_id
        and audit_row.id = 'qa-reject-proof-session-audit'
        and audit_row.user_id = context.actor_id::text
        and audit_row.raw_data->>'userId' = context.actor_id::text
        and audit_row.message like '%Released 1 prior game continuation.%'
        and audit_row.message not like '%Client message%'
    ),
    'Session audit actor or server-built release message is incorrect.'
  );
  perform pg_temp.qa_assert(
    exists (
      select 1 from public.operational_events event_row
      where event_row.id = first_result->>'event_id'
        and event_row.created_by = context.actor_id::text
        and event_row.metadata->'released_continued_from_session_ids' = jsonb_build_array(context.source_session_id)
    ),
    'Session event actor or released IDs are incorrect.'
  );

  replay_result := public.reject_session(pg_temp.qa_session_reject_payload(
    context.consumer_session_id,
    'qa-reject-proof-session-mutation',
    'qa-reject-proof-session-audit',
    context.actor_id::text,
    context.initial_app_state_version
  ));
  perform pg_temp.qa_assert(replay_result->>'idempotent' = 'true', 'Sequential replay was not canonical idempotent success.');
  perform pg_temp.qa_assert(replay_result->>'event_id' = first_result->>'event_id', 'Sequential replay returned a different event.');
  perform pg_temp.qa_assert((select version from public.app_state where id = 'primary') = version_after_first, 'Sequential replay advanced app_state.');

  begin
    perform public.reject_session(pg_temp.qa_session_reject_payload(
      context.stale_session_id,
      'qa-reject-proof-session-mutation',
      'qa-reject-proof-stale-audit',
      context.actor_id::text,
      version_after_first
    ));
    raise exception using errcode = 'QA006', message = 'Expected mutation-identity failure did not occur.';
  exception when sqlstate 'P0001' then
    get stacked diagnostics error_detail = pg_exception_detail;
    perform pg_temp.qa_assert(error_detail::jsonb->>'code' = 'mutation_identity_mismatch', 'Mutation-ID reuse returned the wrong code.');
  end;
  perform pg_temp.qa_assert(
    exists (
      select 1 from public.sessions
      where organization_id = context.organization_id
        and id = context.stale_session_id
        and status = 'active'
        and continued_from_session_ids = jsonb_build_array(context.source_session_id)
    ),
    'Mutation-identity failure changed the second entity.'
  );

  tab_result := public.reject_customer_tab(pg_temp.qa_tab_reject_payload(
    context.consumer_tab_id,
    'qa-reject-proof-tab-mutation',
    'qa-reject-proof-tab-audit',
    context.actor_id::text,
    version_after_first
  ));
  select version into version_after_tab from public.app_state where id = 'primary';
  perform pg_temp.qa_assert(version_after_tab = version_after_first + 1, 'Tab reject did not advance app_state exactly once.');
  perform pg_temp.qa_assert(
    exists (
      select 1 from public.customer_tabs tab_row
      where tab_row.organization_id = context.organization_id
        and tab_row.id = context.consumer_tab_id
        and tab_row.status = 'closed'
        and tab_row.close_disposition = 'rejected'
        and tab_row.closed_bill_id is null
        and tab_row.continued_from_session_ids = '[]'::jsonb
        and tab_row.raw_data->'continuedFromSessionIds' = '[]'::jsonb
    ),
    'Tab typed/raw rejection release is incorrect.'
  );
  perform pg_temp.qa_assert(
    exists (
      select 1 from jsonb_array_elements((select data->'customerTabs' from public.app_state where id = 'primary')) entry
      where entry->>'id' = context.consumer_tab_id
        and entry->'continuedFromSessionIds' = '[]'::jsonb
        and entry->'closedBillId' = 'null'::jsonb
    ),
    'Tab compatibility release is incorrect.'
  );
  perform pg_temp.qa_assert(
    exists (
      select 1 from public.audit_logs audit_row
      where audit_row.organization_id = context.organization_id
        and audit_row.id = 'qa-reject-proof-tab-audit'
        and audit_row.user_id = context.actor_id::text
        and audit_row.raw_data->>'userId' = context.actor_id::text
        and audit_row.message like '%Released 1 prior game continuation.%'
        and audit_row.message not like '%Client message%'
    ),
    'Tab audit actor or server-built release message is incorrect.'
  );
  perform pg_temp.qa_assert(
    exists (
      select 1 from public.operational_events event_row
      where event_row.id = tab_result->>'event_id'
        and event_row.created_by = context.actor_id::text
        and event_row.metadata->'released_continued_from_session_ids' = jsonb_build_array(context.source_tab_session_id)
    ),
    'Tab event actor or released IDs are incorrect.'
  );

  begin
    perform public.reject_session(pg_temp.qa_session_reject_payload(
      context.stale_session_id,
      'qa-reject-proof-stale-mutation',
      'qa-reject-proof-stale-audit',
      context.actor_id::text,
      version_after_tab - 1
    ));
    raise exception using errcode = 'QA002', message = 'Expected stale-version failure did not occur.';
  exception when sqlstate 'P0001' then
    get stacked diagnostics error_detail = pg_exception_detail;
    perform pg_temp.qa_assert(error_detail::jsonb->>'code' = 'app_state_conflict', 'Stale-version failure returned the wrong code.');
  end;
  perform pg_temp.qa_assert(
    exists (select 1 from public.sessions where organization_id = context.organization_id and id = context.stale_session_id and status = 'active' and continued_from_session_ids = jsonb_build_array(context.source_session_id)),
    'Stale-version failure changed the session or released its source.'
  );

  begin
    perform public.reject_session(pg_temp.qa_session_reject_payload(
      context.spoof_session_id,
      'qa-reject-proof-spoof-mutation',
      'qa-reject-proof-spoof-audit',
      gen_random_uuid()::text,
      version_after_tab
    ));
    raise exception using errcode = 'QA003', message = 'Expected actor-spoof failure did not occur.';
  exception when sqlstate 'P0001' then
    get stacked diagnostics error_detail = pg_exception_detail;
    perform pg_temp.qa_assert(error_detail::jsonb->>'code' = 'organization_access_denied', 'Actor-spoof failure returned the wrong code.');
  end;
  perform pg_temp.qa_assert(
    exists (select 1 from public.sessions where organization_id = context.organization_id and id = context.spoof_session_id and status = 'active'),
    'Actor-spoof failure changed the session.'
  );

  begin
    perform public.reject_session(pg_temp.qa_session_reject_payload(
      context.audit_collision_session_id,
      'qa-reject-proof-audit-collision-mutation',
      'qa-reject-proof-existing-audit',
      context.actor_id::text,
      version_after_tab
    ));
    raise exception using errcode = 'QA004', message = 'Expected audit collision did not occur.';
  exception when sqlstate 'P0001' then
    get stacked diagnostics error_detail = pg_exception_detail;
    perform pg_temp.qa_assert(error_detail::jsonb->>'code' = 'audit_id_conflict', 'Audit collision returned the wrong code.');
  end;
  perform pg_temp.qa_assert(
    exists (select 1 from public.sessions where organization_id = context.organization_id and id = context.audit_collision_session_id and status = 'active' and continued_from_session_ids = jsonb_build_array(context.source_session_id)),
    'Audit collision did not roll back the session release.'
  );

  malformed_result := public.reject_session(pg_temp.qa_session_reject_payload(
    context.malformed_session_id,
    'qa-reject-proof-malformed-mutation',
    'qa-reject-proof-malformed-audit',
    context.actor_id::text,
    version_after_tab
  ));
  perform pg_temp.qa_assert(
    exists (
      select 1 from public.operational_events event_row
      where event_row.id = malformed_result->>'event_id'
        and event_row.metadata->'released_continued_from_session_ids' = '[]'::jsonb
    ),
    'Malformed legacy continuation JSON was not normalized to an empty release array.'
  );
  perform pg_temp.qa_assert(
    exists (
      select 1 from public.audit_logs audit_row
      where audit_row.organization_id = context.organization_id
        and audit_row.id = 'qa-reject-proof-malformed-audit'
        and audit_row.message not like '%Released %'
    ),
    'Malformed legacy continuation JSON produced a false release count.'
  );
  perform pg_temp.qa_assert(
    exists (
      select 1 from public.sessions session_row
      where session_row.organization_id = context.organization_id
        and session_row.id = context.malformed_session_id
        and session_row.status = 'closed'
        and session_row.close_disposition = 'rejected'
        and session_row.closed_bill_id is null
        and session_row.continued_from_session_ids = '[]'::jsonb
        and session_row.raw_data->'continuedFromSessionIds' = '[]'::jsonb
        and session_row.raw_data->'closedBillId' = 'null'::jsonb
    ) and exists (
      select 1
      from jsonb_array_elements((select data->'sessions' from public.app_state where id = 'primary')) entry
      where entry->>'id' = context.malformed_session_id
        and entry->'continuedFromSessionIds' = '[]'::jsonb
        and entry->'closedBillId' = 'null'::jsonb
    ),
    'Malformed legacy continuation JSON was not normalized in typed, raw, and compatibility state.'
  );

  select encode(digest(state.data::text, 'sha256'), 'hex')
  into app_state_hash_before_normalized_writes
  from public.app_state state
  where state.id = 'primary';

  start_result := public.start_session(jsonb_build_object(
    'organization_id', context.organization_id,
    'mutation_id', 'qa-reject-proof-start-mutation',
    'mutation_kind', 'startSession',
    'user_id', context.actor_id::text,
    'payload', jsonb_build_object(
      'session', jsonb_build_object(
        'id', context.start_new_session_id,
        'stationId', context.start_station_id,
        'stationNameSnapshot', 'QA Reject Proof Start Station',
        'mode', 'timed',
        'startedAt', timezone('utc', now()),
        'status', 'active',
        'customerName', 'QA Reject RPC Proof',
        'playMode', 'group',
        'ltpEligible', false,
        'pricingSnapshot', '[]'::jsonb,
        'items', '[]'::jsonb,
        'pauseLogIds', '[]'::jsonb,
        'continuedFromSessionIds', jsonb_build_array(context.start_source_session_id)
      ),
      'stockMovements', '[]'::jsonb,
      'auditLogs', '[]'::jsonb
    )
  ));
  perform pg_temp.qa_assert(
    start_result->>'entity_id' = context.start_new_session_id
      and exists (
        select 1 from public.sessions session_row
        where session_row.organization_id = context.organization_id
          and session_row.id = context.start_new_session_id
          and session_row.status = 'active'
          and session_row.continued_from_session_ids = jsonb_build_array(context.start_source_session_id)
          and session_row.raw_data->'continuedFromSessionIds' = jsonb_build_array(context.start_source_session_id)
      ),
    'start_session did not create the normalized continuation over a stale rejected consumer.'
  );
  perform pg_temp.qa_assert(
    (
      select count(*)
      from (
        select child.id
        from public.sessions child
        where child.organization_id = context.organization_id
          and child.id <> context.start_source_session_id
          and not (
            child.status = 'closed'
            and child.close_disposition is not distinct from 'rejected'
            and child.closed_bill_id is null
          )
          and case
            when jsonb_typeof(coalesce(child.continued_from_session_ids, '[]'::jsonb)) = 'array'
              then coalesce(child.continued_from_session_ids, '[]'::jsonb) @> jsonb_build_array(context.start_source_session_id)
            else false
          end
        union all
        select consumer_tab.id
        from public.customer_tabs consumer_tab
        where consumer_tab.organization_id = context.organization_id
          and not (
            consumer_tab.status = 'closed'
            and consumer_tab.close_disposition is not distinct from 'rejected'
            and consumer_tab.closed_bill_id is null
          )
          and case
            when jsonb_typeof(coalesce(consumer_tab.continued_from_session_ids, '[]'::jsonb)) = 'array'
              then coalesce(consumer_tab.continued_from_session_ids, '[]'::jsonb) @> jsonb_build_array(context.start_source_session_id)
            else false
          end
      ) valid_consumers
    ) = 1,
    'start_session did not leave exactly one valid consumer for the hopped source.'
  );

  link_result := public.link_customer_tab_continuation(jsonb_build_object(
    'organization_id', context.organization_id,
    'mutation_id', 'qa-reject-proof-link-mutation',
    'mutation_kind', 'linkCustomerTabContinuation',
    'user_id', context.actor_id::text,
    'payload', jsonb_build_object(
      'customerTabId', context.link_target_tab_id,
      'continuedFromSessionIds', jsonb_build_array(context.link_source_session_id),
      'auditLogs', '[]'::jsonb
    )
  ));
  perform pg_temp.qa_assert(
    link_result->>'entity_id' = context.link_target_tab_id
      and exists (
        select 1 from public.customer_tabs tab_row
        where tab_row.organization_id = context.organization_id
          and tab_row.id = context.link_target_tab_id
          and tab_row.status = 'open'
          and tab_row.continued_from_session_ids = jsonb_build_array(context.link_source_session_id)
          and tab_row.raw_data->'continuedFromSessionIds' = jsonb_build_array(context.link_source_session_id)
      ),
    'link_customer_tab_continuation did not create the normalized link over a stale rejected consumer.'
  );
  perform pg_temp.qa_assert(
    (
      select count(*)
      from (
        select child.id
        from public.sessions child
        where child.organization_id = context.organization_id
          and not (
            child.status = 'closed'
            and child.close_disposition is not distinct from 'rejected'
            and child.closed_bill_id is null
          )
          and case
            when jsonb_typeof(coalesce(child.continued_from_session_ids, '[]'::jsonb)) = 'array'
              then coalesce(child.continued_from_session_ids, '[]'::jsonb) @> jsonb_build_array(context.link_source_session_id)
            else false
          end
        union all
        select consumer_tab.id
        from public.customer_tabs consumer_tab
        where consumer_tab.organization_id = context.organization_id
          and not (
            consumer_tab.status = 'closed'
            and consumer_tab.close_disposition is not distinct from 'rejected'
            and consumer_tab.closed_bill_id is null
          )
          and case
            when jsonb_typeof(coalesce(consumer_tab.continued_from_session_ids, '[]'::jsonb)) = 'array'
              then coalesce(consumer_tab.continued_from_session_ids, '[]'::jsonb) @> jsonb_build_array(context.link_source_session_id)
            else false
          end
      ) valid_consumers
    ) = 1,
    'link_customer_tab_continuation did not leave exactly one valid consumer for the hopped source.'
  );
  perform pg_temp.qa_assert(
    (select encode(digest(state.data::text, 'sha256'), 'hex') from public.app_state state where state.id = 'primary')
      = app_state_hash_before_normalized_writes,
    'Normalized start/link RPCs unexpectedly changed the compatibility app_state snapshot.'
  );
  perform pg_temp.qa_assert(
    exists (
      select 1
      from jsonb_array_elements((select data->'sessions' from public.app_state where id = 'primary')) entry
      where entry->>'id' = context.start_stale_consumer_session_id
        and entry->'continuedFromSessionIds' = jsonb_build_array(context.start_source_session_id)
        and entry->>'closeDisposition' = 'rejected'
    ) and not exists (
      select 1
      from jsonb_array_elements((select data->'sessions' from public.app_state where id = 'primary')) entry
      where entry->>'id' = context.start_new_session_id
    ) and exists (
      select 1
      from jsonb_array_elements((select data->'customerTabs' from public.app_state where id = 'primary')) entry
      where entry->>'id' = context.link_stale_consumer_tab_id
        and entry->'continuedFromSessionIds' = jsonb_build_array(context.link_source_session_id)
        and entry->>'closeDisposition' = 'rejected'
    ) and exists (
      select 1
      from jsonb_array_elements((select data->'customerTabs' from public.app_state where id = 'primary')) entry
      where entry->>'id' = context.link_target_tab_id
        and entry->'continuedFromSessionIds' = '[]'::jsonb
    ),
    'Compatibility snapshot relationships changed during normalized-authority start/link proof.'
  );
  perform pg_temp.qa_assert(
    exists (
      select 1 from public.operational_events event_row
      where event_row.organization_id = context.organization_id
        and event_row.id = start_result->>'event_id'
        and event_row.event_type = 'start_session'
        and event_row.entity_id = context.start_new_session_id
    ) and exists (
      select 1 from public.operational_events event_row
      where event_row.organization_id = context.organization_id
        and event_row.id = link_result->>'event_id'
        and event_row.event_type = 'link_customer_tab_continuation'
        and event_row.entity_id = context.link_target_tab_id
    ),
    'Normalized start/link operational events are missing.'
  );
  perform pg_temp.qa_assert(
    (select version from public.app_state where id = 'primary') = context.initial_app_state_version + 3,
    'Successful and failed proof operations produced an unexpected app_state version delta.'
  );
end;
$$;

reset role;

update public.organization_members member
set active = false
from qa_reject_rpc_context context
where member.organization_id = context.organization_id
  and member.user_id = context.actor_id;

do $$
declare
  context qa_reject_rpc_context%rowtype;
  error_detail text;
begin
  select * into strict context from qa_reject_rpc_context;
  begin
    perform public.reject_session(pg_temp.qa_session_reject_payload(
      context.stale_session_id,
      'qa-reject-proof-inactive-mutation',
      'qa-reject-proof-inactive-audit',
      context.actor_id::text,
      (select version from public.app_state where id = 'primary')
    ));
    raise exception using errcode = 'QA005', message = 'Expected inactive-member failure did not occur.';
  exception when sqlstate 'P0001' then
    get stacked diagnostics error_detail = pg_exception_detail;
    perform pg_temp.qa_assert(error_detail::jsonb->>'code' = 'organization_access_denied', 'Inactive-member failure returned the wrong code.');
  end;
end;
$$;

update public.organization_members member
set active = true
from qa_reject_rpc_context context
where member.organization_id = context.organization_id
  and member.user_id = context.actor_id;

select pg_temp.qa_assert(
  exists (
    select 1
    from public.organization_members member
    cross join qa_reject_rpc_context context
    where member.organization_id = context.organization_id
      and member.user_id = context.actor_id
      and member.active = true
  ),
  'Inactive-membership proof did not restore the selected membership to active.'
);

select pg_temp.qa_assert(
  has_function_privilege('authenticated', 'public.start_session(jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.reject_session(jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.reject_customer_tab(jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.link_customer_tab_continuation(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.start_session(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.reject_session(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.reject_customer_tab(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.link_customer_tab_continuation(jsonb)', 'execute'),
  'Operational RPC grants are incorrect.'
);

select
  'passed' as proof_result,
  context.actor_id,
  context.initial_app_state_version,
  state.version as final_in_transaction_version,
  state.version - context.initial_app_state_version as app_state_version_delta,
  3 as expected_version_delta
from qa_reject_rpc_context context
join public.app_state state on state.id = 'primary';
