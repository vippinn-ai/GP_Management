-- Read-only, repeatable-read staging preflight for atomic operational bootstrap v2.
-- Save the single JSON value exactly; do not edit it.
begin isolation level repeatable read read only;

do $$
begin
  if current_database() <> 'postgres'
    or (select system_identifier::text from pg_control_system()) <> '7623125441096521075'
  then raise exception 'physical database is not the approved staging cluster'; end if;
  if not exists (
    select 1 from public.deployment_environment_identity
    where environment = 'staging' and project_ref = 'tkbdyzxwwbhkpztgjjxh'
  ) then raise exception 'database-derived staging identity failed'; end if;
  if not exists (select 1 from public.app_state where id = 'primary')
  then raise exception 'primary app_state is missing'; end if;
end $$;

with target_function as (
  select p.*, n.nspname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'load_operational_bootstrap_v2'
    and pg_get_function_identity_arguments(p.oid) = ''
), function_evidence as (
  select jsonb_build_object(
    'definition', pg_get_functiondef(oid),
    'definition_md5', md5(pg_get_functiondef(oid)),
    'body_md5', md5(regexp_replace(btrim(prosrc, E' \t\n\r'), E'\\r\\n?', E'\\n', 'g')),
    'owner', quote_ident(pg_get_userbyid(proowner)),
    'owner_name', pg_get_userbyid(proowner),
    'security_definer', prosecdef,
    'volatility', provolatile,
    'config', to_jsonb(proconfig),
    'acl_detail', (
      select jsonb_agg(jsonb_build_object(
        'grantor', case when acl.grantor = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantor) end,
        'grantee', case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
        'privilege_type', acl.privilege_type,
        'is_grantable', acl.is_grantable
      ) order by acl.grantee, acl.privilege_type)
      from aclexplode(coalesce(proacl, acldefault('f', proowner))) acl
    )
  ) as value
  from target_function
), app_state_evidence as (
  select jsonb_build_object(
    'version', version,
    'bytes', octet_length(data::text),
    'md5', md5(data::text),
    'updated_at', updated_at,
    'updated_by', updated_by
  ) as value
  from public.app_state where id = 'primary'
), realtime_security as (
  select jsonb_build_object(
    'rls_enabled', c.relrowsecurity,
    'published', exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'operational_events'
    ),
    'policies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', policyname, 'roles', roles, 'command', cmd, 'using', qual, 'check', with_check
      ) order by policyname)
      from pg_policies
      where schemaname = 'public' and tablename = 'operational_events'
    ), '[]'::jsonb),
    'access_helper_definition', pg_get_functiondef('public.current_user_has_org_access(text)'::regprocedure),
    'access_helper_md5', md5(pg_get_functiondef('public.current_user_has_org_access(text)'::regprocedure))
  ) as value
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'operational_events'
)
select jsonb_build_object(
  'expected_project_ref', 'tkbdyzxwwbhkpztgjjxh',
  'system_identifier', (select system_identifier::text from pg_control_system()),
  'environment_identity', (
    select jsonb_build_object('environment', environment, 'project_ref', project_ref, 'identity_nonce', identity_nonce)
    from public.deployment_environment_identity where environment = 'staging'
  ),
  'captured_at_utc', timezone('utc', clock_timestamp()),
  'installer_role', current_user,
  'organization_id', 'org-primary',
  'open_sessions', (select count(*) from public.sessions where organization_id = 'org-primary' and status <> 'closed'),
  'open_customer_tabs', (select count(*) from public.customer_tabs where organization_id = 'org-primary' and status = 'open'),
  'processing_financial_mutations', (select count(*) from public.financial_mutations where organization_id = 'org-primary' and status <> 'committed'),
  'processing_operational_mutations', (select count(*) from public.operational_mutations where organization_id = 'org-primary' and status <> 'committed'),
  'app_state', (select value from app_state_evidence),
  'target_function', (select value from function_evidence),
  'realtime_security', (select value from realtime_security)
) as evidence;

rollback;
