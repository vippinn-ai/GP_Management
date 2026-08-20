-- Release B staging-only admin inventory precondition proof.
--
-- This script must never be run against production. It uses one existing active
-- staging inventory row, rejects every malformed/missing/stale precondition in
-- a transaction, and rolls back. No inventory, app_state, movement, audit, or
-- event change is committed.

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
  v_case jsonb;
  v_item jsonb;
  v_detail text;
  v_code text;
begin
  for v_case in
    select value
    from jsonb_array_elements(jsonb_build_array(
      jsonb_build_object('label', 'missing', 'include', false),
      jsonb_build_object('label', 'null', 'include', true, 'value', 'null'::jsonb),
      jsonb_build_object('label', 'string', 'include', true, 'value', to_jsonb('stale'::text)),
      jsonb_build_object('label', 'object', 'include', true, 'value', '{}'::jsonb),
      jsonb_build_object('label', 'array', 'include', true, 'value', '[]'::jsonb),
      jsonb_build_object('label', 'stale-number', 'include', true, 'value', to_jsonb(v_stock + 1)),
      jsonb_build_object('label', 'missing-row', 'include', true, 'value', to_jsonb(0))
    ))
  loop
    v_item := jsonb_build_object(
      'id', case when v_case->>'label' = 'missing-row' then 'release-b-missing-inventory-row' else v_item_id end
    );
    if (v_case->>'include')::boolean then
      v_item := v_item || jsonb_build_object('expectedStockQty', v_case->'value');
    end if;

    begin
      perform public.commit_admin_data_change(jsonb_build_object(
        'organization_id', 'org-primary',
        'mutation_id', 'release-b-admin-precondition-' || v_case->>'label',
        'mutation_kind', 'commitAdminDataChange',
        'entity_type', 'admin_data',
        'entity_id', 'release-b-admin-precondition',
        'user_id', v_actor,
        'payload', jsonb_build_object('inventoryItems', jsonb_build_array(v_item))
      ));
      raise exception 'Malformed precondition unexpectedly succeeded for %.', v_case->>'label';
    exception when others then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_code := coalesce((nullif(v_detail, '')::jsonb)->>'code', '');
      if v_code <> 'inventory_conflict' then
        raise exception 'Expected inventory_conflict for %, received % / %', v_case->>'label', v_code, sqlerrm;
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
