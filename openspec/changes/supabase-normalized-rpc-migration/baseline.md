## Production Baseline

Captured from production Supabase `public.app_state` on 2026-06-20.

```json
{
  "app_state_bytes": 2501760,
  "app_state_size": "2443 kB",
  "inventory_categories": 10,
  "stations": 7,
  "pricing_rules": 8,
  "sessions": 773,
  "session_pause_logs": 786,
  "customers": 466,
  "customer_tabs": 760,
  "inventory_items": 147,
  "combos": 6,
  "stock_movements": 3014,
  "bills": 1283,
  "payments": 1161,
  "audit_logs": 7822,
  "expenses": 9,
  "expense_templates": 3,
  "expense_template_overrides": 0,
  "version": 8018,
  "updated_at": "2026-06-20 11:03:13.75771+00"
}
```

## Interpretation

- The full app-state row is approximately 2.44 MB before JSON transport overhead.
- Any full-state save currently writes this large blob.
- Any app-state realtime update can cause subscribed devices to download a similarly large snapshot.
- At 5 simultaneous devices, a single live action can create roughly 2.44 MB of new stored payload movement plus multiple client downloads. If four other devices receive the realtime snapshot, that is about 9.8 MB of Supabase outbound transfer for one action; if the initiating device also receives the realtime event, it is about 12.2 MB.
- The largest growth collections are historical/audit-heavy:
  - `audit_logs`: 7,822
  - `stock_movements`: 3,014
  - `bills`: 1,283
  - `payments`: 1,161
  - `session_pause_logs`: 786
  - `sessions`: 773
  - `customer_tabs`: 760
  - `customers`: 466

## Initial Targets

These are the first measurable targets for the normalized/RPC migration:

- Reduce common live-operation realtime payload from about 2.44 MB to below 25 KB per affected screen update.
- Reduce common live-operation browser request payload from full `AppData` to below 10 KB.
- Keep default screen loads bounded to the last 15 business days plus currently open records.
- Keep older bill/report history searchable through paginated queries rather than loading historical arrays into every client.
- Stop including `audit_logs`, old `stock_movements`, old `bills`, old `payments`, old `sessions`, and closed `customer_tabs` in every routine operational update.

## Priority From Baseline

The first schema/RPC cut should target the highest-frequency live operations and the highest-growth historical arrays:

1. Add normalized historical tables for audit logs, stock movements, bills, payments, sessions, and customer tabs.
2. Add paginated reads for bill register and reports so old rows are not part of the default app load.
3. Move live session/customer-tab operations to RPC so adding items, pausing/resuming, and opening tabs do not save the full blob.
4. Move financial writes only after read parity and operational RPC behavior are stable.
