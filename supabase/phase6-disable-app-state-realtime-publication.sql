-- Phase 6 follow-up: stop publishing the large app_state row to Supabase realtime.
--
-- Why:
-- - Compact realtime clients subscribe to public.operational_events.
-- - public.app_state is still updated for rollback compatibility, but the row is large.
-- - Keeping app_state in supabase_realtime can still make every app_state update
--   flow through the realtime publication even when new clients no longer need it.
--
-- Safety:
-- - This does not delete or change public.app_state data.
-- - This does not stop app_state reads/writes used for compatibility.
-- - Rollback is re-adding public.app_state to supabase_realtime; see
--   phase6-restore-app-state-realtime-publication.sql.
-- - Run only after all active production browsers have hard refreshed onto the
--   compact realtime build.

do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'app_state'
  ) then
    alter publication supabase_realtime drop table public.app_state;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'operational_events'
  ) then
    alter publication supabase_realtime add table public.operational_events;
  end if;
end
$$;

select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename in ('app_state', 'operational_events')
order by tablename;
