import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("Release B mixed staging performance harness", () => {
  it("exposes one staging-only serial zero-retry command and a read-only list mode", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const runner = read("scripts/run-release-b-mixed-performance-staging-e2e.mjs");
    expect(packageJson.scripts["test:e2e:staging:v2:performance:mixed"]).toBe("node scripts/run-release-b-mixed-performance-staging-e2e.mjs");
    expect(packageJson.scripts["test:e2e:staging:v2:performance:mixed:list"]).toContain("--list");
    expect(runner).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(runner).toContain("assertStagingBaseUrl");
    expect(runner).toContain("assertLiveCredentials(baseEnv)");
    expect(runner).toContain('productionAllowed: false');
    expect(runner).toContain('safeForAutomaticRetry: false');
    expect(runner).toContain('workers: 1');
    expect(runner).toContain('retries: 0');
    expect(runner).toContain("automatic retry is forbidden");
    expect(runner).not.toContain("for (let attempt");
    expect(runner).not.toContain("while (");
  });

  it("runs only the exact three reviewed scenarios with a fresh fail-closed preflight before each", () => {
    const runner = read("scripts/run-release-b-mixed-performance-staging-e2e.mjs");
    expect(runner).toContain('scenarioOrder: ["partial_previous_dues", "replacement_quantity_decrease", "checkout_vs_repeat_combo_simultaneous"]');
    expect(runner.indexOf('"payment preflight"')).toBeLessThan(runner.indexOf('"payment scenario"'));
    expect(runner.indexOf('"replacement preflight"')).toBeLessThan(runner.indexOf('"replacement scenario"'));
    expect(runner.indexOf('"combo-race preflight"')).toBeLessThan(runner.indexOf('"simultaneous combo race"'));
    expect(runner).toContain('["--partial-previous-dues"]');
    expect(runner).toContain('run-checkout-replacement-parity-staging-e2e.mjs');
    expect(runner).toContain('["--simultaneous-only"]');
    expect(runner).toContain('runOnce("simultaneous combo-race reconciliation"');
    expect(runner).toContain("E2E_REPEAT_COMBO_RECONCILE_RUN_ID: ids.combo");
    expect(runner).toContain("No staging combo fixture satisfies the reviewed stock and pricing preflight.");
  });

  it("records monotonic submit, response, and UI-terminal timing in every scenario", () => {
    for (const file of [
      "tests/e2e/staging/release-b-checkout-payment-matrix-v2.e2e.ts",
      "tests/e2e/staging/release-b-checkout-replacement-parity-v2.e2e.ts",
      "tests/e2e/staging/release-b-checkout-repeat-combo-race-v2.e2e.ts"
    ]) {
      const source = read(file);
      expect(source).toContain("monotonicMs: performance.now()");
      expect(source).toContain("browserCompletionMs");
      expect(source).toContain("toBeLessThan(7_000)");
      expect(source).toContain("responseMs");
    }
  });

  it("SHA-binds exact terminal and reconciliation identities and enforces every acceptance threshold", () => {
    const reconciler = read("scripts/reconcile-release-b-mixed-performance-staging.mjs");
    for (const source of [
      "paymentTerminal", "paymentReconciliation", "replacementTerminal",
      "replacementReconciliation", "comboTerminal", "comboPostflight"
    ]) expect(reconciler).toContain(`${source}: readBound`);
    expect(reconciler).toContain('createHash("sha256")');
    expect(reconciler).toContain("samePath(paymentReconciliation.browserEvidence, source.paymentTerminal.path)");
    expect(reconciler).toContain("paymentReconciliation.browserEvidenceSha256 === source.paymentTerminal.sha256");
    expect(reconciler).toContain("samePath(replacementReconciliation.evidence?.terminal?.path, source.replacementTerminal.path)");
    expect(reconciler).toContain("replacementReconciliation.evidence?.terminal?.sha256 === source.replacementTerminal.sha256");
    expect(reconciler).toContain("samePath(comboClassification?.artifactPath, source.comboTerminal.path)");
    expect(reconciler).toContain("comboClassification?.artifactSha256 === source.comboTerminal.sha256");
    expect(reconciler).toContain("submission.monotonicMs <= response.monotonicMs");
    expect(reconciler).toContain("value.browserCompletionMs >= 7_000");
    expect(reconciler).toContain("databaseP95Ms < 2_000 && databaseMaxMs < 5_000");
    expect(reconciler).toContain("expectedDatabaseSampleCount = checkoutSucceeded ? 5 : 4");
    expect(reconciler).toContain("requiredContentionWinnerResponseMs: \"<5000\"");
    expect(reconciler).toContain("\\b57014\\b|deadlock detected|statement timeout|client timeout|timed out|timeout.*exceeded");
    expect(reconciler).toContain("checkoutSubmissionCount === 1");
    expect(reconciler).toContain("comboSubmissionCount === 1");
    expect(reconciler).toContain("checkoutCaptureCount === 1");
    expect(reconciler).toContain("comboCaptureCount === 1");
    expect(reconciler).toContain("comboSnapshot?.openSessions?.length === 0");
    expect(reconciler).toContain("comboSnapshot?.openTabs?.length === 0");
    expect(reconciler).toContain("paymentSnapshot?.mutationStatuses?.length === 2");
    expect(reconciler).toContain("replacementSnapshot?.mutationStatuses?.length === 2");
    expect(reconciler).toContain("comboWinnerEffects");
    expect(reconciler).toContain("comboFinalStateBound");
    expect(reconciler).toContain('flag: "wx"');
    expect(reconciler).toContain('productionAllowed: false');
    expect(reconciler).toContain('safeForAutomaticRetry: false');
  });
});
