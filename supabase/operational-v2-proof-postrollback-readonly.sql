-- Exact proof-run rollback verification. Generated copies replace __PROOF_RUN_ID__.
begin isolation level repeatable read read only;

do $$
begin
  if current_database() <> 'postgres' or (select system_identifier::text from pg_control_system()) <> '7623125441096521075'
    then raise exception 'physical database is not the approved staging cluster'; end if;
  if not exists(select 1 from public.deployment_environment_identity where environment='staging' and project_ref='tkbdyzxwwbhkpztgjjxh')
    then raise exception 'database staging identity failed'; end if;
end $$;

select jsonb_build_object(
  'proof_run_id','__PROOF_RUN_ID__',
  'project_ref','tkbdyzxwwbhkpztgjjxh',
  'transaction_read_only',current_setting('transaction_read_only')::boolean,
  'captured_at_utc',timezone('utc',clock_timestamp()),
  'app_state',(select jsonb_build_object('version',version,'bytes',octet_length(data::text),'md5',md5(data::text),'updated_at',updated_at,'updated_by',updated_by) from public.app_state where id='primary'),
  'residuals',jsonb_build_object(
    'sessions',(select count(*) from public.sessions where organization_id='org-primary' and (id like '__PROOF_RUN_ID__%' or raw_data::text like '%__PROOF_RUN_ID__%')),
    'session_pause_logs',(select count(*) from public.session_pause_logs where organization_id='org-primary' and (id like '__PROOF_RUN_ID__%' or raw_data::text like '%__PROOF_RUN_ID__%')),
    'customer_tabs',(select count(*) from public.customer_tabs where organization_id='org-primary' and (id like '__PROOF_RUN_ID__%' or raw_data::text like '%__PROOF_RUN_ID__%')),
    'operational_mutations',(select count(*) from public.operational_mutations where organization_id='org-primary' and mutation_id like '__PROOF_RUN_ID__%'),
    'audit_logs',(select count(*) from public.audit_logs where organization_id='org-primary' and (id like '__PROOF_RUN_ID__%' or message ilike '%__PROOF_RUN_ID__%' or raw_data::text like '%__PROOF_RUN_ID__%')),
    'operational_events',(select count(*) from public.operational_events where organization_id='org-primary' and (id like '__PROOF_RUN_ID__%' or metadata::text like '%__PROOF_RUN_ID__%'))
  )
) as evidence;

rollback;
