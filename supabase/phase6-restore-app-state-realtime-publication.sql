-- Phase 6 rollback: restore full app_state realtime publication.
--
-- Use only if compact realtime must be rolled back to the previous full
-- app_state realtime behavior.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'app_state'
  ) then
    alter publication supabase_realtime add table public.app_state;
  end if;
end
$$;

select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename in ('app_state', 'operational_events')
order by tablename;
