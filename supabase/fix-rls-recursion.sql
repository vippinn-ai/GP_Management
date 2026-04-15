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
