-- Phase 1 normalized side-by-side schema.
-- This adds tenant-aware shadow tables beside public.app_state.
-- It does not modify app_state, does not change the application runtime, and does not add realtime publication entries.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.organizations (
  id text primary key,
  name text not null,
  business_profile jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.organization_members (
  organization_id text not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.app_role not null,
  active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, user_id)
);

create index if not exists organization_members_user_org_idx
on public.organization_members (user_id, organization_id)
where active = true;

create or replace function public.current_user_has_org_access(target_organization_id text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce(
    (
      select organization_members.active
      from public.organization_members
      where organization_members.organization_id = target_organization_id
        and organization_members.user_id = (select auth.uid())
        and organization_members.active = true
      limit 1
    ),
    false
  );
$$;

create or replace function public.current_user_org_role(target_organization_id text)
returns public.app_role
language sql
security definer
set search_path = public
as $$
  select organization_members.role
  from public.organization_members
  where organization_members.organization_id = target_organization_id
    and organization_members.user_id = (select auth.uid())
    and organization_members.active = true
  limit 1;
$$;

grant execute on function public.current_user_has_org_access(text) to authenticated;
grant execute on function public.current_user_org_role(text) to authenticated;

create table if not exists public.inventory_categories (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  name text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id),
  unique (organization_id, name)
);

create table if not exists public.stations (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  name text not null,
  mode text not null default 'timed',
  active boolean not null default true,
  ltp_enabled boolean not null default false,
  notes text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id)
);

create table if not exists public.pricing_rules (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  station_id text,
  label text not null,
  start_minute integer not null default 0,
  end_minute integer not null default 0,
  hourly_rate numeric(12, 2) not null default 0,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id)
);

create table if not exists public.customers (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  name text not null,
  phone text,
  first_seen_at timestamptz,
  last_visit_at timestamptz,
  notes text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id)
);

create table if not exists public.inventory_items (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  name text not null,
  category text,
  price numeric(12, 2) not null default 0,
  stock_qty numeric(12, 3) not null default 0,
  low_stock_threshold numeric(12, 3) not null default 0,
  unit text not null default 'piece',
  is_reusable boolean not null default false,
  barcode text,
  active boolean not null default true,
  archived_at timestamptz,
  archived_by_user_id text,
  archive_reason text,
  sell_base_item boolean not null default true,
  cigarette_pack jsonb,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id)
);

create table if not exists public.sale_variants (
  organization_id text not null references public.organizations (id) on delete cascade,
  inventory_item_id text not null,
  id text not null,
  name text not null,
  price numeric(12, 2) not null default 0,
  stock_units_per_sale numeric(12, 3) not null default 1,
  barcode text,
  active boolean not null default true,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, inventory_item_id, id),
  foreign key (organization_id, inventory_item_id)
    references public.inventory_items (organization_id, id) on delete cascade
);

create table if not exists public.combos (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  name text not null,
  type text not null default 'game',
  active boolean not null default true,
  price numeric(12, 2) not null default 0,
  included_minutes integer not null default 0,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id)
);

create table if not exists public.combo_station_targets (
  organization_id text not null references public.organizations (id) on delete cascade,
  combo_id text not null,
  station_id text not null,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, combo_id, station_id),
  foreign key (organization_id, combo_id)
    references public.combos (organization_id, id) on delete cascade
);

create table if not exists public.combo_fixed_items (
  organization_id text not null references public.organizations (id) on delete cascade,
  combo_id text not null,
  id text not null,
  sellable_option_id text not null,
  quantity numeric(12, 3) not null default 1,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, combo_id, id),
  foreign key (organization_id, combo_id)
    references public.combos (organization_id, id) on delete cascade
);

create table if not exists public.combo_choice_groups (
  organization_id text not null references public.organizations (id) on delete cascade,
  combo_id text not null,
  id text not null,
  label text not null,
  required_quantity integer not null default 1,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, combo_id, id),
  foreign key (organization_id, combo_id)
    references public.combos (organization_id, id) on delete cascade
);

create table if not exists public.combo_choice_options (
  organization_id text not null references public.organizations (id) on delete cascade,
  combo_id text not null,
  choice_group_id text not null,
  option_id text not null,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, combo_id, choice_group_id, option_id),
  foreign key (organization_id, combo_id, choice_group_id)
    references public.combo_choice_groups (organization_id, combo_id, id) on delete cascade
);

create table if not exists public.sessions (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  station_id text,
  station_name_snapshot text,
  mode text not null default 'timed',
  started_at timestamptz,
  ended_at timestamptz,
  status text not null default 'active',
  customer_id text,
  customer_name text,
  customer_phone text,
  play_mode text not null default 'group',
  ltp_eligible boolean not null default false,
  ltp_outcome text,
  ltp_discount_applied boolean,
  pricing_snapshot jsonb not null default '[]'::jsonb,
  pause_log_ids jsonb not null default '[]'::jsonb,
  continued_from_session_ids jsonb,
  closed_bill_id text,
  close_disposition text,
  close_reason text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id)
);

create table if not exists public.session_pause_logs (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  session_id text,
  paused_at timestamptz,
  resumed_at timestamptz,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id),
  foreign key (organization_id, session_id)
    references public.sessions (organization_id, id) on delete cascade
);

create table if not exists public.session_items (
  organization_id text not null references public.organizations (id) on delete cascade,
  session_id text not null,
  id text not null,
  inventory_item_id text,
  name text not null,
  quantity numeric(12, 3) not null default 0,
  unit_price numeric(12, 2) not null default 0,
  added_at timestamptz,
  sold_as_pack_of numeric(12, 3),
  sale_variant_id text,
  stock_units_per_sale numeric(12, 3),
  combo_application_id text,
  combo_id text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, session_id, id),
  foreign key (organization_id, session_id)
    references public.sessions (organization_id, id) on delete cascade
);

create table if not exists public.session_combo_applications (
  organization_id text not null references public.organizations (id) on delete cascade,
  session_id text not null,
  id text not null,
  combo_id text,
  combo_name text not null,
  price numeric(12, 2) not null default 0,
  included_minutes integer not null default 0,
  applied_at timestamptz,
  fixed_items jsonb not null default '[]'::jsonb,
  choices jsonb not null default '[]'::jsonb,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, session_id, id),
  foreign key (organization_id, session_id)
    references public.sessions (organization_id, id) on delete cascade
);

create table if not exists public.customer_tabs (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  customer_id text,
  customer_name text not null,
  customer_phone text,
  status text not null default 'open',
  opened_at timestamptz,
  closed_at timestamptz,
  continued_from_session_ids jsonb,
  closed_bill_id text,
  close_disposition text,
  close_reason text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id)
);

create table if not exists public.customer_tab_items (
  organization_id text not null references public.organizations (id) on delete cascade,
  customer_tab_id text not null,
  id text not null,
  inventory_item_id text,
  name text not null,
  quantity numeric(12, 3) not null default 0,
  unit_price numeric(12, 2) not null default 0,
  added_at timestamptz,
  sold_as_pack_of numeric(12, 3),
  sale_variant_id text,
  stock_units_per_sale numeric(12, 3),
  combo_application_id text,
  combo_id text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, customer_tab_id, id),
  foreign key (organization_id, customer_tab_id)
    references public.customer_tabs (organization_id, id) on delete cascade
);

create table if not exists public.customer_tab_combo_applications (
  organization_id text not null references public.organizations (id) on delete cascade,
  customer_tab_id text not null,
  id text not null,
  combo_id text,
  combo_name text not null,
  price numeric(12, 2) not null default 0,
  included_minutes integer not null default 0,
  applied_at timestamptz,
  fixed_items jsonb not null default '[]'::jsonb,
  choices jsonb not null default '[]'::jsonb,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, customer_tab_id, id),
  foreign key (organization_id, customer_tab_id)
    references public.customer_tabs (organization_id, id) on delete cascade
);

create table if not exists public.bills (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  bill_number text not null,
  status text not null,
  created_at_source timestamptz,
  issued_at timestamptz,
  issued_by_user_id text,
  customer_id text,
  customer_name text,
  customer_phone text,
  payment_mode text,
  station_id text,
  session_id text,
  amount_paid numeric(12, 2) not null default 0,
  amount_due numeric(12, 2) not null default 0,
  subtotal numeric(12, 2) not null default 0,
  total_discount_amount numeric(12, 2) not null default 0,
  bill_discount_amount numeric(12, 2) not null default 0,
  round_off_enabled boolean not null default false,
  round_off_amount numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  receipt_type text,
  replacement_of_bill_id text,
  replaced_by_bill_id text,
  replaced_at timestamptz,
  replaced_by_user_id text,
  replace_reason text,
  voided_at timestamptz,
  voided_by_user_id text,
  void_reason text,
  settled_at timestamptz,
  settled_by_user_id text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id),
  unique (organization_id, bill_number)
);

create table if not exists public.bill_lines (
  organization_id text not null references public.organizations (id) on delete cascade,
  bill_id text not null,
  id text not null,
  type text not null,
  description text not null,
  quantity numeric(12, 3) not null default 0,
  unit_price numeric(12, 2) not null default 0,
  subtotal numeric(12, 2) not null default 0,
  discount_amount numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  linked_session_id text,
  inventory_item_id text,
  sold_as_pack_of numeric(12, 3),
  sale_variant_id text,
  stock_units_per_sale numeric(12, 3),
  combo_application_id text,
  combo_id text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, bill_id, id),
  foreign key (organization_id, bill_id)
    references public.bills (organization_id, id) on delete cascade
);

create table if not exists public.bill_line_discounts (
  organization_id text not null references public.organizations (id) on delete cascade,
  bill_id text not null,
  id text not null,
  target_id text,
  discount_type text,
  value numeric(12, 2) not null default 0,
  amount numeric(12, 2) not null default 0,
  reason text,
  applied_by_user_id text,
  applied_at timestamptz,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, bill_id, id),
  foreign key (organization_id, bill_id)
    references public.bills (organization_id, id) on delete cascade
);

create table if not exists public.bill_discounts (
  organization_id text not null references public.organizations (id) on delete cascade,
  bill_id text not null,
  id text not null,
  discount_type text,
  value numeric(12, 2) not null default 0,
  amount numeric(12, 2) not null default 0,
  reason text,
  applied_by_user_id text,
  applied_at timestamptz,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, bill_id, id),
  foreign key (organization_id, bill_id)
    references public.bills (organization_id, id) on delete cascade
);

create table if not exists public.payments (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  bill_id text,
  mode text not null,
  amount numeric(12, 2) not null default 0,
  paid_at timestamptz,
  received_by_user_id text,
  settlement_group_id text,
  related_checkout_bill_id text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id)
);

create table if not exists public.stock_movements (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  item_id text,
  type text not null,
  quantity numeric(12, 3) not null default 0,
  reason text,
  movement_at timestamptz,
  user_id text,
  related_bill_id text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id)
);

create table if not exists public.audit_logs (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  action text not null,
  entity_type text,
  entity_id text,
  message text,
  audit_at timestamptz,
  user_id text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id)
);

create table if not exists public.expenses (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  title text not null,
  category text,
  amount numeric(12, 2) not null default 0,
  payment_mode text,
  cash_amount numeric(12, 2),
  upi_amount numeric(12, 2),
  spent_at timestamptz,
  notes text,
  created_by_user_id text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id)
);

create table if not exists public.expense_templates (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  title text not null,
  category text,
  amount numeric(12, 2) not null default 0,
  frequency text not null default 'monthly',
  start_month text,
  active boolean not null default true,
  notes text,
  created_by_user_id text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id)
);

create table if not exists public.expense_template_overrides (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text not null,
  template_id text,
  month_key text,
  amount numeric(12, 2),
  skip_reason text,
  notes text,
  created_by_user_id text,
  updated_at_source timestamptz,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, id)
);

create table if not exists public.operational_events (
  organization_id text not null references public.organizations (id) on delete cascade,
  id text primary key default ('event-' || gen_random_uuid()::text),
  event_type text not null,
  entity_type text not null,
  entity_id text not null,
  entity_version integer,
  created_by text,
  created_at timestamptz not null default timezone('utc', now()),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists inventory_categories_org_name_idx on public.inventory_categories (organization_id, name);
create index if not exists stations_org_active_idx on public.stations (organization_id, active);
create index if not exists pricing_rules_org_station_idx on public.pricing_rules (organization_id, station_id);
create index if not exists customers_org_phone_idx on public.customers (organization_id, phone) where phone is not null;
create index if not exists customers_org_last_visit_idx on public.customers (organization_id, last_visit_at desc, id desc);
create index if not exists inventory_items_org_active_category_idx on public.inventory_items (organization_id, active, category);
create index if not exists inventory_items_org_barcode_idx on public.inventory_items (organization_id, barcode) where barcode is not null;
create index if not exists sale_variants_org_item_idx on public.sale_variants (organization_id, inventory_item_id);
create index if not exists sale_variants_org_barcode_idx on public.sale_variants (organization_id, barcode) where barcode is not null;
create index if not exists combos_org_type_active_idx on public.combos (organization_id, type, active);
create index if not exists combo_station_targets_org_station_idx on public.combo_station_targets (organization_id, station_id);
create index if not exists sessions_org_status_started_idx on public.sessions (organization_id, status, started_at desc, id desc);
create index if not exists sessions_org_station_open_idx on public.sessions (organization_id, station_id) where status <> 'closed';
create index if not exists sessions_org_customer_idx on public.sessions (organization_id, customer_id) where customer_id is not null;
create index if not exists session_pause_logs_org_session_idx on public.session_pause_logs (organization_id, session_id);
create index if not exists session_items_org_session_idx on public.session_items (organization_id, session_id);
create index if not exists session_items_org_inventory_idx on public.session_items (organization_id, inventory_item_id) where inventory_item_id is not null;
create index if not exists session_combo_apps_org_session_idx on public.session_combo_applications (organization_id, session_id);
create index if not exists customer_tabs_org_status_created_idx on public.customer_tabs (organization_id, status, opened_at desc, id desc);
create index if not exists customer_tabs_org_customer_idx on public.customer_tabs (organization_id, customer_id) where customer_id is not null;
create index if not exists customer_tab_items_org_tab_idx on public.customer_tab_items (organization_id, customer_tab_id);
create index if not exists customer_tab_items_org_inventory_idx on public.customer_tab_items (organization_id, inventory_item_id) where inventory_item_id is not null;
create index if not exists customer_tab_combo_apps_org_tab_idx on public.customer_tab_combo_applications (organization_id, customer_tab_id);
create index if not exists bills_org_issued_idx on public.bills (organization_id, issued_at desc, id desc);
create index if not exists bills_org_status_issued_idx on public.bills (organization_id, status, issued_at desc);
create index if not exists bills_org_pending_customer_idx on public.bills (organization_id, customer_id, issued_at desc) where status = 'pending';
create index if not exists bills_org_customer_phone_idx on public.bills (organization_id, customer_phone) where customer_phone is not null;
create index if not exists bill_lines_org_bill_idx on public.bill_lines (organization_id, bill_id);
create index if not exists bill_lines_org_inventory_idx on public.bill_lines (organization_id, inventory_item_id) where inventory_item_id is not null;
create index if not exists payments_org_bill_idx on public.payments (organization_id, bill_id) where bill_id is not null;
create index if not exists payments_org_paid_idx on public.payments (organization_id, paid_at desc, id desc);
create index if not exists stock_movements_org_item_created_idx on public.stock_movements (organization_id, item_id, movement_at desc, id desc);
create index if not exists stock_movements_org_type_created_idx on public.stock_movements (organization_id, type, movement_at desc);
create index if not exists audit_logs_org_created_idx on public.audit_logs (organization_id, audit_at desc, id desc);
create index if not exists audit_logs_org_entity_idx on public.audit_logs (organization_id, entity_type, entity_id);
create index if not exists expenses_org_spent_idx on public.expenses (organization_id, spent_at desc, id desc);
create index if not exists expense_template_overrides_org_template_month_idx on public.expense_template_overrides (organization_id, template_id, month_key);
create index if not exists operational_events_org_created_idx on public.operational_events (organization_id, created_at desc, id desc);
create index if not exists operational_events_org_entity_idx on public.operational_events (organization_id, entity_type, entity_id, created_at desc);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organizations',
    'organization_members',
    'inventory_categories',
    'stations',
    'pricing_rules',
    'customers',
    'inventory_items',
    'sale_variants',
    'combos',
    'combo_station_targets',
    'combo_fixed_items',
    'combo_choice_groups',
    'combo_choice_options',
    'sessions',
    'session_pause_logs',
    'session_items',
    'session_combo_applications',
    'customer_tabs',
    'customer_tab_items',
    'customer_tab_combo_applications',
    'bills',
    'bill_lines',
    'bill_line_discounts',
    'bill_discounts',
    'payments',
    'stock_movements',
    'audit_logs',
    'expenses',
    'expense_templates',
    'expense_template_overrides',
    'operational_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
  end loop;
end
$$;

drop policy if exists organizations_org_access on public.organizations;
create policy organizations_org_access
on public.organizations
for all
to authenticated
using ((select public.current_user_has_org_access(id)))
with check ((select public.current_user_has_org_access(id)));

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organization_members',
    'inventory_categories',
    'stations',
    'pricing_rules',
    'customers',
    'inventory_items',
    'sale_variants',
    'combos',
    'combo_station_targets',
    'combo_fixed_items',
    'combo_choice_groups',
    'combo_choice_options',
    'sessions',
    'session_pause_logs',
    'session_items',
    'session_combo_applications',
    'customer_tabs',
    'customer_tab_items',
    'customer_tab_combo_applications',
    'bills',
    'bill_lines',
    'bill_line_discounts',
    'bill_discounts',
    'payments',
    'stock_movements',
    'audit_logs',
    'expenses',
    'expense_templates',
    'expense_template_overrides',
    'operational_events'
  ]
  loop
    execute format('drop policy if exists normalized_org_access on public.%I', table_name);
    execute format(
      'create policy normalized_org_access on public.%I for all to authenticated using ((select public.current_user_has_org_access(organization_id))) with check ((select public.current_user_has_org_access(organization_id)))',
      table_name
    );
  end loop;
end
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organizations',
    'organization_members',
    'inventory_categories',
    'stations',
    'pricing_rules',
    'customers',
    'inventory_items',
    'sale_variants',
    'combos',
    'combo_fixed_items',
    'combo_choice_groups',
    'sessions',
    'session_pause_logs',
    'session_items',
    'session_combo_applications',
    'customer_tabs',
    'customer_tab_items',
    'customer_tab_combo_applications',
    'bills',
    'bill_lines',
    'bill_line_discounts',
    'bill_discounts',
    'payments',
    'stock_movements',
    'audit_logs',
    'expenses',
    'expense_templates',
    'expense_template_overrides'
  ]
  loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', table_name, table_name);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I for each row execute procedure public.set_updated_at()',
      table_name,
      table_name
    );
  end loop;
end
$$;
