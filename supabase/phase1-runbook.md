# Phase 1 Normalized Shadow Schema Runbook

These scripts are side-by-side only. They do not switch the app away from `app_state`.

Run in staging first.

## Order

1. Run `supabase/phase1-normalized-schema.sql`
2. Run `supabase/phase1-organization-member-sync.sql`
3. Run `supabase/phase1-backfill-from-app-state.sql`
4. Run `supabase/phase1-parity-checks-single-result.sql`

## Stop Conditions

Do not proceed to any read cutover if:

- any schema script fails
- the backfill script fails
- any row in the first parity result has `delta <> 0`
- any row in financial totals has `delta <> 0`
- open session, open customer tab, or pending bill parity has `delta <> 0`

## Expected Result

After the backfill, normalized tables should contain a full shadow copy of the current `app_state` data under `organization_id = 'org-primary'`.

The parity script returns one result set with three `check_group` values:

1. `collection_count`
2. `totals`
3. `live_summary`

All deltas should be zero before Phase 2 data gateway work starts.

## Important Notes

- `phase1-backfill-from-app-state.sql` deletes and repopulates only the `org-primary` shadow organization.
- It does not delete or update `public.app_state`.
- `phase1-organization-member-sync.sql` is safe to rerun after creating, updating, or disabling staff users. It backfills `organization_members` from `profiles` and installs the trigger that keeps future profile changes synchronized.
- Do not run the backfill script after normalized tables become the production source of truth.
- Keep `app_state` as the production source until a later cutover is explicitly approved.
