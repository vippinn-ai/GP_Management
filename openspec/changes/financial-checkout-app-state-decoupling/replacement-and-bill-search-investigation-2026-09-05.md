# Replacement and Bill Search Investigation — 5 September 2026

## Scope and safety boundary

- Production activity in this investigation was read-only. No production bill, payment, session, inventory, function, configuration, or deployment was changed.
- The staging replacement reproduction used one unique run ID, zero Playwright retries, a fail-closed preflight, immutable request/response evidence, and mandatory database reconciliation.
- This document is an investigation and fix/test plan. It is not production approval.

## Finding 1 — Bill Register search defect reproduced in staging

Run `diag-bill-search-20260905b` reproduced the defect on a 390 x 844 viewport. After typing the first character:

- the value `B` remained in React state;
- the original search input DOM node was disconnected;
- keyboard focus changed from the search input to no focused input;
- the reusable desired-behavior test failed with `Typing must not replace the focused search input DOM node.`

Evidence:

- `test-artifacts/playwright/summary-diag-bill-search-20260905b.json`
- `test-artifacts/playwright/bill-search-stability-diag-bill-search-20260905b/bill-register-search-stabi-b6706--normalized-results-refresh/attachments/bill-register-search-stability-2d13914577d9926a896f8d9e13e26a0ce3cd54df.json`

### Root cause

`BillRegisterPanel` immediately includes `search` in `normalizedServerQuery`. Every character calls the parent query-change callback. The parent immediately assigns the new query key and sets loading. `normalizedBillRegisterDisplayEnabled` then becomes false until the new backend page returns. Because the panel treats `ready=false` as an initial-load failure, it replaces the complete register—including the focused input—with a loading banner. The results request is valid, but the UI shell is unnecessarily unmounted during each request.

## Finding 2 — Fractional timed-session replacement failure reproduced

Run `diag-replace-upi-20260905d` covered the reported payment transition and also changed item quantity:

- original bill payment: cash;
- replacement bill payment: UPI;
- original quantity: 2;
- replacement quantity: 1;
- the replacement RPC was submitted exactly once with mutation `financial-c88dfe47-91c6-43f9-b4cd-86b47fff7cdf`;
- server duration was 145.185 ms;
- original bill became `Replaced` and replacement became `Issued`;
- the receipt showed UPI;
- normalized hard-refresh consumers, bill/payment links, stock movement, actor attribution, audit/event evidence, and app-state invariance reconciled;
- integrity failures, completion failures, and ambiguities were all empty.

Evidence:

- `test-artifacts/evidence/checkout-replacement-parity-terminal-diag-replace-upi-20260905d.json`
- `test-artifacts/evidence/checkout-replacement-parity-reconciliation-diag-replace-upi-20260905d.json` (SHA-256 `c66063434ac9e790e49832e9a7dac0d79e7f969e71fc2a3e273e20bf1261926e`)

The first diagnostic run stopped before the replacement request because its new selector was too strict. It was not retried. Its partial state was reconciled, then the exact SHA-bound cleanup run `diag-replace-upi-clean-20260905c` archived only the isolated item authorized by that reconciliation. Cleanup postflight passed with no failures. A fresh run ID was used for the actual reproduction.

The later production-specific run `diag-fractional-replace-20260905a` reproduced the reported failure with one submission and zero retries:

- Snooker Star Table timed session edited to 43 minutes;
- original bill paid by UPI;
- replacement changed to Cash;
- the original bill committed successfully;
- the replacement RPC returned `replacement_source_mismatch`;
- no replacement bill committed and the modal remained visible;
- the server message was visible only in the global sidebar alert behind the modal.

Evidence:

- `test-artifacts/playwright/summary-diag-fractional-replace-20260905a.json`
- `test-artifacts/playwright/v2-run-diag-fractional-replace-20260905a/release-b-replacement-v2.e-ddbc9-ills-without-changing-stock/error-context.md`

### Production read-only findings

- Local staging and production builds reproduce the exact currently deployed bundle artifacts: staging `index-GzHnG-g2.js`; production `index-B23LCT31.js`. The production symptom is not explained by an outdated frontend deployment.
- In the read-only seven-day window beginning 29 August 2026 23:31 IST, production contains two complete replacement pairs and no incomplete/orphan replacement link. One pair proves a cash-to-UPI replacement succeeded: `BILL-20260829-022` to `BILL-20260829-023`, reason `BY MISTAKE ISSUED CASH`.
- No replacement committed after 30 August appears in that window. This is consistent with recent attempts failing before transaction commit, but does not prove the rejection cause.
- The exact 4 PM record is `BILL-20260905-004`, issued at 4:00:54 PM IST for `Vansh jalam`, total Rs 285, UPI, by Shanu (active admin). The original session ran from 3:16 PM to 4:00:12 PM IST on Snooker Star Table.
- The bill remains `issued`. It has no replacement link, replacement timestamp, replacement actor, replacement payment, replacement audit, replacement event, or stock movement. The failed attempt therefore made no partial financial change.
- Its normalized line stores `unit_price`, `subtotal`, and `total` as `285.14`; its legacy `raw_data` retains `285.14166666666665`. `mapNormalizedBillLine` preferred the legacy raw precision, and `cloneBillLinesForReplacement` sent it back to the v2 RPC. The RPC correctly compared that value with the locked normalized bill-line value and rejected it as `replacement_source_mismatch`.
- Bills `BILL-20260905-003`, `-004`, and `-005` were issued in order at 3:33 PM, 4:00 PM, and 4:05 PM IST, with no duplicate or orphan replacement row. Bill-number contention is not needed to explain this incident.
- The application admin identity cannot read `financial_mutations`, by design. Because a rejected transaction rolls back its mutation row and all domain writes, no failed mutation record is available through the application identity.

### Current conclusion

The production failure is a deterministic normalized-versus-legacy precision mismatch for timed-session lines whose calculated charge has more than two decimal places. It is not caused by the payment-mode change. The strict server validation and atomic rollback behaved correctly; the client supplied the wrong precision and hid the returned explanation behind the modal.

The first staged client correction then exposed a second, independent validator conflict: the generic bill-line check required every `linkedSessionId` to occur in `source_session_ids`, while replacement mode correctly requires that source array to be empty. The replacement-specific validator already requires an inherited session line to match the locked original bill line exactly, and already forbids a linked session on any newly added line. The correction therefore exempts replacement mode only from the generic source-array check; it does not weaken the locked-original-line validation.

There is also a confirmed usability defect in the failure path: `finalizeCheckout` rethrows the RPC error while the modal remains open, but the error is rendered in the global page banner behind the modal. Staff can therefore see the spinner stop and the same popup return without seeing the rejection reason.

## Fix plan

### A. Stabilize Bill Register query refresh

1. Split initial availability from query-refresh state. Only the first load with no usable backend result may replace the page with the fail-closed banner.
2. Keep the register shell, filters, and search input mounted during subsequent searches.
3. Use a deferred/debounced server search value so local typing remains immediate and the backend is not called for each rapid character.
4. Retain the existing generation guard so only the latest response is accepted.
5. While a query is pending, show an inline `Searching...` state and disable result-row financial actions until the response query key matches. Do not silently enable actions against stale results.
6. On refresh failure, keep the input mounted, show a retryable inline error, and keep stale row actions disabled.

### B. Make replacement failures visible without weakening transaction safety

1. Add checkout-local error state rendered inside `Replace Issued Bill`, next to the Issue button.
2. Catch the blocking action rejection at the button boundary so there is no unhandled promise, while preserving the modal, form values, and stable mutation ID.
3. Show the server's safe structured code/message; do not generate a new mutation ID or automatically retry an ambiguous request.
4. Clear the local error only after a relevant field changes or a fresh, user-initiated attempt begins.
5. Map replacement-source bill lines from normalized columns first, using legacy raw JSON only as a fallback when a normalized value is absent. Keep all server replacement snapshot, stock, role, linkage, payment, and idempotency checks unchanged.

## Test and independent-review gate

The candidate fix must not be deployed to production until an independent agent works from a separate clean worktree, reads this plan, and reports every case as passed, failed, blocked, or not run.

Required automated cases:

- Bill search at mobile and desktop widths: first character, continuous typing, backspace, paste, clear, quick filters, date/status/mode/station changes, slow response, out-of-order response, failed response/retry, and hard refresh.
- Assert the same search DOM node remains connected, focus stays in the input, scroll does not jump, typed text is not lost, only the latest result is shown, and stale row actions remain disabled.
- Replacement payment matrix: cash to UPI, UPI to cash, cash/UPI to split, and unchanged mode.
- Replacement shapes: unchanged lines, quantity increase/decrease/removal/addition, current-day and older original bills, archived/changed catalog references, insufficient stock, double-click, lost response/idempotency recovery, realtime before response, and deterministic rejection.
- For every successful replacement, reconcile both bills, lines, payments, modes, actors, links, audit/event rows, stock deltas, receipt rendering, normalized hard refreshes, and unchanged `app_state.data` hash.
- For every rejected replacement, prove zero new bill/payment/stock/audit/event rows and verify the modal shows the actionable error without losing entered values.
- Run unit tests, targeted contract tests, lint, staging and production-mode builds, and zero-retry staging Playwright suites.

Release remains gated by: exact production failure classification, passing independent review, clean staging reconciliation, no open operational sessions/tabs at deployment, backup/rollback readiness, and explicit contemporaneous production approval.

## Candidate implementation and staging proof — 6 September 2026

- `mapNormalizedBillLine` now prefers normalized columns for all immutable and financial line fields, using legacy raw JSON only as a fallback.
- `commit_checkout_bill_v2` retains strict replacement snapshot validation but no longer applies the incompatible generic source-session-array check in replacement mode.
- The replacement modal now renders the safe server error beside the action buttons and preserves the form and mutation ID; no automatic retry was added.
- Bill Register keeps its shell and focused search input mounted after initialization, debounces server search by 250 ms, ignores bill-history queries while viewing receivables, and disables financial row actions until the current query is authoritative.
- Full unit/contract suite: 55 files, 546 tests passed.
- Build passed. Lint has zero errors and only the four pre-existing warnings.
- Deployed staging frontend: Worker version `bc9ddedb-6517-4e0b-90a0-c7d474645ce7`, bundle `/assets/index-CBwKPnez.js`, SHA-256 `f4e974afc4a6353a436d01abc6824d49460c70dbc5f75f7ef98922c7fd4cd9dc`.
- Deployed staging SQL was read back and proved both the narrow replacement exemption and continued absence of any `app_state` reference.
- Search proof `verify-bill-search-20260906a`: passed with the same input node connected, focus retained, value retained, and scroll unchanged.
- Exact replacement proof `verify-fractional-replace-20260906b`: passed once with zero retries. A 43-minute Snooker bill issued by UPI was replaced by Cash; both RPCs returned 200.
- Database reconciliation passed with no failures: two bills, two payments, correct bidirectional replacement links, preserved session line/rate, unchanged original session lifecycle, one replacement audit, two compact events, canonical mutation recovery for both mutation IDs, and unchanged `app_state` version 722/hash `c3d3bed9285ef454e3644b02f62e1610bbf635004a0d1aef5adcbbe96492067e`.

Evidence:

- `test-artifacts/playwright/summary-verify-bill-search-20260906a.json`
- `test-artifacts/playwright/summary-verify-fractional-replace-20260906b.json`
- `test-artifacts/evidence/session-replacement-reconciliation-verify-fractional-replace-20260906b-verified.json`

Production remains unchanged and is not approved by this staging proof.
