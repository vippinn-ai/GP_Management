import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("checkout repeat-combo staging fixture harness contract", () => {
  const preflight = read("scripts/preflight-checkout-repeat-combo-fixture-staging.mjs");
  const runner = read("scripts/run-checkout-repeat-combo-fixture-setup-staging-e2e.mjs");
  const scenario = read("tests/e2e/staging/release-b-checkout-repeat-combo-fixture-setup.e2e.ts");
  const reconcile = read("scripts/reconcile-checkout-repeat-combo-fixture-staging.mjs");
  const cleanupRunner = read("scripts/run-checkout-repeat-combo-fixture-cleanup-staging-e2e.mjs");
  const cleanupPreflight = read("scripts/preflight-checkout-repeat-combo-fixture-cleanup-staging.mjs");
  const cleanupScenario = read("tests/e2e/staging/release-b-checkout-repeat-combo-fixture-cleanup.e2e.ts");
  const cleanupReconcile = read("scripts/reconcile-checkout-repeat-combo-fixture-cleanup-staging.mjs");
  const config = read("playwright.financial-v2.staging.config.ts");

  it("locks the preflight to staging, an empty floor, unique identities, and an immutable compatibility baseline", () => {
    expect(preflight).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(preflight).toContain("PRODUCTION_PROJECT_REF");
    expect(preflight).toContain("deployedArtifactEvidence");
    expect(preflight).toContain("openSessions.data.length === 0");
    expect(preflight).toContain("openTabs.data.length === 0");
    expect(preflight).toContain("categories.data.length === 1");
    expect(preflight).toContain("itemCollisions.data.length === 0");
    expect(preflight).toContain("comboCollisions.data.length === 0");
    expect(preflight).toContain("artifactCollisions.length === 0");
    expect(preflight).toContain("appState: { version: appState.data.version, hash: hash(appState.data.data) }");
    expect(preflight).toContain("flag: \"wx\"");
    expect(preflight).toContain("--verify");
  });

  it("uses one zero-retry UI-only setup selected by an exact reviewed artifact", () => {
    expect(config).toContain("retries: 0");
    expect(config).toContain("workers: 1");
    expect(runner).toContain("accepts only the optional --list");
    expect(runner).toContain("preflight-checkout-repeat-combo-fixture-staging.mjs");
    expect(runner).toContain('"--verify"');
    expect(runner).toContain("release-b-checkout-repeat-combo-fixture-setup.e2e.ts");
    expect(runner).toContain("E2E_RUN_ID = `fixture-${fixtureRunId}`");
  });

  it("creates only the isolated item and combo through two exact admin UI mutations", () => {
    expect(scenario).toContain('getByRole("button", { name: "Create Item", exact: true })');
    expect(scenario).toContain('createItemForm.locator("select").first().selectOption({ label: "Food" })');
    expect(scenario).toContain('getByLabel("Reusable item", { exact: true })');
    expect(scenario).toContain('fill("20")');
    expect(scenario).toContain('getByRole("button", { name: "Create Combo", exact: true })');
    expect(scenario).toContain('comboForm.locator("select").first().selectOption("game")');
    expect(scenario).toContain('getByRole("button", { name: "Add Fixed Item", exact: true })');
    expect(scenario).toContain('fixedRow.locator("select").first().selectOption({ label: itemName })');
    expect(scenario).toContain('response.url().includes("/rest/v1/rpc/commit_admin_data_change")');
    expect(scenario).toContain("preflightVersion + 1");
    expect(scenario).toContain("preflightVersion + 2");
    expect(scenario).toContain('["audit_logs", "inventory_items", "sale_variants"]');
    expect(scenario).toContain('["audit_logs", "combos"]');
    expect(scenario).toContain('event_type: "admin_data_committed"');
    expect(scenario).toContain("expect(movements).toEqual([])");
    expect(scenario).toContain("expect(openSessions).toEqual([])");
    expect(scenario).toContain("expect(openTabs).toEqual([])");
    expect(scenario).toContain("assertNoPageErrors(pageErrors)");
    expect(scenario).toContain('checkpoint("prepared"');
    expect(scenario).toContain('checkpoint("item-created"');
    expect(scenario).toContain('checkpoint("combo-created"');
    expect(scenario).toContain('checkpoint("final"');
    expect(scenario).toContain('flag: "wx"');
    expect(scenario).toContain("await link(temporaryPath, outputPath)");
    expect(scenario).toContain("await expect(fixedRows).toHaveCount(1)");
    expect(scenario).toContain("adminRpcs).toHaveLength(2)");
    expect(scenario).toContain("compatibilityItems).toHaveLength(1)");
    expect(scenario).toContain("compatibilityCombos).toHaveLength(1)");
  });

  it("requires an immutable Playwright attachment and direct database postflight", () => {
    expect(scenario).toContain('attachJson(testInfo, "checkout-repeat-combo-fixture-setup-evidence"');
    expect(reconcile).toContain("summary.tests[0].retry !== 0");
    expect(reconcile).toContain("Fixture evidence identity mismatch");
    expect(reconcile).toContain('"item_only"');
    expect(reconcile).toContain("Fixture item has no stock movements.");
    expect(reconcile).toContain("Staging floor remains empty.");
    expect(reconcile).toContain("Compatibility state advanced exactly once per acknowledged effect.");
    expect(reconcile).toContain("recentEvents.filter");
    expect(reconcile).toContain("reconciledButPlaywrightFailed");
    expect(reconcile).toContain("flag: \"wx\"");
  });

  it("keeps partial-fixture cleanup behind a separate exact-run UI authorization", () => {
    expect(cleanupPreflight).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(cleanupPreflight).toContain("sessions.length === 0 && tabs.length === 0");
    expect(cleanupPreflight).toContain("exactTargets && exactFixedItems");
    expect(cleanupPreflight).toContain("artifactCollisions: collisions");
    expect(cleanupPreflight).toContain('flag: "wx"');
    expect(cleanupRunner).toContain('E2E_FIXTURE_CLEANUP_APPROVED !== `${runId}:${cleanupRunId}`');
    expect(cleanupRunner).toContain("E2E_FIXTURE_CLEANUP_RUN_ID");
    expect(cleanupRunner).toContain("requires a fresh execution ID distinct from the setup ID");
    expect(cleanupRunner).toContain("collides with existing artifacts");
    expect(cleanupRunner).toContain("path.resolve(entryPath) !== path.resolve(preflightPath)");
    expect(cleanupRunner).toContain("childEnv.E2E_RUN_ID = cleanupRunId");
    expect(cleanupRunner).toContain("The immutable fixture postflight is missing.");
    expect(cleanupRunner).toContain("The immutable fixture cleanup preflight is missing.");
    expect(cleanupRunner).toContain("preflight.safeToRun");
    expect(cleanupRunner).toContain('["item_only", "complete"]');
    expect(cleanupScenario).toContain('name: "Archive", exact: true');
    expect(cleanupScenario).toContain('name: "Archive Item", exact: true');
    expect(cleanupScenario).toContain("baselineVersion + expectedEffects");
    expect(cleanupScenario).toContain('checkpoint("prepared"');
    expect(cleanupScenario).toContain('checkpoint("combo-archived"');
    expect(cleanupScenario).toContain('checkpoint("item-archived"');
    expect(cleanupScenario).toContain("await link(temporaryPath, outputPath)");
    expect(cleanupScenario).toContain("assertNoPageErrors(errors)");
    expect(cleanupReconcile).toContain("Cleanup order cannot archive the item before its combo.");
    expect(cleanupReconcile).toContain("Acknowledged cleanup events and actors match.");
    expect(cleanupReconcile).toContain("Cleanup created no new stock movements.");
    expect(cleanupReconcile).toContain("fresh cleanup baseline");
    expect(cleanupReconcile).toContain("preserved the fixture item physical stock quantity");
    expect(cleanupReconcile).toContain("discoveredEvents.filter");
    expect(cleanupReconcile).toContain("reconciledButPlaywrightFailed");
    expect(cleanupReconcile).toContain('flag: "wx"');
  });
});
