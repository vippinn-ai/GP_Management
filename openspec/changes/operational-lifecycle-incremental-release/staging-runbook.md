# R1 staging execution contract

Status: preparation draft; NOT approved for live execution. Runtime base f85b11a has independent local evidence, but this tooling successor still needs reviewer/tester acceptance. Production is excluded.

## Pre-execution gates

1. Freeze a clean exact candidate commit and source identity. Review the five runtime/helper SQL sources and retained continuation consumers against read-only installed definitions. Never infer an installed SQL version from a frontend build.
2. Run local unit/type/lint and the 14-spec static check. Offline Playwright discovery must identify the full 31-case R1 suite, with the single maintenance-only abandoned-session cleanup case excluded. Discovery executes zero tests and is not acceptance.
3. Independently re-review the implemented corrections for preserved-function reinstall provenance, identical SQL-body canonicalization and complete mutation-table/function security checks before generating or executing SQL. Local negative fixtures pass, but there is no live SQL acceptance. A failed preflight must not trigger an alternative installer automatically.
4. Take a fresh physical-staging-identity-bound read-only preflight with an empty operational floor. Choose initial install only for the reviewed absent-v2 state; choose reinstall only for the exact reviewed installed predecessor. Each artifact/run identity is immutable and single use.

## Evidence chain

Both package builders and the postflight verifier require `--expected-commit=<reviewed full SHA>`. They refuse a dirty or mismatched checkout and bind the complete runtime/SQL/tooling source hash. Generate packages only after the corrected candidate is committed and independently approved; do not bypass this guard for live use.

Initial install additionally requires absence of the mutation table, all three v2 functions and the dataset helper at preflight and inside the installation transaction. Strict CREATE statements refuse a concurrent appearance. There is no automatic reinstall fallback. Existing start/open/link predecessor definitions and ACLs remain captured for rollback. Both modes bind all five compatibility-state identity fields.

Run the package-generated `staging-postflight-readonly.sql`, not the unrendered template. Its result must carry the matching package run ID, source commit and source hash. The verifier binds and hashes this artifact, checks the exact seven-function metadata/ACL contract, zero open sessions/tabs/recoverable hops/incomplete mutations, and the owner-only mutation-table ACL with RLS/no policies. Missing evidence is a failure.

Installed function owner is postgres; EXECUTE ACL is exactly postgres and authenticated without grant options. PUBLIC, anon and service_role execution must be absent. Reinstall does not silently normalize an unexpected predecessor: all seven preflight functions must meet this security/metadata contract, and preserved bodies must match candidate source. Unexpected grants/configuration require review of a new explicit package, never switching install modes or editing saved evidence.

The original rollback artifact already guards all seven candidate bodies and metadata before restoring predecessor definitions. It does not depend on successful postflight to become safe. Preserve the mutation table and committed rows; verify exact predecessor restoration and unchanged compatibility state. Postflight verification adds raw installed-definition hashes as an additional drift check, not as a substitute for the original guard.

Preflight function sets must be unique and complete: initial mode has the three legacy lifecycle functions plus start/open/link; reinstall includes those six plus v2 trio/dataset helper. Both rollbacks guard table owner, ACL, enabled-but-not-forced RLS and empty policies before and after restoring functions, without requiring committed rows to be absent.

Database version is part of package identity: exact `server_version_num` must match preflight, install/rollback and postflight. Supported contract is PostgreSQL 15/16 (seven owner table privileges) or 17 (also MAINTAIN); any other major requires explicit review. PostgreSQL documents MAINTAIN in its [version 17 default-privilege contract](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html). Never weaken an ACL mismatch into an optional arbitrary privilege.

Fresh preflight -> one atomic install/reinstall -> source-bound postflight -> one rollback-only 49-case transactional proof -> exact proof postrollback verification -> complete fixed Playwright suite -> immediate read-only posttest reconciliation and exact-ID cleanup verification.

Required operation limits remain database p95 below 500 ms and maximum below 2 seconds; HTTP/UI p95 below 2 seconds and maximum below 5 seconds; outer completion below 7 seconds. Retain 20 observations per class, same-scale v1 comparison, size sensitivity, unrelated-target overlap and 50 reload/mutation pairs. No global cold-start benchmark or atomic-bootstrap requirement.

The live runner requires E2E_RUN_ID, E2E_EXPECTED_COMMIT, E2E_EXPECTED_SOURCE_SHA256, E2E_EXPECTED_RUNTIME_SHA256, E2E_EXPECTED_BUNDLE_SHA256 and the existing manifest/proof/rollback paths and hashes. Runtime identity binds nonsecret station/customer/browser inputs and excludes credentials. It accepts no live Playwright selectors or overrides. --list is offline discovery and --help prints usage. Before/after source and deployed-bundle identity, exact file/project/title membership, every passed status and zero retries are mandatory. A run-start reservation binds the full approved source/runtime/DB lineage and survives Playwright output cleanup. Failure still seals evidence and returns nonzero; never replay an ambiguous mutation.

## Local commands (no staging execution)

### Explicit staging ACL convergence (26 September predecessor)

The complete 15:12 UTC read-only capture found matching bodies for all ten functions, but additional direct non-grantable service_role EXECUTE on the seven candidate functions and eight service_role privileges on operational_mutations. Owner, RLS, forced-RLS and policies match. Do not bypass the existing install/reinstall contracts or replace matching business functions.

Use the separate `build-operational-lifecycle-v2-staging-acl-convergence.mjs` only after independent source/test approval and freezing a clean commit. Required arguments are `--run-id=normops-YYYYMMDD-HHMM-slug`, `--expected-commit=<full SHA>` and `--preflight=<immutable complete raw JSON>`. It binds source, physical staging cluster, identity nonce, org-primary, exact PostgreSQL 170006, all ten definitions/metadata, five app_state identity fields, zero operational floors and complete table security. It never reuses an output directory.

Forward scope is exactly seven REVOKE EXECUTE statements and eight explicit table-privilege REVOKEs from service_role. Legacy functions, function definitions, rows, schema, RLS and policies are unchanged. Both directions use a bounded transaction, shared business-table locks and before/after exact catalog/state checks. The inverse restores only those fifteen original grants without grant options; it is not a destructive database restore. Rollback deliberately refuses if the recorded app_state identity or empty operational floor has changed. Do not erase later data or weaken a guard to force rollback; investigate and prepare a new reviewed state-bound package instead.

Generated postflight is read-only and carries package/source/preflight identities. Verify with `verifyAclPostflight` from `scripts/lifecycle-acl-convergence.mjs`, supplying root, manifestPath, evidencePath and phase `after` (forward) or `before` (rollback). Verification regenerates every SQL artifact from the clean source and compares exact bytes/hashes plus observed state. Do not treat a generated artifact, synthetic postflight or local test as live SQL proof. Do not automatically execute the inverse, which re-expands privileges; satisfy action-time authorization requirements first.

Exact CLI: `node scripts/verify-operational-lifecycle-v2-staging-acl-convergence.mjs --manifest=<generated manifest.json> --evidence=<immutable postflight.json> --phase=after`. Use `--phase=before` only for evidence following the separately authorized inverse. Wrong phase, dirty source, missing evidence, altered raw preflight, SQL artifact or observed identity is a failure.

Lock order is READ COMMITTED transaction -> exact environment/role precheck -> package advisory lock -> shared table locks -> full exact state guard -> fifteen explicit privilege operations -> full exact state guard -> commit. The fresh statement snapshots avoid relying on a catalog snapshot taken before locks. The advisory lock coordinates cooperating tools, not all possible pg_proc DDL. Non-cooperating function DDL is not absolutely excluded; exact before/after guards, catalog update conflicts and immediate postflight are mandatory fail-closed controls. Do not run unrelated staging DDL concurrently.

One reviewed forward execution, immutable postflight and offline verification must precede the existing 49-case transactional proof and 31-case reusable Playwright gates. No repeated installation is justified merely to replace matching bodies. Any proof/runner lineage change needed to accept this package requires explicit independent review; do not fabricate an old installer manifest. Production is excluded.

```text
node --test scripts/lifecycle-runner-guards.nodechecks.mjs
node scripts/check-operational-v2-staging-static.mjs
node scripts/run-operational-v2-staging-e2e.mjs --list
```

The last command additionally requires the staging-only build configuration flags. It uses a no-write JSON discovery reporter; it must not create a live compact summary. The broad startup and optional customer-profile suites remain in the historical mixed branch, not this R1 package. Export regression checks retain baseline behavior only, without deferred-chunk assumptions.

## Stop conditions

Wrong environment, missing source/proof identity, open/ambiguous work, SQL/ACL drift, missing/skipped/duplicate test, retry, timeout, unexpected financial/stock effect, cleanup residue or changed source means STOP. Reconcile read-only and preserve failed evidence. No production write is implied. Final staging acceptance, rollback/backup validation and immediate owner approval remain prerequisites to production.
