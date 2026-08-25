# Review manifest and traceability baseline

## Reproducible inventory

Run `node scripts/generate-checkout-review-manifest.mjs` from the repository root. It enumerates tracked and unignored first-party text/configuration files, reads every physical line, validates JSON syntax, records SHA-256, and emits `review-manifest-files.csv`.

The generated CSV is the per-file evidence. Its columns record path, physical line count, content hash, review status/method, billing relevance, inferred data collections, RPCs called or defined, `app_state` disposition, and direct test evidence.

Current generated snapshot:

- First-party text/configuration files: 291.
- Physical lines mechanically screened: 81,942.
- Semantic billing/data-gateway/compatibility hotspots: 228.
- Files with billing/financial vocabulary: 209.
- Files containing an `app_state`, `appState`, or base-version reference: 94; none remain in the unclassified bucket.
- Excluded: generated `dist`, dependencies, coverage/cache/test artifacts, `.git`, binary assets, this narrative file, and the generated CSV itself.
- `package-lock.json` is parsed as JSON, hashed, and marked as a mechanical lockfile-integrity screen rather than authored business logic.

“Reviewed” in the CSV means every file was included in the reproducible full-text risk screen. `semantic-hotspot-plus-mechanical-screen` additionally means the file was traced through the billing/data flow and its relevant consumers or SQL trust boundary. It does not claim that prose and low-risk styling received the same semantic depth as checkout SQL.

## `app_state` disposition

| Disposition | Current count | Release meaning |
| --- | ---: | --- |
| Documentation or test reference | 42 | Evidence, characterization, or explicitly documented legacy behavior. |
| Runtime legacy compatibility boundary | 14 | Gated v1/local contracts retained for rollback; normalized mode cannot use them as a financial read fallback. |
| Migration, diagnostic, or reconstruction | 17 | Offline parity/backfill/evidence tooling; not a v2 runtime dependency. |
| Legacy-v1 purpose writer | 8 | Existing v1 operational/financial/admin behavior retained while v2 is off. |
| Schema or realtime compatibility | 7 | Table/publication definitions or explicit rollback scripts. |
| Normalized source with explicit no-app-state access | 2 | Read/index SQL whose comments and implementation prohibit the legacy row. |
| Legacy maintenance script | 2 | Operator-only scripts; never invoked by normalized runtime. |
| Review-tool classifier | 1 | The manifest generator’s own reference detector. |
| V2 prohibition and client-field rejection | 1 | Financial v2 SQL explicitly rejects legacy version fields and contains no `app_state` access. |

`architect.md` now distinguishes the historical single-row design from normalized persistence and records `profiles.tab_permissions` as the backend permission source.

## Source-of-truth and consumer traceability

| Collection/capability | Startup/refresh | Purpose writes | Realtime/hydration | Downstream consumers | Evidence |
| --- | --- | --- | --- | --- | --- |
| Profiles and permissions | `profiles`, normalized organization membership | Authenticated edge admin APIs; `profiles.tab_permissions` | Profile refresh/sign-in | Navigation and write authorization | Backend/useAppSync tests; Release A staging permission persistence/restoration passed |
| Business/config/stations/pricing | Normalized bootstrap | Admin data RPC | Compact event/by-ID or targeted bootstrap refresh | Sale, settings, receipts, timing | Data-gateway/admin patch tests |
| Sessions and pause logs | Open plus recoverable unbilled hopped sessions | Operational RPCs, including phase-11 pause edit/delete | Changed session IDs replace that session’s complete pause-log set | Sale, carryovers, checkout pricing, dashboard | Operational sync and normalized overlay tests |
| Customer tabs/items | Open tabs and item snapshots | Operational customer-tab RPCs | Changed tab/item IDs | Sale, continuation, checkout | Operational RPC tests and two-browser staging contract |
| Customers | Complete paginated directory | Purpose financial/admin customer updates | Changed customer IDs merge by ID | Search, autocomplete, customer analytics/history | Customer search/history tests; fail-closed UI tests |
| Inventory/catalog/variants/combos | Complete current normalized catalog and stock | Purpose operational/admin/financial RPCs; normalized inventory is authoritative | Changed inventory/movement IDs merge by ID | Sale validation, checkout, inventory reports | Gateway, SQL contract, inventory report tests |
| Bills and payments | Current business day plus all pending and today’s payments against older bills | v1 financial RPC in Release A; additive v2 remains disabled | Changed IDs and targeted deltas | Bill Register, receipts, receivables, dashboard | Bootstrap cap/fail-closed, Bill Register, report tests |
| Historical Bill Register | Cursor-paginated normalized reader | Authorized adjustment RPCs | Each loaded page hydrates full bill/payment rows into the action state by ID | Search, receipt, settlement, replacement, void/refund | Overlay preservation test and staging action matrix |
| Reports and analytics | Normalized detail readers plus summary RPC | Read-only | Explicit retry/refetch | Dashboard, reports, exports | Report read-state and analytics tests |
| Customer visit history | Exhaustive normalized bill/payment pages plus linked session/tab activity | Read-only | Explicit retry/refetch | Visit count/time/day/station analytics | `buildNormalizedCustomerBillVisitAt` characterization |
| Expenses/templates/overrides | Normalized admin/report readers | Admin data RPC | Targeted refresh | Reports and settings | Admin patch/report tests |
| Audits, movements, events | Bounded recent operational context; exhaustive screen-specific readers | Purpose RPCs stamp authenticated actor | Changed IDs merge by ID | Forensics, inventory history, monitoring | Overlay tests, SQL contract, staging actor checks |
| Local-browser mode | Hydrated local `AppData` | Existing local persistence | Same-browser state | All existing local screens | Preserved feature-flag path and local tests |

## High-risk write-path disposition

| Path | Collections/tables | Release A disposition |
| --- | --- | --- |
| Checkout orchestration | sessions, tabs, bills, payments, stock, customers, audits | Existing v1 RPC remains enabled; financial v2 stays off. |
| Financial v1 SQL | normalized financial rows plus global compatibility state | Preserved as the latency rollback/Release A path. |
| Financial adjustments | bills, payments, inventory, stock, audits | Existing v1 path remains; additive v2 is not installed by the Release A runbook. |
| Operational RPCs | sessions, tabs, items, combos, reservations, audits | Purpose-built writes required; normalized inventory helper is authoritative. |
| Admin/profile APIs | config, catalog, expenses, audits, permissions | Purpose-built RPC/edge APIs only; generic normalized full-state save remains blocked. |

## Completion rule

The local manifest and traceability review is complete when the generator reports no `reviewed-other-reference`, local tests/build/lint/diff checks pass, and the CSV is regenerated after the final source change. Environment verification is separate: Release A cannot be promoted until the staging runbook has captured definitions/grants/indexes/parity, two-browser cases, normalized failure behavior, and a full-business-day v1 soak.
