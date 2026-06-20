-- Phase 3 supplemental read-performance indexes.
--
-- Run this after supabase/phase1-normalized-schema.sql has already been
-- applied in staging or production. The statements are idempotent and only add
-- indexes used by normalized report reads; they do not modify app_state or data.

create index if not exists sessions_org_started_closed_bill_idx
on public.sessions (organization_id, started_at desc, id desc)
where closed_bill_id is not null;

create index if not exists sessions_org_closed_bill_idx
on public.sessions (organization_id, closed_bill_id)
where closed_bill_id is not null;

create index if not exists customer_tabs_org_opened_closed_bill_idx
on public.customer_tabs (organization_id, opened_at desc, id desc)
where closed_bill_id is not null;

create index if not exists customer_tabs_org_closed_bill_idx
on public.customer_tabs (organization_id, closed_bill_id)
where closed_bill_id is not null;
