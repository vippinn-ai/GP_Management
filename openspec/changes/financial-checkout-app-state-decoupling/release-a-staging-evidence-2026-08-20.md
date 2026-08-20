# Release A staging execution evidence — 2026-08-20

## Scope

- Project: `test/staging` (`tkbdyzxwwbhkpztgjjxh`), Southeast Asia (Singapore).
- Current reviewed deployment commit: `ab9b355a66d642bd1351bf8414770b9af543827d` (the initial Release A deployment was built from application commit `0af9c7b0cb35e521fd35bff9ba7980d792cf100e`).
- Financial v2 remained disabled; phase 10 was not applied.
- No production project, production database, or production deployment was accessed.
- Staging was resumed from its paused state. The initial investigation was read-only. After the user explicitly approved the staging-only destructive reconstruction, a verified backup was retained and normalized `org-primary` was rebuilt from authoritative `app_state`.

## Evidence metadata

- Execution window: `2026-08-19T19:28:17Z` through approximately `2026-08-20T04:15Z` (`2026-08-20 00:58` through approximately `09:45` IST) for the recorded active runs; the required business-day soak remains open.
- Operator: Codex primary agent using the user-authorized authenticated staging sessions.
- Independent reviewer: separate read-only checkout test agent.
- Browser surface: authenticated Codex in-app browser plus the user's independently authenticated Chrome profile through the connected browser integration.
- Previous accepted staging frontend version: `c76b06d6-3cab-408f-a32c-d1937b14b562`.
- Current staging frontend version: `a92f5873-ccf0-4801-ad30-ac5a6c32d858`.

## Project and compatibility baseline

Captured at `2026-08-19T19:28:17.526161+00:00` (`2026-08-20 00:58:17 IST`):

- PostgreSQL `17.6`; project status became Healthy after restoration.
- `app_state.id = primary`.
- `app_state.version = 487`.
- `app_state.updated_at = 2026-07-27T05:33:35.017281+00:00`.
- `app_state.data` SHA-256: `cf5e87672491da73d41db3565218c79f9b98a1e938c2b1ad4c2c934a12d670d5`.
- Required normalized tables exist.
- `app_state` and `operational_events` are both in `supabase_realtime`.
- `profiles.tab_permissions` is absent.
- `edit_pause_log`, `delete_pause_log`, and `record_session_audit` are absent.
- `load_analytics_summary(text,date,date,date,date)` and `load_inventory_report_summary(text,date,date,text,integer)` were present, denied to `anon`, and granted to `authenticated`. The earlier probe used incorrect `get_*` names; the frontend and repository use these `load_*` signatures.
- Existing public operational/financial/admin RPCs are granted to `authenticated`; the internal inventory resolver is not granted to `authenticated` or `anon`.

## Pre-reconstruction parity result

The repository `phase1-parity-checks-single-result.sql` returned 36 rows. The following non-zero deltas block normalized-source promotion:

| Metric | `app_state` | Normalized | Delta |
| --- | ---: | ---: | ---: |
| audit logs | 531 | 769 | +238 |
| bill discounts | 13 | 11 | -2 |
| bill line discounts | 4 | 3 | -1 |
| bill lines | 342 | 322 | -20 |
| bills | 119 | 112 | -7 |
| customer tabs | 58 | 59 | +1 |
| customers | 61 | 86 | +25 |
| payments | 127 | 118 | -9 |
| pause logs | 18 | 33 | +15 |
| sessions | 110 | 111 | +1 |
| stock movements | 272 | 359 | +87 |
| bill amount due | Rs 652 | Rs 852 | +Rs 200 |
| bill amount paid | Rs 196,976 | Rs 194,126 | -Rs 2,850 |
| bill total | Rs 197,628 | Rs 194,978 | -Rs 2,650 |
| payment amount | Rs 197,476 | Rs 194,126 | -Rs 3,350 |
| stock quantity | 999,802 | 999,680 | -122 |
| open customer tabs | 0 | 1 | +1 |
| open sessions | 0 | 1 | +1 |
| pending bills | 0 | 1 | +1 |

Catalog, combo, expense, pricing, station, item, and variant counts not listed above were equal. Inventory item current-stock values had no per-item difference, despite the historical movement-count and movement-total deltas.

## Financial differences

Normalized tables contain no bill or payment IDs absent from `app_state`; they are an incomplete subset for these collections.

Seven bills exist only in `app_state`, and none of their bill numbers exists under another normalized ID:

- `BILL-20260620-001` — Rs 697.
- `BILL-20260620-002` — Rs 0.
- `BILL-20260620-003` — Rs 73.
- `BILL-20260620-004` — Rs 854.
- `BILL-20260620-023` — Rs 10.
- `BILL-20260621-010` — Rs 517.
- `BILL-20260621-011` — Rs 499.

Nine payment IDs exist only in `app_state`, totaling Rs 3,350. They include the payments for the missing bills and older-bill settlement payments.

Bill `BILL-20260418-003` (`bill-a13bfafe-17a4-469a-a9c2-114368789a89`) demonstrates stale lifecycle state:

- `app_state`: issued/settled, amount paid Rs 700, amount due Rs 0, settled at `2026-06-20T21:29:23.325Z`.
- normalized: pending, amount paid Rs 500, amount due Rs 200.

## Stale normalized live rows

The normalized tables retain rows that are absent from the current `app_state` live summary:

- Open customer tab `customer-tab-845371bc-9803-4dc4-b8f5-e345bd7e324b`, customer `Harpreet`, opened `2026-07-22T14:30:50.527Z`.
- Paused session `session-0ed9589f-98f0-4662-85e3-7cd1e948d3bb`, customer `rudraksh`, station `station-snooker-sharma`, started `2026-07-22T15:13:28.943Z` and paused `2026-07-22T15:18:45.727583Z`.

Their start/open/pause operational events exist, but the later state represented in `app_state` is not reflected in those normalized rows.

## Backup and reconstruction

The user explicitly approved deletion and reconstruction of staging normalized `org-primary`; production remained out of scope.

- Backup schema: `release_a_backup_20260820_0af9c7b`.
- Backup capture: `2026-08-19T19:34:38.400815+00:00`.
- Backup contents: 46 captured data/metadata tables and 4,564 rows, plus the backup row-count table.
- Backup includes every public `organization_id` table for `org-primary`, primary `app_state`, all profiles, public function definitions and grants, indexes, and realtime publication membership.
- Backup `app_state`: version `487`, updated at `2026-07-27T05:33:35.017281+00:00`, SHA-256 `cf5e87672491da73d41db3565218c79f9b98a1e938c2b1ad4c2c934a12d670d5`; all three fields exactly matched live staging before reconstruction.
- No other active non-system staging database connection was present immediately before reconstruction.

The first direct phase-1 backfill attempt failed on `analytics_dirty_dates_organization_id_fkey`: an existing analytics trigger fired during the organization cascade. PostgreSQL rolled the statement back. A follow-up query proved the organization and pre-attempt counts remained present (`bills=112`, `payments=118`, `sessions=111`, `audit_logs=769`, `operational_events=416`) and the `app_state` version/hash were unchanged.

The approved backfill was then run in one explicit transaction. Public user-trigger modes were captured in a temporary table, user triggers were disabled only for the reconstruction, and each trigger was restored to its original `O`, `D`, `R`, or `A` mode before commit. The reviewed repository backfill SHA-256 was `967da7e9c7f06e9ae1e6b5a10321b7562f249f7deb18fecb133b53d49e98aa3e`; the transaction wrapper SHA-256 was `2d2fcc56d7190dee25c77991a6847bcf44be9a4bb6c142b7e869788a29b69b50`.

Post-reconstruction evidence:

- All 36 repository parity rows returned delta `0`.
- Core normalized counts became `bills=119`, `payments=127`, `sessions=110`, `customer_tabs=58`, `audit_logs=531`, and `stock_movements=272`.
- Stale normalized open sessions, tabs, and pending bills became `0`, matching `app_state`.
- The reconstructed compatibility baseline intentionally contains `0` historical `operational_events`; the former 416 normalized-only events remain retained in the backup schema.
- All public user triggers were restored to normal enabled mode; no nonstandard trigger mode remained.
- `app_state` remained version `487` with the same updated timestamp and SHA-256.

## Additive Release A database and edge installation

Applied to staging, in reviewed order:

1. `supabase/phase4-customer-tab-rpcs.sql`, SHA-256 `b0857f508914499fdd71fbc367681de39259a5b283d3e35e3f55012d32165822`.
2. `supabase/phase11-operational-maintenance-rpcs.sql`, SHA-256 `161d9b2374d3b12b84a96e9e338d48cf7bd9bb8da1f4acaa0c39e5f8f02f42a3`.
3. Repository `admin-update-user` edge function.

Verification proved:

- `resolve_operational_inventory_item` reads `public.inventory_items`, contains no `app_state` reference, and is executable by neither `anon` nor `authenticated`.
- `open_customer_tab`, tab-item add/update/remove, `edit_pause_log`, `delete_pause_log`, and `record_session_audit` are denied to `anon` and granted to `authenticated`.
- `profiles.tab_permissions` exists as nullable `jsonb`.
- Analytics and inventory summary tables retain RLS; their read RPCs are denied to `anon` and granted to `authenticated`.
- `app_state` and `operational_events` remain in `supabase_realtime`.
- `commit_checkout_bill_v2`, `commit_financial_adjustment_v2`, and `financial_mutations` remain absent.
- A second 36-row parity run after installation again returned no non-zero delta.
- `app_state` remained version `487` and SHA-256 `cf5e87672491da73d41db3565218c79f9b98a1e938c2b1ad4c2c934a12d670d5`.

The previously deployed edge source was retained in evidence with SHA-256 `5b0610cffe75858ebc8ec931c918517ac3dae203d3a6bc32138ffc3bba471a31`. Shared `cors.ts` and `admin.ts` matched the repository. A post-deploy source verification caught that a dashboard-editor search had appended a stray token to the first staged update; the file was immediately replaced and redeployed before functional testing. The final deployed normalized source SHA-256 is `68141c5f0851c05e618e3c5db35b1d24ecd8c86a169574d38c8a311db60b110b`, exactly matching the repository-normalized source and ending at `});` with no trailing token.

## Frontend deployment state

The actual ignored `.env.staging` boolean flag capture was reviewed and hashed. Its SHA-256 is `cc6cf00348ed6f4e61971438d04b24254a36e3fbf8c301d4847a49fb6d537942`; all required normalized/operational read and write flags are `true`, while `VITE_BACKEND_FINANCIAL_RPC_V2=false`.

The first staging frontend build passed from clean application commit `0af9c7b0cb35e521fd35bff9ba7980d792cf100e` with the existing large-chunk warning, but its Cloudflare upload did not start because the stored Wrangler OAuth credential had expired and its refresh request returned HTTP 400. Wrangler exited before changing the deployment. The operator renewed the existing Wrangler OAuth authorization without exposing an API token.

The reviewed staging build was then repeated successfully from evidence checkpoint `0cc3f15` (application source unchanged from `0af9c7b`). Wrangler uploaded three modified assets and deployed only worker `gp-management-staging-pages`:

- URL: `https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev`.
- Cloudflare version ID: `8bd7fd6d-9084-428f-859d-26b04123135c`.
- Financial v2 build flag: `false`.
- Production worker `management` was not targeted or changed.

A fresh, uncached in-app browser tab loaded the deployed staging URL successfully with title `Game Parlour Management System` and the expected BreakPerfect sign-in screen.

During extended functional verification, the application source was updated only to correct a staging-discovered customer-identity defect. Commit `249e898` first preserved missing canonical customer IDs and reconciled optimistic IDs with the server response. The independent reviewer then found a duplicate-name/phone edge case; commit `60ba75c` made IDs referenced by sessions, tabs, or bills authoritative and added both failure-shape tests. The intermediate Cloudflare version `f6456e7c-e506-43d5-a13a-6902c39b7c84` was superseded before acceptance. The identity-corrected staging deployment was:

- Commit: `60ba75c07cebf6a5e12bc52096b8158917cbbcdc`.
- Cloudflare version: `c76b06d6-3cab-408f-a32c-d1937b14b562`.
- Local gates: 30 test files / 376 tests passed; production and staging builds passed; lint exited zero with five pre-existing warnings; generated manifest contains 242 files with zero missing/hash/line mismatches.
- Financial v2 remained `false`; production was not targeted.

The independent financial adjustment case then exposed a separate Bill Register invalidation defect: replacement committed successfully in PostgreSQL, but the origin and observer Bill Register pages retained stale rows even after the screen's Refresh action; a hard reload reconstructed the correct data. Commit `ab9b355` made compact financial realtime carry its refreshed bill slice into the application, added a dedicated Bill Register refresh generation, and covered the behavior in gateway and cutover contract tests. The reviewed fix was deployed only to staging:

- Commit: `ab9b355a66d642bd1351bf8414770b9af543827d` (`Refresh normalized bill register after adjustments`).
- Cloudflare version: `a92f5873-ccf0-4801-ad30-ac5a6c32d858`.
- Local gates: 30 test files / 377 tests passed; build passed with the existing large-chunk warning; lint exited zero with five pre-existing warnings; `git diff --check` passed.
- The staging build retained `VITE_BACKEND_FINANCIAL_RPC_V2=false`; worker `management` and the production database were not targeted.

## Authenticated application smoke and realtime evidence

The staging application login was exercised with an active admin profile. No credential, resolved email address, access token, or password was written to this evidence or the repository.

Authenticated normalized-read checks passed after login and after a hard refresh:

- Live Dashboard loaded with `0` live open sessions before the controlled mutation.
- Bill Register loaded its first normalized page of 50 bills.
- Analytics loaded without a retry/error state.
- Customer Profiles loaded 61 normalized customer profiles.
- Inventory loaded without a retry/error state.
- No checked screen displayed a cached-data fallback or stale-read warning.

A controlled realtime mutation was then run from the deployed staging UI:

- A temporary session was started on `Arcade 3` for uniquely tagged customer `QA ReleaseA 20260820 0134`.
- The origin tab showed the session as Running, a Rs 5 live bill, and `1` open session.
- A second authenticated tab received the new session through compact realtime without a manual refresh and also showed `1` open session.
- Because this browser runtime does not expose `window.prompt`, the UI Reject button could not supply its required reason. Cleanup therefore used the application's authenticated `reject_session` RPC contract rather than a direct table edit.
- Cleanup session: `session-94a531bc-222f-4b06-8654-4f290480bcfd`.
- Cleanup mutation: `op-8746f50d-6b95-4c97-ad41-465fcfbff066`.
- Cleanup operational event: `event-972b08e8-04a3-471d-8676-5f2c84761fe4`.
- RPC duration: `85.528 ms`; compatibility `app_state.version` advanced from `487` to `488`.
- The persisted session is closed with disposition `rejected` and the staging smoke-cleanup reason.
- The `session_rejected` audit actor and `reject_session` operational-event actor both match the authenticated user.
- Both tabs received the closure through realtime: `0` live open sessions, `Arcade 3` Available, and the QA customer absent from live sessions.
- Both tabs retained the same state after hard refresh; the closed QA session did not resurrect.

This first lifecycle was a same-browser, two-tab realtime check. Its former Chrome-connectivity limitation was subsequently removed. The independent Chrome lifecycle below supersedes that limitation for session start/item/reject/reload coverage, but it does not represent the whole Gate 5 matrix as passed.

### Independent Chrome lifecycle and non-resurrection check

A second controlled lifecycle used two genuinely independent browser sessions: the authenticated Codex in-app browser and the user's separately authenticated Chrome profile.

- Test customer: `QA Independent Chrome 20260820 0905`.
- Session: `session-9d6a8e93-12c9-42da-87e3-9327c0782f6c` on `Arcade 2`.
- The in-app origin started the unit session at `2026-08-20T03:34:46.409+00:00` with one `Arcade 1 Coin`, quantity `1`, unit price Rs 5.
- Chrome received the new Running session through realtime without refresh and showed the same Rs 5 live total.
- The origin added one Coke; Chrome independently received the Rs 15 total. The origin then removed Coke; Chrome independently returned to Rs 5. The persisted session subsequently contained only the original Arcade coin.
- Start mutation/event: `op-3111337b-f2f7-4235-8836-8a8b4a0f3ad5` / `start_session`.
- Add mutation/event: `op-5fcb0615-d160-4a2c-b01b-a53b6b80450a` / `add_session_item`.
- Remove mutation/event: `op-249feed0-84b8-47b7-bec2-249d6147d1e0` / `remove_session_item`.
- Chrome initiated the normal UI rejection. The persisted rejection time is `2026-08-20T03:44:45.187+00:00`; the stored reason is `reject`.
- Reject mutation/event: `op-abb91978-c253-46c5-897c-083e24cb5808` / `reject_session`; server duration `198.529 ms`.
- The final session is closed with disposition `rejected`, no bill link, and `Arcade 2` available.
- All four audit rows and all four operational events resolve to the authenticated `Vipin` / `vipin` profile (`61cc2f83-69d1-46ab-9d89-9df7f7b1e497`).
- Compatibility `app_state.version` advanced to `494`; final SHA-256 is `4f0f0865923aaf5c8bf7768b74ffffeb214b62820d1bcf0ed08fbb5e81eb6af5`, updated at `2026-08-20T03:44:47.166446+00:00` by the same actor.
- A fresh in-app browser load and a full Chrome reload each reconstructed `0` open sessions, showed `Arcade 2` Available, displayed the rejection audit, and did not resurrect the closed session.

## Extended v1 financial and downstream verification

Four controlled v1 bills/adjustments were completed without a client timeout or SQLSTATE `57014`:

1. Timed session checkout: `BILL-20260819-001` (`bill-2ff891f7-139d-426f-91c1-c8e8639678f0`), Rs 36 cash, correctly closed the timed session after pause/resume/edit/delete-pause and item add/remove checks. The receipt showed the 8 Ball Pool timed charge, and payment/bill/audit actors agreed.
2. Unit-sale checkout: `BILL-20260819-002` (`bill-63ed71d6-d04e-4dc9-ac97-d464f616bac0`), Rs 5 deferred, followed by a full Rs 5 cash settlement. The Bill Register refetched to zero due; bill settlement, payment receiver, and audit actor agreed.
3. Customer-tab checkout: `BILL-20260819-003` (`bill-b0cfabc0-1b3e-431b-b19a-1ec322dd6f20`), Rs 10 cash for one Coke. The tab closed, stock decreased once, receipt and actors agreed, and the bill survived hard refresh.
4. Customer-identity regression checkout: `BILL-20260819-004` (`bill-5dc1cab1-c927-4bf0-ab50-31e830cf70a1`), Rs 10 cash for one Coke. It completed inside the bounded browser observation window; its database financial event reports `190.959 ms` server duration.

Analytics after the first three bills showed Rs 51 gross revenue, three bills, Rs 35.76 session revenue, Rs 15 consumables revenue, and Rs 51 cash, matching the controlled bills. Bill Register rows and receipts remained available after hard refresh.

### Independent two-browser checkout, settlement, replacement, and refresh verification

The authenticated in-app browser and the user's independently authenticated Chrome profile then exercised the v1 financial path together:

- `BILL-20260820-001` (`bill-69424f80-7bd2-43de-b111-908732c4a674`) closed a timed 8 Ball Pool session after realtime pause/resume observation. It contains the timed line `8 Ball Pool session (0 min)` at Rs 2.21, Rs -0.21 round-off, and a Rs 2 cash payment.
- `BILL-20260820-002` (`bill-0f817565-a26c-4da9-ba82-fe43ca8a5c58`) closed a customer tab containing one Coke as Rs 10 deferred, then settled Rs 10 cash. Both browsers showed zero due.
- Replacement `BILL-20260820-003` (`bill-f878d264-017b-430a-92be-3619f25e51d4`) increased Coke from one to two and charged Rs 20 cash. PostgreSQL atomically marked `BILL-20260820-002` replaced and linked both bills. Inventory history contains the original Coke sale `-1` and the replacement difference `-1`, not a duplicate full deduction.
- On the pre-fix deployment, the replacement revealed that the Bill Register's separate normalized page state was not invalidated by origin success or compact realtime. Both pages stayed stale until a hard reload. This failure was retained as evidence and fixed in commit `ab9b355`.
- Post-fix `BILL-20260820-004` (`bill-b6d1040d-816a-44e0-93ac-2dc5253647be`) closed a second one-Coke tab as Rs 10 deferred and was then fully settled in cash. Without pressing Refresh or hard reloading, both the origin in-app browser and independent Chrome observer changed from `Pending`, paid Rs 0/due Rs 10, to `Issued`, paid Rs 10/no due; the Settle action disappeared in both within the bounded observation window.
- A subsequent hard reload in both browsers reconstructed the same paid/issued row, `Receivables (0)`, and `0` open sessions. The closed tab did not resurrect.
- All four bill issuers, all four payment receivers, both settlement actors, every related bill audit, and every related stock movement resolve to the same authenticated `Vipin` profile (`61cc2f83-69d1-46ab-9d89-9df7f7b1e497`).
- Server durations were `167.788 ms`, `115.464 ms`, `103.244 ms` for the first settlement, `110.882 ms` for replacement, `199.302 ms` for `BILL-20260820-004`, and `335.511 ms` for its settlement. No client timeout or SQLSTATE `57014` occurred.
- `BILL-20260820-004` has exactly one Rs 10 cash payment, one Coke sale movement of `-1`, and a `bill_settled` audit stating Rs 10 collected and zero remaining due. Staging has zero negative inventory rows.
- Compatibility `app_state.version` advanced through the v1 operations to `500`; final SHA-256 is `74392d91ce5052436003fcd033981e40d46d68bf12fa26723b707bdef51a4b6b`, updated at `2026-08-20T04:11:48.582945+00:00` by the same actor.
- Two interrupted browser-dialog attempts to open the void workflow did not commit: database evidence retains `BILL-20260820-001` as issued with `voided_at = null`. The mutation was not retried after the settlement flow supplied the required refresh proof.

Current-deployment downstream reads were repeated after the refresh fix and final hard reload:

- Both browsers showed `Receivables (0)` and today Gross Revenue Rs 32 across three active bills: Session Revenue Rs 2.21 and Consumable Revenue Rs 30. Payment Mix was Rs 32 cash and Rs 0 UPI.
- Customer Profiles loaded all 70 normalized profiles. The controlled rows were `QA Independent Timed 20260820 0921` at 1 visit/Rs 2, `QA Independent Tab 20260820 0923` at 1 visit/Rs 20, and `QA Refresh Settlement 20260820 0939` at 1 visit/Rs 10.
- Inventory Catalog showed Coke current stock `87`. Inventory Report showed Stock Deducted `3`, Net Stock Change `-3`, Currently Reserved `0`, and the exact original sale, replacement difference, and refresh-proof sale movements. Independent Chrome reconstructed the same Coke summary row.
- Exact historical search still loaded `BILL-20260415-003` outside the initial page with its Rs 3.43 timed line, Rs -0.43 round-off, and Rs 3 total.
- Isolated replaced bill `BILL-20260621-003` still resolved `Superseded By BILL-20260621-012`.
- Isolated checkout bill `BILL-20260722-004` still hydrated `Previous Dues Paid Rs 100`, source `BILL-20260625-005`, and the Rs 100 cash/Rs 0 UPI split.

Normalized historical Bill Register and receipt-support checks also passed without a write:

- Direct search loaded April history outside the initial 50-row page: `BILL-20260415-003` rendered its Snooker Star Table line, Rs 3.43 subtotal, `-Rs 0.43` round-off, and Rs 3 total.
- An isolated replaced bill, `BILL-20260621-003`, resolved and displayed `Superseded By BILL-20260621-012` even though the related bill was not part of the search result page.
- An isolated checkout bill, `BILL-20260722-004`, hydrated the cross-bill payment support needed by its receipt and displayed `Previous Dues Paid Rs 100`, source `BILL-20260625-005`, and the Rs 100 cash/zero UPI split.
- These read-only searches and receipt previews did not advance `app_state` beyond version `493` or its checkout timestamp/hash captured below.

The first customer-tab case exposed a real Release A blocker: the tab and bill referenced `customer-ee251663-5e04-4188-9ea8-29afe587aa7b`, while the normalized customer row created at tab-open was `customer-24d8c529-ae9f-4e93-957e-858fb0068817`. Customer Profiles therefore showed the valid Rs 10 bill as zero visits/zero spend. This was retained as failure evidence and not silently rewritten.

After the two-step fix and final redeployment, the exact scenario was repeated with `QA Customer ID Fix 20260820 0219`. Database evidence for `BILL-20260819-004` proves:

- Bill and closed tab both reference `customer-c0673d07-9760-467a-bd11-88b73ac0e1cd`.
- Exactly one customer row exists for that ID and exactly one customer has the test name.
- Exactly one bill, one payment, one financial event, and zero open rows for the test tab exist.
- Bill issuer, payment receiver, bill audit actor, stock-movement actor, and financial-event actor are the same authenticated profile.
- The one related stock movement is a sale of `-1`; staging has zero negative inventory rows.
- Customer Profiles shows one visit and Rs 10 spend with `BILL-20260819-004`, both immediately and after a full hard refresh.
- Compatibility `app_state.version` is `493`, final SHA-256 is `507a92a179f5baf6a6e8c426f29a783f566e76c88e23480731c89a472e4b4a63`, and `updated_at` is the checkout time `2026-08-19T20:50:12.692763+00:00`; later read-only history navigation did not advance it.
- `financial_mutations` and `commit_checkout_bill_v2(jsonb)` remain absent.

The independent reviewer re-read the strengthened identity logic, ran the focused 131-test pair and full 376-test suite, verified the 242-row manifest, and reported no remaining blocker specific to customer identity.

### Write-off, refund, and receipt-export verification

The remaining Bill Register financial-adjustment and export cases were exercised on staging only. Production was not targeted.

- `BILL-20260820-005` (`bill-13fb7748-feac-41fe-94ee-1a5af98fc440`) was issued as a Rs 10 deferred one-Coke customer-tab bill and then written off with reason `Release A independent write-off verification`.
- The canonical bill is `voided` at `2026-08-20T04:40:13.441+00:00`; its `voided_by_user_id`, `bill_voided_bad_debt` audit actor, and `writeOffPendingBills` event actor all resolve to `Vipin` / `vipin` (`61cc2f83-69d1-46ab-9d89-9df7f7b1e497`). The adjustment event completed in `98.236 ms` and advanced compatibility `app_state.version` to `502`.
- The origin Bill Register changed to Voided immediately after confirmation. The independent Chrome observer changed from Pending to Voided without a manual or hard refresh within the bounded observation window; it was proven updated by the final 7.5-second sample. A later hard refresh retained Voided and exposed no obsolete action.
- Write-off is a bad-debt disposition, not a return of a consumed item. The original Coke sale movement remains the only movement for the bill and stock remains deducted once; no reversal was expected or created. Staging retained zero negative inventory rows.
- Database reconciliation found one bill-number row, zero duplicate payment IDs, and zero duplicate event IDs. No payment exists for the deferred write-off.

The native `window.prompt` / `window.confirm` void-refund flow proved unreliable in both controlled browsers. The interrupted attempts did not commit; a read-only database check still showed `BILL-20260820-001` issued, with no void timestamp or refund event. Commit `55da12b` replaced only those native dialogs with the existing controlled modal pattern while leaving the `voidBill` / `refundBill` patch, reversal, audit, and Bill Register refresh logic unchanged. A source-contract test prevents reintroduction of the native-dialog flow.

- The controlled modal was loaded from final staging bundle `index-o2QILXCi.js` and refunded `BILL-20260820-001` with reason `Release A independent refund verification`.
- The origin Bill Register immediately changed to Refunded without a manual refresh. An independently authenticated Chrome load reconstructed the same Refunded row, `Receivables (0)`, and Rs 30 current-day revenue; it reported no browser warning or error.
- Canonical PostgreSQL evidence shows status `refunded`, `voided_at=2026-08-20T04:57:03.937+00:00`, and the exact reason. The issuer, refund actor, `bill_refunded` audit actor, original payment receiver, and adjustment-event actor all resolve to the same authenticated `Vipin` profile.
- The `refundBill` event completed in `166.390 ms`, advanced compatibility `app_state.version` exactly once to `503`, and produced final compatibility SHA-256 `e0420b050f843f4b53bf73895b22e7673ac004a99a2d5dfa6172a28811ce4ff5` at `2026-08-20T04:57:04.47677+00:00`.
- This timed-session bill contained no inventory line, so the correct refund stock result was zero related stock movements. Staging still had zero negative inventory rows. Reconciliation found one bill-number row, zero duplicate payment IDs, and zero duplicate event IDs.

Receipt export was tested with replacement `BILL-20260820-003`:

- The staging UI generated a one-page PDF with the correct bill number, issue time, customer, cash mode, `Replaces BILL-20260820-002`, two Coke lines at Rs 10, and Rs 20 total.
- Visual rendering of the first export exposed that jsPDF's built-in Helvetica font displayed the rupee glyph as an apostrophe-like character. Commit `55da12b` made only PDF-bound currency text font-safe as `Rs `; the on-screen receipt and all numerical models remain unchanged.
- The corrected staging export is 292,211 bytes, one page, 226.77 by 384 points. A 150-DPI render verified the logo, address, bill metadata, replacement link, line, subtotal, discount, round-off, total, and footer with legible `Rs 20.00` / `Rs 10.00` values and no clipping or overlap.
- The final frontend was deployed only to `gp-management-staging-pages`, Cloudflare version `8ebe7ee1-4265-407c-afa7-ce11ec2d597c`. `VITE_BACKEND_FINANCIAL_RPC_V2` remained `false`; the production worker and production database were not targeted.
- Final local gates for this source were 31 test files / 380 tests passed; production and staging builds passed with the existing large-chunk warning; lint exited zero with the same five warnings; `git diff --check` passed.

## Post-functional parity reconciliation

The repository 36-row parity query after the independent financial cases returned four nonzero collection-count rows and zero financial-total or live-summary deltas:

| Collection | `app_state` | Normalized | Delta | Reconciliation |
| --- | ---: | ---: | ---: | --- |
| audit logs | 551 | 576 | +25 | Exactly 25 normalized-only purpose-RPC audit IDs: the prior 23 plus the write-off tab-open and item-add audits. Financial checkout, settlement, replacement, write-off, and refund audits were patched into both stores. |
| customers | 64 | 71 | +7 | Exactly seven normalized QA customers created through purpose-built operational RPCs; the added row is the write-off customer-tab customer. |
| session pause logs | 18 | 19 | +1 | The independent timed session's pause/resume row is normalized-only and survives reload; it is intentionally absent from the stale compatibility snapshot. |
| stock movements | 279 | 283 | +4 | Two controlled Coke reservation/release pairs (`-1`, `+1`); combined net zero. All financial sale/replacement/write-off movements are present in both stores. |

These deltas are explained normalized-only operational history, not missing normalized data. They demonstrate why Release A must not roll reads back to the compatibility snapshot. They do not satisfy the complete Gate 6 by themselves; the remaining verification scripts, second-browser matrix, and soak evidence are still required.

## Current gate decision

Database reconstruction, additive Release A installation, staging frontend deployment, authenticated normalized-read smoke, controlled operational lifecycle checks, representative timed/unit/tab v1 checkout, settlement, replacement, write-off, refund, customer-history correction, actor/stock verification, independent Chrome session/item/reject and financial realtime coverage, Bill Register invalidation correction, receipt PDF export/rendering, historical receipt linkage, analytics, customer-history, inventory-report parity, and hard-refresh non-resurrection checks are complete. The remaining Gate 5 fail-closed/permissions cases, complete Gate 6 capture, performance, and full-business-day soak gates remain open. No production promotion claim is made.

## Remaining gated work

1. Complete permissions and controlled fail-closed read cases.
2. Complete the remaining Gate 6 definitions/grants/indexes/publication/error/duplicate captures and performance probes.
3. Complete the full representative staging business-day soak and independent sign-off.

No production action is authorized by this evidence.
