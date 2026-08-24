import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/phase6-admin-data-change-rpc.sql"),
  "utf8"
).replace(/\r\n/g, "\n");
const stagingProof = readFileSync(
  resolve(
    process.cwd(),
    "openspec/changes/financial-checkout-app-state-decoupling/release-b-admin-inventory-precondition-proof.sql"
  ),
  "utf8"
);
const authorizationProof = readFileSync(
  resolve(
    process.cwd(),
    "openspec/changes/financial-checkout-app-state-decoupling/release-b-admin-data-authorization-proof.sql"
  ),
  "utf8"
);

describe("admin inventory concurrency SQL contract", () => {
  it("locks affected normalized inventory rows in deterministic order", () => {
    expect(sql).toContain("as affected_inventory\n    order by id");
    expect(sql).toMatch(
      /from public\.inventory_items\s+where organization_id = v_organization_id and id = v_lock_id\s+for update;/
    );
  });

  it("rejects missing or stale stock preconditions for existing items", () => {
    expect(sql).toContain("left join public.inventory_items as current_item");
    expect(sql).toContain("when current_item.id is null then source.item ? 'expectedStockQty'");
    expect(sql).toContain("when jsonb_typeof(source.item->'expectedStockQty') is distinct from 'number' then true");
    expect(sql).toContain(
      "(source.item->>'expectedStockQty')::numeric is distinct from current_item.stock_qty"
    );
    expect(sql).toContain("'inventory_conflict'");
  });

  it("does not persist the concurrency-only field into normalized or compatibility data", () => {
    expect(sql).toContain("- 'expectedStockQty'");
    expect(sql.indexOf("- 'expectedStockQty'")).toBeLessThan(
      sql.indexOf("insert into public.inventory_items")
    );
  });

  it("derives actor attribution and enforces admin inventory authorization", () => {
    expect(sql).toContain("v_actor_user_id uuid := auth.uid()");
    expect(sql).toContain("v_client_user_id <> v_user_id");
    expect(sql).toContain("'actor_spoof_rejected'");
    expect(sql).toContain("v_actor_role <> 'admin'::public.app_role");
    expect(sql).toContain("'role_access_denied'");
    expect(sql).toContain("(movement - 'userId') || jsonb_build_object('userId', v_user_id)");
    expect(sql).toContain("(audit - 'userId') || jsonb_build_object('userId', v_user_id)");
  });

  it("retains rollback-only malformed and stale precondition staging cases", () => {
    expect(stagingProof).toContain("This script must never be run against production");
    for (const label of ["missing", "null", "string", "object", "array", "stale-number", "missing-row"]) {
      expect(stagingProof).toContain(`'${label}'`);
    }
    expect(stagingProof).toContain("v_code <> 'inventory_conflict'");
    expect(stagingProof).toContain("rollback;");
    expect(stagingProof).toContain("restored_profile_active");
  });

  it("retains rollback-only receptionist and manager authorization coverage", () => {
    expect(authorizationProof).toContain("This script must never be run against production");
    expect(authorizationProof).toContain("'receptionist'");
    expect(authorizationProof).toContain("'manager'");
    expect(authorizationProof).toContain("Expected receptionist role_access_denied");
    expect(authorizationProof).toContain("Expected manager role_access_denied");
    expect(authorizationProof).toContain("release-b-manager-expense-customer-success");
    expect(authorizationProof).toContain("created_by = v_actor");
    expect(authorizationProof).toContain("expense_rolled_back");
    expect(authorizationProof).toContain("customer_rolled_back");
    expect(authorizationProof).toContain("rollback;");
  });
});
