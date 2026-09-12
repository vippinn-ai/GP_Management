# Tasks and evidence

Each completed item records commit SHA, command, timestamp, artifact path, and SHA-256.

## 1. Characterize

- [x] Freeze exact production-equivalent source SHA and staging configuration. Evidence: base `c0e0d2133f39372aac43e669c05e8c27ad5a255c`.
- [x] Trace hop/reject/continuation/startup/realtime/export paths. Evidence: `proposal.md`, `design.md`, independent first-phase reports.
- [x] Add v1 compatibility and v2 forbidden-`app_state` contract tests. Evidence: `src/qa/operationalLifecycleV2SqlContract.test.ts`.
- [x] Capture build, lint, tests, entry chunks, restore request count, and latency baseline. Evidence: local build/test output and measured baseline in `proposal.md`.

## 2. Lifecycle SQL

- [x] Add least-privilege `operational_mutations` and normalized-only v2 functions. Evidence pending independent review and staging install.
- [x] Harden new-tab continuation-source locking and actor attribution. Evidence pending independent review and staging races.
- [ ] Add narrow installer, exact-definition/grant verification, rollback capture, and transactional proof.
- [ ] Prove `app_state` data hash/version/timestamp/updater invariance.

## 3. Frontend lifecycle

- [x] Add default-off v2 flag and fail-closed dependencies.
- [x] Route only target kinds to v2; send intent-only payloads.
- [x] Hydrate changed normalized rows before critical acknowledgement.
- [x] Do not reapply stale client snapshots after canonical v2 confirmation.
- [x] Make continuation-bearing tab flows confirmation-based.
- [x] Serialize realtime hydration completion.

## 4. Frontend performance

- [x] Demand-load XLSX/PDF libraries with popup-safe behavior.
- [x] Add subscription-first buffering/catch-up before writes are enabled.
- [ ] Defer noncritical screen data and parallelize critical reads.
- [ ] Add per-slice/request startup telemetry without PII.
- [ ] Remove root one-second render coupling and gate heavy derived models in a later isolated commit if required by measurements.

## 5. Gates

- [ ] Local TypeScript, lint, tests, builds, and Playwright discovery pass without retries.
- [ ] Reviewer approves exact candidate SHA.
- [ ] Fail-closed staging preflight and flag-off SQL install pass.
- [ ] Functional, edge, security, idempotency, race, recovery, realtime, parity, and performance suites pass.
- [ ] Exact-ID cleanup and immutable postflight pass.
- [ ] Tester GO and deployed-definition reviewer GO are recorded.
- [ ] Production remains untouched pending fresh explicit approval.
