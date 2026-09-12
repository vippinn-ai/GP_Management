# Operational performance decoupling

## Problem

Production hop and rejection commands still lock, read, patch, and rewrite the shared multi-megabyte `public.app_state.data` document. Production evidence shows these operations taking roughly four to seven seconds while normalized financial v2 commands complete materially faster. The shared compatibility row also couples unrelated sessions, so independent operators serialize behind global JSON work and can surface ambiguous pending-sync failures.

Startup has two distinct costs. Export-only libraries are eagerly included in the entry bundle, and the authenticated bootstrap performs many reads before realtime is subscribed. Bundle size can delay startup, but the subscribe-after-bootstrap gap is the stronger stale-sync risk; the implementation and evidence must not conflate them.

## Outcome

- Hop session, reject session, and reject customer tab have additive normalized-only v2 RPCs.
- V2 commands never read, lock, patch, or update `app_state`.
- Each command is atomic, authenticated, actor-safe, idempotent, and scoped to affected normalized rows.
- Hop continuation into a new/existing game or tab remains single-consumer and becomes confirmation-based.
- Origin and observer browsers converge through compact changed-row hydration without a full snapshot.
- Legacy v1 RPCs remain installed as a flag-controlled rollback path.
- Export-only libraries leave the startup chunk in a separate reversible commit.
- Subscription-first/catch-up and critical-bootstrap reduction are specified and delivered separately before claiming the sync issue fully solved.
- Existing timing, pause, carryover, continuation, inventory, audit, receipt, dashboard, report, and local-browser behavior remains compatible.

## Measured baseline

- Production `app_state.data` is approximately 4.85 MB and its relation is approximately 10.46 MB.
- Historical observations show `hop_session` averaging approximately 4.31 seconds and `reject_customer_tab` approximately 4.84 seconds.
- Recent normalized financial checkout v2 observations average below one second.
- The production entry JavaScript is approximately 1.53 MB minified / 443 KB gzip and includes `jspdf` and `xlsx` eagerly.
- Normalized restore has a multi-stage request waterfall and realtime starts only after restore completes.

These values are diagnostic evidence, not acceptance evidence. Staging must capture a frozen same-scale baseline and immutable candidate comparison.

## Release gates

1. OpenSpec, traceability, characterization tests, TypeScript, lint, unit tests, and build pass locally.
2. Independent code review approves the exact candidate commit and SQL/install approach.
3. Additive SQL is installed in staging with v2 disabled; definitions, grants, indexes, and the no-`app_state` contract are verified.
4. Reusable zero-retry Playwright and direct-database suites pass functional, security, idempotency, concurrency, realtime, recovery, continuation, and parity tests.
5. Same-scale staging measurements meet the latency and bundle budgets in `test-plan.md`.
6. Cleanup and postflight prove no QA residue and no unexplained drift.
7. The independent tester and reviewer issue commit- and evidence-bound GO decisions.

Production is excluded until both approvals exist and the user gives fresh production-write approval.

## Non-goals

- No billing, pricing, stock, receipt, or continuation-rule redesign.
- No automatic retry or polling loop.
- No removal of legacy v1 RPCs.
- No production deployment or mutation during staging implementation.
- No broad component rewrite or visual redesign.
