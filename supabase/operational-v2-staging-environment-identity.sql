-- One-time staging identity anchor. The PostgreSQL system identifier is tied
-- to this exact physical staging cluster and remains stable across restarts.
begin;

do $$
declare system_id text := (select system_identifier::text from pg_control_system());
begin
  if current_database() <> 'postgres' then raise exception 'staging identity requires the postgres database'; end if;
  if system_id <> '7623125441096521075' then raise exception 'physical database is not the approved staging cluster'; end if;
  if not exists(select 1 from public.organizations where id='org-primary' and active is true)
  then raise exception 'staging organization identity failed'; end if;
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
