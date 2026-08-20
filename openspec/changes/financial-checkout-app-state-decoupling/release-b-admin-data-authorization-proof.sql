-- Release B staging-only admin-data authorization proof.
--
-- This script must never be run against production. It temporarily changes the
-- active staging `vipin` user to receptionist and manager inside one transaction,
-- proves both roles are denied inventory mutation, proves a manager can still
-- create an expense and customer through the same RPC, and rolls everything back.
-- No inventory, expense, customer, audit, event, profile, membership, or app_state
-- change is committed.
--
-- Captured staging result:
-- 2026-08-20 16:20:01.646769+00 | passed | restored active true | profile admin | membership admin
-- Post-rollback verification at 2026-08-20 16:20:25.782312+00 found no fixture
-- expense, customer, audit, event, or app_state content.

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
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('release_b.actor_id', v_user_id::text, true);
end
$setup$;

set local role authenticated;

do $receptionist_proof$
declare
  v_actor text := auth.uid()::text;
  v_detail text;
  v_code text;
begin
  if public.current_user_org_role('org-primary') <> 'receptionist'::public.app_role then
    raise exception 'Transactional receptionist identity was not established.';
  end if;

  begin
    perform public.commit_admin_data_change(jsonb_build_object(
      'organization_id', 'org-primary',
      'mutation_id', 'release-b-receptionist-inventory-denial',
      'mutation_kind', 'commitAdminDataChange',
      'entity_type', 'admin_data',
      'entity_id', 'release-b-receptionist-inventory-denial',
      'user_id', v_actor,
      'payload', jsonb_build_object(
        'inventoryItems', jsonb_build_array(jsonb_build_object(
          'id', 'release-b-receptionist-inventory-probe',
          'stockQty', 0
        ))
      )
    ));
    raise exception 'Receptionist inventory mutation unexpectedly succeeded.';
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    v_code := case
      when left(ltrim(coalesce(v_detail, '')), 1) = '{'
        then coalesce((v_detail::jsonb)->>'code', '')
      else ''
    end;
    if v_code <> 'role_access_denied' then
      raise exception 'Expected receptionist role_access_denied, received % / %', v_code, sqlerrm;
    end if;
  end;
end
$receptionist_proof$;

reset role;

update public.profiles
set role = 'manager'
where id = current_setting('release_b.actor_id')::uuid;

set local role authenticated;

do $manager_proof$
declare
  v_actor text := auth.uid()::text;
  v_expense_id text := 'expense-release-b-manager-authorization';
  v_customer_id text := 'customer-release-b-manager-authorization';
  v_audit_id text := 'audit-release-b-manager-authorization';
  v_detail text;
  v_code text;
  v_result jsonb;
begin
  if public.current_user_org_role('org-primary') <> 'manager'::public.app_role then
    raise exception 'Transactional manager identity was not established.';
  end if;

  begin
    perform public.commit_admin_data_change(jsonb_build_object(
      'organization_id', 'org-primary',
      'mutation_id', 'release-b-manager-inventory-denial',
      'mutation_kind', 'commitAdminDataChange',
      'entity_type', 'admin_data',
      'entity_id', 'release-b-manager-inventory-denial',
      'user_id', v_actor,
      'payload', jsonb_build_object(
        'inventoryItems', jsonb_build_array(jsonb_build_object(
          'id', 'release-b-manager-inventory-probe',
          'stockQty', 0
        ))
      )
    ));
    raise exception 'Manager inventory mutation unexpectedly succeeded.';
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    v_code := case
      when left(ltrim(coalesce(v_detail, '')), 1) = '{'
        then coalesce((v_detail::jsonb)->>'code', '')
      else ''
    end;
    if v_code <> 'role_access_denied' then
      raise exception 'Expected manager role_access_denied, received % / %', v_code, sqlerrm;
    end if;
  end;

  v_result := public.commit_admin_data_change(jsonb_build_object(
    'organization_id', 'org-primary',
    'mutation_id', 'release-b-manager-expense-customer-success',
    'mutation_kind', 'commitAdminDataChange',
    'entity_type', 'admin_data',
    'entity_id', 'release-b-manager-expense-customer-success',
    'user_id', v_actor,
    'payload', jsonb_build_object(
      'expenses', jsonb_build_array(jsonb_build_object(
        'id', v_expense_id,
        'title', 'Release B manager authorization expense',
        'category', 'QA',
        'amount', 1,
        'paymentMode', 'cash',
        'cashAmount', 1,
        'upiAmount', 0,
        'spentAt', clock_timestamp(),
        'notes', 'Rollback-only authorization proof',
        'createdByUserId', v_actor
      )),
      'customers', jsonb_build_array(jsonb_build_object(
        'id', v_customer_id,
        'name', 'Release B Manager Authorization',
        'phone', '0000000000',
        'createdAt', clock_timestamp(),
        'lastVisitAt', clock_timestamp(),
        'notes', 'Rollback-only authorization proof'
      )),
      'auditLogs', jsonb_build_array(jsonb_build_object(
        'id', v_audit_id,
        'action', 'expense_created',
        'entityType', 'expense',
        'entityId', v_expense_id,
        'message', 'Release B rollback-only manager expense proof',
        'createdAt', clock_timestamp(),
        'userId', 'spoofed-audit-actor'
      ))
    )
  ));

  if not exists (
    select 1 from public.expenses
    where organization_id = 'org-primary'
      and id = v_expense_id
      and created_by_user_id = v_actor
  ) then
    raise exception 'Manager expense mutation did not persist with the authenticated actor.';
  end if;

  if not exists (
    select 1 from public.customers
    where organization_id = 'org-primary' and id = v_customer_id
  ) then
    raise exception 'Manager customer mutation did not persist inside the proof transaction.';
  end if;

  if not exists (
    select 1 from public.audit_logs
    where organization_id = 'org-primary'
      and id = v_audit_id
      and user_id = v_actor
  ) then
    raise exception 'Manager audit row was not stamped with the authenticated actor.';
  end if;

  if not exists (
    select 1 from public.operational_events
    where organization_id = 'org-primary'
      and id = v_result->>'event_id'
      and created_by = v_actor
      and metadata->'changed_rows'->'expenses' ? v_expense_id
      and metadata->'changed_rows'->'customers' ? v_customer_id
  ) then
    raise exception 'Manager operational event or changed-row attribution is incomplete.';
  end if;

  if not exists (
    select 1 from public.app_state
    where id = 'primary'
      and data->'expenses' @> jsonb_build_array(jsonb_build_object('id', v_expense_id))
      and data->'customers' @> jsonb_build_array(jsonb_build_object('id', v_customer_id))
  ) then
    raise exception 'Manager compatibility snapshot was not updated inside the proof transaction.';
  end if;
end
$manager_proof$;

rollback;
reset role;

select
  clock_timestamp() as completed_at_utc,
  'passed'::text as authorization_checks,
  profiles.active as restored_profile_active,
  profiles.role::text as restored_profile_role,
  (
    select role::text from public.organization_members
    where organization_id = 'org-primary' and user_id = profiles.id
  ) as restored_membership_role,
  not exists (
    select 1 from public.expenses
    where organization_id = 'org-primary' and id = 'expense-release-b-manager-authorization'
  ) as expense_rolled_back,
  not exists (
    select 1 from public.customers
    where organization_id = 'org-primary' and id = 'customer-release-b-manager-authorization'
  ) as customer_rolled_back
from public.profiles
where lower(username) = 'vipin' and active = true
order by id
limit 1;
