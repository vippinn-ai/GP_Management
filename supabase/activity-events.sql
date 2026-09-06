-- Detailed activity ledger.
-- Additive: this script does not alter business rows or app_state.

begin;

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table if not exists public.activity_events (
  id text primary key default ('activity-' || gen_random_uuid()::text),
  organization_id text not null references public.organizations (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid,
  actor_name_snapshot text,
  actor_username_snapshot text,
  actor_role_snapshot text,
  action text not null,
  category text not null,
  entity_type text,
  entity_id text,
  entity_label text,
  summary text not null,
  details jsonb not null default '{}'::jsonb,
  mutation_id text,
  audit_reference_ids text[] not null default '{}'::text[],
  source_kind text not null check (source_kind in ('audit_log', 'operational_event')),
  source_id text not null,
  legacy boolean not null default false,
  search_text text generated always as (
    lower(
      coalesce(summary, '') || ' ' ||
      coalesce(actor_name_snapshot, '') || ' ' ||
      coalesce(actor_username_snapshot, '') || ' ' ||
      coalesce(entity_label, '') || ' ' ||
      coalesce(entity_id, '') || ' ' ||
      coalesce(action, '')
    )
  ) stored,
  created_at timestamptz not null default now(),
  unique (organization_id, source_kind, source_id)
);

alter table public.activity_events
  add column if not exists audit_reference_ids text[] not null default '{}'::text[];
alter table public.activity_events
  drop constraint if exists activity_events_actor_user_id_fkey;

create index if not exists activity_events_org_cursor_idx
  on public.activity_events (organization_id, occurred_at desc, id desc);
create index if not exists activity_events_org_actor_cursor_idx
  on public.activity_events (organization_id, actor_user_id, occurred_at desc, id desc);
create index if not exists activity_events_org_category_cursor_idx
  on public.activity_events (organization_id, category, occurred_at desc, id desc);
create index if not exists activity_events_org_entity_cursor_idx
  on public.activity_events (organization_id, entity_type, entity_id, occurred_at desc, id desc);
create index if not exists activity_events_search_trgm_idx
  on public.activity_events using gin (search_text gin_trgm_ops);
create index if not exists activity_events_audit_references_idx
  on public.activity_events using gin (audit_reference_ids);

alter table public.activity_events enable row level security;

drop policy if exists activity_events_select_org_member on public.activity_events;
create policy activity_events_select_org_member
on public.activity_events
for select
to authenticated
using ((select public.current_user_has_org_access(organization_id)));

revoke all on table public.activity_events from anon, authenticated;
grant select on table public.activity_events to authenticated;

create or replace function public.activity_category(
  p_action text,
  p_entity_type text
)
returns text
language sql
immutable
as $$
  select case
    when coalesce(p_action, '') ~* '(bill|payment|settle|discount|refund|void|checkout)' or coalesce(p_entity_type, '') = 'bill' then 'billing'
    when coalesce(p_action, '') ~* '(inventory|stock|item|variant)' or coalesce(p_entity_type, '') in ('inventory_item', 'stock_movement') then 'inventory'
    when coalesce(p_action, '') ~* '(session|pause|resume|hop|game)' or coalesce(p_entity_type, '') = 'session' then 'session'
    when coalesce(p_action, '') ~* '(customer_tab|consumables_tab|tab_)' or coalesce(p_entity_type, '') = 'customer_tab' then 'customer_tab'
    when coalesce(p_action, '') ~* '(customer)' or coalesce(p_entity_type, '') = 'customer' then 'customer'
    when coalesce(p_action, '') ~* '(combo|catalog|pricing|station)' or coalesce(p_entity_type, '') in ('combo', 'station', 'pricing_rule') then 'catalog'
    when coalesce(p_action, '') ~* '(expense)' or coalesce(p_entity_type, '') in ('expense', 'expense_template') then 'expense'
    when coalesce(p_action, '') ~* '(user|profile|password)' or coalesce(p_entity_type, '') in ('user', 'profile') then 'user'
    when coalesce(p_action, '') ~* '(setting|business_profile)' then 'settings'
    else 'other'
  end;
$$;

create or replace function public.activity_humanize(p_value text)
returns text
language sql
immutable
as $$
  select initcap(replace(coalesce(nullif(p_value, ''), 'activity'), '_', ' '));
$$;

create or replace function public.resolve_activity_summary(
  p_event_type text,
  p_detail jsonb
)
returns text
language plpgsql
immutable
as $$
declare
  v_item_name text := nullif(p_detail->>'item_name', '');
  v_quantity text := nullif(p_detail->>'quantity', '');
  v_previous_quantity text := nullif(p_detail->>'previous_quantity', '');
  v_unit_price text := nullif(p_detail->>'unit_price', '');
begin
  if p_event_type in ('add_session_item', 'add_customer_tab_item') and v_item_name is not null then
    return format(
      'Added %s x %s%s.',
      coalesce(v_quantity, '1'),
      v_item_name,
      case when v_unit_price is null then '' else format(' at Rs %s each', v_unit_price) end
    );
  end if;
  if p_event_type in ('remove_session_item', 'remove_customer_tab_item') and v_item_name is not null then
    return format('Removed %s x %s.', coalesce(v_quantity, '1'), v_item_name);
  end if;
  if p_event_type = 'update_customer_tab_item_quantity' and v_item_name is not null then
    return format(
      'Changed %s quantity from %s to %s.',
      v_item_name,
      coalesce(v_previous_quantity, '?'),
      coalesce(v_quantity, '?')
    );
  end if;
  return public.activity_humanize(p_event_type);
end;
$$;

create or replace function public.extract_activity_audit_reference_ids(p_metadata jsonb)
returns text[]
language plpgsql
immutable
as $$
declare
  v_references text[] := '{}'::text[];
  v_value text;
begin
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    return v_references;
  end if;

  v_value := nullif(p_metadata->>'audit_log_id', '');
  if v_value is not null then
    v_references := array_append(v_references, v_value);
  end if;

  if jsonb_typeof(p_metadata->'audit_log_ids') = 'array' then
    v_references := v_references || array(
      select value
      from jsonb_array_elements_text(p_metadata->'audit_log_ids') as values_(value)
      where nullif(value, '') is not null
    );
  end if;

  if jsonb_typeof(p_metadata #> '{changed_rows,audit_logs}') = 'array' then
    v_references := v_references || array(
      select value
      from jsonb_array_elements_text(p_metadata #> '{changed_rows,audit_logs}') as values_(value)
      where nullif(value, '') is not null
    );
  end if;

  return coalesce(array(
    select distinct value
    from unnest(v_references) as values_(value)
    order by value
  ), '{}'::text[]);
end;
$$;

create or replace function public.resolve_activity_entity_label(
  p_organization_id text,
  p_entity_type text,
  p_entity_id text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text;
begin
  case coalesce(p_entity_type, '')
    when 'bill' then
      select concat_ws(' · ', nullif(bill_number, ''), nullif(customer_name, ''))
      into v_label
      from public.bills
      where organization_id = p_organization_id and id = p_entity_id;
    when 'session' then
      select concat_ws(' · ', nullif(station_name_snapshot, ''), nullif(customer_name, ''))
      into v_label
      from public.sessions
      where organization_id = p_organization_id and id = p_entity_id;
    when 'customer_tab' then
      select nullif(customer_name, '')
      into v_label
      from public.customer_tabs
      where organization_id = p_organization_id and id = p_entity_id;
    when 'inventory_item' then
      select nullif(name, '')
      into v_label
      from public.inventory_items
      where organization_id = p_organization_id and id = p_entity_id;
    when 'customer' then
      select nullif(name, '')
      into v_label
      from public.customers
      where organization_id = p_organization_id and id = p_entity_id;
    when 'station' then
      select nullif(name, '')
      into v_label
      from public.stations
      where organization_id = p_organization_id and id = p_entity_id;
    else
      v_label := null;
  end case;

  return nullif(v_label, '');
end;
$$;

revoke all on function public.resolve_activity_entity_label(text, text, text) from public, anon, authenticated;

create or replace function public.canonicalize_audit_log_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
begin
  if v_actor is not null then
    new.user_id := v_actor::text;
    new.audit_at := v_now;
    new.raw_data := coalesce(new.raw_data, '{}'::jsonb) || jsonb_build_object(
      'userId', v_actor::text,
      'createdAt', v_now
    );
  else
    new.audit_at := coalesce(new.audit_at, v_now);
  end if;
  return new;
end;
$$;

create or replace function public.canonicalize_operational_event_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is not null then
    new.created_by := v_actor::text;
    new.created_at := now();
  end if;
  return new;
end;
$$;

create or replace function public.preserve_audit_log_immutability()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Audit IDs are idempotency identities. A replay may execute an UPSERT, but it
  -- must never rewrite the original actor, time, action, entity, or message.
  return old;
end;
$$;

create or replace function public.prevent_authenticated_activity_source_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'Activity evidence cannot be deleted by an authenticated application user.' using errcode = '42501';
  end if;
  return old;
end;
$$;

create or replace function public.append_activity_from_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_name text;
  v_username text;
  v_role text;
begin
  if new.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_actor := new.user_id::uuid;
  end if;

  if v_actor is not null then
    select profile.name, profile.username, coalesce(member.role::text, profile.role::text)
    into v_name, v_username, v_role
    from public.profiles profile
    left join public.organization_members member
      on member.organization_id = new.organization_id and member.user_id = profile.id
    where profile.id = v_actor;
  end if;

  insert into public.activity_events (
    organization_id,
    occurred_at,
    actor_user_id,
    actor_name_snapshot,
    actor_username_snapshot,
    actor_role_snapshot,
    action,
    category,
    entity_type,
    entity_id,
    entity_label,
    summary,
    details,
    source_kind,
    source_id,
    legacy
  ) values (
    new.organization_id,
    coalesce(new.audit_at, new.created_at, now()),
    v_actor,
    v_name,
    v_username,
    v_role,
    new.action,
    public.activity_category(new.action, new.entity_type),
    new.entity_type,
    new.entity_id,
    public.resolve_activity_entity_label(new.organization_id, new.entity_type, new.entity_id),
    coalesce(nullif(new.message, ''), public.activity_humanize(new.action)),
    jsonb_strip_nulls(jsonb_build_object(
      'audit_id', new.id,
      'source', 'audit_log'
    )),
    'audit_log',
    new.id,
    false
  )
  on conflict (organization_id, source_kind, source_id) do nothing;

  return new;
end;
$$;

create or replace function public.append_activity_from_operational_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_name text;
  v_username text;
  v_role text;
  v_audit_reference_ids text[];
begin
  v_audit_reference_ids := public.extract_activity_audit_reference_ids(new.metadata);

  if new.created_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_actor := new.created_by::uuid;
  end if;

  if v_actor is not null then
    select profile.name, profile.username, coalesce(member.role::text, profile.role::text)
    into v_name, v_username, v_role
    from public.profiles profile
    left join public.organization_members member
      on member.organization_id = new.organization_id and member.user_id = profile.id
    where profile.id = v_actor;
  end if;

  insert into public.activity_events (
    organization_id,
    occurred_at,
    actor_user_id,
    actor_name_snapshot,
    actor_username_snapshot,
    actor_role_snapshot,
    action,
    category,
    entity_type,
    entity_id,
    entity_label,
    summary,
    details,
    mutation_id,
    audit_reference_ids,
    source_kind,
    source_id,
    legacy
  ) values (
    new.organization_id,
    new.created_at,
    v_actor,
    v_name,
    v_username,
    v_role,
    new.event_type,
    public.activity_category(new.event_type, new.entity_type),
    new.entity_type,
    new.entity_id,
    public.resolve_activity_entity_label(new.organization_id, new.entity_type, new.entity_id),
    public.resolve_activity_summary(new.event_type, coalesce(new.metadata->'activity_detail', '{}'::jsonb)),
    jsonb_strip_nulls(jsonb_build_object(
      'event_id', new.id,
      'source', 'operational_event',
      'entity_version', new.entity_version
    ) || coalesce(new.metadata->'activity_detail', '{}'::jsonb)),
    nullif(new.metadata->>'mutation_id', ''),
    v_audit_reference_ids,
    'operational_event',
    new.id,
    false
  )
  on conflict (organization_id, source_kind, source_id) do nothing;

  return new;
end;
$$;

-- Install capture before taking the backfill snapshots. Inserts that wait on the
-- trigger DDL lock are captured normally after this transaction commits.
drop trigger if exists audit_logs_canonical_identity on public.audit_logs;
create trigger audit_logs_canonical_identity
before insert on public.audit_logs
for each row execute function public.canonicalize_audit_log_identity();

drop trigger if exists audit_logs_append_activity on public.audit_logs;
create trigger audit_logs_append_activity
after insert on public.audit_logs
for each row execute function public.append_activity_from_audit_log();

drop trigger if exists zz_audit_logs_preserve_immutable on public.audit_logs;
create trigger zz_audit_logs_preserve_immutable
before update on public.audit_logs
for each row execute function public.preserve_audit_log_immutability();

drop trigger if exists zz_audit_logs_prevent_delete on public.audit_logs;
create trigger zz_audit_logs_prevent_delete
before delete on public.audit_logs
for each row execute function public.prevent_authenticated_activity_source_delete();

drop trigger if exists operational_events_canonical_identity on public.operational_events;
create trigger operational_events_canonical_identity
before insert on public.operational_events
for each row execute function public.canonicalize_operational_event_identity();

drop trigger if exists operational_events_append_activity on public.operational_events;
create trigger operational_events_append_activity
after insert on public.operational_events
for each row execute function public.append_activity_from_operational_event();

drop trigger if exists zz_operational_events_prevent_delete on public.operational_events;
create trigger zz_operational_events_prevent_delete
before delete on public.operational_events
for each row execute function public.prevent_authenticated_activity_source_delete();

-- Every source is retained as evidence. Historical data is explicitly marked legacy. Actor/time values are preserved,
-- never guessed or rewritten during backfill. Current profile/entity values are
-- lookup labels only and their provenance is exposed in details.
insert into public.activity_events (
  organization_id, occurred_at, actor_user_id,
  actor_name_snapshot, actor_username_snapshot, actor_role_snapshot,
  action, category, entity_type, entity_id, entity_label, summary, details,
  source_kind, source_id, legacy
)
select
  audit.organization_id,
  coalesce(audit.audit_at, audit.created_at),
  profile.id,
  profile.name,
  profile.username,
  coalesce(member.role::text, profile.role::text),
  audit.action,
  public.activity_category(audit.action, audit.entity_type),
  audit.entity_type,
  audit.entity_id,
  public.resolve_activity_entity_label(audit.organization_id, audit.entity_type, audit.entity_id),
  coalesce(nullif(audit.message, ''), public.activity_humanize(audit.action)),
  jsonb_build_object(
    'audit_id', audit.id,
    'source', 'audit_log',
    'legacy_identity_provenance', 'current_membership_profile_lookup',
    'legacy_entity_label_provenance', 'current_entity_lookup'
  ),
  'audit_log',
  audit.id,
  true
from public.audit_logs audit
left join public.profiles profile
  on profile.id::text = audit.user_id
left join public.organization_members member
  on member.organization_id = audit.organization_id and member.user_id = profile.id
on conflict (organization_id, source_kind, source_id) do nothing;

insert into public.activity_events (
  organization_id, occurred_at, actor_user_id,
  actor_name_snapshot, actor_username_snapshot, actor_role_snapshot,
  action, category, entity_type, entity_id, entity_label, summary, details,
  mutation_id, audit_reference_ids, source_kind, source_id, legacy
)
select
  event.organization_id,
  event.created_at,
  profile.id,
  profile.name,
  profile.username,
  coalesce(member.role::text, profile.role::text),
  event.event_type,
  public.activity_category(event.event_type, event.entity_type),
  event.entity_type,
  event.entity_id,
  public.resolve_activity_entity_label(event.organization_id, event.entity_type, event.entity_id),
  public.resolve_activity_summary(event.event_type, coalesce(event.metadata->'activity_detail', '{}'::jsonb)),
  jsonb_strip_nulls(jsonb_build_object(
    'event_id', event.id,
    'source', 'operational_event',
    'entity_version', event.entity_version,
    'legacy_identity_provenance', 'current_membership_profile_lookup',
    'legacy_entity_label_provenance', 'current_entity_lookup'
  ) || coalesce(event.metadata->'activity_detail', '{}'::jsonb)),
  nullif(event.metadata->>'mutation_id', ''),
  public.extract_activity_audit_reference_ids(event.metadata),
  'operational_event',
  event.id,
  true
from public.operational_events event
left join public.profiles profile
  on profile.id::text = event.created_by
left join public.organization_members member
  on member.organization_id = event.organization_id and member.user_id = profile.id
on conflict (organization_id, source_kind, source_id) do update
set audit_reference_ids = excluded.audit_reference_ids,
    summary = excluded.summary,
    details = excluded.details,
    mutation_id = excluded.mutation_id;

-- Application clients may read compatibility rows, but all writes must go through
-- authenticated SECURITY DEFINER business RPCs.
revoke insert, update, delete, truncate on public.audit_logs from authenticated;
revoke insert, update, delete, truncate on public.operational_events from authenticated;

create or replace function public.list_activity_events(payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id text := nullif(payload->>'organization_id', '');
  v_limit integer := least(greatest(coalesce(nullif(payload->>'limit', '')::integer, 50), 1), 100);
  v_search text := nullif(btrim(payload->>'search'), '');
  v_actor_user_id uuid;
  v_category text := nullif(payload->>'category', '');
  v_action text := nullif(payload->>'action', '');
  v_entity_type text := nullif(payload->>'entity_type', '');
  v_entity_id text := nullif(payload->>'entity_id', '');
  v_from timestamptz;
  v_to timestamptz;
  v_time_from time;
  v_time_to time;
  v_cursor_at timestamptz;
  v_cursor_id text := nullif(payload->>'cursor_id', '');
  v_result jsonb;
begin
  if auth.uid() is null
    or v_organization_id is null
    or not public.current_user_has_org_access(v_organization_id)
  then
    raise exception 'Authenticated active organization membership is required.' using errcode = '42501';
  end if;

  if nullif(payload->>'actor_user_id', '') is not null then
    v_actor_user_id := (payload->>'actor_user_id')::uuid;
  end if;
  if nullif(payload->>'from_date', '') is not null then
    v_from := ((payload->>'from_date')::date::timestamp at time zone 'Asia/Kolkata');
  elsif nullif(payload->>'from_iso', '') is not null then
    v_from := (payload->>'from_iso')::timestamptz;
  end if;
  if nullif(payload->>'to_date', '') is not null then
    v_to := (((payload->>'to_date')::date + 1)::timestamp at time zone 'Asia/Kolkata');
  elsif nullif(payload->>'to_iso_exclusive', '') is not null then
    v_to := (payload->>'to_iso_exclusive')::timestamptz;
  end if;
  if nullif(payload->>'time_from', '') is not null then
    v_time_from := (payload->>'time_from')::time;
  end if;
  if nullif(payload->>'time_to', '') is not null then
    v_time_to := (payload->>'time_to')::time;
  end if;
  if nullif(payload->>'cursor_at', '') is not null then
    v_cursor_at := (payload->>'cursor_at')::timestamptz;
  end if;
  if (v_cursor_at is null) <> (v_cursor_id is null) then
    raise exception 'cursor_at and cursor_id must be supplied together.' using errcode = '22023';
  end if;

  with matching as (
    select event.*
    from public.activity_events event
    where event.organization_id = v_organization_id
      and (v_actor_user_id is null or event.actor_user_id = v_actor_user_id)
      and (v_category is null or event.category = v_category)
      and (v_action is null or event.action = v_action)
      and (v_entity_type is null or event.entity_type = v_entity_type)
      and (v_entity_id is null or event.entity_id = v_entity_id)
      and (v_from is null or event.occurred_at >= v_from)
      and (v_to is null or event.occurred_at < v_to)
      and (
        v_time_from is null
        or v_time_to is null
        or v_time_from <= v_time_to
        or (event.occurred_at at time zone 'Asia/Kolkata')::time >= v_time_from
        or (event.occurred_at at time zone 'Asia/Kolkata')::time <= v_time_to
      )
      and (
        v_time_from is null
        or (v_time_to is not null and v_time_from > v_time_to)
        or (event.occurred_at at time zone 'Asia/Kolkata')::time >= v_time_from
      )
      and (
        v_time_to is null
        or (v_time_from is not null and v_time_from > v_time_to)
        or (event.occurred_at at time zone 'Asia/Kolkata')::time <= v_time_to
      )
      and (v_search is null or event.search_text ilike '%' || lower(v_search) || '%')
      and not (
        event.source_kind = 'audit_log'
        and exists (
          select 1
          from public.activity_events operational
          where operational.organization_id = event.organization_id
            and operational.source_kind = 'operational_event'
            and operational.audit_reference_ids @> array[event.source_id]
            and (
              (event.legacy and operational.legacy)
              or (
                not operational.legacy
                and event.actor_user_id is not null
                and operational.actor_user_id = event.actor_user_id
                and operational.occurred_at = event.occurred_at
              )
            )
        )
      )
      and (
        v_cursor_at is null
        or (event.occurred_at, event.id) < (v_cursor_at, v_cursor_id)
      )
    order by event.occurred_at desc, event.id desc
    limit v_limit + 1
  ), page_rows as (
    select * from matching
    order by occurred_at desc, id desc
    limit v_limit
  )
  select jsonb_build_object(
    'server_time', now(),
    'actors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', actor.actor_user_id,
        'name', actor.actor_name_snapshot,
        'username', actor.actor_username_snapshot,
        'role', actor.actor_role_snapshot
      ) order by actor.actor_name_snapshot, actor.actor_username_snapshot, actor.actor_user_id)
      from (
        select distinct on (event.actor_user_id)
          event.actor_user_id,
          event.actor_name_snapshot,
          event.actor_username_snapshot,
          event.actor_role_snapshot
        from public.activity_events event
        where event.organization_id = v_organization_id
          and event.actor_user_id is not null
        order by event.actor_user_id, event.occurred_at desc, event.id desc
      ) actor
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', row.id,
        'occurred_at', row.occurred_at,
        'actor_user_id', row.actor_user_id,
        'actor_name', row.actor_name_snapshot,
        'actor_username', row.actor_username_snapshot,
        'actor_role', row.actor_role_snapshot,
        'action', row.action,
        'category', row.category,
        'entity_type', row.entity_type,
        'entity_id', row.entity_id,
        'entity_label', row.entity_label,
        'summary', row.summary,
        'details', row.details,
        'mutation_id', row.mutation_id,
        'source_kind', row.source_kind,
        'legacy', row.legacy
      ) order by row.occurred_at desc, row.id desc)
      from page_rows row
    ), '[]'::jsonb),
    'has_more', (select count(*) > v_limit from matching),
    'next_cursor', case when (select count(*) > v_limit from matching) then (
      select jsonb_build_object('occurred_at', tail.occurred_at, 'id', tail.id)
      from page_rows tail
      order by tail.occurred_at asc, tail.id asc
      limit 1
    ) else null end
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.list_activity_events(jsonb) from public, anon;
grant execute on function public.list_activity_events(jsonb) to authenticated;

commit;
