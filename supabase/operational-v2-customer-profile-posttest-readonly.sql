-- Dedicated post-test contract for the admin customer snapshot-parity suite.
begin isolation level repeatable read read only;

do $$
begin
  if current_database() <> 'postgres' or (select system_identifier::text from pg_control_system()) <> '7623125441096521075'
    then raise exception 'physical database is not the approved staging cluster'; end if;
  if not exists(select 1 from public.deployment_environment_identity where environment='staging' and project_ref='tkbdyzxwwbhkpztgjjxh')
    then raise exception 'database staging identity failed'; end if;
  if not exists(select 1 from public.organizations where id='org-primary')
    then raise exception 'staging organization identity failed'; end if;
end $$;

select jsonb_build_object(
  'run_id','__RUN_ID__','project_ref','tkbdyzxwwbhkpztgjjxh','transaction_read_only',current_setting('transaction_read_only')::boolean,
  'app_state',(select jsonb_build_object('version',version,'bytes',octet_length(data::text),'md5',md5(data::text),'updated_at',updated_at,'updated_by',updated_by) from public.app_state where id='primary'),
  'global_floor',jsonb_build_object(
    'open_sessions',(select count(*) from public.sessions where status<>'closed'),
    'open_customer_tabs',(select count(*) from public.customer_tabs where status='open'),
    'incomplete_operational_mutations',(select count(*) from public.operational_mutations where status<>'committed'),
    'incomplete_financial_mutations',(select count(*) from public.financial_mutations where status<>'committed')
  ),
  'qa_live_residuals',jsonb_build_object(
    'sessions',(select count(*) from public.sessions where organization_id='org-primary' and status<>'closed' and (customer_name ilike '%__RUN_ID__%' or raw_data::text like '%__RUN_ID__%')),
    'customer_tabs',(select count(*) from public.customer_tabs where organization_id='org-primary' and status='open' and (customer_name ilike '%__RUN_ID__%' or raw_data::text like '%__RUN_ID__%')),
    'customers',(select count(*) from public.customers where organization_id='org-primary' and (name ilike '%__RUN_ID__%' or raw_data::text like '%__RUN_ID__%')),
    'compatibility_customers',(select count(*) from public.app_state state cross join lateral jsonb_array_elements(coalesce(state.data->'customers','[]'::jsonb)) customer where state.id='primary' and customer::text like '%__RUN_ID__%')
  ),
  'qa_terminal_evidence',jsonb_build_object(
    'closed_sessions',(select count(*) from public.sessions where organization_id='org-primary' and status='closed' and (customer_name ilike '%__RUN_ID__%' or raw_data::text like '%__RUN_ID__%')),
    'audit_logs',(select count(*) from public.audit_logs where organization_id='org-primary' and (id like '__RUN_ID__%' or message ilike '%__RUN_ID__%' or raw_data::text like '%__RUN_ID__%')),
    'operational_events',(select count(*) from public.operational_events where organization_id='org-primary' and (id like '__RUN_ID__%' or metadata::text like '%__RUN_ID__%'))
  ),
  'functions',(select jsonb_object_agg(proname,md5(pg_get_functiondef(p.oid))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('hop_session_v2','reject_session_v2','reject_customer_tab_v2','start_session','open_customer_tab','link_customer_tab_continuation','get_operational_performance_dataset_identity') and pg_get_function_identity_arguments(p.oid)='payload jsonb')
) as evidence;

rollback;
