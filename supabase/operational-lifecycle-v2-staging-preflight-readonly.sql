-- Read-only fail-closed staging preflight. Run in the staging SQL editor only.
begin isolation level repeatable read read only;

select jsonb_build_object(
  'database', current_database(),
  'server_time', timezone('utc', now()),
  'app_state_version', version,
  'app_state_bytes', octet_length(data::text),
  'app_state_md5', md5(data::text),
  'app_state_updated_at', updated_at,
  'app_state_updated_by', updated_by
) as environment_baseline
from public.app_state
where id = 'primary';

select jsonb_build_object(
  'open_sessions', (select count(*) from public.sessions where status <> 'closed'),
  'open_customer_tabs', (select count(*) from public.customer_tabs where status = 'open'),
  'processing_financial_mutations', (select count(*) from public.financial_mutations where status <> 'committed'),
  'operational_mutations_table_exists', to_regclass('public.operational_mutations') is not null
) as floor_state;

select
  p.proname,
  md5(pg_get_functiondef(p.oid)) as definition_md5,
  p.prosecdef as security_definer,
  p.provolatile,
  p.proconfig,
  p.proacl,
  pg_get_userbyid(p.proowner) as owner,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('hop_session', 'reject_session', 'reject_customer_tab', 'open_customer_tab')
  and pg_get_function_identity_arguments(p.oid) = 'payload jsonb'
order by p.proname;

select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'operational_mutations'
order by table_name, grantee, privilege_type;

rollback;
