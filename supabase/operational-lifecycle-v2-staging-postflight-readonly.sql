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
  if has_table_privilege('anon','public.operational_mutations','select')
    or has_table_privilege('authenticated','public.operational_mutations','select') then raise exception 'operational mutation table is directly readable'; end if;
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
  'system_identifier',(select system_identifier::text from pg_control_system()),
  'environment_identity',(select jsonb_build_object('environment',environment,'project_ref',project_ref,'identity_nonce',identity_nonce) from public.deployment_environment_identity where environment='staging'),
  'captured_at_utc',timezone('utc',clock_timestamp()),
  'organization_id','org-primary',
  'app_state',(select jsonb_build_object('version',version,'bytes',octet_length(data::text),'md5',md5(data::text),'updated_at',updated_at,'updated_by',updated_by) from public.app_state where id='primary'),
  'open_sessions',(select count(*) from public.sessions where status<>'closed'),
  'open_customer_tabs',(select count(*) from public.customer_tabs where status='open'),
  'processing_financial_mutations',(select count(*) from public.financial_mutations where status<>'committed'),
  'processing_operational_mutations',(select count(*) from public.operational_mutations where status<>'committed'),
  'operational_mutations_rls',(select relrowsecurity from pg_class where oid='public.operational_mutations'::regclass),
  'functions',(select jsonb_agg(jsonb_build_object(
    'name',proname,'definition',pg_get_functiondef(oid),'definition_md5',md5(pg_get_functiondef(oid)),
    'owner',quote_ident(pg_get_userbyid(proowner)),'security_definer',prosecdef,'volatility',provolatile,'config',proconfig,'acl',proacl,
    'acl_detail',(select jsonb_agg(jsonb_build_object(
      'grantor',case when acl_items.grantor=0 then 'PUBLIC' else pg_get_userbyid(acl_items.grantor) end,
      'grantee',case when acl_items.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl_items.grantee) end,
      'privilege_type',acl_items.privilege_type,
      'is_grantable',acl_items.is_grantable
    ) order by acl_items.grantee,acl_items.privilege_type)
    from aclexplode(coalesce(proacl,acldefault('f',proowner))) acl_items),
    'anon_execute',has_function_privilege('anon',oid,'execute'),
    'authenticated_execute',has_function_privilege('authenticated',oid,'execute')
  ) order by proname) from target_functions)
) as evidence;

rollback;
