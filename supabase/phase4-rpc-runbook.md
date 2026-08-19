# Phase 4 Operational RPC Runbook

These scripts add normalized write RPCs beside the current `app_state` write path. They do not switch runtime behavior unless `VITE_BACKEND_RPC_OPERATIONAL_WRITES` is enabled in the frontend environment.

Run in staging first.

## Current Script Order

1. Confirm Phase 1 schema/backfill/parity are already complete.
2. Run `supabase/phase4-start-session-rpc.sql`.
3. Run the read-only `supabase/phase4-hop-continuation-verification.sql` checks after updating `start_session`.
4. Run `supabase/phase4-pause-resume-session-rpcs.sql`.
5. Run `supabase/phase4-session-item-rpcs.sql`.
6. Run `supabase/phase4-customer-tab-rpcs.sql`.
7. Run `supabase/phase4-combo-rpcs.sql`.
8. Run `supabase/phase4-live-detail-rpcs.sql`.
9. Run `supabase/phase4-reject-rpcs.sql`.
10. Run `supabase/phase4-hop-session-rpc.sql`.
11. Run `supabase/phase4-link-customer-tab-continuation-rpc.sql`.
12. Run `supabase/phase4-fast-app-state-patch-helper.sql` if this environment was already on an older helper or if reject/financial RPCs show statement-timeout errors on production-sized `app_state` arrays.
13. Run `supabase/phase5-financial-checkout-rpc.sql` only when you are ready to test compact issue-bill writes.
14. Run `supabase/phase5-financial-adjustment-rpc.sql` only when you are ready to test compact pending settlement, pending write-off, and issued-bill void/refund writes.
15. Keep `VITE_BACKEND_RPC_OPERATIONAL_WRITES`, `VITE_BACKEND_NORMALIZED_LIVE_READS`, and `VITE_BACKEND_RPC_FINANCIAL_WRITES` disabled until a deliberate staging smoke test.

## Frontend Smoke-Test Flags

Enable both flags together for staging RPC smoke tests:

```text
VITE_BACKEND_RPC_OPERATIONAL_WRITES=true
VITE_BACKEND_NORMALIZED_LIVE_READS=true
```

Do not enable `VITE_BACKEND_RPC_OPERATIONAL_WRITES` by itself. RPC writes create/update normalized live rows, and `VITE_BACKEND_NORMALIZED_LIVE_READS` makes refreshes and other devices read open sessions/customer tabs from those normalized rows while preserving closed history from `app_state`.

For Phase 5 issue-bill testing, enable all three flags together in staging:

```text
VITE_BACKEND_RPC_OPERATIONAL_WRITES=true
VITE_BACKEND_NORMALIZED_LIVE_READS=true
VITE_BACKEND_RPC_FINANCIAL_WRITES=true
```

`VITE_BACKEND_RPC_FINANCIAL_WRITES` accelerates normal session checkout, customer-tab checkout, bill replacement, pending receivable settlement, pending write-off, and issued-bill void/refund after both Phase 5 scripts are installed. Admin, stock-admin, and config changes continue using the existing blocking save path.

## Verify Function Install

Run this after the script:

```sql
select
  routine_schema,
  routine_name,
  security_type,
  data_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'start_session',
    'pause_session',
    'resume_session',
    'add_session_item',
    'remove_session_item',
    'hop_session',
    'reject_session',
    'open_customer_tab',
    'link_customer_tab_continuation',
    'add_customer_tab_item',
    'update_customer_tab_item_quantity',
    'remove_customer_tab_item',
    'reject_customer_tab',
    'repeat_session_combo',
    'apply_customer_tab_combo',
    'save_live_session_details',
    'save_live_customer_tab_details',
    'commit_checkout_bill',
    'commit_financial_adjustment',
    'patch_app_state_array_by_id',
    'resolve_operational_customer',
    'raise_operational_rpc_error'
  )
order by routine_name;
```

Expected:

- `start_session` exists.
- `pause_session` exists.
- `resume_session` exists.
- `add_session_item` exists.
- `remove_session_item` exists.
- `hop_session` exists.
- `reject_session` exists.
- `open_customer_tab` exists.
- `link_customer_tab_continuation` exists.
- `add_customer_tab_item` exists.
- `update_customer_tab_item_quantity` exists.
- `remove_customer_tab_item` exists.
- `reject_customer_tab` exists.
- `repeat_session_combo` exists.
- `apply_customer_tab_combo` exists.
- `save_live_session_details` exists.
- `save_live_customer_tab_details` exists.
- `commit_checkout_bill` exists.
- `commit_financial_adjustment` exists.
- `patch_app_state_array_by_id` exists.
- `resolve_operational_customer` exists.
- `start_session` is `DEFINER`.
- `pause_session` is `DEFINER`.
- `resume_session` is `DEFINER`.
- `add_session_item` is `DEFINER`.
- `remove_session_item` is `DEFINER`.
- `hop_session` is `DEFINER`.
- `reject_session` is `DEFINER`.
- `open_customer_tab` is `DEFINER`.
- `link_customer_tab_continuation` is `DEFINER`.
- `add_customer_tab_item` is `DEFINER`.
- `update_customer_tab_item_quantity` is `DEFINER`.
- `remove_customer_tab_item` is `DEFINER`.
- `reject_customer_tab` is `DEFINER`.
- `repeat_session_combo` is `DEFINER`.
- `apply_customer_tab_combo` is `DEFINER`.
- `save_live_session_details` is `DEFINER`.
- `save_live_customer_tab_details` is `DEFINER`.
- `commit_checkout_bill` is `DEFINER`.
- `commit_financial_adjustment` is `DEFINER`.
- `raise_operational_rpc_error` exists.

## Verify Execute Grant

Use this boolean check first:

```sql
select
  has_function_privilege('anon', 'public.start_session(jsonb)', 'execute') as anon_can_execute,
  has_function_privilege('authenticated', 'public.start_session(jsonb)', 'execute') as authenticated_can_execute,
  has_function_privilege('anon', 'public.pause_session(jsonb)', 'execute') as anon_can_pause,
  has_function_privilege('authenticated', 'public.pause_session(jsonb)', 'execute') as authenticated_can_pause,
  has_function_privilege('anon', 'public.resume_session(jsonb)', 'execute') as anon_can_resume,
  has_function_privilege('authenticated', 'public.resume_session(jsonb)', 'execute') as authenticated_can_resume,
  has_function_privilege('anon', 'public.add_session_item(jsonb)', 'execute') as anon_can_add_session_item,
  has_function_privilege('authenticated', 'public.add_session_item(jsonb)', 'execute') as authenticated_can_add_session_item,
  has_function_privilege('anon', 'public.remove_session_item(jsonb)', 'execute') as anon_can_remove_session_item,
  has_function_privilege('authenticated', 'public.remove_session_item(jsonb)', 'execute') as authenticated_can_remove_session_item,
  has_function_privilege('anon', 'public.hop_session(jsonb)', 'execute') as anon_can_hop_session,
  has_function_privilege('authenticated', 'public.hop_session(jsonb)', 'execute') as authenticated_can_hop_session,
  has_function_privilege('anon', 'public.reject_session(jsonb)', 'execute') as anon_can_reject_session,
  has_function_privilege('authenticated', 'public.reject_session(jsonb)', 'execute') as authenticated_can_reject_session,
  has_function_privilege('anon', 'public.open_customer_tab(jsonb)', 'execute') as anon_can_open_customer_tab,
  has_function_privilege('authenticated', 'public.open_customer_tab(jsonb)', 'execute') as authenticated_can_open_customer_tab,
  has_function_privilege('anon', 'public.link_customer_tab_continuation(jsonb)', 'execute') as anon_can_link_customer_tab_continuation,
  has_function_privilege('authenticated', 'public.link_customer_tab_continuation(jsonb)', 'execute') as authenticated_can_link_customer_tab_continuation,
  has_function_privilege('anon', 'public.add_customer_tab_item(jsonb)', 'execute') as anon_can_add_customer_tab_item,
  has_function_privilege('authenticated', 'public.add_customer_tab_item(jsonb)', 'execute') as authenticated_can_add_customer_tab_item,
  has_function_privilege('anon', 'public.update_customer_tab_item_quantity(jsonb)', 'execute') as anon_can_update_customer_tab_item_quantity,
  has_function_privilege('authenticated', 'public.update_customer_tab_item_quantity(jsonb)', 'execute') as authenticated_can_update_customer_tab_item_quantity,
  has_function_privilege('anon', 'public.remove_customer_tab_item(jsonb)', 'execute') as anon_can_remove_customer_tab_item,
  has_function_privilege('authenticated', 'public.remove_customer_tab_item(jsonb)', 'execute') as authenticated_can_remove_customer_tab_item,
  has_function_privilege('anon', 'public.reject_customer_tab(jsonb)', 'execute') as anon_can_reject_customer_tab,
  has_function_privilege('authenticated', 'public.reject_customer_tab(jsonb)', 'execute') as authenticated_can_reject_customer_tab,
  has_function_privilege('anon', 'public.repeat_session_combo(jsonb)', 'execute') as anon_can_repeat_session_combo,
  has_function_privilege('authenticated', 'public.repeat_session_combo(jsonb)', 'execute') as authenticated_can_repeat_session_combo,
  has_function_privilege('anon', 'public.apply_customer_tab_combo(jsonb)', 'execute') as anon_can_apply_customer_tab_combo,
  has_function_privilege('authenticated', 'public.apply_customer_tab_combo(jsonb)', 'execute') as authenticated_can_apply_customer_tab_combo,
  has_function_privilege('anon', 'public.save_live_session_details(jsonb)', 'execute') as anon_can_save_live_session_details,
  has_function_privilege('authenticated', 'public.save_live_session_details(jsonb)', 'execute') as authenticated_can_save_live_session_details,
  has_function_privilege('anon', 'public.save_live_customer_tab_details(jsonb)', 'execute') as anon_can_save_live_customer_tab_details,
  has_function_privilege('authenticated', 'public.save_live_customer_tab_details(jsonb)', 'execute') as authenticated_can_save_live_customer_tab_details,
  has_function_privilege('anon', 'public.commit_checkout_bill(jsonb)', 'execute') as anon_can_commit_checkout_bill,
  has_function_privilege('authenticated', 'public.commit_checkout_bill(jsonb)', 'execute') as authenticated_can_commit_checkout_bill,
  has_function_privilege('anon', 'public.commit_financial_adjustment(jsonb)', 'execute') as anon_can_commit_financial_adjustment,
  has_function_privilege('authenticated', 'public.commit_financial_adjustment(jsonb)', 'execute') as authenticated_can_commit_financial_adjustment,
  has_function_privilege('anon', 'public.patch_app_state_array_by_id(jsonb, jsonb)', 'execute') as anon_can_patch_app_state_array_by_id,
  has_function_privilege('authenticated', 'public.patch_app_state_array_by_id(jsonb, jsonb)', 'execute') as authenticated_can_patch_app_state_array_by_id,
  has_function_privilege('anon', 'public.resolve_operational_customer(text, jsonb)', 'execute') as anon_can_resolve_operational_customer,
  has_function_privilege('authenticated', 'public.resolve_operational_customer(text, jsonb)', 'execute') as authenticated_can_resolve_operational_customer;
```

Expected:

- `anon_can_execute = false`
- `authenticated_can_execute = true`
- `anon_can_pause = false`
- `authenticated_can_pause = true`
- `anon_can_resume = false`
- `authenticated_can_resume = true`
- `anon_can_add_session_item = false`
- `authenticated_can_add_session_item = true`
- `anon_can_remove_session_item = false`
- `authenticated_can_remove_session_item = true`
- `anon_can_hop_session = false`
- `authenticated_can_hop_session = true`
- `anon_can_reject_session = false`
- `authenticated_can_reject_session = true`
- `anon_can_open_customer_tab = false`
- `authenticated_can_open_customer_tab = true`
- `anon_can_link_customer_tab_continuation = false`
- `authenticated_can_link_customer_tab_continuation = true`
- `anon_can_add_customer_tab_item = false`
- `authenticated_can_add_customer_tab_item = true`
- `anon_can_update_customer_tab_item_quantity = false`
- `authenticated_can_update_customer_tab_item_quantity = true`
- `anon_can_remove_customer_tab_item = false`
- `authenticated_can_remove_customer_tab_item = true`
- `anon_can_reject_customer_tab = false`
- `authenticated_can_reject_customer_tab = true`
- `anon_can_repeat_session_combo = false`
- `authenticated_can_repeat_session_combo = true`
- `anon_can_apply_customer_tab_combo = false`
- `authenticated_can_apply_customer_tab_combo = true`
- `anon_can_save_live_session_details = false`
- `authenticated_can_save_live_session_details = true`
- `anon_can_save_live_customer_tab_details = false`
- `authenticated_can_save_live_customer_tab_details = true`
- `anon_can_commit_checkout_bill = false`
- `authenticated_can_commit_checkout_bill = true`
- `anon_can_commit_financial_adjustment = false`
- `authenticated_can_commit_financial_adjustment = true`
- `anon_can_patch_app_state_array_by_id = false`
- `authenticated_can_patch_app_state_array_by_id = false`
- `anon_can_resolve_operational_customer = false`
- `authenticated_can_resolve_operational_customer = false`

This detailed grant query is useful when the boolean check does not match expectations:

```sql
select
  routine_name,
  grantee,
  privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'start_session',
    'pause_session',
    'resume_session',
    'add_session_item',
    'remove_session_item',
    'hop_session',
    'reject_session',
    'open_customer_tab',
    'link_customer_tab_continuation',
    'add_customer_tab_item',
    'update_customer_tab_item_quantity',
    'remove_customer_tab_item',
    'reject_customer_tab',
    'repeat_session_combo',
    'apply_customer_tab_combo',
    'save_live_session_details',
    'save_live_customer_tab_details',
    'commit_checkout_bill',
    'commit_financial_adjustment',
    'patch_app_state_array_by_id',
    'resolve_operational_customer'
  )
order by routine_name, grantee, privilege_type;
```

Expected:

- `authenticated` has `EXECUTE` on all listed browser-facing operational RPCs.
- `anon` does not have `EXECUTE` on these RPCs.
- `commit_checkout_bill` is browser-facing for Phase 5, so `authenticated` should have direct `EXECUTE`.
- `commit_financial_adjustment` is browser-facing for Phase 5, so `authenticated` should have direct `EXECUTE`.
- `resolve_operational_customer` and `patch_app_state_array_by_id` are helpers, so neither `anon` nor `authenticated` should have direct `EXECUTE`.
- `postgres` may appear as owner/admin.
- `service_role` may appear in Supabase-managed projects; it is not used by the browser anon key.

## Behavior Covered

The `start_session` RPC:

- validates organization membership through `current_user_has_org_access`
- serializes starts for the same station with a transaction-scoped advisory lock
- locks every referenced hopped source and rejects unavailable, billed, or already-consumed continuations
- serializes competing game and consumables continuations so one hopped source cannot branch into two live consumers
- requires the next session to retain the hopped source customer identity, falling back from customer id to normalized phone and then normalized name
- rejects inactive/missing stations with `station_unavailable`
- rejects already occupied stations with `station_occupied`
- validates required stock against current stock minus open session and customer-tab reservations
- rejects unavailable stock with `insufficient_stock`
- resolves matching customers by normalized phone first, then normalized name when no phone exists
- inserts session, session item, combo application, stock movement, audit, and operational event rows in one transaction
- returns compact changed-row ids and event metadata
- returns idempotently if the same session was already written

The `pause_session` and `resume_session` RPCs:

- validate organization membership through `current_user_has_org_access`
- lock the target session row for the duration of the short transaction
- reject closed/missing sessions with `session_not_open`
- reject invalid pause/resume state transitions with stable domain error codes
- write session status, pause log, audit, and compact operational event rows atomically
- return compact changed-row ids and event metadata

The `add_session_item` and `remove_session_item` RPCs:

- validate organization membership through `current_user_has_org_access`
- lock the target session row for the duration of the short transaction
- reject closed/missing sessions with `session_not_open`
- validate inventory availability before adding a new reserved item
- write session item, reservation/release stock movement, audit, and compact operational event rows atomically
- return compact changed-row ids and event metadata

The `open_customer_tab`, `link_customer_tab_continuation`, `add_customer_tab_item`, `update_customer_tab_item_quantity`, and
`remove_customer_tab_item` RPCs:

- validate organization membership through `current_user_has_org_access`
- serialize matching customer-tab opens with a transaction-scoped advisory lock
- reject duplicate open tabs for the same customer name or phone with `matching_customer_tab_open`
- link hopped sessions into an existing open customer tab without duplicating `continuedFromSessionIds`
- reject closed/missing tabs or already billed hopped sessions before linking
- lock the target customer tab row for item mutations
- reject closed/missing tabs with `customer_tab_not_open`
- reject direct edits/removals for included combo lines with `combo_item_locked`
- validate inventory availability before adding or increasing tab item quantity
- write customer, tab, item, audit, and compact operational event rows atomically
- return compact changed-row ids and event metadata

The `reject_session` and `reject_customer_tab` RPCs:

- validate organization membership through `current_user_has_org_access`
- lock the target live session or customer tab plus the compatibility `app_state` row for a short transaction
- reject closed/missing live records with `session_not_open` or `customer_tab_not_open`
- update the normalized live row to closed/rejected
- patch only the affected legacy `sessions` or `customerTabs`, optional `sessionPauseLogs`, and `auditLogs` arrays in `app_state`
- increment and return the next `app_state.version` so later compatibility writes do not retry against a stale version
- avoid the old full app-state upload path for rejected sessions/tabs
- require the set-based `patch_app_state_array_by_id` helper from `phase4-fast-app-state-patch-helper.sql` on large production datasets to avoid statement-timeout errors while patching arrays such as `auditLogs`

The `repeat_session_combo` and `apply_customer_tab_combo` RPCs:

- validate organization membership through `current_user_has_org_access`
- lock the target session or customer tab row for the duration of the short transaction
- reject closed/missing live records with `session_not_open` or `customer_tab_not_open`
- preserve combo application snapshots exactly as supplied by the frontend
- validate included inventory availability before adding combo item rows
- write combo application, included item, stock movement where applicable, audit, and compact event rows atomically
- return compact changed-row ids and event metadata

The `save_live_session_details` and `save_live_customer_tab_details` RPCs:

- validate organization membership through `current_user_has_org_access`
- lock the target live session or customer tab row for the duration of the short transaction
- reject closed/missing live records with `session_not_open` or `customer_tab_not_open`
- resolve or clear the linked customer snapshot from the supplied payload
- update only live detail fields and optional audit rows
- return compact changed-row ids and event metadata

The `commit_checkout_bill` RPC:

- validates organization membership through `current_user_has_org_access`
- locks the target session or customer tab row for the checkout transaction
- keeps `app_state` compatibility by patching only changed arrays instead of accepting a full app-state upload
- writes bill, bill lines, discounts, payments, stock movements, audit logs, customer, inventory stock, and closed session/tab rows atomically
- rejects stale checkouts when the expected `app_state.version` has already changed
- returns the next `app_state.version` so the browser can continue without a full save retry

The `commit_financial_adjustment` RPC:

- validates organization membership through `current_user_has_org_access`
- supports pending receivable settlement, pending write-off, and issued-bill void/refund
- locks only the affected bill rows and the single compatibility `app_state` row for the short transaction
- validates the current bill status before applying the supplied compact patch
- keeps `app_state` compatibility by patching only changed inventory, bill, payment, stock movement, and audit arrays
- rejects stale writes when the expected `app_state.version` has already changed
- returns the next `app_state.version` and database-side timing for staging verification

## Checkout Timing Checks

After rerunning `phase5-financial-checkout-rpc.sql`, new checkout events include database-side
duration in milliseconds. Use this in staging after issuing a test bill:

```sql
select
  created_at,
  entity_type,
  entity_id,
  metadata->>'bill_number' as bill_number,
  (metadata->>'server_duration_ms')::numeric as server_duration_ms,
  (metadata->>'app_state_version')::integer as app_state_version,
  jsonb_array_length(coalesce(metadata #> '{changed_rows,bills}', '[]'::jsonb)) as bill_rows,
  jsonb_array_length(coalesce(metadata #> '{changed_rows,payments}', '[]'::jsonb)) as payment_rows,
  jsonb_array_length(coalesce(metadata #> '{changed_rows,stock_movements}', '[]'::jsonb)) as stock_rows,
  jsonb_array_length(coalesce(metadata #> '{changed_rows,audit_logs}', '[]'::jsonb)) as audit_rows
from public.operational_events
where event_type = 'financial_checkout_committed'
order by created_at desc
limit 10;
```

In the staging browser console, use this after issuing a bill:

```js
window.__GP_CHECKOUT_TELEMETRY__?.getSamples?.().slice(0, 10)
```

Expected simple session/customer-tab checkout timing shape:

- `precheck_snapshot` has `skippedFullSnapshot: true` and `durationMs: 0`.
- `financial_rpc` shows the compact RPC network duration and `serverDurationMs` when the updated SQL is installed.
- `checkout_total` should be close to the RPC duration plus receipt generation time.

Replacement checkout should also show `skippedFullSnapshot: true` after the updated `phase5-financial-checkout-rpc.sql` is installed. Pending-settlement checkout and hopped-session combined checkout still keep the full remote precheck until their wider server-side validations are implemented.

## Financial Adjustment Timing Checks

After running `phase5-financial-adjustment-rpc.sql`, new financial adjustment events include database-side
duration in milliseconds. Use this in staging after settling, writing off, voiding, or refunding a test bill:

```sql
select
  created_at,
  entity_type,
  entity_id,
  metadata->>'mutation_kind' as mutation_kind,
  (metadata->>'server_duration_ms')::numeric as server_duration_ms,
  (metadata->>'app_state_version')::integer as app_state_version,
  jsonb_array_length(coalesce(metadata #> '{changed_rows,bills}', '[]'::jsonb)) as bill_rows,
  jsonb_array_length(coalesce(metadata #> '{changed_rows,payments}', '[]'::jsonb)) as payment_rows,
  jsonb_array_length(coalesce(metadata #> '{changed_rows,stock_movements}', '[]'::jsonb)) as stock_rows,
  jsonb_array_length(coalesce(metadata #> '{changed_rows,audit_logs}', '[]'::jsonb)) as audit_rows,
  jsonb_array_length(coalesce(metadata #> '{changed_rows,inventory_items}', '[]'::jsonb)) as inventory_rows
from public.operational_events
where event_type = 'financial_adjustment_committed'
order by created_at desc
limit 10;
```

## Stop Conditions

Do not enable `VITE_BACKEND_RPC_OPERATIONAL_WRITES`, `VITE_BACKEND_NORMALIZED_LIVE_READS`, or `VITE_BACKEND_RPC_FINANCIAL_WRITES` if:

- the script fails
- any operational RPC is not installed as a security definer function
- `commit_checkout_bill` is not installed as a security definer function
- `commit_financial_adjustment` is not installed as a security definer function after installing the adjustment script
- `authenticated` does not have execute permission for each operational RPC
- `authenticated` does not have execute permission for `commit_checkout_bill`
- `authenticated` does not have execute permission for `commit_financial_adjustment` after installing the adjustment script
- `anon` has execute permission for any operational RPC
- `anon` has execute permission for `commit_checkout_bill`, `commit_financial_adjustment`, or `patch_app_state_array_by_id`
- Phase 1 parity checks are not clean

Do not run this directly in production until the staging script install and a staging smoke test with all enabled frontend flags has passed.
