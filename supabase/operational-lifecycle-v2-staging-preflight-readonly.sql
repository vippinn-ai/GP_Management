-- Read-only fail-closed staging preflight. Save the single JSON value exactly.
-- The SQL-editor URL must show project tkbdyzxwwbhkpztgjjxh before execution.
begin isolation level repeatable read read only;

do $$
declare incomplete_operational integer := 0;
begin
  if current_setting('app.settings.api_url', true) is null
    or position('tkbdyzxwwbhkpztgjjxh' in current_setting('app.settings.api_url', true)) = 0
  then raise exception 'database API URL does not identify the approved staging project'; end if;
  if not exists(select 1 from public.organizations where id='org-primary') then raise exception 'staging organization identity failed'; end if;
  if to_regclass('public.deployment_environment_identity') is null
    or not exists(select 1 from public.deployment_environment_identity where environment='staging' and project_ref='tkbdyzxwwbhkpztgjjxh')
  then raise exception 'database-derived staging identity failed'; end if;
  if not exists(select 1 from public.app_state where id='primary') then raise exception 'primary app_state is missing'; end if;
  if (select count(*) from public.sessions where status<>'closed') <> 0 then raise exception 'staging has open sessions'; end if;
  if (select count(*) from public.customer_tabs where status='open') <> 0 then raise exception 'staging has open customer tabs'; end if;
  if exists(
    select 1 from public.sessions source
    where source.organization_id='org-primary' and source.status='closed' and source.close_disposition='hopped' and source.closed_bill_id is null
      and not exists(select 1 from public.sessions consumer where consumer.organization_id=source.organization_id
        and consumer.continued_from_session_ids @> jsonb_build_array(source.id)
        and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))
      and not exists(select 1 from public.customer_tabs consumer where consumer.organization_id=source.organization_id
        and consumer.continued_from_session_ids @> jsonb_build_array(source.id)
        and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))
  ) then raise exception 'staging has a recoverable unconsumed hopped session'; end if;
  if (select count(*) from public.financial_mutations where status<>'committed') <> 0 then raise exception 'staging has incomplete financial mutations'; end if;
  if to_regclass('public.operational_mutations') is not null then
    execute 'select count(*) from public.operational_mutations where status<>''committed''' into incomplete_operational;
    if incomplete_operational <> 0 then raise exception 'staging has incomplete operational mutations'; end if;
  end if;
  perform set_config('normops.processing_operational_mutations', incomplete_operational::text, true);
end $$;

with target_functions as (
  select p.*, n.nspname
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname in (
      'hop_session','reject_session','reject_customer_tab',
      'start_session','open_customer_tab','link_customer_tab_continuation',
      'hop_session_v2','reject_session_v2','reject_customer_tab_v2'
    )
    and pg_get_function_identity_arguments(p.oid)='payload jsonb'
), function_evidence as (
  select jsonb_agg(jsonb_build_object(
    'name', proname,
    'definition', pg_get_functiondef(oid),
    'definition_md5', md5(pg_get_functiondef(oid)),
    'owner', quote_ident(pg_get_userbyid(proowner)),
    'security_definer', prosecdef,
    'volatility', provolatile,
    'config', proconfig,
    'acl', proacl,
    'acl_detail', (select jsonb_agg(jsonb_build_object(
      'grantor',case when acl_items.grantor=0 then 'PUBLIC' else pg_get_userbyid(acl_items.grantor) end,
      'grantee',case when acl_items.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl_items.grantee) end,
      'privilege_type',acl_items.privilege_type,
      'is_grantable',acl_items.is_grantable
    ) order by acl_items.grantee,acl_items.privilege_type)
    from aclexplode(coalesce(proacl,acldefault('f',proowner))) acl_items),
    'public_execute', has_function_privilege('public', oid, 'execute'),
    'anon_execute', has_function_privilege('anon', oid, 'execute'),
    'authenticated_execute', has_function_privilege('authenticated', oid, 'execute'),
    'service_role_execute', has_function_privilege('service_role', oid, 'execute')
  ) order by proname) as value
  from target_functions
), app_state_evidence as (
  select jsonb_build_object(
    'version', version,
    'bytes', octet_length(data::text),
    'md5', md5(data::text),
    'updated_at', updated_at,
    'updated_by', updated_by
  ) as value from public.app_state where id='primary'
)
select jsonb_build_object(
  'expected_project_ref', 'tkbdyzxwwbhkpztgjjxh',
  'environment_identity', (select jsonb_build_object('environment',environment,'project_ref',project_ref,'identity_nonce',identity_nonce) from public.deployment_environment_identity where environment='staging'),
  'api_url_setting', current_setting('app.settings.api_url', true),
  'database', current_database(),
  'captured_at_utc', timezone('utc', clock_timestamp()),
  'organization_id', 'org-primary',
  'organization_exists', exists(select 1 from public.organizations where id='org-primary'),
  'open_sessions', (select count(*) from public.sessions where status<>'closed'),
  'open_customer_tabs', (select count(*) from public.customer_tabs where status='open'),
  'recoverable_hopped_sessions', (select count(*) from public.sessions source
    where source.organization_id='org-primary' and source.status='closed' and source.close_disposition='hopped' and source.closed_bill_id is null
      and not exists(select 1 from public.sessions consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))
      and not exists(select 1 from public.customer_tabs consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))),
  'processing_financial_mutations', (select count(*) from public.financial_mutations where status<>'committed'),
  'processing_operational_mutations', current_setting('normops.processing_operational_mutations')::integer,
  'operational_mutations_table_exists', to_regclass('public.operational_mutations') is not null,
  'app_state', (select value from app_state_evidence),
  'functions', (select value from function_evidence)
) as evidence;

rollback;
