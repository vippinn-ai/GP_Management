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
7. Stop on wrong environment, unknown or drifted deployed-function definition/owner/configuration/ACL, any open session/tab, dirty mutation floor, missing rollback artifact, or incomplete role access.

## Additive install

1. Execute only the generated manifest-bound install. It installs lifecycle v2 and the exact reviewed `start_session`, `open_customer_tab`, and `link_customer_tab_continuation` actor-safe definitions in one transaction.
2. Read definitions and grants back from the database.
3. Prove all three lifecycle v2 bodies have no `app_state` reference and that legacy functions remain executable.
4. Run the read-only postflight, save its JSON, and run `npm run verify:db:staging:operational-v2 -- --preflight=<saved-preflight> --postflight=<saved-postflight> --manifest=<manifest>`.
5. Confirm install changed no domain rows or compatibility values.
6. Deploy the exact staging build with operational v2 and `VITE_PERFORMANCE_EVIDENCE=true` enabled only after SQL verification succeeds. This profiler flag is staging-evidence-only and must remain false/absent in production.

## Test execution

Follow `test-plan.md` in its declared order: transactional rollback proof, serial functional cases, negative/security, same-ID recovery, concurrency, realtime ordering, continuation consumption, scale/performance, export lazy-load, bootstrap overlap, parity, cleanup, postflight. A failed or ambiguous case stops the run for reconciliation; it is never automatically retried.

After the zero-retry browser suite succeeds, build the run-bound read-only reconciliation with `npm run build:db:staging:operational-v2:posttest`, execute only its generated SQL in staging, save the JSON result unchanged, and run `npm run verify:db:staging:operational-v2:posttest`. Completion requires the same browser run ID, a zero global open/incomplete floor, zero run-specific live sessions/tabs/reservations, exact installed function hashes, and an unchanged compatibility `app_state`; terminal QA rows remain counted as evidence rather than being silently deleted.

Before the comparison, create one immutable environment profile with `npm run build:evidence:staging:operational-performance-profile -- --profile-id=<stable-id> --network-profile=<description>`. Bind both runs to its path and SHA-256. Bind the frozen baseline and candidate to their expected deployed bundle SHA-256, the same exact dataset/restore manifest SHA-256, that same host/network profile, exact Chromium version, `1440x900` viewport, cold context/cache policy, and a fixed quiet test window. Candidate execution must additionally bind the baseline evidence manifest, database install manifest, and verified database postflight by path and SHA-256. The baseline uses the rendered Live Dashboard as its readiness point because it predates candidate-only performance marks; candidate mode requires all ordered `bp-*` marks and the staging-only React profiler evidence.

Build the transactional proof only after postflight verification:
`npm run build:db:staging:operational-v2:proof -- --run-id=normops-YYYYMMDD-HHMM-db-proof-<suffix> --db-manifest=<manifest> --db-manifest-sha256=<sha> --postflight-verification=<verification> --postflight-verification-sha256=<sha>`.
Execute the generated rollback-only SQL in staging, save the single JSON result unchanged, and bind its manifest/result paths and hashes as `E2E_DB_PROOF_MANIFEST_*` and `E2E_DB_PROOF_RESULT_*` before the functional browser runner is allowed to start. The proof must report 20 samples for each lifecycle RPC, database p95 below 2 seconds, maximum below 5 seconds, all negative/idempotency checks, and unchanged `app_state`.

## Rollback

- Frontend: redeploy the exact prior staging build or set `VITE_BACKEND_OPERATIONAL_RPC_V2=false`; keep normalized bootstrap/realtime enabled.
- SQL: v2 functions/table may remain installed while flag-off. If a function replacement must be restored, apply the immutable generated rollback, which restores the preflight-captured definition, owner, and execution ACL in one transaction.
- Data: do not delete `operational_mutations` or committed evidence during rollback. Clean only exact QA identities after reconciliation.
- Compatibility: do not switch to stale `app_state` reads. Any full legacy rollback requires separately verified reconstruction.

## Completion

Staging completes only when exact-ID cleanup is clean, compatibility invariance is proven, performance budgets pass, and both independent agents bind GO decisions to the tested commit, deployed assets/functions, and evidence hashes.
