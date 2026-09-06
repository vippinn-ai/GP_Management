import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "supabase/activity-events.sql"), "utf8");

describe("activity ledger SQL contract", () => {
  it("is additive, tenant-scoped, indexed, and read-only to app clients", () => {
    expect(sql).toContain("create table if not exists public.activity_events");
    expect(sql).toContain("activity_events_org_cursor_idx");
    expect(sql).toContain("activity_events_search_trgm_idx");
    expect(sql).toContain("public.current_user_has_org_access(organization_id)");
    expect(sql).toContain("grant select on table public.activity_events to authenticated");
    expect(sql).toContain("revoke insert, update, delete, truncate on public.audit_logs from authenticated");
    expect(sql).toContain("revoke insert, update, delete, truncate on public.operational_events from authenticated");
    expect(sql).not.toMatch(/\b(update|delete from|truncate)\s+public\.app_state\b/i);
  });

  it("canonicalizes future actors and timestamps from authenticated server context", () => {
    expect(sql).toContain("v_actor uuid := auth.uid()");
    expect(sql).toContain("new.user_id := v_actor::text");
    expect(sql).toContain("new.created_by := v_actor::text");
    expect(sql).toContain("new.audit_at := v_now");
    expect(sql).toContain("new.created_at := now()");
    expect(sql).toContain("create trigger zz_audit_logs_preserve_immutable");
    expect(sql).toContain("return old");
  });

  it("deduplicates source records and labels historical imports without inventing data", () => {
    expect(sql).toContain("unique (organization_id, source_kind, source_id)");
    expect(sql).toMatch(/from public\.audit_logs audit[\s\S]*?true[\s\S]*?on conflict \(organization_id, source_kind, source_id\) do nothing/i);
    expect(sql).toContain("An audit row is the canonical presentation record when both sources exist");
  });

  it("provides authenticated keyset pagination and server-side filters", () => {
    expect(sql).toContain("create or replace function public.list_activity_events");
    expect(sql).toContain("(event.occurred_at, event.id) < (v_cursor_at, v_cursor_id)");
    expect(sql).toContain("limit v_limit + 1");
    expect(sql).toContain("grant execute on function public.list_activity_events(jsonb) to authenticated");
    expect(sql).toContain("at time zone 'Asia/Kolkata'");
  });
});
