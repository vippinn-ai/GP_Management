-- Release B production baseline for backup and post-deployment reconciliation.
-- Production project: rrdwbxvuwrbxefarxnse.
-- This file contains no public DML, DDL, temporary tables, or mutation RPC calls.

begin transaction isolation level repeatable read read only;
set local statement_timeout = '60s';
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
    select count(*) from public.sessions
    where organization_id = 'org-primary' and status in ('active', 'paused')
  ),
  'open_customer_tabs', (
    select count(*) from public.customer_tabs
    where organization_id = 'org-primary' and status = 'open'
  ),
  'public_counts', jsonb_build_object(
    'profiles', (select count(*) from public.profiles),
    'organizations', (select count(*) from public.organizations),
    'organization_members', (select count(*) from public.organization_members),
    'inventory_categories', (select count(*) from public.inventory_categories where organization_id = 'org-primary'),
    'stations', (select count(*) from public.stations where organization_id = 'org-primary'),
    'pricing_rules', (select count(*) from public.pricing_rules where organization_id = 'org-primary'),
    'customers', (select count(*) from public.customers where organization_id = 'org-primary'),
    'inventory_items', (select count(*) from public.inventory_items where organization_id = 'org-primary'),
    'sale_variants', (select count(*) from public.sale_variants where organization_id = 'org-primary'),
    'combos', (select count(*) from public.combos where organization_id = 'org-primary'),
    'combo_station_targets', (select count(*) from public.combo_station_targets where organization_id = 'org-primary'),
    'combo_fixed_items', (select count(*) from public.combo_fixed_items where organization_id = 'org-primary'),
    'combo_choice_groups', (select count(*) from public.combo_choice_groups where organization_id = 'org-primary'),
    'combo_choice_options', (select count(*) from public.combo_choice_options where organization_id = 'org-primary'),
    'sessions', (select count(*) from public.sessions where organization_id = 'org-primary'),
    'session_pause_logs', (select count(*) from public.session_pause_logs where organization_id = 'org-primary'),
    'session_items', (select count(*) from public.session_items where organization_id = 'org-primary'),
    'session_combo_applications', (select count(*) from public.session_combo_applications where organization_id = 'org-primary'),
    'customer_tabs', (select count(*) from public.customer_tabs where organization_id = 'org-primary'),
    'customer_tab_items', (select count(*) from public.customer_tab_items where organization_id = 'org-primary'),
    'customer_tab_combo_applications', (select count(*) from public.customer_tab_combo_applications where organization_id = 'org-primary'),
    'bills', (select count(*) from public.bills where organization_id = 'org-primary'),
    'bill_lines', (select count(*) from public.bill_lines where organization_id = 'org-primary'),
    'bill_line_discounts', (select count(*) from public.bill_line_discounts where organization_id = 'org-primary'),
    'bill_discounts', (select count(*) from public.bill_discounts where organization_id = 'org-primary'),
    'payments', (select count(*) from public.payments where organization_id = 'org-primary'),
    'stock_movements', (select count(*) from public.stock_movements where organization_id = 'org-primary'),
    'audit_logs', (select count(*) from public.audit_logs where organization_id = 'org-primary'),
    'expenses', (select count(*) from public.expenses where organization_id = 'org-primary'),
    'expense_templates', (select count(*) from public.expense_templates where organization_id = 'org-primary'),
    'expense_template_overrides', (select count(*) from public.expense_template_overrides where organization_id = 'org-primary'),
    'operational_events', (select count(*) from public.operational_events where organization_id = 'org-primary')
  ),
  'financial_totals', jsonb_build_object(
    'bill_total', (select coalesce(sum(total), 0) from public.bills where organization_id = 'org-primary'),
    'bill_amount_paid', (select coalesce(sum(amount_paid), 0) from public.bills where organization_id = 'org-primary'),
    'bill_amount_due', (select coalesce(sum(amount_due), 0) from public.bills where organization_id = 'org-primary'),
    'payment_amount', (select coalesce(sum(amount), 0) from public.payments where organization_id = 'org-primary'),
    'stock_movement_quantity', (select coalesce(sum(quantity), 0) from public.stock_movements where organization_id = 'org-primary'),
    'pending_bill_count', (select count(*) from public.bills where organization_id = 'org-primary' and status = 'pending'),
    'pending_bill_due', (select coalesce(sum(amount_due), 0) from public.bills where organization_id = 'org-primary' and status = 'pending')
  ),
  'latest_timestamps', jsonb_build_object(
    'bill_issued_at', (select max(issued_at) from public.bills where organization_id = 'org-primary'),
    'payment_paid_at', (select max(paid_at) from public.payments where organization_id = 'org-primary'),
    'audit_at', (select max(audit_at) from public.audit_logs where organization_id = 'org-primary'),
    'operational_event_created_at', (select max(created_at) from public.operational_events where organization_id = 'org-primary')
  ),
  'managed_schema_counts', jsonb_build_object(
    'auth_users', (select count(*) from auth.users),
    'storage_buckets', (select count(*) from storage.buckets),
    'storage_objects', (select count(*) from storage.objects)
  ),
  'app_state', jsonb_build_object(
    'version', (select version from public.app_state where id = 'primary'),
    'bytes', (select pg_column_size(data) from public.app_state where id = 'primary'),
    'data_hash', (select encode(digest(data::text, 'sha256'), 'hex') from public.app_state where id = 'primary'),
    'data_selected', false
  )
) as release_b_production_baseline;

commit;
