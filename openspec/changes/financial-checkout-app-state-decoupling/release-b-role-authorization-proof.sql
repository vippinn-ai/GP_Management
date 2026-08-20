-- Release B staging-only authorization proof.
--
-- This script must never be run against production. It temporarily changes the
-- active staging `vipin` user to receptionist inside a transaction, exercises
-- the real financial v2 authorization boundary, and rolls the entire change
-- back. It contains no credentials and creates no financial rows.
--
-- Captured staging result on 2026-08-20 after the post-rollback role reset:
-- completed_at_utc                 | authorization_checks | restored_profile_role | restored_membership_role
-- 2026-08-20 15:21:58.452954+00   | passed               | admin                 | admin

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

  update public.profiles set role = 'receptionist' where id = v_user_id;

  if public.current_user_org_role('org-primary') is not null then
    raise exception 'JWT actor must not be set before the authorization probe.';
  end if;

  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end
$setup$;

set local role authenticated;

do $proof$
declare
  v_kind text;
  v_detail text;
  v_code text;
  v_replacement_bill jsonb := jsonb_build_object(
    'id', 'release-b-role-replacement',
    'billNumber', 'RELEASE-B-ROLE-REPLACEMENT'
  );
begin
  if auth.uid() is null
    or public.current_user_org_role('org-primary') <> 'receptionist'::public.app_role
  then
    raise exception 'Transactional receptionist identity was not established.';
  end if;

  foreach v_kind in array array['writeOffPendingBills', 'voidBill', 'refundBill'] loop
    begin
      perform public.commit_financial_adjustment_v2(jsonb_build_object(
        'organization_id', 'org-primary',
        'mutation_id', 'release-b-role-' || v_kind,
        'mutation_kind', v_kind,
        'entity_type', 'bill',
        'entity_id', 'release-b-role-check',
        'payload', jsonb_build_object(
          'bill_updates', jsonb_build_array(jsonb_build_object('id', 'release-b-role-check'))
        )
      ));
      raise exception 'Restricted adjustment unexpectedly succeeded.';
    exception when others then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_code := coalesce((nullif(v_detail, '')::jsonb)->>'code', '');
      if v_code <> 'role_access_denied' then
        raise exception 'Expected role_access_denied for %, received % / %', v_kind, v_code, sqlerrm;
      end if;
    end;
  end loop;

  begin
    perform public.commit_checkout_bill_v2(jsonb_build_object(
      'organization_id', 'org-primary',
      'mutation_id', 'release-b-role-bill-replacement',
      'mutation_kind', 'commitCheckoutBill',
      'entity_type', 'bill',
      'entity_id', 'release-b-role-check',
      'payload', jsonb_build_object(
        'mode', 'bill_replacement',
        'primary_bill', v_replacement_bill,
        'bill_updates', jsonb_build_array(v_replacement_bill)
      )
    ));
    raise exception 'Restricted replacement unexpectedly succeeded.';
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    v_code := coalesce((nullif(v_detail, '')::jsonb)->>'code', '');
    if v_code <> 'role_access_denied' then
      raise exception 'Expected role_access_denied for replacement, received % / %', v_code, sqlerrm;
    end if;
  end;

  begin
    perform public.commit_financial_adjustment_v2(jsonb_build_object(
      'organization_id', 'org-primary',
      'mutation_id', 'release-b-role-settlement',
      'mutation_kind', 'settlePendingBills',
      'entity_type', 'bill',
      'entity_id', 'release-b-role-check',
      'payload', jsonb_build_object(
        'bill_updates', jsonb_build_array(jsonb_build_object('id', 'release-b-role-check')),
        'bill_expectations', jsonb_build_array(jsonb_build_object(
          'billId', 'release-b-role-check',
          'expectedStatus', 'pending',
          'expectedAmountPaid', 0,
          'expectedAmountDue', 1
        ))
      )
    ));
    raise exception 'Settlement domain probe unexpectedly succeeded.';
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    v_code := coalesce((nullif(v_detail, '')::jsonb)->>'code', '');
    if v_code = 'role_access_denied' then
      raise exception 'Receptionist settlement was incorrectly role-denied.';
    end if;
    if sqlerrm = 'Settlement domain probe unexpectedly succeeded.' then
      raise;
    end if;
  end;
end
$proof$;

rollback;
reset role;

select
  clock_timestamp() as completed_at_utc,
  'passed'::text as authorization_checks,
  role::text as restored_profile_role,
  (
    select role::text from public.organization_members
    where organization_id = 'org-primary' and user_id = profiles.id
  ) as restored_membership_role
from public.profiles
where lower(username) = 'vipin' and active = true
order by id
limit 1;
