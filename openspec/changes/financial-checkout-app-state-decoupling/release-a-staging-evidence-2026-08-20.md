# Release A staging execution evidence — 2026-08-20

## Scope

- Project: `test/staging` (`tkbdyzxwwbhkpztgjjxh`), Southeast Asia (Singapore).
- Reviewed deployment commit: `0af9c7b0cb35e521fd35bff9ba7980d792cf100e`.
- Financial v2 remained disabled; phase 10 was not applied.
- No production project, production database, or production deployment was accessed.
- Staging was resumed from its paused state. The initial investigation was read-only. After the user explicitly approved the staging-only destructive reconstruction, a verified backup was retained and normalized `org-primary` was rebuilt from authoritative `app_state`.

## Project and compatibility baseline

Captured at `2026-08-19T19:28:17.526161+00:00` (`2026-08-20 00:58:17 IST`):

- PostgreSQL `17.6`; project status became Healthy after restoration.
- `app_state.id = primary`.
- `app_state.version = 487`.
- `app_state.updated_at = 2026-07-27T05:33:35.017281+00:00`.
- `app_state.data` SHA-256: `cf5e87672491da73d41db3565218c79f9b98a1e938c2b1ad4c2c934a12d670d5`.
- Required normalized tables exist.
- `app_state` and `operational_events` are both in `supabase_realtime`.
- `profiles.tab_permissions` is absent.
- `edit_pause_log`, `delete_pause_log`, and `record_session_audit` are absent.
- `load_analytics_summary(text,date,date,date,date)` and `load_inventory_report_summary(text,date,date,text,integer)` were present, denied to `anon`, and granted to `authenticated`. The earlier probe used incorrect `get_*` names; the frontend and repository use these `load_*` signatures.
- Existing public operational/financial/admin RPCs are granted to `authenticated`; the internal inventory resolver is not granted to `authenticated` or `anon`.

## Pre-reconstruction parity result

The repository `phase1-parity-checks-single-result.sql` returned 36 rows. The following non-zero deltas block normalized-source promotion:

| Metric | `app_state` | Normalized | Delta |
| --- | ---: | ---: | ---: |
| audit logs | 531 | 769 | +238 |
| bill discounts | 13 | 11 | -2 |
| bill line discounts | 4 | 3 | -1 |
| bill lines | 342 | 322 | -20 |
| bills | 119 | 112 | -7 |
| customer tabs | 58 | 59 | +1 |
| customers | 61 | 86 | +25 |
| payments | 127 | 118 | -9 |
| pause logs | 18 | 33 | +15 |
| sessions | 110 | 111 | +1 |
| stock movements | 272 | 359 | +87 |
| bill amount due | Rs 652 | Rs 852 | +Rs 200 |
| bill amount paid | Rs 196,976 | Rs 194,126 | -Rs 2,850 |
| bill total | Rs 197,628 | Rs 194,978 | -Rs 2,650 |
| payment amount | Rs 197,476 | Rs 194,126 | -Rs 3,350 |
| stock quantity | 999,802 | 999,680 | -122 |
| open customer tabs | 0 | 1 | +1 |
| open sessions | 0 | 1 | +1 |
| pending bills | 0 | 1 | +1 |

Catalog, combo, expense, pricing, station, item, and variant counts not listed above were equal. Inventory item current-stock values had no per-item difference, despite the historical movement-count and movement-total deltas.

## Financial differences

Normalized tables contain no bill or payment IDs absent from `app_state`; they are an incomplete subset for these collections.

Seven bills exist only in `app_state`, and none of their bill numbers exists under another normalized ID:

- `BILL-20260620-001` — Rs 697.
- `BILL-20260620-002` — Rs 0.
- `BILL-20260620-003` — Rs 73.
- `BILL-20260620-004` — Rs 854.
- `BILL-20260620-023` — Rs 10.
- `BILL-20260621-010` — Rs 517.
- `BILL-20260621-011` — Rs 499.

Nine payment IDs exist only in `app_state`, totaling Rs 3,350. They include the payments for the missing bills and older-bill settlement payments.

Bill `BILL-20260418-003` (`bill-a13bfafe-17a4-469a-a9c2-114368789a89`) demonstrates stale lifecycle state:

- `app_state`: issued/settled, amount paid Rs 700, amount due Rs 0, settled at `2026-06-20T21:29:23.325Z`.
- normalized: pending, amount paid Rs 500, amount due Rs 200.

## Stale normalized live rows

The normalized tables retain rows that are absent from the current `app_state` live summary:

- Open customer tab `customer-tab-845371bc-9803-4dc4-b8f5-e345bd7e324b`, customer `Harpreet`, opened `2026-07-22T14:30:50.527Z`.
- Paused session `session-0ed9589f-98f0-4662-85e3-7cd1e948d3bb`, customer `rudraksh`, station `station-snooker-sharma`, started `2026-07-22T15:13:28.943Z` and paused `2026-07-22T15:18:45.727583Z`.

Their start/open/pause operational events exist, but the later state represented in `app_state` is not reflected in those normalized rows.

## Backup and reconstruction

The user explicitly approved deletion and reconstruction of staging normalized `org-primary`; production remained out of scope.

- Backup schema: `release_a_backup_20260820_0af9c7b`.
- Backup capture: `2026-08-19T19:34:38.400815+00:00`.
- Backup contents: 46 captured data/metadata tables and 4,564 rows, plus the backup row-count table.
- Backup includes every public `organization_id` table for `org-primary`, primary `app_state`, all profiles, public function definitions and grants, indexes, and realtime publication membership.
- Backup `app_state`: version `487`, updated at `2026-07-27T05:33:35.017281+00:00`, SHA-256 `cf5e87672491da73d41db3565218c79f9b98a1e938c2b1ad4c2c934a12d670d5`; all three fields exactly matched live staging before reconstruction.
- No other active non-system staging database connection was present immediately before reconstruction.

The first direct phase-1 backfill attempt failed on `analytics_dirty_dates_organization_id_fkey`: an existing analytics trigger fired during the organization cascade. PostgreSQL rolled the statement back. A follow-up query proved the organization and pre-attempt counts remained present (`bills=112`, `payments=118`, `sessions=111`, `audit_logs=769`, `operational_events=416`) and the `app_state` version/hash were unchanged.

The approved backfill was then run in one explicit transaction. Public user-trigger modes were captured in a temporary table, user triggers were disabled only for the reconstruction, and each trigger was restored to its original `O`, `D`, `R`, or `A` mode before commit. The reviewed repository backfill SHA-256 was `967da7e9c7f06e9ae1e6b5a10321b7562f249f7deb18fecb133b53d49e98aa3e`; the transaction wrapper SHA-256 was `2d2fcc56d7190dee25c77991a6847bcf44be9a4bb6c142b7e869788a29b69b50`.

Post-reconstruction evidence:

- All 36 repository parity rows returned delta `0`.
- Core normalized counts became `bills=119`, `payments=127`, `sessions=110`, `customer_tabs=58`, `audit_logs=531`, and `stock_movements=272`.
- Stale normalized open sessions, tabs, and pending bills became `0`, matching `app_state`.
- The reconstructed compatibility baseline intentionally contains `0` historical `operational_events`; the former 416 normalized-only events remain retained in the backup schema.
- All public user triggers were restored to normal enabled mode; no nonstandard trigger mode remained.
- `app_state` remained version `487` with the same updated timestamp and SHA-256.

## Additive Release A database and edge installation

Applied to staging, in reviewed order:

1. `supabase/phase4-customer-tab-rpcs.sql`, SHA-256 `b0857f508914499fdd71fbc367681de39259a5b283d3e35e3f55012d32165822`.
2. `supabase/phase11-operational-maintenance-rpcs.sql`, SHA-256 `161d9b2374d3b12b84a96e9e338d48cf7bd9bb8da1f4acaa0c39e5f8f02f42a3`.
3. Repository `admin-update-user` edge function.

Verification proved:

- `resolve_operational_inventory_item` reads `public.inventory_items`, contains no `app_state` reference, and is executable by neither `anon` nor `authenticated`.
- `open_customer_tab`, tab-item add/update/remove, `edit_pause_log`, `delete_pause_log`, and `record_session_audit` are denied to `anon` and granted to `authenticated`.
- `profiles.tab_permissions` exists as nullable `jsonb`.
- Analytics and inventory summary tables retain RLS; their read RPCs are denied to `anon` and granted to `authenticated`.
- `app_state` and `operational_events` remain in `supabase_realtime`.
- `commit_checkout_bill_v2`, `commit_financial_adjustment_v2`, and `financial_mutations` remain absent.
- A second 36-row parity run after installation again returned no non-zero delta.
- `app_state` remained version `487` and SHA-256 `cf5e87672491da73d41db3565218c79f9b98a1e938c2b1ad4c2c934a12d670d5`.

The previously deployed edge source was retained in evidence with SHA-256 `5b0610cffe75858ebc8ec931c918517ac3dae203d3a6bc32138ffc3bba471a31`. Shared `cors.ts` and `admin.ts` matched the repository. A post-deploy source verification caught that a dashboard-editor search had appended a stray token to the first staged update; the file was immediately replaced and redeployed before functional testing. The final deployed normalized source SHA-256 is `68141c5f0851c05e618e3c5db35b1d24ecd8c86a169574d38c8a311db60b110b`, exactly matching the repository-normalized source and ending at `});` with no trailing token.

## Frontend deployment state

The actual ignored `.env.staging` boolean flag capture was reviewed and hashed. Its SHA-256 is `cc6cf00348ed6f4e61971438d04b24254a36e3fbf8c301d4847a49fb6d537942`; all required normalized/operational read and write flags are `true`, while `VITE_BACKEND_FINANCIAL_RPC_V2=false`.

The first staging frontend build passed from clean application commit `0af9c7b0cb35e521fd35bff9ba7980d792cf100e` with the existing large-chunk warning, but its Cloudflare upload did not start because the stored Wrangler OAuth credential had expired and its refresh request returned HTTP 400. Wrangler exited before changing the deployment. The operator renewed the existing Wrangler OAuth authorization without exposing an API token.

The reviewed staging build was then repeated successfully from evidence checkpoint `0cc3f15` (application source unchanged from `0af9c7b`). Wrangler uploaded three modified assets and deployed only worker `gp-management-staging-pages`:

- URL: `https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev`.
- Cloudflare version ID: `8bd7fd6d-9084-428f-859d-26b04123135c`.
- Financial v2 build flag: `false`.
- Production worker `management` was not targeted or changed.

A fresh, uncached in-app browser tab loaded the deployed staging URL successfully with title `Game Parlour Management System` and the expected BreakPerfect sign-in screen. Authenticated, two-browser, mutation, fail-closed, and soak gates remain pending.

## Current gate decision

Database reconstruction, additive Release A installation, and staging frontend deployment are complete and clean. The unauthenticated load smoke passed. No authenticated functional/soak claim and no production promotion claim is made.

## Remaining gated work

1. Authenticate independent staging application browsers and execute Gate 5 functional/two-browser cases.
2. Repeat post-functional parity, actors, errors, hashes, and deployment captures.
3. Complete the full representative staging business-day soak and independent sign-off.

No production action is authorized by this evidence.
