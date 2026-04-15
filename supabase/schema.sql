create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('admin', 'manager', 'receptionist');
  end if;
end
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  auth_email text not null unique,
  name text not null,
  role public.app_role not null,
  active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.app_state (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by uuid references public.profiles (id)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.current_profile_is_active()
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce(
    (
      select profiles.active
      from public.profiles
      where profiles.id = auth.uid()
    ),
    false
  );
$$;

create or replace function public.current_profile_role()
returns public.app_role
language sql
security definer
set search_path = public
as $$
  select profiles.role
  from public.profiles
  where profiles.id = auth.uid()
    and profiles.active = true;
$$;

grant execute on function public.current_profile_is_active() to authenticated;
grant execute on function public.current_profile_role() to authenticated;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute procedure public.set_updated_at();

drop trigger if exists app_state_set_updated_at on public.app_state;
create trigger app_state_set_updated_at
before update on public.app_state
for each row execute procedure public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.app_state enable row level security;

drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
on public.profiles
for select
to authenticated
using (public.current_profile_is_active());

drop policy if exists "app_state_select_authenticated" on public.app_state;
create policy "app_state_select_authenticated"
on public.app_state
for select
to authenticated
using (public.current_profile_is_active());

drop policy if exists "app_state_update_authenticated" on public.app_state;
create policy "app_state_update_authenticated"
on public.app_state
for all
to authenticated
using (public.current_profile_is_active())
with check (public.current_profile_is_active());

insert into public.app_state (id, data)
values ('primary', '{}'::jsonb)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'app_state'
  ) then
    alter publication supabase_realtime add table public.app_state;
  end if;
end
$$;
