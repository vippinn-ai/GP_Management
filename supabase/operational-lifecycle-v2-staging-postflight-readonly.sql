-- Read-only fail-closed staging postflight. Save the single JSON value exactly.
begin isolation level repeatable read read only;

do $$
declare function_name text; function_body text; incomplete_operational integer; system_id text := (select system_identifier::text from pg_control_system());
begin
  if current_database() <> 'postgres' or system_id <> '7623125441096521075'
  then raise exception 'physical database is not the approved staging cluster'; end if;
  if not exists(select 1 from public.organizations where id='org-primary') then raise exception 'staging organization identity failed'; end if;
  if to_regclass('public.deployment_environment_identity') is null
    or not exists(select 1 from public.deployment_environment_identity where environment='staging' and project_ref='tkbdyzxwwbhkpztgjjxh')
  then raise exception 'database-derived staging identity failed'; end if;
  if to_regclass('public.operational_mutations') is null then raise exception 'operational_mutations is missing'; end if;
  execute 'select count(*) from public.operational_mutations where status<>''committed''' into incomplete_operational;
  if incomplete_operational <> 0 then raise exception 'staging has incomplete operational mutations'; end if;
  foreach function_name in array array[
    'hop_session_v2','reject_session_v2','reject_customer_tab_v2',
    'start_session','open_customer_tab','link_customer_tab_continuation','get_operational_performance_dataset_identity'
  ] loop
    select pg_get_functiondef(p.oid) into function_body from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=function_name and pg_get_function_identity_arguments(p.oid)='payload jsonb';
    if function_body is null then raise exception 'missing installed function %', function_name; end if;
    if function_name like '%\_v2' escape '\' and (function_body ~* '\mapp_state\M' or function_body ~* 'patch_app_state') then
      raise exception 'forbidden compatibility-state reference in %', function_name;
    end if;
    if function_name in ('hop_session_v2','reject_session_v2','reject_customer_tab_v2','start_session','open_customer_tab','link_customer_tab_continuation','get_operational_performance_dataset_identity')
      and function_body !~* 'auth\.uid\(\)' then raise exception 'authenticated actor binding missing from %', function_name; end if;
  end loop;
  if exists(select 1 from (values ('anon'),('authenticated')) roles(name)
    cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) privileges(name)
    where has_table_privilege(roles.name,'public.operational_mutations',privileges.name))
    or exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      where c.oid='public.operational_mutations'::regclass and acl.grantee=0)
    or exists(select 1 from pg_policy where polrelid='public.operational_mutations'::regclass)
  then raise exception 'operational mutation table has forbidden direct privileges or policies'; end if;
  if has_function_privilege('anon','public.hop_session_v2(jsonb)','execute')
    or has_function_privilege('anon','public.reject_session_v2(jsonb)','execute')
    or has_function_privilege('anon','public.reject_customer_tab_v2(jsonb)','execute') then raise exception 'anonymous lifecycle v2 execution is enabled'; end if;
  if has_function_privilege('anon','public.get_operational_performance_dataset_identity(jsonb)','execute')
    or not has_function_privilege('authenticated','public.get_operational_performance_dataset_identity(jsonb)','execute')
  then raise exception 'performance dataset identity grants are invalid'; end if;
  if not has_function_privilege('authenticated','public.hop_session_v2(jsonb)','execute')
    or not has_function_privilege('authenticated','public.reject_session_v2(jsonb)','execute')
    or not has_function_privilege('authenticated','public.reject_customer_tab_v2(jsonb)','execute') then raise exception 'authenticated lifecycle v2 execution is missing'; end if;
end $$;

with target_functions as (
  select p.*, n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname in ('hop_session_v2','reject_session_v2','reject_customer_tab_v2','start_session','open_customer_tab','link_customer_tab_continuation','get_operational_performance_dataset_identity')
    and pg_get_function_identity_arguments(p.oid)='payload jsonb'
)
select jsonb_build_object(
  'expected_project_ref','tkbdyzxwwbhkpztgjjxh',
  'package_run_id','__PACKAGE_RUN_ID__',
  'source_commit','__SOURCE_COMMIT__',
  'source_sha256','__SOURCE_SHA256__',
  'server_version_num',current_setting('server_version_num')::integer,
  'system_identifier',(select system_identifier::text from pg_control_system()),
  'environment_identity',(select jsonb_build_object('environment',environment,'project_ref',project_ref,'identity_nonce',identity_nonce) from public.deployment_environment_identity where environment='staging'),
  'captured_at_utc',timezone('utc',clock_timestamp()),
  'organization_id','org-primary',
  'app_state',(select jsonb_build_object('version',version,'bytes',octet_length(data::text),'md5',md5(data::text),'updated_at',updated_at,'updated_by',updated_by) from public.app_state where id='primary'),
  'open_sessions',(select count(*) from public.sessions where status<>'closed'),
  'open_customer_tabs',(select count(*) from public.customer_tabs where status='open'),
  'recoverable_hopped_sessions',(select count(*) from public.sessions source
    where source.organization_id='org-primary' and source.status='closed' and source.close_disposition='hopped' and source.closed_bill_id is null
      and not exists(select 1 from public.sessions consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))
      and not exists(select 1 from public.customer_tabs consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))),
  'processing_financial_mutations',(select count(*) from public.financial_mutations where status<>'committed'),
  'processing_operational_mutations',(select count(*) from public.operational_mutations where status<>'committed'),
  'operational_mutations_rls',(select relrowsecurity from pg_class where oid='public.operational_mutations'::regclass),
  'operational_mutations_force_rls',(select relforcerowsecurity from pg_class where oid='public.operational_mutations'::regclass),
  'operational_mutations_owner',(select pg_get_userbyid(relowner) from pg_class where oid='public.operational_mutations'::regclass),
  'operational_mutations_acl',(select jsonb_agg(jsonb_build_object(
    'grantor',case when a.grantor=0 then 'PUBLIC' else pg_get_userbyid(a.grantor) end,
    'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
    'privilege_type',a.privilege_type,'is_grantable',a.is_grantable) order by a.privilege_type)
    from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid='public.operational_mutations'::regclass),
  'operational_mutations_forbidden_privileges',(select coalesce(jsonb_agg(record),'[]'::jsonb) from (
    select jsonb_build_object('role',roles.name,'privilege',privileges.name) record
    from (values ('anon'),('authenticated')) roles(name)
    cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) privileges(name)
    where has_table_privilege(roles.name,'public.operational_mutations',privileges.name)
    union all
    select jsonb_build_object('role','PUBLIC','privilege',acl.privilege_type)
    from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    where c.oid='public.operational_mutations'::regclass and acl.grantee=0
  ) forbidden),
  'operational_mutations_policies',(select coalesce(jsonb_agg(polname order by polname),'[]'::jsonb) from pg_policy where polrelid='public.operational_mutations'::regclass),
  'functions',(select jsonb_agg(jsonb_build_object(
    'name',proname,'definition',pg_get_functiondef(oid),'definition_md5',md5(pg_get_functiondef(oid)),
    'owner',quote_ident(pg_get_userbyid(proowner)),'security_definer',prosecdef,'volatility',provolatile,'config',proconfig,'acl',proacl,
    'language',(select lanname from pg_language where oid=prolang),
    'strict',proisstrict,'parallel',proparallel,'leakproof',proleakproof,'cost',procost,'rows',prorows,
    'returns_set',proretset,'result',pg_get_function_result(oid),'kind',prokind,'support',prosupport::oid::bigint,
    'acl_detail',(select jsonb_agg(jsonb_build_object(
      'grantor',case when acl_items.grantor=0 then 'PUBLIC' else pg_get_userbyid(acl_items.grantor) end,
      'grantee',case when acl_items.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl_items.grantee) end,
      'privilege_type',acl_items.privilege_type,
      'is_grantable',acl_items.is_grantable
    ) order by acl_items.grantee,acl_items.privilege_type)
    from aclexplode(coalesce(proacl,acldefault('f',proowner))) acl_items),
    'anon_execute',has_function_privilege('anon',oid,'execute'),
    'public_execute',exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'),
    'service_role_execute',has_function_privilege('service_role',oid,'execute'),
    'authenticated_execute',has_function_privilege('authenticated',oid,'execute')
  ) order by proname) from target_functions)
) as evidence;

rollback;
