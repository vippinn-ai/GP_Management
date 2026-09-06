# Design

## Source of truth

`public.activity_events` is a source-retaining evidence projection. Existing `audit_logs` and `operational_events` remain the compatibility sources. Application clients cannot mutate projection or source rows; an idempotent installer may repair only derived projection fields from the retained source key when upgrading an earlier trigger revision.

- An `audit_logs` trigger canonicalizes authenticated actor and server time, then appends one activity row per audit action.
- An `operational_events` trigger canonicalizes actor/time and appends every operational event. Its action and entity come from the server-authored business RPC rather than client audit text.
- One extractor recognizes all deployed correlation shapes: `audit_log_id`, `audit_log_ids`, and `changed_rows.audit_logs`.
- The reader keeps both source records as evidence. It suppresses an audit presentation only when the correlated operational projection is explicitly complete and covers that same semantic audit action. A generic multi-audit operational event never hides the distinct audit actions it references. New correlations additionally require the exact same authenticated actor and transaction timestamp, so a reused client audit ID cannot hide the operational truth.
- Unique `(organization_id, source_kind, source_id)` prevents duplicate source effects.

Authenticated clients receive SELECT only. INSERT/UPDATE/DELETE are revoked on all three evidence tables; SECURITY DEFINER mutation RPCs continue writing as their owner. Actor identity is derived from `auth.uid()` in triggers and cannot be changed by payload fields. Operational rows are labelled as authoritative server operations. Audit wording accepted by compatibility RPCs is explicitly labelled client-reported context; phase 10 financial audit wording is marked server-canonical only after the RPC validates the action/entity and constructs the message from committed rows.

## Activity record

Each record contains server `occurred_at`, actor ID and immutable name/username/organization-role snapshots, action, category, entity type/ID/label, safe summary, allowlisted details, mutation ID, source kind/ID, audit-reference IDs, and `legacy`.

Capture triggers are installed before backfill so a concurrent insert cannot fall between the snapshot and trigger installation. Every historic audit and operational source row is then backfilled and marked legacy. Valid source UUIDs are retained even when their profile was deleted; profile/member joins supply labels only. Existing actor/timestamp values are retained. Because old rows did not store immutable staff and entity labels, legacy lookup labels are explicitly identified in `details` and in the UI as current-record lookups rather than historical fact.

Financial v2 projections derive their semantic action and display evidence from the committed normalized bill and payment rows plus the server-authored mutation kind. Checkout, deferred issue, replacement, settlement, write-off, void, and refund therefore remain distinguishable without trusting client audit messages. A grouped adjustment is not marked complete, so its server-authored per-bill audit actions remain visible with each bill's amount and due balance. Item projections are complete only when the committed RPC supplies the server-persisted item, quantity, and price; older incomplete operational rows leave their correlated historical audit presentation visible.

## Reader contract

`list_activity_events(payload jsonb)` is SECURITY DEFINER and authenticated-only. It verifies active organization membership and returns `items`, `next_cursor`, `has_more`, and `server_time`.

Input supports `organization_id`, bounded `limit`, a complete cursor pair, free-text `search`, `actor_user_id`, `category`, `action`, `entity_type`, `entity_id`, date or ISO bounds, `time_from`, and `time_to`. Ordering is `(occurred_at desc, id desc)` and filtering uses Asia/Kolkata for time-of-day, including cross-midnight ranges.

## Frontend

The feature flag is `VITE_BACKEND_ACTIVITY_FEED`, default false. When enabled with a configured backend:

- Activity data loads only when the dashboard or Activity tab needs it.
- Dashboard requests 10 rows; the full page requests 50 and uses keyset Load More.
- Filter typing stays in local draft state; the server query runs only when the user applies the filters.
- Every realtime operational event carries its source event ID through the normalized snapshot and invalidates the compact/full feed, including fallback-only events that do not change `app_state` or `auditLogs`; rows are keyed and deduplicated by ID.
- Errors remain local to the activity panel and expose Retry.

Local-browser fallback continues to show existing local `auditLogs`, resolving actors from local users and labelling each row as a local record, not as historical server evidence. It mirrors IST cross-midnight filtering and fails closed on a missing pagination cursor instead of restarting at page one.

## Presentation

The visual direction is an industrial operations ledger: high information density, warm neutral panels, categorical signal colors, strong timestamps, and readable mobile cards. Rows show actor, action summary, entity, exact IST time, and a details disclosure. All content is rendered as text.

## Rollback

The frontend flag can be disabled without deleting rows. Emergency disable removes capture/immutability triggers, revokes the reader, and restores the prior authenticated operational-event insert grant needed by the legacy full-state publisher. All captured activity and business data remain intact.

## Installation order

For an upgrade, install `activity-events.sql` before the updated phase 4 item RPCs and phase 10 financial RPCs, then deploy the frontend. This ensures the complete trigger-time projection is active before any newly enriched operational event can commit. The postflight must report zero `incomplete_nonlegacy_financial_rows`; any nonzero result stops rollout and is reconciled before enabling the UI.
