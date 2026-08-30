-- Release B final deployed staging evidence probe (rollback-only public-data read scope).
--
-- Run only in the Supabase SQL Editor for staging project tkbdyzxwwbhkpztgjjxh.
-- This script:
--   * reads deployed function fingerprints, grants, RLS, policies, indexes, and rows;
--   * uses EXPLAIN without ANALYZE for representative lock predicates;
--   * creates and writes only transaction-local temporary tables;
--   * never invokes a mutation RPC and never writes public business tables;
--   * never projects or hashes app_state contents; it records only version and pg_column_size(data).
-- The staging Postgres configuration rejects CREATE TEMP TABLE inside a READ ONLY transaction,
-- so public-data safety is provided by the reviewed absence of public DML/DDL plus final ROLLBACK.

begin isolation level repeatable read;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
set local search_path = pg_temp, public, extensions;

create temp table release_b_deployed_evidence (
  section_order integer not null,
  section text not null,
  line_no integer not null,
  detail jsonb not null
) on commit drop;

insert into release_b_deployed_evidence values
  (10, 'capture_context', 1, jsonb_build_object(
    'expected_project_ref', 'tkbdyzxwwbhkpztgjjxh',
    'captured_at', now(),
    'database_name', current_database(),
    'server_version', current_setting('server_version'),
    'transaction_read_only', current_setting('transaction_read_only'),
    'transaction_isolation', current_setting('transaction_isolation'),
    'public_write_guard', 'reviewed_no_public_dml_or_ddl_plus_rollback',
    'production_allowed', false
  ));

insert into release_b_deployed_evidence
select
  20,
  'deployed_function',
  row_number() over (order by candidate.signature)::integer,
  jsonb_build_object(
    'signature', candidate.signature,
    'exists', procedure_row.oid is not null,
    'definition_sha256', case when procedure_row.oid is null then null else encode(digest(pg_get_functiondef(procedure_row.oid), 'sha256'), 'hex') end,
    'definition_length', case when procedure_row.oid is null then null else length(pg_get_functiondef(procedure_row.oid)) end,
    'security_definer', procedure_row.prosecdef,
    'volatility', procedure_row.provolatile,
    'owner', pg_get_userbyid(procedure_row.proowner),
    'authenticated_can_execute', case when procedure_row.oid is null then null else has_function_privilege('authenticated', procedure_row.oid, 'execute') end,
    'anon_can_execute', case when procedure_row.oid is null then null else has_function_privilege('anon', procedure_row.oid, 'execute') end,
    'public_can_execute', case when procedure_row.oid is null then null else exists (
      select 1
      from aclexplode(coalesce(procedure_row.proacl, acldefault('f', procedure_row.proowner))) function_acl
      where function_acl.grantee = 0 and function_acl.privilege_type = 'EXECUTE'
    ) end,
    'forbidden_app_state_table_token', case when procedure_row.oid is null then null else pg_get_functiondef(procedure_row.oid) ~* '\mapp_state\M' end,
    'mentions_financial_mutations', case when procedure_row.oid is null then null else pg_get_functiondef(procedure_row.oid) ~* '\mfinancial_mutations\M' end
  )
from (values
  ('public.commit_checkout_bill_v2(jsonb)'),
  ('public.commit_financial_adjustment_v2(jsonb)'),
  ('public.get_financial_mutation_result(jsonb)')
) as candidate(signature)
left join pg_proc procedure_row on procedure_row.oid = to_regprocedure(candidate.signature)
order by candidate.signature;

insert into release_b_deployed_evidence
select
  30,
  'financial_mutations_table',
  1,
  jsonb_build_object(
    'table_exists', class_row.oid is not null,
    'row_level_security_enabled', class_row.relrowsecurity,
    'row_level_security_forced', class_row.relforcerowsecurity,
    'authenticated_select_privilege', case when class_row.oid is null then null else has_table_privilege('authenticated', class_row.oid, 'select') end,
    'authenticated_insert_privilege', case when class_row.oid is null then null else has_table_privilege('authenticated', class_row.oid, 'insert') end,
    'authenticated_update_privilege', case when class_row.oid is null then null else has_table_privilege('authenticated', class_row.oid, 'update') end,
    'anon_select_privilege', case when class_row.oid is null then null else has_table_privilege('anon', class_row.oid, 'select') end
  )
from (values ('public', 'financial_mutations')) as candidate(schema_name, table_name)
left join pg_namespace namespace_row on namespace_row.nspname = candidate.schema_name
left join pg_class class_row on class_row.relnamespace = namespace_row.oid and class_row.relname = candidate.table_name;

insert into release_b_deployed_evidence
select
  31,
  'financial_mutations_policy',
  row_number() over (order by policyname)::integer,
  to_jsonb(policy_row)
from (
  select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
  from pg_policies
  where schemaname = 'public' and tablename = 'financial_mutations'
  order by policyname
) as policy_row;

insert into release_b_deployed_evidence
select
  40,
  'relevant_index',
  row_number() over (order by tablename, indexname)::integer,
  jsonb_build_object('table', tablename, 'index', indexname, 'definition', indexdef)
from pg_indexes
where schemaname = 'public'
  and tablename in (
    'financial_mutations', 'sessions', 'customer_tabs', 'bills', 'bill_lines',
    'payments', 'inventory_items', 'stock_movements', 'operational_events', 'audit_logs'
  )
order by tablename, indexname;

insert into release_b_deployed_evidence
select
  50,
  'app_state_metadata_only',
  1,
  jsonb_build_object(
    'id', id,
    'version', version,
    'data_bytes', pg_column_size(data),
    'data_was_selected', false
  )
from public.app_state
where id = 'primary';

create temp table selected_release_b_mutations (
  mutation_id text primary key,
  expected_kind text not null,
  evidence_case text not null
) on commit drop;

insert into selected_release_b_mutations values
  ('financial-07e2f510-9f99-4ee9-81ea-fa7b73e5f1d2', 'commitCheckoutBill', 'replacement_quantity_decrease'),
  ('financial-0d8fface-924d-4448-82ec-d7b605f976e8', 'commitCheckoutBill', 'ltp_zero'),
  ('financial-11adc2ae-a34c-4695-9a46-920bba52229c', 'commitCheckoutBill', 'refund_race'),
  ('financial-12ad305e-c491-4bac-8e8c-896c45f6f553', 'commitCheckoutBill', 'payment_split'),
  ('financial-3a8a8555-b9bc-4d67-8f81-0233d1e5971a', 'commitCheckoutBill', 'bill_discount_zero'),
  ('financial-40e698d4-a052-4237-a0bc-5c2a07ecb3fd', 'commitCheckoutBill', 'repeat_combo_race'),
  ('financial-5ccede34-f309-4d06-9047-eee3bf31ffea', 'commitCheckoutBill', 'payment_partial_previous_dues'),
  ('financial-668ed94f-8db9-4d81-a6d4-b442cbaf0633', 'commitCheckoutBill', 'settlement_race'),
  ('financial-78e58f7a-a4f8-4c38-9649-525faad3b47a', 'commitCheckoutBill', 'refund_race'),
  ('financial-8b7e3657-e429-46a7-9648-feaa950f4ab1', 'commitCheckoutBill', 'writeoff_race'),
  ('financial-964246e4-ce27-412d-9650-a04ed47cd245', 'commitCheckoutBill', 'void_race'),
  ('financial-97096f90-8825-4fa9-ba19-55236e843128', 'commitCheckoutBill', 'discount_rounding'),
  ('financial-9ba5e551-62b3-4b21-a8b4-eadc62e40e1f', 'commitCheckoutBill', 'payment_partial_previous_dues'),
  ('financial-9cdfce70-3da7-4e78-9b2a-9ff34bba34d6', 'commitCheckoutBill', 'tab_combo_mutation_race'),
  ('financial-adjustment-bbf84c07-1f34-455b-8845-60a56636abc5', 'voidBill', 'void_race'),
  ('financial-adjustment-ebb59e5e-4564-41ce-aee1-466c90b5900e', 'settlePendingBills', 'settlement_race'),
  ('financial-adjustment-eeb86813-c144-42ab-b1e7-cb2332428488', 'refundBill', 'refund_race'),
  ('financial-adjustment-fba12e3d-7885-4b44-978e-aa93034f8ac8', 'writeOffPendingBills', 'writeoff_race'),
  ('financial-cf04504d-c550-4fa1-8122-0317464acc05', 'commitCheckoutBill', 'replacement_quantity_decrease'),
  ('financial-d699ad81-8979-454f-a725-85f3bd010471', 'commitCheckoutBill', 'payment_upi'),
  ('financial-dcc374f1-ca58-4f41-b018-81364cbd4f12', 'commitCheckoutBill', 'void_race'),
  ('financial-multihop-20260825122028-b', 'commitCheckoutBill', 'multi_hop_carryover');

create temp table selected_release_b_mutation_checks (
  mutation_id text primary key,
  evidence_case text not null,
  expected_kind text not null,
  mutation_row_count bigint not null,
  status text,
  actual_kind text,
  actor_user_id text,
  server_duration_ms numeric,
  canonical_event_id text,
  metadata_event_count bigint not null,
  canonical_event_match_count bigint not null,
  canonical_metadata_event_match_count bigint not null,
  created_at timestamptz,
  updated_at timestamptz
) on commit drop;

insert into selected_release_b_mutation_checks
select
  selected.mutation_id,
  selected.evidence_case,
  selected.expected_kind,
  mutation.mutation_row_count,
  mutation.status,
  mutation.actual_kind,
  mutation.actor_user_id,
  mutation.server_duration_ms,
  mutation.canonical_event_id,
  event_counts.metadata_event_count,
  event_counts.canonical_event_match_count,
  event_counts.canonical_metadata_event_match_count,
  mutation.created_at,
  mutation.updated_at
from selected_release_b_mutations selected
left join lateral (
  select
    count(*) as mutation_row_count,
    min(financial.status) as status,
    min(financial.mutation_kind) as actual_kind,
    min(financial.actor_user_id::text) as actor_user_id,
    min((financial.canonical_result->>'server_duration_ms')::numeric) as server_duration_ms,
    min(financial.canonical_result->>'event_id') as canonical_event_id,
    min(financial.created_at) as created_at,
    max(financial.updated_at) as updated_at
  from public.financial_mutations financial
  where financial.organization_id = 'org-primary'
    and financial.mutation_id = selected.mutation_id
) mutation on true
left join lateral (
  select
    count(*) filter (where event_row.metadata->>'mutation_id' = selected.mutation_id) as metadata_event_count,
    count(*) filter (where event_row.id = mutation.canonical_event_id) as canonical_event_match_count,
    count(*) filter (
      where event_row.id = mutation.canonical_event_id
        and event_row.metadata->>'mutation_id' = selected.mutation_id
    ) as canonical_metadata_event_match_count
  from public.operational_events event_row
  where event_row.organization_id = 'org-primary'
    and (
      event_row.metadata->>'mutation_id' = selected.mutation_id
      or event_row.id = mutation.canonical_event_id
    )
) event_counts on true;

insert into release_b_deployed_evidence
select
  60,
  'selected_mutation_integrity',
  row_number() over (order by mutation_id)::integer,
  jsonb_build_object(
    'mutation_id', mutation_id,
    'evidence_case', evidence_case,
    'expected_kind', expected_kind,
    'mutation_row_count', mutation_row_count,
    'status', status,
    'actual_kind', actual_kind,
    'actor_user_id', actor_user_id,
    'server_duration_ms', server_duration_ms,
    'canonical_event_id', canonical_event_id,
    'metadata_event_count', metadata_event_count,
    'canonical_event_match_count', canonical_event_match_count,
    'canonical_metadata_event_match_count', canonical_metadata_event_match_count,
    'created_at', created_at,
    'updated_at', updated_at,
    'exact', mutation_row_count = 1 and status = 'committed' and actual_kind = expected_kind
      and canonical_event_id is not null and metadata_event_count = 1 and canonical_event_match_count = 1
      and canonical_metadata_event_match_count = 1
  )
from selected_release_b_mutation_checks
order by mutation_id;

insert into release_b_deployed_evidence
select
  61,
  'selected_mutation_summary',
  1,
  jsonb_build_object(
    'expected_count', 22,
    'matched_count', count(*) filter (where mutation_row_count = 1),
    'committed_count', count(*) filter (where status = 'committed'),
    'kind_match_count', count(*) filter (where actual_kind = expected_kind),
    'canonical_event_exact_count', count(*) filter (
      where canonical_event_id is not null and metadata_event_count = 1 and canonical_event_match_count = 1
        and canonical_metadata_event_match_count = 1
    ),
    'database_p95_ms', percentile_disc(0.95) within group (order by server_duration_ms),
    'database_max_ms', max(server_duration_ms),
    'window_from', min(created_at) - interval '5 minutes',
    'window_to', max(updated_at) + interval '5 minutes',
    'mutation_ids', jsonb_agg(mutation_id order by mutation_id),
    'missing_or_duplicate_ids', coalesce(jsonb_agg(mutation_id order by mutation_id) filter (where mutation_row_count <> 1), '[]'::jsonb),
    'uncommitted_ids', coalesce(jsonb_agg(mutation_id order by mutation_id) filter (where status is distinct from 'committed'), '[]'::jsonb),
    'kind_mismatch_ids', coalesce(jsonb_agg(mutation_id order by mutation_id) filter (where actual_kind is distinct from expected_kind), '[]'::jsonb),
    'event_mismatch_ids', coalesce(jsonb_agg(mutation_id order by mutation_id) filter (
      where canonical_event_id is null or metadata_event_count <> 1 or canonical_event_match_count <> 1
        or canonical_metadata_event_match_count <> 1
    ), '[]'::jsonb),
    'all_22_exact', count(*) = 22 and bool_and(
      mutation_row_count = 1 and status = 'committed' and actual_kind = expected_kind
      and canonical_event_id is not null and metadata_event_count = 1 and canonical_event_match_count = 1
      and canonical_metadata_event_match_count = 1
    )
  )
from selected_release_b_mutation_checks;

do $$
declare
  sample_mutation public.financial_mutations%rowtype;
  sample_session_id text;
  sample_tab_id text;
  sample_bill_id text;
  sample_inventory_id text;
  plan_line text;
  line_counter integer := 0;
begin
  select mutation.* into sample_mutation
  from public.financial_mutations mutation
  join selected_release_b_mutations selected
    on selected.mutation_id = mutation.mutation_id and selected.expected_kind = mutation.mutation_kind
  where mutation.organization_id = 'org-primary'
  order by mutation.created_at desc
  limit 1;

  select id into sample_session_id from public.sessions where organization_id = 'org-primary' order by created_at desc limit 1;
  select id into sample_tab_id from public.customer_tabs where organization_id = 'org-primary' order by opened_at desc limit 1;
  select id into sample_bill_id from public.bills where organization_id = 'org-primary' order by issued_at desc limit 1;
  select id into sample_inventory_id from public.inventory_items where organization_id = 'org-primary' order by id limit 1;

  for plan_line in execute format(
    'explain (format text) select 1 from public.financial_mutations where organization_id = %L and mutation_id = %L and mutation_kind = %L for update',
    sample_mutation.organization_id, sample_mutation.mutation_id, sample_mutation.mutation_kind
  ) loop
    line_counter := line_counter + 1;
    insert into release_b_deployed_evidence values (70, 'plan_1_idempotency_lock', line_counter, jsonb_build_object('line', plan_line));
  end loop;

  line_counter := 0;
  if sample_session_id is not null then
    for plan_line in execute format('explain (format text) select 1 from public.sessions where organization_id = %L and id = %L for update', 'org-primary', sample_session_id) loop
      line_counter := line_counter + 1;
      insert into release_b_deployed_evidence values (71, 'plan_2_session_lock', line_counter, jsonb_build_object('line', plan_line));
    end loop;
  end if;

  line_counter := 0;
  if sample_tab_id is not null then
    for plan_line in execute format('explain (format text) select 1 from public.customer_tabs where organization_id = %L and id = %L for update', 'org-primary', sample_tab_id) loop
      line_counter := line_counter + 1;
      insert into release_b_deployed_evidence values (72, 'plan_3_customer_tab_lock', line_counter, jsonb_build_object('line', plan_line));
    end loop;
  end if;

  line_counter := 0;
  if sample_bill_id is not null then
    for plan_line in execute format('explain (format text) select 1 from public.bills where organization_id = %L and id = %L for update', 'org-primary', sample_bill_id) loop
      line_counter := line_counter + 1;
      insert into release_b_deployed_evidence values (73, 'plan_4_bill_lock', line_counter, jsonb_build_object('line', plan_line));
    end loop;
  end if;

  line_counter := 0;
  if sample_inventory_id is not null then
    for plan_line in execute format('explain (format text) select 1 from public.inventory_items where organization_id = %L and id = %L for update', 'org-primary', sample_inventory_id) loop
      line_counter := line_counter + 1;
      insert into release_b_deployed_evidence values (74, 'plan_5_inventory_lock', line_counter, jsonb_build_object('line', plan_line));
    end loop;
  end if;
end;
$$;

insert into release_b_deployed_evidence
select
  90,
  'probe_summary',
  1,
  jsonb_build_object(
    'function_rows', count(*) filter (where section = 'deployed_function'),
    'function_rows_with_forbidden_app_state_token', count(*) filter (where section = 'deployed_function' and (detail->>'forbidden_app_state_table_token')::boolean),
    'plan_rows', count(*) filter (where section like 'plan_%'),
    'plan_rows_mentioning_app_state', count(*) filter (where section like 'plan_%' and detail->>'line' ~* '\mapp_state\M'),
    'explain_analyze_used', false,
    'row_level_for_update_executed', false,
    'planning_relation_locks_possible', true,
    'mutation_rpc_invoked', false,
    'public_business_rows_written', false,
    'transaction_rollback_is_final_statement', true,
    'production_allowed', false
  )
from release_b_deployed_evidence;

select jsonb_build_object(
  'schema_version', 1,
  'expected_project_ref', 'tkbdyzxwwbhkpztgjjxh',
  'row_count', count(*),
  'rows', jsonb_agg(
    jsonb_build_object(
      'section_order', section_order,
      'section', section,
      'line_no', line_no,
      'detail', detail
    ) order by section_order, line_no
  )
) as release_b_deployed_readonly_evidence
from release_b_deployed_evidence;

rollback;
