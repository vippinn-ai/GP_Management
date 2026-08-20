-- Release B staging-only inactive-user authorization proof.
--
-- This script must never be run against production. It temporarily marks the
-- active staging `vipin` profile inactive inside a transaction. The existing
-- profile trigger synchronizes that state to organization_members. Both real
-- financial v2 entry points must reject the authenticated actor before domain
-- validation. The transaction is then rolled back and both active flags are
-- verified as restored. It contains no credentials and creates no financial
-- rows.
--
-- Captured staging result on 2026-08-20 after the rollback and role reset:
-- completed_at_utc              | authorization_checks | restored_profile_active | restored_membership_active | restored_profile_role | restored_membership_role
-- 2026-08-20 15:48:29.8673+00  | passed               | true                    | true                       | admin                 | admin

begin;

do $setup$
declare
  v_user_id uuid;
begin
  select id into v_user_id
  from public.profiles
  where lower(username) = 'vipin' and active = true and role = 'admin'
  order by id
  limit 1;

  if v_user_id is null then
    raise exception 'Expected active staging admin profile was not found.';
  end if;

  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  update public.profiles set active = false where id = v_user_id;

  if exists (
    select 1
    from public.organization_members
    where organization_id = 'org-primary'
      and user_id = v_user_id
      and active = true
  ) then
    raise exception 'Profile trigger did not deactivate the organization membership.';
  end if;

  if public.current_user_has_org_access('org-primary') then
    raise exception 'Inactive staging actor still has organization access.';
  end if;
end
$setup$;

set local role authenticated;

do $proof$
declare
  v_detail text;
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Transactional authenticated identity was not established.';
  end if;

  begin
    perform public.commit_checkout_bill_v2(jsonb_build_object(
      'organization_id', 'org-primary',
      'mutation_id', 'release-b-inactive-checkout',
      'mutation_kind', 'commitCheckoutBill',
      'entity_type', 'session',
      'entity_id', 'release-b-inactive-checkout',
      'payload', jsonb_build_object('mode', 'session')
    ));
    raise exception 'Inactive checkout unexpectedly succeeded.';
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    v_code := coalesce((nullif(v_detail, '')::jsonb)->>'code', '');
    if v_code <> 'organization_access_denied' then
      raise exception 'Expected organization_access_denied for inactive checkout, received % / %', v_code, sqlerrm;
    end if;
  end;

  begin
    perform public.commit_financial_adjustment_v2(jsonb_build_object(
      'organization_id', 'org-primary',
      'mutation_id', 'release-b-inactive-adjustment',
      'mutation_kind', 'settlePendingBills',
      'entity_type', 'bill',
      'entity_id', 'release-b-inactive-adjustment',
      'payload', jsonb_build_object(
        'bill_updates', jsonb_build_array(jsonb_build_object('id', 'release-b-inactive-adjustment')),
        'bill_expectations', jsonb_build_array(jsonb_build_object(
          'billId', 'release-b-inactive-adjustment',
          'expectedStatus', 'pending',
          'expectedAmountPaid', 0,
          'expectedAmountDue', 1
        ))
      )
    ));
    raise exception 'Inactive adjustment unexpectedly succeeded.';
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    v_code := coalesce((nullif(v_detail, '')::jsonb)->>'code', '');
    if v_code <> 'organization_access_denied' then
      raise exception 'Expected organization_access_denied for inactive adjustment, received % / %', v_code, sqlerrm;
    end if;
  end;
end
$proof$;

rollback;
reset role;

select
  clock_timestamp() as completed_at_utc,
  'passed'::text as authorization_checks,
  profiles.active as restored_profile_active,
  organization_members.active as restored_membership_active,
  profiles.role::text as restored_profile_role,
  organization_members.role::text as restored_membership_role
from public.profiles
join public.organization_members
  on organization_members.organization_id = 'org-primary'
 and organization_members.user_id = profiles.id
where lower(profiles.username) = 'vipin'
order by profiles.id
limit 1;
