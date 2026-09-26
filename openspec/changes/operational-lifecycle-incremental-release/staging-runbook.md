# R1 staging execution contract

Status: preparation draft; NOT approved for live execution. Runtime base f85b11a has independent local evidence, but this tooling successor still needs reviewer/tester acceptance. Production is excluded.

## Pre-execution gates

1. Freeze a clean exact candidate commit and source identity. Review the five runtime/helper SQL sources and retained continuation consumers against read-only installed definitions. Never infer an installed SQL version from a frontend build.
2. Run local unit/type/lint and the 14-spec static check. Offline Playwright discovery must identify the full 31-case R1 suite, with the single maintenance-only abandoned-session cleanup case excluded. Discovery executes zero tests and is not acceptance.
3. Independently re-review the implemented corrections for preserved-function reinstall provenance, identical SQL-body canonicalization and complete mutation-table/function security checks before generating or executing SQL. Local negative fixtures pass, but there is no live SQL acceptance. A failed preflight must not trigger an alternative installer automatically.
4. Take a fresh physical-staging-identity-bound read-only preflight with an empty operational floor. Choose initial install only for the reviewed absent-v2 state; choose reinstall only for the exact reviewed installed predecessor. Each artifact/run identity is immutable and single use.

## Evidence chain

Fresh preflight -> one atomic install/reinstall -> source-bound postflight -> one rollback-only 49-case transactional proof -> exact proof postrollback verification -> complete fixed Playwright suite -> immediate read-only posttest reconciliation and exact-ID cleanup verification.

Required operation limits remain database p95 below 500 ms and maximum below 2 seconds; HTTP/UI p95 below 2 seconds and maximum below 5 seconds; outer completion below 7 seconds. Retain 20 observations per class, same-scale v1 comparison, size sensitivity, unrelated-target overlap and 50 reload/mutation pairs. No global cold-start benchmark or atomic-bootstrap requirement.

The live runner requires E2E_RUN_ID, E2E_EXPECTED_COMMIT, E2E_EXPECTED_SOURCE_SHA256, E2E_EXPECTED_RUNTIME_SHA256, E2E_EXPECTED_BUNDLE_SHA256 and the existing manifest/proof/rollback paths and hashes. Runtime identity binds nonsecret station/customer/browser inputs and excludes credentials. It accepts no live Playwright selectors or overrides. --list is offline discovery and --help prints usage. Before/after source and deployed-bundle identity, exact file/project/title membership, every passed status and zero retries are mandatory. A run-start reservation binds the full approved source/runtime/DB lineage and survives Playwright output cleanup. Failure still seals evidence and returns nonzero; never replay an ambiguous mutation.

## Local commands (no staging execution)

```text
node --test scripts/lifecycle-runner-guards.nodechecks.mjs
node scripts/check-operational-v2-staging-static.mjs
node scripts/run-operational-v2-staging-e2e.mjs --list
```

The last command additionally requires the staging-only build configuration flags. It uses a no-write JSON discovery reporter; it must not create a live compact summary. The broad startup and optional customer-profile suites remain in the historical mixed branch, not this R1 package. Export regression checks retain baseline behavior only, without deferred-chunk assumptions.

## Stop conditions

Wrong environment, missing source/proof identity, open/ambiguous work, SQL/ACL drift, missing/skipped/duplicate test, retry, timeout, unexpected financial/stock effect, cleanup residue or changed source means STOP. Reconcile read-only and preserve failed evidence. No production write is implied. Final staging acceptance, rollback/backup validation and immediate owner approval remain prerequisites to production.
