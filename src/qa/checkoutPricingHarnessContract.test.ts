import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("checkout pricing staging harness", () => {
  it("exposes four exact one-worker zero-retry cases", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const runner = read("scripts/run-checkout-pricing-staging-e2e.mjs");
    const config = read("playwright.pricing.staging.config.ts");
    for (const mode of ["discount-rounding-positive", "ltp-zero", "bill-discount-zero", "true-zero-price-guard"]) {
      expect(packageJson.scripts[`test:e2e:staging:v2:pricing:${mode}`]).toContain("run-checkout-pricing-staging-e2e.mjs");
      expect(packageJson.scripts[`test:e2e:staging:v2:pricing:${mode}:list`]).toContain("-list");
    }
    expect(runner).toContain("requires exactly one named case");
    expect(runner).toContain("E2E_PRICING_CASE = mode.selectedCase");
    expect(runner).toContain("productionAllowed: false");
    expect(runner).toContain("safeForAutomaticRetry: false");
    expect(config).toContain("workers: 1");
    expect(config).toContain("retries: 0");
    expect(config).toContain('trace: "off"');
  });

  it("fails preflight closed on staging, actors, empty floor, LTP, unit-sale, collisions, and drift", () => {
    const source = read("scripts/preflight-checkout-pricing-staging.mjs");
    expect(source).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(source).toContain("bundle.includes(PRODUCTION_PROJECT_REF)");
    expect(source).toContain('role.data !== "admin"');
    expect(source).toContain("openSessions.data.length === 0 && openTabs.data.length === 0");
    expect(source).toContain('timedStation.ltp_enabled === true');
    expect(source).toContain('eq("mode", "unit_sale")');
    expect(source).toContain("collisionsEmpty");
    expect(source).toContain('throw new Error("reviewed_preflight_drift")');
    expect(source).toContain('flag: "wx"');
  });

  it("proves positive discounts and rounding plus two distinct subtotal-positive zero-total commits", () => {
    const source = read("tests/e2e/staging/release-b-checkout-pricing-v2.e2e.ts");
    expect(source).toContain('row.getByPlaceholder("required if used", { exact: true })');
    expect(source).toContain('getByLabel("Bill Discount Value", { exact: true })');
    expect(source).toContain('summaryAmount(checkout, "Round Off")');
    expect(source).toContain('getByRole("combobox", { name: "LTP Result", exact: true }).selectOption("won")');
    expect(source).toContain('LTP win - game charge waived');
    expect(source).toContain('getByRole("combobox", { name: "Bill Discount Type", exact: true }).selectOption("percentage")');
    expect(source).toContain('await value.fill("100")');
    expect(source).toContain('submitCaptured(page, "**/rest/v1/rpc/commit_checkout_bill_v2"');
    expect(source).toContain("authoritativePreSubmitSessions");
    expect(source).toContain('page.reload({ waitUntil: "domcontentloaded" })');
    expect(source).toContain("const reloadedManaged = await openManagedSession");
    expect(source).toContain("fs.linkSync(temporary, target)");
    expect(source.indexOf("const responsePath = writeEvidence")).toBeLessThan(source.indexOf("await triggerPromise;"));
    expect(source).toContain("expect(afterFinancial).toEqual(beforeFinancial)");
    expect(source).toContain('safeForAutomaticRetry: false');
  });

  it("keeps the true-zero guard pre-submit and uses a unique Arcade fixture", () => {
    const source = read("tests/e2e/staging/release-b-checkout-pricing-v2.e2e.ts");
    expect(source).toContain('selectOption({ label: "Arcade" })');
    expect(source).toContain('getByLabel("Price", { exact: true }).fill("0")');
    expect(source).toContain('submitCaptured(page, "**/rest/v1/rpc/commit_admin_data_change"');
    expect(source).toContain('submitCaptured(page, "**/rest/v1/rpc/start_session"');
    expect(source).toContain("await expect(issue).toBeDisabled()");
    expect(source).toContain('toHaveAttribute("title", "Bill total is Rs 0 - add items or remove discounts")');
    expect(source).toContain("expect(financialRequests).toEqual([])");
    expect(source).not.toContain("rejectSessionIfOpen");
  });

  it("reconciles every acknowledged lifecycle and authorizes only exact identity-bound cleanup", () => {
    const source = read("scripts/reconcile-checkout-pricing-staging.mjs");
    for (const table of ["sessions", "bills", "bill_lines", "payments", "bill_line_discounts", "bill_discounts", "stock_movements", "operational_events", "audit_logs"]) expect(source).toContain(`"${table}"`);
    expect(source).toContain('supabase.rpc("get_financial_mutation_result"');
    expect(source).toContain("Number(Number(value ?? 0).toFixed(2))");
    expect(source).toContain("Session detail edit was submitted once but is not canonically recoverable");
    expect(source).toContain("canonicalSessionAuditMessageIsExact");
    expect(source).toContain("runFinancialAudits");
    expect(source).toContain("Pricing-only checkout unexpectedly wrote stock movements.");
    expect(source).toContain("evidenceLineage");
    expect(source).toContain("ambiguities");
    expect(source).toContain('lineDiscounts[0].reason === "LTP win - game charge waived"');
    expect(source).toContain('billDiscounts[0].discount_type === "percentage"');
    expect(source).toContain("safeForIdentityBoundCleanup");
    expect(source).toContain('else if (safeForIdentityBoundCleanup) status = "partial"');
    expect(source).toContain('flag: "wx"');
  });

  it("keeps all partial cleanup SHA-bound, collision-free, exact, and read-only in postflight", () => {
    const runner = read("scripts/run-checkout-pricing-zero-cleanup-staging-e2e.mjs");
    const scenario = read("tests/e2e/staging/release-b-checkout-pricing-zero-cleanup.e2e.ts");
    const postflight = read("scripts/reconcile-checkout-pricing-zero-cleanup-staging.mjs");
    expect(runner).toContain("E2E_PRICING_RECOVERY_SHA256");
    expect(runner).toContain("safeForIdentityBoundCleanup !== true");
    expect(runner).toContain('recovery.status !== "partial"');
    expect(runner).toContain("recovery.ambiguities.length !== 0");
    expect(runner).toContain("Cleanup run ID collides with existing artifacts");
    expect(runner).toContain("Cleanup run ID must be fresh and distinct");
    expect(scenario).toContain("rejectSessionIfOpen");
    expect(scenario).toContain('submitCaptured(page, "**/rest/v1/rpc/reject_session"');
    expect(scenario).toContain('submitCaptured(page, "**/rest/v1/rpc/commit_admin_data_change"');
    expect(scenario).toContain("baselineVersion + expectedEffects");
    expect(scenario).toContain("fs.linkSync(temporary, target)");
    expect(scenario).toContain("verifiedSnapshot");
    expect(scenario).toContain("recovery.snapshot.runEvents");
    expect(scenario).toContain("recovery.snapshot.sessionItems");
    expect(scenario).toContain("recovery.snapshot.billDiscounts");
    expect(scenario.indexOf("const responsePath = checkpoint")).toBeLessThan(scenario.indexOf("await ui;"));
    expect(postflight).toContain("Source bills changed during cleanup.");
    expect(postflight).toContain("Source item movements changed during cleanup.");
    expect(postflight).toContain("Source evidence lineage changed at");
    expect(postflight).toContain("Reject-session event identity/actor/version/changed_rows is not exact.");
    expect(postflight).toContain("Archive event identity/actor/version/changed_rows is not exact.");
    expect(postflight).toContain("The run contains an extra or missing source/cleanup event.");
    expect(postflight).toContain("recovery.appState.version) + expectedEffects");
    expect(postflight).toContain("fs.linkSync(temporary, target)");
    expect(postflight).not.toMatch(/\.(insert|upsert|delete)\(/);
    expect(postflight).not.toContain(".update({");
  });
});
