-- OPERATIONAL_LIFECYCLE_V2_TRANSACTIONAL_PROOF
-- Generated copies replace __RUN_ID__. Every fixture and mutation is rolled back.
begin isolation level serializable;
set local lock_timeout = '3s';
set local statement_timeout = '180s';

do $$
begin
  if coalesce(current_setting('app.settings.api_url', true), '') not like '%tkbdyzxwwbhkpztgjjxh%' then
    raise exception 'database-owned staging API URL identity failed';
  end if;
  if not exists (
    select 1 from public.deployment_environment_identity
    where environment = 'staging' and project_ref = 'tkbdyzxwwbhkpztgjjxh'
  ) then raise exception 'database staging identity failed'; end if;
end $$;

-- The builder replaces this marker with exact pg_get_functiondef MD5 guards
-- from the verified staging installation. An unbound source file must fail.
__INSTALLED_FUNCTION_GUARDS__

create or replace function pg_temp.qa_assert(ok boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception using errcode = 'QA001', message = message; end if;
end $$;

create temp table qa_context on commit drop as
select
  'org-primary'::text organization_id,
  member.user_id actor_id,
  '__RUN_ID__'::text run_id,
  '__RUN_ID__-hop'::text hop_session_id,
  '__RUN_ID__-reject'::text reject_session_id,
  '__RUN_ID__-tab'::text reject_tab_id,
  '__RUN_ID__-collision'::text collision_session_id,
  timezone('utc', now()) - interval '1 minute' proof_end_at,
  state.version app_state_version,
  md5(state.data::text) app_state_md5,
  state.updated_at app_state_updated_at,
  state.updated_by app_state_updated_by
from public.organization_members member
join public.profiles profile_row on profile_row.id = member.user_id and profile_row.active
join public.app_state state on state.id = 'primary'
where member.organization_id = 'org-primary' and member.active and member.role = 'admin'::public.app_role
order by member.created_at, member.user_id
limit 1;

select pg_temp.qa_assert((select count(*) = 1 from qa_context), 'Proof requires one active staging admin and app_state.');
select pg_temp.qa_assert(not exists (
  select 1 from public.sessions s cross join qa_context c
  where s.organization_id = c.organization_id and s.id in (c.hop_session_id, c.reject_session_id, c.collision_session_id)
), 'A generated session fixture already exists.');
select pg_temp.qa_assert(not exists (
  select 1 from public.customer_tabs t cross join qa_context c
  where t.organization_id = c.organization_id and t.id = c.reject_tab_id
), 'A generated tab fixture already exists.');

select set_config('request.jwt.claim.sub', (select actor_id::text from qa_context), true);
select set_config('request.jwt.claims', jsonb_build_object('sub', (select actor_id::text from qa_context), 'role', 'authenticated')::text, true);

insert into public.sessions (
  organization_id, id, station_id, station_name_snapshot, mode, started_at, status,
  customer_name, play_mode, ltp_eligible, pricing_snapshot, pause_log_ids,
  continued_from_session_ids, raw_data
)
select organization_id, id, station_id, station_name, 'timed', timezone('utc', now()) - interval '20 minutes', status,
  'QA Operational V2 Proof', 'group', false, '[]'::jsonb, pause_ids, '[]'::jsonb,
  jsonb_build_object('id', id, 'status', status, 'startedAt', timezone('utc', now()) - interval '20 minutes')
from (
  select organization_id, hop_session_id id, '__RUN_ID__-station-hop' station_id, 'QA Hop' station_name, 'active' status, '[]'::jsonb pause_ids from qa_context
  union all
  select organization_id, reject_session_id, '__RUN_ID__-station-reject', 'QA Reject', 'paused', jsonb_build_array('__RUN_ID__-pause') from qa_context
  union all
  select organization_id, collision_session_id, '__RUN_ID__-station-collision', 'QA Collision', 'active', '[]'::jsonb from qa_context
) fixture;

insert into public.session_pause_logs (organization_id, id, session_id, paused_at, raw_data)
select organization_id, '__RUN_ID__-pause', reject_session_id, timezone('utc', now()) - interval '5 minutes',
  jsonb_build_object('id', '__RUN_ID__-pause', 'sessionId', reject_session_id, 'pausedAt', timezone('utc', now()) - interval '5 minutes')
from qa_context;

insert into public.customer_tabs (
  organization_id, id, customer_name, status, opened_at, continued_from_session_ids, raw_data
)
select organization_id, reject_tab_id, 'QA Operational V2 Proof Tab', 'open', timezone('utc', now()) - interval '15 minutes', '[]'::jsonb,
  jsonb_build_object('id', reject_tab_id, 'customerName', 'QA Operational V2 Proof Tab', 'status', 'open')
from qa_context;

insert into public.audit_logs (organization_id, id, action, entity_type, entity_id, message, audit_at, user_id, raw_data)
select organization_id, '__RUN_ID__-audit-collision', 'qa_collision', 'session', collision_session_id,
  'QA intentional collision', timezone('utc', now()), actor_id::text, '{}'::jsonb
from qa_context;

create temp table qa_results (case_name text primary key, result jsonb) on commit drop;

insert into qa_results
select 'hop', public.hop_session_v2(jsonb_build_object(
  'organization_id', organization_id, 'mutation_id', '__RUN_ID__-mutation-hop',
  'mutation_kind', 'hopSession', 'entity_type', 'session', 'entity_id', hop_session_id,
  'payload', jsonb_build_object('effective_ended_at', proof_end_at, 'audit_log_id', '__RUN_ID__-audit-hop')
)) from qa_context;

insert into qa_results
select 'reject_session', public.reject_session_v2(jsonb_build_object(
  'organization_id', organization_id, 'mutation_id', '__RUN_ID__-mutation-reject',
  'mutation_kind', 'rejectSession', 'entity_type', 'session', 'entity_id', reject_session_id,
  'payload', jsonb_build_object('effective_ended_at', timezone('utc', now()) - interval '1 minute', 'reason', 'QA rollback proof', 'audit_log_id', '__RUN_ID__-audit-reject')
)) from qa_context;

insert into qa_results
select 'reject_tab', public.reject_customer_tab_v2(jsonb_build_object(
  'organization_id', organization_id, 'mutation_id', '__RUN_ID__-mutation-tab',
  'mutation_kind', 'rejectCustomerTab', 'entity_type', 'customer_tab', 'entity_id', reject_tab_id,
  'payload', jsonb_build_object('effective_closed_at', timezone('utc', now()) - interval '1 minute', 'reason', 'QA rollback proof', 'audit_log_id', '__RUN_ID__-audit-tab')
)) from qa_context;

insert into qa_results
select 'hop_replay', public.hop_session_v2(jsonb_build_object(
  'organization_id', organization_id, 'mutation_id', '__RUN_ID__-mutation-hop',
  'mutation_kind', 'hopSession', 'entity_type', 'session', 'entity_id', hop_session_id,
  'payload', jsonb_build_object('effective_ended_at', proof_end_at, 'audit_log_id', '__RUN_ID__-audit-hop')
)) from qa_context;

insert into qa_results
select 'reject_session_replay', public.reject_session_v2(jsonb_build_object(
  'organization_id', organization_id, 'mutation_id', '__RUN_ID__-mutation-reject',
  'mutation_kind', 'rejectSession', 'entity_type', 'session', 'entity_id', reject_session_id,
  'payload', jsonb_build_object('effective_ended_at', timezone('utc', now()) - interval '1 minute', 'reason', 'QA rollback proof', 'audit_log_id', '__RUN_ID__-audit-reject')
)) from qa_context;

insert into qa_results
select 'reject_tab_replay', public.reject_customer_tab_v2(jsonb_build_object(
  'organization_id', organization_id, 'mutation_id', '__RUN_ID__-mutation-tab',
  'mutation_kind', 'rejectCustomerTab', 'entity_type', 'customer_tab', 'entity_id', reject_tab_id,
  'payload', jsonb_build_object('effective_closed_at', timezone('utc', now()) - interval '1 minute', 'reason', 'QA rollback proof', 'audit_log_id', '__RUN_ID__-audit-tab')
)) from qa_context;

-- Expected failures run in subtransactions so a late error must restore every earlier statement.
do $$
declare c qa_context%rowtype; failed boolean;
begin
  select * into c from qa_context;

  failed := false;
  begin
    perform public.hop_session_v2(jsonb_build_object(
      'organization_id', c.organization_id, 'mutation_id', '__RUN_ID__-mutation-hop',
      'mutation_kind', 'hopSession', 'entity_type', 'session', 'entity_id', c.hop_session_id,
      'payload', jsonb_build_object('effective_ended_at', timezone('utc', now()) - interval '2 minutes', 'audit_log_id', '__RUN_ID__-audit-hop'));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Same mutation ID with different intent did not fail.');

  failed := false;
  begin
    perform public.reject_customer_tab_v2(jsonb_build_object(
      'organization_id', c.organization_id, 'mutation_id', '__RUN_ID__-mutation-tab',
      'mutation_kind', 'rejectCustomerTab', 'entity_type', 'customer_tab', 'entity_id', c.reject_tab_id,
      'payload', jsonb_build_object('effective_closed_at', timezone('utc', now()) - interval '2 minutes', 'reason', 'Changed intent', 'audit_log_id', '__RUN_ID__-audit-tab'));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Same tab mutation ID with different intent did not fail.');

  failed := false;
  begin
    perform public.hop_session_v2(jsonb_build_object('organization_id', c.organization_id));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Malformed hop payload did not fail.');

  failed := false;
  begin perform public.reject_session_v2(jsonb_build_object('organization_id', c.organization_id));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Malformed reject-session payload did not fail.');

  failed := false;
  begin perform public.reject_customer_tab_v2(jsonb_build_object('organization_id', c.organization_id));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Malformed reject-tab payload did not fail.');

  failed := false;
  begin
    perform public.hop_session_v2(jsonb_build_object(
      'organization_id', c.organization_id, 'mutation_id', '__RUN_ID__-mutation-wrong-kind',
      'mutation_kind', 'rejectSession', 'entity_type', 'customer_tab', 'entity_id', c.collision_session_id,
      'payload', jsonb_build_object('effective_ended_at', timezone('utc', now()) - interval '1 minute', 'audit_log_id', '__RUN_ID__-audit-wrong-kind'));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Wrong mutation/entity target did not fail.');

  failed := false;
  begin
    perform public.hop_session_v2(jsonb_build_object(
      'organization_id', c.organization_id, 'mutation_id', '__RUN_ID__-mutation-future',
      'mutation_kind', 'hopSession', 'entity_type', 'session', 'entity_id', c.collision_session_id,
      'payload', jsonb_build_object('effective_ended_at', timezone('utc', now()) + interval '1 minute', 'audit_log_id', '__RUN_ID__-audit-future'));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Future session end did not fail.');

  failed := false;
  begin
    perform public.hop_session_v2(jsonb_build_object(
      'organization_id', c.organization_id, 'mutation_id', '__RUN_ID__-mutation-before-start',
      'mutation_kind', 'hopSession', 'entity_type', 'session', 'entity_id', c.collision_session_id,
      'payload', jsonb_build_object('effective_ended_at', timezone('utc', now()) - interval '30 minutes', 'audit_log_id', '__RUN_ID__-audit-before-start'));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Session end before canonical start did not fail.');

  failed := false;
  begin
    perform public.hop_session_v2(jsonb_build_object(
      'organization_id', c.organization_id, 'mutation_id', '__RUN_ID__-mutation-closed-target',
      'mutation_kind', 'hopSession', 'entity_type', 'session', 'entity_id', c.hop_session_id,
      'payload', jsonb_build_object('effective_ended_at', c.proof_end_at, 'audit_log_id', '__RUN_ID__-audit-closed-target'));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Closed session target did not fail.');

  failed := false;
  begin
    perform public.hop_session_v2(jsonb_build_object(
      'organization_id', c.organization_id, 'mutation_id', '__RUN_ID__-mutation-spoof',
      'mutation_kind', 'hopSession', 'entity_type', 'session', 'entity_id', c.collision_session_id,
      'user_id', gen_random_uuid()::text,
      'payload', jsonb_build_object('effective_ended_at', timezone('utc', now()) - interval '1 minute', 'audit_log_id', '__RUN_ID__-audit-spoof'));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Client actor spoof field did not fail.');

  failed := false;
  begin
    perform public.reject_session_v2(jsonb_build_object(
      'organization_id', c.organization_id, 'mutation_id', '__RUN_ID__-mutation-collision',
      'mutation_kind', 'rejectSession', 'entity_type', 'session', 'entity_id', c.collision_session_id,
      'payload', jsonb_build_object('effective_ended_at', timezone('utc', now()) - interval '1 minute', 'reason', 'QA collision', 'audit_log_id', '__RUN_ID__-audit-collision'));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Late audit collision did not fail.');
  perform pg_temp.qa_assert(exists(select 1 from public.sessions where organization_id=c.organization_id and id=c.collision_session_id and status='active'), 'Late collision did not roll back session change.');
  perform pg_temp.qa_assert(not exists(select 1 from public.operational_mutations where organization_id=c.organization_id and mutation_id='__RUN_ID__-mutation-collision'), 'Late collision left a mutation row.');

  failed := false;
  begin
    update public.profiles set active=false where id=c.actor_id;
    perform public.reject_session_v2(jsonb_build_object(
      'organization_id', c.organization_id, 'mutation_id', '__RUN_ID__-mutation-inactive',
      'mutation_kind', 'rejectSession', 'entity_type', 'session', 'entity_id', c.collision_session_id,
      'payload', jsonb_build_object('effective_ended_at', timezone('utc', now()) - interval '1 minute', 'reason', 'QA inactive', 'audit_log_id', '__RUN_ID__-audit-inactive'));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Inactive actor did not fail.');

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  failed := false;
  begin
    perform public.reject_customer_tab_v2(jsonb_build_object(
      'organization_id', c.organization_id, 'mutation_id', '__RUN_ID__-mutation-anon',
      'mutation_kind', 'rejectCustomerTab', 'entity_type', 'customer_tab', 'entity_id', c.reject_tab_id,
      'payload', jsonb_build_object('effective_closed_at', timezone('utc', now()) - interval '1 minute', 'reason', 'QA anon', 'audit_log_id', '__RUN_ID__-audit-anon'));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Anonymous actor did not fail.');
  perform set_config('request.jwt.claim.sub', c.actor_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',c.actor_id::text,'role','authenticated')::text, true);

  failed := false;
  begin
    perform public.reject_customer_tab_v2(jsonb_build_object(
      'organization_id', '__RUN_ID__-wrong-org', 'mutation_id', '__RUN_ID__-mutation-wrong-org',
      'mutation_kind', 'rejectCustomerTab', 'entity_type', 'customer_tab', 'entity_id', c.reject_tab_id,
      'payload', jsonb_build_object('effective_closed_at', timezone('utc', now()) - interval '1 minute', 'reason', 'QA wrong org', 'audit_log_id', '__RUN_ID__-audit-wrong-org'));
  exception when others then failed := true; end;
  perform pg_temp.qa_assert(failed, 'Wrong organization did not fail.');
end $$;

-- Rollback-only latency samples use unique fixtures and the same authenticated
-- SQL transaction. They measure database execution without browser/network
-- noise; browser acknowledgement is covered by the Playwright lifecycle gate.
create temp table qa_performance(case_name text, sample_number integer, duration_ms numeric) on commit drop;

insert into public.sessions (
  organization_id, id, station_id, station_name_snapshot, mode, started_at, status,
  customer_name, play_mode, ltp_eligible, pricing_snapshot, pause_log_ids,
  continued_from_session_ids, raw_data
)
select c.organization_id, c.run_id||'-perf-'||kind||'-'||lpad(sample::text,2,'0'),
  c.run_id||'-perf-station-'||kind||'-'||lpad(sample::text,2,'0'), 'QA Perf '||kind,
  case when sample % 2 = 0 then 'unit' else 'timed' end,
  timezone('utc',now())-interval '10 minutes', 'active', 'QA Operational Perf', 'group', false,
  '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, jsonb_build_object('qaRunId',c.run_id,'sample',sample,'kind',kind)
from qa_context c cross join (values('hop'),('reject')) kinds(kind) cross join generate_series(1,20) sample;

insert into public.customer_tabs (organization_id,id,customer_name,status,opened_at,continued_from_session_ids,raw_data)
select c.organization_id, c.run_id||'-perf-tab-'||lpad(sample::text,2,'0'), 'QA Operational Perf Tab', 'open',
  timezone('utc',now())-interval '10 minutes', '[]'::jsonb, jsonb_build_object('qaRunId',c.run_id,'sample',sample)
from qa_context c cross join generate_series(1,20) sample;

do $$
declare c qa_context%rowtype; sample integer; started timestamptz;
begin
  select * into c from qa_context;
  for sample in 1..20 loop
    started := clock_timestamp();
    perform public.hop_session_v2(jsonb_build_object(
      'organization_id',c.organization_id,'mutation_id',c.run_id||'-perf-mutation-hop-'||lpad(sample::text,2,'0'),
      'mutation_kind','hopSession','entity_type','session','entity_id',c.run_id||'-perf-hop-'||lpad(sample::text,2,'0'),
      'payload',jsonb_build_object('effective_ended_at',timezone('utc',now()),'audit_log_id',c.run_id||'-perf-audit-hop-'||lpad(sample::text,2,'0'))));
    insert into qa_performance values('hop_session_v2',sample,extract(epoch from clock_timestamp()-started)*1000);

    started := clock_timestamp();
    perform public.reject_session_v2(jsonb_build_object(
      'organization_id',c.organization_id,'mutation_id',c.run_id||'-perf-mutation-reject-'||lpad(sample::text,2,'0'),
      'mutation_kind','rejectSession','entity_type','session','entity_id',c.run_id||'-perf-reject-'||lpad(sample::text,2,'0'),
      'payload',jsonb_build_object('effective_ended_at',timezone('utc',now()),'reason','QA performance proof','audit_log_id',c.run_id||'-perf-audit-reject-'||lpad(sample::text,2,'0'))));
    insert into qa_performance values('reject_session_v2',sample,extract(epoch from clock_timestamp()-started)*1000);

    started := clock_timestamp();
    perform public.reject_customer_tab_v2(jsonb_build_object(
      'organization_id',c.organization_id,'mutation_id',c.run_id||'-perf-mutation-tab-'||lpad(sample::text,2,'0'),
      'mutation_kind','rejectCustomerTab','entity_type','customer_tab','entity_id',c.run_id||'-perf-tab-'||lpad(sample::text,2,'0'),
      'payload',jsonb_build_object('effective_closed_at',timezone('utc',now()),'reason','QA performance proof','audit_log_id',c.run_id||'-perf-audit-tab-'||lpad(sample::text,2,'0'))));
    insert into qa_performance values('reject_customer_tab_v2',sample,extract(epoch from clock_timestamp()-started)*1000);
  end loop;
end $$;

select pg_temp.qa_assert(not exists(
  select 1 from (
    select case_name, count(*) samples,
      percentile_cont(0.95) within group(order by duration_ms) p95_ms,
      max(duration_ms) max_ms
    from qa_performance group by case_name
  ) performance where samples<>20 or p95_ms>=2000 or max_ms>=5000
), 'Operational lifecycle database latency budget failed.');

select pg_temp.qa_assert((select result->>'idempotent'='false' from qa_results where case_name='hop'), 'Initial hop was not canonical.');
select pg_temp.qa_assert((select result->>'idempotent'='true' from qa_results where case_name='hop_replay'), 'Same-ID hop replay was not idempotent.');
select pg_temp.qa_assert((select result->>'event_id' from qa_results where case_name='hop')=(select result->>'event_id' from qa_results where case_name='hop_replay'), 'Replay returned a different event.');
select pg_temp.qa_assert((select result->>'idempotent'='true' from qa_results where case_name='reject_session_replay'), 'Same-ID session rejection replay was not idempotent.');
select pg_temp.qa_assert((select result->>'idempotent'='true' from qa_results where case_name='reject_tab_replay'), 'Same-ID tab rejection replay was not idempotent.');
select pg_temp.qa_assert((select count(*)=3 from public.operational_mutations m cross join qa_context c where m.organization_id=c.organization_id and m.mutation_id in (c.run_id||'-mutation-hop',c.run_id||'-mutation-reject',c.run_id||'-mutation-tab') and m.status='committed' and m.actor_id=c.actor_id), 'Committed mutation actor/count mismatch.');
select pg_temp.qa_assert((select count(*)=3 from public.audit_logs a cross join qa_context c where a.organization_id=c.organization_id and a.id in (c.run_id||'-audit-hop',c.run_id||'-audit-reject',c.run_id||'-audit-tab') and a.user_id=c.actor_id::text), 'Audit actor/count mismatch.');
select pg_temp.qa_assert((select count(*)=3 from public.operational_events e cross join qa_context c where e.organization_id=c.organization_id and e.metadata->>'mutation_id' in (c.run_id||'-mutation-hop',c.run_id||'-mutation-reject',c.run_id||'-mutation-tab') and e.created_by=c.actor_id::text), 'Event actor/count mismatch.');
select pg_temp.qa_assert((select count(*)=64 from public.audit_logs a cross join qa_context c where a.organization_id=c.organization_id and a.id like c.run_id||'-%audit-%'), 'A failed case left an audit row or a performance audit is missing.');
select pg_temp.qa_assert((select count(*)=63 from public.operational_events e cross join qa_context c where e.organization_id=c.organization_id and e.metadata->>'mutation_id' like c.run_id||'-%mutation-%'), 'A failed case left an operational event or a performance event is missing.');
select pg_temp.qa_assert((select count(*)=1 from public.session_pause_logs p cross join qa_context c where p.organization_id=c.organization_id and p.id=c.run_id||'-pause' and p.resumed_at is not null), 'Paused rejection did not close the canonical pause.');
select pg_temp.qa_assert((select count(*)=2 from public.sessions s cross join qa_context c where s.organization_id=c.organization_id and s.id in (c.hop_session_id,c.reject_session_id) and s.status='closed'), 'Session lifecycle results are not closed.');
select pg_temp.qa_assert((select count(*)=1 from public.customer_tabs t cross join qa_context c where t.organization_id=c.organization_id and t.id=c.reject_tab_id and t.status='closed'), 'Tab rejection result is not closed.');
select pg_temp.qa_assert((select state.version=c.app_state_version and md5(state.data::text)=c.app_state_md5 and state.updated_at=c.app_state_updated_at and state.updated_by is not distinct from c.app_state_updated_by from public.app_state state cross join qa_context c where state.id='primary'), 'Operational v2 changed app_state.');

select jsonb_build_object(
  'proof','passed',
  'run_id',c.run_id,
  'project_ref','tkbdyzxwwbhkpztgjjxh',
  'actor_id',c.actor_id,
  'successful_cases',(select jsonb_object_agg(case_name,result) from qa_results),
  'negative_cases',jsonb_build_array('same-id-hop-mismatch','same-id-tab-mismatch','malformed-all-functions','wrong-kind-and-entity','future-time','before-start','closed-target','actor-spoof','late-audit-collision','inactive','anonymous','wrong-organization'),
  'performance',(select jsonb_object_agg(case_name,jsonb_build_object('samples',samples,'p95_ms',p95_ms,'max_ms',max_ms)) from (
    select case_name,count(*) samples,percentile_cont(0.95) within group(order by duration_ms) p95_ms,max(duration_ms) max_ms
    from qa_performance group by case_name
  ) measured),
  'app_state_unchanged',true,
  'rollback_required',true,
  'captured_at_utc',timezone('utc',clock_timestamp())
) as evidence
from qa_context c;

rollback;
