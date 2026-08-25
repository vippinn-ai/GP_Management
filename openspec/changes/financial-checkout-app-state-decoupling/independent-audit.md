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
