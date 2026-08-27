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
- [x] Reconcile checkout-versus-standalone-settlement attempt `20260827053236` without retry. It stopped before either race interceptor or financial identity existed because the still-open session modal blocked a redundant dashboard-navigation click. The setup created one exact Rs 45 deferred bill with zero payments; guarded cleanup rejected the exact second session, and read-only postflight proved zero open sessions/tabs, the one expected compatibility increment, and no settlement effect. The redundant navigation was removed locally; the concurrency case remains open and another staging run requires separate approval.
- [x] Reconcile checkout-versus-standalone-settlement attempt `20260827054102` without retry. Both UI commands were captured once, but a pre-send whole-header assertion failed before deliberate concurrent submission. Failure teardown removed interception too early and the checkout's bounded ambiguous-response path subsequently committed one canonical checkout that also settled the setup bill; no deliberate standalone-adjustment submit occurred and no persisted adjustment result or effect was evidenced. Exact read-only reconciliation proves two Rs 30 bills, the two expected Rs 30 cash payments, authoritative admin attribution, zero open sessions/tabs, and unchanged compatibility version/hash `643` / `f0c3300bb4e4c024a994fb41aa1aa266fea4bc91ed498e987687cdecd6174208`. The interceptor now remains installed through request settlement and pre-race page quiescence, evidence captures mutation identities before later assertions, and attached errors are redacted. This is functional recovery evidence only; the concurrency case remains open and this authorization is consumed.
- [x] Close the checkout-versus-standalone-settlement functional subgate from reconciled zero-retry run `20260827115031`. The run submitted each captured UI command once; the standalone adjustment won, settled `BILL-20260827-004` with exactly one Rs 30 cash payment/audit/event, and the checkout lost with HTTP 400, a null mutation lookup, and no candidate bill. Exact before/after reconciliation proves authenticated-admin attribution, unchanged `app_state` version/hash across the financial race, identity-bound rejection of the unbilled losing session through cleanup `cleanup_20260827121000`, an empty floor, and retained `BILL-20260827-001` unchanged. Playwright remains reported failed because a later cleanup-eligibility assertion expected raw status `open` instead of normalized `active`; the functional/database result passed, the assertion is corrected, and no rerun was performed.
- [ ] SQL transaction/security/idempotency/concurrency tests pass. Anonymous, wrong-organization, actor-spoof, malformed, inactive-user, rollback, authenticated financial/admin role boundaries, same/different-mutation, over-settlement, bill-number collision, exact- and over-capacity limited-stock contention, both admin inventory metadata orderings, both checkout/reject orderings, all authoritative-admin and ordinary-role checkout/hop direction/order combinations, and single- and multi-hop double-bill races pass; concurrency against remaining operational/financial-adjustment writers remains.
- [ ] Two-browser staging test passes. Basic session/tab checkout, settlement, refund, replacement, realtime, and refresh cases pass; the remaining complex/payment/carryover matrix is open.
- [ ] Performance thresholds pass on production-sized staging data. The corrected 50-case Arcade session/inventory run passes; mixed complex and contention workloads remain.
- [ ] Independent test-agent report has no failed or unexplained not-run cases.
- [x] Production build passes; lint exits zero with five existing warnings and no new warnings.

The current independent static verdict and environment-blocked evidence are recorded in `independent-audit.md`.
