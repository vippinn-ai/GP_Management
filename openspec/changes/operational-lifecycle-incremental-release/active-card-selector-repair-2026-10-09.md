# Active-card selector repair

## Observed failure

Run `normops-20261009-1300-acceptance-b16507d` stopped with one passed case, one failed case and 29 not run, zero retries. Its second case completed 20 hop and 20 session-rejection samples before the first customer-tab rejection. The rejection returned HTTP 200. The preserved dashboard context contains four matching names in Recent Activity, but no live customer-tab card. Independent read-only posttest found all live operational floors/residuals zero and unchanged app_state. Historical QA bills/payments and audit events are retained. Staging frontend was restored to the recorded baseline; production was untouched.

## Bounded change

Select targets only inside the unique visible Live Sessions tile/grid. Distinguish active customer-tab cards from active/paused station-session cards. Match the tab heading or session customer metric exactly; retain strict one-card checks for presence and zero-card checks for absence. Missing, hidden or duplicate grids must not satisfy absence. Activity, receipts and other historical names must not satisfy presence or defeat closure.

Both concurrency sampling/overlap helpers and the duplicate-event recovery absence assertion use the shared test helper. No runtime UI, RPC, SQL, business rule, timeout, performance budget, live-suite title or retry configuration changes.

## Local independent contract

Use reusable local-only Playwright with synthetic DOM matching DashboardPanel structure and the actual helper. No authentication, staging requests or database mutations. Cover active/paused sessions, tabs, retained historical names, exact versus prefix names, wrong target type, multiple targets, duplicate cards, missing/hidden/duplicate grids, and stale live cards. Verify the full staging runner still discovers the same 31 cases and static guards remain intact.

Reviewer and tester must sign off on the exact committed successor. Local checks are not live acceptance. Prior failed evidence remains immutable; any later staging execution uses a fresh unique identity, candidate-bound proof/lineage, guarded provisioning, zero retries and reconciliation under the existing release plan. Do not relabel b16507d results as successor results.

## Local execution evidence

The independent tester's final offline Playwright run passed all eight tests with one worker and zero retries. It explicitly checks duplicate grids, hidden-grid absence, history-only presence rejection, and active/paused cards alongside four historical copies each. Scoped ESLint, TypeScript and diff checks passed. Local config writes generated output under ignored test-artifacts; these fixtures use setContent and block external requests.

The parent separately passed the 14 selected-spec static guard and 14 lifecycle Playwright contract tests. Offline live-suite discovery still returns 31 cases with zero executed. Staging build output remains `index-CRmZEn-8.js`, SHA256 `feb7294dcbd7765e82c7722d82d3a42609eab3e75517bf159c965ac595026c39`, identical to the predecessor runtime bundle. Initial restricted Vitest failed before test execution on a temporary-file EPERM; the established workspace-local TEMP run passed. Initial offline discovery correctly refused missing private staging configuration and passed after the existing ignored staging configuration was supplied. No staging test or deployment was executed for this successor at this checkpoint.
