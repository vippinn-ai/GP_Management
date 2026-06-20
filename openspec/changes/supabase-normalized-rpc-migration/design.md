## Context

The current app stores almost all business state in `AppData`, then persists that state into one Supabase row:

- `src/types.ts` defines `AppData` with users, stations, pricing rules, sessions, customers, customer tabs, inventory, combos, stock movements, bills, payments, audit logs, and expenses.
- `src/backend.ts` loads `app_state.select("id, data, version")`, saves the full sanitized blob through `saveRemoteAppData`, and subscribes to all changes on the `app_state` row.
- `src/hooks/useAppSync.ts` debounces and saves the full app state after local changes.
- `src/operationalSync.ts` already defines typed operational mutations, but the queue still eventually saves the full app state.
- `supabase/schema.sql` currently has `profiles` and `app_state` as the only core business-state tables.

That architecture was useful while the app was small, but it scales poorly because every write and realtime update moves the full JSON document.

## Design Principles

- Keep production safe by adding new tables side-by-side before switching behavior.
- Keep current prefix string IDs in the first migration so existing references and bill history remain stable.
- Use `organization_id` on every business row and enforce tenant isolation with RLS.
- Use small command payloads for writes instead of sending the full `AppData`.
- Use cursor pagination for historical lists instead of loading all rows.
- Keep the last 15 business days optimized for fast screen loads.
- Keep older history searchable with slower paginated/report queries.
- Keep financial writes blocking and server-confirmed until the RPC path is fully proven.
- Make rollback possible at every phase until `app_state` retirement.

## Phase 0: Measurement

### Current Production Baseline

The initial production baseline was captured on 2026-06-20 and is recorded in `baseline.md`.

- `app_state` size: 2,501,760 bytes / 2,443 KB.
- `app_state.version`: 8,018.
- Largest historical collections:
  - `auditLogs`: 7,822
  - `stockMovements`: 3,014
  - `bills`: 1,283
  - `payments`: 1,161
  - `sessionPauseLogs`: 786
  - `sessions`: 773
  - `customerTabs`: 760

This confirms that historical and audit arrays are already large enough that routine live operations should not move the full app state.

### Client Metrics

Add a lightweight internal sync telemetry module that records:

- action name or mutation kind
- app state JSON byte size before save
- top-level collection counts
- save start/end timestamp
- save duration
- remote version before/after
- conflict count
- realtime snapshot count
- full snapshot byte size received from realtime
- active pending operation count

The first version can keep metrics in local dev tools or localStorage. If persisted remotely, use a separate low-volume table and sample production events to avoid creating a new egress problem.

### SQL Baseline Query

Use this query manually in Supabase SQL editor or in an admin-only diagnostic script:

```sql
select
  pg_column_size(data) as app_state_bytes,
  pg_size_pretty(pg_column_size(data)::bigint) as app_state_size,
  jsonb_array_length(coalesce(data->'bills', '[]'::jsonb)) as bills,
  jsonb_array_length(coalesce(data->'payments', '[]'::jsonb)) as payments,
  jsonb_array_length(coalesce(data->'stockMovements', '[]'::jsonb)) as stock_movements,
  jsonb_array_length(coalesce(data->'auditLogs', '[]'::jsonb)) as audit_logs,
  jsonb_array_length(coalesce(data->'sessions', '[]'::jsonb)) as sessions,
  jsonb_array_length(coalesce(data->'customerTabs', '[]'::jsonb)) as customer_tabs,
  jsonb_array_length(coalesce(data->'inventoryItems', '[]'::jsonb)) as inventory_items,
  jsonb_array_length(coalesce(data->'combos', '[]'::jsonb)) as combos
from public.app_state
where id = 'primary';
```

### Success Metrics

- Establish current average bytes per operational action.
- Establish current realtime bytes per second during normal use.
- Establish current `app_state` growth rate by collection.
- After RPC migration, operational actions should move only command payload plus changed rows, not the full state blob.

## Phase 1: Target Schema Groups

All business-domain tables SHALL include:

- `organization_id text not null`
- `id text not null`
- `created_at timestamptz`
- `updated_at timestamptz` where the row is mutable
- primary key appropriate for the table, usually `(organization_id, id)` for migrated app IDs

The first migration keeps existing string IDs such as `session-...`, `bill-...`, and `inventory-...`. A later ID cleanup can introduce time-ordered IDs, but it should not be coupled to the first data migration.

The drafted Phase 1 SQL files are:

- `supabase/phase1-normalized-schema.sql`: creates tenant-aware shadow tables, RLS helpers/policies, triggers, and indexes.
- `supabase/phase1-backfill-from-app-state.sql`: resets and repopulates the default `org-primary` shadow organization from the current `app_state` JSON.
- `supabase/phase1-parity-checks-single-result.sql`: compares JSON source counts/totals against normalized rows in one Supabase SQL Editor result grid.

Most domain tables include `raw_data jsonb` in Phase 1. This preserves every current JSON field while we move toward narrower indexed reads and smaller RPC writes.

### SaaS and Identity

- `organizations`
  - `id text primary key`
  - `name text not null`
  - `business_profile jsonb not null default '{}'::jsonb`
  - `active boolean not null default true`
- `organization_members`
  - `organization_id text references organizations(id)`
  - `user_id uuid references profiles(id)`
  - `role public.app_role not null`
  - `active boolean not null default true`
  - primary key `(organization_id, user_id)`
- Existing `profiles` remains global user identity.

### Configuration

- `stations`
- `pricing_rules`
- `inventory_categories`
- `business_day_settings` if the 7 AM business-day setting becomes configurable later

### Inventory and Catalog

- `inventory_items`
- `sale_variants`
- `combos`
- `combo_station_targets`
- `combo_fixed_items`
- `combo_choice_groups`
- `combo_choice_options`

### Live Operations

- `sessions`
- `session_pause_logs`
- `session_items`
- `session_combo_applications`
- `session_combo_fixed_items`
- `session_combo_choice_selections`
- `customer_tabs`
- `customer_tab_items`
- `customer_tab_combo_applications`

### Billing and Receivables

- `bills`
- `bill_lines`
- `bill_line_discounts`
- `bill_discounts`
- `payments`
- `pending_settlement_groups` only if needed for grouped settlement tracking; otherwise derive from payments and bill status.

### Stock, Audit, and Expenses

- `stock_movements`
- `audit_logs`
- `expenses`
- `expense_templates`
- `expense_template_overrides`

### Sync and Diagnostics

- `operational_events`
  - compact event stream for realtime invalidation
  - columns: `organization_id`, `id`, `event_type`, `entity_type`, `entity_id`, `entity_version`, `created_at`, `created_by`
- `sync_telemetry_samples`
  - optional and sampled; do not write every UI event in production

## Index Strategy

Use indexed foreign keys and composite indexes based on the known access patterns.

Examples:

```sql
create index sessions_org_status_started_idx
on public.sessions (organization_id, status, started_at desc);

create index sessions_org_station_status_idx
on public.sessions (organization_id, station_id, status)
where status <> 'closed';

create index customer_tabs_org_status_created_idx
on public.customer_tabs (organization_id, status, created_at desc);

create index bills_org_issued_idx
on public.bills (organization_id, issued_at desc, id desc);

create index bills_org_status_issued_idx
on public.bills (organization_id, status, issued_at desc);

create index bills_org_customer_status_idx
on public.bills (organization_id, customer_id, status)
where status = 'pending';

create index bill_lines_org_bill_idx
on public.bill_lines (organization_id, bill_id);

create index payments_org_bill_idx
on public.payments (organization_id, bill_id);

create index stock_movements_org_item_created_idx
on public.stock_movements (organization_id, item_id, created_at desc);

create index audit_logs_org_created_idx
on public.audit_logs (organization_id, created_at desc, id desc);
```

Historical screens should use cursor pagination with `(issued_at, id)`, `(created_at, id)`, or equivalent, not deep `offset`.

## RLS Strategy

Every tenant table SHALL enable RLS. Policies SHALL verify active membership in the target organization.

Use a security definer helper to avoid repeating complex joins in every policy:

```sql
create or replace function public.current_user_has_org_access(target_organization_id text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members
    where organization_members.organization_id = target_organization_id
      and organization_members.user_id = (select auth.uid())
      and organization_members.active = true
  );
$$;
```

Policy pattern:

```sql
create policy sessions_org_access
on public.sessions
for all
to authenticated
using ((select public.current_user_has_org_access(organization_id)))
with check ((select public.current_user_has_org_access(organization_id)));
```

Indexes required for RLS:

```sql
create index organization_members_user_org_idx
on public.organization_members (user_id, organization_id)
where active = true;
```

## RPC/API Strategy

RPC functions should accept compact payloads, validate server-side, write all affected rows inside one short transaction, and return only changed rows plus event metadata.

Initial operational RPCs:

- `start_session(payload jsonb)`
- `pause_session(payload jsonb)`
- `resume_session(payload jsonb)`
- `add_session_item(payload jsonb)`
- `remove_session_item(payload jsonb)`
- `repeat_session_combo(payload jsonb)`
- `open_customer_tab(payload jsonb)`
- `apply_customer_tab_combo(payload jsonb)`
- `add_customer_tab_item(payload jsonb)`
- `update_customer_tab_item_quantity(payload jsonb)`
- `remove_customer_tab_item(payload jsonb)`
- `save_live_session_details(payload jsonb)`
- `save_live_customer_tab_details(payload jsonb)`

Financial RPCs, migrated later:

- `checkout_session(payload jsonb)`
- `checkout_customer_tab(payload jsonb)`
- `settle_pending_bills(payload jsonb)`
- `void_bill(payload jsonb)`
- `refund_bill(payload jsonb)`
- `replace_bill(payload jsonb)`
- `record_stock_movement(payload jsonb)`
- `record_one_time_expense(payload jsonb)`

RPC responses should be shaped for small UI updates:

```ts
interface RpcMutationResult<TChangedRows> {
  organizationId: string;
  eventId: string;
  entityType: string;
  entityId: string;
  changedRows: TChangedRows;
  serverTime: string;
}
```

## Realtime Strategy

Stop subscribing to the full `app_state` row as the primary sync mechanism.

Use one of these modes by screen:

- Dashboard: active sessions, open customer tabs, stations, and compact operational events.
- Sale panel: selected customer tab plus inventory availability changes.
- Inventory panel: inventory items, stock movements, combos when the tab is open.
- Bill register: no broad realtime; refresh on demand or listen only for compact bill events.
- Reports: no realtime by default.

The `operational_events` table should contain only enough data to tell clients what changed. Clients then fetch the affected entity if their current screen needs it.

## Data Gateway

Add a frontend data boundary before switching storage sources.

Proposed modules:

- `src/dataGateway/types.ts`
- `src/dataGateway/appStateGateway.ts`
- `src/dataGateway/normalizedGateway.ts`
- `src/dataGateway/featureFlags.ts`
- `src/dataGateway/rpcClient.ts`

The gateway should let existing panels keep working while specific reads/writes are moved behind flags.

Example flags:

```ts
interface BackendFeatureFlags {
  normalizedConfigReads: boolean;
  normalizedCatalogReads: boolean;
  normalizedBillHistoryReads: boolean;
  rpcOperationalWrites: boolean;
  rpcFinancialWrites: boolean;
  normalizedRealtime: boolean;
}
```

Phase 2 implements this boundary with all flags defaulting to `false`. The current runtime still uses the `app_state` gateway unless one of these explicit Vite flags is enabled:

- `VITE_BACKEND_NORMALIZED_CONFIG_READS`
- `VITE_BACKEND_NORMALIZED_CATALOG_READS`
- `VITE_BACKEND_NORMALIZED_BILL_HISTORY_READS`
- `VITE_BACKEND_NORMALIZED_REALTIME`
- `VITE_BACKEND_RPC_OPERATIONAL_WRITES`
- `VITE_BACKEND_RPC_FINANCIAL_WRITES`

Until Phase 3/4 adapters exist, enabling any normalized or RPC flag intentionally selects a guarded skeleton that fails with a clear "not implemented" error instead of performing a silent partial cutover.

The first Phase 3 slice implements normalized config/catalog read overlays:

- `VITE_BACKEND_NORMALIZED_CONFIG_READS` overlays `businessProfile`, `inventoryCategories`, `stations`, and `pricingRules` from normalized tables.
- `VITE_BACKEND_NORMALIZED_CATALOG_READS` overlays `inventoryItems` with grouped `saleVariants`.

These overlays intentionally keep saves and realtime on `app_state`. This lets staging validate normalized row mapping under feature flags before moving screen-specific reads away from the full snapshot load.

## Migration and Rollback

### Backfill

- Export current `app_state` from staging.
- Transform JSON arrays into normalized rows.
- Insert into normalized tables in batches.
- Run parity checks:
  - counts by entity
  - bill totals
  - payment totals
  - stock movement totals
  - open session/tab counts
  - pending bill totals by customer
  - inventory stock and reserved stock

### Cutover

- Enable normalized reads by screen group.
- Enable operational RPC writes after read parity.
- Enable financial RPC writes only after staging smoke tests and manual financial parity.

### Rollback

- Before financial cutover, rollback means disable feature flags and return to `app_state`.
- After financial cutover, rollback requires a reverse snapshot writer or keeping `app_state` updated in parallel until stable.
- Do not retire full `app_state` writes until at least one stable production period after financial RPC cutover.

## Testing Strategy

- Unit tests for gateway mappers between normalized rows and current UI models.
- Migration tests that convert fixture `AppData` into normalized rows and back.
- RPC tests for validation, stock availability, bill totals, payment splits, and audit rows.
- Tenant isolation tests for every table and RPC.
- Realtime tests proving a remote event updates only the relevant local entity.
- Performance tests using synthetic history older than 15 days.
- Manual two-browser tests for station start conflict, stock conflict, tab item updates, checkout blocking, and pending receivables.

## Open Implementation Notes

- Keep 7 AM business-day logic in one shared place and reuse it in report/RPC queries.
- Keep archived inventory rows queryable for historical bill and report lines.
- Keep combo snapshots immutable once applied to sessions/tabs/bills.
- Avoid returning nested full history from RPCs. Return changed rows and let the screen fetch details when needed.
