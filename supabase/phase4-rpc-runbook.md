# Phase 4 Operational RPC Runbook

These scripts add normalized write RPCs beside the current `app_state` write path. They do not switch runtime behavior unless `VITE_BACKEND_RPC_OPERATIONAL_WRITES` is enabled in the frontend environment.

Run in staging first.

## Current Script Order

1. Confirm Phase 1 schema/backfill/parity are already complete.
2. Run `supabase/phase4-start-session-rpc.sql`.
3. Run `supabase/phase4-pause-resume-session-rpcs.sql`.
4. Run `supabase/phase4-session-item-rpcs.sql`.
5. Run `supabase/phase4-customer-tab-rpcs.sql`.
6. Run `supabase/phase4-combo-rpcs.sql`.
7. Keep `VITE_BACKEND_RPC_OPERATIONAL_WRITES` disabled until a deliberate staging smoke test.

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
    'open_customer_tab',
    'add_customer_tab_item',
    'update_customer_tab_item_quantity',
    'remove_customer_tab_item',
    'repeat_session_combo',
    'apply_customer_tab_combo',
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
- `open_customer_tab` exists.
- `add_customer_tab_item` exists.
- `update_customer_tab_item_quantity` exists.
- `remove_customer_tab_item` exists.
- `repeat_session_combo` exists.
- `apply_customer_tab_combo` exists.
- `resolve_operational_customer` exists.
- `start_session` is `DEFINER`.
- `pause_session` is `DEFINER`.
- `resume_session` is `DEFINER`.
- `add_session_item` is `DEFINER`.
- `remove_session_item` is `DEFINER`.
- `open_customer_tab` is `DEFINER`.
- `add_customer_tab_item` is `DEFINER`.
- `update_customer_tab_item_quantity` is `DEFINER`.
- `remove_customer_tab_item` is `DEFINER`.
- `repeat_session_combo` is `DEFINER`.
- `apply_customer_tab_combo` is `DEFINER`.
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
  has_function_privilege('anon', 'public.open_customer_tab(jsonb)', 'execute') as anon_can_open_customer_tab,
  has_function_privilege('authenticated', 'public.open_customer_tab(jsonb)', 'execute') as authenticated_can_open_customer_tab,
  has_function_privilege('anon', 'public.add_customer_tab_item(jsonb)', 'execute') as anon_can_add_customer_tab_item,
  has_function_privilege('authenticated', 'public.add_customer_tab_item(jsonb)', 'execute') as authenticated_can_add_customer_tab_item,
  has_function_privilege('anon', 'public.update_customer_tab_item_quantity(jsonb)', 'execute') as anon_can_update_customer_tab_item_quantity,
  has_function_privilege('authenticated', 'public.update_customer_tab_item_quantity(jsonb)', 'execute') as authenticated_can_update_customer_tab_item_quantity,
  has_function_privilege('anon', 'public.remove_customer_tab_item(jsonb)', 'execute') as anon_can_remove_customer_tab_item,
  has_function_privilege('authenticated', 'public.remove_customer_tab_item(jsonb)', 'execute') as authenticated_can_remove_customer_tab_item,
  has_function_privilege('anon', 'public.repeat_session_combo(jsonb)', 'execute') as anon_can_repeat_session_combo,
  has_function_privilege('authenticated', 'public.repeat_session_combo(jsonb)', 'execute') as authenticated_can_repeat_session_combo,
  has_function_privilege('anon', 'public.apply_customer_tab_combo(jsonb)', 'execute') as anon_can_apply_customer_tab_combo,
  has_function_privilege('authenticated', 'public.apply_customer_tab_combo(jsonb)', 'execute') as authenticated_can_apply_customer_tab_combo,
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
- `anon_can_open_customer_tab = false`
- `authenticated_can_open_customer_tab = true`
- `anon_can_add_customer_tab_item = false`
- `authenticated_can_add_customer_tab_item = true`
- `anon_can_update_customer_tab_item_quantity = false`
- `authenticated_can_update_customer_tab_item_quantity = true`
- `anon_can_remove_customer_tab_item = false`
- `authenticated_can_remove_customer_tab_item = true`
- `anon_can_repeat_session_combo = false`
- `authenticated_can_repeat_session_combo = true`
- `anon_can_apply_customer_tab_combo = false`
- `authenticated_can_apply_customer_tab_combo = true`
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
    'open_customer_tab',
    'add_customer_tab_item',
    'update_customer_tab_item_quantity',
    'remove_customer_tab_item',
    'repeat_session_combo',
    'apply_customer_tab_combo',
    'resolve_operational_customer'
  )
order by routine_name, grantee, privilege_type;
```

Expected:

- `authenticated` has `EXECUTE` on all listed browser-facing operational RPCs.
- `anon` does not have `EXECUTE` on these RPCs.
- `resolve_operational_customer` is a helper, so neither `anon` nor `authenticated` should have direct `EXECUTE`.
- `postgres` may appear as owner/admin.
- `service_role` may appear in Supabase-managed projects; it is not used by the browser anon key.

## Behavior Covered

The `start_session` RPC:

- validates organization membership through `current_user_has_org_access`
- serializes starts for the same station with a transaction-scoped advisory lock
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

The `open_customer_tab`, `add_customer_tab_item`, `update_customer_tab_item_quantity`, and
`remove_customer_tab_item` RPCs:

- validate organization membership through `current_user_has_org_access`
- serialize matching customer-tab opens with a transaction-scoped advisory lock
- reject duplicate open tabs for the same customer name or phone with `matching_customer_tab_open`
- lock the target customer tab row for item mutations
- reject closed/missing tabs with `customer_tab_not_open`
- reject direct edits/removals for included combo lines with `combo_item_locked`
- validate inventory availability before adding or increasing tab item quantity
- write customer, tab, item, audit, and compact operational event rows atomically
- return compact changed-row ids and event metadata

The `repeat_session_combo` and `apply_customer_tab_combo` RPCs:

- validate organization membership through `current_user_has_org_access`
- lock the target session or customer tab row for the duration of the short transaction
- reject closed/missing live records with `session_not_open` or `customer_tab_not_open`
- preserve combo application snapshots exactly as supplied by the frontend
- validate included inventory availability before adding combo item rows
- write combo application, included item, stock movement where applicable, audit, and compact event rows atomically
- return compact changed-row ids and event metadata

## Stop Conditions

Do not enable `VITE_BACKEND_RPC_OPERATIONAL_WRITES` if:

- the script fails
- any operational RPC is not installed as a security definer function
- `authenticated` does not have execute permission for each operational RPC
- `anon` has execute permission for any operational RPC
- Phase 1 parity checks are not clean

Do not run this directly in production until the staging script install and a staging start-session smoke test have passed.
