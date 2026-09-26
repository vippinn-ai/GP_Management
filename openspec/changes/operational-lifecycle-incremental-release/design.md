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

Staging packaging has two distinct contracts. Immutable preflight captures the predecessor for exact restoration; the candidate's fixed seven-function metadata/security contract defines what installation is allowed to produce. Postflight observations cannot redefine that contract. Package creation and verification require the same clean Git commit and full source fingerprint; generated postflight SQL includes the run/source identities. Initial installation uses strict creation and runtime absence checks, whereas reinstall requires the reviewed existing schema/metadata and preserved candidate bodies. Neither mode silently substitutes for the other.

The original rollback artifact checks candidate body and full metadata/ACL before restoration, then verifies restored predecessor definitions and unchanged compatibility state. Later verified rollback adds raw installed-definition drift hashes. Both retain committed operational mutation records and domain data. Function ownership is postgres, the exact EXECUTE ACL is postgres/authenticated without grant options, and the dataset helper alone is stable. Remaining function attributes and mutation-table owner/RLS/ACL/policies are checked explicitly. No application runtime or billing calculation changes are part of these packaging safeguards.

Design intent: disable operational v2 for new lifecycle commands while retaining normalized readers and committed data; do not reconstruct stale app_state implicitly, delete mutation records or reverse completed user actions. Before release, verify v1 operation compatibility after v2 effects, exact installed definitions and a backup/restore/rollback package. This document is not rollback validation.
