# Independent test plan

The independent tester works from a clean worktree and reports each case as Passed, Failed, Blocked, or Not Run with mutation ID, bill ID/number, event ID, timings, and database evidence.

## Characterization

Cover timed/unit-sale sessions; original/edited times; pause variants; direct/multi-hop carryover; session/tab items; cigarettes; variants; reusable inventory; game and consumables combos; cash/UPI/split/deferred/partial collection; settlement during checkout; discounts/LTP/rounding/zero guards; replacement quantity deltas; receipts; payments; stock; audits; and downstream reports.

## SQL transaction and security

Assert exact normalized rows and complete rollback on failure. Prove the `app_state` data hash and row metadata are unchanged. Reject anonymous, inactive, wrong-organization, actor-spoof, malformed, stale, already-closed/billed, insufficient-stock, invalid-replacement, invalid-discount, and over-settlement requests.

## Idempotency and concurrency

Use two independent connections for same-mutation replay, lost response, double click, same session/tab, shared hopped session, shared pending bill, limited stock, duplicate bill number, and checkout concurrent with settlement, admin inventory save, reject, hop, replacement, void/refund, and live item/combo writes. Require no duplicates, negative stock, over-settlement, deadlock, stale success, or global-row wait.

## UI/reload/realtime

Use two staging browsers. Verify confirmation-bound modal behavior, canonical receipt/PDF, compact realtime, hard refresh, Bill Register, pending receivables, dashboard, analytics, reports, customer history, inventory report, actor attribution, event-before-response ordering, and recovery after a missed realtime event.

Explicitly prove that deleting a pause log replaces that session's complete pause-log overlay in the second browser, normalized read failures never show cached financial totals, generic full-state auto-persist is not called, and admin profile plus tab-permission edits commit without `app_state`.

## Performance

With staging history and app-state size at least production scale, run 50 representative sequential checkouts plus complex and concurrent cases. Require zero SQLSTATE `57014`, deadlocks, duplicate effects, and client timeouts; database p95 below 2 seconds, maximum below 5 seconds, browser completion below 7 seconds; and query plans with no `app_state` access.
