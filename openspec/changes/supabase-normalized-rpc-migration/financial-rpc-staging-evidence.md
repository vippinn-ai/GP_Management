# Phase 5 Financial RPC Staging Evidence

## Purpose

Track staging-only evidence for compact financial RPC writes before any production rollout.

## Current Staging Status

- `commit_checkout_bill` is installed and used by session/customer-tab checkout when `VITE_BACKEND_RPC_FINANCIAL_WRITES=true`.
- `commit_financial_adjustment` is installed and used by pending settlement, pending write-off, and issued-bill void/refund when `VITE_BACKEND_RPC_FINANCIAL_WRITES=true`.
- Replacement bills use `commit_checkout_bill` with `mode = bill_replacement` and `entity_type = bill`.
- `app_state` compatibility remains active; RPCs patch changed arrays and increment `app_state.version`.

## Staging Timing Evidence

| Date | Event | Entity Type | Server Duration | App State Version | Notes |
| --- | --- | --- | ---: | ---: | --- |
| 2026-06-20 | `writeOffPendingBills` | `bill` | 129.702 ms | 392 | Confirmed `financial_adjustment_committed` event in staging |
| 2026-06-20 | `settlePendingBills` | `bill` | 151.483 ms | 391 | Confirmed `financial_adjustment_committed` event in staging |
| 2026-06-20 | `voidBill` | `bill` | 147.612 ms | 387 | Confirmed `financial_adjustment_committed` event after staging flag correction |
| 2026-06-20 | `refundBill` | `bill` | 189.443 ms | 386 | Confirmed `financial_adjustment_committed` event after staging flag correction |
| 2026-06-21 | `commitCheckoutBill` replacement | `bill` | 271.596 ms | 412 | Confirmed `financial_checkout_committed`; browser telemetry skipped full snapshot and sent 4,431-byte payload |

## Remaining Staging Evidence Needed

- Manual smoke by admin, manager, and receptionist.
- Multi-browser conflict smoke where practical.
