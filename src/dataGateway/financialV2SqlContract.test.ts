import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "phase10-financial-v2-rpcs.sql"),
  "utf8"
);
const maintenanceMigration = readFileSync(
  join(process.cwd(), "supabase", "phase11-operational-maintenance-rpcs.sql"),
  "utf8"
);

function functionBody(name: string): string {
  const match = migration.match(
    new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)[\\s\\S]*?\\n\\$\\$;`, "i")
  );
  if (!match) {
    throw new Error(`Unable to find ${name} in the v2 migration.`);
  }
  return match[0];
}

function maintenanceFunctionBody(name: string): string {
  const match = maintenanceMigration.match(
    new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)[\\s\\S]*?\\n\\$\\$;`, "i")
  );
  if (!match) {
    throw new Error(`Unable to find ${name} in the maintenance migration.`);
  }
  return match[0];
}

describe("financial v2 SQL contract", () => {
  it("keeps both mutation RPCs completely independent of app_state", () => {
    for (const name of ["commit_checkout_bill_v2", "commit_financial_adjustment_v2"]) {
      const body = functionBody(name);
      expect(body).not.toMatch(/public\.app_state/i);
      expect(body).not.toMatch(/patch_app_state/i);
      expect(body).not.toMatch(/base_app_state_version/i);
    }
  });

  it("uses a unique mutation record and a canonical committed result", () => {
    expect(migration).toMatch(/primary key \(organization_id, mutation_id\)/i);
    expect(functionBody("commit_checkout_bill_v2")).toMatch(/for update/i);
    expect(functionBody("commit_checkout_bill_v2")).toMatch(/canonical_result = v_result/i);
    expect(functionBody("commit_financial_adjustment_v2")).toMatch(/canonical_result = v_result/i);
  });

  it("derives actors from auth and rejects client actor fields", () => {
    expect(functionBody("commit_checkout_bill_v2")).toMatch(/v_actor_user_id uuid := auth\.uid\(\)/i);
    expect(functionBody("commit_financial_adjustment_v2")).toMatch(/v_actor_user_id uuid := auth\.uid\(\)/i);
    expect(migration).toMatch(/actor_spoof_rejected/i);
    expect(migration).toMatch(/received_by_user_id[\s\S]*p_actor_user_id::text/i);
    expect(migration).toMatch(/user_id[\s\S]*p_actor_user_id::text/i);
  });

  it("locks idempotency, source sessions, tabs, bills, and inventory in the documented order", () => {
    const checkout = functionBody("commit_checkout_bill_v2");
    const mutationLock = checkout.indexOf("pg_advisory_xact_lock(hashtextextended");
    const mutationInsert = checkout.indexOf("insert into public.financial_mutations");
    const sessionLock = checkout.indexOf("foreach v_lock_id in array v_source_session_ids");
    const tabLock = checkout.indexOf("foreach v_lock_id in array v_source_tab_ids");
    const billLock = checkout.indexOf("select distinct id from (");
    const inventoryLock = checkout.indexOf("select distinct value->>'itemId'");
    expect(mutationLock).toBeGreaterThan(0);
    expect(mutationInsert).toBeGreaterThan(mutationLock);
    expect(sessionLock).toBeGreaterThan(mutationInsert);
    expect(tabLock).toBeGreaterThan(sessionLock);
    expect(billLock).toBeGreaterThan(tabLock);
    expect(inventoryLock).toBeGreaterThan(billLock);
  });

  it("serializes identical checkout and adjustment mutation keys without a global row", () => {
    for (const name of ["commit_checkout_bill_v2", "commit_financial_adjustment_v2"]) {
      const body = functionBody(name);
      expect(body).toMatch(
        /pg_advisory_xact_lock\(hashtextextended\(v_organization_id \|\| chr\(31\) \|\| v_mutation_id, 0\)\)/i
      );
      expect(body.indexOf("pg_advisory_xact_lock")).toBeLessThan(
        body.indexOf("insert into public.financial_mutations")
      );
    }
  });

  it("measures complete financial work after mutation commit hydration", () => {
    for (const name of ["commit_checkout_bill_v2", "commit_financial_adjustment_v2"]) {
      const body = functionBody(name);
      expect(body).toMatch(
        /status = 'committed'[\s\S]*v_server_duration_ms := round[\s\S]*'server_duration_ms', v_server_duration_ms[\s\S]*canonical_result = v_result/i
      );
      expect(body).toMatch(/'core_duration_ms', v_server_duration_ms/i);
    }
  });

  it("keeps v2 RPC execution authenticated-only", () => {
    expect(migration).toMatch(/grant execute on function public\.commit_checkout_bill_v2\(jsonb\) to authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.commit_financial_adjustment_v2\(jsonb\) to authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.get_financial_mutation_result\(jsonb\) to authenticated/i);
  });

  it("requires persisted row identities and validates server source metadata", () => {
    const checkout = functionBody("commit_checkout_bill_v2");
    expect(checkout).toMatch(/missing_financial_row_identity/i);
    expect(checkout).toMatch(/source_item_mismatch/i);
    expect(checkout).toMatch(/sold_as_pack_of/i);
    expect(checkout).toMatch(/stock_units_per_sale/i);
    expect(checkout).toMatch(/expected_description/i);
    expect(checkout).toMatch(/format_financial_minutes_v2/i);
    expect(checkout).toMatch(/to_char\(item\.sold_as_pack_of, 'FM999999999999990\.###'\)/i);
    expect(checkout).not.toMatch(/rtrim\(rtrim\(item\.sold_as_pack_of/i);
    expect(checkout).toMatch(/session_charge_mismatch/i);
    expect(checkout).toMatch(/invalid_source_scope/i);
    expect(checkout).toMatch(/invalid_ltp_result/i);
    expect(checkout).toMatch(/invalid_customer_scope/i);
    expect(checkout).toMatch(/replacement_source_mismatch/i);
    expect(checkout).toMatch(
      /v_mode <> 'bill_replacement'\s+and nullif\(line->>'linkedSessionId', ''\) is not null\s+and not \(line->>'linkedSessionId' = any\(v_source_session_ids\)\)/i
    );
    expect(checkout).toMatch(/original_line\.stock_units_per_sale[\s\S]*variant\.stock_units_per_sale/i);
    expect(checkout).toMatch(/current normalized catalog/i);
    expect(checkout).not.toMatch(/full join/i);
    expect(checkout.match(/from expected[\s\S]*?where not exists \([\s\S]*?select 1 from actual/gi)).toHaveLength(2);
    expect(checkout.match(/from actual[\s\S]*?where not exists \([\s\S]*?select 1 from expected/gi)).toHaveLength(2);
  });

  it("requires non-null adjustment expectations before lifecycle changes", () => {
    const adjustment = functionBody("commit_financial_adjustment_v2");
    expect(adjustment).toMatch(/jsonb_typeof\(source\.value->'expectedAmountPaid'\) is distinct from 'number'/i);
    expect(adjustment).toMatch(/jsonb_typeof\(source\.value->'expectedAmountDue'\) is distinct from 'number'/i);
    expect(adjustment).toMatch(/current_bill\.status is distinct from expectation->>'expectedStatus'/i);
    expect(adjustment).toMatch(/expectedStatus' is distinct from 'issued'/i);
    expect(adjustment).toMatch(/jsonb_typeof\(source\.value->'amountPaid'\) is distinct from 'number'/i);
    expect(adjustment).toMatch(/status' is distinct from 'voided'/i);
  });

  it("server-stamps financial event and lifecycle timestamps", () => {
    expect(migration).toMatch(/p_transaction_at timestamptz/i);
    expect(migration).toMatch(/createdAt', p_transaction_at, 'issuedAt', p_transaction_at/i);
    expect(migration).toMatch(/payment \|\| jsonb_build_object\('createdAt', p_transaction_at/i);
    expect(migration).toMatch(/movement \|\| jsonb_build_object\('createdAt', p_transaction_at/i);
    expect(migration).toMatch(/audit \|\| jsonb_build_object\([\s\S]*'createdAt', p_transaction_at/i);
    expect(migration).toMatch(/bill[\s\S]*- 'voidedAt'[\s\S]*- 'settledAt'/i);
  });

  it("whitelists audit actions and settlement receipt linkage", () => {
    const checkout = functionBody("commit_checkout_bill_v2");
    const adjustment = functionBody("commit_financial_adjustment_v2");
    expect(checkout).toMatch(/invalid_settlement_linkage/i);
    expect(checkout).toMatch(/payment->>'relatedCheckoutBillId' is distinct from v_bill_id/i);
    expect(checkout).toMatch(/source\.value->>'action' = 'session_checkout_details_updated'/i);
    expect(checkout).toMatch(/source\.value->>'action' = 'ltp_discount_applied'/i);
    expect(checkout).toMatch(/group by source\.value->>'entityType', source\.value->>'entityId', source\.value->>'action'/i);
    expect(adjustment).toMatch(/jsonb_array_length\(v_audit_logs\) <> jsonb_array_length\(v_bills\)/i);
    expect(adjustment).toMatch(/audit\.value->>'action' is distinct from case v_mutation_kind/i);
    expect(adjustment).toMatch(/jsonb_array_length\(v_bills\) > 1[\s\S]*count\(distinct value->>'settlementGroupId'\)/i);
  });

  it("reconstructs detailed financial audit messages from locked server facts", () => {
    expect(migration).toMatch(/when 'bill_settled' then 'Settled Rs '[\s\S]*during checkout[\s\S]*Remaining due: Rs/i);
    expect(migration).toMatch(/when 'bill_replaced' then 'Issued replacement '[\s\S]*join public\.bills as original[\s\S]*Reason:/i);
    expect(migration).toMatch(/when 'session_checkout_details_updated' then[\s\S]*start time:[\s\S]*end time:[\s\S]*customer name:[\s\S]*customer phone:/i);
    expect(functionBody("commit_checkout_bill_v2")).toMatch(
      /endedAt'\)::timestamptz is distinct from current_session\.ended_at/i
    );
    expect(functionBody("commit_checkout_bill_v2")).toMatch(
      /session_checkout_details_updated'[\s\S]*<> \([\s\S]*current_session\.ended_at/i
    );
    expect(functionBody("commit_checkout_bill_v2")).not.toMatch(/endedAt'[\s\S]{0,160}> 60/i);
    expect(migration).toMatch(/when 'customer_tab_checkout_details_updated' then[\s\S]*customer name:[\s\S]*customer phone:/i);
    expect(migration).toMatch(/pre-checkout values[\s\S]*apply_financial_v2_rows[\s\S]*update public\.sessions/i);
  });

  it("allows first-close timing for ordinary staff but rejects their start or persisted-end edits", () => {
    const checkout = functionBody("commit_checkout_bill_v2");
    expect(checkout).toMatch(
      /current_session\.id = case when v_mode = 'session'[\s\S]*current_user_org_role\(v_organization_id\) <> 'admin'::public\.app_role/i
    );
    expect(checkout).toMatch(
      /startedAt'\)::timestamptz is distinct from current_session\.started_at[\s\S]*current_session\.ended_at is not null[\s\S]*endedAt'\)::timestamptz is distinct from current_session\.ended_at/i
    );
    expect(checkout).toMatch(/raise_operational_rpc_error\('invalid_session_timing'/i);
  });

  it("keeps normalized pause maintenance independent of app_state", () => {
    expect(maintenanceMigration).not.toMatch(/public\.app_state/i);
    expect(maintenanceMigration).not.toMatch(/patch_app_state/i);
    for (const name of ["edit_pause_log", "delete_pause_log", "record_session_audit"]) {
      expect(maintenanceMigration).toMatch(new RegExp(`grant execute on function public\\.${name}\\(jsonb\\) to authenticated`, "i"));
    }
    expect(maintenanceMigration).toMatch(/v_paused_at < v_session_started_at/i);
    expect(maintenanceMigration).toMatch(/v_audit->>'action' <> 'hop_continuation_detached'/i);
    expect(maintenanceMigration).toMatch(/'action', 'hop_continuation_detached'/i);
    expect(maintenanceMigration.match(/v_event_at timestamptz := now\(\)/gi)).toHaveLength(3);
    expect(maintenanceMigration).not.toMatch(/'createdAt', timezone\('utc', now\(\)\)/i);
    for (const name of ["edit_pause_log", "delete_pause_log", "record_session_audit"]) {
      const body = maintenanceFunctionBody(name);
      expect(body).toMatch(/v_event_at timestamptz := now\(\)/i);
      expect(body).toMatch(/audit_at, user_id, raw_data\)[\s\S]*v_event_at, v_actor::text/i);
      expect(body).toMatch(/'createdAt', v_event_at/i);
      expect(body).toMatch(/'server_time', v_event_at/i);
    }
  });
});
