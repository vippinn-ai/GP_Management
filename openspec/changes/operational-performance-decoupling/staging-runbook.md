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
6. Deploy the exact staging build with operational v2 enabled only after SQL verification succeeds.

## Test execution

Follow `test-plan.md` in its declared order: transactional rollback proof, serial functional cases, negative/security, same-ID recovery, concurrency, realtime ordering, continuation consumption, scale/performance, export lazy-load, bootstrap overlap, parity, cleanup, postflight. A failed or ambiguous case stops the run for reconciliation; it is never automatically retried.

## Rollback

- Frontend: redeploy the exact prior staging build or set `VITE_BACKEND_OPERATIONAL_RPC_V2=false`; keep normalized bootstrap/realtime enabled.
- SQL: v2 functions/table may remain installed while flag-off. If a function replacement must be restored, apply the immutable generated rollback, which restores the preflight-captured definition, owner, and execution ACL in one transaction.
- Data: do not delete `operational_mutations` or committed evidence during rollback. Clean only exact QA identities after reconciliation.
- Compatibility: do not switch to stale `app_state` reads. Any full legacy rollback requires separately verified reconstruction.

## Completion

Staging completes only when exact-ID cleanup is clean, compatibility invariance is proven, performance budgets pass, and both independent agents bind GO decisions to the tested commit, deployed assets/functions, and evidence hashes.
