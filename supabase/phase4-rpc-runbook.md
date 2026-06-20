# Phase 4 Operational RPC Runbook

These scripts add normalized write RPCs beside the current `app_state` write path. They do not switch runtime behavior unless `VITE_BACKEND_RPC_OPERATIONAL_WRITES` is enabled in the frontend environment.

Run in staging first.

## Current Script Order

1. Confirm Phase 1 schema/backfill/parity are already complete.
2. Run `supabase/phase4-start-session-rpc.sql`.
3. Keep `VITE_BACKEND_RPC_OPERATIONAL_WRITES` disabled until a deliberate staging smoke test.

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
  and routine_name in ('start_session', 'raise_operational_rpc_error')
order by routine_name;
```

Expected:

- `start_session` exists.
- `start_session` is `DEFINER`.
- `raise_operational_rpc_error` exists.

## Verify Execute Grant

```sql
select
  routine_name,
  grantee,
  privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name = 'start_session'
order by grantee, privilege_type;
```

Expected:

- `authenticated` has `EXECUTE` on `start_session`.

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

## Stop Conditions

Do not enable `VITE_BACKEND_RPC_OPERATIONAL_WRITES` if:

- the script fails
- `start_session` is not installed as a security definer function
- `authenticated` does not have execute permission
- Phase 1 parity checks are not clean

Do not run this directly in production until the staging script install and a staging start-session smoke test have passed.
