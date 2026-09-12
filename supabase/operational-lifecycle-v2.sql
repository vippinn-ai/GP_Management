-- Additive normalized-only lifecycle mutations.
-- Legacy hop_session/reject_session/reject_customer_tab remain installed for flag rollback.

create table if not exists public.operational_mutations (
  organization_id text not null references public.organizations (id) on delete cascade,
  mutation_id text not null,
  mutation_kind text not null,
  entity_type text not null,
  entity_id text not null,
  actor_id uuid not null,
  request_fingerprint text not null,
  status text not null check (status in ('processing', 'committed')),
  canonical_result jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, mutation_id)
);

create index if not exists operational_mutations_org_created_idx
  on public.operational_mutations (organization_id, created_at desc, mutation_id desc);

alter table public.operational_mutations enable row level security;
revoke all on table public.operational_mutations from public;
revoke all on table public.operational_mutations from anon;
revoke all on table public.operational_mutations from authenticated;

create or replace function public.hop_session_v2(payload jsonb)
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
  v_entity_type text := nullif(payload->>'entity_type', '');
  v_entity_id text := nullif(payload->>'entity_id', '');
  v_actor uuid := auth.uid();
  v_actor_role public.app_role;
  v_effective_end timestamptz;
  v_audit_log_id text := nullif(payload #>> '{payload,audit_log_id}', '');
  v_request_fingerprint text;
  v_existing public.operational_mutations%rowtype;
  v_session public.sessions%rowtype;
  v_pause_id text;
  v_open_pause_count integer := 0;
  v_event_id text := 'event-' || gen_random_uuid()::text;
  v_audit_message text;
  v_audit_raw jsonb;
  v_changed_rows jsonb;
  v_result jsonb;
  v_duration numeric;
begin
  if jsonb_typeof(payload) <> 'object' or v_organization_id is null or v_mutation_id is null
    or v_mutation_kind <> 'hopSession' or v_entity_type <> 'session' or v_entity_id is null
    or v_audit_log_id is null or payload ? 'user_id' or payload ? 'base_app_state_version'
    or jsonb_typeof(payload->'payload') <> 'object'
    or exists (select 1 from jsonb_object_keys(case when jsonb_typeof(payload)='object' then payload else '{}'::jsonb end) key where key not in ('organization_id','mutation_id','mutation_kind','label','entity_type','entity_id','client_created_at','payload'))
    or exists (select 1 from jsonb_object_keys(case when jsonb_typeof(payload->'payload')='object' then payload->'payload' else '{}'::jsonb end) key where key not in ('effective_ended_at','audit_log_id'))
  then
    perform public.raise_operational_rpc_error('invalid_payload', 'The normalized hop payload is invalid.', '{}'::jsonb);
  end if;

  begin
    v_effective_end := nullif(payload #>> '{payload,effective_ended_at}', '')::timestamptz;
  exception when others then
    perform public.raise_operational_rpc_error('invalid_session_timing', 'The session end time is invalid.', '{}'::jsonb);
  end;
  if v_effective_end is null or v_effective_end > clock_timestamp() then
    perform public.raise_operational_rpc_error('invalid_session_timing', 'The session end time is invalid.', '{}'::jsonb);
  end if;

  v_actor_role := public.current_user_org_role(v_organization_id);
  if v_actor is null or not public.current_user_has_org_access(v_organization_id)
    or v_actor_role not in ('admin'::public.app_role, 'manager'::public.app_role, 'receptionist'::public.app_role)
  then
    perform public.raise_operational_rpc_error('organization_access_denied', 'You do not have access to this organization.', jsonb_build_object('organization_id', v_organization_id));
  end if;

  v_request_fingerprint := md5(jsonb_build_object(
    'kind', v_mutation_kind, 'entity_type', v_entity_type, 'entity_id', v_entity_id,
    'effective_ended_at', v_effective_end, 'audit_log_id', v_audit_log_id
  )::text);

  perform pg_advisory_xact_lock(hashtextextended(v_organization_id || chr(31) || v_mutation_id, 0));
  insert into public.operational_mutations (
    organization_id, mutation_id, mutation_kind, entity_type, entity_id,
    actor_id, request_fingerprint, status
  ) values (
    v_organization_id, v_mutation_id, v_mutation_kind, v_entity_type, v_entity_id,
    v_actor, v_request_fingerprint, 'processing'
  ) on conflict (organization_id, mutation_id) do nothing;

  select * into v_existing
  from public.operational_mutations
  where organization_id = v_organization_id and mutation_id = v_mutation_id
  for update;

  if v_existing.mutation_kind <> v_mutation_kind or v_existing.entity_type <> v_entity_type
    or v_existing.entity_id <> v_entity_id or v_existing.actor_id <> v_actor
    or v_existing.request_fingerprint <> v_request_fingerprint
  then
    perform public.raise_operational_rpc_error('mutation_identity_mismatch', 'This mutation ID belongs to different intent.', jsonb_build_object('mutation_id', v_mutation_id));
  end if;
  if v_existing.status = 'committed' and v_existing.canonical_result is not null then
    return v_existing.canonical_result || jsonb_build_object('idempotent', true);
  end if;

  select * into v_session from public.sessions
  where organization_id = v_organization_id and id = v_entity_id
  for update;
  if not found or v_session.status = 'closed' then
    perform public.raise_operational_rpc_error('session_not_open', 'The session is no longer open.', jsonb_build_object('session_id', v_entity_id));
  end if;
  if v_session.closed_bill_id is not null then
    perform public.raise_operational_rpc_error('session_already_billed', 'The session is already linked to a bill.', jsonb_build_object('session_id', v_entity_id, 'bill_id', v_session.closed_bill_id));
  end if;
  if v_session.started_at is null or v_effective_end < v_session.started_at then
    perform public.raise_operational_rpc_error('invalid_session_timing', 'The session end time precedes its canonical start.', jsonb_build_object('session_id', v_entity_id));
  end if;

  perform 1 from public.session_pause_logs
  where organization_id = v_organization_id and session_id = v_entity_id and resumed_at is null
  order by paused_at, id for update;
  select count(*), min(id) into v_open_pause_count, v_pause_id
  from public.session_pause_logs
  where organization_id = v_organization_id and session_id = v_entity_id and resumed_at is null;
  if v_open_pause_count > 1 then
    perform public.raise_operational_rpc_error('invalid_pause_state', 'The session has multiple open pauses.', jsonb_build_object('session_id', v_entity_id));
  end if;
  if (v_session.status = 'paused' and v_open_pause_count <> 1)
    or (v_session.status <> 'paused' and v_open_pause_count <> 0)
  then
    perform public.raise_operational_rpc_error('invalid_pause_state', 'The session status and open pause do not agree.', jsonb_build_object('session_id', v_entity_id, 'status', v_session.status, 'open_pause_count', v_open_pause_count));
  end if;
  if v_pause_id is not null and exists (
    select 1 from public.session_pause_logs
    where organization_id = v_organization_id and id = v_pause_id and paused_at > v_effective_end
  ) then
    perform public.raise_operational_rpc_error('invalid_pause_state', 'The session end time precedes its open pause.', jsonb_build_object('session_id', v_entity_id, 'pause_id', v_pause_id));
  end if;

  update public.sessions set
    ended_at = v_effective_end,
    status = 'closed',
    closed_bill_id = null,
    close_disposition = 'hopped',
    close_reason = null,
    raw_data = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
      coalesce(v_session.raw_data, '{}'::jsonb),
      '{endedAt}', to_jsonb(v_effective_end), true),
      '{status}', '"closed"'::jsonb, true),
      '{closedBillId}', 'null'::jsonb, true),
      '{closeDisposition}', '"hopped"'::jsonb, true),
      '{closeReason}', 'null'::jsonb, true),
    updated_at = timezone('utc', now())
  where organization_id = v_organization_id and id = v_entity_id;

  if v_pause_id is not null then
    update public.session_pause_logs set
      resumed_at = v_effective_end,
      raw_data = jsonb_set(coalesce(raw_data, '{}'::jsonb), '{resumedAt}', to_jsonb(v_effective_end), true),
      updated_at = timezone('utc', now())
    where organization_id = v_organization_id and id = v_pause_id;
  end if;

  v_audit_message := 'Game hop: closed ' || coalesce(nullif(v_session.station_name_snapshot, ''), 'session') || ' without billing. Station released for next customer.';
  v_audit_raw := jsonb_build_object(
    'id', v_audit_log_id, 'action', 'session_hopped', 'entityType', 'session',
    'entityId', v_entity_id, 'message', v_audit_message,
    'createdAt', timezone('utc', now()), 'userId', v_actor::text
  );
  insert into public.audit_logs (organization_id, id, action, entity_type, entity_id, message, audit_at, user_id, raw_data)
  values (v_organization_id, v_audit_log_id, 'session_hopped', 'session', v_entity_id, v_audit_message, timezone('utc', now()), v_actor::text, v_audit_raw)
  on conflict (organization_id, id) do nothing;
  if not found then
    perform public.raise_operational_rpc_error('audit_id_conflict', 'The hop audit ID is already in use.', jsonb_build_object('audit_log_id', v_audit_log_id));
  end if;

  v_changed_rows := jsonb_build_object(
    'sessions', jsonb_build_array(v_entity_id),
    'session_pause_logs', case when v_pause_id is null then '[]'::jsonb else jsonb_build_array(v_pause_id) end,
    'audit_logs', jsonb_build_array(v_audit_log_id),
    'operational_events', jsonb_build_array(v_event_id)
  );
  v_duration := round((extract(epoch from (clock_timestamp() - v_started_at)) * 1000)::numeric, 3);
  insert into public.operational_events (id, organization_id, event_type, entity_type, entity_id, created_by, metadata)
  values (v_event_id, v_organization_id, 'hop_session_v2', 'session', v_entity_id, v_actor::text,
    jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind, 'server_duration_ms', v_duration, 'changed_rows', v_changed_rows));

  v_result := jsonb_build_object(
    'mutation_id', v_mutation_id, 'organization_id', v_organization_id,
    'entity_type', 'session', 'entity_id', v_entity_id, 'event_id', v_event_id,
    'server_time', timezone('utc', now()), 'server_duration_ms', v_duration,
    'app_state_version', null, 'changed_rows', v_changed_rows, 'idempotent', false
  );
  update public.operational_mutations set status = 'committed', canonical_result = v_result, updated_at = timezone('utc', now())
  where organization_id = v_organization_id and mutation_id = v_mutation_id;
  return v_result;
end;
$$;

create or replace function public.reject_session_v2(payload jsonb)
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
  v_entity_type text := nullif(payload->>'entity_type', '');
  v_entity_id text := nullif(payload->>'entity_id', '');
  v_actor uuid := auth.uid();
  v_actor_role public.app_role;
  v_effective_end timestamptz;
  v_reason text := nullif(btrim(payload #>> '{payload,reason}'), '');
  v_audit_log_id text := nullif(payload #>> '{payload,audit_log_id}', '');
  v_fingerprint text;
  v_existing public.operational_mutations%rowtype;
  v_session public.sessions%rowtype;
  v_pause_id text;
  v_pause_count integer;
  v_released jsonb;
  v_event_id text := 'event-' || gen_random_uuid()::text;
  v_message text;
  v_changed jsonb;
  v_result jsonb;
  v_duration numeric;
begin
  if jsonb_typeof(payload) <> 'object' or v_organization_id is null or v_mutation_id is null
    or v_mutation_kind <> 'rejectSession' or v_entity_type <> 'session' or v_entity_id is null
    or v_audit_log_id is null or v_reason is null or payload ? 'user_id' or payload ? 'base_app_state_version'
    or jsonb_typeof(payload->'payload') <> 'object'
    or exists (select 1 from jsonb_object_keys(case when jsonb_typeof(payload)='object' then payload else '{}'::jsonb end) key where key not in ('organization_id','mutation_id','mutation_kind','label','entity_type','entity_id','client_created_at','payload'))
    or exists (select 1 from jsonb_object_keys(case when jsonb_typeof(payload->'payload')='object' then payload->'payload' else '{}'::jsonb end) key where key not in ('effective_ended_at','reason','audit_log_id'))
  then perform public.raise_operational_rpc_error('invalid_payload', 'The normalized session rejection payload is invalid.', '{}'::jsonb); end if;
  begin v_effective_end := nullif(payload #>> '{payload,effective_ended_at}', '')::timestamptz;
  exception when others then perform public.raise_operational_rpc_error('invalid_session_timing', 'The rejection time is invalid.', '{}'::jsonb); end;
  if v_effective_end is null or v_effective_end > clock_timestamp() then
    perform public.raise_operational_rpc_error('invalid_session_timing', 'The rejection time is invalid.', '{}'::jsonb); end if;

  v_actor_role := public.current_user_org_role(v_organization_id);
  if v_actor is null or not public.current_user_has_org_access(v_organization_id)
    or v_actor_role not in ('admin'::public.app_role, 'manager'::public.app_role, 'receptionist'::public.app_role)
  then perform public.raise_operational_rpc_error('organization_access_denied', 'You do not have access to this organization.', jsonb_build_object('organization_id', v_organization_id)); end if;
  v_fingerprint := md5(jsonb_build_object('kind', v_mutation_kind, 'entity_type', v_entity_type, 'entity_id', v_entity_id, 'effective_ended_at', v_effective_end, 'reason', v_reason, 'audit_log_id', v_audit_log_id)::text);
  perform pg_advisory_xact_lock(hashtextextended(v_organization_id || chr(31) || v_mutation_id, 0));
  insert into public.operational_mutations (organization_id, mutation_id, mutation_kind, entity_type, entity_id, actor_id, request_fingerprint, status)
  values (v_organization_id, v_mutation_id, v_mutation_kind, v_entity_type, v_entity_id, v_actor, v_fingerprint, 'processing')
  on conflict (organization_id, mutation_id) do nothing;
  select * into v_existing from public.operational_mutations where organization_id=v_organization_id and mutation_id=v_mutation_id for update;
  if v_existing.mutation_kind<>v_mutation_kind or v_existing.entity_type<>v_entity_type or v_existing.entity_id<>v_entity_id or v_existing.actor_id<>v_actor or v_existing.request_fingerprint<>v_fingerprint then
    perform public.raise_operational_rpc_error('mutation_identity_mismatch', 'This mutation ID belongs to different intent.', jsonb_build_object('mutation_id', v_mutation_id)); end if;
  if v_existing.status='committed' and v_existing.canonical_result is not null then return v_existing.canonical_result || jsonb_build_object('idempotent', true); end if;

  select * into v_session from public.sessions where organization_id=v_organization_id and id=v_entity_id for update;
  if not found or v_session.status='closed' then perform public.raise_operational_rpc_error('session_not_open', 'The session is no longer open.', jsonb_build_object('session_id', v_entity_id)); end if;
  if v_session.closed_bill_id is not null then perform public.raise_operational_rpc_error('session_already_billed','The session is already linked to a bill.',jsonb_build_object('session_id',v_entity_id,'bill_id',v_session.closed_bill_id)); end if;
  if v_session.started_at is null or v_effective_end < v_session.started_at then perform public.raise_operational_rpc_error('invalid_session_timing', 'The rejection time precedes the canonical start.', jsonb_build_object('session_id', v_entity_id)); end if;
  v_released := case when jsonb_typeof(coalesce(v_session.continued_from_session_ids, '[]'::jsonb))='array' then coalesce(v_session.continued_from_session_ids, '[]'::jsonb) else '[]'::jsonb end;
  perform 1 from public.session_pause_logs where organization_id=v_organization_id and session_id=v_entity_id and resumed_at is null order by paused_at,id for update;
  select count(*), min(id) into v_pause_count,v_pause_id from public.session_pause_logs where organization_id=v_organization_id and session_id=v_entity_id and resumed_at is null;
  if v_pause_count>1 then perform public.raise_operational_rpc_error('invalid_pause_state','The session has multiple open pauses.',jsonb_build_object('session_id',v_entity_id)); end if;
  if (v_session.status='paused' and v_pause_count<>1) or (v_session.status<>'paused' and v_pause_count<>0) then perform public.raise_operational_rpc_error('invalid_pause_state','The session status and open pause do not agree.',jsonb_build_object('session_id',v_entity_id,'status',v_session.status,'open_pause_count',v_pause_count)); end if;
  if v_pause_id is not null and exists(select 1 from public.session_pause_logs where organization_id=v_organization_id and id=v_pause_id and paused_at>v_effective_end) then perform public.raise_operational_rpc_error('invalid_pause_state','The rejection time precedes the open pause.',jsonb_build_object('session_id',v_entity_id,'pause_id',v_pause_id)); end if;

  update public.sessions set ended_at=v_effective_end,status='closed',closed_bill_id=null,close_disposition='rejected',close_reason=v_reason,continued_from_session_ids='[]'::jsonb,
    raw_data=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(coalesce(v_session.raw_data,'{}'::jsonb),'{endedAt}',to_jsonb(v_effective_end),true),'{status}','"closed"'::jsonb,true),'{closedBillId}','null'::jsonb,true),'{closeDisposition}','"rejected"'::jsonb,true),'{closeReason}',to_jsonb(v_reason),true),'{continuedFromSessionIds}','[]'::jsonb,true),
    updated_at=timezone('utc',now()) where organization_id=v_organization_id and id=v_entity_id;
  if v_pause_id is not null then update public.session_pause_logs set resumed_at=v_effective_end,raw_data=jsonb_set(coalesce(raw_data,'{}'::jsonb),'{resumedAt}',to_jsonb(v_effective_end),true),updated_at=timezone('utc',now()) where organization_id=v_organization_id and id=v_pause_id; end if;
  v_message := 'Rejected ' || coalesce(nullif(v_session.station_name_snapshot,''),'session') || '. Reason: ' || v_reason || case when jsonb_array_length(v_released)=0 then '' else ' Released '||jsonb_array_length(v_released)::text||' prior game continuation'||case when jsonb_array_length(v_released)=1 then '' else 's' end||'.' end;
  insert into public.audit_logs (organization_id,id,action,entity_type,entity_id,message,audit_at,user_id,raw_data)
  values (v_organization_id,v_audit_log_id,'session_rejected','session',v_entity_id,v_message,timezone('utc',now()),v_actor::text,jsonb_build_object('id',v_audit_log_id,'action','session_rejected','entityType','session','entityId',v_entity_id,'message',v_message,'createdAt',timezone('utc',now()),'userId',v_actor::text)) on conflict (organization_id,id) do nothing;
  if not found then perform public.raise_operational_rpc_error('audit_id_conflict','The rejection audit ID is already in use.',jsonb_build_object('audit_log_id',v_audit_log_id)); end if;
  v_changed:=jsonb_build_object('sessions',jsonb_build_array(v_entity_id),'session_pause_logs',case when v_pause_id is null then '[]'::jsonb else jsonb_build_array(v_pause_id) end,'audit_logs',jsonb_build_array(v_audit_log_id),'operational_events',jsonb_build_array(v_event_id));
  v_duration:=round((extract(epoch from(clock_timestamp()-v_started_at))*1000)::numeric,3);
  insert into public.operational_events(id,organization_id,event_type,entity_type,entity_id,created_by,metadata) values(v_event_id,v_organization_id,'reject_session_v2','session',v_entity_id,v_actor::text,jsonb_build_object('mutation_id',v_mutation_id,'mutation_kind',v_mutation_kind,'server_duration_ms',v_duration,'released_continued_from_session_ids',v_released,'changed_rows',v_changed));
  v_result:=jsonb_build_object('mutation_id',v_mutation_id,'organization_id',v_organization_id,'entity_type','session','entity_id',v_entity_id,'event_id',v_event_id,'server_time',timezone('utc',now()),'server_duration_ms',v_duration,'app_state_version',null,'changed_rows',v_changed,'idempotent',false);
  update public.operational_mutations set status='committed',canonical_result=v_result,updated_at=timezone('utc',now()) where organization_id=v_organization_id and mutation_id=v_mutation_id;
  return v_result;
end;
$$;

create or replace function public.reject_customer_tab_v2(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started_at timestamptz := clock_timestamp();
  v_org text := nullif(payload->>'organization_id',''); v_mid text := nullif(payload->>'mutation_id','');
  v_kind text := nullif(payload->>'mutation_kind',''); v_type text := nullif(payload->>'entity_type',''); v_eid text := nullif(payload->>'entity_id','');
  v_actor uuid := auth.uid(); v_role public.app_role; v_closed_at timestamptz; v_reason text := nullif(btrim(payload#>>'{payload,reason}'),'');
  v_audit_id text := nullif(payload#>>'{payload,audit_log_id}',''); v_fp text; v_existing public.operational_mutations%rowtype; v_tab public.customer_tabs%rowtype;
  v_released jsonb; v_event text := 'event-'||gen_random_uuid()::text; v_message text; v_changed jsonb; v_result jsonb; v_duration numeric;
begin
  if jsonb_typeof(payload)<>'object' or v_org is null or v_mid is null or v_kind<>'rejectCustomerTab' or v_type<>'customer_tab' or v_eid is null or v_reason is null or v_audit_id is null or payload?'user_id' or payload?'base_app_state_version'
    or jsonb_typeof(payload->'payload')<>'object'
    or exists(select 1 from jsonb_object_keys(case when jsonb_typeof(payload)='object' then payload else '{}'::jsonb end) key where key not in ('organization_id','mutation_id','mutation_kind','label','entity_type','entity_id','client_created_at','payload'))
    or exists(select 1 from jsonb_object_keys(case when jsonb_typeof(payload->'payload')='object' then payload->'payload' else '{}'::jsonb end) key where key not in ('effective_closed_at','reason','audit_log_id'))
  then perform public.raise_operational_rpc_error('invalid_payload','The normalized tab rejection payload is invalid.','{}'::jsonb); end if;
  begin v_closed_at:=nullif(payload#>>'{payload,effective_closed_at}','')::timestamptz; exception when others then perform public.raise_operational_rpc_error('invalid_tab_timing','The tab rejection time is invalid.','{}'::jsonb); end;
  if v_closed_at is null or v_closed_at>clock_timestamp() then perform public.raise_operational_rpc_error('invalid_tab_timing','The tab rejection time is invalid.','{}'::jsonb); end if;
  v_role:=public.current_user_org_role(v_org);
  if v_actor is null or not public.current_user_has_org_access(v_org) or v_role not in('admin'::public.app_role,'manager'::public.app_role,'receptionist'::public.app_role) then perform public.raise_operational_rpc_error('organization_access_denied','You do not have access to this organization.',jsonb_build_object('organization_id',v_org)); end if;
  v_fp:=md5(jsonb_build_object('kind',v_kind,'entity_type',v_type,'entity_id',v_eid,'effective_closed_at',v_closed_at,'reason',v_reason,'audit_log_id',v_audit_id)::text);
  perform pg_advisory_xact_lock(hashtextextended(v_org||chr(31)||v_mid,0));
  insert into public.operational_mutations(organization_id,mutation_id,mutation_kind,entity_type,entity_id,actor_id,request_fingerprint,status) values(v_org,v_mid,v_kind,v_type,v_eid,v_actor,v_fp,'processing') on conflict(organization_id,mutation_id) do nothing;
  select * into v_existing from public.operational_mutations where organization_id=v_org and mutation_id=v_mid for update;
  if v_existing.mutation_kind<>v_kind or v_existing.entity_type<>v_type or v_existing.entity_id<>v_eid or v_existing.actor_id<>v_actor or v_existing.request_fingerprint<>v_fp then perform public.raise_operational_rpc_error('mutation_identity_mismatch','This mutation ID belongs to different intent.',jsonb_build_object('mutation_id',v_mid)); end if;
  if v_existing.status='committed' and v_existing.canonical_result is not null then return v_existing.canonical_result||jsonb_build_object('idempotent',true); end if;
  select * into v_tab from public.customer_tabs where organization_id=v_org and id=v_eid for update;
  if not found or v_tab.status<>'open' then perform public.raise_operational_rpc_error('customer_tab_not_open','The customer tab is no longer open.',jsonb_build_object('customer_tab_id',v_eid)); end if;
  if v_tab.closed_bill_id is not null then perform public.raise_operational_rpc_error('customer_tab_already_billed','The customer tab is already linked to a bill.',jsonb_build_object('customer_tab_id',v_eid,'bill_id',v_tab.closed_bill_id)); end if;
  if v_tab.opened_at is not null and v_closed_at<v_tab.opened_at then perform public.raise_operational_rpc_error('invalid_tab_timing','The rejection time precedes the canonical opening time.',jsonb_build_object('customer_tab_id',v_eid)); end if;
  v_released:=case when jsonb_typeof(coalesce(v_tab.continued_from_session_ids,'[]'::jsonb))='array' then coalesce(v_tab.continued_from_session_ids,'[]'::jsonb) else '[]'::jsonb end;
  update public.customer_tabs set status='closed',closed_at=v_closed_at,closed_bill_id=null,close_disposition='rejected',close_reason=v_reason,continued_from_session_ids='[]'::jsonb,
    raw_data=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(coalesce(v_tab.raw_data,'{}'::jsonb),'{status}','"closed"'::jsonb,true),'{closedAt}',to_jsonb(v_closed_at),true),'{closedBillId}','null'::jsonb,true),'{closeDisposition}','"rejected"'::jsonb,true),'{closeReason}',to_jsonb(v_reason),true),'{continuedFromSessionIds}','[]'::jsonb,true),updated_at=timezone('utc',now()) where organization_id=v_org and id=v_eid;
  v_message:='Rejected customer tab for '||coalesce(nullif(v_tab.customer_name,''),'customer')||'. Reason: '||v_reason||case when jsonb_array_length(v_released)=0 then '' else ' Released '||jsonb_array_length(v_released)::text||' prior game continuation'||case when jsonb_array_length(v_released)=1 then '' else 's' end||'.' end;
  insert into public.audit_logs(organization_id,id,action,entity_type,entity_id,message,audit_at,user_id,raw_data) values(v_org,v_audit_id,'customer_tab_rejected','customer_tab',v_eid,v_message,timezone('utc',now()),v_actor::text,jsonb_build_object('id',v_audit_id,'action','customer_tab_rejected','entityType','customer_tab','entityId',v_eid,'message',v_message,'createdAt',timezone('utc',now()),'userId',v_actor::text)) on conflict(organization_id,id) do nothing;
  if not found then perform public.raise_operational_rpc_error('audit_id_conflict','The tab rejection audit ID is already in use.',jsonb_build_object('audit_log_id',v_audit_id)); end if;
  v_changed:=jsonb_build_object('customer_tabs',jsonb_build_array(v_eid),'audit_logs',jsonb_build_array(v_audit_id),'operational_events',jsonb_build_array(v_event));
  v_duration:=round((extract(epoch from(clock_timestamp()-v_started_at))*1000)::numeric,3);
  insert into public.operational_events(id,organization_id,event_type,entity_type,entity_id,created_by,metadata) values(v_event,v_org,'reject_customer_tab_v2','customer_tab',v_eid,v_actor::text,jsonb_build_object('mutation_id',v_mid,'mutation_kind',v_kind,'server_duration_ms',v_duration,'released_continued_from_session_ids',v_released,'changed_rows',v_changed));
  v_result:=jsonb_build_object('mutation_id',v_mid,'organization_id',v_org,'entity_type','customer_tab','entity_id',v_eid,'event_id',v_event,'server_time',timezone('utc',now()),'server_duration_ms',v_duration,'app_state_version',null,'changed_rows',v_changed,'idempotent',false);
  update public.operational_mutations set status='committed',canonical_result=v_result,updated_at=timezone('utc',now()) where organization_id=v_org and mutation_id=v_mid;
  return v_result;
end;
$$;

revoke all on function public.hop_session_v2(jsonb) from public;
revoke all on function public.reject_session_v2(jsonb) from public;
revoke all on function public.reject_customer_tab_v2(jsonb) from public;
revoke execute on function public.hop_session_v2(jsonb) from anon;
revoke execute on function public.reject_session_v2(jsonb) from anon;
revoke execute on function public.reject_customer_tab_v2(jsonb) from anon;
grant execute on function public.hop_session_v2(jsonb) to authenticated;
grant execute on function public.reject_session_v2(jsonb) to authenticated;
grant execute on function public.reject_customer_tab_v2(jsonb) to authenticated;
