-- Phase 1 follow-up: keep default organization membership in sync with profiles.
--
-- Run this in staging after phase1-normalized-schema.sql when normalized reads/RPCs
-- are enabled. It is idempotent and safe to rerun.

create or replace function public.sync_org_primary_member_from_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.organizations
    where organizations.id = 'org-primary'
  ) then
    insert into public.organization_members (organization_id, user_id, role, active)
    values ('org-primary', new.id, new.role, new.active)
    on conflict (organization_id, user_id) do update
    set
      role = excluded.role,
      active = excluded.active,
      updated_at = timezone('utc', now());
  end if;

  return new;
end;
$$;

revoke all on function public.sync_org_primary_member_from_profile() from public;

drop trigger if exists profiles_sync_org_primary_member on public.profiles;

create trigger profiles_sync_org_primary_member
after insert or update of role, active on public.profiles
for each row
execute function public.sync_org_primary_member_from_profile();

insert into public.organization_members (organization_id, user_id, role, active)
select
  'org-primary',
  profiles.id,
  profiles.role,
  profiles.active
from public.profiles
where exists (
  select 1
  from public.organizations
  where organizations.id = 'org-primary'
)
on conflict (organization_id, user_id) do update
set
  role = excluded.role,
  active = excluded.active,
  updated_at = timezone('utc', now());

select
  'organization_members_synced' as check_name,
  count(*) filter (where organization_members.user_id is null) as missing_membership_count,
  count(*) filter (where organization_members.user_id is not null) as synced_membership_count
from public.profiles
left join public.organization_members
  on organization_members.organization_id = 'org-primary'
 and organization_members.user_id = profiles.id;
