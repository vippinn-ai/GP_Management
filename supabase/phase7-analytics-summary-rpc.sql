-- Phase 7: compact Analytics summary read model.
--
-- Run after the normalized schema and Phase 4-6 RPC scripts are installed.
-- This script is additive and idempotent: it does not remove app_state or
-- change existing operational/financial RPC contracts.

create table if not exists public.analytics_daily_summary (
  organization_id text not null references public.organizations (id) on delete cascade,
  business_date date not null,
  gross_revenue numeric(12, 2) not null default 0,
  paid_bill_count integer not null default 0,
  session_revenue numeric(12, 2) not null default 0,
  item_revenue numeric(12, 2) not null default 0,
  total_discounts numeric(12, 2) not null default 0,
  pending_revenue numeric(12, 2) not null default 0,
  deferred_outstanding numeric(12, 2) not null default 0,
  one_time_expenses numeric(12, 2) not null default 0,
  payment_cash numeric(12, 2) not null default 0,
  payment_upi numeric(12, 2) not null default 0,
  expense_cash numeric(12, 2) not null default 0,
  expense_upi numeric(12, 2) not null default 0,
  expense_unknown numeric(12, 2) not null default 0,
  refreshed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, business_date)
);

create table if not exists public.analytics_daily_channels (
  organization_id text not null references public.organizations (id) on delete cascade,
  business_date date not null,
  channel_key text not null,
  channel_label text not null,
  amount numeric(12, 2) not null default 0,
  refreshed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, business_date, channel_key)
);

create table if not exists public.analytics_daily_expense_categories (
  organization_id text not null references public.organizations (id) on delete cascade,
  business_date date not null,
  category text not null,
  amount numeric(12, 2) not null default 0,
  cash_amount numeric(12, 2) not null default 0,
  upi_amount numeric(12, 2) not null default 0,
  unknown_amount numeric(12, 2) not null default 0,
  refreshed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, business_date, category)
);

-- Used only inside load_analytics_summary to count distinct paid bills across
-- multi-day ranges without double-counting bills paid on multiple days.
create table if not exists public.analytics_daily_paid_bills (
  organization_id text not null references public.organizations (id) on delete cascade,
  business_date date not null,
  bill_id text not null,
  refreshed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, business_date, bill_id)
);

create table if not exists public.analytics_dirty_dates (
  organization_id text not null references public.organizations (id) on delete cascade,
  business_date date not null,
  reason text not null default 'data_change',
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, business_date)
);

create index if not exists analytics_daily_summary_org_date_idx
on public.analytics_daily_summary (organization_id, business_date);

create index if not exists analytics_daily_channels_org_date_amount_idx
on public.analytics_daily_channels (organization_id, business_date, amount desc);

create index if not exists analytics_daily_expense_categories_org_date_idx
on public.analytics_daily_expense_categories (organization_id, business_date);

create index if not exists analytics_dirty_dates_org_date_idx
on public.analytics_dirty_dates (organization_id, business_date);

create or replace function public.analytics_business_date(value timestamptz)
returns date
language sql
stable
returns null on null input
set search_path = public
as $$
  select (timezone('Asia/Kolkata', value) - interval '7 hours')::date;
$$;

create or replace function public.analytics_local_date(value timestamptz)
returns date
language sql
stable
returns null on null input
set search_path = public
as $$
  select timezone('Asia/Kolkata', value)::date;
$$;

create or replace function public.mark_analytics_dirty_date(
  p_organization_id text,
  p_business_date date,
  p_reason text default 'data_change'
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

  insert into public.analytics_dirty_dates (organization_id, business_date, reason, updated_at)
  values (p_organization_id, p_business_date, coalesce(nullif(p_reason, ''), 'data_change'), timezone('utc', now()))
  on conflict (organization_id, business_date) do update
  set reason = excluded.reason,
      updated_at = excluded.updated_at;
end;
$$;

create or replace function public.mark_analytics_dirty_dates_for_bill(
  p_organization_id text,
  p_bill_id text,
  p_reason text default 'bill_change'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_date date;
begin
  if p_organization_id is null or p_bill_id is null then
    return;
  end if;

  select coalesce(
    public.analytics_business_date(session_by_id.started_at),
    public.analytics_business_date(session_by_bill.started_at),
    public.analytics_business_date(tab_by_bill.opened_at),
    public.analytics_business_date(bills.issued_at),
    public.analytics_business_date(bills.created_at)
  )
  into v_business_date
  from public.bills
  left join public.sessions as session_by_id
    on session_by_id.organization_id = bills.organization_id
   and session_by_id.id = bills.session_id
  left join public.sessions as session_by_bill
    on session_by_bill.organization_id = bills.organization_id
   and session_by_bill.closed_bill_id = bills.id
  left join public.customer_tabs as tab_by_bill
    on tab_by_bill.organization_id = bills.organization_id
   and tab_by_bill.closed_bill_id = bills.id
  where bills.organization_id = p_organization_id
    and bills.id = p_bill_id
  limit 1;

  perform public.mark_analytics_dirty_date(p_organization_id, v_business_date, p_reason);

  for v_business_date in
    select distinct public.analytics_business_date(payments.paid_at)
    from public.payments
    where payments.organization_id = p_organization_id
      and payments.bill_id = p_bill_id
      and payments.paid_at is not null
  loop
    perform public.mark_analytics_dirty_date(p_organization_id, v_business_date, p_reason);
  end loop;
end;
$$;

create or replace function public.refresh_analytics_for_business_dates(
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

  delete from public.analytics_daily_summary
  where organization_id = p_organization_id
    and business_date = any(v_dates);

  delete from public.analytics_daily_channels
  where organization_id = p_organization_id
    and business_date = any(v_dates);

  delete from public.analytics_daily_expense_categories
  where organization_id = p_organization_id
    and business_date = any(v_dates);

  delete from public.analytics_daily_paid_bills
  where organization_id = p_organization_id
    and business_date = any(v_dates);

  with target_dates as (
    select unnest(v_dates) as business_date
  ),
  bill_sources as (
    select
      bills.organization_id,
      bills.id,
      bills.status,
      bills.amount_due,
      bills.total,
      coalesce(
        public.analytics_business_date(session_by_id.started_at),
        public.analytics_business_date(session_by_bill.started_at),
        public.analytics_business_date(tab_by_bill.opened_at),
        public.analytics_business_date(bills.issued_at),
        public.analytics_business_date(bills.created_at)
      ) as business_date
    from public.bills
    left join public.sessions as session_by_id
      on session_by_id.organization_id = bills.organization_id
     and session_by_id.id = bills.session_id
    left join public.sessions as session_by_bill
      on session_by_bill.organization_id = bills.organization_id
     and session_by_bill.closed_bill_id = bills.id
    left join public.customer_tabs as tab_by_bill
      on tab_by_bill.organization_id = bills.organization_id
     and tab_by_bill.closed_bill_id = bills.id
    where bills.organization_id = p_organization_id
  ),
  pending_summary as (
    select
      business_date,
      sum(amount_due) filter (where status = 'pending' and amount_due > 0) as pending_revenue
    from bill_sources
    where business_date = any(v_dates)
    group by business_date
  ),
  line_totals as (
    select
      bill_lines.organization_id,
      bill_lines.bill_id,
      sum(bill_lines.total) filter (where bill_lines.type in ('session_charge', 'combo_package')) as session_line_total,
      sum(bill_lines.total) filter (where bill_lines.type = 'inventory_item') as item_line_total
    from public.bill_lines
    where bill_lines.organization_id = p_organization_id
    group by bill_lines.organization_id, bill_lines.bill_id
  ),
  payment_allocations as (
    select
      payments.organization_id,
      public.analytics_business_date(payments.paid_at) as business_date,
      payments.bill_id,
      payments.mode,
      payments.amount as payment_amount,
      bills.station_id,
      bills.total as bill_total,
      bills.total_discount_amount,
      coalesce(line_totals.session_line_total, 0) as session_line_total,
      coalesce(line_totals.item_line_total, 0) as item_line_total
    from public.payments
    join public.bills
      on bills.organization_id = payments.organization_id
     and bills.id = payments.bill_id
    left join line_totals
      on line_totals.organization_id = payments.organization_id
     and line_totals.bill_id = payments.bill_id
    where payments.organization_id = p_organization_id
      and payments.bill_id is not null
      and payments.paid_at is not null
      and public.analytics_business_date(payments.paid_at) = any(v_dates)
      and bills.status in ('issued', 'pending')
      and payments.amount > 0
      and bills.total > 0
  ),
  payment_summary as (
    select
      business_date,
      sum(payment_amount) as gross_revenue,
      count(distinct bill_id) as paid_bill_count,
      sum(session_line_total * payment_amount / bill_total) as session_revenue,
      sum(item_line_total * payment_amount / bill_total) as item_revenue,
      sum(total_discount_amount * payment_amount / bill_total) as total_discounts,
      sum(payment_amount) filter (where mode = 'cash') as payment_cash,
      sum(payment_amount) filter (where mode = 'upi') as payment_upi
    from payment_allocations
    group by business_date
  ),
  expense_rows as (
    select
      expenses.organization_id,
      public.analytics_local_date(expenses.spent_at) as business_date,
      coalesce(nullif(expenses.category, ''), 'Uncategorized') as category,
      expenses.amount,
      case
        when expenses.payment_mode = 'cash' then expenses.amount
        when expenses.payment_mode = 'split' and coalesce(expenses.cash_amount, 0) + coalesce(expenses.upi_amount, 0) > 0 then coalesce(expenses.cash_amount, 0)
        else 0
      end as cash_amount,
      case
        when expenses.payment_mode = 'upi' then expenses.amount
        when expenses.payment_mode = 'split' and coalesce(expenses.cash_amount, 0) + coalesce(expenses.upi_amount, 0) > 0 then coalesce(expenses.upi_amount, 0)
        else 0
      end as upi_amount,
      case
        when expenses.payment_mode in ('cash', 'upi') then 0
        when expenses.payment_mode = 'split' and coalesce(expenses.cash_amount, 0) + coalesce(expenses.upi_amount, 0) > 0 then 0
        else expenses.amount
      end as unknown_amount
    from public.expenses
    where expenses.organization_id = p_organization_id
      and expenses.spent_at is not null
      and public.analytics_local_date(expenses.spent_at) = any(v_dates)
  ),
  expense_summary as (
    select
      business_date,
      sum(amount) as one_time_expenses,
      sum(cash_amount) as expense_cash,
      sum(upi_amount) as expense_upi,
      sum(unknown_amount) as expense_unknown
    from expense_rows
    group by business_date
  )
  insert into public.analytics_daily_summary (
    organization_id,
    business_date,
    gross_revenue,
    paid_bill_count,
    session_revenue,
    item_revenue,
    total_discounts,
    pending_revenue,
    deferred_outstanding,
    one_time_expenses,
    payment_cash,
    payment_upi,
    expense_cash,
    expense_upi,
    expense_unknown,
    refreshed_at
  )
  select
    p_organization_id,
    target_dates.business_date,
    coalesce(payment_summary.gross_revenue, 0),
    coalesce(payment_summary.paid_bill_count, 0),
    coalesce(payment_summary.session_revenue, 0),
    coalesce(payment_summary.item_revenue, 0),
    coalesce(payment_summary.total_discounts, 0),
    coalesce(pending_summary.pending_revenue, 0),
    coalesce(pending_summary.pending_revenue, 0),
    coalesce(expense_summary.one_time_expenses, 0),
    coalesce(payment_summary.payment_cash, 0),
    coalesce(payment_summary.payment_upi, 0),
    coalesce(expense_summary.expense_cash, 0),
    coalesce(expense_summary.expense_upi, 0),
    coalesce(expense_summary.expense_unknown, 0),
    timezone('utc', now())
  from target_dates
  left join payment_summary on payment_summary.business_date = target_dates.business_date
  left join pending_summary on pending_summary.business_date = target_dates.business_date
  left join expense_summary on expense_summary.business_date = target_dates.business_date;

  with payment_allocations as (
    select
      payments.organization_id,
      public.analytics_business_date(payments.paid_at) as business_date,
      payments.bill_id,
      payments.amount as payment_amount,
      bills.station_id,
      bills.total as bill_total
    from public.payments
    join public.bills
      on bills.organization_id = payments.organization_id
     and bills.id = payments.bill_id
    where payments.organization_id = p_organization_id
      and payments.bill_id is not null
      and payments.paid_at is not null
      and public.analytics_business_date(payments.paid_at) = any(v_dates)
      and bills.status in ('issued', 'pending')
      and payments.amount > 0
      and bills.total > 0
  )
  insert into public.analytics_daily_paid_bills (organization_id, business_date, bill_id, refreshed_at)
  select distinct organization_id, business_date, bill_id, timezone('utc', now())
  from payment_allocations;

  with payment_channels as (
    select
      payments.organization_id,
      public.analytics_business_date(payments.paid_at) as business_date,
      case
        when bills.station_id is not null then 'station:' || bills.station_id
        else 'customer_tab'
      end as channel_key,
      case
        when bills.station_id is not null then coalesce(stations.name, 'Unknown station')
        else 'Customer tab'
      end as channel_label,
      payments.amount
    from public.payments
    join public.bills
      on bills.organization_id = payments.organization_id
     and bills.id = payments.bill_id
    left join public.stations
      on stations.organization_id = bills.organization_id
     and stations.id = bills.station_id
    where payments.organization_id = p_organization_id
      and payments.bill_id is not null
      and payments.paid_at is not null
      and public.analytics_business_date(payments.paid_at) = any(v_dates)
      and bills.status in ('issued', 'pending')
      and payments.amount > 0
      and bills.total > 0
  )
  insert into public.analytics_daily_channels (
    organization_id,
    business_date,
    channel_key,
    channel_label,
    amount,
    refreshed_at
  )
  select
    organization_id,
    business_date,
    channel_key,
    channel_label,
    sum(amount),
    timezone('utc', now())
  from payment_channels
  group by organization_id, business_date, channel_key, channel_label
  having sum(amount) > 0;

  with expense_rows as (
    select
      expenses.organization_id,
      public.analytics_local_date(expenses.spent_at) as business_date,
      coalesce(nullif(expenses.category, ''), 'Uncategorized') as category,
      expenses.amount,
      case
        when expenses.payment_mode = 'cash' then expenses.amount
        when expenses.payment_mode = 'split' and coalesce(expenses.cash_amount, 0) + coalesce(expenses.upi_amount, 0) > 0 then coalesce(expenses.cash_amount, 0)
        else 0
      end as cash_amount,
      case
        when expenses.payment_mode = 'upi' then expenses.amount
        when expenses.payment_mode = 'split' and coalesce(expenses.cash_amount, 0) + coalesce(expenses.upi_amount, 0) > 0 then coalesce(expenses.upi_amount, 0)
        else 0
      end as upi_amount,
      case
        when expenses.payment_mode in ('cash', 'upi') then 0
        when expenses.payment_mode = 'split' and coalesce(expenses.cash_amount, 0) + coalesce(expenses.upi_amount, 0) > 0 then 0
        else expenses.amount
      end as unknown_amount
    from public.expenses
    where expenses.organization_id = p_organization_id
      and expenses.spent_at is not null
      and public.analytics_local_date(expenses.spent_at) = any(v_dates)
  )
  insert into public.analytics_daily_expense_categories (
    organization_id,
    business_date,
    category,
    amount,
    cash_amount,
    upi_amount,
    unknown_amount,
    refreshed_at
  )
  select
    organization_id,
    business_date,
    category,
    sum(amount),
    sum(cash_amount),
    sum(upi_amount),
    sum(unknown_amount),
    timezone('utc', now())
  from expense_rows
  group by organization_id, business_date, category
  having sum(amount) > 0;

  delete from public.analytics_dirty_dates
  where organization_id = p_organization_id
    and business_date = any(v_dates);

  v_refreshed := coalesce(array_length(v_dates, 1), 0);
  return jsonb_build_object('refreshed_dates', v_refreshed);
end;
$$;

create or replace function public.backfill_analytics_daily_summary(
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

  return public.refresh_analytics_for_business_dates(p_organization_id, v_dates);
end;
$$;

create or replace function public.load_analytics_summary(
  p_organization_id text,
  p_from_date date,
  p_to_date date,
  p_previous_from_date date,
  p_previous_to_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from date := least(p_from_date, p_to_date);
  v_to date := greatest(p_from_date, p_to_date);
  v_previous_from date := least(p_previous_from_date, p_previous_to_date);
  v_previous_to date := greatest(p_previous_from_date, p_previous_to_date);
  v_refresh_from date := least(v_from, v_previous_from);
  v_refresh_to date := greatest(v_to, v_previous_to);
  v_refresh_dates date[];
  v_today date := public.analytics_business_date(now());
  v_summary jsonb;
  v_top_station jsonb;
  v_expense_by_category jsonb;
  v_pending_receivables jsonb;
begin
  if p_organization_id is null or not public.current_user_has_org_access(p_organization_id) then
    raise exception using
      errcode = '42501',
      message = 'You do not have access to this organization.';
  end if;

  with requested_days as (
    select day::date as business_date
    from generate_series(v_refresh_from, v_refresh_to, interval '1 day') as day
  ),
  missing_days as (
    select requested_days.business_date
    from requested_days
    left join public.analytics_daily_summary
      on analytics_daily_summary.organization_id = p_organization_id
     and analytics_daily_summary.business_date = requested_days.business_date
    where analytics_daily_summary.business_date is null
  ),
  dirty_days as (
    select business_date
    from public.analytics_dirty_dates
    where organization_id = p_organization_id
      and business_date between v_refresh_from and v_refresh_to
  )
  select array_agg(distinct business_date order by business_date)
  into v_refresh_dates
  from (
    select business_date from missing_days
    union
    select business_date from dirty_days
  ) as dates_to_refresh;

  if coalesce(array_length(v_refresh_dates, 1), 0) > 0 then
    perform public.refresh_analytics_for_business_dates(p_organization_id, v_refresh_dates);
  end if;

  with current_summary as (
    select
      coalesce(sum(gross_revenue), 0) as gross_revenue,
      coalesce(sum(session_revenue), 0) as session_revenue,
      coalesce(sum(item_revenue), 0) as item_revenue,
      coalesce(sum(total_discounts), 0) as total_discounts,
      coalesce(sum(pending_revenue), 0) as pending_revenue,
      coalesce(sum(deferred_outstanding), 0) as deferred_outstanding,
      coalesce(sum(one_time_expenses), 0) as one_time_expenses,
      coalesce(sum(payment_cash), 0) as payment_cash,
      coalesce(sum(payment_upi), 0) as payment_upi,
      coalesce(sum(expense_cash), 0) as expense_cash,
      coalesce(sum(expense_upi), 0) as expense_upi,
      coalesce(sum(expense_unknown), 0) as expense_unknown
    from public.analytics_daily_summary
    where organization_id = p_organization_id
      and business_date between v_from and v_to
  ),
  previous_summary as (
    select coalesce(sum(gross_revenue), 0) as previous_range_revenue
    from public.analytics_daily_summary
    where organization_id = p_organization_id
      and business_date between v_previous_from and v_previous_to
  ),
  paid_bills as (
    select count(distinct bill_id)::integer as paid_bill_count
    from public.analytics_daily_paid_bills
    where organization_id = p_organization_id
      and business_date between v_from and v_to
  )
  select jsonb_build_object(
    'gross_revenue', current_summary.gross_revenue,
    'paid_bill_count', paid_bills.paid_bill_count,
    'session_revenue', current_summary.session_revenue,
    'item_revenue', current_summary.item_revenue,
    'total_discounts', current_summary.total_discounts,
    'pending_revenue', current_summary.pending_revenue,
    'deferred_outstanding', current_summary.deferred_outstanding,
    'one_time_expenses', current_summary.one_time_expenses,
    'previous_range_revenue', previous_summary.previous_range_revenue,
    'payment_mode_totals', jsonb_build_object(
      'cash', current_summary.payment_cash,
      'upi', current_summary.payment_upi
    ),
    'expense_payment_mode_totals', jsonb_build_object(
      'cash', current_summary.expense_cash,
      'upi', current_summary.expense_upi,
      'unknown', current_summary.expense_unknown
    )
  )
  into v_summary
  from current_summary, previous_summary, paid_bills;

  select coalesce(
    (
      select jsonb_build_object('label', channel_label, 'amount', sum(amount))
      from public.analytics_daily_channels
      where organization_id = p_organization_id
        and business_date between v_from and v_to
      group by channel_key, channel_label
      order by sum(amount) desc, channel_label asc
      limit 1
    ),
    jsonb_build_object('label', null, 'amount', 0)
  )
  into v_top_station;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('category', category, 'amount', amount)
      order by amount desc, category asc
    ),
    '[]'::jsonb
  )
  into v_expense_by_category
  from (
    select category, sum(amount) as amount
    from public.analytics_daily_expense_categories
    where organization_id = p_organization_id
      and business_date between v_from and v_to
    group by category
    having sum(amount) > 0
  ) as categories;

  with pending as (
    select
      bills.id as bill_id,
      bills.bill_number,
      coalesce(
        public.analytics_business_date(session_by_id.started_at),
        public.analytics_business_date(session_by_bill.started_at),
        public.analytics_business_date(tab_by_bill.opened_at),
        public.analytics_business_date(bills.issued_at),
        public.analytics_business_date(bills.created_at)
      ) as business_date,
      bills.issued_at,
      bills.customer_id,
      bills.customer_name,
      bills.customer_phone,
      bills.station_id,
      bills.session_id,
      bills.total,
      bills.amount_paid,
      bills.amount_due
    from public.bills
    left join public.sessions as session_by_id
      on session_by_id.organization_id = bills.organization_id
     and session_by_id.id = bills.session_id
    left join public.sessions as session_by_bill
      on session_by_bill.organization_id = bills.organization_id
     and session_by_bill.closed_bill_id = bills.id
    left join public.customer_tabs as tab_by_bill
      on tab_by_bill.organization_id = bills.organization_id
     and tab_by_bill.closed_bill_id = bills.id
    where bills.organization_id = p_organization_id
      and bills.status = 'pending'
      and bills.amount_due > 0
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'bill_id', bill_id,
        'bill_number', bill_number,
        'business_date', business_date::text,
        'days_overdue', greatest(0, v_today - business_date),
        'issued_at', issued_at,
        'customer_id', customer_id,
        'customer_name', customer_name,
        'customer_phone', customer_phone,
        'station_id', station_id,
        'session_id', session_id,
        'total', total,
        'amount_paid', amount_paid,
        'amount_due', amount_due
      )
      order by greatest(0, v_today - business_date) desc, business_date asc, bill_number asc
    ),
    '[]'::jsonb
  )
  into v_pending_receivables
  from pending;

  return jsonb_build_object(
    'summary', v_summary,
    'top_station', v_top_station,
    'expense_by_category', v_expense_by_category,
    'pending_receivables', v_pending_receivables
  );
end;
$$;

create or replace function public.mark_analytics_dirty_from_bill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.mark_analytics_dirty_dates_for_bill(old.organization_id, old.id, 'bill_change');
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.mark_analytics_dirty_dates_for_bill(new.organization_id, new.id, 'bill_change');
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.mark_analytics_dirty_from_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.mark_analytics_dirty_date(old.organization_id, public.analytics_business_date(old.paid_at), 'payment_change');
    perform public.mark_analytics_dirty_dates_for_bill(old.organization_id, old.bill_id, 'payment_change');
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.mark_analytics_dirty_date(new.organization_id, public.analytics_business_date(new.paid_at), 'payment_change');
    perform public.mark_analytics_dirty_dates_for_bill(new.organization_id, new.bill_id, 'payment_change');
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.mark_analytics_dirty_from_bill_child()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.mark_analytics_dirty_dates_for_bill(old.organization_id, old.bill_id, 'bill_detail_change');
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.mark_analytics_dirty_dates_for_bill(new.organization_id, new.bill_id, 'bill_detail_change');
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.mark_analytics_dirty_from_expense()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.mark_analytics_dirty_date(old.organization_id, public.analytics_local_date(old.spent_at), 'expense_change');
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.mark_analytics_dirty_date(new.organization_id, public.analytics_local_date(new.spent_at), 'expense_change');
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.mark_analytics_dirty_from_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.mark_analytics_dirty_date(old.organization_id, public.analytics_business_date(old.started_at), 'session_change');
    perform public.mark_analytics_dirty_dates_for_bill(old.organization_id, old.closed_bill_id, 'session_change');
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.mark_analytics_dirty_date(new.organization_id, public.analytics_business_date(new.started_at), 'session_change');
    perform public.mark_analytics_dirty_dates_for_bill(new.organization_id, new.closed_bill_id, 'session_change');
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.mark_analytics_dirty_from_customer_tab()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.mark_analytics_dirty_date(old.organization_id, public.analytics_business_date(old.opened_at), 'customer_tab_change');
    perform public.mark_analytics_dirty_dates_for_bill(old.organization_id, old.closed_bill_id, 'customer_tab_change');
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.mark_analytics_dirty_date(new.organization_id, public.analytics_business_date(new.opened_at), 'customer_tab_change');
    perform public.mark_analytics_dirty_dates_for_bill(new.organization_id, new.closed_bill_id, 'customer_tab_change');
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists bills_analytics_dirty on public.bills;
create trigger bills_analytics_dirty
after insert or update or delete on public.bills
for each row execute function public.mark_analytics_dirty_from_bill();

drop trigger if exists payments_analytics_dirty on public.payments;
create trigger payments_analytics_dirty
after insert or update or delete on public.payments
for each row execute function public.mark_analytics_dirty_from_payment();

drop trigger if exists bill_lines_analytics_dirty on public.bill_lines;
create trigger bill_lines_analytics_dirty
after insert or update or delete on public.bill_lines
for each row execute function public.mark_analytics_dirty_from_bill_child();

drop trigger if exists bill_discounts_analytics_dirty on public.bill_discounts;
create trigger bill_discounts_analytics_dirty
after insert or update or delete on public.bill_discounts
for each row execute function public.mark_analytics_dirty_from_bill_child();

drop trigger if exists bill_line_discounts_analytics_dirty on public.bill_line_discounts;
create trigger bill_line_discounts_analytics_dirty
after insert or update or delete on public.bill_line_discounts
for each row execute function public.mark_analytics_dirty_from_bill_child();

drop trigger if exists expenses_analytics_dirty on public.expenses;
create trigger expenses_analytics_dirty
after insert or update or delete on public.expenses
for each row execute function public.mark_analytics_dirty_from_expense();

drop trigger if exists sessions_analytics_dirty on public.sessions;
create trigger sessions_analytics_dirty
after insert or update or delete on public.sessions
for each row execute function public.mark_analytics_dirty_from_session();

drop trigger if exists customer_tabs_analytics_dirty on public.customer_tabs;
create trigger customer_tabs_analytics_dirty
after insert or update or delete on public.customer_tabs
for each row execute function public.mark_analytics_dirty_from_customer_tab();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'analytics_daily_summary',
    'analytics_daily_channels',
    'analytics_daily_expense_categories',
    'analytics_daily_paid_bills',
    'analytics_dirty_dates'
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

revoke all on function public.refresh_analytics_for_business_dates(text, date[]) from public, anon, authenticated;
revoke all on function public.backfill_analytics_daily_summary(text, date, date) from public, anon, authenticated;
revoke all on function public.load_analytics_summary(text, date, date, date, date) from public, anon, authenticated;
revoke all on function public.analytics_business_date(timestamptz) from public, anon, authenticated;
revoke all on function public.analytics_local_date(timestamptz) from public, anon, authenticated;
revoke all on function public.mark_analytics_dirty_date(text, date, text) from public, anon, authenticated;
revoke all on function public.mark_analytics_dirty_dates_for_bill(text, text, text) from public, anon, authenticated;
revoke all on function public.mark_analytics_dirty_from_bill() from public, anon, authenticated;
revoke all on function public.mark_analytics_dirty_from_payment() from public, anon, authenticated;
revoke all on function public.mark_analytics_dirty_from_bill_child() from public, anon, authenticated;
revoke all on function public.mark_analytics_dirty_from_expense() from public, anon, authenticated;
revoke all on function public.mark_analytics_dirty_from_session() from public, anon, authenticated;
revoke all on function public.mark_analytics_dirty_from_customer_tab() from public, anon, authenticated;

grant execute on function public.load_analytics_summary(text, date, date, date, date) to authenticated;
