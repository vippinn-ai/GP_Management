-- One-time staging database setting bootstrap.
--
-- OPERATOR PRECONDITION (fail closed): execute this file only while the
-- Supabase SQL Editor URL is exactly:
-- https://supabase.com/dashboard/project/tkbdyzxwwbhkpztgjjxh/sql/new
--
-- Hosted Supabase does not guarantee that app.settings.api_url is predefined.
-- This script persists the approved staging URL as a database-specific custom
-- setting so every later install, proof, rollback, and postflight can verify a
-- database-owned project identity. It never changes application/domain rows.

do $$
declare existing_api_url text := nullif(current_setting('app.settings.api_url', true), '');
begin
  if current_database() <> 'postgres' then
    raise exception 'staging API URL anchor requires the postgres database';
  end if;
  if not exists(select 1 from public.organizations where id='org-primary' and active is true) then
    raise exception 'staging organization identity failed';
  end if;
  if existing_api_url is not null and existing_api_url <> 'https://tkbdyzxwwbhkpztgjjxh.supabase.co' then
    raise exception 'database already carries a different API URL identity';
  end if;
  if to_regclass('public.deployment_environment_identity') is not null
    and exists(
      select 1 from public.deployment_environment_identity
      where environment <> 'staging' or project_ref <> 'tkbdyzxwwbhkpztgjjxh'
    )
  then raise exception 'database already carries a different environment identity'; end if;
end $$;

-- ALTER DATABASE ... SET cannot run inside a transaction block. PostgreSQL
-- applies it only to new sessions; set_config also anchors this SQL-editor
-- session so the immediately following identity installation can verify it.
-- If execution is interrupted after ALTER DATABASE, rerun this exact file:
-- the exact-match guard makes that recovery idempotent and no domain row has
-- been changed.
alter database postgres set "app.settings.api_url" to 'https://tkbdyzxwwbhkpztgjjxh.supabase.co';
select set_config('app.settings.api_url', 'https://tkbdyzxwwbhkpztgjjxh.supabase.co', false);

select jsonb_build_object(
  'expected_project_ref', 'tkbdyzxwwbhkpztgjjxh',
  'database', current_database(),
  'api_url_setting', current_setting('app.settings.api_url', true),
  'organization_exists', exists(select 1 from public.organizations where id='org-primary' and active is true),
  'identity_table', to_regclass('public.deployment_environment_identity'),
  'anchored_at_utc', timezone('utc', clock_timestamp())
) as staging_api_url_anchor;
