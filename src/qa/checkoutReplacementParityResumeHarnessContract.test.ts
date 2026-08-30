import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("checkout replacement parity read-only resume harness", () => {
  it("is SHA-bound, staging-only, collision-safe, single-worker, and zero-retry", () => {
    const runner = read("scripts/run-checkout-replacement-parity-resume-staging-e2e.mjs");
    const config = read("playwright.replacement-parity-resume.staging.config.ts");
    expect(runner).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(runner).toContain("checkout-replacement-parity-reanalysis-");
    expect(runner).toContain('AUTHORIZED_SOURCE_RUN_ID = "replacement-parity-20260830-1542"');
    expect(runner).toContain('AUTHORIZED_RECOVERY_SHA256 = "2879af27e847c5b321037f335c5494aac4b8d9dd4749518717eaf65241a087e7"');
    expect(runner).toContain("Recovery artifact SHA-256 mismatch.");
    expect(runner).toContain("Source preflight SHA-256 mismatch.");
    expect(runner).toContain("Resume run ID collides with existing artifacts");
    expect(runner).toContain("readOnly: true");
    expect(runner).toContain("productionAllowed: false");
    expect(config).toContain("workers: 1");
    expect(config).toContain("retries: 0");
    expect(config).toContain('trace: "off"');
  });

  it("revalidates exact source rows and canonical results without mutation", () => {
    const source = read("tests/e2e/staging/release-b-checkout-replacement-parity-resume.e2e.ts");
    for (const table of ["inventory_items", "customer_tabs", "bills", "bill_lines", "payments", "stock_movements", "operational_events", "audit_logs", "sessions", "app_state"]) expect(source).toContain(`"${table}"`);
    expect(source).toContain("get_financial_mutation_result");
    expect(source).toContain('page.route("**/rest/v1/rpc/**"');
    expect(source).toContain("readOnlyRpcAllowlist.has(rpc)");
    expect(source).toContain('route.abort("blockedbyclient")');
    expect(source).toContain("expect(blockedRpcRequests).toEqual([])");
    expect(source).not.toContain("interceptSingleRpcCommand");
    expect(source).not.toMatch(/\.submit\(/);
    expect(source).not.toMatch(/\.(insert|upsert|delete)\(/);
    expect(source).not.toContain(".update({");
    expect(source).toContain("fs.linkSync(temporary, target)");
  });

  it("covers both hard-refresh contexts and every downstream consumer", () => {
    const source = read("tests/e2e/staging/release-b-checkout-replacement-parity-resume.e2e.ts");
    expect(source).toContain("Promise.all([page.reload");
    expect(source).toContain('name: "Bill Register"');
    expect(source).toContain('getByText("Replaces"');
    expect(source).toContain('name: /^Receivables \\(\\d+\\)$/');
    expect(source).toContain('locator("tr.receivable-row").filter({ hasText: pending.customer_name })');
    expect(source).toContain('getByRole("button", { name: "View", exact: true })');
    expect(source).toContain('locator("tr.receivable-detail-row").filter({ hasText: pending.bill_number })');
    expect(source).toContain('name: "Analytics"');
    expect(source).toContain('bill_id: pending.id, bill_number: pending.bill_number, customer_name: pending.customer_name');
    expect(source).toContain('name: "Customer Profiles"');
    expect(source).toContain('name: "Recent Billed Visits", exact: true }).locator("xpath=../..")');
    expect(source).toContain('name: "Inventory"');
    expect(source).toContain('name: "Inventory Report"');
    expect(source).toContain('"1 visits"');
    expect(source).toContain('[ids.itemName, "Beverages", "Active", "0", "2", "0", "1", "-1", "4", "0"]');
    expect(source).toContain('getByRole("cell", { name: "Sale", exact: true })');
    expect(source).toContain('getByRole("cell", { name: "Void/Refund Restore", exact: true })');
    expect(source).toContain('originalMovementRow.locator("td").nth(6)');
    expect(source).toContain("expect(await appStateSnapshot(page, identity)).toEqual(financialState)");
  });
});
