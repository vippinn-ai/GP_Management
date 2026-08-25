# Tasks

## Baseline

- [x] Preserve pre-change WIP in commit `63c2b8a`.
- [x] Create `codex/checkout-app-state-decoupling`.
- [x] Complete reproducible per-file review manifest and source-of-truth traceability matrix.
- [x] Resolve the current lint error; local lint has zero errors and five pre-existing warnings (no new warning gate).
- [x] Prepare the gated Release A staging installation/verification/rollback runbook.
- [x] Capture staging schema/function/grant/parity evidence.

## Release A: normalized reads

- [x] Load current-business-day payments and their older bills during normalized bootstrap.
- [x] Load recoverable unbilled hopped sessions.
- [x] Make normalized inventory authoritative in operational helpers.
- [x] Prove generic full-state saves remain blocked in normalized bootstrap.
- [x] Prove compact realtime closes/removes live entities and merges financial overlays by ID.
- [x] Complete scoped read coverage for downstream screens/actions, including historical Bill Register action hydration and normalized customer visit activity.

## Release B: financial v2

- [x] Add financial mutation idempotency schema and RLS.
- [x] Add checkout v2 and adjustment v2 RPCs without `app_state` access.
- [x] Add authenticated actor enforcement and deterministic row locking.
- [x] Add mutation-status reconciliation.
- [x] Add frontend v2 flag, stable mutation identity, and bounded recovery.
- [x] Preserve v1 and local mode.

## Verification

- [x] Local unit and characterization tests pass (39 files / 452 tests on 2026-08-25).
- [x] Add a reproducible staging-only Playwright harness with exact-host/project guards, ignored credentials, two independent contexts, zero retries, trace-disabled credential safety, compact RPC evidence, and failure-only screenshots/video.
- [x] Execute the Playwright pause-edit and hop/detach scenarios with staging credentials; retain their reported harness failures and reconcile the exact canonical RPC, observer, hard-refresh, cleanup, continuation, and Bill Register evidence without retrying checkout.
- [x] Restore normalized-ready report CSV/XLSX/PDF exports, prove keyset pagination beyond one backend page locally, and inspect all three generated formats on staging.
- [x] Execute the two-browser combo, variant, cigarette-pack, and reservation before/after-refresh Playwright matrix with exact RPC and cleanup evidence.
- [x] Run the final consolidated Release A staging Playwright matrix with five passes in one zero-retry run; preserve and reconcile the two earlier harness-only failures before correcting their synchronization assertions.
- [x] Pass the exact-definition reject-release transactional staging proof with authenticated/anonymous grant checks, in-transaction mutation coverage, rollback-to-savepoint restoration, zero residual fixtures, exact compatibility reconciliation, and independent evidence GO.
- [x] Persist the proven reject-release RPC definitions in staging, verify all six hashes/grants/security modes, deploy the corrected staging frontend, and prove the definition install changed no operational or compatibility data.
- [x] Repair the quarantined S1/S2 QA continuation link. The first guarded attempt failed closed and fully rolled back; the separately approved trigger-aware second attempt passed once, advanced compatibility v624 to v625, removed all three link representations, and passed exact independent postflight reconciliation.
- [x] Reconcile the separately authorized three-session multi-hop Playwright attempt without retry. Exactly one Rs 45 bill/payment/mutation/event was committed, all three sessions closed to that bill, and the floor returned empty; the intended two-command race was not submitted because of an interception lifecycle failure, so the product concurrency case remains open. Harden the reusable zero-retry harness locally and retain a fresh-authorization gate for any rerun.
- [x] Reconcile fresh authorized run `20260825104947` without retry. It stopped before interceptor installation or financial identity creation because the observer emitted authenticated REST reads but no POST RPC; guarded rejection released both prior continuation links, exact read-only evidence proved zero bill lines and an empty floor, and the reusable metadata collector was broadened locally. The multi-hop concurrency case remains open and another run requires separate approval.
- [x] Reconcile fresh authorized run `20260825114908` without retry. It stopped before interceptor installation or financial identity creation because the harness selected nonexistent `profiles.organization_id`; guarded rejection again released both prior links, exact evidence proved zero bill lines and an empty floor, and the schema-correct profile/organization-role preflight was fixed locally. The multi-hop concurrency case remains open and another run requires separate approval.
- [x] Reconcile fresh authorized run `20260825120115` without retry. It stopped before interceptor installation or financial identity creation because the harness incorrectly required the normalized-only primary session in compatibility `app_state`; source and database evidence proved only carried/hopped sessions belong there, guarded cleanup left zero bill lines and an empty floor, and the compatibility assertion was corrected locally. The multi-hop concurrency case remains open and another run requires separate approval.
- [x] Pass the fresh zero-retry three-session multi-hop double-bill race. Two distinct commands were submitted once, exactly one Rs 30 bill/payment/mutation/event committed with three Rs 10 session lines, the loser returned `session_not_billable` with null status, all three sessions closed/billed to the winner, actors matched, `app_state` remained unchanged across the financial race, both browsers reloaded Available, and independent read-only postflight found an empty floor.
- [x] Pass the dedicated receptionist/manager checkout-hop timing matrix. Runs `role_matrix_20260825_1457`, `role_matrix_20260825_162048`, and `role_matrix_remaining_20260825_165519` proved both checkout-first outcomes and receptionist checkout versus manager hop-first while exposing and correcting zero-total payment and delayed-alert harness assumptions. Final zero-retry run `role_matrix_final_20260825_2249` passed manager checkout versus receptionist hop-first and both simultaneous role directions. Every exact run was fully reconciled to an empty floor with correct actor, bill, payment, audit, event, mutation, and compatibility evidence; all run-specific profiles are inactive and credential files removed. All six ordinary-role direction/order combinations are now demonstrated.
- [ ] SQL transaction/security/idempotency/concurrency tests pass. Anonymous, wrong-organization, actor-spoof, malformed, inactive-user, rollback, authenticated financial/admin role boundaries, same/different-mutation, over-settlement, bill-number collision, exact- and over-capacity limited-stock contention, both admin inventory metadata orderings, both checkout/reject orderings, all authoritative-admin and ordinary-role checkout/hop direction/order combinations, and single- and multi-hop double-bill races pass; concurrency against remaining operational/financial-adjustment writers remains.
- [ ] Two-browser staging test passes. Basic session/tab checkout, settlement, refund, replacement, realtime, and refresh cases pass; the remaining complex/payment/carryover matrix is open.
- [ ] Performance thresholds pass on production-sized staging data. The corrected 50-case Arcade session/inventory run passes; mixed complex and contention workloads remain.
- [ ] Independent test-agent report has no failed or unexplained not-run cases.
- [x] Production build passes; lint exits zero with five existing warnings and no new warnings.

The current independent static verdict and environment-blocked evidence are recorded in `independent-audit.md`.
