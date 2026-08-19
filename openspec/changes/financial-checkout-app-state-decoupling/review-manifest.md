# Review manifest and traceability baseline

## Inventory

- First-party text/configuration files inventoried: 211
- Approximate lines: 58,212
- Excluded from semantic line review: `node_modules`, generated `dist`, coverage/cache output, and binary assets.
- `package-lock.json` is checked for dependency/lock consistency rather than treated as authored business logic.

## High-risk write paths

| Path | Collections/tables | Required disposition |
| --- | --- | --- |
| Checkout orchestration | sessions, tabs, bills, payments, stock, customers, audits | Characterize and route behind v2 flag |
| Financial v1 SQL | normalized financial rows plus global app state | Preserve as disabled fallback |
| Financial adjustments | bills, payments, inventory, stock, audits | Add normalized-only v2 sibling |
| Operational RPCs | sessions, tabs, items, combos, reservations, audits | Confirm normalized inventory authority and lock compatibility |
| Admin RPC | config, catalog, expenses, audits | Must remain purpose-built under normalized bootstrap |

## Read-path matrix

| Consumer | Required normalized source |
| --- | --- |
| Startup/refresh | config, catalog, live rows, recoverable hops, pending/current financial context |
| Dashboard/analytics | payment-date and business-day summary RPCs |
| Bill Register/receipt | paginated history and bill-by-ID details |
| Pending receivables | all pending bill summaries plus bill-by-ID hydration |
| Reports | bounded bill/payment/session/tab/expense queries |
| Inventory | normalized catalog plus bounded/report-summary movement reads |
| Customers | normalized search/history rather than bounded startup arrays |
| Realtime | operational-event changed IDs and by-ID hydration |
| Local fallback | existing hydrated browser `AppData`; unchanged |

## Review completion rule

Before staging, every first-party file must be marked reviewed in the implementation evidence, every `app_state` reference classified as migration, diagnostic, compatibility-only, or forbidden-runtime, and every billing-visible behavior linked to an automated or manual test case.
