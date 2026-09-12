-- OPERATIONAL_LIFECYCLE_V2_TRANSACTIONAL_PROOF
-- Generated copies replace __RUN_ID__. Every fixture and mutation is rolled back.
begin isolation level serializable;
set local lock_timeout = '3s';
set local statement_timeout = '10min';

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

create temp table qa_app_state_original on commit drop as
select data,version,updated_at,updated_by from public.app_state where id='primary';

create or replace function pg_temp.qa_assert(ok boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception using errcode = 'QA001', message = message; end if;
end $$;

create temp table qa_negative_results (
  case_name text primary key,
  expected_code text not null,
  observed_code text not null
) on commit drop;

create or replace function pg_temp.qa_expect_rpc_error(case_name text, rpc_name text, rpc_payload jsonb, expected_code text)
returns void language plpgsql as $$
declare error_detail text; observed_code text; failed boolean := false;
begin
  begin
    execute format('select public.%I($1)', rpc_name) using rpc_payload;
  exception when others then
    failed := true;
    get stacked diagnostics error_detail = PG_EXCEPTION_DETAIL;
    begin observed_code := error_detail::jsonb->>'code'; exception when others then observed_code := sqlstate; end;
  end;
  perform pg_temp.qa_assert(failed, case_name || ' unexpectedly succeeded.');
  perform pg_temp.qa_assert(observed_code = expected_code, case_name || ' returned ' || coalesce(observed_code,'null') || ' instead of ' || expected_code || '.');
  insert into qa_negative_results values(case_name, expected_code, observed_code);
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
  union all
  select organization_id, run_id||'-missing-start', run_id||'-station-missing-start', 'QA Missing Start', 'active', '[]'::jsonb from qa_context
  union all
  select organization_id, run_id||'-paused-no-log', run_id||'-station-paused-no-log', 'QA Paused No Log', 'paused', '[]'::jsonb from qa_context
  union all
  select organization_id, run_id||'-foreign-pause-target', run_id||'-station-foreign-pause-target', 'QA Foreign Pause Target', 'paused', jsonb_build_array(run_id||'-foreign-pause') from qa_context
  union all
  select organization_id, run_id||'-foreign-pause-owner', run_id||'-station-foreign-pause-owner', 'QA Foreign Pause Owner', 'active', jsonb_build_array(run_id||'-foreign-pause') from qa_context
  union all
  select organization_id, run_id||'-multi-pause', run_id||'-station-multi-pause', 'QA Multiple Pauses', 'paused', jsonb_build_array(run_id||'-multi-pause-1',run_id||'-multi-pause-2') from qa_context
  union all
  select organization_id, run_id||'-pause-time', run_id||'-station-pause-time', 'QA Pause Timing', 'paused', jsonb_build_array(run_id||'-pause-time-log') from qa_context
  union all
  select organization_id, run_id||'-billed-session', run_id||'-station-billed', 'QA Billed Session', 'active', '[]'::jsonb from qa_context
  union all
  select organization_id, run_id||'-rejected-session', run_id||'-station-rejected', 'QA Rejected Session', 'closed', '[]'::jsonb from qa_context
) fixture;

update public.sessions s set started_at=null,raw_data=jsonb_set(s.raw_data,'{startedAt}','null'::jsonb,true)
from qa_context c where s.organization_id=c.organization_id and s.id=c.run_id||'-missing-start';
update public.sessions s set closed_bill_id='__RUN_ID__-synthetic-bill'
from qa_context c where s.organization_id=c.organization_id and s.id=c.run_id||'-billed-session';
update public.sessions s set close_disposition='rejected',close_reason='QA already rejected'
from qa_context c where s.organization_id=c.organization_id and s.id=c.run_id||'-rejected-session';

insert into public.session_pause_logs (organization_id, id, session_id, paused_at, raw_data)
select organization_id, '__RUN_ID__-pause', reject_session_id, timezone('utc', now()) - interval '5 minutes',
  jsonb_build_object('id', '__RUN_ID__-pause', 'sessionId', reject_session_id, 'pausedAt', timezone('utc', now()) - interval '5 minutes')
from qa_context;

insert into public.session_pause_logs (organization_id,id,session_id,paused_at,raw_data)
select organization_id,run_id||'-foreign-pause',run_id||'-foreign-pause-owner',timezone('utc',now())-interval '5 minutes',jsonb_build_object('qaRunId',run_id)
from qa_context
union all
select organization_id,run_id||'-multi-pause-1',run_id||'-multi-pause',timezone('utc',now())-interval '6 minutes',jsonb_build_object('qaRunId',run_id) from qa_context
union all
select organization_id,run_id||'-multi-pause-2',run_id||'-multi-pause',timezone('utc',now())-interval '5 minutes',jsonb_build_object('qaRunId',run_id) from qa_context;
insert into public.session_pause_logs (organization_id,id,session_id,paused_at,raw_data)
select organization_id,run_id||'-pause-time-log',run_id||'-pause-time',timezone('utc',now())-interval '5 minutes',jsonb_build_object('qaRunId',run_id) from qa_context;

insert into public.customer_tabs (
  organization_id, id, customer_name, status, opened_at, continued_from_session_ids, raw_data
)
select organization_id, reject_tab_id, 'QA Operational V2 Proof Tab', 'open', timezone('utc', now()) - interval '15 minutes', '[]'::jsonb,
  jsonb_build_object('id', reject_tab_id, 'customerName', 'QA Operational V2 Proof Tab', 'status', 'open')
from qa_context;

insert into public.customer_tabs (organization_id,id,customer_name,status,opened_at,continued_from_session_ids,closed_bill_id,close_disposition,close_reason,raw_data)
select organization_id,run_id||'-billed-tab','QA Billed Tab','open',timezone('utc',now())-interval '15 minutes','[]'::jsonb,run_id||'-synthetic-bill',null,null,jsonb_build_object('qaRunId',run_id)
from qa_context
union all
select organization_id,run_id||'-closed-tab','QA Closed Tab','closed',timezone('utc',now())-interval '15 minutes','[]'::jsonb,null,'rejected','QA already rejected',jsonb_build_object('qaRunId',run_id)
from qa_context
union all
select organization_id,run_id||'-timing-tab','QA Timing Tab','open',timezone('utc',now())-interval '1 minute','[]'::jsonb,null,null,null,jsonb_build_object('qaRunId',run_id)
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

-- Execute every input/state/security class with an exact application error
-- code. Each expected failure is isolated in the helper subtransaction, so no
-- mutation, audit, event, or domain row may leak from a rejected command.
do $$
declare c qa_context%rowtype; ended timestamptz := timezone('utc',now())-interval '10 seconds';
begin
  select * into c from qa_context;
  perform pg_temp.qa_expect_rpc_error('missing-organization','hop_session_v2',jsonb_build_object(
    'mutation_id',c.run_id||'-neg-missing-org','mutation_kind','hopSession','entity_type','session','entity_id',c.collision_session_id,
    'payload',jsonb_build_object('effective_ended_at',ended,'audit_log_id',c.run_id||'-audit-neg-missing-org')),'invalid_payload');
  perform pg_temp.qa_expect_rpc_error('wrong-kind','hop_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-kind','mutation_kind','rejectSession','entity_type','session','entity_id',c.collision_session_id,
    'payload',jsonb_build_object('effective_ended_at',ended,'audit_log_id',c.run_id||'-audit-neg-kind')),'invalid_payload');
  perform pg_temp.qa_expect_rpc_error('wrong-entity-type','hop_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-type','mutation_kind','hopSession','entity_type','customer_tab','entity_id',c.collision_session_id,
    'payload',jsonb_build_object('effective_ended_at',ended,'audit_log_id',c.run_id||'-audit-neg-type')),'invalid_payload');
  perform pg_temp.qa_expect_rpc_error('missing-entity','hop_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-entity','mutation_kind','hopSession','entity_type','session',
    'payload',jsonb_build_object('effective_ended_at',ended,'audit_log_id',c.run_id||'-audit-neg-entity')),'invalid_payload');
  perform pg_temp.qa_expect_rpc_error('missing-audit','hop_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-audit','mutation_kind','hopSession','entity_type','session','entity_id',c.collision_session_id,
    'payload',jsonb_build_object('effective_ended_at',ended)),'invalid_payload');
  perform pg_temp.qa_expect_rpc_error('nested-array','hop_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-array','mutation_kind','hopSession','entity_type','session','entity_id',c.collision_session_id,'payload','[]'::jsonb),'invalid_payload');
  perform pg_temp.qa_expect_rpc_error('root-array','hop_session_v2','[]'::jsonb,'invalid_payload');
  perform pg_temp.qa_expect_rpc_error('outer-inner-mismatch','hop_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-inner','mutation_kind','hopSession','entity_type','session','entity_id',c.collision_session_id,
    'payload',jsonb_build_object('effective_ended_at',ended,'audit_log_id',c.run_id||'-audit-neg-inner','session',jsonb_build_object('id','different-session'))),'invalid_payload');
  perform pg_temp.qa_expect_rpc_error('compatibility-version-authority','hop_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-version','mutation_kind','hopSession','entity_type','session','entity_id',c.collision_session_id,'base_app_state_version',c.app_state_version,
    'payload',jsonb_build_object('effective_ended_at',ended,'audit_log_id',c.run_id||'-audit-neg-version')),'invalid_payload');
  perform pg_temp.qa_expect_rpc_error('actor-spoof','hop_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-spoof-exact','mutation_kind','hopSession','entity_type','session','entity_id',c.collision_session_id,'user_id',gen_random_uuid()::text,
    'payload',jsonb_build_object('effective_ended_at',ended,'audit_log_id',c.run_id||'-audit-neg-spoof-exact')),'invalid_payload');
  perform pg_temp.qa_expect_rpc_error('malformed-session-time','hop_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-time','mutation_kind','hopSession','entity_type','session','entity_id',c.collision_session_id,
    'payload',jsonb_build_object('effective_ended_at','not-a-time','audit_log_id',c.run_id||'-audit-neg-time')),'invalid_session_timing');
  perform pg_temp.qa_expect_rpc_error('future-session-time','hop_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-future-exact','mutation_kind','hopSession','entity_type','session','entity_id',c.collision_session_id,
    'payload',jsonb_build_object('effective_ended_at',timezone('utc',now())+interval '1 minute','audit_log_id',c.run_id||'-audit-neg-future-exact')),'invalid_session_timing');
  perform pg_temp.qa_expect_rpc_error('session-end-before-start','hop_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-before-exact','mutation_kind','hopSession','entity_type','session','entity_id',c.collision_session_id,
    'payload',jsonb_build_object('effective_ended_at',timezone('utc',now())-interval '30 minutes','audit_log_id',c.run_id||'-audit-neg-before-exact')),'invalid_session_timing');
  perform pg_temp.qa_expect_rpc_error('missing-canonical-start','hop_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-start','mutation_kind','hopSession','entity_type','session','entity_id',c.run_id||'-missing-start',
    'payload',jsonb_build_object('effective_ended_at',ended,'audit_log_id',c.run_id||'-audit-neg-start')),'invalid_session_timing');
  perform pg_temp.qa_expect_rpc_error('missing-open-pause','reject_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-no-pause','mutation_kind','rejectSession','entity_type','session','entity_id',c.run_id||'-paused-no-log',
    'payload',jsonb_build_object('effective_ended_at',ended,'reason','QA invalid pause','audit_log_id',c.run_id||'-audit-neg-no-pause')),'invalid_pause_state');
  perform pg_temp.qa_expect_rpc_error('foreign-open-pause','reject_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-foreign-pause','mutation_kind','rejectSession','entity_type','session','entity_id',c.run_id||'-foreign-pause-target',
    'payload',jsonb_build_object('effective_ended_at',ended,'reason','QA foreign pause','audit_log_id',c.run_id||'-audit-neg-foreign-pause')),'invalid_pause_state');
  perform pg_temp.qa_expect_rpc_error('multiple-open-pauses','reject_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-multi-pause','mutation_kind','rejectSession','entity_type','session','entity_id',c.run_id||'-multi-pause',
    'payload',jsonb_build_object('effective_ended_at',ended,'reason','QA multiple pause','audit_log_id',c.run_id||'-audit-neg-multi-pause')),'invalid_pause_state');
  perform pg_temp.qa_expect_rpc_error('end-before-open-pause','reject_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-pause-time','mutation_kind','rejectSession','entity_type','session','entity_id',c.run_id||'-pause-time',
    'payload',jsonb_build_object('effective_ended_at',timezone('utc',now())-interval '6 minutes','reason','QA pause timing','audit_log_id',c.run_id||'-audit-neg-pause-time')),'invalid_pause_state');
  perform pg_temp.qa_expect_rpc_error('empty-reason','reject_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-reason','mutation_kind','rejectSession','entity_type','session','entity_id',c.collision_session_id,
    'payload',jsonb_build_object('effective_ended_at',ended,'reason','   ','audit_log_id',c.run_id||'-audit-neg-reason')),'invalid_payload');
  perform pg_temp.qa_expect_rpc_error('missing-session-target','reject_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-missing-session','mutation_kind','rejectSession','entity_type','session','entity_id',c.run_id||'-does-not-exist',
    'payload',jsonb_build_object('effective_ended_at',ended,'reason','QA missing','audit_log_id',c.run_id||'-audit-neg-missing-session')),'session_not_open');
  perform pg_temp.qa_expect_rpc_error('rejected-session-target','reject_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-rejected','mutation_kind','rejectSession','entity_type','session','entity_id',c.run_id||'-rejected-session',
    'payload',jsonb_build_object('effective_ended_at',ended,'reason','QA closed','audit_log_id',c.run_id||'-audit-neg-rejected')),'session_not_open');
  perform pg_temp.qa_expect_rpc_error('billed-session-target','reject_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-billed','mutation_kind','rejectSession','entity_type','session','entity_id',c.run_id||'-billed-session',
    'payload',jsonb_build_object('effective_ended_at',ended,'reason','QA billed','audit_log_id',c.run_id||'-audit-neg-billed')),'session_already_billed');
  perform pg_temp.qa_expect_rpc_error('missing-tab-target','reject_customer_tab_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-missing-tab','mutation_kind','rejectCustomerTab','entity_type','customer_tab','entity_id',c.run_id||'-tab-does-not-exist',
    'payload',jsonb_build_object('effective_closed_at',ended,'reason','QA missing','audit_log_id',c.run_id||'-audit-neg-missing-tab')),'customer_tab_not_open');
  perform pg_temp.qa_expect_rpc_error('closed-tab-target','reject_customer_tab_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-closed-tab','mutation_kind','rejectCustomerTab','entity_type','customer_tab','entity_id',c.run_id||'-closed-tab',
    'payload',jsonb_build_object('effective_closed_at',ended,'reason','QA closed','audit_log_id',c.run_id||'-audit-neg-closed-tab')),'customer_tab_not_open');
  perform pg_temp.qa_expect_rpc_error('billed-tab-target','reject_customer_tab_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-billed-tab','mutation_kind','rejectCustomerTab','entity_type','customer_tab','entity_id',c.run_id||'-billed-tab',
    'payload',jsonb_build_object('effective_closed_at',ended,'reason','QA billed','audit_log_id',c.run_id||'-audit-neg-billed-tab')),'customer_tab_already_billed');
  perform pg_temp.qa_expect_rpc_error('malformed-tab-time','reject_customer_tab_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-tab-time','mutation_kind','rejectCustomerTab','entity_type','customer_tab','entity_id',c.run_id||'-timing-tab',
    'payload',jsonb_build_object('effective_closed_at','not-a-time','reason','QA timing','audit_log_id',c.run_id||'-audit-neg-tab-time')),'invalid_tab_timing');
  perform pg_temp.qa_expect_rpc_error('tab-before-open','reject_customer_tab_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-tab-before','mutation_kind','rejectCustomerTab','entity_type','customer_tab','entity_id',c.run_id||'-timing-tab',
    'payload',jsonb_build_object('effective_closed_at',timezone('utc',now())-interval '2 minutes','reason','QA timing','audit_log_id',c.run_id||'-audit-neg-tab-before')),'invalid_tab_timing');
  perform pg_temp.qa_expect_rpc_error('wrong-organization','reject_customer_tab_v2',jsonb_build_object(
    'organization_id',c.run_id||'-wrong-org','mutation_id',c.run_id||'-neg-wrong-org-exact','mutation_kind','rejectCustomerTab','entity_type','customer_tab','entity_id',c.reject_tab_id,
    'payload',jsonb_build_object('effective_closed_at',ended,'reason','QA wrong org','audit_log_id',c.run_id||'-audit-neg-wrong-org-exact')),'organization_access_denied');
  perform pg_temp.qa_expect_rpc_error('same-id-different-intent','hop_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-mutation-hop','mutation_kind','hopSession','entity_type','session','entity_id',c.hop_session_id,
    'payload',jsonb_build_object('effective_ended_at',c.proof_end_at-interval '1 minute','audit_log_id',c.run_id||'-audit-hop')),'mutation_identity_mismatch');
  perform pg_temp.qa_expect_rpc_error('audit-collision','reject_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-audit-collision-exact','mutation_kind','rejectSession','entity_type','session','entity_id',c.collision_session_id,
    'payload',jsonb_build_object('effective_ended_at',ended,'reason','QA collision','audit_log_id',c.run_id||'-audit-collision')),'audit_id_conflict');

  update public.profiles set active=false where id=c.actor_id;
  perform pg_temp.qa_expect_rpc_error('inactive-actor','reject_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-inactive-exact','mutation_kind','rejectSession','entity_type','session','entity_id',c.collision_session_id,
    'payload',jsonb_build_object('effective_ended_at',ended,'reason','QA inactive','audit_log_id',c.run_id||'-audit-neg-inactive-exact')),'organization_access_denied');
  update public.profiles set active=true where id=c.actor_id;

  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  perform pg_temp.qa_expect_rpc_error('anonymous-actor','reject_session_v2',jsonb_build_object(
    'organization_id',c.organization_id,'mutation_id',c.run_id||'-neg-anon-exact','mutation_kind','rejectSession','entity_type','session','entity_id',c.collision_session_id,
    'payload',jsonb_build_object('effective_ended_at',ended,'reason','QA anon','audit_log_id',c.run_id||'-audit-neg-anon-exact')),'organization_access_denied');
  perform set_config('request.jwt.claim.sub',c.actor_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',c.actor_id::text,'role','authenticated')::text,true);

  perform pg_temp.qa_assert((select array_agg(enumlabel::text order by enumsortorder)=array['admin','manager','receptionist']::text[] from pg_enum join pg_type on pg_type.oid=pg_enum.enumtypid where pg_type.typname='app_role'), 'Unsupported role became representable in app_role.');
  insert into qa_negative_results values('unsupported-role','schema-excludes-value','schema-excludes-value');
end $$;

-- Rollback-only latency samples use unique fixtures and the same authenticated
-- SQL transaction. They measure database execution without browser/network
-- noise; browser acknowledgement is covered by the Playwright lifecycle gate.
create temp table qa_performance(
  case_name text,
  sample_number integer,
  duration_ms numeric,
  implementation text default 'v2',
  dataset_size text default 'large'
) on commit drop;

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
    insert into qa_performance(case_name,sample_number,duration_ms) values('hop_session_v2',sample,extract(epoch from clock_timestamp()-started)*1000);

    started := clock_timestamp();
    perform public.reject_session_v2(jsonb_build_object(
      'organization_id',c.organization_id,'mutation_id',c.run_id||'-perf-mutation-reject-'||lpad(sample::text,2,'0'),
      'mutation_kind','rejectSession','entity_type','session','entity_id',c.run_id||'-perf-reject-'||lpad(sample::text,2,'0'),
      'payload',jsonb_build_object('effective_ended_at',timezone('utc',now()),'reason','QA performance proof','audit_log_id',c.run_id||'-perf-audit-reject-'||lpad(sample::text,2,'0'))));
    insert into qa_performance(case_name,sample_number,duration_ms) values('reject_session_v2',sample,extract(epoch from clock_timestamp()-started)*1000);

    started := clock_timestamp();
    perform public.reject_customer_tab_v2(jsonb_build_object(
      'organization_id',c.organization_id,'mutation_id',c.run_id||'-perf-mutation-tab-'||lpad(sample::text,2,'0'),
      'mutation_kind','rejectCustomerTab','entity_type','customer_tab','entity_id',c.run_id||'-perf-tab-'||lpad(sample::text,2,'0'),
      'payload',jsonb_build_object('effective_closed_at',timezone('utc',now()),'reason','QA performance proof','audit_log_id',c.run_id||'-perf-audit-tab-'||lpad(sample::text,2,'0'))));
    insert into qa_performance(case_name,sample_number,duration_ms) values('reject_customer_tab_v2',sample,extract(epoch from clock_timestamp()-started)*1000);
  end loop;
end $$;

-- Prove v2 execution is insensitive to compatibility-document size. The
-- original multi-megabyte row is restored before the legacy comparison and
-- again before returning evidence.
insert into public.sessions (
  organization_id,id,station_id,station_name_snapshot,mode,started_at,status,
  customer_name,play_mode,ltp_eligible,pricing_snapshot,pause_log_ids,continued_from_session_ids,raw_data
)
select c.organization_id,c.run_id||'-small-hop-'||lpad(sample::text,2,'0'),c.run_id||'-small-station-hop-'||sample,'QA Small Hop','timed',timezone('utc',now())-interval '10 minutes','active','QA Small','group',false,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,jsonb_build_object('qaRunId',c.run_id)
from qa_context c cross join generate_series(1,10) sample
union all
select c.organization_id,c.run_id||'-small-reject-'||lpad(sample::text,2,'0'),c.run_id||'-small-station-reject-'||sample,'QA Small Reject','timed',timezone('utc',now())-interval '10 minutes','active','QA Small','group',false,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,jsonb_build_object('qaRunId',c.run_id)
from qa_context c cross join generate_series(1,10) sample;
insert into public.customer_tabs(organization_id,id,customer_name,status,opened_at,continued_from_session_ids,raw_data)
select c.organization_id,c.run_id||'-small-tab-'||lpad(sample::text,2,'0'),'QA Small Tab','open',timezone('utc',now())-interval '10 minutes','[]'::jsonb,jsonb_build_object('qaRunId',c.run_id)
from qa_context c cross join generate_series(1,10) sample;

update public.app_state set data=jsonb_build_object('sessions','[]'::jsonb,'sessionPauseLogs','[]'::jsonb,'customerTabs','[]'::jsonb,'auditLogs','[]'::jsonb)
where id='primary';

do $$
declare c qa_context%rowtype; sample integer; started timestamptz;
begin
  select * into c from qa_context;
  for sample in 1..10 loop
    started:=clock_timestamp();
    perform public.hop_session_v2(jsonb_build_object('organization_id',c.organization_id,'mutation_id',c.run_id||'-small-mutation-hop-'||lpad(sample::text,2,'0'),'mutation_kind','hopSession','entity_type','session','entity_id',c.run_id||'-small-hop-'||lpad(sample::text,2,'0'),'payload',jsonb_build_object('effective_ended_at',timezone('utc',now()),'audit_log_id',c.run_id||'-small-audit-hop-'||lpad(sample::text,2,'0'))));
    insert into qa_performance values('hop_session_v2',sample,extract(epoch from clock_timestamp()-started)*1000,'v2','small');
    started:=clock_timestamp();
    perform public.reject_session_v2(jsonb_build_object('organization_id',c.organization_id,'mutation_id',c.run_id||'-small-mutation-reject-'||lpad(sample::text,2,'0'),'mutation_kind','rejectSession','entity_type','session','entity_id',c.run_id||'-small-reject-'||lpad(sample::text,2,'0'),'payload',jsonb_build_object('effective_ended_at',timezone('utc',now()),'reason','QA small proof','audit_log_id',c.run_id||'-small-audit-reject-'||lpad(sample::text,2,'0'))));
    insert into qa_performance values('reject_session_v2',sample,extract(epoch from clock_timestamp()-started)*1000,'v2','small');
    started:=clock_timestamp();
    perform public.reject_customer_tab_v2(jsonb_build_object('organization_id',c.organization_id,'mutation_id',c.run_id||'-small-mutation-tab-'||lpad(sample::text,2,'0'),'mutation_kind','rejectCustomerTab','entity_type','customer_tab','entity_id',c.run_id||'-small-tab-'||lpad(sample::text,2,'0'),'payload',jsonb_build_object('effective_closed_at',timezone('utc',now()),'reason','QA small proof','audit_log_id',c.run_id||'-small-audit-tab-'||lpad(sample::text,2,'0'))));
    insert into qa_performance values('reject_customer_tab_v2',sample,extract(epoch from clock_timestamp()-started)*1000,'v2','small');
  end loop;
end $$;

update public.app_state state set data=original.data,version=original.version,updated_at=original.updated_at,updated_by=original.updated_by
from qa_app_state_original original where state.id='primary';

select pg_temp.qa_assert(not exists(
  select 1 from (
    select large.case_name,large.p95_ms large_p95,small.p95_ms small_p95
    from (select case_name,percentile_cont(0.95) within group(order by duration_ms) p95_ms from qa_performance where implementation='v2' and dataset_size='large' group by case_name) large
    join (select case_name,percentile_cont(0.95) within group(order by duration_ms) p95_ms from qa_performance where implementation='v2' and dataset_size='small' group by case_name) small using(case_name)
  ) delta where abs(large_p95-small_p95)>greatest(small_p95*0.20,250)
), 'Operational v2 changed materially with compatibility-document size.');

-- Frozen same-scale v1 comparison. These fixtures run against the restored
-- production-logical-size compatibility document; all v1 effects are then
-- restored inside this outer rollback-only transaction.
insert into public.sessions(organization_id,id,station_id,station_name_snapshot,mode,started_at,status,customer_name,play_mode,ltp_eligible,pricing_snapshot,pause_log_ids,continued_from_session_ids,raw_data)
select c.organization_id,c.run_id||'-v1-'||kind||'-'||lpad(sample::text,2,'0'),c.run_id||'-v1-station-'||kind||'-'||sample,'QA V1 '||kind,'timed',timezone('utc',now())-interval '10 minutes','active','QA V1','group',false,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,jsonb_build_object('qaRunId',c.run_id)
from qa_context c cross join (values('hop'),('reject')) kinds(kind) cross join generate_series(1,20) sample;
insert into public.customer_tabs(organization_id,id,customer_name,status,opened_at,continued_from_session_ids,raw_data)
select c.organization_id,c.run_id||'-v1-tab-'||lpad(sample::text,2,'0'),'QA V1 Tab','open',timezone('utc',now())-interval '10 minutes','[]'::jsonb,jsonb_build_object('qaRunId',c.run_id)
from qa_context c cross join generate_series(1,20) sample;

do $$
declare c qa_context%rowtype; sample integer; started timestamptz; entity_id text; audit_id text; effective_at timestamptz;
begin
  select * into c from qa_context;
  for sample in 1..20 loop
    effective_at:=timezone('utc',now()); entity_id:=c.run_id||'-v1-hop-'||lpad(sample::text,2,'0'); audit_id:=c.run_id||'-v1-audit-hop-'||lpad(sample::text,2,'0');
    started:=clock_timestamp();
    perform public.hop_session(jsonb_build_object('organization_id',c.organization_id,'mutation_id',c.run_id||'-v1-mutation-hop-'||lpad(sample::text,2,'0'),'mutation_kind','hopSession','user_id',c.actor_id::text,'payload',jsonb_build_object('session',jsonb_build_object('id',entity_id,'status','closed','closeDisposition','hopped','endedAt',effective_at),'auditLog',jsonb_build_object('id',audit_id,'action','session_hopped','entityType','session','entityId',entity_id,'message','QA v1 hop','createdAt',effective_at,'userId',c.actor_id::text))));
    insert into qa_performance values('hop_session_v2',sample,extract(epoch from clock_timestamp()-started)*1000,'v1','large');

    effective_at:=timezone('utc',now()); entity_id:=c.run_id||'-v1-reject-'||lpad(sample::text,2,'0'); audit_id:=c.run_id||'-v1-audit-reject-'||lpad(sample::text,2,'0');
    started:=clock_timestamp();
    perform public.reject_session(jsonb_build_object('organization_id',c.organization_id,'mutation_id',c.run_id||'-v1-mutation-reject-'||lpad(sample::text,2,'0'),'mutation_kind','rejectSession','user_id',c.actor_id::text,'payload',jsonb_build_object('session',jsonb_build_object('id',entity_id,'status','closed','closeDisposition','rejected','closeReason','QA v1 reject','endedAt',effective_at),'auditLog',jsonb_build_object('id',audit_id,'action','session_rejected','entityType','session','entityId',entity_id,'message','QA v1 reject','createdAt',effective_at,'userId',c.actor_id::text))));
    insert into qa_performance values('reject_session_v2',sample,extract(epoch from clock_timestamp()-started)*1000,'v1','large');

    effective_at:=timezone('utc',now()); entity_id:=c.run_id||'-v1-tab-'||lpad(sample::text,2,'0'); audit_id:=c.run_id||'-v1-audit-tab-'||lpad(sample::text,2,'0');
    started:=clock_timestamp();
    perform public.reject_customer_tab(jsonb_build_object('organization_id',c.organization_id,'mutation_id',c.run_id||'-v1-mutation-tab-'||lpad(sample::text,2,'0'),'mutation_kind','rejectCustomerTab','user_id',c.actor_id::text,'payload',jsonb_build_object('tab',jsonb_build_object('id',entity_id,'status','closed','closeDisposition','rejected','closeReason','QA v1 reject','closedAt',effective_at),'auditLog',jsonb_build_object('id',audit_id,'action','customer_tab_rejected','entityType','customer_tab','entityId',entity_id,'message','QA v1 tab reject','createdAt',effective_at,'userId',c.actor_id::text))));
    insert into qa_performance values('reject_customer_tab_v2',sample,extract(epoch from clock_timestamp()-started)*1000,'v1','large');
  end loop;
end $$;

select pg_temp.qa_assert(not exists(
  select 1 from (
    select v2.case_name,v2.p95_ms v2_p95,v1.p95_ms v1_p95
    from (select case_name,percentile_cont(0.95) within group(order by duration_ms) p95_ms from qa_performance where implementation='v2' and dataset_size='large' group by case_name) v2
    join (select case_name,percentile_cont(0.95) within group(order by duration_ms) p95_ms from qa_performance where implementation='v1' and dataset_size='large' group by case_name) v1 using(case_name)
  ) comparison where v2_p95>v1_p95*0.50
), 'Operational v2 was not at least 50 percent faster than same-scale v1.');

update public.app_state state set data=original.data,version=original.version,updated_at=original.updated_at,updated_by=original.updated_by
from qa_app_state_original original where state.id='primary';

select pg_temp.qa_assert(not exists(
  select 1 from (
    select case_name, count(*) samples,
      percentile_cont(0.95) within group(order by duration_ms) p95_ms,
      max(duration_ms) max_ms
    from qa_performance where implementation='v2' and dataset_size='large' group by case_name
  ) performance where samples<>20 or p95_ms>=500 or max_ms>=2000
), 'Operational lifecycle database latency budget failed.');

select pg_temp.qa_assert((select result->>'idempotent'='false' from qa_results where case_name='hop'), 'Initial hop was not canonical.');
select pg_temp.qa_assert((select result->>'idempotent'='true' from qa_results where case_name='hop_replay'), 'Same-ID hop replay was not idempotent.');
select pg_temp.qa_assert((select result->>'event_id' from qa_results where case_name='hop')=(select result->>'event_id' from qa_results where case_name='hop_replay'), 'Replay returned a different event.');
select pg_temp.qa_assert((select result->>'idempotent'='true' from qa_results where case_name='reject_session_replay'), 'Same-ID session rejection replay was not idempotent.');
select pg_temp.qa_assert((select result->>'idempotent'='true' from qa_results where case_name='reject_tab_replay'), 'Same-ID tab rejection replay was not idempotent.');
select pg_temp.qa_assert((select count(*)=3 from public.operational_mutations m cross join qa_context c where m.organization_id=c.organization_id and m.mutation_id in (c.run_id||'-mutation-hop',c.run_id||'-mutation-reject',c.run_id||'-mutation-tab') and m.status='committed' and m.actor_id=c.actor_id), 'Committed mutation actor/count mismatch.');
select pg_temp.qa_assert((select count(*)=3 from public.audit_logs a cross join qa_context c where a.organization_id=c.organization_id and a.id in (c.run_id||'-audit-hop',c.run_id||'-audit-reject',c.run_id||'-audit-tab') and a.user_id=c.actor_id::text), 'Audit actor/count mismatch.');
select pg_temp.qa_assert((select count(*)=3 from public.operational_events e cross join qa_context c where e.organization_id=c.organization_id and e.metadata->>'mutation_id' in (c.run_id||'-mutation-hop',c.run_id||'-mutation-reject',c.run_id||'-mutation-tab') and e.created_by=c.actor_id::text), 'Event actor/count mismatch.');
select pg_temp.qa_assert((select count(*)=93 from public.operational_mutations m cross join qa_context c where m.organization_id=c.organization_id and m.mutation_id like c.run_id||'-%mutation-%' and m.status='committed'), 'A successful v2 mutation is missing or a failed v2 case left a mutation row.');
select pg_temp.qa_assert((select count(*)=93 from public.operational_events e cross join qa_context c where e.organization_id=c.organization_id and e.metadata->>'mutation_id' like c.run_id||'-%mutation-%' and e.event_type in ('hop_session_v2','reject_session_v2','reject_customer_tab_v2')), 'A successful v2 event is missing or a failed v2 case left an event row.');
select pg_temp.qa_assert((select count(*)=93 from public.audit_logs a cross join qa_context c where a.organization_id=c.organization_id and a.id like c.run_id||'-%audit-%' and a.action in ('session_hopped','session_rejected','customer_tab_rejected')), 'A successful v2 audit is missing or a failed v2 case left an audit row.');
select pg_temp.qa_assert((select count(*)=60 from public.operational_events e cross join qa_context c where e.organization_id=c.organization_id and e.metadata->>'mutation_id' like c.run_id||'-v1-mutation-%' and e.event_type in ('hop_session','reject_session','reject_customer_tab')), 'A successful frozen v1 comparison event is missing.');
select pg_temp.qa_assert((select count(*)=60 from public.audit_logs a cross join qa_context c where a.organization_id=c.organization_id and a.id like c.run_id||'-v1-audit-%' and a.action in ('session_hopped','session_rejected','customer_tab_rejected')), 'A successful frozen v1 comparison audit is missing.');
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
  'negative_cases',(select jsonb_object_agg(case_name,jsonb_build_object('expected_code',expected_code,'observed_code',observed_code)) from qa_negative_results),
  'performance',(select jsonb_object_agg(case_name,jsonb_build_object('samples',samples,'p95_ms',p95_ms,'max_ms',max_ms)) from (
    select case_name,count(*) samples,percentile_cont(0.95) within group(order by duration_ms) p95_ms,max(duration_ms) max_ms
    from qa_performance where implementation='v2' and dataset_size='large' group by case_name
  ) measured),
  'performance_comparison',(select jsonb_object_agg(case_name,jsonb_build_object(
    'v2_large_p95_ms',v2_large_p95,'v2_small_p95_ms',v2_small_p95,'v1_large_p95_ms',v1_large_p95,
    'v2_at_least_50_percent_faster',v2_large_p95<=v1_large_p95*0.50,
    'large_small_within_budget',abs(v2_large_p95-v2_small_p95)<=greatest(v2_small_p95*0.20,250)
  )) from (
    select large.case_name,large.p95_ms v2_large_p95,small.p95_ms v2_small_p95,legacy.p95_ms v1_large_p95
    from (select case_name,percentile_cont(0.95) within group(order by duration_ms) p95_ms from qa_performance where implementation='v2' and dataset_size='large' group by case_name) large
    join (select case_name,percentile_cont(0.95) within group(order by duration_ms) p95_ms from qa_performance where implementation='v2' and dataset_size='small' group by case_name) small using(case_name)
    join (select case_name,percentile_cont(0.95) within group(order by duration_ms) p95_ms from qa_performance where implementation='v1' and dataset_size='large' group by case_name) legacy using(case_name)
  ) comparison),
  'app_state',(select jsonb_build_object('version',version,'bytes',octet_length(data::text),'md5',md5(data::text),'updated_at',updated_at,'updated_by',updated_by) from public.app_state where id='primary'),
  'app_state_unchanged',true,
  'rollback_required',true,
  'captured_at_utc',timezone('utc',clock_timestamp())
) as evidence
from qa_context c;

rollback;
