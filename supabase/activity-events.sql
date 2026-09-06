-- Detailed activity ledger.
-- Additive: this script does not alter business rows or app_state.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table if not exists public.activity_events (
  id text primary key default ('activity-' || gen_random_uuid()::text),
  organization_id text not null references public.organizations (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid references public.profiles (id) on delete set null,
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
    select name, username, role::text
    into v_name, v_username, v_role
    from public.profiles
    where id = v_actor;
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
  v_has_audit_reference boolean;
begin
  v_has_audit_reference := coalesce(nullif(new.metadata->>'audit_log_id', ''), '') <> ''
    or jsonb_typeof(new.metadata #> '{changed_rows,audit_logs}') = 'array'
       and jsonb_array_length(new.metadata #> '{changed_rows,audit_logs}') > 0;

  -- An audit row is the canonical presentation record when both sources exist.
  if v_has_audit_reference then
    return new;
  end if;

  if new.created_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_actor := new.created_by::uuid;
  end if;

  if v_actor is not null then
    select name, username, role::text
    into v_name, v_username, v_role
    from public.profiles
    where id = v_actor;
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
    public.activity_humanize(new.event_type),
    jsonb_strip_nulls(jsonb_build_object(
      'event_id', new.id,
      'source', 'operational_event',
      'entity_version', new.entity_version
    )),
    nullif(new.metadata->>'mutation_id', ''),
    'operational_event',
    new.id,
    false
  )
  on conflict (organization_id, source_kind, source_id) do nothing;

  return new;
end;
$$;

-- Historical data is explicitly marked legacy. Actor/time values are preserved,
-- never guessed or rewritten during backfill.
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
  profile.role::text,
  audit.action,
  public.activity_category(audit.action, audit.entity_type),
  audit.entity_type,
  audit.entity_id,
  public.resolve_activity_entity_label(audit.organization_id, audit.entity_type, audit.entity_id),
  coalesce(nullif(audit.message, ''), public.activity_humanize(audit.action)),
  jsonb_build_object('audit_id', audit.id, 'source', 'audit_log'),
  'audit_log',
  audit.id,
  true
from public.audit_logs audit
left join public.profiles profile
  on profile.id::text = audit.user_id
on conflict (organization_id, source_kind, source_id) do nothing;

insert into public.activity_events (
  organization_id, occurred_at, actor_user_id,
  actor_name_snapshot, actor_username_snapshot, actor_role_snapshot,
  action, category, entity_type, entity_id, entity_label, summary, details,
  mutation_id, source_kind, source_id, legacy
)
select
  event.organization_id,
  event.created_at,
  profile.id,
  profile.name,
  profile.username,
  profile.role::text,
  event.event_type,
  public.activity_category(event.event_type, event.entity_type),
  event.entity_type,
  event.entity_id,
  public.resolve_activity_entity_label(event.organization_id, event.entity_type, event.entity_id),
  public.activity_humanize(event.event_type),
  jsonb_strip_nulls(jsonb_build_object(
    'event_id', event.id,
    'source', 'operational_event',
    'entity_version', event.entity_version
  )),
  nullif(event.metadata->>'mutation_id', ''),
  'operational_event',
  event.id,
  true
from public.operational_events event
left join public.profiles profile
  on profile.id::text = event.created_by
where not (
  coalesce(nullif(event.metadata->>'audit_log_id', ''), '') <> ''
  or jsonb_typeof(event.metadata #> '{changed_rows,audit_logs}') = 'array'
     and jsonb_array_length(event.metadata #> '{changed_rows,audit_logs}') > 0
)
on conflict (organization_id, source_kind, source_id) do nothing;

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

drop trigger if exists operational_events_canonical_identity on public.operational_events;
create trigger operational_events_canonical_identity
before insert on public.operational_events
for each row execute function public.canonicalize_operational_event_identity();

drop trigger if exists operational_events_append_activity on public.operational_events;
create trigger operational_events_append_activity
after insert on public.operational_events
for each row execute function public.append_activity_from_operational_event();

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
  v_entity_type text := nullif(payload->>'entity_type', '');
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
  end if;
  if nullif(payload->>'to_date', '') is not null then
    v_to := (((payload->>'to_date')::date + 1)::timestamp at time zone 'Asia/Kolkata');
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

  with matching as (
    select event.*
    from public.activity_events event
    where event.organization_id = v_organization_id
      and (v_actor_user_id is null or event.actor_user_id = v_actor_user_id)
      and (v_category is null or event.category = v_category)
      and (v_entity_type is null or event.entity_type = v_entity_type)
      and (v_from is null or event.occurred_at >= v_from)
      and (v_to is null or event.occurred_at < v_to)
      and (v_time_from is null or (event.occurred_at at time zone 'Asia/Kolkata')::time >= v_time_from)
      and (v_time_to is null or (event.occurred_at at time zone 'Asia/Kolkata')::time <= v_time_to)
      and (v_search is null or event.search_text ilike '%' || lower(v_search) || '%')
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
