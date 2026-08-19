# Release A staging installation and verification runbook

## Scope and stop conditions

This runbook installs and verifies normalized read/bootstrap completeness while the existing v1 checkout remains active. It does not install `phase10-financial-v2-rpcs.sql`, enable `VITE_BACKEND_FINANCIAL_RPC_V2`, deploy to production, or remove the `app_state` fallback implementation.

Stop before changing staging if the local commit is not identified, local gates are red, staging has active billing work, a required normalized table/RPC is missing, the deployed definitions differ unexpectedly from the repository, or a pre-install parity query is unexplained.

## Evidence header

Record these fields in the release evidence before starting:

| Field | Value |
| --- | --- |
| UTC start/end | |
| Operator and reviewer | |
| Git commit | |
| Staging project ref | `tkbdyzxwwbhkpztgjjxh` |
| Previous frontend deployment | |
| Actual staging build flag capture/hash | |
| Browser/device versions | |
| Pre/post `app_state` hash and version | |
| SQL files applied | |
| Edge function version | |

Do not paste service-role keys, access tokens, passwords, or JWTs into the evidence.

## Gate 1: local artifact verification

From the repository root:

```powershell
git status --short
git rev-parse HEAD
node scripts/generate-checkout-review-manifest.mjs
npm test -- --run
npm run build
npm run lint
git diff --check
```

The intended staging flags are:

```text
VITE_BACKEND_RPC_OPERATIONAL_WRITES=true
VITE_BACKEND_NORMALIZED_LIVE_READS=true
VITE_BACKEND_RPC_FINANCIAL_WRITES=true
VITE_BACKEND_FINANCIAL_RPC_V2=false
VITE_BACKEND_NORMALIZED_REALTIME=true
VITE_BACKEND_NORMALIZED_BOOTSTRAP=true
VITE_BACKEND_NORMALIZED_CUSTOMER_SEARCH_READS=true
VITE_BACKEND_NORMALIZED_BILL_HISTORY_READS=true
VITE_BACKEND_NORMALIZED_REPORT_READS=true
VITE_BACKEND_ANALYTICS_SUMMARY_READS=true
VITE_BACKEND_INVENTORY_REPORT_READS=true
```

The application feature-flag resolver must reject a configuration that enables financial v2 without normalized bootstrap, operational RPC writes, normalized financial readers, and normalized realtime.

## Gate 2: capture staging drift before installation

Run the following read-only queries in the staging SQL editor and retain their result exports.

```sql
select
  current_database() as database_name,
  current_setting('server_version') as server_version,
  now() as captured_at;

select
  p.oid::regprocedure::text as function_signature,
  pg_get_functiondef(p.oid) as function_definition,
  p.proacl as grants
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'resolve_operational_inventory_item',
    'open_customer_tab',
    'add_customer_tab_item',
    'update_customer_tab_item_quantity',
    'remove_customer_tab_item',
    'edit_pause_log',
    'delete_pause_log',
    'record_session_audit',
    'commit_checkout_bill',
    'commit_financial_adjustment',
    'commit_admin_data_change',
    'get_analytics_summary',
    'get_inventory_report_summary'
  )
order by 1;

select schemaname, tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in (
    'sessions', 'session_pause_logs', 'customer_tabs', 'customer_tab_items',
    'customers', 'bills', 'payments', 'inventory_items', 'stock_movements',
    'audit_logs', 'operational_events', 'profiles'
  )
order by tablename, indexname;

select attname as column_name, format_type(atttypid, atttypmod) as data_type
from pg_attribute
where attrelid = 'public.profiles'::regclass
  and attname = 'tab_permissions'
  and not attisdropped;

select pubname, schemaname, tablename
from pg_publication_tables
where schemaname = 'public'
  and tablename in ('operational_events', 'app_state')
order by pubname, tablename;

select
  id,
  version,
  updated_at,
  encode(digest(data::text, 'sha256'), 'hex') as data_sha256
from public.app_state
where id = 'primary';
```

Run the repository parity and performance probes against staging and save every result:

- `supabase/phase1-parity-checks-single-result.sql`
- `supabase/phase3-performance-evidence-probes-single-result.sql`
- `supabase/phase7-analytics-summary-verification.sql`
- `supabase/phase9-inventory-report-summary-verification.sql`

Any unexplained count, total, relationship, organization, or business-day mismatch is a stop condition.

## Gate 3: additive Release A database changes

Review captured definitions against the repository before applying anything. If an earlier prerequisite phase is absent, stop and reconcile the exact missing prerequisite; do not blindly replay all phases over staging.

Apply in this order, one file at a time, retaining the SQL editor result:

1. `supabase/phase4-customer-tab-rpcs.sql` — makes normalized inventory authoritative for customer-tab validation while preserving v1 compatibility writes.
2. `supabase/phase11-operational-maintenance-rpcs.sql` — installs purpose-built pause edit/delete and continuation-audit APIs and adds `profiles.tab_permissions`.
3. Deploy the repository version of `supabase/functions/admin-update-user` to the staging project so the authenticated profile update writes `tab_permissions` atomically.

Do not apply `supabase/phase10-financial-v2-rpcs.sql` in Release A. Do not enable the financial v2 flag.

After each SQL file, rerun the relevant function-definition and grant query from Gate 2. Confirm helper functions are not executable by `anon`, public maintenance RPCs are executable only by `authenticated`, and their definitions match the reviewed repository text.

## Gate 4: deploy the Release A frontend to staging

`.env.staging` is intentionally ignored and is not proven by the Git commit. Before building, capture the actual staging build environment's feature-flag names and boolean values from the operator/deployment system, redact all URLs/keys/tokens, hash the redacted capture, and have the reviewer compare it with Gate 1. Explicitly prove the effective v2 flag is false in the built application. Deploy only the reviewed commit and reviewed flag capture using the existing staging deployment workflow. Record the resulting deployment identifier and URL.

Hard-refresh every staging test browser after deployment. Do not reuse a tab containing a pre-deployment JavaScript bundle.

## Gate 5: functional and two-browser verification

Use two independently authenticated browser sessions and retain screenshots, console/network evidence, entity IDs, and database rows for each case.

| Area | Required evidence |
| --- | --- |
| Startup | Normalized bootstrap completes; no `app_state.data` read is used to populate financial screens. |
| Live session/tab | Start, add/update/remove items, pause/resume, edit/delete pause, hop/detach, and reject propagate to browser 2 without resurrection after refresh. |
| Existing v1 checkout | Timed and unit-sale session plus customer-tab checkout complete with correct bill, payment, stock, audit, receipt, and closure rows. |
| Bill Register | Search and paginate into older history; receipts resolve previous-due and replacement bill numbers outside the displayed page; perform authorized settlement/replacement/void/refund actions; the page becomes read-only/loading until canonical refetch and ignores late pre-action load-more results. |
| Receivables | All pending bills and payments agree before/after refresh; older-bill settlement received today appears on the correct business date. |
| Reports | Dashboard, analytics, detail reports, exports, and receipt totals agree with normalized SQL results. |
| Customers | Directory/search and complete bill history load; visit time uses linked session start or tab open time, then bill issue time only for counter-only bills. |
| Inventory | Catalog, current stock, movement report, combos, variants, cigarette packs, and reservations agree before/after refresh. |
| Permissions | Admin tab-permission edit survives sign-out/in and changes only `profiles.tab_permissions`; `app_state` hash remains unchanged. |
| Fail-closed reads | Force each normalized history/report/customer/inventory read to fail in a controlled test; the UI shows retry/read-only state and never cached financial totals. |
| Realtime deletion | Deleting a pause replaces that session's complete pause-log set in browser 2. |

For every write case, resolve the actor through `auth.uid()`/`profiles.id` and confirm audit attribution. A discrepancy is a failed case, not evidence to rationalize.

## Gate 6: post-install database evidence

Repeat all Gate 2 captures plus the parity and verification scripts. Prove:

- the `app_state.data` hash did not change during read-only navigation and permission editing;
- normalized and compatibility totals/counts have no unexplained delta after the controlled v1 bills;
- no duplicate bills/payments, negative stock, resurrected sessions/tabs, or missing operational events exist;
- no SQLSTATE `57014`, deadlock, client timeout, or global full-state save was observed;
- financial v2 remains disabled and its SQL was not part of this release.

## Soak and promotion gate

Run staging for one full representative business day with v1 checkout. Record every bill, adjustment, session/tab lifecycle, read error, realtime miss, and latency exception. Release A is eligible for a separately approved production rollout only when all cases are Passed, there are no unexplained parity deltas, and the independent tester signs off on the evidence.

Production remains out of scope for this runbook execution. After a separately approved Release A production deployment, observe one full production business day before beginning the financial-v2 staging cutover.

## Rollback

If staging shows a missing/duplicate financial row, wrong actor, stock mismatch, resurrected entity, stale fallback, permissions failure, or realtime divergence:

1. Stop all test mutations and record the exact IDs/timestamps.
2. Disable access to the affected staging deployment or restore the prior frontend deployment.
3. Keep financial v2 off.
4. Do not delete normalized evidence or rewrite `app_state`.
5. Compare the pre/post definitions, hashes, parity exports, browser logs, and database rows before deciding on a corrective migration.

Rollback evidence must be retained with the same evidence header. A production rollback is a separate decision and is not authorized by this document.
