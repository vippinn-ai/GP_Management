-- Release B staging-only admin inventory precondition proof.
--
-- This script must never be run against production. It uses one existing active
-- staging inventory row, rejects every malformed/missing/stale precondition in
-- a transaction, and rolls back. No inventory, app_state, movement, audit, or
-- event change is committed.
--
-- Captured staging result:
-- 2026-08-20 16:09:27.325935+00 | passed | restored active true | restored role admin

begin;

do $setup$
declare
  v_user_id uuid;
  v_item_id text;
  v_stock numeric;
begin
  select id into v_user_id
  from public.profiles
  where lower(username) = 'vipin' and active = true and role = 'admin'
  order by id
  limit 1;

  select id, stock_qty into v_item_id, v_stock
  from public.inventory_items
  where organization_id = 'org-primary' and active = true
  order by id
  limit 1;

  if v_user_id is null or v_item_id is null then
    raise exception 'Expected active staging admin and inventory fixture were not found.';
  end if;

  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('release_b.item_id', v_item_id, true);
  perform set_config('release_b.stock_qty', v_stock::text, true);
end
$setup$;

set local role authenticated;

do $proof$
declare
  v_actor text := auth.uid()::text;
  v_item_id text := current_setting('release_b.item_id');
  v_stock numeric := current_setting('release_b.stock_qty')::numeric;
  v_label text;
  v_item jsonb;
  v_detail text;
  v_code text;
begin
  foreach v_label in array array[
    'missing', 'null', 'string', 'object', 'array', 'stale-number', 'missing-row'
  ]
  loop
    v_item := jsonb_build_object(
      'id', case when v_label = 'missing-row' then 'release-b-missing-inventory-row' else v_item_id end
    );
    if v_label = 'null' then
      v_item := v_item || jsonb_build_object('expectedStockQty', 'null'::jsonb);
    elsif v_label = 'string' then
      v_item := v_item || jsonb_build_object('expectedStockQty', to_jsonb('stale'::text));
    elsif v_label = 'object' then
      v_item := v_item || jsonb_build_object('expectedStockQty', '{}'::jsonb);
    elsif v_label = 'array' then
      v_item := v_item || jsonb_build_object('expectedStockQty', '[]'::jsonb);
    elsif v_label = 'stale-number' then
      v_item := v_item || jsonb_build_object('expectedStockQty', to_jsonb(v_stock + 1));
    elsif v_label = 'missing-row' then
      v_item := v_item || jsonb_build_object('expectedStockQty', to_jsonb(0));
    end if;

    begin
      perform public.commit_admin_data_change(jsonb_build_object(
        'organization_id', 'org-primary',
        'mutation_id', 'release-b-admin-precondition-' || v_label,
        'mutation_kind', 'commitAdminDataChange',
        'entity_type', 'admin_data',
        'entity_id', 'release-b-admin-precondition',
        'user_id', v_actor,
        'payload', jsonb_build_object('inventoryItems', jsonb_build_array(v_item))
      ));
      raise exception 'Malformed precondition unexpectedly succeeded for %.', v_label;
    exception when others then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_code := case
        when left(ltrim(coalesce(v_detail, '')), 1) = '{'
          then coalesce((v_detail::jsonb)->>'code', '')
        else ''
      end;
      if v_code <> 'inventory_conflict' then
        raise exception 'Expected inventory_conflict for %, received % / %', v_label, v_code, sqlerrm;
      end if;
    end;
  end loop;
end
$proof$;

rollback;
reset role;

select
  clock_timestamp() as completed_at_utc,
  'passed'::text as precondition_checks,
  profiles.active as restored_profile_active,
  profiles.role::text as restored_profile_role
from public.profiles
where lower(username) = 'vipin'
order by profiles.id
limit 1;
