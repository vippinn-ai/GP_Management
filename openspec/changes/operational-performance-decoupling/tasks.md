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
- [x] Add a guarded PII-free staging scale-fixture builder, full production-count normalized rows, representative compatibility collections at production byte size, exact workload-shape identity, identity-only private registry, rollback-only proof, base-plus-auxiliary identity chain, trigger suppression/restoration, clean source/commit bindings, and exact pre-functional cleanup path after the live snapshot proved staging was below production scale. Superseded proof-a and proof-b packages were never executed. Proof-c was executed exactly once and failed before its workload because Monaco preserved CRLF inside the function body and Supabase default privileges added `service_role`; the transaction rolled back and an independent read-only postflight exactly matched the preflight. Proof-d then passed its rollback-only proof and applied the expected production-scale fixture, but the postapply verifier correctly stopped because the standalone read-only SQL still emitted raw CRLF-sensitive RPC hashes. No baseline or performance test ran. The exact cleanup passed and restored the complete preflight identity. Proof-e passed its rollback-only gate, exact postrollback verification, one-shot apply, and manifest-bound scaled-dataset verification. Baseline identity `normops-20260913-1649-perf-baseline-e` then stopped locally before browser or staging-network work because the runner compared semantically equal workload-shape objects using order-sensitive `JSON.stringify`; the identity is permanently closed. Proof-e cleanup subsequently passed once: cleanup result SHA `c9e846bef31ceaf539e47926476afd955ccc9dbc5dd602850e6ff19b7586c5f3`, read-only postcleanup SHA `ccb284d7deb30fa8857dfd38e8d2b22323630bd0084793a5e24bc45a214ab33e`, and manifest-bound cleanup verification SHA `756db0012630fb67b699989865663017b86afd96c72a5a86bb85a30567407b29` prove exact original restoration, fixture/key/RPC absence, five clean floors, and no production write. The runner now uses strict semantic JSON-value equality, with executable regression coverage for reordered object keys and negative value/type/missing-key/extra-key/null-versus-absent/array-order cases. Fresh preflight and fixture/package lineage are required; proof-e, dataset-e, and the closed baseline identity cannot be reused.
- [x] Execute the fresh package-f scale proof, apply, and frozen legacy baseline after three independent gates. Proof verification SHA `6f83f3754e41405066df1b18f1c67b4ccf39e086c36c209eb95e412eb9ad373e` proves exact rollback restoration; apply verification SHA `8b82ab5aa9fbc065eb9c5b65a3afe053014a8aec78ef5675bb487f4209b851b7` proves the production-sized fixture at app-state version 736 with no production write. Dataset manifest SHA `1c87b1a3b127b3ede279422f8a6b91bab35dd6bc13f1540a45a299a88f81b85c` bound the 30-load legacy baseline `normops-20260913-2030-perf-baseline-f`, which passed with evidence SHA `3e70e5d971eb2092c39212c14a0d291af6657675de8f496d91c1ed29db72af4c`, p95 14,349 ms, maximum 16,948 ms, and critical API bytes p95 1,071,686. Candidate preflight then exposed that the verified install and fixture recorded the same `app_state.updated_at` instant with `+05:30` and `+00:00` offsets; the runner now compares timestamp instants while preserving exact equality for every other identity field, with positive and negative executable coverage.
- [x] Preserve the failed one-shot candidate identity `normops-20260913-2050-perf-candidate-f` without retry. Summary SHA `985dbe5d308b5359fd9a659fe003afb61c0f2428900e215abb6993bec596e63b` and evidence-manifest SHA `a1054cc3d5f5adbfa803ae5d1c8893287bb05964fbc887e88f0df056de359626` show that the deferred Inventory history stopped at PostgREST's 1,000-row response cap instead of the frozen dataset's 1,506-row shape. The normalized movement reader now uses bounded, exact-count, deterministic pagination with count-drift, overlap, early-end, and incomplete-result rejection; the performance assertion sums every successful page instead of assuming one uncapped response.
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
