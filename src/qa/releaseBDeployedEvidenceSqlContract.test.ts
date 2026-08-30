import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = fs.readFileSync(path.join(process.cwd(), "supabase/release-b-final-deployed-evidence-readonly.sql"), "utf8");

describe("Release B deployed evidence SQL probe", () => {
  it("is rollback-only for public data, staging-scoped, and transaction-local", () => {
    expect(sql).toContain("begin isolation level repeatable read;");
    expect(sql).toContain("tkbdyzxwwbhkpztgjjxh");
    expect(sql).toContain("create temp table release_b_deployed_evidence");
    expect(sql).toContain("on commit drop");
    expect(sql).toMatch(/rollback;\s*$/);
    expect(sql).toContain("reviewed_no_public_dml_or_ddl_plus_rollback");
    expect(sql).not.toMatch(/\b(?:insert\s+into|update|delete\s+from|alter\s+table|drop\s+table|create\s+table)\s+public\./i);
  });

  it("never invokes mutation RPCs or EXPLAIN ANALYZE", () => {
    expect(sql).not.toMatch(/select\s+public\.commit_checkout_bill_v2\s*\(/i);
    expect(sql).not.toMatch(/select\s+public\.commit_financial_adjustment_v2\s*\(/i);
    expect(sql).not.toMatch(/explain\s*\([^)]*analyze/i);
    expect(sql).toContain("'explain_analyze_used', false");
    expect(sql).toContain("'mutation_rpc_invoked', false");
    expect(sql).toContain("'row_level_for_update_executed', false");
  });

  it("does not project app_state data and checks deployed source and plans for table access", () => {
    expect(sql).toContain("pg_column_size(data)");
    expect(sql).not.toMatch(/select\s+(?:app_state\.)?data\b/i);
    expect(sql).toContain("'data_was_selected', false");
    expect(sql).toContain("forbidden_app_state_table_token");
    expect(sql).toContain("plan_rows_mentioning_app_state");
  });

  it("captures function hashes, grants, RLS, indexes, exact mutation integrity, and safe lock plans", () => {
    for (const signature of ["commit_checkout_bill_v2(jsonb)", "commit_financial_adjustment_v2(jsonb)", "get_financial_mutation_result(jsonb)"]) {
      expect(sql).toContain(signature);
    }
    expect(sql).toContain("definition_sha256");
    expect(sql).toContain("has_function_privilege");
    expect(sql).toContain("row_level_security_enabled");
    expect(sql).toContain("relevant_index");
    expect(sql).toContain("expected_count', 22");
    expect(sql).toContain("missing_or_duplicate_ids");
    expect(sql).toContain("event_mismatch_ids");
    expect(sql).toContain("all_22_exact");
    expect(sql).toContain("canonical_event_match_count");
    expect(sql).toContain("canonical_metadata_event_match_count");
    expect(sql).not.toContain("and financial.mutation_kind = selected.expected_kind");
    expect(sql).toContain("plan_1_idempotency_lock");
    expect(sql).toContain("plan_5_inventory_lock");
    expect(sql).toContain("release_b_deployed_readonly_evidence");
    expect(sql).toContain("'row_count', count(*)");
    expect(sql).toContain("'rows', jsonb_agg(");
  });
});
