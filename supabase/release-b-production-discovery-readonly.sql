-- Release B production discovery: read-only and safe before v2 is installed.
-- Production project: rrdwbxvuwrbxefarxnse.
-- This file contains no public DML, DDL, temporary tables, or mutation RPC calls.

begin transaction isolation level repeatable read read only;
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
  'financial_mutations_table_present',
    to_regclass('public.financial_mutations') is not null,
  'financial_v2_function_count', (
    select count(*)
    from unnest(array[
      'public.commit_checkout_bill_v2(jsonb)',
      'public.commit_financial_adjustment_v2(jsonb)',
      'public.get_financial_mutation_result(jsonb)'
    ]) as candidate(signature)
    where to_regprocedure(candidate.signature) is not null
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
  'required_existing_function_count', (
    select count(*)
    from unnest(array[
      'public.start_session(jsonb)',
      'public.pause_session(jsonb)',
      'public.resume_session(jsonb)',
      'public.add_session_item(jsonb)',
      'public.remove_session_item(jsonb)',
      'public.hop_session(jsonb)',
      'public.reject_session(jsonb)',
      'public.repeat_session_combo(jsonb)',
      'public.open_customer_tab(jsonb)',
      'public.link_customer_tab_continuation(jsonb)',
      'public.apply_customer_tab_combo(jsonb)',
      'public.add_customer_tab_item(jsonb)',
      'public.update_customer_tab_item_quantity(jsonb)',
      'public.remove_customer_tab_item(jsonb)',
      'public.reject_customer_tab(jsonb)',
      'public.save_live_session_details(jsonb)',
      'public.save_live_customer_tab_details(jsonb)',
      'public.commit_checkout_bill(jsonb)',
      'public.commit_financial_adjustment(jsonb)',
      'public.commit_admin_data_change(jsonb)',
      'public.load_analytics_summary(text,date,date,date,date)',
      'public.load_inventory_report_summary(text,date,date,text,integer)'
    ]) as candidate(signature)
    where to_regprocedure(candidate.signature) is not null
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
) as release_b_production_discovery;

commit;
