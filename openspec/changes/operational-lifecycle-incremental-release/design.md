# Design and isolation

## Source boundary

Start at the live-matching c0e0d2133 base. Initial lifecycle UI/flag/result contracts derive from b2b581e; final RPC client and lifecycle/continuation SQL are extracted from d4eda24, retaining intervening validation, identity, actor and locking corrections. These are source provenance, not candidate approvals.

Keep the base complete normalized bootstrap readers and all existing financial/customer/report/receipt models. Main entry, panels, pricing, billing, financial RPC client and backend authentication implementation are unchanged. No atomic-bootstrap capability is introduced.

## Confirmation and recovery

Only the existing three mapped kinds use v2 when enabled. Commands retain stable mutation/audit identities and omit trusted actor and compatibility-version authority. RPC-confirmed changed rows are hydrated before acknowledgement; canonical rows are never replaced by stale client closures. Continued tabs wait for confirmation and re-use a failed manual attempt with matching intent.

## Realtime and restore

Subscribe before the authoritative read; await SUBSCRIBED. Buffer at most 1,000 unique events during snapshot/catch-up and reject overflow before publication. Apply events serially, dedupe up to 2,000 event IDs, filter organization and recheck subscription generation after asynchronous hydration. Unsubscribe invalidates old work and rejects pending readiness. Listener generation prevents remounted callbacks receiving old results.

Snapshot requests are single-flight per subscription generation. Reset clears the in-flight reference; an old completion cannot clear or publish a later attempt. Normalized full-refresh requests never silently read the compatibility document. Compatibility mode retains its previous full-refresh behavior.

Readiness is required before activating writable UI and dispatching the operational queue. An already-sent request is reconciled; subsequent unsent mutations return to pending when connectivity/readiness is lost and resume only after a successful restore.

## Rollback boundary

Design intent: disable operational v2 for new lifecycle commands while retaining normalized readers and committed data; do not reconstruct stale app_state implicitly, delete mutation records or reverse completed user actions. Before release, verify v1 operation compatibility after v2 effects, exact installed definitions and a backup/restore/rollback package. This document is not rollback validation.
