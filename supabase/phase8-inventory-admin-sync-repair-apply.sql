-- Phase 8 inventory admin sync repair apply.
-- Mutating. Run only after phase8-inventory-admin-sync-repair-preview.sql has been reviewed.
-- This syncs normalized inventory/catalog rows from app_state. It does not modify bills,
-- payments, sessions, customer tabs, or current open reservations.

begin;

do $$
begin
  if not exists (select 1 from public.app_state where id = 'primary') then
    raise exception 'Cannot apply inventory admin sync repair: app_state primary row is missing.';
  end if;
end $$;

with state as (
  select data
  from public.app_state
  where id = 'primary'
),
categories as (
  select distinct nullif(trim(value), '') as name
  from state
  cross join lateral jsonb_array_elements_text(coalesce(data->'inventoryCategories', '[]'::jsonb)) as category_values(value)
)
insert into public.inventory_categories (organization_id, id, name, updated_at)
select
  'org-primary',
  'category-' || md5(name),
  name,
  timezone('utc', now())
from categories
where name is not null
on conflict (organization_id, id) do update
set
  name = excluded.name,
  updated_at = timezone('utc', now());

with state as (
  select data
  from public.app_state
  where id = 'primary'
),
app_inventory as (
  select item
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
  where item ? 'id'
)
insert into public.inventory_items (
  organization_id,
  id,
  name,
  category,
  price,
  stock_qty,
  low_stock_threshold,
  unit,
  is_reusable,
  barcode,
  active,
  archived_at,
  archived_by_user_id,
  archive_reason,
  sell_base_item,
  cigarette_pack,
  raw_data,
  updated_at
)
select
  'org-primary',
  item->>'id',
  coalesce(nullif(item->>'name', ''), 'Unnamed item'),
  nullif(item->>'category', ''),
  coalesce(nullif(item->>'price', '')::numeric, 0),
  coalesce(nullif(item->>'stockQty', '')::numeric, 0),
  coalesce(nullif(item->>'lowStockThreshold', '')::numeric, 0),
  coalesce(nullif(item->>'unit', ''), 'piece'),
  coalesce(nullif(item->>'isReusable', '')::boolean, false),
  nullif(item->>'barcode', ''),
  coalesce(nullif(item->>'active', '')::boolean, true),
  nullif(item->>'archivedAt', '')::timestamptz,
  nullif(item->>'archivedByUserId', ''),
  nullif(item->>'archiveReason', ''),
  coalesce(nullif(item->>'sellBaseItem', '')::boolean, true),
  item->'cigarettePack',
  item,
  timezone('utc', now())
from app_inventory
on conflict (organization_id, id) do update
set
  name = excluded.name,
  category = excluded.category,
  price = excluded.price,
  stock_qty = excluded.stock_qty,
  low_stock_threshold = excluded.low_stock_threshold,
  unit = excluded.unit,
  is_reusable = excluded.is_reusable,
  barcode = excluded.barcode,
  active = excluded.active,
  archived_at = excluded.archived_at,
  archived_by_user_id = excluded.archived_by_user_id,
  archive_reason = excluded.archive_reason,
  sell_base_item = excluded.sell_base_item,
  cigarette_pack = excluded.cigarette_pack,
  raw_data = excluded.raw_data,
  updated_at = timezone('utc', now());

with state as (
  select data
  from public.app_state
  where id = 'primary'
),
app_inventory_ids as (
  select item->>'id' as id
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
  where item ? 'id'
),
app_variants as (
  select
    item->>'id' as inventory_item_id,
    variant->>'id' as id
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
  cross join lateral jsonb_array_elements(coalesce(item->'saleVariants', '[]'::jsonb)) as variant
  where item ? 'id'
    and variant ? 'id'
)
delete from public.sale_variants
where sale_variants.organization_id = 'org-primary'
  and sale_variants.inventory_item_id in (select id from app_inventory_ids)
  and not exists (
    select 1
    from app_variants
    where app_variants.inventory_item_id = sale_variants.inventory_item_id
      and app_variants.id = sale_variants.id
  );

with state as (
  select data
  from public.app_state
  where id = 'primary'
),
app_variants as (
  select
    item->>'id' as inventory_item_id,
    variant
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
  cross join lateral jsonb_array_elements(coalesce(item->'saleVariants', '[]'::jsonb)) as variant
  where item ? 'id'
    and variant ? 'id'
)
insert into public.sale_variants (
  organization_id,
  inventory_item_id,
  id,
  name,
  price,
  stock_units_per_sale,
  barcode,
  active,
  raw_data,
  updated_at
)
select
  'org-primary',
  inventory_item_id,
  variant->>'id',
  coalesce(nullif(variant->>'name', ''), 'Unnamed variant'),
  coalesce(nullif(variant->>'price', '')::numeric, 0),
  coalesce(nullif(variant->>'stockUnitsPerSale', '')::numeric, 1),
  nullif(variant->>'barcode', ''),
  coalesce(nullif(variant->>'active', '')::boolean, true),
  variant,
  timezone('utc', now())
from app_variants
on conflict (organization_id, inventory_item_id, id) do update
set
  name = excluded.name,
  price = excluded.price,
  stock_units_per_sale = excluded.stock_units_per_sale,
  barcode = excluded.barcode,
  active = excluded.active,
  raw_data = excluded.raw_data,
  updated_at = timezone('utc', now());

with state as (
  select data
  from public.app_state
  where id = 'primary'
),
app_inventory_ids as (
  select item->>'id' as id
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
  where item ? 'id'
),
app_stock_movements as (
  select movement
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'stockMovements', '[]'::jsonb)) as movement
  where movement ? 'id'
    and nullif(movement->>'itemId', '') in (select id from app_inventory_ids)
)
insert into public.stock_movements (
  organization_id,
  id,
  item_id,
  type,
  quantity,
  reason,
  movement_at,
  user_id,
  related_bill_id,
  raw_data,
  updated_at
)
select
  'org-primary',
  movement->>'id',
  nullif(movement->>'itemId', ''),
  coalesce(nullif(movement->>'type', ''), 'adjustment'),
  coalesce(nullif(movement->>'quantity', '')::numeric, 0),
  nullif(movement->>'reason', ''),
  nullif(movement->>'createdAt', '')::timestamptz,
  nullif(movement->>'userId', ''),
  nullif(movement->>'relatedBillId', ''),
  movement,
  timezone('utc', now())
from app_stock_movements
on conflict (organization_id, id) do update
set
  item_id = excluded.item_id,
  type = excluded.type,
  quantity = excluded.quantity,
  reason = excluded.reason,
  movement_at = excluded.movement_at,
  user_id = excluded.user_id,
  related_bill_id = excluded.related_bill_id,
  raw_data = excluded.raw_data,
  updated_at = timezone('utc', now());

with state as (
  select data
  from public.app_state
  where id = 'primary'
),
app_inventory_audit_logs as (
  select audit
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'auditLogs', '[]'::jsonb)) as audit
  where audit ? 'id'
    and (
      audit->>'entityType' = 'inventory_item'
      or audit->>'action' in ('inventory_created', 'inventory_updated', 'inventory_archived', 'inventory_restored', 'stock_movement')
    )
)
insert into public.audit_logs (
  organization_id,
  id,
  action,
  entity_type,
  entity_id,
  message,
  audit_at,
  user_id,
  raw_data,
  updated_at
)
select
  'org-primary',
  audit->>'id',
  coalesce(nullif(audit->>'action', ''), 'inventory_admin_sync_repair'),
  nullif(audit->>'entityType', ''),
  nullif(audit->>'entityId', ''),
  nullif(audit->>'message', ''),
  nullif(audit->>'createdAt', '')::timestamptz,
  nullif(audit->>'userId', ''),
  audit,
  timezone('utc', now())
from app_inventory_audit_logs
on conflict (organization_id, id) do update
set
  action = excluded.action,
  entity_type = excluded.entity_type,
  entity_id = excluded.entity_id,
  message = excluded.message,
  audit_at = excluded.audit_at,
  user_id = excluded.user_id,
  raw_data = excluded.raw_data,
  updated_at = timezone('utc', now());

with state as (
  select data
  from public.app_state
  where id = 'primary'
),
app_inventory_ids as (
  select coalesce(jsonb_agg(item->>'id'), '[]'::jsonb) as ids
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
  where item ? 'id'
)
insert into public.operational_events (
  organization_id,
  event_type,
  entity_type,
  entity_id,
  created_by,
  metadata
)
select
  'org-primary',
  'inventory_admin_sync_repair',
  'admin_data',
  'inventory_admin_sync_repair',
  'manual_sql_repair',
  jsonb_build_object(
    'mutation_kind', 'inventoryAdminSyncRepair',
    'changed_rows', jsonb_build_object(
      'inventory_items', ids,
      'sale_variants', ids
    )
  )
from app_inventory_ids;

commit;
