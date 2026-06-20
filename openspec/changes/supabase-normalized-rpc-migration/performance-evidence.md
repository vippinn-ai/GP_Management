# Phase 3 Read Performance Evidence

## Purpose

Task `5.7` needs evidence that normalized reads can keep recent screens fast while preserving older bill/report search without downloading the full `app_state` JSON document.

The current production baseline from `baseline.md` shows `app_state` at `2,501,760` bytes before transport overhead. These probes are designed to prove that Phase 3 reads use bounded normalized row queries instead of loading that full blob.

## Files

- `supabase/phase3-read-performance-indexes.sql`
  - Adds idempotent report-read indexes for closed session and closed customer-tab activity.
  - Does not update business data or `app_state`.
- `supabase/phase3-performance-evidence-probes.sql`
  - Read-only SQL probes for recent Bill Register, report reads, and older history search.
  - Uses the app's 7 AM Asia/Kolkata business-day boundary for bill/payment activity and mirrors the current Analytics local-date window for one-time expenses.

## Staging Run Order

Run these in staging:

1. `supabase/phase3-read-performance-indexes.sql`
2. `supabase/phase3-performance-evidence-probes.sql`

Do not rerun `phase1-backfill-from-app-state.sql` after normalized tables become a production source of truth. At the current side-by-side stage it is still a staging validation script only.

## Evidence To Capture

Record the first summary grid and each `EXPLAIN ANALYZE` execution time.

| Probe | Target Evidence | Pass Guidance |
| --- | --- | --- |
| Summary grid | `recent_bill_page_count` is `<= 51`; `recent_bill_page_json_bytes` is much smaller than `app_state_bytes` | Confirms default bill history does not download full app history |
| Probe 1 recent bill page | Uses `bills_org_issued_idx` or equivalent index; returns `<= 51` rows | Should stay well below a few seconds |
| Probe 2 bill page details | Reads details only for current page bill IDs | Should use bill/payment lookup indexes or primary-key prefixes |
| Probe 3 reports | Uses date-range indexes for bills, payments, sessions, customer tabs, and expenses | Confirms reports are bounded by selected range |
| Probe 4 older search | Returns paginated results without `app_state` | Acceptable if slower than recent reads but still within a few seconds |

## Current Notes

- Older search currently uses `ILIKE` across bill number, customer name, and phone. This is acceptable for the first normalized-read phase because it stays paginated and avoids the full app-state download.
- If Probe 4 becomes slow as bill volume grows, the next schema step should add a dedicated bill-search vector or trigram-backed search path instead of relying on broad `ILIKE`.
- Codex cannot run these probes against Supabase from the local sandbox. Staging/prod evidence must be captured from Supabase SQL Editor or an approved SQL connection.

## Result Log

| Environment | Date | Recent Page Time | Report Probe Time | Older Search Time | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| Staging | Pending | Pending | Pending | Pending | Run the scripts above and paste the summary/EXPLAIN output back into the thread |
