-- Emergency rollback for the activity feature. It retains every activity row
-- and does not touch any session, bill, payment, inventory, or app_state data.
begin;

drop trigger if exists audit_logs_canonical_identity on public.audit_logs;
drop trigger if exists audit_logs_append_activity on public.audit_logs;
drop trigger if exists zz_audit_logs_preserve_immutable on public.audit_logs;
drop trigger if exists zz_audit_logs_prevent_delete on public.audit_logs;
drop trigger if exists operational_events_canonical_identity on public.operational_events;
drop trigger if exists operational_events_append_activity on public.operational_events;
drop trigger if exists zz_operational_events_prevent_delete on public.operational_events;

revoke execute on function public.list_activity_events(jsonb) from authenticated;

-- Restore the pre-feature direct event capability used by the legacy full-state
-- save publisher. RLS and the server identity trigger state that existed before
-- this feature remain the authority after rollback.
grant insert on table public.operational_events to authenticated;

commit;
