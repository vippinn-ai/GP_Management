-- Phase 8 inventory admin sync repair verification.
-- Read-only. Run after applying the repair.

with state as (
  select data
  from public.app_state
  where id = 'primary'
),
app_inventory as (
  select
    item->>'id' as id,
    coalesce(nullif(item->>'name', ''), 'Unnamed item') as name,
    nullif(item->>'category', '') as category,
    coalesce(nullif(item->>'price', '')::numeric, 0) as price,
    coalesce(nullif(item->>'stockQty', '')::numeric, 0) as stock_qty,
    coalesce(nullif(item->>'lowStockThreshold', '')::numeric, 0) as low_stock_threshold,
    coalesce(nullif(item->>'unit', ''), 'piece') as unit,
    coalesce(nullif(item->>'isReusable', '')::boolean, false) as is_reusable,
    nullif(item->>'barcode', '') as barcode,
    coalesce(nullif(item->>'active', '')::boolean, true) as active,
    nullif(item->>'archivedAt', '')::timestamptz as archived_at,
    nullif(item->>'archivedByUserId', '') as archived_by_user_id,
    nullif(item->>'archiveReason', '') as archive_reason,
    coalesce(nullif(item->>'sellBaseItem', '')::boolean, true) as sell_base_item,
    item->'cigarettePack' as cigarette_pack,
    item->'saleVariants' as sale_variants
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
  where item ? 'id'
),
inventory_mismatches as (
  select coalesce(app_inventory.id, inventory_items.id) as id
  from app_inventory
  full join public.inventory_items
    on inventory_items.organization_id = 'org-primary'
   and inventory_items.id = app_inventory.id
  where
    app_inventory.id is null
    or inventory_items.id is null
    or app_inventory.name is distinct from inventory_items.name
    or app_inventory.category is distinct from inventory_items.category
    or app_inventory.price is distinct from inventory_items.price
    or app_inventory.stock_qty is distinct from inventory_items.stock_qty
    or app_inventory.low_stock_threshold is distinct from inventory_items.low_stock_threshold
    or app_inventory.unit is distinct from inventory_items.unit
    or app_inventory.is_reusable is distinct from inventory_items.is_reusable
    or app_inventory.barcode is distinct from inventory_items.barcode
    or app_inventory.active is distinct from inventory_items.active
    or app_inventory.archived_at is distinct from inventory_items.archived_at
    or app_inventory.archived_by_user_id is distinct from inventory_items.archived_by_user_id
    or app_inventory.archive_reason is distinct from inventory_items.archive_reason
    or app_inventory.sell_base_item is distinct from inventory_items.sell_base_item
    or app_inventory.cigarette_pack is distinct from inventory_items.cigarette_pack
),
app_variants as (
  select
    item->>'id' as inventory_item_id,
    variant->>'id' as id,
    coalesce(nullif(variant->>'name', ''), 'Unnamed variant') as name,
    coalesce(nullif(variant->>'price', '')::numeric, 0) as price,
    coalesce(nullif(variant->>'stockUnitsPerSale', '')::numeric, 1) as stock_units_per_sale,
    nullif(variant->>'barcode', '') as barcode,
    coalesce(nullif(variant->>'active', '')::boolean, true) as active
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
  cross join lateral jsonb_array_elements(coalesce(item->'saleVariants', '[]'::jsonb)) as variant
  where item ? 'id'
    and variant ? 'id'
),
variant_mismatches as (
  select coalesce(app_variants.inventory_item_id, sale_variants.inventory_item_id) || '::' ||
    coalesce(app_variants.id, sale_variants.id) as id
  from app_variants
  full join public.sale_variants
    on sale_variants.organization_id = 'org-primary'
   and sale_variants.inventory_item_id = app_variants.inventory_item_id
   and sale_variants.id = app_variants.id
  where
    app_variants.id is null
    or sale_variants.id is null
    or app_variants.name is distinct from sale_variants.name
    or app_variants.price is distinct from sale_variants.price
    or app_variants.stock_units_per_sale is distinct from sale_variants.stock_units_per_sale
    or app_variants.barcode is distinct from sale_variants.barcode
    or app_variants.active is distinct from sale_variants.active
),
paneer_momo as (
  select
    app_inventory.id,
    app_inventory.name,
    app_inventory.stock_qty as app_state_stock,
    inventory_items.stock_qty as normalized_stock,
    app_inventory.stock_qty - inventory_items.stock_qty as stock_delta,
    app_inventory.sale_variants as app_state_variants,
    (
      select jsonb_agg(jsonb_build_object(
        'id', sale_variants.id,
        'name', sale_variants.name,
        'stockUnitsPerSale', sale_variants.stock_units_per_sale,
        'active', sale_variants.active
      ) order by sale_variants.name)
      from public.sale_variants
      where sale_variants.organization_id = 'org-primary'
        and sale_variants.inventory_item_id = app_inventory.id
    ) as normalized_variants
  from app_inventory
  join public.inventory_items
    on inventory_items.organization_id = 'org-primary'
   and inventory_items.id = app_inventory.id
  where lower(app_inventory.name) = 'paneer momo'
)
select 'summary' as section, 'inventory_item_mismatches' as metric, count(*)::text as value
from inventory_mismatches
union all
select 'summary', 'sale_variant_mismatches', count(*)::text
from variant_mismatches
union all
select 'paneer_momo', id, jsonb_build_object(
  'name', name,
  'appStateStock', app_state_stock,
  'normalizedStock', normalized_stock,
  'stockDelta', stock_delta,
  'appStateVariants', app_state_variants,
  'normalizedVariants', normalized_variants
)::text
from paneer_momo
order by section, metric;
