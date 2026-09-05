import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("checkout replacement/downstream parity staging harness", () => {
  it("is a single-worker zero-retry staging-only execution", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const runner = read("scripts/run-checkout-replacement-parity-staging-e2e.mjs");
    const config = read("playwright.replacement-parity.staging.config.ts");
    expect(packageJson.scripts["test:e2e:staging:v2:replacement-parity"]).toContain("run-checkout-replacement-parity-staging-e2e.mjs");
    expect(packageJson.scripts["test:e2e:staging:v2:replacement-parity:list"]).toContain("--list");
    expect(runner).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(runner).toContain("productionAllowed: false");
    expect(runner).toContain("safeForAutomaticRetry: false");
    expect(config).toContain("workers: 1");
    expect(config).toContain("retries: 0");
    expect(config).toContain('trace: "off"');
  });

  it("fails preflight closed on bundle identity, active admins, empty floor, collisions, and drift", () => {
    const source = read("scripts/preflight-checkout-replacement-parity-staging.mjs");
    expect(source).toContain("body.includes(PRODUCTION_PROJECT_REF)");
    expect(source).toContain('role.data !== "admin"');
    expect(source).toContain("openSessions.data.length === 0 && openTabs.data.length === 0");
    expect(source).toContain("collisionsEmpty");
    expect(source).toContain("E2E_V2_REPLACEMENT_CUSTOMER");
    expect(source).toContain('throw new Error("reviewed_preflight_drift")');
    expect(source).toContain('safeForAutomaticRetry: false');
    expect(source).toContain('flag: "wx"');
  });

  it("captures every mutation before submission and proves quantity two to one", () => {
    const source = read("tests/e2e/staging/release-b-checkout-replacement-parity-v2.e2e.ts");
    expect(source).toContain("fs.linkSync(temporary, target)");
    expect(source.indexOf("const responsePath = writeEvidence")).toBeLessThan(source.indexOf("await triggerPromise;"));
    for (const rpc of ["commit_admin_data_change", "open_customer_tab", "add_customer_tab_item", "update_customer_tab_item_quantity", "commit_checkout_bill_v2"]) {
      expect(source).toContain(`**/rest/v1/rpc/${rpc}`);
    }
    expect(source).toContain('await expect(replacementQuantity).toHaveValue("2")');
    expect(source).toContain('await replacementQuantity.fill("1")');
    expect(source).toContain("bill_updates.filter((bill) => bill.id === primaryBillId && bill.billNumber === billNumber)");
    expect(source).toContain("replaceAll(previousBillNumber, billNumber)");
    expect(source).toContain('expectedStockDelta: 1');
    expect(source).toContain('[[originalBillId, "sale", -2], [replacementBillId, "void_refund_reversal", 1]]');
    expect(source).toContain("expect(await appStateSnapshot(observer.page, observerIdentity)).toEqual(financialState)");
  });

  it("hard-refreshes two contexts and covers every normalized downstream consumer", () => {
    const source = read("tests/e2e/staging/release-b-checkout-replacement-parity-v2.e2e.ts");
    expect(source).toContain("Promise.all([page.reload");
    expect(source).toContain('name: "Bill Register"');
    expect(source).toContain('getByText("Replaces"');
    expect(source).toContain('name: /^Receivables \\(\\d+\\)$/');
    expect(source).toContain('locator("tr.receivable-row")');
    expect(source).toContain('locator("tr.receivable-detail-row").filter({ hasText: pendingBillNumber })');
    expect(source).toContain('name: "Analytics"');
    expect(source).toContain('name: "Customer Profiles"');
    expect(source).toContain('name: "Inventory"');
    expect(source).toContain('name: "Inventory Report"');
    expect(source).toContain('"1 visits"');
    expect(source).toContain('[itemName, "Beverages", "Active", "0", "2", "0", "1", "-1", "4", "0"]');
    expect(source).toContain('getByRole("cell", { name: "Sale", exact: true })');
    expect(source).toContain('getByRole("cell", { name: "Void/Refund Restore", exact: true })');
  });

  it("reconciles canonical financial, stock, actor, floor, and compatibility evidence", () => {
    const source = read("scripts/reconcile-checkout-replacement-parity-staging.mjs");
    for (const table of ["inventory_items", "customer_tabs", "customer_tab_items", "bills", "bill_lines", "payments", "stock_movements", "audit_logs", "operational_events", "app_state"]) {
      expect(source).toContain(`"${table}"`);
    }
    expect(source).toContain('client.rpc("get_financial_mutation_result"');
    expect(source).not.toContain('from("financial_mutations")');
    expect(source).toContain("quantity 2 to 1");
    expect(source).toContain("exact -2 sale and +1 reversal");
    expect(source).toContain("Canonical mutation result differs");
    expect(source).toContain("financial.inventory_expectations");
    expect(source).toContain("row.bill_id === financial.primary_bill.id");
    expect(source).toContain("event id/type/entity/actor");
    expect(source).toContain("audit changed_rows differ from command");
    expect(source).toContain("safeForIdentityBoundCleanup");
    expect(source).toContain("deterministicFinancialRejections");
    expect(source).toContain("deterministic rejection unexpectedly has a canonical mutation result");
    expect(source).toContain('flag: "wx"');
  });

  it("keeps recovery cleanup SHA-bound, exact, and read-only in postflight", () => {
    const runner = read("scripts/run-checkout-replacement-parity-cleanup-staging-e2e.mjs");
    const scenario = read("tests/e2e/staging/release-b-checkout-replacement-parity-cleanup.e2e.ts");
    const postflight = read("scripts/reconcile-checkout-replacement-parity-cleanup-staging.mjs");
    expect(runner).toContain("E2E_REPLACEMENT_PARITY_RECOVERY_SHA256");
    expect(runner).toContain('["reconciliation", "reanalysis"]');
    expect(runner).toContain("safeForIdentityBoundCleanup !== true");
    expect(runner).toContain('recovery.status !== "partial"');
    expect(runner).toContain("Cleanup run ID must be fresh and distinct");
    expect(runner).toContain("Cleanup run ID collides with existing artifacts");
    expect(scenario).toContain("recovery-revalidated");
    expect(scenario).toContain("submitted-once-response-pending");
    expect(scenario).toContain("get_financial_mutation_result");
    expect(scenario).toContain('interceptSingleRpcCommand(page, "**/rest/v1/rpc/reject_customer_tab")');
    expect(scenario).toContain('interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_admin_data_change")');
    expect(scenario).toContain("snapshot.appState.version + actions.length");
    expect(scenario).toContain("fs.linkSync(temporary, target)");
    expect(postflight).toContain("Source bills changed during cleanup.");
    expect(postflight).toContain("Source payments changed during cleanup.");
    expect(postflight).toContain("Source stock movements changed during cleanup.");
    expect(postflight).toContain("Source operational events changed during cleanup.");
    expect(postflight).toContain("Source audit logs changed during cleanup.");
    expect(postflight).toContain("Canonical financial mutation results changed during cleanup.");
    expect(postflight).toContain("acknowledgement mutation/event/entity is not exact");
    expect(postflight).toContain("Rejected customer tab for ${snapshot.tabs[0].customer_name}. Reason:");
    expect(postflight).toContain("E2E_REPLACEMENT_PARITY_CLEANUP_REANALYZE");
    expect(postflight).toContain("Final staging floor is not empty.");
    expect(postflight).not.toMatch(/\.(insert|upsert|delete)\(/);
    expect(postflight).not.toContain(".update({");
  });
});
