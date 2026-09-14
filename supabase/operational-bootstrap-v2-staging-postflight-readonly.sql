-- Read-only executable postflight for the staging atomic bootstrap RPC.
begin isolation level repeatable read read only;

do $$
declare
  actor_id uuid;
  payload jsonb;
  function_owner text;
  function_security_definer boolean;
  function_volatility "char";
  function_config text[];
  operational_events_rls boolean;
  operational_events_published boolean;
  applicable_select_policies integer;
  access_helper_definition text;
  access_helper_body_md5 text;
  access_helper_owner text;
  access_helper_security_definer boolean;
  access_helper_volatility "char";
  access_helper_config text[];
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
  if md5(replace(replace(btrim(E' \talpha\r\nbeta\rgamma\n ', E' \t\n\r'), E'\r\n', E'\n'), E'\r', E'\n'))
    is distinct from md5(E'alpha\nbeta\ngamma')
  then raise exception 'canonical function-body newline normalization failed'; end if;
  select c.relrowsecurity, exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'operational_events'
  )
  into strict operational_events_rls, operational_events_published
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'operational_events';
  with recursive authenticated_roles(role_oid, role_name) as (
    select role.oid, role.rolname from pg_roles role where role.rolname = 'authenticated'
    union
    select granted_role.oid, granted_role.rolname
    from authenticated_roles inherited_role
    join pg_auth_members membership on membership.member = inherited_role.role_oid
    join pg_roles granted_role on granted_role.oid = membership.roleid
  )
  select count(*) into strict applicable_select_policies
  from pg_policies policy
  where policy.schemaname = 'public' and policy.tablename = 'operational_events'
    and policy.cmd in ('SELECT', 'ALL')
    and exists (
      select 1 from unnest(policy.roles) policy_role
      where lower(policy_role::text) = 'public'
        or lower(policy_role::text) in (select lower(role_name) from authenticated_roles)
    );
  if operational_events_rls is distinct from true
    or operational_events_published is distinct from true
    or applicable_select_policies <> 1
    or not exists (
      select 1 from pg_policies policy
      where policy.schemaname = 'public' and policy.tablename = 'operational_events'
        and policy.cmd in ('SELECT', 'ALL')
        and policy.permissive = 'PERMISSIVE'
        and policy.roles = array['authenticated']::name[]
        and regexp_replace(lower(coalesce(policy.qual, '')), '\s+', '', 'g')
          in (
            'current_user_has_org_access(organization_id)',
            '(current_user_has_org_access(organization_id))',
            'current_user_has_org_access(operational_events.organization_id)',
            '(current_user_has_org_access(operational_events.organization_id))',
            '(selectcurrent_user_has_org_access(operational_events.organization_id)ascurrent_user_has_org_access)'
          )
    )
  then raise exception 'operational_events realtime RLS, publication, or inherited-role policy proof failed'; end if;
  select pg_get_functiondef(helper.oid),
    md5(replace(replace(btrim(helper.prosrc, E' \t\n\r'), E'\r\n', E'\n'), E'\r', E'\n')),
    pg_get_userbyid(helper.proowner), helper.prosecdef, helper.provolatile, helper.proconfig
  into strict access_helper_definition, access_helper_body_md5, access_helper_owner,
    access_helper_security_definer, access_helper_volatility, access_helper_config
  from pg_proc helper
  where helper.oid = 'public.current_user_has_org_access(text)'::regprocedure;
  if access_helper_body_md5 is distinct from '1582c0fa10f3c451fee64540e43de6f7'
    or access_helper_owner is distinct from current_user
    or access_helper_security_definer is distinct from true
    or access_helper_volatility is distinct from 'v'
    or access_helper_definition !~* 'organization_members'
    or access_helper_definition !~* 'auth\.uid'
    or access_helper_definition !~* 'active[[:space:]]*=[[:space:]]*true'
    or to_jsonb(access_helper_config) is distinct from '["search_path=public"]'::jsonb
    or exists (
      select 1
      from pg_proc helper
      cross join lateral aclexplode(coalesce(helper.proacl, acldefault('f', helper.proowner))) acl
      where helper.oid = 'public.current_user_has_org_access(text)'::regprocedure
        and (
          (case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end
            not in (access_helper_owner, 'authenticated', 'PUBLIC')
            and not (
              (case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end)
                in ('anon', 'service_role')
              and exists (
                select 1
                from pg_proc public_helper
                cross join lateral aclexplode(coalesce(public_helper.proacl, acldefault('f', public_helper.proowner))) public_acl
                where public_helper.oid = 'public.current_user_has_org_access(text)'::regprocedure
                  and public_acl.grantee = 0
                  and public_acl.privilege_type = 'EXECUTE'
                  and not public_acl.is_grantable
              )
            ))
          or acl.privilege_type <> 'EXECUTE'
          or acl.is_grantable
        )
    )
    or not exists (
      select 1
      from pg_proc helper
      cross join lateral aclexplode(coalesce(helper.proacl, acldefault('f', helper.proowner))) acl
      where helper.oid = 'public.current_user_has_org_access(text)'::regprocedure
        and pg_get_userbyid(acl.grantee) = access_helper_owner
        and acl.privilege_type = 'EXECUTE' and not acl.is_grantable
    )
    or not exists (
      select 1
      from pg_proc helper
      cross join lateral aclexplode(coalesce(helper.proacl, acldefault('f', helper.proowner))) acl
      where helper.oid = 'public.current_user_has_org_access(text)'::regprocedure
        and pg_get_userbyid(acl.grantee) = 'authenticated'
        and acl.privilege_type = 'EXECUTE' and not acl.is_grantable
    )
  then raise exception 'organization access helper identity or ACL proof failed'; end if;
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
  select pg_get_userbyid(p.proowner), p.prosecdef, p.provolatile, p.proconfig
  into strict function_owner, function_security_definer, function_volatility, function_config
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'load_operational_bootstrap_v2'
    and pg_get_function_identity_arguments(p.oid) = '';
  if function_security_definer is distinct from true
    or function_volatility is distinct from 's'
    or to_jsonb(function_config) is distinct from '["search_path=pg_catalog","statement_timeout=5s"]'::jsonb
    or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where n.nspname = 'public' and p.proname = 'load_operational_bootstrap_v2'
        and pg_get_function_identity_arguments(p.oid) = '') <> 2
    or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where n.nspname = 'public' and p.proname = 'load_operational_bootstrap_v2'
        and pg_get_function_identity_arguments(p.oid) = ''
        and (case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end
          not in (function_owner, 'authenticated')
          or acl.privilege_type <> 'EXECUTE' or acl.is_grantable))
    or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where n.nspname = 'public' and p.proname = 'load_operational_bootstrap_v2'
        and pg_get_function_identity_arguments(p.oid) = ''
        and pg_get_userbyid(acl.grantee) = function_owner and acl.privilege_type = 'EXECUTE' and not acl.is_grantable)
    or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where n.nspname = 'public' and p.proname = 'load_operational_bootstrap_v2'
        and pg_get_function_identity_arguments(p.oid) = ''
        and pg_get_userbyid(acl.grantee) = 'authenticated' and acl.privilege_type = 'EXECUTE' and not acl.is_grantable)
  then raise exception 'bootstrap owner, security mode, configuration, or exact ACL mismatch'; end if;
  perform set_config('normops.bootstrap_postflight_payload', payload::text, true);
end $$;

with recursive target as (
  select p.* from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'load_operational_bootstrap_v2'
    and pg_get_function_identity_arguments(p.oid) = ''
), authenticated_roles(role_oid, role_name) as (
  select role.oid, role.rolname from pg_roles role where role.rolname = 'authenticated'
  union
  select granted_role.oid, granted_role.rolname
  from authenticated_roles inherited_role
  join pg_auth_members membership on membership.member = inherited_role.role_oid
  join pg_roles granted_role on granted_role.oid = membership.roleid
), access_helper as (
  select helper.* from pg_proc helper
  where helper.oid = 'public.current_user_has_org_access(text)'::regprocedure
), payload as (
  select current_setting('normops.bootstrap_postflight_payload')::jsonb value
)
select jsonb_build_object(
  'project_ref', 'tkbdyzxwwbhkpztgjjxh',
  'system_identifier', (select system_identifier::text from pg_control_system()),
  'captured_at_utc', timezone('utc', clock_timestamp()),
  'function', (select jsonb_build_object(
    'definition_md5', md5(pg_get_functiondef(oid)),
    'body_md5', md5(replace(replace(btrim(prosrc, E' \t\n\r'), E'\r\n', E'\n'), E'\r', E'\n')),
    'owner', pg_get_userbyid(proowner),
    'security_definer', prosecdef,
    'volatility', provolatile,
    'config', proconfig,
    'public_execute', has_function_privilege('public', oid, 'execute'),
    'anon_execute', has_function_privilege('anon', oid, 'execute'),
    'service_role_execute', has_function_privilege('service_role', oid, 'execute'),
    'authenticated_execute', has_function_privilege('authenticated', oid, 'execute'),
    'acl_detail', (
      select jsonb_agg(jsonb_build_object(
        'grantor', case when acl.grantor = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantor) end,
        'grantee', case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
        'privilege_type', acl.privilege_type,
        'is_grantable', acl.is_grantable
      ) order by acl.grantee, acl.privilege_type)
      from aclexplode(coalesce(proacl, acldefault('f', proowner))) acl
    )
  ) from target),
  'realtime_security', jsonb_build_object(
    'rls_enabled', (
      select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'operational_events'
    ),
    'published', exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'operational_events'
    ),
    'authenticated_role_memberships', (
      select jsonb_agg(role_name order by role_name) from authenticated_roles
    ),
    'policies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', policyname, 'permissive', permissive, 'roles', roles,
        'command', cmd, 'using', qual, 'check', with_check
      ) order by policyname)
      from pg_policies
      where schemaname = 'public' and tablename = 'operational_events'
    ), '[]'::jsonb),
    'access_helper', (select jsonb_build_object(
      'definition_md5', md5(pg_get_functiondef(oid)),
      'body_md5', md5(replace(replace(btrim(prosrc, E' \t\n\r'), E'\r\n', E'\n'), E'\r', E'\n')),
      'owner_name', pg_get_userbyid(proowner),
      'security_definer', prosecdef,
      'volatility', provolatile,
      'config', proconfig,
      'acl_detail', (
        select jsonb_agg(jsonb_build_object(
          'grantor', case when acl.grantor = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantor) end,
          'grantee', case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
          'privilege_type', acl.privilege_type,
          'is_grantable', acl.is_grantable
        ) order by acl.grantee, acl.privilege_type)
        from aclexplode(coalesce(access_helper.proacl, acldefault('f', access_helper.proowner))) acl
      )
    ) from access_helper)
  ),
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
