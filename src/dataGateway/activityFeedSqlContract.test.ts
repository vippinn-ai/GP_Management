import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "supabase/activity-events.sql"), "utf8");
const verificationSql = readFileSync(resolve(process.cwd(), "supabase/activity-events-verification.sql"), "utf8");
const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const normalizedGatewaySource = readFileSync(resolve(process.cwd(), "src/dataGateway/normalizedGateway.ts"), "utf8");
const sessionItemRpcSql = readFileSync(resolve(process.cwd(), "supabase/phase4-session-item-rpcs.sql"), "utf8");
const customerTabRpcSql = readFileSync(resolve(process.cwd(), "supabase/phase4-customer-tab-rpcs.sql"), "utf8");
const financialV2RpcSql = readFileSync(resolve(process.cwd(), "supabase/phase10-financial-v2-rpcs.sql"), "utf8");

describe("activity ledger SQL contract", () => {
  it("is additive, tenant-scoped, indexed, and read-only to app clients", () => {
    expect(sql).toContain("create table if not exists public.activity_events");
    expect(sql).toContain("activity_events_org_cursor_idx");
    expect(sql).toContain("activity_events_search_trgm_idx");
    expect(sql).toContain("activity_events_audit_references_idx");
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
    expect(sql).toMatch(/'audit_log',\s+audit\.id,\s+true\s+from public\.audit_logs audit[\s\S]*?on conflict \(organization_id, source_kind, source_id\) do nothing/i);
    expect(sql).toContain("Every source is retained as");
  });

  it("retains every operational source and extracts every deployed audit-reference shape", () => {
    expect(sql).toContain("create or replace function public.extract_activity_audit_reference_ids");
    expect(sql).toContain("p_metadata->>'audit_log_id'");
    expect(sql).toContain("p_metadata->'audit_log_ids'");
    expect(sql).toContain("p_metadata #> '{changed_rows,audit_logs}'");
    expect(sql).toMatch(/from public\.operational_events event[\s\S]*?on conflict \(organization_id, source_kind, source_id\) do update/i);
    expect(verificationSql).toContain("audit_reference_extractor_valid");
    expect(verificationSql).toContain("reference_mismatch_rows");
  });

  it("suppresses only a correlated audit action covered by a complete server projection", () => {
    for (const source of [sql, verificationSql]) {
      expect(source).toContain("operational.audit_reference_ids @> array[event.source_id]");
      expect(source).toContain("public.operational_activity_covers_audit(operational.action, operational.details, event.action)");
      expect(source).toContain("operational.actor_user_id = event.actor_user_id");
      expect(source).toContain("operational.occurred_at = event.occurred_at");
    }
    expect(sql).toContain("coalesce(p_operational_details->>'projection_complete', 'false') = 'true'");
    expect(sql).toContain("p_operational_action = p_audit_action");
    expect(sql).toContain("p_operational_action = 'add_session_item' and p_audit_action = 'session_item_added'");
  });

  it("server-persists exact item, quantity, and price context for item activity", () => {
    expect(sql).toContain("create or replace function public.resolve_activity_summary");
    expect(sql).toContain("p_metadata->'activity_detail'");
    for (const source of [sessionItemRpcSql, customerTabRpcSql]) {
      expect(source).toContain("'activity_detail', jsonb_build_object(");
      expect(source).toContain("'item_name'");
      expect(source).toContain("'quantity'");
      expect(source).toContain("'unit_price'");
      expect(source).toContain("'total'");
    }
    expect(customerTabRpcSql).toContain("'previous_quantity'");
  });

  it("projects trusted financial checkout and adjustment semantics with bill evidence", () => {
    expect(sql).toContain("create or replace function public.resolve_operational_activity_detail");
    expect(sql).toContain("p_event_type = 'financial_checkout_committed_v2'");
    expect(sql).toContain("p_event_type = 'financial_adjustment_committed_v2'");
    expect(sql).toContain("from public.bills bill");
    expect(sql).toContain("from public.payments payment");
    for (const action of ["bill_issued", "bill_pending", "bill_replaced", "bill_settled", "bill_voided_bad_debt", "bill_voided", "bill_refunded"]) {
      expect(sql).toContain(`'${action}'`);
    }
    expect(financialV2RpcSql).toContain("'checkout_mode', v_mode");
    expect(financialV2RpcSql).toContain("'activity_detail', jsonb_build_object(");
    expect(financialV2RpcSql).toContain("when 'settlePendingBills' then 'bill_settled'");
    expect(financialV2RpcSql).toContain("when 'refundBill' then 'bill_refunded'");
    expect(sql).toContain("p_allow_current_snapshot boolean");
    expect(sql).toContain("return v_detail - 'projection_complete'");
    expect(sql).toMatch(/event\.metadata, false\s*\) as value/);
    expect(sql).toContain("where public.activity_events.legacy");
    expect(verificationSql).toContain("incomplete_nonlegacy_financial_rows");
  });

  it("installs capture triggers before historical backfill and refreshes on every realtime event", () => {
    expect(sql.indexOf("create trigger operational_events_append_activity")).toBeLessThan(
      sql.indexOf("from public.operational_events event")
    );
    expect(normalizedGatewaySource).toContain("sourceEventId: event.id");
    expect(appSource).toContain("latestActivityEventId");
    expect(appSource).toContain("activityRefreshKey = `${remoteVersion}:${latestActivityEventId}");
  });

  it("provides authenticated keyset pagination and server-side filters", () => {
    expect(sql).toContain("create or replace function public.list_activity_events");
    expect(sql).toContain("(event.occurred_at, event.id) < (v_cursor_at, v_cursor_id)");
    expect(sql).toContain("limit v_limit + 1");
    expect(sql).toContain("grant execute on function public.list_activity_events(jsonb) to authenticated");
    expect(sql).toContain("at time zone 'Asia/Kolkata'");
  });
});
