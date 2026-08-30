-- Release B production preflight: read-only and fail-closed.
-- Run only after explicit approval, in production project rrdwbxvuwrbxefarxnse.
-- This file contains no public DML, DDL, temporary tables, or mutation RPC calls.

begin isolation level repeatable read read only;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
set local search_path = public, extensions;

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
