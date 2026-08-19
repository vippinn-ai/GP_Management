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

- [x] Local unit and characterization tests pass (30 files / 372 tests on 2026-08-20).
- [ ] SQL transaction/security/idempotency/concurrency tests pass.
- [ ] Two-browser staging test passes.
- [ ] Performance thresholds pass on production-sized staging data.
- [ ] Independent test-agent report has no failed or unexplained not-run cases.
- [x] Production build passes; lint exits zero with five existing warnings and no new warnings.

The current independent static verdict and environment-blocked evidence are recorded in `independent-audit.md`.
