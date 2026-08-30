import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Release B production preparation contract", () => {
  it("keeps environment preparation exact, local, and secret-safe", () => {
    const source = read("scripts/prepare-release-b-production.mjs");

    expect(source).toContain('const productionProjectRef = "rrdwbxvuwrbxefarxnse"');
    expect(source).toContain('const stagingProjectRef = "tkbdyzxwwbhkpztgjjxh"');
    expect(source).toContain('"VITE_BACKEND_FINANCIAL_RPC_V2"');
    expect(source).toContain('"VITE_BACKEND_NORMALIZED_BOOTSTRAP"');
    expect(source).toContain('"VITE_BACKEND_NORMALIZED_REPORT_READS"');
    expect(source).toContain('productionAccessed: false');
    expect(source).toContain('productionWritePerformed: false');
    expect(source).toContain('secretValuesPrinted: false');
    expect(source).not.toContain("VITE_SUPABASE_ANON_KEY=");
  });

  it("binds the four independently accepted staging evidence hashes", () => {
    const source = read("scripts/prepare-release-b-production.mjs");

    for (const hash of [
      "39ad4a4439fbbfcc3e7f4c62537200d0b76050b0e1ff46896978f840e1f07800",
      "43e8ffab19d95f812716914349890ff3bb63ee774d43ecee2f42d808beb84336",
      "fd973cc6243b613a5d5cb8a4edfcf51ac8a583f3d0ede52afb7f67a15f9cc7b7",
      "cdbd15aa163cc583500f0f8080f7fa699391cc1c711c1c57901d063fdd6b2de6"
    ]) {
      expect(source).toContain(hash);
    }
  });

  it("keeps the production SQL probe read-only", () => {
    const sql = read("supabase/release-b-production-preflight-readonly.sql");
    const executableSql = sql.replace(/^\s*--.*$/gm, "");

    expect(executableSql).toMatch(/begin isolation level repeatable read read only/i);
    expect(executableSql).toContain("'open_active_sessions'");
    expect(executableSql).toContain("'open_customer_tabs'");
    expect(executableSql).toContain("'processing_financial_mutations'");
    expect(executableSql).toContain("'financial_v2_functions_with_app_state_reference'");
    expect(executableSql).toMatch(/commit;\s*$/i);
    expect(executableSql).not.toMatch(/\b(insert|update|delete|merge|create|alter|drop|truncate|call)\b/i);
  });

  it("requires explicit approval and exact-version rollback", () => {
    const runbook = read("openspec/changes/financial-checkout-app-state-decoupling/release-b-production-runbook.md");

    expect(runbook).toContain("explicit approval immediately before production access or change");
    expect(runbook).toContain("open_active_sessions");
    expect(runbook).toContain("`processing_financial_mutations` = `0`");
    expect(runbook).toContain("npx wrangler rollback <stable-version-id> --name management");
    expect(runbook).toContain("Do not roll normalized financial data back into stale `app_state`");
  });

  it("verifies a production-only bundle with all v2 endpoints", () => {
    const verifier = read("scripts/verify-release-b-production-build.mjs");

    expect(verifier).toContain('searchable.includes("commit_checkout_bill_v2")');
    expect(verifier).toContain('searchable.includes("commit_financial_adjustment_v2")');
    expect(verifier).toContain('searchable.includes("get_financial_mutation_result")');
    expect(verifier).toContain("stagingProjectAbsent");
    expect(verifier).toContain("secretValuesPrinted: false");
  });
});
