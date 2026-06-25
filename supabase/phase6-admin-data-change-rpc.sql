-- Phase 6 normalized admin-data RPC.
--
-- Run after Phase 5 RPC scripts. This keeps app_state as the rollback snapshot,
-- but writes admin/catalog changes into normalized tables so normalized startup
-- bootstrap can stay enabled without losing admin edits after refresh.

create or replace function public.remove_app_state_array_by_id(
  target_array jsonb,
  ids_to_remove jsonb
)
returns jsonb
language sql
as $$
  with remove_ids as (
    select jsonb_array_elements_text(
      case when jsonb_typeof(ids_to_remove) = 'array' then ids_to_remove else '[]'::jsonb end
    ) as id
  ),
  target_entries as (
    select
      item.value,
      item.ordinality,
      nullif(item.value->>'id', '') as id
    from jsonb_array_elements(
      case when jsonb_typeof(target_array) = 'array' then target_array else '[]'::jsonb end
    ) with ordinality as item(value, ordinality)
  )
  select coalesce(jsonb_agg(target_entries.value order by target_entries.ordinality), '[]'::jsonb)
  from target_entries
  where target_entries.id is null
    or not exists (
      select 1
      from remove_ids
      where remove_ids.id = target_entries.id
    );
$$;

revoke all on function public.remove_app_state_array_by_id(jsonb, jsonb) from public;
revoke execute on function public.remove_app_state_array_by_id(jsonb, jsonb) from anon;
revoke execute on function public.remove_app_state_array_by_id(jsonb, jsonb) from authenticated;

create or replace function public.commit_admin_data_change(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started_at timestamptz := clock_timestamp();
  v_organization_id text := nullif(payload->>'organization_id', '');
  v_mutation_id text := nullif(payload->>'mutation_id', '');
  v_mutation_kind text := nullif(payload->>'mutation_kind', '');
  v_entity_type text := nullif(payload->>'entity_type', '');
  v_entity_id text := coalesce(nullif(payload->>'entity_id', ''), 'admin_data');
  v_user_id text := nullif(payload->>'user_id', '');
  v_client_created_at timestamptz := coalesce(nullif(payload->>'client_created_at', '')::timestamptz, timezone('utc', now()));
  v_expected_version integer := nullif(payload->>'base_app_state_version', '')::integer;
  v_patch jsonb := coalesce(payload->'payload', '{}'::jsonb);
  v_inventory_categories jsonb := v_patch->'inventoryCategories';
  v_inventory_items jsonb := coalesce(v_patch->'inventoryItems', '[]'::jsonb);
  v_inventory_item_ids_to_delete jsonb := coalesce(v_patch->'inventoryItemIdsToDelete', '[]'::jsonb);
  v_combos jsonb := coalesce(v_patch->'combos', '[]'::jsonb);
  v_combo_ids_to_delete jsonb := coalesce(v_patch->'comboIdsToDelete', '[]'::jsonb);
  v_stock_movements jsonb := coalesce(v_patch->'stockMovements', '[]'::jsonb);
  v_audit_logs jsonb := coalesce(v_patch->'auditLogs', '[]'::jsonb);
  v_expenses jsonb := coalesce(v_patch->'expenses', '[]'::jsonb);
  v_expense_ids_to_delete jsonb := coalesce(v_patch->'expenseIdsToDelete', '[]'::jsonb);
  v_expense_templates jsonb := coalesce(v_patch->'expenseTemplates', '[]'::jsonb);
  v_expense_template_ids_to_delete jsonb := coalesce(v_patch->'expenseTemplateIdsToDelete', '[]'::jsonb);
  v_expense_template_overrides jsonb := coalesce(v_patch->'expenseTemplateOverrides', '[]'::jsonb);
  v_expense_template_override_ids_to_delete jsonb := coalesce(v_patch->'expenseTemplateOverrideIdsToDelete', '[]'::jsonb);
  v_stations jsonb := coalesce(v_patch->'stations', '[]'::jsonb);
  v_station_ids_to_delete jsonb := coalesce(v_patch->'stationIdsToDelete', '[]'::jsonb);
  v_pricing_rules jsonb := coalesce(v_patch->'pricingRules', '[]'::jsonb);
  v_pricing_rule_ids_to_delete jsonb := coalesce(v_patch->'pricingRuleIdsToDelete', '[]'::jsonb);
  v_customers jsonb := coalesce(v_patch->'customers', '[]'::jsonb);
  v_customer_ids_to_delete jsonb := coalesce(v_patch->'customerIdsToDelete', '[]'::jsonb);
  v_business_profile jsonb := v_patch->'businessProfile';
  v_app_state_data jsonb;
  v_next_app_state_data jsonb;
  v_app_state_version integer;
  v_next_app_state_version integer;
  v_updated_by uuid;
  v_event_id text;
  v_event_metadata jsonb;
  v_changed_rows jsonb := '{}'::jsonb;
  v_row jsonb;
  v_combo jsonb;
  v_server_duration_ms numeric;
begin
  if v_organization_id is null then
    perform public.raise_operational_rpc_error('invalid_payload', 'The admin change payload is missing an organization.', '{}'::jsonb);
  end if;

  if not (select public.current_user_has_org_access(v_organization_id)) then
    perform public.raise_operational_rpc_error(
      'organization_access_denied',
      'You do not have access to this organization.',
      jsonb_build_object('organization_id', v_organization_id)
    );
  end if;

  if v_mutation_id is null or v_mutation_kind <> 'commitAdminDataChange' or v_user_id is null or v_entity_type <> 'admin_data' then
    perform public.raise_operational_rpc_error(
      'invalid_payload',
      'The admin change payload is incomplete.',
      jsonb_build_object('mutation_id', v_mutation_id, 'mutation_kind', v_mutation_kind, 'entity_type', v_entity_type)
    );
  end if;

  select app_state.data, app_state.version
  into v_app_state_data, v_app_state_version
  from public.app_state
  where app_state.id = 'primary'
  for update;

  if v_app_state_data is null then
    perform public.raise_operational_rpc_error('missing_app_state', 'The app state row is missing.', '{}'::jsonb);
  end if;

  if v_expected_version is not null and v_app_state_version <> v_expected_version then
    perform public.raise_operational_rpc_error(
      'version_conflict',
      'This data was saved on another device. Please review the latest data and try again.',
      jsonb_build_object('expected_version', v_expected_version, 'actual_version', v_app_state_version)
    );
  end if;

  v_next_app_state_data := v_app_state_data;

  if jsonb_typeof(v_inventory_categories) = 'array' then
    delete from public.inventory_categories
    where organization_id = v_organization_id
      and name not in (
        select nullif(trim(value), '')
        from jsonb_array_elements_text(v_inventory_categories) as category_values(value)
        where nullif(trim(value), '') is not null
      );

    insert into public.inventory_categories (organization_id, id, name)
    select
      v_organization_id,
      'category-' || md5(name),
      name
    from (
      select distinct nullif(trim(value), '') as name
      from jsonb_array_elements_text(v_inventory_categories) as category_values(value)
    ) categories
    where name is not null
    on conflict (organization_id, id) do update
    set
      name = excluded.name,
      updated_at = timezone('utc', now());

    v_next_app_state_data := jsonb_set(v_next_app_state_data, '{inventoryCategories}', v_inventory_categories, true);
    v_changed_rows := jsonb_set(v_changed_rows, '{inventory_categories}', coalesce((select jsonb_agg(value) from jsonb_array_elements_text(v_inventory_categories) as category_values(value)), '[]'::jsonb), true);
  end if;

  delete from public.sale_variants
  where organization_id = v_organization_id
    and inventory_item_id in (
      select jsonb_array_elements_text(
        case when jsonb_typeof(v_inventory_item_ids_to_delete) = 'array' then v_inventory_item_ids_to_delete else '[]'::jsonb end
      )
    );

  delete from public.inventory_items
  where organization_id = v_organization_id
    and id in (
      select jsonb_array_elements_text(
        case when jsonb_typeof(v_inventory_item_ids_to_delete) = 'array' then v_inventory_item_ids_to_delete else '[]'::jsonb end
      )
    );

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
    v_organization_id,
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
  from jsonb_array_elements(case when jsonb_typeof(v_inventory_items) = 'array' then v_inventory_items else '[]'::jsonb end) as item
  where item ? 'id'
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

  for v_row in
    select item
    from jsonb_array_elements(case when jsonb_typeof(v_inventory_items) = 'array' then v_inventory_items else '[]'::jsonb end) as item
    where item ? 'id'
  loop
    delete from public.sale_variants
    where organization_id = v_organization_id
      and inventory_item_id = v_row->>'id'
      and id not in (
        select variant->>'id'
        from jsonb_array_elements(coalesce(v_row->'saleVariants', '[]'::jsonb)) as variant
        where variant ? 'id'
      );

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
      v_organization_id,
      v_row->>'id',
      variant->>'id',
      coalesce(nullif(variant->>'name', ''), 'Unnamed variant'),
      coalesce(nullif(variant->>'price', '')::numeric, 0),
      coalesce(nullif(variant->>'stockUnitsPerSale', '')::numeric, 1),
      nullif(variant->>'barcode', ''),
      coalesce(nullif(variant->>'active', '')::boolean, true),
      variant,
      timezone('utc', now())
    from jsonb_array_elements(coalesce(v_row->'saleVariants', '[]'::jsonb)) as variant
    where variant ? 'id'
    on conflict (organization_id, inventory_item_id, id) do update
    set
      name = excluded.name,
      price = excluded.price,
      stock_units_per_sale = excluded.stock_units_per_sale,
      barcode = excluded.barcode,
      active = excluded.active,
      raw_data = excluded.raw_data,
      updated_at = timezone('utc', now());
  end loop;

  delete from public.combo_choice_options
  where organization_id = v_organization_id
    and combo_id in (
      select jsonb_array_elements_text(case when jsonb_typeof(v_combo_ids_to_delete) = 'array' then v_combo_ids_to_delete else '[]'::jsonb end)
    );
  delete from public.combo_choice_groups
  where organization_id = v_organization_id
    and combo_id in (
      select jsonb_array_elements_text(case when jsonb_typeof(v_combo_ids_to_delete) = 'array' then v_combo_ids_to_delete else '[]'::jsonb end)
    );
  delete from public.combo_fixed_items
  where organization_id = v_organization_id
    and combo_id in (
      select jsonb_array_elements_text(case when jsonb_typeof(v_combo_ids_to_delete) = 'array' then v_combo_ids_to_delete else '[]'::jsonb end)
    );
  delete from public.combo_station_targets
  where organization_id = v_organization_id
    and combo_id in (
      select jsonb_array_elements_text(case when jsonb_typeof(v_combo_ids_to_delete) = 'array' then v_combo_ids_to_delete else '[]'::jsonb end)
    );
  delete from public.combos
  where organization_id = v_organization_id
    and id in (
      select jsonb_array_elements_text(case when jsonb_typeof(v_combo_ids_to_delete) = 'array' then v_combo_ids_to_delete else '[]'::jsonb end)
    );

  insert into public.combos (
    organization_id,
    id,
    name,
    type,
    active,
    price,
    included_minutes,
    raw_data,
    created_at,
    updated_at
  )
  select
    v_organization_id,
    combo->>'id',
    coalesce(nullif(combo->>'name', ''), 'Unnamed combo'),
    coalesce(nullif(combo->>'type', ''), 'game'),
    coalesce(nullif(combo->>'active', '')::boolean, true),
    coalesce(nullif(combo->>'price', '')::numeric, 0),
    coalesce(nullif(combo->>'includedMinutes', '')::integer, 0),
    combo,
    coalesce(nullif(combo->>'createdAt', '')::timestamptz, timezone('utc', now())),
    coalesce(nullif(combo->>'updatedAt', '')::timestamptz, timezone('utc', now()))
  from jsonb_array_elements(case when jsonb_typeof(v_combos) = 'array' then v_combos else '[]'::jsonb end) as combo
  where combo ? 'id'
  on conflict (organization_id, id) do update
  set
    name = excluded.name,
    type = excluded.type,
    active = excluded.active,
    price = excluded.price,
    included_minutes = excluded.included_minutes,
    raw_data = excluded.raw_data,
    updated_at = excluded.updated_at;

  for v_combo in
    select combo
    from jsonb_array_elements(case when jsonb_typeof(v_combos) = 'array' then v_combos else '[]'::jsonb end) as combo
    where combo ? 'id'
  loop
    delete from public.combo_station_targets where organization_id = v_organization_id and combo_id = v_combo->>'id';
    insert into public.combo_station_targets (organization_id, combo_id, station_id)
    select v_organization_id, v_combo->>'id', station_id
    from jsonb_array_elements_text(coalesce(v_combo->'stationIds', '[]'::jsonb)) as station_values(station_id)
    where nullif(station_id, '') is not null
    on conflict do nothing;

    delete from public.combo_fixed_items
    where organization_id = v_organization_id
      and combo_id = v_combo->>'id'
      and id not in (
        select fixed_item->>'id'
        from jsonb_array_elements(coalesce(v_combo->'fixedItems', '[]'::jsonb)) as fixed_item
        where fixed_item ? 'id'
      );
    insert into public.combo_fixed_items (organization_id, combo_id, id, sellable_option_id, quantity, raw_data, updated_at)
    select
      v_organization_id,
      v_combo->>'id',
      fixed_item->>'id',
      coalesce(nullif(fixed_item->>'sellableOptionId', ''), ''),
      coalesce(nullif(fixed_item->>'quantity', '')::numeric, 1),
      fixed_item,
      timezone('utc', now())
    from jsonb_array_elements(coalesce(v_combo->'fixedItems', '[]'::jsonb)) as fixed_item
    where fixed_item ? 'id'
    on conflict (organization_id, combo_id, id) do update
    set
      sellable_option_id = excluded.sellable_option_id,
      quantity = excluded.quantity,
      raw_data = excluded.raw_data,
      updated_at = timezone('utc', now());

    delete from public.combo_choice_options where organization_id = v_organization_id and combo_id = v_combo->>'id';
    delete from public.combo_choice_groups
    where organization_id = v_organization_id
      and combo_id = v_combo->>'id'
      and id not in (
        select choice_group->>'id'
        from jsonb_array_elements(coalesce(v_combo->'choiceGroups', '[]'::jsonb)) as choice_group
        where choice_group ? 'id'
      );
    insert into public.combo_choice_groups (organization_id, combo_id, id, label, required_quantity, raw_data, updated_at)
    select
      v_organization_id,
      v_combo->>'id',
      choice_group->>'id',
      coalesce(nullif(choice_group->>'label', ''), 'Choice group'),
      coalesce(nullif(choice_group->>'requiredQuantity', '')::integer, 1),
      choice_group,
      timezone('utc', now())
    from jsonb_array_elements(coalesce(v_combo->'choiceGroups', '[]'::jsonb)) as choice_group
    where choice_group ? 'id'
    on conflict (organization_id, combo_id, id) do update
    set
      label = excluded.label,
      required_quantity = excluded.required_quantity,
      raw_data = excluded.raw_data,
      updated_at = timezone('utc', now());

    insert into public.combo_choice_options (organization_id, combo_id, choice_group_id, option_id)
    select
      v_organization_id,
      v_combo->>'id',
      choice_group->>'id',
      option_id
    from jsonb_array_elements(coalesce(v_combo->'choiceGroups', '[]'::jsonb)) as choice_group
    cross join lateral jsonb_array_elements_text(coalesce(choice_group->'optionIds', '[]'::jsonb)) as option_values(option_id)
    where choice_group ? 'id'
      and nullif(option_id, '') is not null
    on conflict do nothing;
  end loop;

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
    v_organization_id,
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
  from jsonb_array_elements(case when jsonb_typeof(v_stock_movements) = 'array' then v_stock_movements else '[]'::jsonb end) as movement
  where movement ? 'id'
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
    v_organization_id,
    audit->>'id',
    coalesce(nullif(audit->>'action', ''), 'unknown'),
    nullif(audit->>'entityType', ''),
    nullif(audit->>'entityId', ''),
    nullif(audit->>'message', ''),
    nullif(audit->>'createdAt', '')::timestamptz,
    nullif(audit->>'userId', ''),
    audit,
    timezone('utc', now())
  from jsonb_array_elements(case when jsonb_typeof(v_audit_logs) = 'array' then v_audit_logs else '[]'::jsonb end) as audit
  where audit ? 'id'
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

  delete from public.expenses
  where organization_id = v_organization_id
    and id in (
      select jsonb_array_elements_text(case when jsonb_typeof(v_expense_ids_to_delete) = 'array' then v_expense_ids_to_delete else '[]'::jsonb end)
    );
  insert into public.expenses (
    organization_id,
    id,
    title,
    category,
    amount,
    payment_mode,
    cash_amount,
    upi_amount,
    spent_at,
    notes,
    created_by_user_id,
    raw_data,
    updated_at
  )
  select
    v_organization_id,
    expense->>'id',
    coalesce(nullif(expense->>'title', ''), 'Expense'),
    nullif(expense->>'category', ''),
    coalesce(nullif(expense->>'amount', '')::numeric, 0),
    nullif(expense->>'paymentMode', ''),
    nullif(expense->>'cashAmount', '')::numeric,
    nullif(expense->>'upiAmount', '')::numeric,
    nullif(expense->>'spentAt', '')::timestamptz,
    nullif(expense->>'notes', ''),
    nullif(expense->>'createdByUserId', ''),
    expense,
    timezone('utc', now())
  from jsonb_array_elements(case when jsonb_typeof(v_expenses) = 'array' then v_expenses else '[]'::jsonb end) as expense
  where expense ? 'id'
  on conflict (organization_id, id) do update
  set
    title = excluded.title,
    category = excluded.category,
    amount = excluded.amount,
    payment_mode = excluded.payment_mode,
    cash_amount = excluded.cash_amount,
    upi_amount = excluded.upi_amount,
    spent_at = excluded.spent_at,
    notes = excluded.notes,
    created_by_user_id = excluded.created_by_user_id,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

  delete from public.expense_templates
  where organization_id = v_organization_id
    and id in (
      select jsonb_array_elements_text(case when jsonb_typeof(v_expense_template_ids_to_delete) = 'array' then v_expense_template_ids_to_delete else '[]'::jsonb end)
    );
  insert into public.expense_templates (
    organization_id,
    id,
    title,
    category,
    amount,
    frequency,
    start_month,
    active,
    notes,
    created_by_user_id,
    raw_data,
    updated_at
  )
  select
    v_organization_id,
    template->>'id',
    coalesce(nullif(template->>'title', ''), 'Expense template'),
    nullif(template->>'category', ''),
    coalesce(nullif(template->>'amount', '')::numeric, 0),
    coalesce(nullif(template->>'frequency', ''), 'monthly'),
    nullif(template->>'startMonth', ''),
    coalesce(nullif(template->>'active', '')::boolean, true),
    nullif(template->>'notes', ''),
    nullif(template->>'createdByUserId', ''),
    template,
    timezone('utc', now())
  from jsonb_array_elements(case when jsonb_typeof(v_expense_templates) = 'array' then v_expense_templates else '[]'::jsonb end) as template
  where template ? 'id'
  on conflict (organization_id, id) do update
  set
    title = excluded.title,
    category = excluded.category,
    amount = excluded.amount,
    frequency = excluded.frequency,
    start_month = excluded.start_month,
    active = excluded.active,
    notes = excluded.notes,
    created_by_user_id = excluded.created_by_user_id,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

  delete from public.expense_template_overrides
  where organization_id = v_organization_id
    and id in (
      select jsonb_array_elements_text(case when jsonb_typeof(v_expense_template_override_ids_to_delete) = 'array' then v_expense_template_override_ids_to_delete else '[]'::jsonb end)
    );
  insert into public.expense_template_overrides (
    organization_id,
    id,
    template_id,
    month_key,
    amount,
    skip_reason,
    notes,
    created_by_user_id,
    updated_at_source,
    raw_data,
    updated_at
  )
  select
    v_organization_id,
    override_row->>'id',
    nullif(override_row->>'templateId', ''),
    nullif(override_row->>'monthKey', ''),
    nullif(override_row->>'amount', '')::numeric,
    nullif(override_row->>'skipReason', ''),
    nullif(override_row->>'notes', ''),
    nullif(override_row->>'createdByUserId', ''),
    nullif(override_row->>'updatedAt', '')::timestamptz,
    override_row,
    timezone('utc', now())
  from jsonb_array_elements(case when jsonb_typeof(v_expense_template_overrides) = 'array' then v_expense_template_overrides else '[]'::jsonb end) as override_row
  where override_row ? 'id'
  on conflict (organization_id, id) do update
  set
    template_id = excluded.template_id,
    month_key = excluded.month_key,
    amount = excluded.amount,
    skip_reason = excluded.skip_reason,
    notes = excluded.notes,
    created_by_user_id = excluded.created_by_user_id,
    updated_at_source = excluded.updated_at_source,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

  delete from public.stations
  where organization_id = v_organization_id
    and id in (
      select jsonb_array_elements_text(case when jsonb_typeof(v_station_ids_to_delete) = 'array' then v_station_ids_to_delete else '[]'::jsonb end)
    );
  insert into public.stations (organization_id, id, name, mode, active, ltp_enabled, notes, raw_data, updated_at)
  select
    v_organization_id,
    station->>'id',
    coalesce(nullif(station->>'name', ''), 'Unnamed station'),
    coalesce(nullif(station->>'mode', ''), 'timed'),
    coalesce(nullif(station->>'active', '')::boolean, true),
    coalesce(nullif(station->>'ltpEnabled', '')::boolean, false),
    nullif(station->>'notes', ''),
    station,
    timezone('utc', now())
  from jsonb_array_elements(case when jsonb_typeof(v_stations) = 'array' then v_stations else '[]'::jsonb end) as station
  where station ? 'id'
  on conflict (organization_id, id) do update
  set
    name = excluded.name,
    mode = excluded.mode,
    active = excluded.active,
    ltp_enabled = excluded.ltp_enabled,
    notes = excluded.notes,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

  delete from public.pricing_rules
  where organization_id = v_organization_id
    and id in (
      select jsonb_array_elements_text(case when jsonb_typeof(v_pricing_rule_ids_to_delete) = 'array' then v_pricing_rule_ids_to_delete else '[]'::jsonb end)
    );
  insert into public.pricing_rules (organization_id, id, station_id, label, start_minute, end_minute, hourly_rate, raw_data, updated_at)
  select
    v_organization_id,
    rule->>'id',
    nullif(rule->>'stationId', ''),
    coalesce(nullif(rule->>'label', ''), 'Pricing rule'),
    coalesce(nullif(rule->>'startMinute', '')::integer, 0),
    coalesce(nullif(rule->>'endMinute', '')::integer, 0),
    coalesce(nullif(rule->>'hourlyRate', '')::numeric, 0),
    rule,
    timezone('utc', now())
  from jsonb_array_elements(case when jsonb_typeof(v_pricing_rules) = 'array' then v_pricing_rules else '[]'::jsonb end) as rule
  where rule ? 'id'
  on conflict (organization_id, id) do update
  set
    station_id = excluded.station_id,
    label = excluded.label,
    start_minute = excluded.start_minute,
    end_minute = excluded.end_minute,
    hourly_rate = excluded.hourly_rate,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

  delete from public.customers
  where organization_id = v_organization_id
    and id in (
      select jsonb_array_elements_text(case when jsonb_typeof(v_customer_ids_to_delete) = 'array' then v_customer_ids_to_delete else '[]'::jsonb end)
    );
  insert into public.customers (organization_id, id, name, phone, first_seen_at, last_visit_at, notes, raw_data, updated_at)
  select
    v_organization_id,
    customer->>'id',
    coalesce(nullif(customer->>'name', ''), 'Walk-in customer'),
    nullif(customer->>'phone', ''),
    nullif(customer->>'createdAt', '')::timestamptz,
    nullif(customer->>'lastVisitAt', '')::timestamptz,
    nullif(customer->>'notes', ''),
    customer,
    timezone('utc', now())
  from jsonb_array_elements(case when jsonb_typeof(v_customers) = 'array' then v_customers else '[]'::jsonb end) as customer
  where customer ? 'id'
  on conflict (organization_id, id) do update
  set
    name = excluded.name,
    phone = excluded.phone,
    first_seen_at = excluded.first_seen_at,
    last_visit_at = excluded.last_visit_at,
    notes = excluded.notes,
    raw_data = excluded.raw_data,
    updated_at = timezone('utc', now());

  if jsonb_typeof(v_business_profile) = 'object' then
    update public.organizations
    set
      name = coalesce(nullif(v_business_profile->>'name', ''), organizations.name),
      business_profile = v_business_profile,
      updated_at = timezone('utc', now())
    where organizations.id = v_organization_id;
    v_next_app_state_data := jsonb_set(v_next_app_state_data, '{businessProfile}', v_business_profile, true);
    v_changed_rows := jsonb_set(v_changed_rows, '{organizations}', jsonb_build_array(v_organization_id), true);
  end if;

  v_next_app_state_data := jsonb_set(
    v_next_app_state_data,
    '{inventoryItems}',
    public.patch_app_state_array_by_id(
      public.remove_app_state_array_by_id(v_next_app_state_data->'inventoryItems', v_inventory_item_ids_to_delete),
      v_inventory_items
    ),
    true
  );
  v_next_app_state_data := jsonb_set(
    v_next_app_state_data,
    '{combos}',
    public.patch_app_state_array_by_id(
      public.remove_app_state_array_by_id(v_next_app_state_data->'combos', v_combo_ids_to_delete),
      v_combos
    ),
    true
  );
  v_next_app_state_data := jsonb_set(
    v_next_app_state_data,
    '{stockMovements}',
    public.patch_app_state_array_by_id(v_next_app_state_data->'stockMovements', v_stock_movements),
    true
  );
  v_next_app_state_data := jsonb_set(
    v_next_app_state_data,
    '{auditLogs}',
    public.patch_app_state_array_by_id(v_next_app_state_data->'auditLogs', v_audit_logs),
    true
  );
  v_next_app_state_data := jsonb_set(
    v_next_app_state_data,
    '{expenses}',
    public.patch_app_state_array_by_id(
      public.remove_app_state_array_by_id(v_next_app_state_data->'expenses', v_expense_ids_to_delete),
      v_expenses
    ),
    true
  );
  v_next_app_state_data := jsonb_set(
    v_next_app_state_data,
    '{expenseTemplates}',
    public.patch_app_state_array_by_id(
      public.remove_app_state_array_by_id(v_next_app_state_data->'expenseTemplates', v_expense_template_ids_to_delete),
      v_expense_templates
    ),
    true
  );
  v_next_app_state_data := jsonb_set(
    v_next_app_state_data,
    '{expenseTemplateOverrides}',
    public.patch_app_state_array_by_id(
      public.remove_app_state_array_by_id(v_next_app_state_data->'expenseTemplateOverrides', v_expense_template_override_ids_to_delete),
      v_expense_template_overrides
    ),
    true
  );
  v_next_app_state_data := jsonb_set(
    v_next_app_state_data,
    '{stations}',
    public.patch_app_state_array_by_id(
      public.remove_app_state_array_by_id(v_next_app_state_data->'stations', v_station_ids_to_delete),
      v_stations
    ),
    true
  );
  v_next_app_state_data := jsonb_set(
    v_next_app_state_data,
    '{pricingRules}',
    public.patch_app_state_array_by_id(
      public.remove_app_state_array_by_id(v_next_app_state_data->'pricingRules', v_pricing_rule_ids_to_delete),
      v_pricing_rules
    ),
    true
  );
  v_next_app_state_data := jsonb_set(
    v_next_app_state_data,
    '{customers}',
    public.patch_app_state_array_by_id(
      public.remove_app_state_array_by_id(v_next_app_state_data->'customers', v_customer_ids_to_delete),
      v_customers
    ),
    true
  );

  if jsonb_array_length(v_inventory_items) > 0 or jsonb_array_length(v_inventory_item_ids_to_delete) > 0 then
    v_changed_rows := jsonb_set(
      v_changed_rows,
      '{inventory_items}',
      coalesce((select jsonb_agg(id) from (
        select item->>'id' as id from jsonb_array_elements(v_inventory_items) as item where item ? 'id'
        union
        select jsonb_array_elements_text(v_inventory_item_ids_to_delete)
      ) ids), '[]'::jsonb),
      true
    );
    v_changed_rows := jsonb_set(v_changed_rows, '{sale_variants}', v_changed_rows->'inventory_items', true);
  end if;
  if jsonb_array_length(v_combos) > 0 or jsonb_array_length(v_combo_ids_to_delete) > 0 then
    v_changed_rows := jsonb_set(
      v_changed_rows,
      '{combos}',
      coalesce((select jsonb_agg(id) from (
        select combo->>'id' as id from jsonb_array_elements(v_combos) as combo where combo ? 'id'
        union
        select jsonb_array_elements_text(v_combo_ids_to_delete)
      ) ids), '[]'::jsonb),
      true
    );
  end if;
  if jsonb_array_length(v_stock_movements) > 0 then
    v_changed_rows := jsonb_set(v_changed_rows, '{stock_movements}', coalesce((select jsonb_agg(movement->>'id') from jsonb_array_elements(v_stock_movements) as movement where movement ? 'id'), '[]'::jsonb), true);
  end if;
  if jsonb_array_length(v_audit_logs) > 0 then
    v_changed_rows := jsonb_set(v_changed_rows, '{audit_logs}', coalesce((select jsonb_agg(audit->>'id') from jsonb_array_elements(v_audit_logs) as audit where audit ? 'id'), '[]'::jsonb), true);
  end if;
  if jsonb_array_length(v_expenses) > 0 or jsonb_array_length(v_expense_ids_to_delete) > 0 then
    v_changed_rows := jsonb_set(v_changed_rows, '{expenses}', coalesce((select jsonb_agg(id) from (
      select expense->>'id' as id from jsonb_array_elements(v_expenses) as expense where expense ? 'id'
      union
      select jsonb_array_elements_text(v_expense_ids_to_delete)
    ) ids), '[]'::jsonb), true);
  end if;
  if jsonb_array_length(v_expense_templates) > 0 or jsonb_array_length(v_expense_template_ids_to_delete) > 0 then
    v_changed_rows := jsonb_set(v_changed_rows, '{expense_templates}', coalesce((select jsonb_agg(id) from (
      select template->>'id' as id from jsonb_array_elements(v_expense_templates) as template where template ? 'id'
      union
      select jsonb_array_elements_text(v_expense_template_ids_to_delete)
    ) ids), '[]'::jsonb), true);
  end if;
  if jsonb_array_length(v_expense_template_overrides) > 0 or jsonb_array_length(v_expense_template_override_ids_to_delete) > 0 then
    v_changed_rows := jsonb_set(v_changed_rows, '{expense_template_overrides}', coalesce((select jsonb_agg(id) from (
      select override_row->>'id' as id from jsonb_array_elements(v_expense_template_overrides) as override_row where override_row ? 'id'
      union
      select jsonb_array_elements_text(v_expense_template_override_ids_to_delete)
    ) ids), '[]'::jsonb), true);
  end if;
  if jsonb_array_length(v_stations) > 0 or jsonb_array_length(v_station_ids_to_delete) > 0 then
    v_changed_rows := jsonb_set(v_changed_rows, '{stations}', coalesce((select jsonb_agg(id) from (
      select station->>'id' as id from jsonb_array_elements(v_stations) as station where station ? 'id'
      union
      select jsonb_array_elements_text(v_station_ids_to_delete)
    ) ids), '[]'::jsonb), true);
  end if;
  if jsonb_array_length(v_pricing_rules) > 0 or jsonb_array_length(v_pricing_rule_ids_to_delete) > 0 then
    v_changed_rows := jsonb_set(v_changed_rows, '{pricing_rules}', coalesce((select jsonb_agg(id) from (
      select rule->>'id' as id from jsonb_array_elements(v_pricing_rules) as rule where rule ? 'id'
      union
      select jsonb_array_elements_text(v_pricing_rule_ids_to_delete)
    ) ids), '[]'::jsonb), true);
  end if;
  if jsonb_array_length(v_customers) > 0 or jsonb_array_length(v_customer_ids_to_delete) > 0 then
    v_changed_rows := jsonb_set(v_changed_rows, '{customers}', coalesce((select jsonb_agg(id) from (
      select customer->>'id' as id from jsonb_array_elements(v_customers) as customer where customer ? 'id'
      union
      select jsonb_array_elements_text(v_customer_ids_to_delete)
    ) ids), '[]'::jsonb), true);
  end if;

  begin
    v_updated_by := v_user_id::uuid;
  exception when invalid_text_representation then
    v_updated_by := null;
  end;

  update public.app_state
  set
    data = v_next_app_state_data,
    version = v_app_state_version + 1,
    updated_at = timezone('utc', now()),
    updated_by = v_updated_by
  where id = 'primary'
  returning app_state.version into v_next_app_state_version;

  v_server_duration_ms := extract(epoch from (clock_timestamp() - v_started_at)) * 1000;
  v_event_metadata := jsonb_build_object(
    'mutation_id', v_mutation_id,
    'mutation_kind', v_mutation_kind,
    'client_created_at', v_client_created_at,
    'app_state_version', v_next_app_state_version,
    'server_duration_ms', v_server_duration_ms,
    'requires_full_refresh', true,
    'changed_rows', v_changed_rows
  );

  insert into public.operational_events (
    organization_id,
    event_type,
    entity_type,
    entity_id,
    entity_version,
    created_by,
    metadata
  )
  values (
    v_organization_id,
    'admin_data_committed',
    'admin_data',
    v_entity_id,
    v_next_app_state_version,
    v_user_id,
    v_event_metadata
  )
  returning id into v_event_id;

  return jsonb_build_object(
    'mutation_id', v_mutation_id,
    'organization_id', v_organization_id,
    'entity_type', 'admin_data',
    'entity_id', v_entity_id,
    'app_state_version', v_next_app_state_version,
    'event_id', v_event_id,
    'server_time', timezone('utc', now()),
    'server_duration_ms', v_server_duration_ms,
    'changed_rows', v_changed_rows
  );
end;
$$;

revoke all on function public.commit_admin_data_change(jsonb) from public;
revoke execute on function public.commit_admin_data_change(jsonb) from anon;
grant execute on function public.commit_admin_data_change(jsonb) to authenticated;
