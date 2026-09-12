-- Read-only postflight. Compare the app_state object with the preflight exactly.
begin isolation level repeatable read read only;

select jsonb_build_object(
  'app_state_version', version,
  'app_state_bytes', octet_length(data::text),
  'app_state_md5', md5(data::text),
  'app_state_updated_at', updated_at,
  'app_state_updated_by', updated_by
) as compatibility_state
from public.app_state where id = 'primary';

select p.proname, md5(pg_get_functiondef(p.oid)) as definition_md5,
  p.prosecdef as security_definer, p.proconfig, p.proacl,
  pg_get_functiondef(p.oid) ~* '\mapp_state\M' as references_app_state,
  pg_get_functiondef(p.oid) ~* 'patch_app_state' as references_patch_helper
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in ('hop_session_v2','reject_session_v2','reject_customer_tab_v2','open_customer_tab')
  and pg_get_function_identity_arguments(p.oid)='payload jsonb'
order by p.proname;

select
  has_function_privilege('anon', 'public.hop_session_v2(jsonb)', 'execute') as anon_hop,
  has_function_privilege('anon', 'public.reject_session_v2(jsonb)', 'execute') as anon_reject_session,
  has_function_privilege('anon', 'public.reject_customer_tab_v2(jsonb)', 'execute') as anon_reject_tab,
  has_function_privilege('authenticated', 'public.hop_session_v2(jsonb)', 'execute') as authenticated_hop,
  has_function_privilege('authenticated', 'public.reject_session_v2(jsonb)', 'execute') as authenticated_reject_session,
  has_function_privilege('authenticated', 'public.reject_customer_tab_v2(jsonb)', 'execute') as authenticated_reject_tab;

select status, count(*) from public.operational_mutations group by status order by status;

rollback;

