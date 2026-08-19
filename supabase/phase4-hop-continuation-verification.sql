-- Phase 4 game-hop continuation verification.
-- Read-only: safe to run after phase4-start-session-rpc.sql.

select
  'start_session_contract' as check_group,
  'continuation_source_guard' as metric,
  case
    when pg_get_functiondef('public.start_session(jsonb)'::regprocedure)
      like '%hopped_session_unavailable%'
     and pg_get_functiondef('public.start_session(jsonb)'::regprocedure)
      like '%sessions.status <> ''closed''%'
     and pg_get_functiondef('public.start_session(jsonb)'::regprocedure)
      like '%sessions.close_disposition <> ''hopped''%'
     and pg_get_functiondef('public.start_session(jsonb)'::regprocedure)
      like '%sessions.closed_bill_id is not null%'
     and pg_get_functiondef('public.start_session(jsonb)'::regprocedure)
      like '%hopped_session_customer_mismatch%'
     and pg_get_functiondef('public.start_session(jsonb)'::regprocedure)
      like '%hopped_session_already_continued%'
     and pg_get_functiondef('public.link_customer_tab_continuation(jsonb)'::regprocedure)
      like '%hopped_session_already_continued%'
    then 'pass'
    else 'fail'
  end as status;

select
  'function_grant' as check_group,
  'start_session' as metric,
  jsonb_build_object(
    'anon_can_execute',
    has_function_privilege('anon', 'public.start_session(jsonb)', 'execute'),
    'authenticated_can_execute',
    has_function_privilege('authenticated', 'public.start_session(jsonb)', 'execute')
  )::text as value,
  case
    when not has_function_privilege('anon', 'public.start_session(jsonb)', 'execute')
     and has_function_privilege('authenticated', 'public.start_session(jsonb)', 'execute')
    then 'pass'
    else 'fail'
  end as status;

with continuation_links as (
  select
    child.organization_id,
    child.id as child_session_id,
    child.closed_bill_id as child_closed_bill_id,
    source_id.value as source_session_id
  from public.sessions child
  cross join lateral jsonb_array_elements_text(
    case
      when jsonb_typeof(coalesce(child.continued_from_session_ids, '[]'::jsonb)) = 'array'
        then coalesce(child.continued_from_session_ids, '[]'::jsonb)
      else '[]'::jsonb
    end
  ) source_id(value)
)
select
  'continuation_integrity' as check_group,
  count(*)::text as invalid_link_count,
  case when count(*) = 0 then 'pass' else 'investigate' end as status
from continuation_links links
left join public.sessions source
  on source.organization_id = links.organization_id
  and source.id = links.source_session_id
where source.id is null
   or (
     links.child_closed_bill_id is null
     and (
       source.status <> 'closed'
       or source.close_disposition <> 'hopped'
       or source.closed_bill_id is not null
     )
   );

with continuation_links as (
  select
    child.organization_id,
    child.id as child_session_id,
    child.status as child_status,
    source_id.value as source_session_id
  from public.sessions child
  cross join lateral jsonb_array_elements_text(
    case
      when jsonb_typeof(coalesce(child.continued_from_session_ids, '[]'::jsonb)) = 'array'
        then coalesce(child.continued_from_session_ids, '[]'::jsonb)
      else '[]'::jsonb
    end
  ) source_id(value)
)
select
  'open_session_overlap' as check_group,
  count(*)::text as open_source_and_child_count,
  case when count(*) = 0 then 'pass' else 'investigate' end as status
from continuation_links links
join public.sessions source
  on source.organization_id = links.organization_id
  and source.id = links.source_session_id
where links.child_status <> 'closed'
  and source.status <> 'closed';

with continuation_links as (
  select
    child.organization_id,
    child.id as child_session_id,
    child.customer_id as child_customer_id,
    child.customer_name as child_customer_name,
    child.customer_phone as child_customer_phone,
    source_id.value as source_session_id
  from public.sessions child
  cross join lateral jsonb_array_elements_text(
    case
      when jsonb_typeof(coalesce(child.continued_from_session_ids, '[]'::jsonb)) = 'array'
        then coalesce(child.continued_from_session_ids, '[]'::jsonb)
      else '[]'::jsonb
    end
  ) source_id(value)
)
select
  'continuation_customer_integrity' as check_group,
  count(*)::text as mismatched_customer_count,
  case when count(*) = 0 then 'pass' else 'investigate' end as status
from continuation_links links
join public.sessions source
  on source.organization_id = links.organization_id
  and source.id = links.source_session_id
where case
  when nullif(source.customer_id, '') is not null then
    nullif(links.child_customer_id, '') is distinct from nullif(source.customer_id, '')
  when nullif(regexp_replace(coalesce(source.customer_phone, ''), '\D', '', 'g'), '') is not null then
    nullif(regexp_replace(coalesce(links.child_customer_phone, ''), '\D', '', 'g'), '') is distinct from
      nullif(regexp_replace(coalesce(source.customer_phone, ''), '\D', '', 'g'), '')
  when nullif(lower(regexp_replace(trim(coalesce(source.customer_name, '')), '\s+', ' ', 'g')), '') is not null then
    nullif(lower(regexp_replace(trim(coalesce(links.child_customer_name, '')), '\s+', ' ', 'g')), '') is distinct from
      nullif(lower(regexp_replace(trim(coalesce(source.customer_name, '')), '\s+', ' ', 'g')), '')
  else
    nullif(links.child_customer_id, '') is not null
    or nullif(regexp_replace(coalesce(links.child_customer_phone, ''), '\D', '', 'g'), '') is not null
    or nullif(lower(regexp_replace(trim(coalesce(links.child_customer_name, '')), '\s+', ' ', 'g')), '') is not null
end;

with session_consumers as (
  select
    child.organization_id,
    child.id as consumer_id,
    source_id.value as source_id
  from public.sessions child
  cross join lateral jsonb_array_elements_text(
    case
      when jsonb_typeof(coalesce(child.continued_from_session_ids, '[]'::jsonb)) = 'array'
        then coalesce(child.continued_from_session_ids, '[]'::jsonb)
      else '[]'::jsonb
    end
  ) source_id(value)
),
tab_consumers as (
  select
    tab.organization_id,
    tab.id as consumer_id,
    source_id.value as source_id
  from public.customer_tabs tab
  cross join lateral jsonb_array_elements_text(
    case
      when jsonb_typeof(coalesce(tab.continued_from_session_ids, '[]'::jsonb)) = 'array'
        then coalesce(tab.continued_from_session_ids, '[]'::jsonb)
      else '[]'::jsonb
    end
  ) source_id(value)
),
branch_conflicts as (
  select
    left_consumer.organization_id,
    left_consumer.source_id,
    'session_branch'::text as conflict_type
  from session_consumers left_consumer
  join session_consumers right_consumer
    on right_consumer.organization_id = left_consumer.organization_id
    and right_consumer.source_id = left_consumer.source_id
    and right_consumer.consumer_id > left_consumer.consumer_id
  where not exists (
      select 1
      from session_consumers ancestry
      where ancestry.organization_id = left_consumer.organization_id
        and ancestry.consumer_id = right_consumer.consumer_id
        and ancestry.source_id = left_consumer.consumer_id
    )
    and not exists (
      select 1
      from session_consumers ancestry
      where ancestry.organization_id = left_consumer.organization_id
        and ancestry.consumer_id = left_consumer.consumer_id
        and ancestry.source_id = right_consumer.consumer_id
    )
  union all
  select
    left_consumer.organization_id,
    left_consumer.source_id,
    'tab_branch'::text
  from tab_consumers left_consumer
  join tab_consumers right_consumer
    on right_consumer.organization_id = left_consumer.organization_id
    and right_consumer.source_id = left_consumer.source_id
    and right_consumer.consumer_id > left_consumer.consumer_id
  union all
  select
    session_consumer.organization_id,
    session_consumer.source_id,
    'session_tab_branch'::text
  from session_consumers session_consumer
  join tab_consumers tab_consumer
    on tab_consumer.organization_id = session_consumer.organization_id
    and tab_consumer.source_id = session_consumer.source_id
  where not exists (
    select 1
    from tab_consumers ancestry
    where ancestry.organization_id = tab_consumer.organization_id
      and ancestry.consumer_id = tab_consumer.consumer_id
      and ancestry.source_id = session_consumer.consumer_id
  )
)
select
  'continuation_branch_integrity' as check_group,
  count(*)::text as invalid_branch_count,
  case when count(*) = 0 then 'pass' else 'investigate' end as status
from branch_conflicts;

-- Staging behavior matrix:
-- 1. Active or paused source that has not committed hop -> start_session returns
--    code hopped_session_unavailable and creates no session/audit/stock rows.
-- 2. Closed + hopped + unbilled source -> continuation succeeds.
-- 3. Missing, cross-organization, rejected, normally closed, or billed source ->
--    the whole start_session transaction is rejected.
-- 4. Retry with the same mutation/session id remains idempotent.
-- 5. A continuation with the same customer id succeeds.
-- 6. When no customer id exists, normalized phone and then normalized name
--    preserve the same customer across the hop.
-- 7. A different or newly introduced customer identity returns
--    hopped_session_customer_mismatch and creates no session/audit/stock rows.
-- 8. A fully anonymous source can continue only to a fully anonymous target.
-- 9. Concurrent starts from the same source serialize: one succeeds and the
--    other returns hopped_session_already_continued with no partial rows.
-- 10. A -> B -> C succeeds when C requests [A, B], while A -> B and A -> X
--     cannot both succeed.
-- 11. Starting a game and linking a consumables tab concurrently from the
--     same source produces exactly one continuation consumer.
