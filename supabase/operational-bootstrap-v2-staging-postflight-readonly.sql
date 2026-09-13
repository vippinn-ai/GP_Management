-- Read-only executable postflight for the staging atomic bootstrap RPC.
begin isolation level repeatable read read only;

do $$
declare
  actor_id uuid;
  payload jsonb;
  expected_keys text[] := array[
    'contract_version','status','actor_id','organization_id','actor_profile','organization',
    'app_state_metadata','profiles','inventory_categories','stations','pricing_rules','inventory_items',
    'sale_variants','combos','combo_station_targets','combo_fixed_items','combo_choice_groups',
    'combo_choice_options','sessions','session_pause_logs','session_items','session_combo_applications',
    'customer_tabs','customer_tab_items','customer_tab_combo_applications'
  ];
begin
  if current_database() <> 'postgres'
    or (select system_identifier::text from pg_control_system()) <> '7623125441096521075'
  then raise exception 'physical database is not approved staging'; end if;
  if not exists (select 1 from public.deployment_environment_identity
    where environment = 'staging' and project_ref = 'tkbdyzxwwbhkpztgjjxh')
  then raise exception 'staging database identity failed'; end if;
  select profile.id into strict actor_id
  from public.profiles profile
  join public.organization_members membership on membership.user_id = profile.id
  join public.organizations organization on organization.id = membership.organization_id
  where profile.active and membership.active and organization.active and organization.id = 'org-primary'
  order by case profile.role when 'admin' then 0 when 'manager' then 1 else 2 end, profile.id
  limit 1;
  perform set_config('request.jwt.claim.sub', actor_id::text, true);
  payload := public.load_operational_bootstrap_v2();
  if payload ->> 'status' <> 'active'
    or payload ->> 'actor_id' <> actor_id::text
    or payload ->> 'organization_id' <> 'org-primary'
  then raise exception 'bootstrap identity result mismatch'; end if;
  if (select array_agg(key order by key) from jsonb_object_keys(payload) as keys(key))
    is distinct from (select array_agg(key order by key) from unnest(expected_keys) as keys(key))
  then raise exception 'bootstrap response keys mismatch'; end if;
  if octet_length(payload::text) > 160992 then raise exception 'bootstrap payload exceeded byte budget'; end if;
  perform set_config('normops.bootstrap_postflight_payload', payload::text, true);
end $$;

with target as (
  select p.* from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'load_operational_bootstrap_v2'
    and pg_get_function_identity_arguments(p.oid) = ''
), payload as (
  select current_setting('normops.bootstrap_postflight_payload')::jsonb value
)
select jsonb_build_object(
  'project_ref', 'tkbdyzxwwbhkpztgjjxh',
  'system_identifier', (select system_identifier::text from pg_control_system()),
  'captured_at_utc', timezone('utc', clock_timestamp()),
  'function', (select jsonb_build_object(
    'definition_md5', md5(pg_get_functiondef(oid)),
    'body_md5', md5(btrim(prosrc)),
    'security_definer', prosecdef,
    'volatility', provolatile,
    'config', proconfig,
    'public_execute', has_function_privilege('public', oid, 'execute'),
    'anon_execute', has_function_privilege('anon', oid, 'execute'),
    'authenticated_execute', has_function_privilege('authenticated', oid, 'execute')
  ) from target),
  'payload', (select jsonb_build_object(
    'bytes', octet_length(value::text),
    'contract_version', value -> 'contract_version',
    'status', value -> 'status',
    'actor_id', value -> 'actor_id',
    'organization_id', value -> 'organization_id',
    'app_state_version', value #> '{app_state_metadata,version}',
    'collection_counts', jsonb_build_object(
      'profiles', jsonb_array_length(value -> 'profiles'),
      'inventory_categories', jsonb_array_length(value -> 'inventory_categories'),
      'stations', jsonb_array_length(value -> 'stations'),
      'pricing_rules', jsonb_array_length(value -> 'pricing_rules'),
      'inventory_items', jsonb_array_length(value -> 'inventory_items'),
      'sale_variants', jsonb_array_length(value -> 'sale_variants'),
      'combos', jsonb_array_length(value -> 'combos'),
      'sessions', jsonb_array_length(value -> 'sessions'),
      'customer_tabs', jsonb_array_length(value -> 'customer_tabs')
    )
  ) from payload),
  'app_state', (select jsonb_build_object(
    'version', version, 'bytes', octet_length(data::text), 'md5', md5(data::text),
    'updated_at', updated_at, 'updated_by', updated_by
  ) from public.app_state where id = 'primary')
) as evidence;

rollback;
