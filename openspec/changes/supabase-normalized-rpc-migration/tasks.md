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

## 4. Phase 2: Data Gateway

- [x] 4.1 Add frontend data gateway interfaces
- [x] 4.2 Add current `app_state` gateway implementation
- [x] 4.3 Add normalized read gateway skeleton
- [x] 4.4 Add backend feature flags with default values preserving current behavior
- [x] 4.5 Add tests proving disabled flags keep current behavior

## 5. Phase 3: Low-Risk Normalized Reads

- [x] 5.1 Move station/pricing reads behind normalized gateway flag
- [x] 5.2 Move inventory/category/sale-variant reads behind normalized gateway flag
- [ ] 5.3 Move combo reads behind normalized gateway flag
- [ ] 5.4 Move customer search reads behind normalized gateway flag
- [ ] 5.5 Move bill register history reads to paginated normalized queries
  - [x] 5.5.1 Add normalized paginated bill-register reader for bills, lines, discounts, and payments
  - [ ] 5.5.2 Wire Bill Register UI to normalized reader behind a screen-specific flag
- [ ] 5.6 Move report reads to date-filtered normalized queries
- [ ] 5.7 Prove last 15 business days load quickly and older history remains searchable

## 6. Phase 4: Operational RPC Writes

- [ ] 6.1 Implement operational RPC wrappers in the frontend
- [ ] 6.2 Implement `start_session` RPC with station conflict and stock validation
- [ ] 6.3 Implement pause/resume RPCs
- [ ] 6.4 Implement session item add/remove RPCs
- [ ] 6.5 Implement customer tab open/item update RPCs
- [ ] 6.6 Implement combo apply/repeat RPCs
- [ ] 6.7 Add compact operational event rows from each RPC
- [ ] 6.8 Add two-browser conflict tests for station and stock conflicts

## 7. Phase 5: Financial RPC Writes

- [ ] 7.1 Implement checkout RPCs for sessions and customer tabs
- [ ] 7.2 Implement pending receivable settlement RPC
- [ ] 7.3 Implement void/refund/replacement RPCs
- [ ] 7.4 Implement stock finalization and reversal behavior in server transactions
- [ ] 7.5 Implement payment split behavior in server transactions
- [ ] 7.6 Add financial parity tests against current bill preview/build logic
- [ ] 7.7 Keep `app_state` rollback snapshot strategy active until production is stable

## 8. Phase 6: Retire Full-State Sync

- [ ] 8.1 Disable full `app_state` writes after normalized/RPC production stability
- [ ] 8.2 Remove `app_state` realtime subscription from normal runtime
- [ ] 8.3 Keep a read-only migration snapshot for rollback/audit period
- [ ] 8.4 Archive or remove old full-state sync code after rollback window

## 9. Verification

- [x] 9.1 Run `npm test -- --run`
- [x] 9.2 Run `npm run build`
- [x] 9.3 Run staging SQL migration and backfill
- [x] 9.4 Run staging parity checks
- [ ] 9.5 Smoke test as admin, manager, and receptionist
- [ ] 9.6 Smoke test with 5 browser sessions/devices where practical
- [ ] 9.7 Compare before/after telemetry for representative actions
