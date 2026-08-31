# Release B production deployment runbook

## Current decision

Staging Release B is GO. The 2026-08-31 production readiness audit was explicitly limited to read-only discovery. Production writes remain NO-GO until the backup, additive SQL, post-SQL preflight, compatibility rollback version, and final approval gates below are complete. No SQL install, Worker upload, deployment, rollback, test bill, or other production mutation was performed during discovery.

Read-only discovery at `2026-08-31T07:23:36.758305Z` proved:

- zero active/paused sessions;
- zero open customer tabs;
- `financial_mutations` is not installed;
- all three financial-v2 functions are absent;
- 22 of 25 existing required functions are installed and authenticated; the three intentionally additive phase-11 operational-maintenance functions (`edit_pause_log`, `delete_pause_log`, and `record_session_audit`) are absent;
- compatibility `app_state` version/size is `10033` / `4,810,800` bytes.

The Supabase dashboard reports the project is on the Free plan and has no scheduled platform backups. A fresh, hashed logical backup is therefore mandatory before any production SQL write. Because the floor can change after discovery, zero active sessions/tabs must be re-proven immediately before the SQL transaction and immediately before the Worker deployment.

## Prepared release identity

- Source branch: `codex/checkout-app-state-decoupling`.
- Production Supabase project: `rrdwbxvuwrbxefarxnse`.
- Production Cloudflare Worker: `management`.
- Production URL: `https://management.breakperfectgaminglounge.workers.dev`.
- Required frontend mode: normalized reads and financial v2 all enabled.
- Staging independent verdict: GO with no mandatory failed, blocked, or unexplained not-run case.
- Mixed aggregate SHA-256: `39ad4a4439fbbfcc3e7f4c62537200d0b76050b0e1ff46896978f840e1f07800`.
- Deployed staging SQL/plan evidence SHA-256: `43e8ffab19d95f812716914349890ff3bb63ee774d43ecee2f42d808beb84336`.
- Staging log-gate SHA-256: `fd973cc6243b613a5d5cb8a4edfcf51ac8a583f3d0ede52afb7f67a15f9cc7b7`.
- Final fixture-cleanup SHA-256: `cdbd15aa163cc583500f0f8080f7fa699391cc1c711c1c57901d063fdd6b2de6`.

## Local preparation gate

Run:

```powershell
npm test -- --run
npm run lint
npm run build:production:release-b
npm run build:production:release-b:rollback
npm run prepare:production:release-b
npx wrangler deploy --dry-run --name management --outdir test-artifacts/cloudflare-production-dry-run
```

The preparation command must prove the exact production project, exclude the staging project, require every Release B flag, verify every retained evidence hash, verify Wrangler v4+, and print no secret. The production-mode build must contain the production project reference and no staging reference. A dry run validates packaging but does not deploy.

Local preparation completed on 2026-08-30 without production access or writes:

- the ignored `.env.production` was copied from the existing production-configured project and upgraded only by setting all required Release B feature flags to `true`;
- the exact Supabase project is `rrdwbxvuwrbxefarxnse`, every required flag is true, and no secret was printed;
- Wrangler `4.127.1` is installed as a project-local development dependency;
- the production-mode bundle is `dist/assets/index-B23LCT31.js`, SHA-256 `77efff31803b6e12322b1208253e1d30c1b6b840cafbace741b8435724bc7343`;
- the bundle contains the production project and all three financial-v2 RPC paths, and contains no staging project reference;
- Wrangler dry run completed successfully and exited without deploying.

Before the release window, commit and push the reviewed source. Rebuild the v2 bundle and compatibility rollback bundle from that clean commit. At the production window, capture a fresh exact production baseline, build the atomic SQL artifact with `npm run build:production:release-b:sql -- --baseline-evidence=<fresh-evidence-path>`, and take the backup. Then run the strict local check using the exact commit:

```powershell
node scripts/prepare-release-b-production.mjs --release-check --expected-commit=<full-commit-sha>
```

This strict check fails if the branch is wrong, the worktree is dirty, the commit differs, a flag is off, staging evidence drifted, either production artifact hash differs, or the rollback/SQL artifacts were not built from that exact clean commit.

## Explicit approval boundary

Stop and request explicit approval immediately before changing production SQL, uploading a Worker version, deploying, rolling back, changing a secret/database password, or issuing a controlled production bill. Staging approval is not production approval. Read-only readiness queries do not authorize a later write.

## Open-session stop gate

Do not deploy, install SQL, or force-close anything while an active/paused session or open customer tab exists.

1. Wait for staff to complete, reject, or hop the live entity through the existing production UI.
2. If an entity appears stuck, stop the release and investigate it as a separate incident. Do not change its status for the sake of deployment.
3. Re-run `supabase/release-b-production-discovery-readonly.sql` after the floor is naturally empty.
4. After v2 SQL is installed, re-run `supabase/release-b-production-preflight-readonly.sql` and require all zero/existence/grant/RLS/app-state-reference gates.

Any nonzero floor result consumes the release window. A later deployment requires a fresh read-only capture; an earlier zero is never reused.

## Mandatory backup gate

The Free plan has no platform restore point. Before the first production SQL write:

1. Obtain the production database password without placing it in a file, command line, log, evidence artifact, or source control. If it is unknown, stop and separately approve a database-password reset; do not guess credentials.
2. Run `scripts/backup-release-b-production.ps1`. It normally prompts through a masked secure-string input. For an approved remote operation, `-UsePasswordFromEnvironment` accepts `SUPABASE_DB_PASSWORD` only from the current process and clears both that variable and `PGPASSWORD` in `finally`; never place the password in a file or command argument.
3. The script uses the reviewed IPv4 session-pooler identity and portable official PostgreSQL 17.11 clients, without changing the staging link. Before reading the password, it requires the pinned official archive, `pg_dump`, and `pg_dumpall` SHA-256 values and exact tool versions. It produces ignored, local `roles.sql` (without role passwords), `public-schema.sql`, and `public-auth-storage-data.sql` files under `production-backups/`.
4. Require all three files to be non-empty and require the manifest SHA-256 for each file and for the read-only baseline evidence.
5. The 2026-08-31 baseline shows eight Auth users and zero Storage buckets/objects. Auth data and Storage metadata are included in the data dump; there are currently no Storage object binaries to copy.
6. Do not call the backup disaster-recovery-ready until a restore drill succeeds in a separate disposable database/project. A failed restore drill blocks the release.

The reusable restore command is `npm run restore:production:release-b:verify -- -BackupDirectory <backup-path> -TargetProjectRef <disposable-ref> -ConfirmDisposableProjectRef <same-ref> -TargetHost <session-pooler-host>`. It refuses the production and staging references, re-verifies every backup and toolchain hash before reading the password, and restores public schema plus public/Auth/Storage data only to the confirmed disposable target. On Supabase-to-Supabase restores it preserves target-owned `auth.schema_migrations` and `storage.migrations`, verifies the captured managed-role set against the platform-provisioned roles instead of replaying raw role DDL, and writes a SHA-bound parity report. A verification-only resume may be used after a successful data transaction when only a later read-only assertion needed correction; it must still prove every count, total, timestamp, managed-schema count, role, empty-floor value, app-state version, and logical app-state SHA-256. Physical `pg_column_size` is diagnostic because PostgreSQL TOAST/compression layout may differ across databases while the logical JSON hash remains exact.

The backup is a disaster-recovery asset, not the normal rollback mechanism. Restoring it over production would discard transactions created after capture. For a committed logical defect, stop new writes and reconcile the exact mutation; restore the backup into a separate environment for comparison or selective recovery. A full production restore is reserved for catastrophic loss and requires a separate approved outage plan.

## Production read-only discovery and preflight

After approval:

1. Open Supabase project `rrdwbxvuwrbxefarxnse` and visibly reconfirm the project identity.
2. Before v2 exists, run `supabase/release-b-production-discovery-readonly.sql`. It is intentionally safe when the additive v2 table/functions are absent.
3. Capture `supabase/release-b-production-baseline-readonly.sql` immediately before backup. Use Supabase SQL Editor's **Copy as JSON** without editing the result and save that raw export under `test-artifacts/evidence/`. Mechanically normalize it with `npm run normalize:production:release-b:baseline -- --raw-export=<raw-path> --output=<new-normalized-path> --dashboard-url=<visible-production-sql-url> --dashboard-title=<visible-production-title>`. The normalizer fails closed unless the raw export is exactly one baseline row, the dashboard URL/title identify production, and the pinned baseline-SQL SHA matches; its output records the canonical raw-result hash, saved-file hash, and SQL hash. The normalized evidence must prove read-only execution, an empty floor, and the app-state version/hash, and must be no more than 15 minutes old when backup starts. Require the backup manifest to bind all four hashes, including the normalized-evidence hash.
4. Build the production SQL artifact from that same fresh evidence. Its first statement block must abort unless the live database still has that exact app-state version/hash, empty floor, 22-function existing RPC baseline, `org-primary`, and no partially installed Release B objects.
5. Install the exact reviewed additive files through that guarded artifact in one transaction and in this order: `supabase/phase11-operational-maintenance-rpcs.sql` (SHA-256 `bf056dd0a05f9388fae52c1e666ef35aa4a7a226a67694c0f4337120bb8aa752`), then `supabase/phase10-financial-v2-rpcs.sql` (SHA-256 `9e54f1afeeb47a45ded330536ab4237486407aba86a84a24dde3c3fc7f41a780`). Then run `supabase/release-b-production-preflight-readonly.sql` once.
6. Save each JSON result with its SHA-256 under `test-artifacts/evidence/`.
7. Require all of the following:
   - `open_active_sessions` = `0`;
   - `open_customer_tabs` = `0`;
   - `processing_financial_mutations` = `0`;
   - all three v2 functions exist;
   - all three authenticated grants and zero anonymous grants;
   - all three operational-maintenance functions exist;
   - all three operational-maintenance authenticated grants and zero anonymous grants;
   - exact reviewed definition SHA-256 for all six functions;
   - owner `postgres`, `SECURITY DEFINER`, volatile behavior, and `search_path=public` for all six functions;
   - authenticated execute and zero `PUBLIC`/anon execute on all six functions;
   - zero v2 function references to `app_state`;
   - `financial_mutations` RLS enabled.
   - exactly one reviewed `financial_mutations_select_org_members` policy, no authenticated/anon direct table privileges, no PUBLIC ACL privileges, owner `postgres`, and both expected indexes.
8. If normalized tables/functions are missing or differ, stop. Capture exact production drift and build a reviewed, SHA-bound additive SQL install set before any further write. Do not improvise or paste the staging evidence script into production.

## Cloudflare versions and data-safe rollback

Before deployment, capture the current deployment and stable version IDs:

```powershell
npx wrangler deployments list --name management
npx wrangler versions list --name management --json
```

The read-only 2026-08-31 capture identifies current 100% production version `d60fbd1b-44ae-4cbf-a6a1-e453fae51bb6` (version 54). Record a fresh value again at the release window. Cloudflare Worker versions include code, assets, bindings, and compatibility settings, but do not version Supabase state. Database migrations and financial rows are never rolled back by a Worker deployment.

Do not use the current legacy version as the normal rollback target after any v2 bill has committed: it can rely on stale `app_state`. Instead:

1. Run `npm run build:production:release-b:rollback`. This builds `dist-production-rollback/` from the same reviewed source with normalized reads kept on, v1 financial fallback kept on, and only `VITE_BACKEND_FINANCIAL_RPC_V2=false`.
2. Require its verifier evidence to show the exact production project, no staging project, normalized bootstrap present, v2 flag false, v1 financial paths present, and a bundle SHA-256.
3. After explicit production approval but before v2 deployment, upload this compatibility build without routing traffic:

```powershell
npx wrangler versions upload --config wrangler.rollback.jsonc --name management --tag release-b-compat-rollback --message "Release B normalized-read compatibility rollback"
```

4. Record the returned compatibility version ID. If rollback is required after any v2 commit, route 100% to this exact version:

```powershell
npx wrangler versions deploy <compatibility-version-id>@100% --name management --yes --message "Release B data-safe compatibility rollback"
```

5. Leave the additive v2 SQL and all normalized financial rows installed. Re-run read-only floor, bill/payment, mutation, inventory, actor, event, and `app_state`-boundary reconciliation.

The legacy stable version may be restored only if the v2 frontend never received traffic and no v2 financial mutation committed. Even then, record the proof before using:

```powershell
npx wrangler rollback <stable-version-id> --name management --message "Release B pre-traffic rollback"
```

## Controlled deployment

Only after every prior gate passes:

1. Require a successful backup manifest and restore drill, fresh zero-floor discovery, and the uploaded compatibility rollback version.
2. Apply the SHA-bound generated `test-artifacts/production-sql/release-b-production-install.sql` once. It wraps the two reviewed sources in one transaction with fail-closed timeouts. Re-run the read-only preflight and require an exact pass.
3. Run `npm run deploy:production` once. Do not retry an ambiguous upload or deployment; reconcile Cloudflare deployments first.
4. Capture the new Worker version/deployment ID and the deployed bundle filename/hash.
5. Hard-refresh staff devices.
6. Verify login and normalized read-only reconstruction before issuing money.
7. Issue one controlled representative bill with a stable mutation ID, then reconcile its bill, lines, payment, actor, session/tab, inventory, event, mutation, receipt, and unchanged financial `app_state` boundary.
8. Check Supabase logs immediately, after 30 minutes, and at end of day for `57014`, deadlocks, timeouts, duplicate effects, actor mismatch, stock mismatch, or entity resurrection.

## Stop and rollback conditions

Stop immediately for a missing or duplicate bill, incorrect payment/due, actor mismatch, stock mismatch, resurrected entity, realtime divergence, timeout, unexpected SQL error, or unexplained parity delta.

For a frontend/runtime problem with intact normalized data after v2 traffic, deploy the prepared compatibility version:

```powershell
npx wrangler versions deploy <compatibility-version-id>@100% --name management --yes --message "Release B data-safe compatibility rollback"
```

Rollback is itself a production write and requires explicit approval unless the user has already authorized the documented stop-condition rollback. After rollback, verify the active deployment ID and re-run read-only reconciliation. Do not delete v2 SQL, delete financial rows, or restore the pre-release database over valid later transactions. Do not roll normalized financial data back into stale `app_state`.

## Known dependency advisory disclosure

The 2026-08-30 read-only production dependency audit reports one moderate, one high, and one critical advisory group in the existing export stack: transitive `dompurify`, direct `xlsx`, and direct `jspdf`. This checkout change did not introduce those runtime packages. `jspdf` has a major-version fix available; `xlsx` has no registry fix reported. Do not run `npm audit fix --force` as part of this release. A `jspdf` major upgrade and any `xlsx` replacement require a separate receipt/PDF/CSV/XLSX compatibility and security workstream. The user must be told about this known risk before production approval; it is not silently treated as checkout-test coverage.
