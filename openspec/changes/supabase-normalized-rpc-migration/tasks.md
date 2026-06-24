## 1. Baseline and Spec Validation

- [x] 1.1 Record accepted product/architecture decisions in this OpenSpec change
- [x] 1.2 Document current full-state sync risk from code inspection
- [x] 1.3 Review this spec with the user before writing runtime code
- [x] 1.4 Capture current production `app_state` size and collection counts using the baseline SQL query
- [x] 1.5 Decide the first measurable egress target after baseline data is available

## 2. Phase 0: Sync/Egress Telemetry

- [x] 2.1 Add a lightweight telemetry utility for app-state byte size and collection counts
- [x] 2.2 Record save duration, action/mutation label, conflict count, and remote version movement
- [x] 2.3 Record realtime snapshot receive count and estimated payload bytes
- [x] 2.4 Add a local-only diagnostics panel or console helper for reviewing telemetry during testing
- [x] 2.5 Add tests for telemetry size/count calculations
- [x] 2.6 Verify telemetry does not change save/load behavior

## 3. Phase 1: Normalized Schema Side-by-Side

- [x] 3.1 Create migration SQL for `organizations` and `organization_members`
- [x] 3.2 Create migration SQL for configuration tables
- [x] 3.3 Create migration SQL for inventory/catalog/combo tables
- [x] 3.4 Create migration SQL for live session and customer-tab tables
- [x] 3.5 Create migration SQL for billing/payment/receivable tables
- [x] 3.6 Create migration SQL for stock, audit, and expense tables
- [x] 3.7 Add RLS policies and membership helper functions
- [x] 3.8 Add indexes for tenant filters, live screens, pending bills, reports, and history pagination
- [x] 3.9 Add staging backfill script from `app_state` into normalized tables
- [x] 3.10 Add parity checks for counts, totals, stock, pending dues, and open live records
- [x] 3.11 Run staging organization membership sync after creating new QA users

## 4. Phase 2: Data Gateway

- [x] 4.1 Add frontend data gateway interfaces
- [x] 4.2 Add current `app_state` gateway implementation
- [x] 4.3 Add normalized read gateway skeleton
- [x] 4.4 Add backend feature flags with default values preserving current behavior
- [x] 4.5 Add tests proving disabled flags keep current behavior

## 5. Phase 3: Low-Risk Normalized Reads

- [x] 5.1 Move station/pricing reads behind normalized gateway flag
- [x] 5.2 Move inventory/category/sale-variant reads behind normalized gateway flag
- [x] 5.3 Move combo reads behind normalized gateway flag
- [x] 5.4 Move customer search reads behind normalized gateway flag
- [x] 5.5 Move bill register history reads to paginated normalized queries
  - [x] 5.5.1 Add normalized paginated bill-register reader for bills, lines, discounts, and payments
  - [x] 5.5.2 Wire Bill Register UI to normalized reader behind a screen-specific flag
- [x] 5.6 Move report reads to date-filtered normalized queries
- [x] 5.7 Prove last 15 business days load quickly and older history remains searchable
  - [x] 5.7.1 Add staging SQL probes and supplemental read indexes for performance evidence collection
  - [x] 5.7.2 Capture staging probe output and record pass/follow-up decision

## 6. Phase 4: Operational RPC Writes

- [x] 6.1 Implement operational RPC wrappers in the frontend
- [x] 6.2 Implement `start_session` RPC with station conflict and stock validation
- [x] 6.3 Implement pause/resume RPCs
- [x] 6.4 Implement session item add/remove RPCs
- [x] 6.5 Implement customer tab open/item update RPCs
- [x] 6.6 Implement combo apply/repeat RPCs
- [x] 6.7 Implement live session/customer-tab detail save RPCs
- [x] 6.8 Add compact operational event rows from each RPC
- [x] 6.9 Add two-browser conflict tests for station and stock conflicts
  - [x] 6.9.1 Validate staging conflict behavior across multiple browser sessions
  - [x] 6.9.2 Fix variant customer-tab stock conflicts by aligning customer-tab RPC stock checks with the current `app_state` inventory source
  - [x] 6.9.3 Add popup alerts for failed/conflict live actions and pending-sync checkout blocks
- [x] 6.10 Implement compact reject session/customer-tab RPCs so reject actions do not fall back to full `app_state` upload
- [x] 6.11 Optimize the shared `app_state` JSON array patch helper after production reject-session timeout evidence

## 7. Phase 5: Financial RPC Writes

- [x] 7.1 Implement checkout RPCs for sessions and customer tabs
- [x] 7.2 Implement pending receivable settlement RPC
- [x] 7.3 Implement void/refund/replacement RPCs
  - [x] 7.3.1 Implement void/refund RPC path
  - [x] 7.3.2 Implement replacement RPC path
- [x] 7.4 Implement stock finalization and reversal behavior in server transactions
  - [x] 7.4.1 Implement checkout stock finalization
  - [x] 7.4.2 Implement void/refund stock reversal
  - [x] 7.4.3 Implement replacement stock delta handling
- [x] 7.5 Implement payment split behavior in server transactions for checkout and pending settlement
- [x] 7.6 Add financial parity tests against current bill preview/build logic
  - [x] 7.6.1 Add checkout and financial-adjustment patch parity tests
  - [x] 7.6.2 Add replacement-bill parity tests when replacement RPC is implemented
- [x] 7.7 Keep `app_state` rollback snapshot strategy active until production is stable

## 8. Phase 6: Retire Full-State Sync

- [x] 8.1 Add compact realtime subscription through `operational_events` behind `VITE_BACKEND_NORMALIZED_REALTIME`
- [x] 8.2 Add SQL to publish `operational_events` to Supabase realtime while keeping `app_state` publication for rollback
- [x] 8.3 Stop full business-state `localStorage` caching in backend mode and clear the legacy cache key after remote load
- [x] 8.4 Add compact realtime telemetry and monitoring queries for app-state size, realtime publication, and event counts
- [x] 8.5 Validate compact realtime in staging with two-browser live sync, checkout, financial adjustments, and no `QuotaExceededError`
- [x] 8.6 Enable compact realtime in production only after staging validation passes
- [x] 8.7 Keep full `app_state` writes and rollback snapshot active until compact realtime is stable
- [ ] 8.8 Later phase: remove full startup `app_state` load and retire full `app_state` writes after a separate cutover

## 9. Verification

- [x] 9.1 Run `npm test -- --run`
- [x] 9.2 Run `npm run build`
- [x] 9.3 Run staging SQL migration and backfill
- [x] 9.4 Run staging parity checks
- [ ] 9.5 Smoke test as admin, manager, and receptionist
- [ ] 9.6 Smoke test with 5 browser sessions/devices where practical
- [x] 9.7 Compare before/after telemetry for representative actions
  - [x] 9.7.1 Compare checkout RPC timings in staging
  - [x] 9.7.2 Compare void/refund RPC timings in staging
  - [x] 9.7.3 Compare pending settlement/write-off RPC timings in staging
  - [x] 9.7.4 Compare replacement RPC timings in staging
- [x] 9.8 Verify compact realtime telemetry in staging and production shows `compact_realtime_event` with `skippedFullSnapshot: true`
- [x] 9.9 Verify backend-mode browser cache cleanup returns `null` for `game-parlour-management-system/v1`

## 10. Production Rollout Checklist

### 10.1 Production Go/No-Go Gate

- [ ] 10.1.1 Confirm staging sign-off from the owner after admin, manager, and receptionist smoke tests are complete
- [ ] 10.1.2 Confirm staging sign-off after practical multi-browser/device testing, including at least two simultaneous browser sessions
- [ ] 10.1.3 Confirm no unresolved staging defects remain for live actions, checkout, replacement, void/refund, pending settlement/write-off, bill search, reports, and customer tabs
- [ ] 10.1.4 Confirm the production rollout window with staff and pause non-essential app usage during the database backfill and production deploy
- [ ] 10.1.5 Confirm the exact production feature-flag set before building; do not enable any flag in production that was not tested in staging
- [ ] 10.1.6 Confirm production deploy command will use `npx wrangler deploy --name management`; do not use staging deploy commands for production
- [ ] 10.1.7 Confirm the current production Worker version ID and the current Git commit before making changes
- [ ] 10.1.8 Stop immediately if production is actively being used for billing and the staff cannot pause writes during the cutover window

### 10.2 Production Backup And Baseline

- [ ] 10.2.1 Capture production `app_state` baseline with `supabase/app-state-baseline.sql` and store the output in this change record
- [ ] 10.2.2 Export or otherwise preserve the current production `public.app_state` row, including `id`, `data`, `version`, `updated_at`, and `updated_by`, before running production migration SQL
- [ ] 10.2.3 Capture production row counts for normalized tables before backfill, if the tables already exist
- [ ] 10.2.4 Capture current production RLS/function-grant state before changing SQL functions
- [ ] 10.2.5 Confirm a rollback artifact exists: either the previous production Worker version can be restored, or a flags-disabled production bundle can be deployed from Git
- [ ] 10.2.6 Do not proceed if the `app_state` backup is missing, incomplete, or cannot be restored manually if needed

### 10.3 Production Database Preparation

- [ ] 10.3.1 Run `supabase/phase1-normalized-schema.sql` in production, then verify RLS is enabled on all normalized tenant tables
- [ ] 10.3.2 Run `supabase/phase1-organization-member-sync.sql` in production, then verify active production users have organization membership rows
- [ ] 10.3.3 Run `supabase/phase1-backfill-from-app-state.sql` in production during the write-pause window
- [ ] 10.3.4 Run `supabase/phase1-parity-checks-single-result.sql` in production and confirm every `delta` is `0`
- [ ] 10.3.5 Run `supabase/phase3-read-performance-indexes.sql` in production before enabling normalized history/report reads
- [ ] 10.3.6 Run Phase 4 RPC scripts in order: start session, pause/resume, session items, customer tabs, combos, live details, reject session/tab
- [ ] 10.3.7 Run Phase 5 RPC scripts in order: `phase5-financial-checkout-rpc.sql`, then `phase5-financial-adjustment-rpc.sql`
- [ ] 10.3.8 Run the function install and execute-grant checks from `supabase/phase4-rpc-runbook.md`
- [ ] 10.3.9 Confirm `anon` cannot execute browser-facing RPCs or helper functions
- [ ] 10.3.10 Confirm `authenticated` can execute browser-facing operational and financial RPCs
- [ ] 10.3.11 Confirm helper functions such as `patch_app_state_array_by_id` and `resolve_operational_customer` are not directly executable by `anon` or `authenticated`
- [ ] 10.3.12 Stop immediately if any SQL script fails, any parity `delta` is non-zero, any RLS check fails, or any execute grant differs from the expected state

### 10.4 Production Frontend Cutover Strategy

- [ ] 10.4.1 First production deploy option: deploy the new code with all normalized/RPC flags disabled to prove the build itself is safe without changing runtime behavior
- [ ] 10.4.2 Runtime cutover deploy: enable only the production flags that were already proven in staging
- [ ] 10.4.3 Required bundled flags for operational RPC cutover: `VITE_BACKEND_RPC_OPERATIONAL_WRITES=true` and `VITE_BACKEND_NORMALIZED_LIVE_READS=true`
- [ ] 10.4.4 Required bundled flag for financial RPC cutover: `VITE_BACKEND_RPC_FINANCIAL_WRITES=true`
- [ ] 10.4.5 Do not enable `VITE_BACKEND_NORMALIZED_REALTIME` in production until a separate compact realtime implementation is completed and tested
- [ ] 10.4.6 Build production with `npm run build -- --mode production`
- [ ] 10.4.7 Deploy production with `npx wrangler deploy --name management`
- [ ] 10.4.8 Record the new production Worker version ID immediately after deploy
- [ ] 10.4.9 Ask all staff browsers to hard refresh after the production deploy before continuing normal work

### 10.5 Immediate Production Smoke Test

- [ ] 10.5.1 Admin login succeeds and Dashboard, Sale, Inventory, Bills, Reports, Customers, Settings, and Users access still matches expected permissions
- [ ] 10.5.2 Manager login succeeds and Analytics/Reports one-time expense access still works as expected
- [ ] 10.5.3 Receptionist login succeeds and restricted tabs remain restricted
- [ ] 10.5.4 Start a normal session and confirm it appears on another browser after refresh
- [ ] 10.5.5 Pause and resume a session
- [ ] 10.5.6 Add and remove a session item, including a sale variant item
- [ ] 10.5.7 Open a customer tab, add an item, update quantity, remove item, and verify stock validation
- [ ] 10.5.8 Apply a consumables combo and a game combo if production data has active combo fixtures
- [ ] 10.5.9 Issue a session bill and confirm `financial_checkout_committed` with `entity_type = session`
- [ ] 10.5.10 Issue a customer-tab bill and confirm `financial_checkout_committed` with `entity_type = customer_tab`
- [ ] 10.5.11 Replace an issued bill and confirm `financial_checkout_committed` with `entity_type = bill`
- [ ] 10.5.12 Void or refund a test issued bill and confirm `financial_adjustment_committed`
- [ ] 10.5.13 Settle or write off a pending bill only if a safe test pending bill exists; otherwise defer this check
- [ ] 10.5.14 Confirm Bill Register search, Today, Yesterday, Pending, and Last 7 Days filters work
- [ ] 10.5.15 Confirm Reports and Inventory Report load expected date ranges
- [ ] 10.5.16 Confirm no staff browser shows unresolved live sync conflicts or pending operations after smoke testing

### 10.6 Production Monitoring Window

- [ ] 10.6.1 For the first 30 minutes, watch Supabase `operational_events` for operational and financial event creation
- [ ] 10.6.2 For the first 30 minutes, monitor browser console telemetry for `skippedFullSnapshot: true` on supported checkout paths
- [ ] 10.6.3 Compare representative payload sizes against staging evidence; common RPC payloads should stay in the compact KB range, not MB range
- [ ] 10.6.4 Watch for repeated `app_state_conflict`, `insufficient_stock`, `station_occupied`, or permission errors
- [ ] 10.6.5 Check Supabase egress after the first business day and compare with pre-rollout usage
- [ ] 10.6.6 Keep production source on `app_state` compatibility; do not start Phase 6 retirement work during this rollout

### 10.7 Rollback Plan

- [ ] 10.7.1 Rollback trigger: login failure, billing failure, incorrect stock movement, incorrect payment/receivable status, broken bill search, repeated unresolved sync conflicts, or non-zero production parity after cutover
- [ ] 10.7.2 Immediate safe rollback: deploy a production bundle with `VITE_BACKEND_RPC_OPERATIONAL_WRITES=false`, `VITE_BACKEND_NORMALIZED_LIVE_READS=false`, and `VITE_BACKEND_RPC_FINANCIAL_WRITES=false`
- [ ] 10.7.3 Alternative rollback: restore the previous production Worker version using Cloudflare rollback tooling if that is faster and verified
- [ ] 10.7.4 Keep production SQL objects in place during frontend rollback; they are side-by-side and should not affect the legacy full-state path when flags are disabled
- [ ] 10.7.5 If a production write partially completed, preserve screenshots, bill numbers, event IDs, and browser telemetry before manual correction
- [ ] 10.7.6 If normalized tables diverge but `app_state` remains correct, rerun the production backfill only after flags are disabled and staff writes are paused
- [ ] 10.7.7 If `app_state` is incorrect, do not restore from backup without explicit owner approval; first identify the exact bad operation and whether a normal void/refund/replacement correction is safer
- [ ] 10.7.8 After rollback, run a small legacy smoke test: login, start session, add item, issue bill, and verify the bill appears in Bill Register

### 10.8 Production Rollout Closure

- [ ] 10.8.1 Record production SQL script completion times and any warnings
- [ ] 10.8.2 Record production Worker version ID, Git commit, and deploy time
- [ ] 10.8.3 Record production smoke test results with tester name and timestamp
- [ ] 10.8.4 Record first-day egress observation and compare against baseline
- [ ] 10.8.5 Mark production rollout complete only after one normal business day without rollback-triggering defects

### 10.9 Compact Realtime / Minimal Cache Production Rollout

- [x] 10.9.1 Staging SQL publication verified `public.operational_events` and `public.app_state` are both in `supabase_realtime`
- [x] 10.9.2 Staging deployed with `VITE_BACKEND_NORMALIZED_REALTIME=true`
  - Staging Worker version: `90af4d7b-c5d5-4dce-a9b3-3e5737876c69`
- [x] 10.9.3 Staging telemetry verified compact realtime samples only after clearing telemetry
  - Examples observed: `compact_realtime_event`, payloads roughly `537-1146` bytes, `skippedFullSnapshot: true`
- [x] 10.9.4 Staging browser cache cleanup verified `game-parlour-management-system/v1` returns `null`
- [x] 10.9.5 Production SQL publication verified `public.operational_events` is in `supabase_realtime` while `public.app_state` remains for rollback
- [x] 10.9.6 Production deployed with `VITE_BACKEND_NORMALIZED_REALTIME=true`
  - Production Worker version: `dd2e3f1e-f2c4-430c-a1e0-59b36014b2ce`
- [x] 10.9.7 Production telemetry verified compact realtime samples after hard refresh
  - Examples observed: `start_session`, `add_session_item`, `remove_session_item`, `pause_session`, `resume_session`
  - Payloads roughly `537-623` bytes and `skippedFullSnapshot: true`
- [x] 10.9.8 Production browser cache cleanup verified `game-parlour-management-system/v1` returns blank/`null`
- [ ] 10.9.9 Confirm all staff production browsers have hard refreshed after rollout
- [ ] 10.9.10 Monitor production for one normal business day with no rollback-triggering defects
- [ ] 10.9.11 Capture next-day Supabase Postgres egress and compare with baseline
- [ ] 10.9.12 Close compact realtime rollout only if daily Postgres egress trends down and no unresolved sync or billing issues are reported
