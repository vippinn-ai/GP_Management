# Independent staging test plan

## Execution rules

- Clean worktree, approved SHA, reusable Playwright/direct-DB scripts, and `retries: 0`.
- Unique `normops-YYYYMMDD-HHMM-<case>-<n>` IDs for every run/entity/mutation/audit/customer.
- Never rerun ambiguity with a new ID; reconcile, then replay only the same ID where specified.
- Persist request body/response/database/timing/console/network/cleanup evidence as immutable JSON with SHA-256. Never persist authorization, API-key, cookie, password, or other credential headers in evidence.
- Capture old deployed definitions, ACLs, proconfig, flags, publication, compatibility hash/version/bytes, and rollback SQL before install.
- Run `npm run test:e2e:staging:operational-v2:static` to lint and no-emit type-check every Playwright spec selected by `playwright.operational-v2.staging.config.ts`; focused checks of only newly edited specs are insufficient.
- For an already-installed v2 function correction, prove the dedicated reinstall builder rejects a missing function, inconsistent definition hash, owner/configuration/ACL drift, dirty operational floor, and incomplete `app_state` identity; verify its install contains only the three reviewed v2 definitions, preserves preflight owner/ACL state, is atomic and immutable, and its rollback restores those exact three preflight definitions without touching unrelated functions or data.
- Exercise reinstall guards against deployed PL/pgSQL bodies containing CRLF and LF line endings; the SQL-side body normalization and boundary-whitespace trimming must produce the same canonical hash as the builder.
- Cleanup must preserve the primary assertion or runtime failure. No selected spec may throw from a `finally` block or otherwise replace the original failure with a cleanup failure.
- Every fallible finalization step must run through the shared settled cleanup guard. Independent steps continue after a cleanup failure; the primary failure is rethrown first, while one or more cleanup failures are reported only after a successful primary path.

## Functional and parity matrix

- Active timed/unit-sale hop; edited start; stale client start cannot overwrite canonical start.
- Active and paused/open-pause session reject; tab reject with items, variants, cigarettes, combos intact.
- Game-to-game multi-hop, game-to-new-tab, game-to-existing-tab, final checkout, receipt, and single consumption.
- Reject continuation consumer, release source hops, recover later exactly once.
- Dashboard availability, continuation banner, activity, bills, receipts, customers, analytics, inventory, hard refresh, logout/login, and mobile viewport.
- No bill/payment/stock/inventory effect from hop or reject.

Reusable suite ownership:

- `operational-lifecycle-v2-continuations.e2e.ts`: unit-sale hop with canonical mode/item/inventory/bill-line preservation and exact one-time final stock decrement/movement; new/existing consumables-tab continuation; three-consumer exclusivity; reject-and-recover; exact direct RPC timing/body, event/audit actor, browser-error, and unresolved-entity evidence.
- `operational-lifecycle-v2-recovery-realtime.e2e.ts`: committed/lost response; configured 20-second critical-acknowledgement waiter expiry; manual same-ID replay; realtime-first/response-first; offline gap; controlled duplicate realtime frame; observer-panel unmount/reconnect.
- `operational-lifecycle-v2-hop-mutation-races.e2e.ts`: hop versus timing, pause, resume, add-item, and remove-item writes, using distinct actors and accepting only success or exact `session_not_open`; reconcile the canonical session, closed pause, item/bill-line outcome, event, audit, actor, console, pending queue, and unresolved-session ledger.
- `operational-lifecycle-v2-concurrency.e2e.ts`: same-target races, exact 20-by-3 latency sampling, and 50 unrelated-target overlap/reload pairs.
- `operational-lifecycle-v2-downstream-parity.e2e.ts`: canonical bill/line/payment, Bill Register/receipt, hard refresh, mobile viewport, and logout/login parity.

## Negative, security, idempotency

- Missing/wrong organization/kind/type/entity/audit; outer-inner mismatch; malformed JSON/arrays; empty reason.
- Omitted and empty-string mutation kind/entity type for all three lifecycle RPCs return `invalid_payload`; the proof helper preserves the original PostgreSQL SQLSTATE when exception detail is not JSON.
- Future/end-before-start/malformed timestamp; missing canonical start; missing/foreign/multiple open pause; audit collision.
- Missing/closed/billed/rejected/wrong-organization target.
- Anonymous, inactive, wrong organization, unsupported role, actor spoof, and forbidden compatibility-version authority.
- Same ID/same intent returns one canonical result; same ID/different intent fails `mutation_identity_mismatch`.
- Mutation, audit, and event actor equals authenticated JWT subject.
- Forced late failure rolls back all domain/mutation writes and leaves `app_state` unchanged.

## Race, realtime, recovery

- hop/hop, reject/reject, hop/reject, checkout/hop, checkout/reject, hop/timing/pause/resume/item mutation.
- continuation start/link/new-tab double consumption; reject consumer versus new consumer.
- unrelated session/session, session/tab, and tab/tab pairs both succeed without global serialization.
- Direct two-client calls retain exact request/response/timing evidence; same-target cases prove winner actor attribution and the read-only post-test reconciliation proves every losing mutation/audit/event rolled back.
- realtime-before-response, response-before-realtime, reversed hydration completion, reconnect/gap/duplicate/unmount.
- lost response and waiter timeout recover with same mutation ID, exactly one effect, no automatic resend.
- 50 two-client reload-versus-mutation overlaps end with database parity before writes become enabled.

The rollback-only DB proof and the frozen/candidate 30-load comparison run before any mutating browser case so both performance runs are bound to the same exact normalized content fingerprints. Functional and concurrency cases run only after candidate performance passes.

## Performance gates

Use guarded disposable production-logical-size staging state with exact restore artifact/hash.

The full-table fingerprint helper is staging-only test instrumentation and is not part of the production lifecycle migration.

- Exactly 20 single-send browser-observed samples per target class plus 50 unrelated-operation pairs; zero 57014, deadlock, timeout, automatic retry, duplicate, or unexpected browser error.
- Ten additional calibrated pairs submit from distinct actors within 100 ms and compare concurrent wall time with equivalent isolated sequential wall time; p95 concurrent/sequential must remain below `0.85`. Raw request, response, client timing, `server_time`, and `server_duration_ms` evidence is retained, but `server_time` is not misrepresented as a transaction-completion timestamp.
- Target RPC DB p95 under 500 ms and max under 2 s; HTTP/UI acknowledgement p95 under 2 s and max under 5 s; outer browser ceiling 7 s.
- Candidate p95 at least 50% faster than frozen same-scale v1; large-versus-small difference <=20% or 250 ms.
- Initial JS <=1,000 KB minified and <=300 KB gzip; cold shell <=450 KB; no jsPDF/XLSX in entry; first export <=2 s.
- Critical bootstrap waterfall depth <=3, payload <=750 KB and >=60% smaller than baseline; no full `app_state.data` read.
- 30 cold authenticated loads: safe-interactive p95 <=3.5 s, max <=5 s, and >=40% faster than baseline. Login LCP p75 <=2.5 s, CLS <=0.1.
- No root commits attributable to the one-second clock after the runtime unit; active-panel commit p95 <16 ms and max <50 ms.

Every case is passed, failed, blocked, or not run. Any required blocked/not-run case is NO-GO unless the approved spec explicitly narrows it with recorded risk acceptance.
