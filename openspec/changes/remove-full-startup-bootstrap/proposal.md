## Why

Production egress is still too high after compact realtime because the app still downloads the full `public.app_state.data` JSON during login/session restore. Production `app_state` is already several MB, so routine hard refreshes, logins, and recovery paths can consume significant Supabase Postgres egress even when live realtime is compact.

The next change removes the full startup bootstrap from normal backend mode while preserving `app_state` as a rollback snapshot until the normalized path is proven stable.

## What Changes

- Add a new feature-flagged normalized startup bootstrap path.
- Build the initial browser `AppData` model from normalized tables instead of `public.app_state.data`.
- Load only the data needed for immediate operation:
  - profiles/users
  - business profile, categories, stations, pricing
  - inventory catalog and sale variants
  - combos
  - open sessions, open customer tabs, and their child rows
  - pending bills and recent bill/payment context needed for dashboard/receivables
  - expenses/templates needed for analytics/admin display
- Keep historical bills, payments, stock movements, and audit logs screen-scoped and paginated/search-driven.
- Keep `app_state` writes/reads available behind rollback flags during this change.
- Prevent partial normalized startup data from being auto-saved back into `app_state`.

## Non-Goals

- Do not remove the `app_state` table in this change.
- Do not stop compatibility writes until a later verified cutover.
- Do not redesign the UI.
- Do not migrate away from Supabase.
- Do not deploy directly to production without staging soak and telemetry evidence.

## Success Criteria

- Staging startup/login telemetry shows no full `app_state` download during normal login/session restore.
- Browser localStorage still does not store the full business dataset in backend mode.
- Live operations continue to use compact RPC/realtime paths.
- Dashboard, sale flow, sessions, customer tabs, bill register, reports, inventory report, pending dues, checkout, replacement, void/refund, and expenses still work.
- Production daily Postgres egress trends materially below the current 100 MB/day pattern after hard refresh.

## Rollback

- Disable the new normalized bootstrap flag to return startup to the existing `app_state` snapshot loader.
- Leave normalized tables and RPCs in place.
- Do not restore or edit `app_state` unless a separate data-integrity issue is proven.
