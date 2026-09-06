# Independent test plan

The testing agent uses a separate clean worktree at the approved commit. Browser tests use reusable Playwright scripts, unique run IDs, zero retries, no production host, failure-only screenshots/video, and immutable request/response/SQL evidence. Every case is passed, failed, blocked, or not run.

## Database and security

- Anonymous, inactive, wrong-organization, and missing-membership reads fail.
- Admin, manager, and receptionist can read identical organization activity.
- Authenticated roles cannot insert, update, or delete activity/audit/operational rows directly.
- Client actor and timestamp spoofing are overwritten by `auth.uid()` and server time.
- A hostile phase 4/6 audit action/entity/message cannot masquerade as server truth: the actual server operation remains visible and injected wording is labelled client-reported.
- Replayed mutation/source IDs produce no duplicate activity.
- Backfill counts reconcile to eligible audit rows plus event fallbacks.
- Generic multi-audit events preserve every distinct correlated audit action; only complete same-action projections suppress duplicates.
- Legacy financial/item events do not derive mutable current values or suppress their historical audit context.
- New checkout, deferred issue, replacement, settlement, write-off, void, and refund records expose distinct server-authored action, bill references, and reconciled amounts.
- The rollout postflight reports zero incomplete nonlegacy financial projections.
- Activity rows contain no password, token, secret, auth email, or unrestricted payload.
- Query plans use the organization/time cursor index; first page p95 is below one second and filtered p95 below two seconds on production-scale staging data.

## Action and UI coverage

- Exercise one unique representative action from every coverage-matrix domain and assert exact actor, action, category, entity, server time, summary, source, and `legacy=false`.
- Verify rollback/failure creates no committed activity.
- All three roles see Activity in default navigation and no mutation control.
- Dashboard shows at most 10 newest records with actor and time; Show All opens Activity without scroll/focus loss.
- Filters compose correctly and Load More has no gaps/duplicates under equal timestamps.
- Details disclosure is keyboard/screen-reader operable and renders hostile text safely.
- Two browsers converge after an action; refresh reconstructs the same order.
- Mobile cards remain usable at 360px and desktop ledger at 1280px.
- Offline/read failures are scoped and do not affect sessions or checkout.

Run the complete existing unit suite and established staging checkout, replacement, settlement, session/tab item, inventory and role smoke paths. No production mutation test is permitted.
