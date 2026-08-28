# Remaining Release B gap audit — 2026-08-28

## Decision

Release B remains production **NO-GO**. The direct live session-item subgate is closed and one customer-tab add/checkout-first ordering is reconciled, but five release-gate families remain open: the remaining 11 customer-tab item/combo writer orderings, two financial-writer races, the complex payment/discount/carryover UI matrix, mixed representative performance plus deployed query-plan/error evidence, and independent final release sign-off.

This audit is read-only. It does not authorize production access or represent staging evidence for a case that has not run.

## Financial writer-concurrency map

| Required concurrent writer | Current evidence | Status |
| --- | --- | --- |
| Admin inventory metadata save | Admin-first `20260820161556`; checkout-first `20260824084853` | Closed |
| Reject session | Reject-first `20260824092648`; both checkout/reject orderings are recorded in the Release B evidence | Closed |
| Hop session | Authoritative-admin three-ordering run plus the six ordinary-role direction/order cases ending in `role_matrix_final_20260825_2249` | Closed |
| Standalone settlement of a pending bill also selected by checkout | `20260827115031`, exact before/after cleanup reconciliation | Closed |
| Bill replacement sharing limited inventory | `replace-race-20260828074932` | Closed |
| Bill refund sharing limited inventory | `refund-race-20260828082130` | Closed |
| Live repeat-combo mutation | Combined runs ending in `20260828-combo-race-ui-fix-014747` | Closed |
| Direct live session-item mutation | Checkout-first runs `session-item-race-202608280924` and `session-item-race-202608280936`; remaining-two pass `session-item-race-rem2-202608280950` | Closed |
| Direct live customer-tab item add | `tab-mut-race-20260828-1755` proves checkout-first only; mutation-first and simultaneous remain unexecuted | **Open (2/3 orderings remain)** |
| Direct live customer-tab item quantity update | Release A proves ordinary `update_customer_tab_item_quantity` behavior only; no simultaneous checkout result exists | **Open** |
| Direct live customer-tab item removal | Release A proves ordinary `remove_customer_tab_item` behavior only; no simultaneous checkout result exists | **Open** |
| Direct live customer-tab combo application | Release A proves ordinary `apply_customer_tab_combo` behavior only; the session-only repeat-combo race does not exercise this RPC | **Open** |
| Pending bad-debt write-off sharing the pending bill selected during checkout | No financial-v2 concurrency result exists | **Open** |
| Issued-bill void sharing a non-reusable inventory row with checkout | Refund proves the shared row-lock/reversal family, but no `voidBill` concurrent command result exists | **Open** |

The SQL confirms these are distinct contracts. Each customer-tab mutation locks the source tab and then follows its own item/combo validation and write path; checkout independently locks the same tab before validating the canonical source items and combo snapshots. Release A behavior/realtime evidence is not concurrency evidence. `writeOffPendingBills` locks the expected pending bill, produces no payment or stock movement, and must conflict with checkout settlement if the bill changes first. `voidBill` locks the issued bill, derives reversal deltas from canonical bill lines, locks affected inventory rows, and uses the same positive `void_refund_reversal` stock contract as refund.

## Required next reusable harnesses

### Checkout versus live customer-tab item/combo mutation

The fail-closed parameterized harness, immutable recovery, identity-bound cleanup, and independent postflight are implemented. Run `tab-mut-race-20260828-1755` proves only `add_item / checkout_first`; it stopped on a corrected expected-conflict UI assertion before the other 11 orderings. Do not relabel that partial run as the full matrix.

- The allowed mutation modes SHALL be exactly `add_item | update_item | remove_item | apply_combo`. Preflight, runner, browser checkpoints, reconciliation, recovery cleanup, and postflight SHALL bind the same exact ordered mode selection.
- Every mode SHALL run three separately identified, zero-retry orderings: checkout-first, mutation-first, and simultaneous. Capture the checkout and the mode-specific UI-generated RPC once in independent authenticated contexts and submit each command exactly once.
- Use run-bound catalog fixtures and a fresh customer tab per ordering. Add/update/remove SHALL exercise `add_customer_tab_item`, `update_customer_tab_item_quantity`, and `remove_customer_tab_item` respectively. Combo SHALL exercise `apply_customer_tab_combo`, including its application row and included item snapshots.
- A checkout winner SHALL create exactly one canonical bill/payment/mutation/event, close the tab, and make the stale operational command fail `customer_tab_not_open` with zero mode-specific row/audit/event effect.
- A mutation winner SHALL create exactly the mode-specific row and event effects: add/remove/apply-combo include their exact client audit row, while quantity update creates no audit row. None of the four operational RPCs may create a stock movement or alter physical stock. Their inventory effect SHALL instead be proved as the exact logical open-tab reservation delta derived from canonical `customer_tab_items` (add/apply increase it, update changes it by the quantity delta, and remove decreases it). The stale checkout SHALL fail `source_item_mismatch`, retain a null financial mutation, create no bill/payment/financial event, and leave the tab open until identity-bound rejection cleanup.
- A simultaneous ordering may produce only one of those two complete outcomes. Reconcile exact command cardinality, actors, tab status, item/combo rows, reservation/stock arithmetic, bills, payments, mutations, events, audits, and unchanged financial `app_state` compatibility. Only acknowledged fixture administration or recovery rejection may advance compatibility.
- Discovery and read-only preflight SHALL pass before any staging write. Any ambiguity stops without retry and requires the exact reconciler. The final postflight SHALL prove every run tab closed, the catalog fixtures inactive, reservations zero, and the floor empty.

### Checkout versus pending write-off

Extend the proven checkout-versus-settlement framework through an exact `writeoff` mode; do not create an unguarded duplicate runner.

- A read-only preflight SHALL bind a fresh run ID, exact staging host/project and bundle hash, active authoritative actors, empty floor, run-specific names/numbers, and exact `app_state` version/hash into an immutable `wx` artifact.
- The runner SHALL accept only full settlement discovery/execution or exact write-off discovery/execution modes and SHALL overwrite, not trust, any externally supplied mode variable.
- The browser case SHALL create one real deferred pending bill, start a second session for the same customer, select that pending bill for settlement during checkout, prepare the Bill Register's `Write Off` command in the independent context, capture each UI-generated command once, and submit each once with zero retries.
- Run three separately identified zero-retry orderings: checkout-first, write-off-first, and simultaneous. This SHALL prove both deterministic winner directions plus one true concurrent result; no ordering may be inferred from another.
- Exactly one command may commit in each ordering. A checkout winner SHALL create one current bill, one settlement payment, and leave the pending bill issued/paid while write-off returns `financial_adjustment_conflict` with a null loser mutation. A write-off winner SHALL leave the pending bill voided with reason/actor/audit/event, zero settlement payment, no checkout bill, a null checkout mutation, and checkout shall return `settlement_conflict`.
- The financial race SHALL leave `app_state` unchanged. If write-off wins, a separately identified recovery cleanup may reject only the exact unbilled second session. Every outcome SHALL end with immutable database reconciliation and an empty-floor postflight.

### Checkout versus issued-bill void

Extend the proven shared-inventory refund framework through an exact `void` mode; retain the default refund mode unchanged.

- Preflight, runner, checkpoints, recovery, cleanup, and postflight SHALL all carry one exact disposition value from the allowed set `refund | void`; arbitrary environment injection must fail closed.
- Use one dedicated stock-2 item and two customer tabs. Issue the first one-item bill, reserve the second unit on the second tab, then capture checkout and issued-bill void once in independent authenticated contexts.
- Both commands SHALL commit once. The original bill SHALL become `voided`; the second bill SHALL remain issued. Exact movements SHALL be first sale `-1`, second sale `-1`, and void reversal `+1`, leaving physical stock `1` with no extra movement.
- Both bills, payments, lines, tabs, mutation results, audits, events, reasons, and actors SHALL be exact. The financial race must not change `app_state`; archiving only the exact fixture may advance compatibility once. Final floor and reservations SHALL be empty.

Both modes require independent static GO before staging execution, unique run identities, one worker, retries `0`, no trace capture, mandatory reconciliation after any ambiguity, and no production path.

## Remaining UI matrix

The existing staging evidence closes basic timed, unit-sale, and customer-tab checkout; edited timing; pause and hop behavior; direct and multi-hop carryover/double-bill prevention; standalone/variant/cigarette/combo inventory; cash and deferred checkout; settlement, replacement, refund, receipts, reports, realtime, and refresh. It does not yet close the consolidated acceptance matrix for:

- UPI and split checkout;
- partial collection/deferred combinations and previous-dues collection during checkout;
- line and bill discounts, LTP, rounding, true zero-price rejection, and discount-driven zero totals;
- the remaining replacement quantity delta directions;
- one final hard-refresh/downstream parity pass over the representative complex cases.

These should run as one reusable serial Playwright matrix with unique case identities and per-case compact evidence, not as conversational browser tests.

## Remaining performance and deployed evidence

The corrected 50-case sequential Arcade workload is complete. Still required:

- representative complex carryover/combo/inventory/settlement cases;
- contention against the final writer modes above;
- browser completion timing for the representative complex matrix;
- deployed query plans proving no `app_state.data` read, expansion, patch, lock, or rewrite;
- deployed error/log evidence showing zero SQLSTATE `57014`, deadlocks, duplicate effects, and client timeouts.

Use database/API scripts for load, reconciliation, plans, and logs. Use Playwright only where UI behavior or two-browser realtime/hard-refresh parity is part of acceptance.

## Execution order

1. Retain the independently reviewed expected-conflict correction, completed recovery/postflight paths, and fail-closed `remaining-eleven` selector for the customer-tab source-mutation harness.
2. Use a new run identity with the reviewed `remaining-eleven` preflight and runner; do not rerun the reconciled `add_item / checkout_first` case. The selector is locally verified but has not executed live.
3. Implement, review, execute, and reconcile the exact write-off and void modes one at a time.
4. Run the consolidated complex UI matrix.
5. Run mixed performance/contention and capture deployed plans/errors.
6. Obtain the independent final report and production recommendation.
7. Seek explicit production approval only after every gate above is closed.
