-- One-time staging identity anchor. This refuses to initialize unless the
-- database's own Supabase API URL names project tkbdyzxwwbhkpztgjjxh.
begin;

do $$
declare api_url text := current_setting('app.settings.api_url', true);
begin
  if api_url is null or position('tkbdyzxwwbhkpztgjjxh' in api_url) = 0 then
    raise exception 'database API URL does not identify the approved staging project';
  end if;
end $$;

create table if not exists public.deployment_environment_identity (
  environment text primary key,
  project_ref text not null unique,
  identity_nonce uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default timezone('utc', now()),
  constraint deployment_environment_identity_environment_check check (environment in ('staging', 'production'))
);

alter table public.deployment_environment_identity enable row level security;
revoke all on table public.deployment_environment_identity from public, anon, authenticated;

do $$
begin
  if exists (
    select 1 from public.deployment_environment_identity
    where environment <> 'staging' or project_ref <> 'tkbdyzxwwbhkpztgjjxh'
  ) then
    raise exception 'database already carries a different environment identity';
  end if;

  insert into public.deployment_environment_identity(environment, project_ref)
  values ('staging', 'tkbdyzxwwbhkpztgjjxh')
  on conflict (environment) do nothing;
end $$;

commit;
