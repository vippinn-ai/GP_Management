## Staging Phase 1 Validation

Captured from staging after running:

1. `supabase/phase1-normalized-schema.sql`
2. `supabase/phase1-backfill-from-app-state.sql`
3. `supabase/phase1-parity-checks-single-result.sql`

## Result

All parity checks returned `delta = 0`.

## Collection Counts

| Metric | App Value | Normalized Value | Delta |
| --- | ---: | ---: | ---: |
| audit_logs | 344 | 344 | 0 |
| bill_discounts | 9 | 9 | 0 |
| bill_line_discounts | 3 | 3 | 0 |
| bill_lines | 133 | 133 | 0 |
| bills | 56 | 56 | 0 |
| combo_choice_groups | 1 | 1 | 0 |
| combo_choice_options | 8 | 8 | 0 |
| combo_fixed_items | 5 | 5 | 0 |
| combo_station_targets | 1 | 1 | 0 |
| combos | 2 | 2 | 0 |
| customer_tab_combo_applications | 1 | 1 | 0 |
| customer_tab_items | 40 | 40 | 0 |
| customer_tabs | 23 | 23 | 0 |
| customers | 41 | 41 | 0 |
| expense_template_overrides | 0 | 0 | 0 |
| expense_templates | 2 | 2 | 0 |
| expenses | 3 | 3 | 0 |
| inventory_categories | 8 | 8 | 0 |
| inventory_items | 25 | 25 | 0 |
| payments | 58 | 58 | 0 |
| pricing_rules | 8 | 8 | 0 |
| sale_variants | 6 | 6 | 0 |
| session_combo_applications | 3 | 3 | 0 |
| session_items | 79 | 79 | 0 |
| session_pause_logs | 11 | 11 | 0 |
| sessions | 57 | 57 | 0 |
| stations | 7 | 7 | 0 |
| stock_movements | 103 | 103 | 0 |

## Totals

| Metric | App Value | Normalized Value | Delta |
| --- | ---: | ---: | ---: |
| bill_amount_due | 1330 | 1330.00 | 0.00 |
| bill_amount_paid | 160955 | 160955.00 | 0.00 |
| bill_total | 162285 | 162285.00 | 0.00 |
| payment_amount | 160955 | 160955.00 | 0.00 |
| stock_quantity | 999837 | 999837.000 | 0.000 |

## Live Summary

| Metric | App Value | Normalized Value | Delta |
| --- | ---: | ---: | ---: |
| open_customer_tabs | 1 | 1 | 0 |
| open_sessions | 0 | 0 | 0 |
| pending_bills | 2 | 2 | 0 |

## Conclusion

Staging shadow-schema creation, backfill, and parity checks are clean. This validates Phase 1 staging data copy but does not cut the application over to normalized reads or writes.
