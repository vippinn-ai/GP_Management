# Activity coverage matrix

| Domain | Entry points | Required actions |
|---|---|---|
| Session lifecycle | `start_session`, `pause_session`, `resume_session`, `save_live_session_details`, `reject_session` | started, paused, resumed, details/timing changed, rejected |
| Session sale | `add_session_item`, `remove_session_item`, `repeat_session_combo` | item added/removed, combo applied/repeated |
| Continuation | `hop_session`, `link_customer_tab_continuation`, `record_session_audit` | hopped, linked, detached/reviewed |
| Customer tab | `open_customer_tab`, `save_live_customer_tab_details`, `add_customer_tab_item`, `update_customer_tab_item_quantity`, `remove_customer_tab_item`, `apply_customer_tab_combo`, `reject_customer_tab` | opened, details changed, item added/quantity changed/removed, combo applied, rejected |
| Checkout | `commit_checkout_bill_v2` and v1 compatibility | issued, deferred, carryover consumed, replacement issued, checkout details changed, discount/LTP applied |
| Adjustments | `commit_financial_adjustment_v2` and v1 compatibility | settled, written off, voided, refunded |
| Inventory/admin | `commit_admin_data_change` | item/category/station/pricing/combo created, updated, archived/restored; stock adjusted; settings changed |
| Expenses | `commit_admin_data_change` | expense/template/override created, changed, removed |
| Users | admin APIs plus admin audit commit | created, updated, activated/deactivated, password reset/change without password value |
| Maintenance | `edit_pause_log`, `delete_pause_log`, `record_session_audit` | pause edited/deleted, maintenance disposition recorded |

Every row receives a static SQL/source contract and at least one transaction or Playwright assertion. Every audit and operational source is retained. The read projection suppresses an audit only when a complete server-authored projection covers that same action; generic operational events cannot hide distinct correlated audit actions.
