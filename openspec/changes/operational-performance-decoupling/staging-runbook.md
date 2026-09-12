# Staging runbook

## Scope

This runbook is staging-only. Production is read-only throughout and requires a later explicit approval.

## Candidate identity

Record branch, commit SHA, clean status, build asset names/hashes, SQL file hashes, staging project reference, Cloudflare deployment/version, and the independent review decision.

## Fail-closed preflight

1. Confirm the staging host, project, organization, and authenticated QA roles.
2. If the identity anchor is not installed, run `operational-v2-staging-environment-identity.sql` once. It must refuse execution unless the database-owned `app.settings.api_url` contains the approved staging project ref; never edit that guard.
3. Confirm no non-QA active session/tab and no unresolved prior QA mutation.
4. Run `operational-lifecycle-v2-staging-preflight-readonly.sql` in the staging SQL editor and save its single JSON value without editing it. The preflight independently validates both the database API URL and the locked identity nonce.
5. Build with `npm run build:db:staging:operational-v2 -- --run-id=normops-YYYYMMDD-HHMM-install --preflight=<saved-json>`.
6. Verify the immutable manifest binds the preflight, source files, install, and rollback by SHA-256 before execution.
7. Stop on wrong environment, unknown or drifted deployed-function definition/owner/configuration/ACL, any open session/tab, any unconsumed recoverable hopped session, dirty mutation floor, missing rollback artifact, or incomplete role access.

## Additive install

1. Execute only the generated manifest-bound install. It installs lifecycle v2 and the exact reviewed `start_session`, `open_customer_tab`, and `link_customer_tab_continuation` actor-safe definitions in one transaction.
2. Read definitions and grants back from the database.
3. Prove all three lifecycle v2 bodies have no `app_state` reference and that legacy functions remain executable.
4. Run the read-only postflight, save its JSON, and run `npm run verify:db:staging:operational-v2 -- --preflight=<saved-preflight> --postflight=<saved-postflight> --manifest=<manifest>`.
5. Confirm install changed no domain rows or compatibility values.
6. Keep the existing frontend deployed for the frozen baseline. Do not deploy the candidate until the rollback-only DB proof and baseline performance run below have passed.

## Test execution

Execute the gates in this evidence-preserving order: transactional rollback proof and independent post-rollback verification; immutable dataset snapshot; frozen baseline performance; candidate deployment and immediate candidate performance on the unchanged dataset; then serial functional and unit-sale lifecycle, exact negative/security matrix, same-ID lost-response recovery, realtime ordering/reconnect/unmount, continuation consumers, hop-versus-five-mutation races, exact 20-by-3 lifecycle latency sampling, 50 unrelated overlap/reload pairs, Bill Register/receipt/mobile/logout parity, export lazy-load, cleanup, and postflight. A failed or ambiguous case stops the run for reconciliation; it is never automatically retried.

After the zero-retry browser suite succeeds, build the run-bound read-only reconciliation with `npm run build:db:staging:operational-v2:posttest`, execute only its generated SQL in staging, save the JSON result unchanged, and run `npm run verify:db:staging:operational-v2:posttest`. Completion requires the same browser run ID, a zero global open/incomplete floor, zero run-specific live sessions/tabs/reservations, exact installed function hashes, and an unchanged compatibility `app_state`; terminal QA rows remain counted as evidence rather than being silently deleted.

Run the dedicated customer-profile snapshot-parity case under a different run ID. It intentionally exercises `commit_admin_data_change`, so it must not use the lifecycle suite's unchanged-`app_state` verifier. The test deletes its exact generated customer through a single unique admin mutation after closing the live session. Build/execute/verify the dedicated `customer-profile-posttest` artifact; it requires zero normalized and compatibility customer residue, a clean global floor, stable function hashes, terminal session evidence, and the expected monotonic compatibility version change.

Before any mutating browser suite, create one immutable environment profile with `npm run build:evidence:staging:operational-performance-profile -- --profile-id=<stable-id> --network-profile=<description>`. Run `operational-performance-dataset-readonly.sql`, save its exact JSON, and build the dataset manifest with `npm run build:evidence:staging:operational-performance-dataset`, binding the raw snapshot, verified production backup manifest, successful disposable restore-drill record, and read-only production scale baseline by path and SHA-256. The builder must verify every backup file, restore-drill identity/counts/checks, and reject staging below the production compatibility bytes or critical normalized row counts. Bind both performance runs to that one dataset manifest. Each run rechecks the exact allowed normalized table counts, content fingerprints, and compatibility identity before collecting measurements.

Run the 30-load frozen baseline against the still-deployed pre-candidate frontend and record its exact bundle SHA-256. Then deploy the exact candidate build with operational v2 and `VITE_PERFORMANCE_EVIDENCE=true`, verify its deployed bundle SHA-256, and immediately run the 30-load candidate measurement before any functional write. The profiler flag is staging-evidence-only and must remain false/absent in production. Bind baseline and candidate to the same recomputed host fingerprint, operator-controlled unchanged network path/profile, exact Chromium channel/version, `1440x900` viewport, cold context/cache policy, and fixed quiet test window. Candidate execution must additionally bind the baseline evidence manifest, database install manifest, and verified database postflight by path and SHA-256. The baseline uses the rendered Live Dashboard as its readiness point because it predates candidate-only performance marks; candidate mode requires all ordered `bp-*` marks and the staging-only React profiler evidence. Any dataset-identity drift between the two runs is a stop, not a reason to recapture only the candidate.

Build the transactional proof only after postflight verification:
`npm run build:db:staging:operational-v2:proof -- --run-id=normops-YYYYMMDD-HHMM-db-proof-<suffix> --db-manifest=<manifest> --db-manifest-sha256=<sha> --postflight-verification=<verification> --postflight-verification-sha256=<sha>`.
Execute the generated rollback-only SQL in staging, save the single JSON result unchanged, and bind its manifest/result paths and hashes as `E2E_DB_PROOF_MANIFEST_*` and `E2E_DB_PROOF_RESULT_*` before the functional browser runner is allowed to start. The proof is bounded by a ten-minute statement timeout because it intentionally executes 60 multi-megabyte legacy rewrites; the v2 acceptance thresholds remain database p95 below 500 ms and maximum below 2 seconds. It must report 20 large-dataset v2 samples for each lifecycle RPC, 10 small-dataset sensitivity samples per RPC, 20 same-scale frozen-v1 samples per RPC, v2 at least 50 percent faster than v1, bounded size sensitivity, the complete exact-code negative/idempotency matrix, and unchanged `app_state`.

Immediately afterward, build and execute `operational-v2-proof-postrollback-readonly.sql` through the manifest-bound `build:db:staging:operational-v2:proof-postrollback` command, save its JSON, and run `verify:db:staging:operational-v2:proof-postrollback`. The functional runner must bind the resulting verification and refuse to start unless every exact proof-run session, pause, tab, mutation, audit, and event count is zero and `app_state` exactly matches the installed postflight identity. The proof's own `rollback_required` field is not sufficient evidence.

## Rollback

- Frontend: redeploy the exact prior staging build or set `VITE_BACKEND_OPERATIONAL_RPC_V2=false`; keep normalized bootstrap/realtime enabled.
- SQL: v2 functions/table may remain installed while flag-off. If a function replacement must be restored, apply only the immutable postflight-verified rollback. It refuses definition/owner/security-definer/volatility/configuration/ACL drift, dynamically revokes every current grantee, then restores the exact preflight definition, owner, and execution ACL in one transaction.
- Data: do not delete `operational_mutations` or committed evidence during rollback. Clean only exact QA identities after reconciliation.
- Compatibility: do not switch to stale `app_state` reads. Any full legacy rollback requires separately verified reconstruction.

## Completion

Staging completes only when exact-ID cleanup is clean, compatibility invariance is proven, performance budgets pass, and both independent agents bind GO decisions to the tested commit, deployed assets/functions, and evidence hashes.
