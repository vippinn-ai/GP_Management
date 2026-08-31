-- Release B production preflight: read-only and fail-closed.
-- Run only after explicit approval, in production project rrdwbxvuwrbxefarxnse.
-- This file contains no public DML, DDL, temporary tables, or mutation RPC calls.

begin transaction isolation level repeatable read read only;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
set local search_path = public, extensions;

with expected_functions(signature, expected_definition_sha256) as (
  values
    ('public.commit_checkout_bill_v2(jsonb)', '5db21abc1719f94627bc24b1845e201e58c3478ac5e3d776ded2d0d631f841b6'),
    ('public.commit_financial_adjustment_v2(jsonb)', '5497baeeb5669fe2d7dbc7cc0d2a687d95b8e8df387e6763df49282fbdeb3867'),
    ('public.delete_pause_log(jsonb)', '2ca126f39bb8cf581b1fa3fa1d9bb71e7ffbfdb5dbbff4458694daf12a9b8ebd'),
    ('public.edit_pause_log(jsonb)', 'f78d9a8b43737a3653248f848f46391bc11e3818509c495ef5a53c144709f15f'),
    ('public.get_financial_mutation_result(jsonb)', 'cb7cf6e5c360cbc139bf146d9e07375fc42845565cc8d635ff865a30f108fbe3'),
    ('public.record_session_audit(jsonb)', '20f9e030b41c6debb458b713bc97e94bc9f707172ae9dafc01d9caeb78f63144')
), resolved_functions as (
  select
    expected.signature,
    expected.expected_definition_sha256,
    to_regprocedure(expected.signature) as oid
  from expected_functions expected
)
select jsonb_build_object(
  'schema_version', 1,
  'expected_project_ref', 'rrdwbxvuwrbxefarxnse',
  'organization_id', 'org-primary',
  'captured_at', now(),
  'transaction_read_only', current_setting('transaction_read_only'),
  'production_write_allowed', false,
  'open_active_sessions', (
    select count(*)
    from public.sessions
    where organization_id = 'org-primary'
      and status in ('active', 'paused')
  ),
  'open_customer_tabs', (
    select count(*)
    from public.customer_tabs
    where organization_id = 'org-primary'
      and status = 'open'
  ),
  'processing_financial_mutations', (
    select count(*)
    from public.financial_mutations
    where organization_id = 'org-primary'
      and status = 'processing'
  ),
  'financial_v2_function_count', (
    select count(*)
    from unnest(array[
      'public.commit_checkout_bill_v2(jsonb)',
      'public.commit_financial_adjustment_v2(jsonb)',
      'public.get_financial_mutation_result(jsonb)'
    ]) as candidate(signature)
    where to_regprocedure(candidate.signature) is not null
  ),
  'financial_v2_functions_with_app_state_reference', (
    select count(*)
    from unnest(array[
      'public.commit_checkout_bill_v2(jsonb)',
      'public.commit_financial_adjustment_v2(jsonb)',
      'public.get_financial_mutation_result(jsonb)'
    ]) as candidate(signature)
    cross join lateral (select to_regprocedure(candidate.signature) as oid) resolved
    where resolved.oid is not null
      and pg_get_functiondef(resolved.oid) ~* '\mapp_state\M'
  ),
  'operational_maintenance_function_count', (
    select count(*)
    from unnest(array[
      'public.edit_pause_log(jsonb)',
      'public.delete_pause_log(jsonb)',
      'public.record_session_audit(jsonb)'
    ]) as candidate(signature)
    where to_regprocedure(candidate.signature) is not null
  ),
  'operational_maintenance_authenticated_grants', (
    select count(*)
    from unnest(array[
      'public.edit_pause_log(jsonb)',
      'public.delete_pause_log(jsonb)',
      'public.record_session_audit(jsonb)'
    ]) as candidate(signature)
    cross join lateral (select to_regprocedure(candidate.signature) as oid) resolved
    where resolved.oid is not null
      and has_function_privilege('authenticated', resolved.oid, 'execute')
  ),
  'operational_maintenance_anonymous_grants', (
    select count(*)
    from unnest(array[
      'public.edit_pause_log(jsonb)',
      'public.delete_pause_log(jsonb)',
      'public.record_session_audit(jsonb)'
    ]) as candidate(signature)
    cross join lateral (select to_regprocedure(candidate.signature) as oid) resolved
    where resolved.oid is not null
      and has_function_privilege('anon', resolved.oid, 'execute')
  ),
  'installed_function_fingerprint_match_count', (
    select count(*)
    from resolved_functions
    where oid is not null
      and encode(digest(pg_get_functiondef(oid), 'sha256'), 'hex') = expected_definition_sha256
  ),
  'installed_function_owner_match_count', (
    select count(*)
    from resolved_functions resolved
    join pg_proc function_row on function_row.oid = resolved.oid
    where pg_get_userbyid(function_row.proowner) = 'postgres'
  ),
  'installed_function_security_definer_count', (
    select count(*)
    from resolved_functions resolved
    join pg_proc function_row on function_row.oid = resolved.oid
    where function_row.prosecdef
      and function_row.provolatile = 'v'
      and function_row.proconfig @> array['search_path=public']::text[]
  ),
  'installed_function_authenticated_grant_count', (
    select count(*) from resolved_functions
    where oid is not null and has_function_privilege('authenticated', oid, 'execute')
  ),
  'installed_function_anon_grant_count', (
    select count(*) from resolved_functions
    where oid is not null and has_function_privilege('anon', oid, 'execute')
  ),
  'installed_function_public_grant_count', (
    select count(*) from resolved_functions
    where oid is not null and has_function_privilege('public', oid, 'execute')
  ),
  'installed_function_verification', (
    select jsonb_agg(jsonb_build_object(
      'signature', resolved.signature,
      'exists', resolved.oid is not null,
      'expected_definition_sha256', resolved.expected_definition_sha256,
      'actual_definition_sha256', case when resolved.oid is null then null else encode(digest(pg_get_functiondef(resolved.oid), 'sha256'), 'hex') end,
      'owner', case when resolved.oid is null then null else pg_get_userbyid(function_row.proowner) end,
      'security_definer', function_row.prosecdef,
      'volatility', function_row.provolatile,
      'search_path_public', coalesce(function_row.proconfig @> array['search_path=public']::text[], false),
      'authenticated_execute', case when resolved.oid is null then null else has_function_privilege('authenticated', resolved.oid, 'execute') end,
      'anon_execute', case when resolved.oid is null then null else has_function_privilege('anon', resolved.oid, 'execute') end,
      'public_execute', case when resolved.oid is null then null else has_function_privilege('public', resolved.oid, 'execute') end
    ) order by resolved.signature)
    from resolved_functions resolved
    left join pg_proc function_row on function_row.oid = resolved.oid
  ),
  'authenticated_function_grants', (
    select count(*)
    from unnest(array[
      'public.commit_checkout_bill_v2(jsonb)',
      'public.commit_financial_adjustment_v2(jsonb)',
      'public.get_financial_mutation_result(jsonb)'
    ]) as candidate(signature)
    cross join lateral (select to_regprocedure(candidate.signature) as oid) resolved
    where resolved.oid is not null
      and has_function_privilege('authenticated', resolved.oid, 'execute')
  ),
  'anonymous_function_grants', (
    select count(*)
    from unnest(array[
      'public.commit_checkout_bill_v2(jsonb)',
      'public.commit_financial_adjustment_v2(jsonb)',
      'public.get_financial_mutation_result(jsonb)'
    ]) as candidate(signature)
    cross join lateral (select to_regprocedure(candidate.signature) as oid) resolved
    where resolved.oid is not null
      and has_function_privilege('anon', resolved.oid, 'execute')
  ),
  'financial_mutations_rls_enabled', (
    select relrowsecurity
    from pg_class
    where oid = to_regclass('public.financial_mutations')
  ),
  'financial_mutations_rls_forced', (
    select relforcerowsecurity
    from pg_class
    where oid = to_regclass('public.financial_mutations')
  ),
  'financial_mutations_owner', (
    select pg_get_userbyid(relowner)
    from pg_class
    where oid = to_regclass('public.financial_mutations')
  ),
  'financial_mutations_direct_role_privilege_count', (
    select count(*)
    from (values ('authenticated'), ('anon')) roles(role_name)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) privileges(privilege_name)
    where has_table_privilege(roles.role_name, 'public.financial_mutations', privileges.privilege_name)
  ),
  'financial_mutations_public_acl_privilege_count', (
    select count(*)
    from pg_class table_row
    cross join lateral aclexplode(coalesce(table_row.relacl, acldefault('r', table_row.relowner))) expanded_acl
    where table_row.oid = to_regclass('public.financial_mutations')
      and expanded_acl.grantee = 0
  ),
  'financial_mutations_policy_count', (
    select count(*)
    from pg_policies
    where schemaname = 'public' and tablename = 'financial_mutations'
  ),
  'financial_mutations_exact_policy_count', (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'financial_mutations'
      and policyname = 'financial_mutations_select_org_members'
      and permissive = 'PERMISSIVE'
      and roles = array['authenticated']::name[]
      and cmd = 'SELECT'
      and qual = 'current_user_has_org_access(organization_id)'
      and with_check is null
  ),
  'financial_mutations_expected_index_count', (
    select count(*)
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'financial_mutations'
      and indexname in ('financial_mutations_pkey', 'financial_mutations_actor_created_idx')
  ),
  'app_state_version', (
    select version
    from public.app_state
    where id = 'primary'
  ),
  'app_state_bytes', (
    select pg_column_size(data)
    from public.app_state
    where id = 'primary'
  ),
  'app_state_data_selected', false
) as release_b_production_preflight;

commit;
