## Why

The current application is outgrowing the single-row Supabase `app_state` model. A small operational change, such as adding one consumable to a live tab, still ends up saving and broadcasting the full `AppData` JSON blob. That creates avoidable Supabase egress, slower multi-device behavior, and a weak foundation for future SaaS usage.

The next backend direction is to keep Supabase for now, but change the data contract:

- Move from one monolithic `app_state.data` JSON document to normalized tenant-aware tables.
- Move business writes from browser-side full-state saves to small server-side RPC operations.
- Keep the migration side-by-side and reversible so production is not broken.

## Confirmed Decisions

- Use one shared Supabase project with `organization_id` tenant isolation for lower cost and simpler operations.
- Keep the last 15 business days instantly searchable in the app.
- Keep older history searchable too, but it can take a few seconds and use paginated/search-specific queries.
- Design for about 5 simultaneous devices per business in the near term.
- Supabase Postgres functions/RPC are acceptable for business-critical writes.
- No temporary Supabase paid buffer is required right now because the quota just reset.

## What Changes

### Phase 0: Measurement and Baseline

- Add sync/egress telemetry without changing current behavior.
- Measure full `app_state` payload size, save frequency, realtime snapshot frequency, top-level collection counts, save duration, and conflict counts.
- Add SQL inspection queries for current `app_state` size and major collection counts.
- Use this data to decide cutover priority and to prove egress reduction later.

### Phase 1: Tenant-Aware Normalized Schema Side-by-Side

- Add normalized tables alongside `app_state`.
- Add `organizations` and `organization_members`.
- Add `organization_id` to all business-domain tables.
- Backfill normalized rows from the current `app_state` JSON in staging first.
- Keep `app_state` as source of truth during this phase.
- Add comparison checks between `app_state` and normalized tables.

### Phase 2: Data Gateway and Feature Flags

- Add a data access boundary in TypeScript so React panels stop depending directly on where data comes from.
- Keep the UI model compatible with current `AppData` while reads/writes can be switched by feature flag.
- Add feature flags for normalized reads, operational RPC writes, financial RPC writes, and realtime mode.

### Phase 3: Low-Risk Normalized Reads

- Move reads that do not mutate money or live state first:
  - stations and pricing rules
  - inventory catalog and sale variants
  - combos
  - customers
  - bill register/history with cursor pagination
  - reports over historical tables
- Keep writes on the old path until read parity is proven.

### Phase 4: Operational RPC Writes

- Move live non-financial actions to RPC:
  - start session
  - pause/resume session
  - add/remove session item
  - repeat game combo
  - open customer tab
  - add/update/remove customer tab item
  - apply consumables combo
  - save live customer/session details
- RPC functions own validation, stock reservation, conflict handling, and audit insertion.
- Browser sends small commands and receives only affected entities.

### Phase 5: Financial RPC Writes

- Move checkout, bill issuance, pending settlement, write-off, void/refund, replacement, stock deduction, and payments last.
- These functions must run in short database transactions and return the final bill/payment/stock/audit rows.
- This phase is the point where `app_state` stops being the financial source of truth.

### Phase 6: Retire `app_state`

- Freeze full-state writes.
- Keep `app_state` temporarily as a read-only rollback snapshot.
- Remove full-row realtime subscription after stable normalized operation.

## Non-Goals

- No provider migration in this change. Supabase remains the target until schema/API redesign proves insufficient.
- No UI redesign in this change.
- No Stripe/subscription billing model in this change.
- No offline-first rewrite in this change. Smooth online UX is the priority; offline can be reconsidered after RPC migration.
- No destructive migration without staging verification and rollback.

## Capabilities

### New Capabilities

- `supabase-egress-reduction`: measure and reduce egress by replacing full-state sync with smaller reads/writes.
- `multi-tenant-normalized-data`: store business data in tenant-aware normalized tables using `organization_id`.
- `rpc-operational-api`: run business mutations through Supabase RPC functions with server-side validation.

### Modified Capabilities

- `concurrent-update-handling`: conflict handling moves from full `app_state.version` conflicts toward row-level/RPC validation.

## Impact

- Future schema: `supabase/schema.sql` plus new migration SQL files.
- Future data layer: `src/backend.ts`, `src/hooks/useAppSync.ts`, a new data gateway module, and RPC wrappers.
- Future domain logic: session, tab, inventory, billing, payment, stock, audit, expense paths.
- Tests: existing unit tests plus migration parity, RPC validation, tenant isolation, and egress telemetry tests.

## Risks

- Migration mistakes can corrupt financial history. Mitigation: side-by-side backfill, parity checks, and feature flags.
- RLS mistakes can leak tenant data. Mitigation: database-enforced `organization_id` policies and explicit tenant tests.
- RPCs can become too large if they duplicate all frontend logic at once. Mitigation: migrate by operation group.
- Realtime can still generate egress if subscribed too broadly. Mitigation: subscribe only to live tables/entities needed by the current screen.
