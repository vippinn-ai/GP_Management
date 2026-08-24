# Design

## Source-of-truth transition

Release A completes normalized startup and screen-scoped reads while v1 continues keeping `app_state` current. Release B adds v2 financial writes. Once v2 is enabled, normalized tables remain authoritative even if v2 is rolled back to v1 for latency recovery.

Normalized startup includes config/catalog/combos, open live rows, recoverable unbilled hops, pending receivables, current-business-day bill activity, payments received during the current business day against older bills, expenses, bounded stock movements, and recent audits. Historical screens use scoped normalized readers.

For session timing, typed `sessions.started_at` and `sessions.ended_at` are authoritative over compatibility `raw_data`. A legacy row with a null typed start may fall back to `raw_data.startedAt`; a typed null end remains null and must not resurrect a stale raw end. The hop RPC locks and copies the typed start into compatibility JSON before persisting the hop, and rejects a missing normalized start rather than creating an invalid carried session.

Bill Register pages merge their complete normalized bill and payment rows into the in-memory action state by ID, preserving unrelated bootstrap rows. Separate receipt support includes payments linked through `related_checkout_bill_id` and the bill-number rows referenced by previous-due or replacement relationships without inserting support bills into the displayed search page. Successful financial adjustments invalidate and refetch the current register generation; late load-more responses from a prior query or refresh are discarded. This lets receipt, settlement, replacement, void, and refund flows operate on the server-authoritative historical record without reintroducing a stale financial fallback. Customer history paginates to exhaustion, deduplicates cross-page settlement payments, and resolves visit activity from the linked session start or closed-tab open time, falling back to bill issue time only for counter-only bills. A missing explicitly linked session and every incomplete pagination/read error fail closed.

Generic AppData auto-persistence is disabled in normalized-bootstrap mode. Local optimistic changes are persisted only by their purpose-built operational, financial, or admin command. Staff tab permissions live with the protected profile row and are updated by the existing admin-only profile function, so user edits do not require a second full-state write.

The frontend fails closed at startup if financial v2 is requested without normalized bootstrap, customer/history/report/inventory readers, compact realtime, and both operational and financial RPC gateways. This makes the release ordering an executable configuration invariant rather than an operator convention.

## V2 mutation lifecycle

1. The browser creates one mutation ID per issuance attempt and retains it through ambiguous network recovery.
2. The RPC derives the actor from `auth.uid()` and verifies active organization membership.
3. A `financial_mutations` row serializes identical mutation IDs and stores the canonical result.
4. Rows are locked in this order: source sessions, source customer tabs, affected bills, affected inventory.
5. Current database state is validated after locks are held.
6. The RPC writes normalized rows and a compact operational event atomically.
7. The canonical result is stored and returned. Repeated calls return that result without repeating effects.

The RPC never touches `app_state`. A status RPC provides one bounded reconciliation read after an ambiguous transport failure.

## Trust boundary

Client calculations remain the compatibility basis, but the server verifies arithmetic and state invariants. Actor fields are overwritten with the authenticated actor. Session/tab item and combo snapshots—including identifiers, labels, quantity, price, pack/variant conversion, and combo linkage—are verified against locked server state; checkout may update only customer, timing, closure, LTP, continuation-billing, replacement, settlement, and calculated stock fields.

## Locking and conflicts

IDs are sorted before row locking to avoid deadlocks. All primary and carried sessions are locked. Pending/replacement bills and every affected inventory row are locked. A conflicting close, settlement, replacement, or stock claim fails atomically with a stable business error.

The retained admin-data writer locks changed/deleted normalized inventory rows in sorted order after its compatibility-row lock. Every existing inventory item in a new admin command carries the normalized `stockQty` observed when the edit began. After acquiring the row lock, the RPC rejects a missing, malformed, or changed stock precondition—and an attempted recreation that carries an existing-row precondition—with `inventory_conflict`; it never lets the client's stale item snapshot overwrite a concurrent v2 checkout deduction. The precondition is removed before normalized or compatibility persistence. New items keep their submitted opening stock, and uncontended metadata, direct-stock, restock/deduction, archive, and restore behavior remains unchanged. The RPC derives its actor from `auth.uid()`, rejects a mismatched client actor, stamps inventory movement/audit attribution server-side, and requires the server-resolved admin role for inventory/category/combo changes.

## Realtime and origin reconciliation

The RPC event lists changed bill, payment, stock, audit, customer, session, tab, pause-log, and inventory IDs. Other browsers load those rows by ID. A refreshed session replaces its complete pause-log set so deletes cannot survive in another browser. A canonical closed session may replace another closed representation of the same session (for example `closed/hopped` to `closed/billed`), while a closed session can never be resurrected to a non-closed status. If another command bills or consumes the source of an open post-hop continuation, normalized reconciliation closes that stale continuation UI before the operator can act on it. Each deferred reconciliation is bound to the exact hopped-session ID that scheduled it, so an earlier consumed hop cannot clear a newer hop's continuation state. The origin uses the confirmed canonical result and bounded normalized hydration; it never performs a full financial recovery from `app_state`.

## Rollback

Before v2: disable normalized bootstrap only while v1 has kept compatibility data current. After the first v2 commit: keep normalized bootstrap enabled; disable only the v2 flag. A full legacy rollback requires a verified normalized-to-app-state reconstruction.
