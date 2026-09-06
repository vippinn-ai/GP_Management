# Design

## Source of truth

`public.activity_events` is an append-only presentation ledger. Existing `audit_logs` and `operational_events` remain compatibility/evidence sources.

- An `audit_logs` trigger canonicalizes authenticated actor and server time, then appends one activity row per audit action.
- An `operational_events` trigger canonicalizes actor and appends a fallback activity row only when the operational event has no audit reference.
- Financial/admin RPCs that produce several audit actions therefore retain their detailed rows without an additional duplicate summary event.
- Unique `(organization_id, source_kind, source_id)` and `(organization_id, mutation_id, action)` constraints prevent duplicate effects.

Authenticated clients receive SELECT only. INSERT/UPDATE/DELETE are revoked on all three evidence tables; SECURITY DEFINER mutation RPCs continue writing as their owner. Actor identity is derived from `auth.uid()` in triggers and cannot be changed by payload fields.

## Activity record

Each record contains server `occurred_at`, actor ID and immutable name/username/role snapshots, action, category, entity type/ID/label, safe summary, allowlisted details, mutation ID, source kind/ID, and `legacy`.

Historic audit rows are backfilled first. Historic operational events without an audit reference are backfilled as fallback records. Existing actor/timestamp values are retained and marked legacy.

## Reader contract

`list_activity_events(payload jsonb)` is SECURITY DEFINER and authenticated-only. It verifies active organization membership and returns `items`, `next_cursor`, `has_more`, and `server_time`.

Input supports `organization_id`, bounded `limit`, cursor, free-text `search`, `actor_user_id`, `category`, `action`, `entity_type`, `entity_id`, `from_iso`, `to_iso_exclusive`, `time_from`, and `time_to`. Ordering is `(occurred_at desc, id desc)` and filtering uses Asia/Kolkata for time-of-day.

## Frontend

The feature flag is `VITE_BACKEND_ACTIVITY_FEED`, default false. When enabled with a configured backend:

- Activity data loads only when the dashboard or Activity tab needs it.
- Dashboard requests 10 rows; the full page requests 50 and uses keyset Load More.
- Typing uses a deferred search value rather than blocking keystrokes.
- Realtime operational events invalidate the compact/full feed with request deduplication; rows are keyed and deduplicated by ID.
- Errors remain local to the activity panel and expose Retry.

Local-browser fallback continues to show existing local `auditLogs`, resolving actors from local users and labelling the source Local activity.

## Presentation

The visual direction is an industrial operations ledger: high information density, warm neutral panels, categorical signal colors, strong timestamps, and readable mobile cards. Rows show actor, action summary, entity, exact IST time, and a details disclosure. All content is rendered as text.

## Rollback

The frontend flag can be disabled without deleting rows. Previous RPC/function definitions can be restored while retaining the additive table and captured activity. Rollback never truncates activity or restores business data unless separately approved.
