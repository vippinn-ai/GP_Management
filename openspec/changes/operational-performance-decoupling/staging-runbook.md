# Staging runbook

## Scope

This runbook is staging-only. Production is read-only throughout and requires a later explicit approval.

## Candidate identity

Record branch, commit SHA, clean status, build asset names/hashes, SQL file hashes, staging project reference, Cloudflare deployment/version, and the independent review decision.

## Fail-closed preflight

1. Confirm the staging host, project, organization, and authenticated QA roles.
2. Confirm no non-QA active session/tab and no unresolved prior QA mutation.
3. Export `pg_get_functiondef`, owner, ACL, volatility, security mode, and `proconfig` for every function changed by the install.
4. Record table/policy/index/grant state for `operational_mutations`.
5. Record normalized row counts and exact `app_state` data SHA-256-equivalent digest, version, byte size, `updated_at`, and `updated_by`.
6. Render and hash rollback SQL before applying anything.
7. Stop on wrong environment, unknown deployed-function hash, open non-QA work, dirty QA floor, missing rollback artifact, or incomplete role access.

## Additive install

1. Execute only the reviewed `operational-lifecycle-v2.sql` and the exact extracted `open_customer_tab` replacement in one transaction.
2. Read definitions and grants back from the database.
3. Prove all three lifecycle v2 bodies have no `app_state` reference and that legacy functions remain executable.
4. Confirm install changed no domain rows or compatibility values.
5. Deploy the exact staging build with operational v2 enabled only after SQL verification succeeds.

## Test execution

Follow `test-plan.md` in its declared order: transactional rollback proof, serial functional cases, negative/security, same-ID recovery, concurrency, realtime ordering, continuation consumption, scale/performance, export lazy-load, bootstrap overlap, parity, cleanup, postflight. A failed or ambiguous case stops the run for reconciliation; it is never automatically retried.

## Rollback

- Frontend: redeploy the exact prior staging build or set `VITE_BACKEND_OPERATIONAL_RPC_V2=false`; keep normalized bootstrap/realtime enabled.
- SQL: v2 functions/table may remain installed while flag-off. If a function replacement must be restored, apply the preflight-captured exact definition/ACL/config in one transaction.
- Data: do not delete `operational_mutations` or committed evidence during rollback. Clean only exact QA identities after reconciliation.
- Compatibility: do not switch to stale `app_state` reads. Any full legacy rollback requires separately verified reconstruction.

## Completion

Staging completes only when exact-ID cleanup is clean, compatibility invariance is proven, performance budgets pass, and both independent agents bind GO decisions to the tested commit, deployed assets/functions, and evidence hashes.

