# Remaining Release B gap audit — 2026-08-28

## Decision

Release B remains production **NO-GO**. The financial-writer concurrency matrix, direct live session-item subgate, and all twelve customer-tab item/combo orderings are closed, but three release-gate families remain open: the complex payment/discount/carryover UI matrix, mixed representative performance plus deployed query-plan/error evidence, and independent final release sign-off.

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
| Direct live customer-tab item add | `tab-mut-race-20260828-1755` plus `tab-mut-rem11-20260829-1305` prove all three orderings | Closed |
| Direct live customer-tab item quantity update | `tab-mut-rem11-20260829-1305` proves checkout-first, mutation-first, and simultaneous | Closed |
| Direct live customer-tab item removal | `tab-mut-rem11-20260829-1305` plus `tab-mut-rem4-20260829-1338` prove all three orderings | Closed |
| Direct live customer-tab combo application | `tab-mut-rem4-20260829-1338` proves checkout-first, mutation-first, and simultaneous with exact application/item snapshots | Closed |
| Pending bad-debt write-off sharing the pending bill selected during checkout | `writeoff-race-20260829-1424`, `writeoff-rem2-20260829-1445`, and `writeoff-sim-20260829-1457` prove checkout-first, write-off-first, and simultaneous | Closed |
| Issued-bill void sharing a non-reusable inventory row with checkout | `void-race-20260829-2027` proves both commands commit once with exact `-1/-1/+1` stock arithmetic | Closed |

The SQL confirms these are distinct contracts. Each customer-tab mutation locks the source tab and then follows its own item/combo validation and write path; checkout independently locks the same tab before validating the canonical source items and combo snapshots. Release A behavior/realtime evidence is not concurrency evidence. `writeOffPendingBills` locks the expected pending bill, produces no payment or stock movement, and must conflict with checkout settlement if the bill changes first. `voidBill` locks the issued bill, derives reversal deltas from canonical bill lines, locks affected inventory rows, and uses the same positive `void_refund_reversal` stock contract as refund.

## Required next reusable harnesses

### Checkout versus live customer-tab item/combo mutation

The fail-closed parameterized harness, immutable recovery, identity-bound cleanup, partial-cleanup recovery, item-only continuation, and independent postflight are implemented. Runs through `tab-mut-rem11-20260829-1305` prove eight exact orderings. The remaining-eleven run timed out after seven complete cases and while only preparing the eighth; that prepared entry is not treated as a race result. Fresh run `tab-mut-rem4-20260829-1338` independently executed and reconciled exactly the remaining four orderings. All twelve customer-tab source-mutation orderings are therefore closed.

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

Execution status on 2026-08-29: `checkout_first` is closed from consumed zero-retry run `writeoff-race-20260829-1424`. Exact reconciliation revision `audit-normalization-1` is `partial` with `failures: []`, proves checkout as the sole winner, the expected two Rs 30 bills/two Rs 30 payments/two billed sessions, null losing write-off mutation, zero stock, empty floor, correct actors, and unchanged `app_state` version/hash `691` / `2de2c4ab0d04f2e65a4031cb987a72bc32bd5cc34af5cbadcddf45786857eb55`. The post-outcome Playwright failure was a local UI assertion mismatch: financial rejection uses the remote-error banner, not the operational conflict queue. It is corrected locally without rerun. No cleanup was required, the temporary admin is inactive, and credentials were removed. `writeoff_first` and `simultaneous` remain not run; the write-off subgate remains open and cannot be inferred from the closed ordering.

Subsequent execution status: fail-closed remaining-two run `writeoff-rem2-20260829-1445` closed `writeoff_first`. Write-off was the sole winner, voiding Rs 30 `BILL-20260829-002` under the distinct adjustment actor; checkout returned `settlement_conflict` with null mutation and zero financial/stock effect. The post-outcome UI stop was caused by the losing checkout modal intercepting the banner Dismiss click, and `simultaneous` did not start. Actor-bound reconciliation revision `actor-bound-1` returned `partial`, `failures: []`, then exact cleanup `writeoff-rem2-cleanup-20260829-1450` rejected only the one unbilled session. Mandatory postflight returned `partial`, `failures: []`, empty floor, preserved financial evidence, and only the acknowledged rejection advanced `app_state` to v692/hash `0c2fc997a8e6668d080b98c1c92dc3864f038ebbe391e7d2f8f07291e17e90e1`. The temporary admin is inactive and credentials removed. Thus both deterministic winner directions are closed; only `simultaneous` remains open.

Final execution status: fresh simultaneous-only preflight `writeoff-sim-20260829-1457` passed with exact selector `[simultaneous]`, distinct active actors, empty floor, zero collisions, and compatibility v692/hash `0c2fc997a8e6668d080b98c1c92dc3864f038ebbe391e7d2f8f07291e17e90e1`. One one-worker, retries-zero race ran once. Write-off was the sole winner, voiding Rs 30 `BILL-20260829-003` through mutation `financial-adjustment-fba12e3d-7885-4b44-978e-aa93034f8ac8`, event `event-3a3ba5c2-eafe-4676-93c5-3ccdc7e03ae5`, and audit `audit-c246eb81-7b00-46ce-95b9-001fb56349af`; checkout returned `settlement_conflict` with null mutation and zero bill/payment/stock effect. The browser stopped only during post-outcome dismissal because the managed-session dialog remained above the remote-error banner. No race was retried. Read-only reconciliation returned `partial`, `failures: []` and one exact cleanup candidate. Cleanup `writeoff-sim-cleanup-20260829-1957` rejected only session `session-5bf2215e-93ac-4974-ad63-5fffefbbd8c4`; mandatory postflight `checkout-writeoff-race-reconciliation-writeoff-sim-20260829-1457-writeoff-sim-cleanup-20260829-1957.json` (SHA-256 `f3ca9034c8bcddbb8d9ea0b178099a2014e6f27367fd7c87b2f6b94bf34ac79a`) returned `passed`, `failures: []`, no open sessions/tabs or cleanup candidates, and compatibility v693/hash `6af03b34ea29896c9bd5c9725f03db36954080bb4b32c8f10a4b843cf9efafc4`, advanced solely by the acknowledged rejection. The temporary admin is inactive and its credential file is removed. All three pending-write-off orderings are closed; issued-bill void is the remaining financial-writer race.

### Checkout versus issued-bill void

Extend the proven shared-inventory refund framework through an exact `void` mode; retain the default refund mode unchanged.

- Preflight, runner, checkpoints, recovery, cleanup, and postflight SHALL all carry one exact disposition value from the allowed set `refund | void`; arbitrary environment injection must fail closed.
- Use one dedicated stock-2 item and two customer tabs. Issue the first one-item bill, reserve the second unit on the second tab, then capture checkout and issued-bill void once in independent authenticated contexts.
- Both commands SHALL commit once. The original bill SHALL become `voided`; the second bill SHALL remain issued. Exact movements SHALL be first sale `-1`, second sale `-1`, and void reversal `+1`, leaving physical stock `1` with no extra movement.
- Both bills, payments, lines, tabs, mutation results, audits, events, reasons, and actors SHALL be exact. The financial race must not change `app_state`; archiving only the exact fixture may advance compatibility once. Final floor and reservations SHALL be empty.

Final execution status on 2026-08-29: fresh preflight `void-race-20260829-2027` passed with exact `void` disposition, staging project/bundle identity, distinct active admins, empty floor, zero collisions, and compatibility v693/hash `6af03b34ea29896c9bd5c9725f03db36954080bb4b32c8f10a4b843cf9efafc4`. One one-worker, retries-zero Playwright race ran once and passed. Original Rs 50 bill `BILL-QA-VOID-RACE-void-race-20260829-2027-ORIGINAL` is `voided` by actor B, while checkout bill `BILL-QA-VOID-RACE-void-race-20260829-2027-CHECKOUT` remains issued by actor A. Exactly two Rs 50 cash payments remain, both tabs are closed/billed, and movements are exactly original sale `-1`, checkout sale `-1`, and void reversal `+1`, leaving stock `1`. Immutable reconciliation and final evidence returned `passed` with exact mutations, bills, lines, payments, actors, audit, event, floor, and archive state; the financial race preserved compatibility v694/hash `fa0b94c6756e185c6e19c990127265a16fc7022e3f6fb7235a8428bc7b761d82`, and only exact fixture archival advanced it to v695/hash `59d1d3d0907e2d191fdc0b6c8bb5d22f33ca8ac2b685c932c4bacaa3e3d90742`. No recovery cleanup was needed. Independent review issued GO to close this subgate. Temporary admin `void-race-admin-20260829-2026` is inactive, its credential file is removed, no password was printed, and deactivation artifact SHA-256 is `8f0003654445fcf909edfcc822422f8a04611b854b57fdfd9675e2717a31feb5`.

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

1. Retain the completed and independently reviewed twelve-case customer-tab source-mutation evidence; do not rerun it.
2. Retain the completed write-off and issued-bill-void evidence; do not rerun either financial-writer subgate.
3. Run the consolidated complex UI matrix.
4. Run mixed performance/contention and capture deployed plans/errors.
5. Obtain the independent final report and production recommendation.
6. Seek explicit production approval only after every gate above is closed.
