# Focused independent testing contract

Use a separate clean candidate worktree for independent testing. Record passed/failed/blocked/not-run against exact candidate, deployed bundle/SQL definitions, unique run IDs and immutable evidence. Reuse existing Playwright suites with zero retries, physical staging guards and exact-ID reconciliation; no manual app-browser testing.

## Local candidate gates

### Four-actor harness gate (27 September correction)

Before any of the31 acceptance cases execute, reserve the unique run identity and perform reusable Playwright sign-ins plus read-only authoritative profile/org-role checks for two distinct admins and separate receptionist/manager actors. Require all four active actor IDs distinct in staging org-primary. The seven role cases use dedicated role variables with no generic-A/B fallback; other cases retain their admin pair. The single invocation, exact31-title union, one worker and zero retries are unchanged. Offline discovery must not authenticate or mutate.

Require the ignored role file to be active, match the run ID and deterministic generated username pattern. A separate immutable preflight receipt binds the earlier reservation hash; the final manifest binds the receipt hash. Store only selected actor IDs/roles/state, never credentials, tokens or captured request headers. Failures must seal sanitized evidence and launch zero acceptance tests. Locally test state/run/pattern/missing-field/duplicate-name/duplicate-ID/wrong-role/inactive/wrong-org/wrong-project/network failures and dedicated-runner compatibility. Provisioning must prove exact usernames absent before creation and retain secret-free lifecycle receipts; deactivation remains a verified cleanup gate.

The historical9e399021 build/DB proof remains preserved in its clean worktree. Harness successor source identity is different; it needs its own reviewed source/evidence binding before live execution. Do not relabel old proof manifests as a successor run. Application and SQL runtime are unchanged by this correction.

- TypeScript, lint without new warnings, complete unit regression, default-off and v2-enabled builds.
- Only three kinds route to v2; all others and local-browser mode retain their existing behavior.
- Canonical hydration and no stale reapplication; closed session/tab anti-resurrection.
- Non-atomic realtime readiness, overflow before/during catch-up, concurrent snapshot single-flight, serial/deduped events, disposed generation/listener, disconnect and organization change.
- App queue sends nothing before restore; disconnect during mutation one prevents mutation two until authoritative restore, preserving identity and pending status.
- Pure SQL contracts cover app_state avoidance, actor/tenant checks, payload discriminators, billed/pause rejection, continuation locks and replay identity. Text assertions do not execute SQL.

## Staging correctness

### Local installer failure matrix before staging

Use disposable, genuinely committed local Git fixtures to execute the real builders/verifier; no environment-variable bypass for clean-source guards. Reject wrong SHA, tracked/untracked edits, changed source after package generation, stale mode, dataset-helper overwrite, and incomplete compatibility identity. Assert strict CREATE and runtime absence checks precede DDL. Test both CRLF and true lone-CR bodies.

Validate the complete seven-function contract and perturb each shared metadata attribute: owner, security-definer, volatility, config, language, strictness, parallel/leakproof, cost/rows/result/set-returning/kind/support and ACL principal/grantor/grant options. Positive fixtures include the stable dataset exception. Reject duplicates, unknown functions, forbidden table grants/policies, wrong table owner, forced RLS, unsupported/drifted database versions, and missing/nonzero floor counters. Bind generated postflight run/source identity. Assert original rollback has all-seven installed guards and exact restore verification even before postflight; never permit mutation-table deletion. These executable Node/JSON/artifact tests do not execute PostgreSQL.

Port and bind the existing guarded lifecycle installer/proof/reconciliation scripts to this release before execution. Read-only production SQL definition verification is still pending. Preserve 49-case historical DB-proof assertions but rerun against exact candidate/installation where changed.

Seven core live cases come from the existing continuation (2), recovery/realtime (2), hop-mutation (1), same-target race (1) and downstream parity (1) suites. Include timed/unit-sale and edited/paused sessions, tab items/variants/combos, continuation into new/existing consumers, single consumption/recovery, lost response/manual same-ID retry, real acknowledgement timeout, response/realtime ordering, offline/duplicate/unmount/reconnect, receipt/bill/payment/stock parity, refresh/mobile/logout-login. Retain checkout-versus-hop/reject coverage and actor/role/tenant checks where affected.

Keep the existing 50 reload/mutation overlap pairs as convergence/lost-update evidence, not a startup benchmark. Close every failed/ambiguous case by read-only reconciliation; never hide it with a new-ID automatic replay.

## Operation performance

Retain 20 observations per lifecycle class, unrelated-target overlap and calibrated pairs, same-scale v1 comparison and size sensitivity. Existing limits: DB p95 <500 ms/max <2 s; HTTP/UI acknowledgement p95 <2 s/max <5 s; outer <7 s; v2 p95 >=50% better than same-scale v1 and size sensitivity <=20% or 250 ms. Use guarded production-logical-scale staging fixtures for any app-size-independence claim. If a smaller useful gain warrants different prospective acceptance, agree it explicitly before a new run; do not rewrite a failed verdict.

Do not require the unrelated global 30-cold-load/40-percent startup benchmark or atomic-bootstrap RPC for this release. Smaller scope does not remove security, data integrity, concurrency or rollback gates.

## Final gate

### Supplemental lineage contract

Run `src/qa/lifecycleDatabaseLineageContract.test.ts` using disposable clean Git fixtures with distinct historical-install, ACL and current-candidate identities. Require the positive complete chain and reject missing/mismatched hashes, dirty source, unavailable historical Git objects, wrong receipts, changed raw definitions even when outer hashes are recomputed, and output reuse. Test the actual descriptor CLI with explicit approved hashes. These fixtures do not execute the 49-case database proof or 31-case staging UI suite.

### ACL-convergence tooling prerequisite

Run `src/qa/lifecycleAclConvergenceContract.test.ts` against synthetic, explicit security fixtures and real clean temporary Git repositories. It must work in a fresh clone without private downloaded evidence. Exercise the actual builder and verifier CLIs, complete environment/floor/app_state/table/function validation, exact fifteen-statement forward and inverse scope, legacy preservation, environment-before-lock ordering, and rejection of package/source/raw-evidence/artifact tampering or output reuse. Keep actual captured staging evidence separate and immutable. No local fixture is a substitute for PostgreSQL execution or the existing staging functional/performance matrix.

Fresh exact-ID cleanup and postflight, independent reviewer AND tester release acceptance for the exact candidate, rollback/backup verification, then immediate owner approval for production. Old discovery output containing an empty tests array is not live test evidence.
