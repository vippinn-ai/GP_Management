-- One-time staging identity anchor. Run only while the SQL-editor URL visibly shows
-- project tkbdyzxwwbhkpztgjjxh. Later preflights bind every artifact to this DB row.
begin;

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
