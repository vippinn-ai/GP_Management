-- Phase 8 inventory admin sync repair preview.
-- Read-only. Run in staging first, then production before applying the repair.

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
    item as raw_data
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
  where item ? 'id'
),
normalized_inventory as (
  select *
  from public.inventory_items
  where organization_id = 'org-primary'
),
inventory_mismatches as (
  select
    coalesce(app_inventory.id, normalized_inventory.id) as id,
    jsonb_build_object(
      'appName', app_inventory.name,
      'normalizedName', normalized_inventory.name,
      'appStock', app_inventory.stock_qty,
      'normalizedStock', normalized_inventory.stock_qty,
      'appActive', app_inventory.active,
      'normalizedActive', normalized_inventory.active,
      'appArchivedAt', app_inventory.archived_at,
      'normalizedArchivedAt', normalized_inventory.archived_at,
      'status',
        case
          when app_inventory.id is null then 'missing_from_app_state'
          when normalized_inventory.id is null then 'missing_from_normalized'
          else 'different'
        end
    ) as detail
  from app_inventory
  full join normalized_inventory
    on normalized_inventory.id = app_inventory.id
  where
    app_inventory.id is null
    or normalized_inventory.id is null
    or app_inventory.name is distinct from normalized_inventory.name
    or app_inventory.category is distinct from normalized_inventory.category
    or app_inventory.price is distinct from normalized_inventory.price
    or app_inventory.stock_qty is distinct from normalized_inventory.stock_qty
    or app_inventory.low_stock_threshold is distinct from normalized_inventory.low_stock_threshold
    or app_inventory.unit is distinct from normalized_inventory.unit
    or app_inventory.is_reusable is distinct from normalized_inventory.is_reusable
    or app_inventory.barcode is distinct from normalized_inventory.barcode
    or app_inventory.active is distinct from normalized_inventory.active
    or app_inventory.archived_at is distinct from normalized_inventory.archived_at
    or app_inventory.archived_by_user_id is distinct from normalized_inventory.archived_by_user_id
    or app_inventory.archive_reason is distinct from normalized_inventory.archive_reason
    or app_inventory.sell_base_item is distinct from normalized_inventory.sell_base_item
    or app_inventory.cigarette_pack is distinct from normalized_inventory.cigarette_pack
),
app_variants as (
  select
    item->>'id' as inventory_item_id,
    variant->>'id' as id,
    coalesce(nullif(variant->>'name', ''), 'Unnamed variant') as name,
    coalesce(nullif(variant->>'price', '')::numeric, 0) as price,
    coalesce(nullif(variant->>'stockUnitsPerSale', '')::numeric, 1) as stock_units_per_sale,
    nullif(variant->>'barcode', '') as barcode,
    coalesce(nullif(variant->>'active', '')::boolean, true) as active,
    variant as raw_data
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'inventoryItems', '[]'::jsonb)) as item
  cross join lateral jsonb_array_elements(coalesce(item->'saleVariants', '[]'::jsonb)) as variant
  where item ? 'id'
    and variant ? 'id'
),
normalized_variants as (
  select *
  from public.sale_variants
  where organization_id = 'org-primary'
),
variant_mismatches as (
  select
    coalesce(app_variants.inventory_item_id, normalized_variants.inventory_item_id) || '::' ||
      coalesce(app_variants.id, normalized_variants.id) as id,
    jsonb_build_object(
      'inventoryItemId', coalesce(app_variants.inventory_item_id, normalized_variants.inventory_item_id),
      'appVariantName', app_variants.name,
      'normalizedVariantName', normalized_variants.name,
      'appStockUnitsPerSale', app_variants.stock_units_per_sale,
      'normalizedStockUnitsPerSale', normalized_variants.stock_units_per_sale,
      'status',
        case
          when app_variants.id is null then 'missing_from_app_state'
          when normalized_variants.id is null then 'missing_from_normalized'
          else 'different'
        end
    ) as detail
  from app_variants
  full join normalized_variants
    on normalized_variants.inventory_item_id = app_variants.inventory_item_id
   and normalized_variants.id = app_variants.id
  where
    app_variants.id is null
    or normalized_variants.id is null
    or app_variants.name is distinct from normalized_variants.name
    or app_variants.price is distinct from normalized_variants.price
    or app_variants.stock_units_per_sale is distinct from normalized_variants.stock_units_per_sale
    or app_variants.barcode is distinct from normalized_variants.barcode
    or app_variants.active is distinct from normalized_variants.active
),
app_stock_movements as (
  select movement
  from state
  cross join lateral jsonb_array_elements(coalesce(data->'stockMovements', '[]'::jsonb)) as movement
  where movement ? 'id'
    and nullif(movement->>'itemId', '') in (select id from app_inventory)
),
missing_stock_movements as (
  select movement->>'id' as id
  from app_stock_movements
  left join public.stock_movements
    on stock_movements.organization_id = 'org-primary'
   and stock_movements.id = movement->>'id'
  where stock_movements.id is null
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
),
missing_audit_logs as (
  select audit->>'id' as id
  from app_inventory_audit_logs
  left join public.audit_logs
    on audit_logs.organization_id = 'org-primary'
   and audit_logs.id = audit->>'id'
  where audit_logs.id is null
)
select 'summary' as section, 'inventory_item_mismatches' as metric, count(*)::text as value
from inventory_mismatches
union all
select 'summary', 'sale_variant_mismatches', count(*)::text
from variant_mismatches
union all
select 'summary', 'missing_stock_movements', count(*)::text
from missing_stock_movements
union all
select 'summary', 'missing_inventory_audit_logs', count(*)::text
from missing_audit_logs
union all
select 'inventory_item_mismatch', id, detail::text
from inventory_mismatches
union all
select 'sale_variant_mismatch', id, detail::text
from variant_mismatches
order by section, metric;
