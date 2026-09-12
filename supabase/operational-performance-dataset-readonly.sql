-- Immutable, PII-free staging dataset identity for operational performance runs.
begin isolation level repeatable read read only;

do $$
begin
  if current_database() <> 'postgres' or (select system_identifier::text from pg_control_system()) <> '7623125441096521075'
    then raise exception 'physical database is not the approved staging cluster'; end if;
  if not exists(select 1 from public.deployment_environment_identity where environment='staging' and project_ref='tkbdyzxwwbhkpztgjjxh')
    then raise exception 'database staging identity failed'; end if;
end $$;

select jsonb_build_object(
  'schema_version',1,
  'expected_project_ref','tkbdyzxwwbhkpztgjjxh',
  'organization_id','org-primary',
  'transaction_read_only',current_setting('transaction_read_only')::boolean,
  'captured_at_utc',timezone('utc',clock_timestamp()),
  'app_state',(select jsonb_build_object(
    'version',version,'bytes',octet_length(data::text),'md5',md5(data::text),
    'updated_at',updated_at,'updated_by',updated_by
  ) from public.app_state where id='primary'),
  'open_sessions',(select count(*) from public.sessions where organization_id='org-primary' and status<>'closed'),
  'open_customer_tabs',(select count(*) from public.customer_tabs where organization_id='org-primary' and status='open'),
  'processing_financial_mutations',(select count(*) from public.financial_mutations where organization_id='org-primary' and status<>'committed'),
  'processing_operational_mutations',case when to_regclass('public.operational_mutations') is null then 0 else (select count(*) from public.operational_mutations where organization_id='org-primary' and status<>'committed') end,
  'public_counts',jsonb_build_object(
    'sessions',(select count(*) from public.sessions where organization_id='org-primary'),
    'customer_tabs',(select count(*) from public.customer_tabs where organization_id='org-primary'),
    'bills',(select count(*) from public.bills where organization_id='org-primary'),
    'bill_lines',(select count(*) from public.bill_lines where organization_id='org-primary'),
    'payments',(select count(*) from public.payments where organization_id='org-primary'),
    'customers',(select count(*) from public.customers where organization_id='org-primary'),
    'audit_logs',(select count(*) from public.audit_logs where organization_id='org-primary'),
    'operational_events',(select count(*) from public.operational_events where organization_id='org-primary'),
    'stock_movements',(select count(*) from public.stock_movements where organization_id='org-primary'),
    'session_pause_logs',(select count(*) from public.session_pause_logs where organization_id='org-primary'),
    'session_items',(select count(*) from public.session_items where organization_id='org-primary'),
    'customer_tab_items',(select count(*) from public.customer_tab_items where organization_id='org-primary'),
    'inventory_items',(select count(*) from public.inventory_items where organization_id='org-primary'),
    'combos',(select count(*) from public.combos where organization_id='org-primary'),
    'stations',(select count(*) from public.stations where organization_id='org-primary')
  ),
  'public_fingerprints',jsonb_build_object(
    'sessions',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.sessions t where organization_id='org-primary'),
    'customer_tabs',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.customer_tabs t where organization_id='org-primary'),
    'bills',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.bills t where organization_id='org-primary'),
    'bill_lines',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.bill_lines t where organization_id='org-primary'),
    'payments',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.payments t where organization_id='org-primary'),
    'customers',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.customers t where organization_id='org-primary'),
    'audit_logs',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.audit_logs t where organization_id='org-primary'),
    'operational_events',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.operational_events t where organization_id='org-primary'),
    'stock_movements',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.stock_movements t where organization_id='org-primary')
  )
) as evidence;

rollback;
