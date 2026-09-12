-- Generated copies replace __RUN_ID__. Read-only final staging reconciliation.
begin isolation level repeatable read read only;

do $$
begin
  if coalesce(current_setting('app.settings.api_url', true), '') not like '%tkbdyzxwwbhkpztgjjxh%'
    then raise exception 'database-owned staging API URL identity failed'; end if;
  if not exists(select 1 from public.deployment_environment_identity where environment='staging' and project_ref='tkbdyzxwwbhkpztgjjxh')
    then raise exception 'database staging identity failed'; end if;
end $$;

with qa_sessions as (
  select id,status from public.sessions where organization_id='org-primary'
    and (id like '__RUN_ID__%' or customer_name ilike '%__RUN_ID__%' or raw_data::text like '%__RUN_ID__%')
), qa_tabs as (
  select id,status from public.customer_tabs where organization_id='org-primary'
    and (id like '__RUN_ID__%' or customer_name ilike '%__RUN_ID__%' or raw_data::text like '%__RUN_ID__%')
), qa_bills as (
  select id,status from public.bills where organization_id='org-primary'
    and (id like '__RUN_ID__%' or bill_number ilike '%__RUN_ID__%' or customer_name ilike '%__RUN_ID__%' or raw_data::text like '%__RUN_ID__%')
), qa_customers as (
  select id from public.customers where organization_id='org-primary'
    and (id like '__RUN_ID__%' or name ilike '%__RUN_ID__%' or raw_data::text like '%__RUN_ID__%')
), target_functions as (
  select proname,md5(pg_get_functiondef(p.oid)) definition_md5
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('hop_session_v2','reject_session_v2','reject_customer_tab_v2','start_session','open_customer_tab','link_customer_tab_continuation','get_operational_performance_dataset_identity')
    and pg_get_function_identity_arguments(p.oid)='payload jsonb'
)
select jsonb_build_object(
  'run_id','__RUN_ID__','project_ref','tkbdyzxwwbhkpztgjjxh','captured_at_utc',timezone('utc',clock_timestamp()),
  'app_state',(select jsonb_build_object('version',version,'bytes',octet_length(data::text),'md5',md5(data::text),'updated_at',updated_at,'updated_by',updated_by) from public.app_state where id='primary'),
  'global_floor',jsonb_build_object(
    'open_sessions',(select count(*) from public.sessions where status<>'closed'),
    'open_customer_tabs',(select count(*) from public.customer_tabs where status='open'),
    'recoverable_hopped_sessions',(select count(*) from public.sessions source
      where source.organization_id='org-primary' and source.status='closed' and source.close_disposition='hopped' and source.closed_bill_id is null
        and not exists(select 1 from public.sessions consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))
        and not exists(select 1 from public.customer_tabs consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))),
    'incomplete_operational_mutations',(select count(*) from public.operational_mutations where status<>'committed'),
    'incomplete_financial_mutations',(select count(*) from public.financial_mutations where status<>'committed')
  ),
  'qa_live_residuals',jsonb_build_object(
    'sessions',(select count(*) from qa_sessions where status<>'closed'),
    'customer_tabs',(select count(*) from qa_tabs where status='open'),
    'session_items',(select count(*) from public.session_items where organization_id='org-primary' and session_id in (select id from qa_sessions where status<>'closed')),
    'session_combos',(select count(*) from public.session_combo_applications where organization_id='org-primary' and session_id in (select id from qa_sessions where status<>'closed')),
    'tab_items',(select count(*) from public.customer_tab_items where organization_id='org-primary' and customer_tab_id in (select id from qa_tabs where status='open')),
    'tab_combos',(select count(*) from public.customer_tab_combo_applications where organization_id='org-primary' and customer_tab_id in (select id from qa_tabs where status='open'))
  ),
  'qa_terminal_evidence',jsonb_build_object(
    'sessions',(select count(*) from qa_sessions),'customer_tabs',(select count(*) from qa_tabs),'customers',(select count(*) from qa_customers),'bills',(select count(*) from qa_bills),
    'payments',(select count(*) from public.payments where organization_id='org-primary' and bill_id in (select id from qa_bills)),
    'audit_logs',(select count(*) from public.audit_logs where organization_id='org-primary' and (id like '__RUN_ID__%' or message ilike '%__RUN_ID__%' or raw_data::text like '%__RUN_ID__%')),
    'operational_events',(select count(*) from public.operational_events where organization_id='org-primary' and (id like '__RUN_ID__%' or metadata::text like '%__RUN_ID__%')),
    'operational_mutations',(select count(*) from public.operational_mutations where organization_id='org-primary' and mutation_id like '__RUN_ID__%'),
    'financial_mutations',(select count(*) from public.financial_mutations where organization_id='org-primary' and mutation_id like '__RUN_ID__%')
  ),
  'same_target_race_integrity',jsonb_build_object(
    'committed_close_mutations',(select count(*) from public.operational_mutations where organization_id='org-primary' and mutation_id like '__RUN_ID__-same-%' and mutation_kind in ('hopSession','rejectSession') and status='committed'),
    'all_close_mutations',(select count(*) from public.operational_mutations where organization_id='org-primary' and mutation_id like '__RUN_ID__-same-%' and mutation_kind in ('hopSession','rejectSession')),
    'close_audits',(select count(*) from public.audit_logs where organization_id='org-primary' and id like '__RUN_ID__-same-%-audit' and action in ('session_hopped','session_rejected')),
    'close_events',(select count(*) from public.operational_events where organization_id='org-primary' and metadata->>'mutation_id' like '__RUN_ID__-same-%' and event_type in ('hop_session_v2','reject_session_v2')),
    'actor_mismatches',(select count(*) from public.operational_mutations m
      left join public.audit_logs a on a.organization_id=m.organization_id and a.id=m.mutation_id||'-audit'
      left join public.operational_events e on e.organization_id=m.organization_id and e.metadata->>'mutation_id'=m.mutation_id
      where m.organization_id='org-primary' and m.mutation_id like '__RUN_ID__-same-%' and m.mutation_kind in ('hopSession','rejectSession')
        and (a.id is null or e.id is null or a.user_id is distinct from m.actor_id::text or e.created_by is distinct from m.actor_id::text))
  ),
  'functions',(select jsonb_object_agg(proname,definition_md5) from target_functions)
) as evidence;

rollback;
