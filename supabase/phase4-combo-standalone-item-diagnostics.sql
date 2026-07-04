-- Diagnostics for combo-included item rows that may have absorbed standalone item additions.
--
-- Read-only. This script does not repair or update data.
-- Review any returned rows before deciding whether manual correction is needed.

select
  has_function_privilege('anon', 'public.add_customer_tab_item(jsonb)', 'execute') as anon_can_add_customer_tab_item,
  has_function_privilege('authenticated', 'public.add_customer_tab_item(jsonb)', 'execute') as authenticated_can_add_customer_tab_item,
  has_function_privilege('anon', 'public.add_session_item(jsonb)', 'execute') as anon_can_add_session_item,
  has_function_privilege('authenticated', 'public.add_session_item(jsonb)', 'execute') as authenticated_can_add_session_item,
  has_function_privilege('anon', 'public.repeat_session_combo(jsonb)', 'execute') as anon_can_repeat_session_combo,
  has_function_privilege('authenticated', 'public.repeat_session_combo(jsonb)', 'execute') as authenticated_can_repeat_session_combo;

with expected_combo_items as (
  select
    'session'::text as entity_type,
    session_combo_applications.organization_id,
    session_combo_applications.session_id as entity_id,
    session_combo_applications.id as combo_application_id,
    session_combo_applications.combo_id,
    session_combo_applications.combo_name,
    item->>'inventoryItemId' as inventory_item_id,
    nullif(item->>'saleVariantId', '') as sale_variant_id,
    coalesce(nullif(item->>'stockUnitsPerSale', '')::numeric, 1) as stock_units_per_sale,
    coalesce(nullif(item->>'quantity', '')::numeric, 0) as expected_quantity
  from public.session_combo_applications
  join public.sessions
    on sessions.organization_id = session_combo_applications.organization_id
   and sessions.id = session_combo_applications.session_id
  cross join lateral jsonb_array_elements(coalesce(session_combo_applications.fixed_items, '[]'::jsonb)) as item
  where sessions.status <> 'closed'
    and nullif(item->>'inventoryItemId', '') is not null

  union all

  select
    'session'::text as entity_type,
    session_combo_applications.organization_id,
    session_combo_applications.session_id as entity_id,
    session_combo_applications.id as combo_application_id,
    session_combo_applications.combo_id,
    session_combo_applications.combo_name,
    item->>'inventoryItemId' as inventory_item_id,
    nullif(item->>'saleVariantId', '') as sale_variant_id,
    coalesce(nullif(item->>'stockUnitsPerSale', '')::numeric, 1) as stock_units_per_sale,
    coalesce(nullif(item->>'quantity', '')::numeric, 0) as expected_quantity
  from public.session_combo_applications
  join public.sessions
    on sessions.organization_id = session_combo_applications.organization_id
   and sessions.id = session_combo_applications.session_id
  cross join lateral jsonb_array_elements(coalesce(session_combo_applications.choices, '[]'::jsonb)) as choice_group
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(choice_group->'selections') = 'array' then choice_group->'selections'
      when jsonb_typeof(choice_group->'selection') = 'object' then jsonb_build_array(choice_group->'selection')
      else '[]'::jsonb
    end
  ) as item
  where sessions.status <> 'closed'
    and nullif(item->>'inventoryItemId', '') is not null

  union all

  select
    'customer_tab'::text as entity_type,
    customer_tab_combo_applications.organization_id,
    customer_tab_combo_applications.customer_tab_id as entity_id,
    customer_tab_combo_applications.id as combo_application_id,
    customer_tab_combo_applications.combo_id,
    customer_tab_combo_applications.combo_name,
    item->>'inventoryItemId' as inventory_item_id,
    nullif(item->>'saleVariantId', '') as sale_variant_id,
    coalesce(nullif(item->>'stockUnitsPerSale', '')::numeric, 1) as stock_units_per_sale,
    coalesce(nullif(item->>'quantity', '')::numeric, 0) as expected_quantity
  from public.customer_tab_combo_applications
  join public.customer_tabs
    on customer_tabs.organization_id = customer_tab_combo_applications.organization_id
   and customer_tabs.id = customer_tab_combo_applications.customer_tab_id
  cross join lateral jsonb_array_elements(coalesce(customer_tab_combo_applications.fixed_items, '[]'::jsonb)) as item
  where customer_tabs.status = 'open'
    and nullif(item->>'inventoryItemId', '') is not null

  union all

  select
    'customer_tab'::text as entity_type,
    customer_tab_combo_applications.organization_id,
    customer_tab_combo_applications.customer_tab_id as entity_id,
    customer_tab_combo_applications.id as combo_application_id,
    customer_tab_combo_applications.combo_id,
    customer_tab_combo_applications.combo_name,
    item->>'inventoryItemId' as inventory_item_id,
    nullif(item->>'saleVariantId', '') as sale_variant_id,
    coalesce(nullif(item->>'stockUnitsPerSale', '')::numeric, 1) as stock_units_per_sale,
    coalesce(nullif(item->>'quantity', '')::numeric, 0) as expected_quantity
  from public.customer_tab_combo_applications
  join public.customer_tabs
    on customer_tabs.organization_id = customer_tab_combo_applications.organization_id
   and customer_tabs.id = customer_tab_combo_applications.customer_tab_id
  cross join lateral jsonb_array_elements(coalesce(customer_tab_combo_applications.choices, '[]'::jsonb)) as choice_group
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(choice_group->'selections') = 'array' then choice_group->'selections'
      when jsonb_typeof(choice_group->'selection') = 'object' then jsonb_build_array(choice_group->'selection')
      else '[]'::jsonb
    end
  ) as item
  where customer_tabs.status = 'open'
    and nullif(item->>'inventoryItemId', '') is not null
),
expected_grouped as (
  select
    entity_type,
    organization_id,
    entity_id,
    combo_application_id,
    combo_id,
    combo_name,
    inventory_item_id,
    sale_variant_id,
    stock_units_per_sale,
    sum(expected_quantity) as expected_quantity
  from expected_combo_items
  group by
    entity_type,
    organization_id,
    entity_id,
    combo_application_id,
    combo_id,
    combo_name,
    inventory_item_id,
    sale_variant_id,
    stock_units_per_sale
),
actual_combo_lines as (
  select
    'session'::text as entity_type,
    session_items.organization_id,
    session_items.session_id as entity_id,
    session_items.combo_application_id,
    session_items.combo_id,
    session_items.inventory_item_id,
    session_items.sale_variant_id,
    coalesce(session_items.stock_units_per_sale, session_items.sold_as_pack_of, 1) as stock_units_per_sale,
    session_items.id as line_id,
    session_items.name,
    session_items.quantity
  from public.session_items
  join public.sessions
    on sessions.organization_id = session_items.organization_id
   and sessions.id = session_items.session_id
  where sessions.status <> 'closed'
    and session_items.combo_application_id is not null

  union all

  select
    'customer_tab'::text as entity_type,
    customer_tab_items.organization_id,
    customer_tab_items.customer_tab_id as entity_id,
    customer_tab_items.combo_application_id,
    customer_tab_items.combo_id,
    customer_tab_items.inventory_item_id,
    customer_tab_items.sale_variant_id,
    coalesce(customer_tab_items.stock_units_per_sale, customer_tab_items.sold_as_pack_of, 1) as stock_units_per_sale,
    customer_tab_items.id as line_id,
    customer_tab_items.name,
    customer_tab_items.quantity
  from public.customer_tab_items
  join public.customer_tabs
    on customer_tabs.organization_id = customer_tab_items.organization_id
   and customer_tabs.id = customer_tab_items.customer_tab_id
  where customer_tabs.status = 'open'
    and customer_tab_items.combo_application_id is not null
),
actual_grouped as (
  select
    entity_type,
    organization_id,
    entity_id,
    combo_application_id,
    combo_id,
    inventory_item_id,
    sale_variant_id,
    stock_units_per_sale,
    jsonb_agg(line_id order by line_id) as line_ids,
    jsonb_agg(name order by line_id) as line_names,
    sum(quantity) as actual_quantity
  from actual_combo_lines
  group by
    entity_type,
    organization_id,
    entity_id,
    combo_application_id,
    combo_id,
    inventory_item_id,
    sale_variant_id,
    stock_units_per_sale
)
select
  'combo_included_quantity_over_snapshot' as check_group,
  actual_grouped.entity_type,
  actual_grouped.organization_id,
  actual_grouped.entity_id,
  actual_grouped.combo_application_id,
  coalesce(expected_grouped.combo_name, actual_grouped.combo_id, 'Unknown combo') as combo_name,
  actual_grouped.inventory_item_id,
  actual_grouped.sale_variant_id,
  actual_grouped.stock_units_per_sale,
  actual_grouped.actual_quantity,
  coalesce(expected_grouped.expected_quantity, 0) as expected_quantity,
  actual_grouped.actual_quantity - coalesce(expected_grouped.expected_quantity, 0) as quantity_over_snapshot,
  actual_grouped.line_ids,
  actual_grouped.line_names
from actual_grouped
left join expected_grouped
  on expected_grouped.entity_type = actual_grouped.entity_type
 and expected_grouped.organization_id = actual_grouped.organization_id
 and expected_grouped.entity_id = actual_grouped.entity_id
 and expected_grouped.combo_application_id = actual_grouped.combo_application_id
 and expected_grouped.inventory_item_id = actual_grouped.inventory_item_id
 and expected_grouped.sale_variant_id is not distinct from actual_grouped.sale_variant_id
 and expected_grouped.stock_units_per_sale is not distinct from actual_grouped.stock_units_per_sale
where actual_grouped.actual_quantity > coalesce(expected_grouped.expected_quantity, 0)
order by
  actual_grouped.entity_type,
  actual_grouped.entity_id,
  actual_grouped.combo_application_id,
  actual_grouped.inventory_item_id;
