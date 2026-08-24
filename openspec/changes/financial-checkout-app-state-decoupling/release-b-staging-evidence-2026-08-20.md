# Release B staging execution evidence — 2026-08-20

## Scope and current decision

- Environment: `test/staging` Supabase project `tkbdyzxwwbhkpztgjjxh` and Cloudflare Worker `gp-management-staging-pages`.
- Production project `rrdwbxvuwrbxefarxnse` was not queried, migrated, deployed, or otherwise changed during this Release B execution.
- Financial v2 is enabled only in the staging build. The final tested frontend is Worker version `6594338c-c3d7-4fa0-8958-fbec91d14a61` in deployment `05438192-9504-4c06-9341-f81406f0b58c`, bundle `/assets/index-C9CwZnTb.js`, SHA-256 `a8dc0f4b51bbb16cb6fc6c3d0ae29cb95df1872d13440f7953e444ee5b2e98df`.
- The installed Phase 10 SQL SHA-256 is `68ca3612d4e4bb3e5bfa5eca3607431552b0248a436e43dc8d99eb1e7db3b426`.
- The installed hardened Phase 6 admin RPC SHA-256 is `1bf2b24d337a913009bb75f8d2dc9ca4636a42073492b12e0be696f200db4c47`.
- Current decision: **Release B production NO-GO**. The evidence below closes the basic transaction, security and role boundaries, idempotency, duplicate-money, lifecycle, exact- and over-capacity limited-stock safety, both admin-metadata race orderings, both checkout/reject orderings, single-hop double-billing prevention, repeated-session performance, realtime, and reload subgates. Concurrency against remaining operational/combo/financial-adjustment writers, representative complex/mixed performance, remaining payment/discount/LTP paths, final query-plan/error capture, and independent final sign-off remain open.

## Installed definition and security evidence

The final Phase 10 migration was applied atomically in the staging SQL editor and returned `Success. No rows returned`. Read-only definition verification proved both `commit_checkout_bill_v2` and `commit_financial_adjustment_v2` contain the core metric, compute the final `server_duration_ms` after `financial_mutations.status = 'committed'`, and retain authenticated execute grants.

The final staging database smoke completed at `2026-08-20T14:45:57.964Z`, with zero retries and production access disabled:

- anonymous checkout rejected with `42501`;
- wrong organization rejected with `organization_access_denied`;
- client actor spoof rejected with `actor_spoof_rejected`;
- malformed checkout rejected with `invalid_payload`;
- absent mutation lookup returned `null`;
- authenticated actor and organization resolution passed.

Both ignored browser credential slots currently resolve to the same staging admin identity, so the command-line smoke explicitly reports its two-identity role case as `not-run`; it does not claim a false independent user. The retained, rollback-safe [`release-b-role-authorization-proof.sql`](./release-b-role-authorization-proof.sql) executed in the signed-in staging editor; the hardened retained copy was re-executed at `2026-08-20 15:21:58.452954+00`. Inside one transaction it changed that profile and its triggered organization membership to `receptionist`, established the authenticated JWT actor, and called the real v2 RPCs. Write-off, void, refund, and bill replacement each returned `role_access_denied`; settlement passed the role boundary and reached domain validation. The transaction rolled back, reset the SQL session role, and returned `passed | admin | admin`, proving that both profile and membership roles were restored.

The retained, rollback-safe [`release-b-inactive-authorization-proof.sql`](./release-b-inactive-authorization-proof.sql) then executed at `2026-08-20 15:48:29.8673+00`. Inside one transaction it set the same staging profile inactive and verified the profile trigger also made the organization membership inactive. With that user's authenticated JWT context, both `commit_checkout_bill_v2` and `commit_financial_adjustment_v2` rejected before domain validation with `organization_access_denied`. The transaction rolled back, reset the SQL session role, and returned `passed | true | true | admin | admin`, proving both active flags and roles were restored. No financial row was created because both calls were rejected at the organization-access boundary.

The hardened Phase 6 admin RPC was then installed additively in staging and returned `Success. No rows returned`. It derives the actor from `auth.uid()`, rejects a mismatched top-level actor, restricts inventory/category/combo/stock mutations to the server-resolved admin role, locks affected normalized inventory rows in deterministic ID order, and rejects missing, malformed, or stale `expectedStockQty` before writing. The concurrency-only precondition is stripped before normalized `raw_data` and compatibility `app_state.data` persistence.

The rollback-only [`release-b-admin-inventory-precondition-proof.sql`](./release-b-admin-inventory-precondition-proof.sql) passed at `2026-08-20 16:09:27.325935+00`. Missing, JSON null, string, object, array, stale-number, and precondition-bearing missing-row cases all returned `inventory_conflict`; the transaction rolled back with the Vipin profile active/admin. The rollback-only [`release-b-admin-data-authorization-proof.sql`](./release-b-admin-data-authorization-proof.sql) passed at `2026-08-20 16:20:01.646769+00`: receptionist and manager inventory attempts returned `role_access_denied`, while the same manager successfully wrote an expense, customer, audit, operational event, and compatibility delta inside the transaction. The audit and event used the authenticated actor. Rollback restored profile and membership to active/admin; a separate query at `2026-08-20 16:20:25.782312+00` found no fixture expense, customer, audit, event, or `app_state` content.

## Functional and two-browser evidence

All listed Playwright runs used the exact staging host/project guard, two isolated Chrome contexts where applicable, zero retries, disabled traces, ignored local credentials, compact JSON RPC evidence, and failure-only screenshot/video capture.

| Run | Case | Result |
| --- | --- | --- |
| `20260820131857` | Timed session checkout with edited end time | Passed after exact client/server audit-transition alignment; one canonical bill/event and no session resurrection. |
| `20260820132447` | Customer-tab inventory checkout with standalone variant, cigarette pack, and consumables combo | Passed; exact Maggie `-2`, cigarette `-10`, and Thumsuyp `-1` deltas, observer closure, and hard-refresh parity. |
| `20260820135005` | Invalid arithmetic rollback plus two simultaneous copies of one mutation | Passed; invalid mutation left no status row, concurrent replay returned one canonical bill/event. |
| `20260820134814` | Deferred checkout followed by v2 settlement | Passed; pending-to-issued transition, one settlement payment, observer parity, and hard refresh. |
| `20260820141104` | Two different mutations against the same session | Passed; exactly one mutation committed, loser rolled back with no status row, winner replay returned the original canonical result. |
| `20260820142216` | Two different settlement mutations against one pending bill | Passed; exactly one settlement committed and the loser left no mutation record, preventing over-collection. |
| `20260820142733` | Two valid sessions concurrently claiming one bill number | Passed; exactly one `BILL` committed, loser received the explicit concurrent duplicate-financial-row error, loser mutation remained absent, and the still-open losing session was rejected through guarded cleanup. |
| `20260820143100` | Paid inventory bill refund | Passed; canonical Refunded status, one stock reversal, one audit, no fabricated payment row, observer realtime, and hard-refresh parity. |
| `20260820143246` | Unchanged bill replacement | Passed; original and replacement bills linked, original Replaced, replacement Issued, zero replacement stock movement, observer realtime, and hard-refresh parity. |
| `20260820150530` | Two simultaneous limited-stock customer-tab checkouts | Passed; a dedicated stock-2 item had two one-unit open reservations, both independent v2 submissions returned HTTP 200, both tabs closed, both browsers reloaded at stock zero with no open reservation, and the item was archived. |
| `20260820151921` | Two distinct checkout mutations against one hopped session | Passed; one request issued `BILL-20260820-134`, the competing request returned `session_not_billable`, the loser mutation remained absent, and replay of the winner returned the same bill and event. |
| `20260820153726` | Two stale limited-stock commands with demand above physical stock | Passed; both requests returned `inventory_conflict`, neither mutation/event/bill existed, physical stock remained `1`, and both source tabs remained open until guarded cleanup. |
| `20260820161556` | Checkout concurrent with an admin metadata edit carrying observed stock `2` | Passed with zero retries; admin committed first, checkout applied `-1` afterward, both browsers showed final stock `1`, and the item was archived. |
| `20260820162351` | Admin inventory create/edit/restock/deduct/archive/restore lifecycle | Passed with zero retries; all seven purpose writes were distinct, stock reconciled `3 + 2 - 1 = 4`, and final cleanup archived the item. |
| `20260824084853` | Checkout-first stale admin metadata command | Passed with zero retries; checkout committed once, the stale admin command returned `inventory_conflict`, final normalized stock was `1`, and no admin event or leaked precondition remained. |
| `20260824092648` | Rejection commits before a stale checkout | Passed with zero retries; rejection closed the session once, checkout returned `session_not_billable`, and no bill, payment, financial mutation, checkout event, or checkout audit existed. |

Earlier failed runs are retained as harness evidence and are not relabeled: `20260820135449` exposed the stale display-clock future-time boundary; `20260820142409` and `20260820142540` attempted timed-session controls on unit-sale Arcade sessions; `20260820142646` proved the bill collision but failed cleanup because two dialog handlers raced. Each harness defect was corrected, characterized, and followed by the passing run above without retrying an ambiguous financial mutation.

Limited-stock setup attempts `20260820145030` and `20260820145330` (before the final pass) are also retained. They stopped before any financial request: the first exposed a Category locator issue, and the second exposed premature `Synced` sampling plus tab-selection/realtime timing. Exact RPC waits and direct tab-chip activation corrected the harness. The aborted `20260820145330` tabs were closed through `reject_customer_tab`, and its dedicated item was archived through the normal admin UI. No abandoned QA tab or active item remains from those attempts.

Admin-race run `20260820161245` completed its financial and cleanup behavior correctly but failed a harness-only assertion because the admin browser did not emit an abort-induced `TypeError: Failed to fetch`. Read-only reconciliation before any new financial run proved admin metadata version `594` committed before the v2 checkout, the checkout created exactly one bill/payment/`-1` sale movement, final normalized stock was `1`, every persisted actor was Vipin, the fixture was archived at version `595`, and neither normalized `raw_data` nor `app_state` contained `expectedStockQty`. The harness now accepts zero or one exact abort error per browser and rejects any other page error.

Fresh zero-retry run `20260820161556` then passed. It captured the checkout and admin commands exactly once each; both returned HTTP 200, with mutation `financial-09b46114-2d6f-4caf-8af7-13453ea2beca`, bill `bill-ac6aca88-f1c1-4eff-87d6-d5544db353a5`, checkout event `event-a97a8424-df06-42f0-9668-597dad05a6ed`, and admin event `event-6ab18113-b69f-419c-acb3-47bf92412edd`. Database reconciliation at `2026-08-20 16:16:57.060827+00` proved final stock `1`, price `2`, one Rs 1 bill/payment, one `-1` sale movement, a committed mutation, matching Vipin bill/payment/movement/event/mutation actors, no persisted precondition, and archived fixture state. Compatibility versions `596`, `597`, and `598` correspond exactly to fixture creation, concurrent admin metadata commit, and archive; the normalized-only v2 checkout did not create an additional compatibility version. This proves the admin-first ordering.

Fresh zero-retry run `20260820162351` exercised the complete isolated admin inventory lifecycle through the deployed UI: new item at stock `3`, metadata price edit `1 -> 2` with stock unchanged, restock `+2`, direct adjustment `-1`, archive, restore, and final cleanup archive. It produced seven distinct events and consecutive `app_state` versions `599` through `605`, with no browser error. Read-only reconciliation at `2026-08-20 16:24:48.70098+00` proved normalized and compatibility snapshots both ended at price `2`, stock `4`, inactive/archived, and the same Vipin archive actor. The exact normalized movements were `restock +2` and `adjustment -1`; the seven audits were create, update, two stock movements, archive, restore, archive; all audit, movement, event, and compatibility actors were Vipin. Neither normalized `raw_data` nor the full compatibility document contained `expectedStockQty`.

On 2026-08-24 the same Playwright race became data-driven with reusable concurrent and deterministic checkout-first variants; the historical run above retains the observed admin-first evidence. Zero-retry run `20260824084358` first proved the checkout-first behavior through the deployed UI and RPC responses. Enhanced run `20260824084644` repeated the correct checkout/rejection/cleanup behavior but is retained as a harness-only failure because a new direct read of protected `financial_mutations` correctly returned HTTP 403 after the commit. The harness then switched to the authenticated `get_financial_mutation_result` RPC rather than weakening table security.

Fresh zero-retry run `20260824084853` is the canonical checkout-first evidence. The command was captured once and committed as mutation `financial-3bb5d5f9-cb6b-4333-92e2-b54c89f9a107`, bill `bill-dd9e43e6-ff1c-4cd5-a211-a263ceb0a23a`, and event `event-4a280920-e4b0-4b3f-bf1b-c3007383f37a`. The stale admin command carried observed stock `2`, returned HTTP 400 `inventory_conflict`, and produced no event. Embedded authenticated reconciliation proved exactly one bill, payment, `-1` sale movement, matching mutation-status result, and checkout event; all financial/event actor IDs resolved to Vipin. Normalized stock ended at `1`, price remained `1`, both normalized and compatibility JSON lacked `expectedStockQty`, both browsers agreed, and guarded cleanup archived the fixture. This closes the checkout-first stale-admin ordering without weakening `financial_mutations` RLS.

The reusable checkout/reject race was independently preflighted before any staging mutation. Run `20260824092142` is retained as a pre-race harness-only failure: one exact QA session started, the observer missed its realtime event, no checkout or race-rejection command was captured or sent, and one guarded `reject_session` cleanup closed session `session-8e787215-cbee-43c4-90ba-72437a906ff1`. Run `20260824092340` then completed and reconciled the checkout-first ordering before failing only its post-reconciliation UI expectation: mutation `financial-bcf33349-3470-40e0-ad4e-2f1ddcf1bfbe` issued Rs 30 bill `bill-c0079a07-8134-4cb9-84fb-79c79fa21256`; the stale rejection returned `session_not_open`; exactly one bill, payment, checkout event, and two checkout audits existed; all actors matched authenticated Vipin; the session was closed/billed; capture counts remained `1/1`; and `app_state` stayed at version `612`. Both browsers showed the station Available. The loser browser correctly retained one local conflict, so the reusable harness now asserts that explicit conflict, proves no pending sync, clears it locally without retrying, and then requires `Synced`. The independent reviewer accepted this canonical database evidence and prohibited an unnecessary checkout-first rerun.

Fresh zero-retry run `20260824092648` executed only the previously unrun reject-first case. Rejection mutation `op-c995f839-a87a-4fef-87eb-1e4b2b362a9f`, event `event-d4bdaf8e-01ae-4a3a-8622-90c4897b6e84`, and audit `audit-aa5b1a63-4297-4eb4-ad09-80bf31bb6383` closed session `session-34d8fa30-c4b2-4744-859c-16aa2194bcba` as rejected with the exact reason. The stale checkout mutation `financial-0d5e2fed-6ab6-49de-ae0b-77881ae7911f` returned `session_not_billable`; its status lookup was `null`. Reconciliation proved zero bill, payment, financial mutation, checkout event, or checkout audit, one rejection event/audit, authenticated Vipin attribution, exact final session state, command counts `1/1`, and the expected single compatibility change from version `612` to `613`. Both browsers reloaded with the station Available. This closes checkout concurrency against rejection in both deterministic orderings.

The passing exact-capacity artifact contains two distinct bill IDs, mutation IDs, event IDs, and stock-movement IDs. Read-only database reconciliation proved two bills totaling Rs 2, two payments totaling Rs 2, one bill actor and one payment actor, two committed mutations, two v2 checkout events, maximum recorded database duration `318.560 ms`, two movements totaling `-2`, two closed tabs, final normalized stock `0`, open reservations `0`, and archived item state. The two `TypeError: Failed to fetch` page errors are expected from deliberately aborting the UI submissions after capturing each command; the two captured commands were then sent exactly once through independent API contexts.

The over-capacity run created an isolated stock-2 item, reserved one unit in each of two open tabs, captured both valid commands, and then recorded one audited admin deduction so physical stock was `1` while combined reservations remained `2`. Both independent requests returned HTTP 400 with `inventory_conflict`; both mutation-status lookups were `null`. The two source tabs were still visible after hard reload and physical stock displayed zero available with one unit reserved. Database reconciliation after guarded cleanup proved physical `stock_qty = 1`, exactly one `-1` admin adjustment, zero checkout bills, zero financial mutations, zero checkout events, both tabs rejected with no bill, zero remaining open reservations, and the dedicated item archived. Harness-only runs `20260820152459`, `20260820152759`, `20260820153046`, `20260820153209`, `20260820153423`, and `20260820153552` exposed dialog, available-versus-physical stock, and post-reload navigation assumptions; they created no committed checkout, and their exact QA tabs/items were closed or archived before the next run.

The first hopped-race run `20260820151441` stopped before any financial request because its recovery flow detached the continuation and then targeted a stale modal. Its exact QA hopped session was billed once through the staging UI as unambiguous cleanup; it was not retried as a test result. The corrected zero-retry run `20260820151921` billed directly from the post-hop continuation and raced two distinct mutation IDs. Responses were HTTP `[400, 200]`: the loser returned `session_not_billable`, its mutation-status lookup was `null`, and replaying the winner returned the original `bill-03d08bdf-0ee1-4863-abc9-35e85507df79` and `event-2348b701-7b8c-4a86-831d-76a5bf8b8267`. Read-only database reconciliation proved exactly one bill and one payment for the source session, one committed mutation (the winner only), one operational event, actor equality, session status `closed`, close disposition `billed`, and the same closed bill ID. This closes the one-hop/two-bill race; multi-hop chains and concurrency against hop or other writers remain open.

## Corrected performance evidence

The first 50-case run `20260820140339` functionally passed but its SQL duration stopped before canonical hydration and the mutation completion update. That run is retained as functional load evidence only. Phase 10 now records `core_duration_ms` separately and computes `server_duration_ms` after all domain writes, event insertion, canonical hydration, and mutation commit; only persistence of the timing metric itself follows.

Corrected run `20260820141559` executed 50 sequential Arcade 1 unit-sale session/inventory checkouts in one zero-retry test:

- 50/50 checkout RPCs returned HTTP 200;
- 50 unique session, bill, bill-number, event, and mutation IDs;
- bills `BILL-20260820-075` through `BILL-20260820-124`;
- full-domain database p95 `478.066 ms`, maximum `530.476 ms`;
- browser p95 `4,261 ms`, maximum `5,051 ms`;
- database and browser thresholds passed (`<2 s` p95, `<5 s` DB max, `<7 s` browser max);
- cleanup recorded 50 completed, no active QA customer, no cleanup error, no dialogs, and no remote errors.

Read-only database reconciliation matched the artifact exactly: 50 issued bills totaling Rs 250, 50 payments totaling Rs 250, 50 operational events, 50 mutation IDs, 100 referenced audits, and 50 stock movements totaling `-50`. Bill, payment, and audit actor sets each contained one authenticated actor.

Immediately before and after this corrected run, the legacy snapshot remained exactly:

- `app_state.id = 'primary'`;
- version `543`;
- SHA-256 `d75a28837a0640266056f80e835e03d7ae6d4012b901b498afff046904574023`.

This performance claim is deliberately scoped to repeated Arcade session/inventory checkout. It does not represent a mixed session/customer-tab/carryover/combo/settlement workload.

## Local gates

After the final source and SQL changes:

- Vitest: 38 files / 418 tests passed;
- production build: passed (existing large-chunk warning remains);
- lint: zero errors and five documented warnings;
- `git diff --check`: passed, with expected line-ending notices only;
- focused financial/admin SQL and staging-harness contracts: 28/28 passed;
- complete staging Playwright discovery: 23 tests across 14 files, with zero configured retries; the financial-v2 subset is 18 tests across 11 files;
- final review manifest: 279 first-party files / 76,266 physical lines / 216 semantic hotspots / 200 billing-relevant files / 82 classified `app_state` references.

## Remaining mandatory Release B gates

1. Prove checkout is safe against concurrent hop, settlement, replacement, void/refund, and combo mutation, and prove multi-hop chain contention. Both checkout/reject and admin-metadata orderings plus standalone metadata/direct-stock/restock/archive/restore/new-item actions already pass.
2. Live timed/unit/tab coverage completes UPI, split, partial/deferred collection during checkout, discount/LTP/rounding/zero-total boundaries, pauses, direct/multi-hop carryover, and changed replacement quantities.
3. A mixed representative performance/contention run passes and final deployed query plans/logs prove no `app_state.data` read, expansion, lock, patch, or rewrite and no SQLSTATE `57014`/deadlock.
4. Independent tester completes the final evidence review and issues a production recommendation. Production deployment still requires separate explicit approval and a no-active-session window.
