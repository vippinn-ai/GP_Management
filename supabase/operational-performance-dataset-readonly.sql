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
  'identity_nonce',(select identity_nonce::text from public.deployment_environment_identity where environment='staging' and project_ref='tkbdyzxwwbhkpztgjjxh'),
  'organization_id','org-primary',
  'transaction_read_only',current_setting('transaction_read_only')::boolean,
  'captured_at_utc',timezone('utc',clock_timestamp()),
  'app_state',(select jsonb_build_object(
    'version',version,'bytes',octet_length(data::text),'md5',md5(data::text),
    'updated_at',updated_at,'updated_by',updated_by
  ) from public.app_state where id='primary'),
  'app_state_collection_counts',(select jsonb_build_object(
    'auditLogs',jsonb_array_length(coalesce(data->'auditLogs','[]'::jsonb)),
    'bills',jsonb_array_length(coalesce(data->'bills','[]'::jsonb)),
    'combos',jsonb_array_length(coalesce(data->'combos','[]'::jsonb)),
    'customers',jsonb_array_length(coalesce(data->'customers','[]'::jsonb)),
    'customerTabs',jsonb_array_length(coalesce(data->'customerTabs','[]'::jsonb)),
    'expenses',jsonb_array_length(coalesce(data->'expenses','[]'::jsonb)),
    'expenseTemplateOverrides',jsonb_array_length(coalesce(data->'expenseTemplateOverrides','[]'::jsonb)),
    'expenseTemplates',jsonb_array_length(coalesce(data->'expenseTemplates','[]'::jsonb)),
    'inventoryCategories',jsonb_array_length(coalesce(data->'inventoryCategories','[]'::jsonb)),
    'inventoryItems',jsonb_array_length(coalesce(data->'inventoryItems','[]'::jsonb)),
    'payments',jsonb_array_length(coalesce(data->'payments','[]'::jsonb)),
    'pricingRules',jsonb_array_length(coalesce(data->'pricingRules','[]'::jsonb)),
    'sessionPauseLogs',jsonb_array_length(coalesce(data->'sessionPauseLogs','[]'::jsonb)),
    'sessions',jsonb_array_length(coalesce(data->'sessions','[]'::jsonb)),
    'stations',jsonb_array_length(coalesce(data->'stations','[]'::jsonb)),
    'stockMovements',jsonb_array_length(coalesce(data->'stockMovements','[]'::jsonb))
  ) from public.app_state where id='primary'),
  'shape_counts',jsonb_build_object(
    'active_inventory_items',(select count(*) from public.inventory_items where organization_id='org-primary' and active),
    'current_business_day_bills',(select count(*) from public.bills where organization_id='org-primary' and public.analytics_business_date(issued_at)=public.analytics_business_date(clock_timestamp())),
    'current_business_day_payments',(select count(*) from public.payments where organization_id='org-primary' and public.analytics_business_date(paid_at)=public.analytics_business_date(clock_timestamp())),
    'pending_bills',(select count(*) from public.bills where organization_id='org-primary' and status='pending'),
    'recent_stock_movements',(select count(*) from public.stock_movements where organization_id='org-primary' and public.analytics_business_date(movement_at) between public.analytics_business_date(clock_timestamp())-29 and public.analytics_business_date(clock_timestamp()))
  ),
  'open_sessions',(select count(*) from public.sessions where organization_id='org-primary' and status<>'closed'),
  'open_customer_tabs',(select count(*) from public.customer_tabs where organization_id='org-primary' and status='open'),
  'recoverable_hopped_sessions',(select count(*) from public.sessions source
    where source.organization_id='org-primary' and source.status='closed' and source.close_disposition='hopped' and source.closed_bill_id is null
      and not exists(select 1 from public.sessions consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))
      and not exists(select 1 from public.customer_tabs consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))),
  'processing_financial_mutations',(select count(*) from public.financial_mutations where organization_id='org-primary' and status<>'committed'),
  'processing_operational_mutations',case when to_regclass('public.operational_mutations') is null then 0 else (select count(*) from public.operational_mutations where organization_id='org-primary' and status<>'committed') end,
  'scale_fixture_absent',to_regnamespace('qa_performance_scale') is null,
  'scale_fixture_key_absent',not ((select data from public.app_state where id='primary') ? 'qaPerformanceScaleFixture'),
  'scale_fixture_rpc_absent',to_regprocedure('public.get_operational_performance_scale_identity(jsonb)') is null,
  'scale_fixture_rpc',(select case when to_regprocedure('public.get_operational_performance_scale_identity(jsonb)') is null then null else jsonb_build_object(
    'owner',(select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=to_regprocedure('public.get_operational_performance_scale_identity(jsonb)')),
    'security_definer',(select prosecdef from pg_proc where oid=to_regprocedure('public.get_operational_performance_scale_identity(jsonb)')),
    'volatility',(select provolatile from pg_proc where oid=to_regprocedure('public.get_operational_performance_scale_identity(jsonb)')),
    'search_path',(select proconfig from pg_proc where oid=to_regprocedure('public.get_operational_performance_scale_identity(jsonb)')),
    'acl',(select coalesce(jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(acl.grantor),'grantee',case when acl.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,'privilege',acl.privilege_type,'grantable',acl.is_grantable) order by acl.grantee,acl.privilege_type,acl.is_grantable),'[]'::jsonb) from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where p.oid=to_regprocedure('public.get_operational_performance_scale_identity(jsonb)')),
    'authenticated_execute',has_function_privilege('authenticated','public.get_operational_performance_scale_identity(jsonb)','execute'),
    'anon_execute',has_function_privilege('anon','public.get_operational_performance_scale_identity(jsonb)','execute'),
    'public_execute',(select exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE') from pg_proc p where p.oid=to_regprocedure('public.get_operational_performance_scale_identity(jsonb)')),
    'body_md5',(select md5(replace(replace(prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10))) from pg_proc where oid=to_regprocedure('public.get_operational_performance_scale_identity(jsonb)')),
    'definition_md5',(select md5(replace(replace(pg_get_functiondef(to_regprocedure('public.get_operational_performance_scale_identity(jsonb)')),chr(13)||chr(10),chr(10)),chr(13),chr(10)))
  )) end),
  'auxiliary_counts',jsonb_build_object(
    'activity_events',(select count(*) from public.activity_events where organization_id='org-primary'),
    'analytics_dirty_dates',(select count(*) from public.analytics_dirty_dates where organization_id='org-primary'),
    'inventory_report_dirty_dates',(select count(*) from public.inventory_report_dirty_dates where organization_id='org-primary')
  ),
  'auxiliary_fingerprints',jsonb_build_object(
    'activity_events',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.activity_events t where organization_id='org-primary'),
    'analytics_dirty_dates',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.analytics_dirty_dates t where organization_id='org-primary'),
    'inventory_report_dirty_dates',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.inventory_report_dirty_dates t where organization_id='org-primary')
  ),
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
    'stations',(select count(*) from public.stations where organization_id='org-primary'),
    'inventory_categories',(select count(*) from public.inventory_categories where organization_id='org-primary'),
    'pricing_rules',(select count(*) from public.pricing_rules where organization_id='org-primary'),
    'sale_variants',(select count(*) from public.sale_variants where organization_id='org-primary'),
    'combo_station_targets',(select count(*) from public.combo_station_targets where organization_id='org-primary'),
    'combo_fixed_items',(select count(*) from public.combo_fixed_items where organization_id='org-primary'),
    'combo_choice_groups',(select count(*) from public.combo_choice_groups where organization_id='org-primary'),
    'combo_choice_options',(select count(*) from public.combo_choice_options where organization_id='org-primary'),
    'session_combo_applications',(select count(*) from public.session_combo_applications where organization_id='org-primary'),
    'customer_tab_combo_applications',(select count(*) from public.customer_tab_combo_applications where organization_id='org-primary'),
    'bill_discounts',(select count(*) from public.bill_discounts where organization_id='org-primary'),
    'bill_line_discounts',(select count(*) from public.bill_line_discounts where organization_id='org-primary'),
    'expenses',(select count(*) from public.expenses where organization_id='org-primary'),
    'expense_templates',(select count(*) from public.expense_templates where organization_id='org-primary'),
    'expense_template_overrides',(select count(*) from public.expense_template_overrides where organization_id='org-primary')
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
    'stock_movements',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.stock_movements t where organization_id='org-primary'),
    'session_pause_logs',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.session_pause_logs t where organization_id='org-primary'),
    'session_items',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.session_items t where organization_id='org-primary'),
    'customer_tab_items',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.customer_tab_items t where organization_id='org-primary'),
    'inventory_items',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.inventory_items t where organization_id='org-primary'),
    'combos',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.combos t where organization_id='org-primary'),
    'stations',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.stations t where organization_id='org-primary'),
    'inventory_categories',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.inventory_categories t where organization_id='org-primary'),
    'pricing_rules',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.pricing_rules t where organization_id='org-primary'),
    'sale_variants',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.sale_variants t where organization_id='org-primary'),
    'combo_station_targets',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.combo_station_targets t where organization_id='org-primary'),
    'combo_fixed_items',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.combo_fixed_items t where organization_id='org-primary'),
    'combo_choice_groups',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.combo_choice_groups t where organization_id='org-primary'),
    'combo_choice_options',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.combo_choice_options t where organization_id='org-primary'),
    'session_combo_applications',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.session_combo_applications t where organization_id='org-primary'),
    'customer_tab_combo_applications',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.customer_tab_combo_applications t where organization_id='org-primary'),
    'bill_discounts',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.bill_discounts t where organization_id='org-primary'),
    'bill_line_discounts',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.bill_line_discounts t where organization_id='org-primary'),
    'expenses',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.expenses t where organization_id='org-primary'),
    'expense_templates',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.expense_templates t where organization_id='org-primary'),
    'expense_template_overrides',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.expense_template_overrides t where organization_id='org-primary')
  )
) as evidence;

rollback;
