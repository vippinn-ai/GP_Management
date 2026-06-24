-- Phase 6 compact realtime publication.
-- Adds operational_events to Supabase realtime so clients can subscribe to
-- compact event rows instead of the full app_state row.
-- This keeps app_state in the publication for rollback safety.

do $$
begin
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
