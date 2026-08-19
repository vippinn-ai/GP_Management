# Financial checkout app-state decoupling

## Problem

Production checkout currently writes normalized financial rows and then locks, expands, patches, and rewrites the multi-megabyte `public.app_state.data` document. The authenticated database role has an eight-second statement timeout, so otherwise-valid checkouts can fail with SQLSTATE `57014` while the browser remains blocked on "Issuing bill".

The compatibility document is also still used by some startup, recovery, stock-validation, and reporting paths. Removing its checkout update before those paths use normalized data would make a hard refresh stale and could resurrect billed entities or omit financial activity.

## Outcome

- Normalized tables are the runtime source of truth before financial v2 is enabled.
- Financial v2 commits never read, lock, patch, or update `app_state`.
- Checkout and adjustment mutations are atomic, idempotent, actor-safe, and protected by deterministic domain-row locks.
- Existing billing calculations, local-browser mode, receipts, reports, carryovers, timing edits, settlement, replacement, stock, and audit behavior remain compatible.

## Release gates

1. Characterization, build, test, and review evidence is clean locally.
2. Normalized bootstrap/reload/realtime/report parity passes in staging with v1 checkout.
3. Financial v2 transaction, security, idempotency, concurrency, and performance tests pass in staging.
4. Production SQL is additive and installed with v2 disabled.
5. Production enablement requires no active sessions, a controlled first bill, and explicit approval.

## Non-goals

- No pricing redesign.
- No UI redesign.
- No automatic polling or blind retry loop.
- No production deployment as part of local implementation.
- No return to stale `app_state` reads after the first v2 checkout.
