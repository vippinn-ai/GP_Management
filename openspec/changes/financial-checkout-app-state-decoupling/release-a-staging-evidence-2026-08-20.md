# Release A staging preflight evidence — 2026-08-20

## Scope

- Project: `test/staging` (`tkbdyzxwwbhkpztgjjxh`), Southeast Asia (Singapore).
- Reviewed commit: `79434b34dc83066554c2845a81e334cd906b37a9`.
- Financial v2 remained disabled; phase 10 was not applied.
- No production project, production database, or production deployment was accessed.
- Staging was resumed from its paused state. All database statements executed in this preflight were read-only.

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
- `get_analytics_summary` and `get_inventory_report_summary` are absent even though the intended staging build enables those read flags.
- Existing public operational/financial/admin RPCs are granted to `authenticated`; the internal inventory resolver is not granted to `authenticated` or `anon`.

## Parity result

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

## Gate decision

Release A installation and frontend deployment stopped before any schema or application mutation. Installing only the missing RPCs would make the UI read incomplete/stale financial and operational data.

The repository phase-1 backfill is intentionally destructive: it deletes the normalized `org-primary` organization and cascade-dependent rows, then reconstructs them from authoritative `app_state`. It must not be run without an explicit deletion confirmation and a retained staging backup/evidence export.

## Proposed recovery requiring explicit approval

1. Export/backup the complete current normalized `org-primary` data and relevant function/grant definitions.
2. Reconstruct normalized staging from the current authoritative `app_state` using the reviewed phase-1 backfill.
3. Rerun all 36 parity rows and require zero unexplained delta.
4. Apply only the required additive Release A prerequisites: read indexes/APIs, normalized inventory helper, phase-11 maintenance RPCs/profile column, and the admin-user edge update.
5. Re-run definitions, grants, hashes, parity, and staging browser checks before any frontend deployment.

No production action is authorized by this evidence.
