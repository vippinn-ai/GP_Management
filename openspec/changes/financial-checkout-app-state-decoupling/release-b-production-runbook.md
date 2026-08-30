# Release B production deployment runbook

## Current decision

Staging Release B is GO. Production remains NO-GO until the user gives explicit approval immediately before production access or change. Preparation may validate local files and build artifacts; it must not query or mutate production.

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
npm run prepare:production:release-b
npm test -- --run
npm run lint
npm run build:production:release-b
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

Before the release window, commit and push the reviewed source. Then run the strict local check using the exact commit:

```powershell
node scripts/prepare-release-b-production.mjs --release-check --expected-commit=<full-commit-sha>
```

This strict check fails if the branch is wrong, the worktree is dirty, the commit differs, a flag is off, or evidence drifted.

## Explicit approval boundary

Stop and request explicit approval immediately before opening production Supabase, querying production, changing production SQL, uploading a Worker version, deploying, rolling back, changing a secret, or issuing a controlled production bill. Staging approval is not production approval.

## Production read-only preflight

After approval:

1. Open Supabase project `rrdwbxvuwrbxefarxnse` and visibly reconfirm the project identity.
2. Run `supabase/release-b-production-preflight-readonly.sql` once.
3. Save the single JSON result with its SHA-256 under `test-artifacts/evidence/`.
4. Require all of the following:
   - `open_active_sessions` = `0`;
   - `open_customer_tabs` = `0`;
   - `processing_financial_mutations` = `0`;
   - all three v2 functions exist;
   - all three authenticated grants and zero anonymous grants;
   - zero v2 function references to `app_state`;
   - `financial_mutations` RLS enabled.
5. If normalized tables/functions are missing or differ, stop. Capture exact production drift and build a reviewed, SHA-bound additive SQL install set before any write. Do not improvise or paste the staging evidence script into production.

## Cloudflare rollback capture

Before deployment, capture the current deployment and stable version IDs:

```powershell
npx wrangler deployments list --name management
npx wrangler versions list --name management --json
```

Record the exact active version ID in immutable evidence. Cloudflare Worker versions include code, assets, bindings, and compatibility settings, but do not version Supabase state. Database migrations are additive and are not rolled back by a Worker rollback.

## Controlled deployment

Only after every prior gate passes:

1. Apply the separately reviewed additive production SQL, if the production preflight proves it is missing. Re-run the read-only preflight and require an exact pass.
2. Run `npm run deploy:production` once. Do not retry an ambiguous upload or deployment; reconcile Cloudflare deployments first.
3. Capture the new Worker version/deployment ID and the deployed bundle filename/hash.
4. Hard-refresh staff devices.
5. Verify login and normalized read-only reconstruction before issuing money.
6. Issue one controlled representative bill with a stable mutation ID, then reconcile its bill, lines, payment, actor, session/tab, inventory, event, mutation, receipt, and unchanged financial `app_state` boundary.
7. Check Supabase logs immediately, after 30 minutes, and at end of day for `57014`, deadlocks, timeouts, duplicate effects, actor mismatch, stock mismatch, or entity resurrection.

## Stop and rollback conditions

Stop immediately for a missing or duplicate bill, incorrect payment/due, actor mismatch, stock mismatch, resurrected entity, realtime divergence, timeout, unexpected SQL error, or unexplained parity delta.

For a frontend/runtime problem with intact normalized data, roll back to the captured stable Worker version:

```powershell
npx wrangler rollback <stable-version-id> --name management --message "Release B controlled rollback"
```

Rollback is itself a production write and requires explicit approval unless the user has already authorized the documented stop-condition rollback. After rollback, verify the active deployment ID and re-run read-only reconciliation. Do not roll normalized financial data back into stale `app_state`.

## Known dependency advisory disclosure

The 2026-08-30 read-only production dependency audit reports one moderate, one high, and one critical advisory group in the existing export stack: transitive `dompurify`, direct `xlsx`, and direct `jspdf`. This checkout change did not introduce those runtime packages. `jspdf` has a major-version fix available; `xlsx` has no registry fix reported. Do not run `npm audit fix --force` as part of this release. A `jspdf` major upgrade and any `xlsx` replacement require a separate receipt/PDF/CSV/XLSX compatibility and security workstream. The user must be told about this known risk before production approval; it is not silently treated as checkout-test coverage.
