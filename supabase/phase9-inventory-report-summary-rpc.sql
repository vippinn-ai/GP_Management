-- Phase 9: compact Inventory Report read model.
--
-- Run after the normalized schema and Phase 4-8 RPC scripts are installed,
-- including the Phase 7 analytics date helpers.
-- This script is additive and idempotent. It keeps stock_movements as the
-- historical source of truth and stores compact report rows for low-egress
-- Inventory Report reads.

create table if not exists public.inventory_daily_item_summary (
  organization_id text not null references public.organizations (id) on delete cascade,
  business_date date not null,
  item_id text not null,
  added numeric(14, 3) not null default 0,
  deducted numeric(14, 3) not null default 0,
  manual_adjustments numeric(14, 3) not null default 0,
  reversals numeric(14, 3) not null default 0,
  net_change numeric(14, 3) not null default 0,
  movement_count integer not null default 0,
  refreshed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, business_date, item_id)
);

create table if not exists public.inventory_report_movements (
  organization_id text not null references public.organizations (id) on delete cascade,
  movement_id text not null,
  business_date date not null,
  item_id text not null,
  type text not null,
  quantity numeric(14, 3) not null default 0,
  reason text,
  movement_at timestamptz not null,
  user_id text,
  related_bill_id text,
  refreshed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, movement_id)
);

create table if not exists public.inventory_report_dirty_dates (
  organization_id text not null references public.organizations (id) on delete cascade,
  business_date date not null,
  reason text not null default 'stock_movement_change',
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, business_date)
);

-- Tracks dates that were refreshed even when they had zero movement rows.
-- Without this marker, empty days would be considered missing on every load.
create table if not exists public.inventory_report_refreshed_dates (
  organization_id text not null references public.organizations (id) on delete cascade,
  business_date date not null,
  refreshed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, business_date)
);

create index if not exists inventory_daily_item_summary_org_date_idx
on public.inventory_daily_item_summary (organization_id, business_date);

create index if not exists inventory_daily_item_summary_org_item_date_idx
on public.inventory_daily_item_summary (organization_id, item_id, business_date);

create index if not exists inventory_report_movements_org_date_time_idx
on public.inventory_report_movements (organization_id, business_date, movement_at desc, movement_id desc);

create index if not exists inventory_report_movements_org_item_date_idx
on public.inventory_report_movements (organization_id, item_id, business_date);

create index if not exists inventory_report_dirty_dates_org_date_idx
on public.inventory_report_dirty_dates (organization_id, business_date);

create index if not exists inventory_report_refreshed_dates_org_date_idx
on public.inventory_report_refreshed_dates (organization_id, business_date);

create or replace function public.mark_inventory_report_dirty_date(
  p_organization_id text,
  p_business_date date,
  p_reason text default 'stock_movement_change'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_organization_id is null or p_business_date is null then
    return;
  end if;

  insert into public.inventory_report_dirty_dates (organization_id, business_date, reason, updated_at)
  values (p_organization_id, p_business_date, coalesce(nullif(p_reason, ''), 'stock_movement_change'), timezone('utc', now()))
  on conflict (organization_id, business_date) do update
  set reason = excluded.reason,
      updated_at = excluded.updated_at;
end;
$$;

create or replace function public.refresh_inventory_report_for_business_dates(
  p_organization_id text,
  p_business_dates date[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dates date[];
  v_refreshed integer;
begin
  select array_agg(distinct business_date order by business_date)
  into v_dates
  from unnest(coalesce(p_business_dates, '{}'::date[])) as dates(business_date)
  where business_date is not null;

  if p_organization_id is null or coalesce(array_length(v_dates, 1), 0) = 0 then
    return jsonb_build_object('refreshed_dates', 0);
  end if;

  delete from public.inventory_daily_item_summary
  where organization_id = p_organization_id
    and business_date = any(v_dates);

  delete from public.inventory_report_movements
  where organization_id = p_organization_id
    and business_date = any(v_dates);

  insert into public.inventory_report_movements (
    organization_id,
    movement_id,
    business_date,
    item_id,
    type,
    quantity,
    reason,
    movement_at,
    user_id,
    related_bill_id,
    refreshed_at
  )
  select
    stock_movements.organization_id,
    stock_movements.id,
    public.analytics_business_date(coalesce(stock_movements.movement_at, stock_movements.created_at)),
    stock_movements.item_id,
    stock_movements.type,
    stock_movements.quantity,
    stock_movements.reason,
    coalesce(stock_movements.movement_at, stock_movements.created_at),
    stock_movements.user_id,
    stock_movements.related_bill_id,
    timezone('utc', now())
  from public.stock_movements
  where stock_movements.organization_id = p_organization_id
    and stock_movements.item_id is not null
    and public.analytics_business_date(coalesce(stock_movements.movement_at, stock_movements.created_at)) = any(v_dates);

  insert into public.inventory_daily_item_summary (
    organization_id,
    business_date,
    item_id,
    added,
    deducted,
    manual_adjustments,
    reversals,
    net_change,
    movement_count,
    refreshed_at
  )
  select
    organization_id,
    business_date,
    item_id,
    coalesce(sum(greatest(quantity, 0)) filter (where type = 'restock'), 0),
    coalesce(sum(abs(quantity)) filter (where type = 'sale'), 0),
    coalesce(sum(quantity) filter (where type = 'adjustment'), 0),
    coalesce(sum(greatest(quantity, 0)) filter (where type = 'void_refund_reversal'), 0),
    coalesce(sum(quantity) filter (where type in ('restock', 'sale', 'adjustment', 'void_refund_reversal')), 0),
    count(*)::integer,
    timezone('utc', now())
  from public.inventory_report_movements
  where organization_id = p_organization_id
    and business_date = any(v_dates)
  group by organization_id, business_date, item_id;

  insert into public.inventory_report_refreshed_dates (organization_id, business_date, refreshed_at)
  select p_organization_id, business_date, timezone('utc', now())
  from unnest(v_dates) as dates(business_date)
  on conflict (organization_id, business_date) do update
  set refreshed_at = excluded.refreshed_at,
      updated_at = excluded.refreshed_at;

  delete from public.inventory_report_dirty_dates
  where organization_id = p_organization_id
    and business_date = any(v_dates);

  v_refreshed := coalesce(array_length(v_dates, 1), 0);
  return jsonb_build_object('refreshed_dates', v_refreshed);
end;
$$;

create or replace function public.backfill_inventory_report_summary(
  p_organization_id text,
  p_from_date date,
  p_to_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from date := least(p_from_date, p_to_date);
  v_to date := greatest(p_from_date, p_to_date);
  v_dates date[];
begin
  select array_agg(day::date order by day::date)
  into v_dates
  from generate_series(v_from, v_to, interval '1 day') as day;

  return public.refresh_inventory_report_for_business_dates(p_organization_id, v_dates);
end;
$$;

create or replace function public.load_inventory_report_summary(
  p_organization_id text,
  p_from_date date,
  p_to_date date,
  p_search_query text default '',
  p_detail_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from date := least(p_from_date, p_to_date);
  v_to date := greatest(p_from_date, p_to_date);
  v_search text := nullif(lower(trim(coalesce(p_search_query, ''))), '');
  v_limit integer := greatest(1, least(coalesce(p_detail_limit, 500), 500));
  v_refresh_dates date[];
  v_summary jsonb;
  v_rows jsonb;
  v_details jsonb;
  v_details_truncated boolean := false;
begin
  if p_organization_id is null or not public.current_user_has_org_access(p_organization_id) then
    raise exception using
      errcode = '42501',
      message = 'You do not have access to this organization.';
  end if;

  with requested_days as (
    select day::date as business_date
    from generate_series(v_from, v_to, interval '1 day') as day
  ),
  missing_days as (
    select requested_days.business_date
    from requested_days
    left join public.inventory_report_refreshed_dates
      on inventory_report_refreshed_dates.organization_id = p_organization_id
     and inventory_report_refreshed_dates.business_date = requested_days.business_date
    where inventory_report_refreshed_dates.business_date is null
  ),
  dirty_days as (
    select business_date
    from public.inventory_report_dirty_dates
    where organization_id = p_organization_id
      and business_date between v_from and v_to
  )
  select array_agg(distinct business_date order by business_date)
  into v_refresh_dates
  from (
    select business_date from missing_days
    union
    select business_date from dirty_days
  ) as dates_to_refresh;

  if coalesce(array_length(v_refresh_dates, 1), 0) > 0 then
    perform public.refresh_inventory_report_for_business_dates(p_organization_id, v_refresh_dates);
  end if;

  with current_items as (
    select
      inventory_items.id as item_id,
      inventory_items.name as item_name,
      coalesce(nullif(inventory_items.category, ''), 'Uncategorized') as category,
      inventory_items.active,
      inventory_items.stock_qty as current_stock
    from public.inventory_items
    where inventory_items.organization_id = p_organization_id
  ),
  reserved as (
    select inventory_item_id as item_id, sum(quantity * coalesce(stock_units_per_sale, sold_as_pack_of, 1)) as reserved
    from public.session_items
    join public.sessions
      on sessions.organization_id = session_items.organization_id
     and sessions.id = session_items.session_id
    where session_items.organization_id = p_organization_id
      and sessions.status <> 'closed'
      and session_items.inventory_item_id is not null
    group by inventory_item_id
    union all
    select inventory_item_id as item_id, sum(quantity * coalesce(stock_units_per_sale, sold_as_pack_of, 1)) as reserved
    from public.customer_tab_items
    join public.customer_tabs
      on customer_tabs.organization_id = customer_tab_items.organization_id
     and customer_tabs.id = customer_tab_items.customer_tab_id
    where customer_tab_items.organization_id = p_organization_id
      and customer_tabs.status = 'open'
      and customer_tab_items.inventory_item_id is not null
    group by inventory_item_id
  ),
  reserved_by_item as (
    select item_id, sum(reserved) as reserved
    from reserved
    group by item_id
  ),
  item_summary as (
    select
      item_id,
      sum(added) as added,
      sum(deducted) as deducted,
      sum(manual_adjustments) as manual_adjustments,
      sum(reversals) as reversals,
      sum(net_change) as net_change,
      sum(movement_count)::integer as movement_count
    from public.inventory_daily_item_summary
    where organization_id = p_organization_id
      and business_date between v_from and v_to
    group by item_id
  ),
  movement_rows as (
    select
      inventory_report_movements.*,
      current_items.item_name,
      current_items.category,
      bills.bill_number
    from public.inventory_report_movements
    join current_items on current_items.item_id = inventory_report_movements.item_id
    left join public.bills
      on bills.organization_id = inventory_report_movements.organization_id
     and bills.id = inventory_report_movements.related_bill_id
    where inventory_report_movements.organization_id = p_organization_id
      and inventory_report_movements.business_date between v_from and v_to
  ),
  matching_movements as (
    select *
    from movement_rows
    where v_search is null
       or lower(coalesce(item_name, '')) like '%' || v_search || '%'
       or lower(coalesce(category, '')) like '%' || v_search || '%'
       or lower(coalesce(type, '')) like '%' || v_search || '%'
       or lower(coalesce(reason, '')) like '%' || v_search || '%'
       or lower(coalesce(bill_number, '')) like '%' || v_search || '%'
       or lower(coalesce(related_bill_id, '')) like '%' || v_search || '%'
  ),
  search_item_matches as (
    select item_id
    from current_items
    where v_search is not null
      and (
        lower(coalesce(item_name, '')) like '%' || v_search || '%'
        or lower(coalesce(category, '')) like '%' || v_search || '%'
      )
  ),
  search_summary as (
    select
      item_id,
      coalesce(sum(greatest(quantity, 0)) filter (where type = 'restock'), 0) as added,
      coalesce(sum(abs(quantity)) filter (where type = 'sale'), 0) as deducted,
      coalesce(sum(quantity) filter (where type = 'adjustment'), 0) as manual_adjustments,
      coalesce(sum(greatest(quantity, 0)) filter (where type = 'void_refund_reversal'), 0) as reversals,
      coalesce(sum(quantity) filter (where type in ('restock', 'sale', 'adjustment', 'void_refund_reversal')), 0) as net_change,
      count(*)::integer as movement_count
    from matching_movements
    where v_search is not null
    group by item_id
  ),
  combined_summary as (
    select * from item_summary where v_search is null
    union all
    select * from search_summary where v_search is not null
  ),
  row_values as (
    select
      current_items.item_id,
      current_items.item_name,
      current_items.category,
      current_items.active,
      coalesce(combined_summary.added, 0) as added,
      coalesce(combined_summary.deducted, 0) as deducted,
      coalesce(combined_summary.manual_adjustments, 0) as manual_adjustments,
      coalesce(combined_summary.reversals, 0) as reversals,
      coalesce(combined_summary.net_change, 0) as net_change,
      current_items.current_stock,
      coalesce(reserved_by_item.reserved, 0) as reserved,
      coalesce(combined_summary.movement_count, 0) as movement_count
    from current_items
    left join combined_summary on combined_summary.item_id = current_items.item_id
    left join reserved_by_item on reserved_by_item.item_id = current_items.item_id
    where (
        coalesce(combined_summary.movement_count, 0) > 0
        or coalesce(reserved_by_item.reserved, 0) > 0
      )
      and (
        v_search is null
        or current_items.item_id in (select item_id from search_item_matches)
        or coalesce(combined_summary.movement_count, 0) > 0
      )
  )
  select
    jsonb_build_object(
      'added', coalesce(sum(added), 0),
      'deducted', coalesce(sum(deducted), 0),
      'manual_adjustments', coalesce(sum(manual_adjustments), 0),
      'reversals', coalesce(sum(reversals), 0),
      'net_change', coalesce(sum(net_change), 0),
      'reserved', coalesce(sum(reserved), 0),
      'touched_items', count(*) filter (where movement_count > 0)
    ),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'item_id', item_id,
          'item_name', item_name,
          'category', category,
          'active', active,
          'added', added,
          'deducted', deducted,
          'manual_adjustments', manual_adjustments,
          'reversals', reversals,
          'net_change', net_change,
          'current_stock', current_stock,
          'reserved', reserved,
          'movement_count', movement_count
        )
        order by movement_count desc, item_name asc
      ),
      '[]'::jsonb
    )
  into v_summary, v_rows
  from row_values;

  with current_items as (
    select
      inventory_items.id as item_id,
      inventory_items.name as item_name,
      coalesce(nullif(inventory_items.category, ''), 'Uncategorized') as category
    from public.inventory_items
    where inventory_items.organization_id = p_organization_id
  ),
  movement_rows as (
    select
      inventory_report_movements.*,
      current_items.item_name,
      current_items.category,
      bills.bill_number
    from public.inventory_report_movements
    join current_items on current_items.item_id = inventory_report_movements.item_id
    left join public.bills
      on bills.organization_id = inventory_report_movements.organization_id
     and bills.id = inventory_report_movements.related_bill_id
    where inventory_report_movements.organization_id = p_organization_id
      and inventory_report_movements.business_date between v_from and v_to
      and (
        v_search is null
        or lower(coalesce(current_items.item_name, '')) like '%' || v_search || '%'
        or lower(coalesce(current_items.category, '')) like '%' || v_search || '%'
        or lower(coalesce(inventory_report_movements.type, '')) like '%' || v_search || '%'
        or lower(coalesce(inventory_report_movements.reason, '')) like '%' || v_search || '%'
        or lower(coalesce(bills.bill_number, '')) like '%' || v_search || '%'
        or lower(coalesce(inventory_report_movements.related_bill_id, '')) like '%' || v_search || '%'
      )
  ),
  limited_movements as (
    select *
    from movement_rows
    order by movement_at desc, movement_id desc
    limit v_limit
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', movement_id,
        'business_date', business_date,
        'created_at', movement_at,
        'item_id', item_id,
        'item_name', item_name,
        'category', category,
        'type', type,
        'quantity', quantity,
        'reason', reason,
        'related_bill_id', related_bill_id,
        'related_bill_number', bill_number
      )
      order by movement_at desc, movement_id desc
    ),
    '[]'::jsonb
  )
  into v_details
  from limited_movements;

  with current_items as (
    select inventory_items.id as item_id, inventory_items.name as item_name, coalesce(nullif(inventory_items.category, ''), 'Uncategorized') as category
    from public.inventory_items
    where inventory_items.organization_id = p_organization_id
  ),
  matching_movements as (
    select inventory_report_movements.movement_id
    from public.inventory_report_movements
    join current_items on current_items.item_id = inventory_report_movements.item_id
    left join public.bills
      on bills.organization_id = inventory_report_movements.organization_id
     and bills.id = inventory_report_movements.related_bill_id
    where inventory_report_movements.organization_id = p_organization_id
      and inventory_report_movements.business_date between v_from and v_to
      and (
        v_search is null
        or lower(coalesce(current_items.item_name, '')) like '%' || v_search || '%'
        or lower(coalesce(current_items.category, '')) like '%' || v_search || '%'
        or lower(coalesce(inventory_report_movements.type, '')) like '%' || v_search || '%'
        or lower(coalesce(inventory_report_movements.reason, '')) like '%' || v_search || '%'
        or lower(coalesce(bills.bill_number, '')) like '%' || v_search || '%'
        or lower(coalesce(inventory_report_movements.related_bill_id, '')) like '%' || v_search || '%'
      )
    order by inventory_report_movements.movement_at desc, inventory_report_movements.movement_id desc
    offset v_limit
    limit 1
  )
  select exists(select 1 from matching_movements)
  into v_details_truncated;

  return jsonb_build_object(
    'summary', coalesce(v_summary, jsonb_build_object(
      'added', 0,
      'deducted', 0,
      'manual_adjustments', 0,
      'reversals', 0,
      'net_change', 0,
      'reserved', 0,
      'touched_items', 0
    )),
    'rows', coalesce(v_rows, '[]'::jsonb),
    'details', coalesce(v_details, '[]'::jsonb),
    'detail_limit', v_limit,
    'details_truncated', v_details_truncated
  );
end;
$$;

create or replace function public.mark_inventory_report_dirty_from_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.mark_inventory_report_dirty_date(
      old.organization_id,
      public.analytics_business_date(coalesce(old.movement_at, old.created_at)),
      'stock_movement_change'
    );
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    perform public.mark_inventory_report_dirty_date(
      new.organization_id,
      public.analytics_business_date(coalesce(new.movement_at, new.created_at)),
      'stock_movement_change'
    );
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists stock_movements_inventory_report_dirty on public.stock_movements;
create trigger stock_movements_inventory_report_dirty
after insert or update or delete on public.stock_movements
for each row execute procedure public.mark_inventory_report_dirty_from_stock_movement();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'inventory_daily_item_summary',
    'inventory_report_movements',
    'inventory_report_dirty_dates',
    'inventory_report_refreshed_dates'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists normalized_org_access on public.%I', table_name);
    execute format(
      'create policy normalized_org_access on public.%I for all to authenticated using ((select public.current_user_has_org_access(organization_id))) with check ((select public.current_user_has_org_access(organization_id)))',
      table_name
    );
    execute format('drop trigger if exists %I_set_updated_at on public.%I', table_name, table_name);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I for each row execute procedure public.set_updated_at()',
      table_name,
      table_name
    );
  end loop;
end
$$;

revoke all on function public.mark_inventory_report_dirty_date(text, date, text) from public, anon, authenticated;
revoke all on function public.refresh_inventory_report_for_business_dates(text, date[]) from public, anon, authenticated;
revoke all on function public.backfill_inventory_report_summary(text, date, date) from public, anon, authenticated;
revoke all on function public.load_inventory_report_summary(text, date, date, text, integer) from public, anon, authenticated;
revoke all on function public.mark_inventory_report_dirty_from_stock_movement() from public, anon, authenticated;

grant execute on function public.load_inventory_report_summary(text, date, date, text, integer) to authenticated;
