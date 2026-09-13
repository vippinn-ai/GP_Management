# Design

## Incremental delivery

### A. Normalized lifecycle commands

Add `operational_mutations`, `hop_session_v2`, `reject_session_v2`, and `reject_customer_tab_v2`. Add `VITE_BACKEND_OPERATIONAL_RPC_V2`, default `false`, with fail-closed dependencies on normalized bootstrap/live reads, compact realtime, and operational RPC writes.

### B. Continuation and canonical convergence

Harden `start_session`, `open_customer_tab`, and `link_customer_tab_continuation` actor attribution. The new-tab continuation path must lock/validate source hops exactly like the existing-session/game paths. All continuation-bearing commands become non-optimistic, manual-retry, acknowledgement-required; UI state advances only after canonical confirmation.

The target v2 response lists changed normalized IDs. Before resolving a critical acknowledgement, the origin loads those rows and merges them through the normalized overlay. It must not reapply a client snapshot after hydration. Observer events are serialized or guarded against stale completion so response-first, realtime-first, and reversed fetch completion converge.

### C. Startup bundle

Move `jspdf` and `xlsx` behind analyzable user-triggered dynamic imports. Preserve synchronous popup creation before awaited work to avoid browser popup blocking. Keep receipt preview construction light and eager. This is a separate commit and release toggle from SQL behavior.

### D. Bootstrap/sync gap

Wait for a confirmed `SUBSCRIBED` realtime status, then buffer compact events before critical snapshot restore and replay/deduplicate them before enabling writes. This subscription-ready barrier removes the snapshot/subscription gap without relying on a best-effort timer. Split critical operational bootstrap from screen-gated history/report/customer/audit data and parallelize independent reads after organization resolution. The app remains read-only until critical data and buffered catch-up are complete. This unit is required before claiming stale-sync elimination, but is independently reversible from A-C.

## Trust boundary

Normalized operational tables are authoritative. V2 payloads contain intent and stable IDs: organization, mutation ID/kind, entity type/ID, client-created time, effective close time, audit ID, and rejection reason where applicable. The server rejects actor and `base_app_state_version` fields, derives `auth.uid()`, verifies active membership/role, and patches only whitelisted canonical fields. Items, combos, customer, station, pricing, start time, LTP, and source continuation data remain server-owned.

## Idempotency and locks

`operational_mutations` is keyed by `(organization_id, mutation_id)` and stores kind, entity, actor, request fingerprint, status, canonical result, and timestamps.

1. Validate envelope and authorization.
2. Serialize first insertion by organization/mutation advisory lock; insert or lock mutation row.
3. Return stored committed result only when identity/fingerprint match; otherwise `mutation_identity_mismatch`.
4. Lock target session/tab.
5. Lock the target session's open pause rows in time/ID order.
6. Validate current state and audit ID.
7. Write closure, pause, audit, compact event, and canonical result atomically.

Independent entities share no global lock. A failure rolls back every write.

## Lifecycle rules

- Hop requires an open, unbilled session, canonical start, valid effective end, and agreement between session status and open-pause rows. It closes exactly one canonical open pause only when the session is paused, sets `closed/hopped`, forces bill/reason null, and preserves other canonical fields and continuation IDs.
- Reject requires an open, unbilled session/tab, trimmed reason, valid close time, and a valid pause invariant. It closes an open session pause, sets `closed/rejected`, clears bill and continuation IDs, and preserves items/combos for audit.
- A continuation source must be closed/hopped/unbilled/unconsumed and match the target customer identity. Same-ID replay is accepted only when the stored request fingerprint matches the complete intent; entity and audit ID collisions fail atomically.
- The server constructs audit message/time/actor. No bill, payment, stock, or inventory row changes.
- `raw_data` is patched minimally from locked canonical raw JSON; a client entity snapshot is never stored.

## Realtime and recovery

Events contain changed normalized IDs, mutation identity, duration, and released continuations; no full entity or `app_state` version is required. Stale unrelated compatibility drift does not block v2. A closed target returns a stable conflict with no partial writes. A lost response is recovered only by same-ID replay. Hydration failure remains explicit and recoverable; it never causes a new-ID automatic retry.

## Rollback

Disable the operational-v2 flag to return new target commands to retained v1 functions while normalized reads remain enabled. Keep v2 functions/table installed so evidence remains. A full compatibility-read rollback requires separately verified normalized-to-`app_state` reconstruction. Bundle and bootstrap units have independent frontend rollback commits/flags.

## Deferred stock-movement pagination

Inventory history remains outside the critical bootstrap graph. Its normalized reader requests at most five exact-count ranges of 1,000 rows, reapplies the organization/date filters and deterministic `movement_at desc nulls last, id desc` database order to every range, and enforces one 15-second wall-clock deadline across the complete read. It rejects missing or drifting counts, null data, duplicate IDs, non-monotonic movement timestamps, short/oversized/empty early pages, API failures, timeouts, and incomplete totals. The caller continues to reject a saturated 5,000-row result so partial history is never presented as complete. The client does not reinterpret PostgreSQL's secondary text order with JavaScript string comparison because their collations are not generally equivalent; executable query tests require both database order clauses on every page, while runtime overlap detection protects the page boundary.

This bounded offset pagination is accepted only for the deferred, read-only, append-only stock-movement audit stream. Concurrent changes can shift offsets, so count drift, overlap, timestamp-order violations, and page-shape mismatches fail to the existing retryable read-only error instead of silently returning mixed history. It is not an authorization to use offset pagination for mutable financial or lifecycle state.
