-- Staging-only, PII-free exact dataset identity for the performance gate.
-- Keep this test instrumentation out of production lifecycle migrations.
create or replace function public.get_operational_performance_dataset_identity(payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_org text := nullif(payload->>'organization_id',''); v_actor uuid := auth.uid();
begin
  if v_org is null or v_actor is null or not public.current_user_has_org_access(v_org) then
    perform public.raise_operational_rpc_error('organization_access_denied','You do not have access to this organization.',jsonb_build_object('organization_id',v_org));
  end if;
  return jsonb_build_object(
    'organization_id',v_org,
    'app_state',(select jsonb_build_object('version',version,'bytes',octet_length(data::text),'md5',md5(data::text),'updated_at',updated_at,'updated_by',updated_by) from public.app_state where id='primary'),
    'public_counts',jsonb_build_object(
      'sessions',(select count(*) from public.sessions where organization_id=v_org),
      'customer_tabs',(select count(*) from public.customer_tabs where organization_id=v_org),
      'bills',(select count(*) from public.bills where organization_id=v_org),
      'bill_lines',(select count(*) from public.bill_lines where organization_id=v_org),
      'payments',(select count(*) from public.payments where organization_id=v_org),
      'customers',(select count(*) from public.customers where organization_id=v_org),
      'audit_logs',(select count(*) from public.audit_logs where organization_id=v_org),
      'operational_events',(select count(*) from public.operational_events where organization_id=v_org),
      'stock_movements',(select count(*) from public.stock_movements where organization_id=v_org),
      'session_pause_logs',(select count(*) from public.session_pause_logs where organization_id=v_org),
      'session_items',(select count(*) from public.session_items where organization_id=v_org),
      'customer_tab_items',(select count(*) from public.customer_tab_items where organization_id=v_org),
      'inventory_items',(select count(*) from public.inventory_items where organization_id=v_org),
      'combos',(select count(*) from public.combos where organization_id=v_org),
      'stations',(select count(*) from public.stations where organization_id=v_org)
    ),
    'public_fingerprints',jsonb_build_object(
      'sessions',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.sessions t where organization_id=v_org),
      'customer_tabs',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.customer_tabs t where organization_id=v_org),
      'bills',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.bills t where organization_id=v_org),
      'bill_lines',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.bill_lines t where organization_id=v_org),
      'payments',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.payments t where organization_id=v_org),
      'customers',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.customers t where organization_id=v_org),
      'audit_logs',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.audit_logs t where organization_id=v_org),
      'operational_events',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.operational_events t where organization_id=v_org),
      'stock_movements',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.stock_movements t where organization_id=v_org)
    )
  );
end;
$$;

revoke all on function public.get_operational_performance_dataset_identity(jsonb) from public;
revoke execute on function public.get_operational_performance_dataset_identity(jsonb) from anon;
grant execute on function public.get_operational_performance_dataset_identity(jsonb) to authenticated;
