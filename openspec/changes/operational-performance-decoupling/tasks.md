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
- [x] Add database-identity-bound installer, exact source/artifact/body/grant verification, guarded rollback capture, and transactional proof tooling. Evidence pending staging execution.
- [x] Add a narrow, preflight-bound reinstall path for corrections to already-installed v2 functions, preserving exact owner/ACL state and producing an exact definition rollback. Evidence pending independent review and staging execution.
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
- [x] Defer bill/report/audit/customer/stock-movement/expense-administration history until after safe interaction or its owning screen; preserve loaded noncritical slices across reconnect and explicitly refresh dashboard context.
- [x] Add named critical-bootstrap marks and a PII-free, immutable 30-cold-load Playwright harness for request/byte/measured dependency-depth, LCP, CLS, React commit, and safe-interactive evidence. Baseline and candidate are bound to exact bundle and dataset hashes.
- [x] Add a guarded PII-free staging scale-fixture builder, full production-count normalized rows, representative compatibility collections at production byte size, exact workload-shape identity, identity-only private registry, rollback-only proof, base-plus-auxiliary identity chain, trigger suppression/restoration, clean source/commit bindings, and exact pre-functional cleanup path after the live snapshot proved staging was below production scale. Superseded proof-a and proof-b packages were never executed. Proof-c was executed exactly once and failed before its workload because Monaco preserved CRLF inside the function body and Supabase default privileges added `service_role`; the transaction rolled back and an independent read-only postflight exactly matched the preflight. Proof-d then passed its rollback-only proof and applied the expected production-scale fixture, but the postapply verifier correctly stopped because the standalone read-only SQL still emitted raw CRLF-sensitive RPC hashes. No baseline or performance test ran. The exact cleanup passed and restored the complete preflight identity. Proof-e passed its rollback-only gate, exact postrollback verification, one-shot apply, and manifest-bound scaled-dataset verification. Baseline identity `normops-20260913-1649-perf-baseline-e` then stopped locally before browser or staging-network work because the runner compared semantically equal workload-shape objects using order-sensitive `JSON.stringify`; the identity is permanently closed. The runner now uses strict semantic JSON-value equality, with executable regression coverage for reordered object keys and negative value/type/array-order cases. The currently applied proof-e fixture and its source tree remain unchanged until the exact cleanup is independently approved and verified; the fix is isolated pending that gate and a fresh package lineage.
- [x] Remove root one-second render coupling (30-second display clock) and reduce the shared logo asset from 226 KB to 61 KB without changing its visual identity.

## 5. Gates

- [x] Add reusable zero-retry suites for exact 20-by-3 target sampling, 50-pair overlap proof, unit-sale/continuation consumers, lost-response/realtime recovery, five hop mutation races, and downstream receipt/mobile/logout parity. Evidence pending live staging execution.
- [x] Replacement-candidate local gate: lint and no-emit TypeScript across every one of the 14 selected operational Playwright specs, lint (0 errors, 4 pre-existing warnings), 63-file/614-test Vitest, production/staging builds, 34-case operational Playwright discovery across 14 files, one separately reconciled customer-profile parity case, and the separate 30-load performance case. Shared settled cleanup and its contract suite preserve primary failures and reject uncontained `finally` awaits. Evidence pending immutable candidate commit.
- [ ] Reviewer approves exact candidate SHA.
- [ ] Fail-closed staging preflight and flag-off SQL install pass.
- [ ] Functional, edge, security, idempotency, race, recovery, realtime, parity, and performance suites pass.
- [ ] Exact-ID cleanup and immutable postflight pass.
- [ ] Tester GO and deployed-definition reviewer GO are recorded.
- [ ] Production remains untouched pending fresh explicit approval.
