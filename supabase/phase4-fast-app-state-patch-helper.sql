-- Phase 4/5 compatibility helper optimization.
--
-- Run this in any environment that already has normalized/RPC SQL installed.
-- It replaces the JSON array patch helper with a set-based implementation so
-- compact RPCs do not spend statement-timeout-scale work rebuilding large
-- app_state arrays such as auditLogs.

create or replace function public.patch_app_state_array_by_id(
  target_array jsonb,
  patch_array jsonb
)
returns jsonb
language sql
as $$
  with target_entries as (
    select
      item.value,
      item.ordinality,
      nullif(item.value->>'id', '') as id
    from jsonb_array_elements(
      case when jsonb_typeof(target_array) = 'array' then target_array else '[]'::jsonb end
    ) with ordinality as item(value, ordinality)
  ),
  patch_entries as (
    select
      item.value,
      item.ordinality,
      nullif(item.value->>'id', '') as id
    from jsonb_array_elements(
      case when jsonb_typeof(patch_array) = 'array' then patch_array else '[]'::jsonb end
    ) with ordinality as item(value, ordinality)
  ),
  first_patch_by_id as (
    select distinct on (id)
      id,
      value
    from patch_entries
    where id is not null
    order by id, ordinality
  ),
  target_ids as (
    select distinct id
    from target_entries
    where id is not null
  ),
  missing_patches as (
    select
      0 as section_order,
      patch_entries.ordinality,
      patch_entries.value
    from patch_entries
    where patch_entries.id is not null
      and not exists (
        select 1
        from target_ids
        where target_ids.id = patch_entries.id
      )
  ),
  patched_target as (
    select
      1 as section_order,
      target_entries.ordinality,
      coalesce(first_patch_by_id.value, target_entries.value) as value
    from target_entries
    left join first_patch_by_id
      on first_patch_by_id.id = target_entries.id
  ),
  combined_entries as (
    select section_order, ordinality, value from missing_patches
    union all
    select section_order, ordinality, value from patched_target
  )
  select coalesce(jsonb_agg(value order by section_order, ordinality), '[]'::jsonb)
  from combined_entries;
$$;

revoke all on function public.patch_app_state_array_by_id(jsonb, jsonb) from public;
revoke execute on function public.patch_app_state_array_by_id(jsonb, jsonb) from anon;
revoke execute on function public.patch_app_state_array_by_id(jsonb, jsonb) from authenticated;
