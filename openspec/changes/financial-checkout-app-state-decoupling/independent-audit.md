# Independent implementation audit

Date: 2026-08-20  
Scope: read-only static review and local automated gates against the shared implementation tree.

> Historical status note: this document records the independent pre-staging audit snapshot. Current staging execution and its remaining gates are tracked in `release-a-staging-evidence-2026-08-20.md`; the blocked/not-run statuses below must not be read as the current staging state.

## Verdict

No release-blocking static/local code defect remains in the reviewed tree, including the audit-driven Release A customer-history, historical-action, receipt-support, post-adjustment refresh, and async-race fixes. Staging and production enablement remain prohibited until the installed-database, security, concurrency, two-browser, performance, and soak gates below are complete.

| Gate | Status | Evidence |
| --- | --- | --- |
| Local automated suite | Passed | 30 files / 372 tests |
| Production build | Passed | 349 modules; existing 1.226 MB chunk warning |
| Lint | Passed with warnings | Zero errors; five existing warnings |
| Diff integrity | Passed | `git diff --check`; line-ending notices only |
| Static v2 trust boundary | Passed | Actor, lock, idempotency, arithmetic, settlement, customer, stock, audit, timestamp, and lifecycle checks reviewed |
| Static `app_state` independence | Passed | V2 RPC bodies do not access the global application-state row |
| SQL installation and transaction behavior | Blocked | No isolated PostgreSQL/Supabase runtime available |
| RLS and negative security calls | Blocked | Requires installed schema and authenticated test identities |
| Rollback and unchanged `app_state` hash | Blocked | Requires transactional database fixtures |
| Concurrency and lost-response cases | Blocked | Requires independent database connections |
| UI, reload, receipt, and realtime parity | Blocked | Requires migration-enabled staging and two browsers |
| Performance acceptance | Not run | Requires production-sized staging data and query plans |
| Business-day soak and deployment | Not run | No staging or production environment was changed |
| Independent clean worktree | Blocked | Audit ran read-only against the shared live tree |
| Per-file review manifest | Passed locally | Reproducible CSV records every first-party text/config file, hash, line count, risk method, source collections, RPCs, test evidence, and classified `app_state` references |
| Release A staging runbook | Passed locally | Additive SQL/edge order, actual build-flag capture, evidence, stop conditions, two-browser matrix, soak, and rollback are documented; execution remains blocked |

## Remaining release evidence

- Execute the Release A staging runbook first without phase 10 or financial v2; capture actual build flags, function definitions, grants, indexes, publications, profile schema, normalized parity, and pre/post `app_state` hash evidence.
- In the later Release B gate, execute the financial-v2 migration against an isolated Supabase/PostgreSQL database and capture its function definitions, grants, RLS behavior, and syntax evidence before staging enablement.
- Run every transaction, spoofing, rollback, idempotency, and race case from `test-plan.md` with mutation, bill, payment, operational-event, inventory, and `app_state` hash evidence.
- Run two-browser hard-refresh, realtime, receipt, downstream-report, customer-history, receivable, and inventory parity cases.
- Run the 50-checkout production-sized performance suite and contention matrix.
- Complete staging drift capture, the full-business-day v1 soak, and the rollback drill.

No database row, environment configuration, staging deployment, or production state was changed by this audit.

## 2026-08-25 receptionist-manager timing checkpoint

Verdict: **GO for the local/static harness checkpoint only. Live staging execution remains approval-gated and not run.**

The independent test agent first returned NO-GO twice. The implementation was corrected before this GO: ordinary-staff timing inputs are now asserted absent and natural frozen timestamps are used; all normalized/app-state reads finish before interception; cleanup requires positive rejection acknowledgement; the dedicated runner rejects arbitrary paths/options; the checkout envelope imports the canonical frontend `FinancialCheckoutV2RpcPayloadEnvelope` and uses `session_updates`; and hopped cleanup requires exactly one `session_charge` linked to the exact source.

| Gate | Status | Evidence |
| --- | --- | --- |
| Focused role/SQL contracts | Passed | 37 / 37 |
| Full local automated suite | Passed | 39 files / 450 tests |
| Role-harness TypeScript | Passed | No-emit check with Node and Vite client types |
| Playwright discovery | Passed | Seven tests in exactly one role-matrix file; retries zero; production disabled |
| Production build | Passed | 350 modules; existing large-chunk warning only |
| Lint | Passed with warnings | Zero errors; five existing warnings |
| Credential safety | Passed statically | Ignored role credential file; no password/token evidence; traces disabled |
| Independent role-harness review | Passed locally | Role preflight, natural timing, immediate single sends, exact loser codes, actor/financial/audit reconciliation, exact cleanup line, and fail-closed ambiguity handling |
| Live staging role matrix | Not run | Requires separate approval, distinct active receptionist/manager credentials, a fresh run ID, and a no-active-session staging window |

No staging access, database mutation, deployment, role change, or production action was performed for this checkpoint.

## 2026-08-25 receptionist-manager live staging attempt

Verdict: **GO on safe reconciliation and harness-defect classification; NO-GO on closing the role matrix.**

The reviewed account lifecycle created distinct active staging-only receptionist and manager profiles after two authoritatively empty pre-write failures. Fresh preflight proved zero open sessions/tabs and unchanged compatibility state. The zero-retry matrix passed its role preflight and submitted only `rec-checkout-first`; checkout committed once, the stale hop returned `session_not_open`, and the test then stopped because it incorrectly required a payment row for a rounded zero-total bill. Five cases did not run.

Independent read-only reconciliation proved the exact bill total/paid/due were all zero, canonical payments were empty, the session closed billed once, the retained bill actor and captured session-audit actors matched the receptionist, the losing hop left no event/audit, and `app_state` version/hash did not change. The retained event identity does not include its actor field, and the inspector did not select the separate bill-entity audit actor, so this checkpoint makes no broader actor claim. Final preflight proved zero open sessions/tabs. Independent review approved deactivation; both profiles are inactive, their ignored credential file is removed, and historical actor rows remain intact.

The local conditional-payment assertion correction is appropriate, but it has not been exercised against staging. Final local verification passed 25 focused contracts and 39 files / 452 tests; build, focused type-check, lint, and diff checks remain clean within the documented existing warnings. Any new role-matrix execution requires a new explicit staging-write approval and fresh identities. Production remains NO-GO.

## 2026-08-25 second receptionist-manager live staging attempt

Verdict: **GO on both checkout-first transaction outcomes and complete reconciliation; NO-GO on the full matrix.**

Fresh distinct receptionist/manager identities and both empty-floor preflights passed. The receptionist checkout-first case passed completely. The manager checkout-first case reconciled a single winning checkout and rejected stale hop, then stopped only because its final native-alert assertion required a delayed refreshed-conflict message after reload; all stronger HTTP, mutation, database, visible conflict, Synced, Available, actor, and compatibility assertions had already passed. Independent review classified this as a UI synchronization test defect, not a transactional product defect.

Exact admin and actor-scoped artifacts prove two closed/billed sessions, two zero-total bills, zero payments, two committed mutations/events, correct retained actors, no hop effects, and unchanged compatibility state. Final postflight proved zero open sessions/tabs. Both QA profiles are inactive and credentials removed. The local dialog contract now permits only the known sync guard and optional refreshed-conflict alert while retaining deterministic conflict-state proof. Four hop-first/concurrent cases remain unexecuted and need new approval and identities. Production remains NO-GO.

## 2026-08-27 checkout-versus-settlement checkpoint

Verdict: **GO on cleanup and harness-defect classification; NO-GO on closing the concurrency gate.**

Independent pre-run review withheld execution until the reusable test bound both UI-generated commands to one authoritative pending-bill snapshot, recovered exact session IDs from acknowledged RPCs, required identity-bound cleanup plus terminal database reconciliation, and linked the winning canonical mutation to exact payment, settlement-audit, and event IDs. After correction, one zero-retry staging run was authorized.

Run `20260827053236` issued one Rs 45 deferred setup bill, then stopped before either race command was captured or sent because the still-open managed-session modal blocked a redundant dashboard-navigation click. Capture counts were zero, `raceStarted` was false, and no checkout-versus-settlement mutation or outcome exists. Guarded cleanup rejected the exact second session. Independent read-only evidence proves zero open sessions/tabs, the source session closed/billed to the pending Rs 45 bill, zero payments, one linked line, the second session closed/rejected without a bill, and compatibility advanced only `642 -> 643` through cleanup rejection.

The redundant navigation was removed locally and the complete corrected suite passes 40 files / 453 tests; the production build passes with its existing large-chunk warning, and lint retains zero errors/five baseline warnings. The Rs 45 QA receivable is an explicitly retained staging artifact and must not be altered without separate approval. A fresh live race needs a new explicit authorization, run identity, and empty-floor/app-state preflight. Production remains NO-GO.

## 2026-08-27 checkout-versus-settlement recovery checkpoint

Verdict: **GO to commit the local harness/evidence correction; NO-GO on closing the concurrency gate.**

Fresh zero-retry run `20260827054102` captured both UI-generated commands once but stopped at a whole-header equality assertion before deliberate concurrent submission. Failure teardown released interception too early, after which bounded ambiguous-response recovery committed one canonical checkout. Exact read-only reconciliation proves `BILL-20260827-003` and setup `BILL-20260827-002` are each issued and paid at Rs 30, the checkout created the current-bill payment and the related old-bill settlement payment, both sessions are closed/billed, every retained actor matches the authenticated admin, no standalone-adjustment effect is present, the floor is empty, and compatibility remains exact version/hash `643` / `f0c3300bb4e4c024a994fb41aa1aa266fea4bc91ed498e987687cdecd6174208`.

Independent review classifies this as correct checkout recovery and previous-dues behavior after a harness failure, not product concurrency evidence. The corrected interceptor cannot unroute before its captured request settles; pre-race failure keeps routes installed through page quiescence; endpoint and authenticated-subject checks replace credential-bearing object equality; mutation identities are retained before later assertions; and attached errors are redacted. The generated token-bearing run artifacts are absent from the workspace/current commit, and the scoped result-root scan found no remaining JWT-bearing Playwright artifact file.

Final local verification passes 40 files / 454 tests, focused harness contracts 27/27, Playwright discovery lists one exact staging-only zero-retry test, the production build passes with its existing large-chunk warning, lint has zero errors/five baseline warnings, and diff integrity passes. The run authorization is consumed. Another staging execution requires fresh approval and a new exact identity; production remains NO-GO.

## 2026-08-27 checkout-versus-settlement completed concurrency checkpoint

Verdict: **GO to close this single concurrency subgate; overall Release B remains production NO-GO.**

Read-only preflight for fresh identity `20260827115031` passed against staging project `tkbdyzxwwbhkpztgjjxh` with two independently authenticated active organization-admin slots, zero open sessions/tabs, retained `BILL-20260827-001` still pending at `Rs 45 / Rs 0 / Rs 45` with zero payments, and exact compatibility version/hash `643` / `f0c3300bb4e4c024a994fb41aa1aa266fea4bc91ed498e987687cdecd6174208`. The one authorized race then captured and submitted both UI-generated commands exactly once with retries zero. Standalone adjustment `financial-adjustment-ebb59e5e-4564-41ce-aee1-466c90b5900e` won and settled `BILL-20260827-004` with exactly one Rs 30 cash payment `payment-f82aa5b1-ae87-44ef-90d1-87a50b82148f`, settlement audit `audit-b1a8d24a-ca96-439f-91dc-4aea694232cb`, and event `event-0f410d09-13f7-4597-8217-9a808edabd69`. Checkout `financial-e670987c-c33b-4355-a970-32f3223c32f7` lost with HTTP 400; its status lookup is null, candidate bill `bill-70d9ea97-5eba-40ad-a525-de99ce3d376b` is absent, and no losing bill line, payment, checkout event, or checkout audit exists. The selected bill, payment, settlement audit, and event rows are attributed to authenticated admin `61cc2f83-69d1-46ab-9d89-9df7f7b1e497`.

The checkout's `settlement_conflict` response is proven by the executed response assertion and ordering recorded before the later failure; the retained compact attachment did not copy the response body. The Playwright case reported failure only because its adjustment-winner cleanup eligibility expected raw session status `open`, while the normalized row correctly uses `active`. Exact read-only reconciliation proved the complete financial transaction and unchanged compatibility version/hash across the race, so independent review classified this as a harness assertion defect rather than a product failure and prohibited a rerun. The assertion now accepts the normalized status. Separately authorized reject-only cleanup `cleanup_20260827121000` rejected exact unbilled session `session-61214135-435f-40c1-a2fb-7067e39ba191` through mutation `op-1b20b65f-6aeb-4b32-a07c-1fecd79b3023`, event `event-77212750-7fda-4ce3-bba2-9044d2bcad0a`, and audit `audit-4bddebed-cf7c-4a48-adec-e646fd94cfeb`. After-cleanup reconciliation proves the floor empty, `BILL-20260827-004` and its one settlement effect unchanged, the checkout loser still absent, retained `BILL-20260827-001` untouched, and compatibility advanced only through the rejection to version/hash `644` / `728e42f03b7da0925636606a168ed5964daaf70869cb72cf936e498dee673114`.

The original compact Playwright summary was accidentally overwritten by a later read-only discovery command that reused the source run identity. Its original race attachment, screenshots, videos, and error context remain, and `checkout-settlement-race-runner-summary-20260827115031.json` is explicitly labeled as a reconstruction rather than original evidence. The primary verdict rests on the preserved run media/attachment and the exact before- and after-cleanup database reconciliation artifacts. No further staging write or race rerun is authorized. Remaining writer-concurrency, complex payment/carryover, production-sized performance, and final independent release sign-off gates keep production NO-GO.

## 2026-08-29 customer-tab source-mutation concurrency completed

Verdict: **GO to close all twelve customer-tab source-mutation orderings; overall Release B remains production NO-GO.**

Independent review verified the fresh `tab-mut-rem4-20260829-1338` preflight and authorized exactly the fail-closed remaining-four selector. The one-worker, retries-zero run passed: `remove_item / simultaneous`, `apply_combo / mutation_first`, and `apply_combo / simultaneous` were operational winners with exact mutation-actor events/audits and null financial mutations; `apply_combo / checkout_first` was the sole checkout winner with exactly one Rs 50 bill, line, cash payment, financial mutation/event/audit, and `-1` sale movement attributed to the checkout actor. No losing or duplicate effect exists.

Read-only recovery returned `reconciled`, `failures: []`, and an empty floor with all four tabs terminal, item stock `63`, both fixtures inactive, and compatibility version/hash `691` / `2de2c4ab0d04f2e65a4031cb987a72bc32bd5cc34af5cbadcddf45786857eb55`. Independent review authorized a generic cleanup finalizer expected to perform zero persistent actions. It passed with `actions: []`; the mandatory independent database postflight retained every exact effect and the same compatibility identity. The temporary mutation admin is inactive, its ignored credential file is removed, and no password was printed.

Together with the previously reconciled one-case and seven-case runs, this closes all 12/12 add/update/remove/apply-combo checkout-first, mutation-first, and simultaneous orderings. This verdict does not authorize production. Pending write-off and void races, the consolidated complex UI/payment/discount/carryover matrix, mixed representative performance and deployed query-plan/error evidence, and final independent release sign-off remain open.

## 2026-08-29 checkout-versus-pending-write-off partial checkpoint

Verdict: **GO to close only the checkout-first ordering; NO-GO on the write-off race subgate and production.**

Fresh immutable preflight `writeoff-race-20260829-1424` bound staging project `tkbdyzxwwbhkpztgjjxh`, deployed bundle `/assets/index-CM3_cZEL.js` / SHA-256 `359fbc5e6530a71d1be6a7c7e3399dbcd441c25d2e234e5e3c391e2bab1e69b9`, distinct active admins, an empty floor, zero identity collisions, and compatibility version/hash `691` / `2de2c4ab0d04f2e65a4031cb987a72bc32bd5cc34af5cbadcddf45786857eb55`. Exactly one one-worker, retries-zero race execution was made and was not retried.

Only `checkout_first` ran. Checkout won and atomically issued the current Rs 30 bill while settling deferred setup bill `BILL-20260829-001` with exactly two Rs 30 cash payments across the two bills. The pending bill finished issued/paid/due `Rs 30 / Rs 30 / Rs 0`; both exact sessions finished closed/billed; and the losing write-off returned HTTP 400 `financial_adjustment_conflict` with a null mutation and no write-off audit/event/effect. Immutable reconciliation revision `checkout-writeoff-race-reconciliation-writeoff-race-20260829-1424-audit-normalization-1.json` returned `partial` with `failures: []`: two exact bills, two payments, six events, ten audits, correct authenticated checkout-actor attribution, zero stock movements, zero open sessions/tabs, no cleanup candidate, and unchanged compatibility identity.

Playwright reported failure only after the complete financial outcome because the harness expected an operational `1 conflict` queue entry. Financial RPC rejections correctly surface through the remote-error banner instead. The reusable local test now requires the exact server rejection message, Dismiss, zero operational conflicts, and clean reload convergence; no staging rerun was performed. Independent review confirmed no cleanup was needed and authorized lifecycle closeout. Temporary admin `f97f5872-6494-4c2a-89ba-2e94c6e643b7` is inactive, its ignored credential file is removed, and the deactivation artifact confirms no password was printed.

The consumed authorization proves only `checkout_first`. `writeoff_first` and `simultaneous` remain not run, so the write-off race subgate stays open. `safeForAutomaticRetry` and `safeForIdentityBoundCleanup` are both false. No race retry or production action is authorized.

## 2026-08-29 checkout-versus-pending-write-off second ordering

Verdict: **GO to close `writeoff_first`; NO-GO on the remaining simultaneous ordering and production.**

The fail-closed remaining-two selector was independently reviewed and fresh preflight `writeoff-rem2-20260829-1445` passed with scenarios exactly `[writeoff_first, simultaneous]`, distinct active admins, empty floor, no run/bill/artifact collisions, deployed bundle SHA-256 `359fbc5e6530a71d1be6a7c7e3399dbcd441c25d2e234e5e3c391e2bab1e69b9`, and compatibility version/hash `691` / `2de2c4ab0d04f2e65a4031cb987a72bc32bd5cc34af5cbadcddf45786857eb55`. One one-worker, retries-zero execution ran once and was not retried.

`writeoff_first` completed its server outcome: write-off won, voiding deferred Rs 30 `BILL-20260829-002` under authenticated adjustment actor `87aa2f3f-590a-4178-b4dc-b109029a1758`; checkout returned HTTP 400 `settlement_conflict` with a null mutation and no candidate bill, payment, or stock effect. The browser then stopped because the still-open losing checkout modal intercepted the remote-error banner's Dismiss click, so `simultaneous` did not run. The local harness now closes the exact losing modal with Cancel before dismissing its exact remote error; no race rerun occurred.

Initial read-only reconciliation queried the write-off mutation through checkout actor A and therefore returned a false null under actor-bound mutation visibility. Narrow revision `actor-bound-1` queries setup/checkout through actor A and write-off through actor B. Its immutable report returned `partial`, `failures: []`, exact write-off canonical/response/database/event/audit attribution, zero payment/stock/candidate-bill effects, unchanged compatibility, and exactly one identity-bound active-session cleanup candidate. Independent review authorized one SHA-bound cleanup `writeoff-rem2-cleanup-20260829-1450`; it rejected only that session. Mandatory postflight returned `partial`, `failures: []`, zero cleanup candidates, an empty floor, and compatibility version/hash `692` / `0c2fc997a8e6668d080b98c1c92dc3864f038ebbe391e7d2f8f07291e17e90e1`, advanced only by the acknowledged rejection.

The temporary admin is inactive, its ignored credential file is removed, and no password was printed. Combined with the earlier `checkout_first` evidence, two of three write-off orderings are closed. `simultaneous` alone remains not run; the overall write-off subgate and production remain NO-GO.

## 2026-08-29 checkout-versus-pending-write-off simultaneous and terminal verdict

Verdict: **GO to close the complete three-ordering staging write-off subgate; production remains NO-GO.**

Fresh simultaneous-only preflight `writeoff-sim-20260829-1457` passed with exact selector `[simultaneous]`, distinct active admins, an empty floor, zero collisions, and compatibility v692/hash `0c2fc997a8e6668d080b98c1c92dc3864f038ebbe391e7d2f8f07291e17e90e1`. The one-worker, retries-zero race ran once. Write-off was the sole winner, voiding Rs 30 `BILL-20260829-003` through mutation `financial-adjustment-fba12e3d-7885-4b44-978e-aa93034f8ac8`, event `event-3a3ba5c2-eafe-4676-93c5-3ccdc7e03ae5`, and audit `audit-c246eb81-7b00-46ce-95b9-001fb56349af` under authenticated adjustment actor `288d0a4e-5fa0-46ff-9132-38ab1026f8dc`. Checkout returned `settlement_conflict` with a null mutation and zero bill/payment/stock effect; compatibility was unchanged by the race.

The browser reported failure only after the complete outcome because the managed-session dialog remained above the exact remote-error banner. No race was retried. Immutable reconciliation returned `partial`, `failures: []`, exact actor/effect evidence, and one identity-bound cleanup candidate. Independently authorized cleanup `writeoff-sim-cleanup-20260829-1957` rejected only session `session-5bf2215e-93ac-4974-ad63-5fffefbbd8c4`. Mandatory postflight SHA-256 `f3ca9034c8bcddbb8d9ea0b178099a2014e6f27367fd7c87b2f6b94bf34ac79a` returned `passed`, `failures: []`, no cleanup candidates, an empty floor, and compatibility v693/hash `6af03b34ea29896c9bd5c9725f03db36954080bb4b32c8f10a4b843cf9efafc4`, advanced solely by acknowledged rejection. The temporary admin is inactive and its credential file is removed.

Combined with `writeoff-race-20260829-1424` and `writeoff-rem2-20260829-1445`, all `checkout_first`, `writeoff_first`, and `simultaneous` orderings have canonical winner/loser and terminal hygiene evidence. The reusable UI harness now closes both the losing financial modal and managed-session dialog before dismissing the remote-error banner. The next financial-writer concurrency gate is issued-bill void. This verdict authorizes no production action.

## 2026-08-29 checkout-versus-issued-bill-void static readiness

Verdict: **GO for one fresh staging-only immutable preflight; no race execution or production action is authorized by this verdict alone.**

Independent static review found the reusable refund-to-void adaptation fail-closed. One exact `refund | void` disposition is overwritten by the package runner and bound through preflight/verify, disposition-specific fixture and artifact identities, Playwright capture, actor-bound reconciliation, recovery, SHA-bound cleanup, and mandatory postflight. Void mode requires a fresh distinct active temporary admin and validates its immutable creation lineage. The browser contract selects exact `void`, requires `voidBill`, `voided`, `bill_voided`, zero adjustment payments, one positive `void_refund_reversal`, two successful command responses, two retained payments, exact `-1/-1/+1` stock arithmetic, final stock `1`, terminal billed tabs, and unchanged financial `app_state`. Legacy refund remains the default and accepts either legacy evidence without a disposition or exact `refund` evidence.

Local evidence passes syntax, focused contract 5/5, full 46 files/494 tests, production build with only the known large-chunk warning, lint with zero errors/five baseline warnings, `git diff --check`, and read-only Playwright discovery of exactly one void-race test and one identity-bound cleanup test with retries `0`. If recovery cleanup is needed, its separately packaged disposition-specific read-only postflight is an explicit mandatory evidence gate before lifecycle deactivation or subgate closure. Production remains excluded.
