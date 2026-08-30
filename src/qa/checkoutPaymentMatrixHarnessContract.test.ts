import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("checkout payment matrix staging harness", () => {
  it("exposes only exact named zero-retry Playwright modes", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const runner = read("scripts/run-checkout-payment-matrix-staging-e2e.mjs");
    const config = read("playwright.payment-matrix.staging.config.ts");
    for (const mode of ["upi", "split", "partial-previous-dues"]) {
      expect(packageJson.scripts[`test:e2e:staging:v2:payment-matrix:${mode}`]).toContain("run-checkout-payment-matrix-staging-e2e.mjs");
      expect(packageJson.scripts[`test:e2e:staging:v2:payment-matrix:${mode}:list`]).toContain("-list");
    }
    expect(runner).toContain("requires exactly one named case");
    expect(runner).toContain("E2E_PAYMENT_MATRIX_CASE = mode.selectedCase");
    expect(runner).toContain('safeForAutomaticRetry: false');
    expect(runner).toContain('productionAllowed: false');
    expect(config).toContain("workers: 1");
    expect(config).toContain("retries: 0");
    expect(config).toContain('trace: "off"');
  });

  it("fails closed on staging identity, floor, collision, pricing, and app-state drift", () => {
    const source = read("scripts/preflight-checkout-payment-matrix-staging.mjs");
    expect(source).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(source).toContain("bundle.includes(PRODUCTION_PROJECT_REF)");
    expect(source).toContain('role.data !== "admin"');
    expect(source).toContain("openSessions.data.length === 0 && openTabs.data.length === 0");
    expect(source).toContain('station?.mode === "timed" && station.active === true && stationPricing.length > 0');
    expect(source).toContain("sessionCollisions.data.length === 0 && billCollisions.data.length === 0 && artifactCollisions.length === 0");
    expect(source).toContain('throw new Error("reviewed_preflight_drift")');
    expect(source).toContain('flag: "wx"');
    expect(source).toContain("safeForAutomaticRetry: false");
    expect(source).toContain("productionAllowed: false");
  });

  it("covers full UPI, exact split, and partial deferred with split previous dues", () => {
    const source = read("tests/e2e/staging/release-b-checkout-payment-matrix-v2.e2e.ts");
    expect(source).toContain('["upi", "split", "partial_previous_dues"]');
    expect(source).toContain('selectOption("deferred")');
    expect(source).toContain('const collectUpfront = currentCheckout.getByLabel("Collect Upfront (optional)", { exact: true })');
    expect(source).toContain("await collectUpfront.blur()");
    expect(source).toContain('const upfrontMode = currentCheckout.getByRole("combobox", { name: "Upfront Mode", exact: true })');
    expect(source).toContain("await expect(upfrontMode).toBeEnabled()");
    expect(source).toContain('await upfrontMode.selectOption("upi")');
    expect(source).toContain('getByRole("combobox", { name: "Previous Dues Payment", exact: true })');
    expect(source).toContain('await previousDuesMode.selectOption("split")');
    expect(source).toContain('getByRole("textbox", { name: "Previous Cash", exact: true })');
    expect(source).toContain("await previousCash.blur()");
    expect(source).toContain('getByRole("textbox", { name: "Previous UPI", exact: true })');
    expect(source).toContain("await previousUpi.blur()");
    expect(source).toContain("const total = await readCheckoutTotal(checkout)");
    expect(source).toContain('getByText("Total", { exact: true }).locator("..").locator("strong")');
    expect(source).toContain('response.url().includes("/rest/v1/rpc/save_live_session_details")');
    expect(source).toContain('"The edited start time must be acknowledged before checkout opens."');
    expect(source).toContain("toHaveValue(expectedStart)");
    expect(source).toContain("toHaveValue(expectedEnd)");
    expect(source).toContain("await readCheckoutTotal(checkout)");
    expect(source).toContain('getByLabel("UPI Amount", { exact: true }).fill(String(upiAmount))');
    expect(source).toContain('getByLabel("Cash Amount", { exact: true })).toHaveValue("10")');
    expect(source).toContain('financialWindows[1].after = await appStateSnapshot');
    expect(source).toContain("expect(financialWindows[1].after).toEqual(currentBefore)");
    expect(source).toContain('interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2")');
    expect(source.indexOf('writeEvidence(`${label}-prepared`')).toBeLessThan(source.indexOf("command.submit(envelope)"));
    expect(source).toContain('writeEvidence(`${label}-response`');
    expect(source).toContain("expect(command.captureCount()).toBe(1)");
    expect(source).toContain("expect(command.wasSubmitted()).toBe(true)");
    expect(source).toContain("assertEvidenceContainsNoSecrets");
    expect(source).not.toContain("rejectSessionIfOpen");
    expect(source.indexOf('await signIn(page, credentials("A"))')).toBeLessThan(source.indexOf('await signIn(observer.page, credentials("B"))'));
    expect(source).toContain('safeForAutomaticRetry: false');
    expect(source).toContain('flag: "wx"');
    expect(source).not.toContain("authorization:");
  });

  it("reconciles every money row, actor, mutation, event, audit, floor, and compatibility window", () => {
    const source = read("scripts/reconcile-checkout-payment-matrix-staging.mjs");
    for (const table of ["sessions", "bills", "bill_lines", "payments", "bill_line_discounts", "bill_discounts", "stock_movements", "operational_events", "audit_logs"]) {
      expect(source).toContain(`"${table}"`);
    }
    expect(source).toContain('supabase.rpc("get_financial_mutation_result"');
    expect(source).toContain('actual.received_by_user_id === actorId');
    expect(source).toContain('payments.length === 2 && cash.length === 1 && upi.length === 1');
    expect(source).toContain('currentPayments.length === 1 && currentPayments[0].mode === "upi"');
    expect(source).toContain('sourcePayments.every((row) => row.related_checkout_bill_id === currentId)');
    expect(source).toContain('row.action === "bill_settled"');
    expect(source).toContain('window.before?.version === window.after.version && window.before?.hash === window.after.hash');
    expect(source).toContain('openSessions.length === 0 && openTabs.length === 0');
    expect(source).toContain('outcome === "ambiguous"');
    expect(source).toContain('same(canonical, operation.responseBody)');
    expect(source).toContain('event.metadata?.mutation_kind === "commitCheckoutBill"');
    expect(source).toContain('Run-wide payment identities contain a missing or extra row.');
    expect(source).toContain("runFinancialAudits");
    expect(source).toContain('"bill_pending"');
    expect(source).toContain('integrityFailures.length === 0 && ambiguous.length === 0');
    expect(source).toContain("assertNoSecrets(report)");
    expect(source).toContain('safeForAutomaticRetry: false');
    expect(source).toContain('flag: "wx"');
  });

  it("keeps recovery cleanup SHA-bound, identity-bound, and financially read-only", () => {
    const runner = read("scripts/run-checkout-payment-matrix-cleanup-staging-e2e.mjs");
    const scenario = read("tests/e2e/staging/release-b-checkout-payment-matrix-cleanup.e2e.ts");
    const postflight = read("scripts/reconcile-checkout-payment-matrix-cleanup-staging.mjs");
    expect(runner).toContain("E2E_PAYMENT_MATRIX_RECOVERY_SHA256");
    expect(runner).toContain("safeForIdentityBoundCleanup !== true");
    expect(runner).toContain('recovery.status !== "partial"');
    expect(runner).toContain('recovery.integrityFailures.length !== 0');
    expect(runner).toContain('entry.outcome === "ambiguous"');
    expect(runner).toContain("recursiveArtifactCollisions");
    expect(runner).toContain("cleanupArtifactCollisions.length !== 0");
    expect(runner).toContain("recovery.snapshot.cleanupCandidates.length === 0");
    expect(scenario).toContain("recovery.snapshot.cleanupCandidates");
    expect(scenario).toContain("rejectSessionIfOpen");
    expect(scenario).toContain('interceptSingleRpcCommand(page, "**/rest/v1/rpc/reject_session")');
    expect(scenario.indexOf('checkpoint(`${candidate.id}-prepared`')).toBeLessThan(scenario.indexOf("activeCommand.submit(envelope)"));
    expect(scenario).toContain('checkpoint(`${candidate.id}-acknowledged`');
    expect(scenario).toContain("hash(recoveryRaw!)");
    expect(scenario).toContain('flag: "wx"');
    expect(postflight).toContain("Committed bills changed during cleanup.");
    expect(postflight).toContain("Committed payments changed during cleanup.");
    expect(postflight).toContain("Stock movements changed during cleanup.");
    expect(postflight).toContain("Compatibility version did not advance exactly once per rejection.");
    expect(postflight).toContain("runEvents.map((entry) => entry.id)");
    expect(postflight).toContain("runAudits.map((entry) => entry.id)");
    expect(scenario).toContain("bill_pending");
    expect(postflight).toContain('"bill_pending"');
    expect(postflight).not.toMatch(/\.(insert|upsert|delete)\(/);
    expect(postflight).not.toContain(".update({");
  });
});
