import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

describe("checkout-refund staging race harness", () => {
  it("exposes one dedicated zero-retry execution and read-only discovery", () => {
    const packageJson = read("package.json");
    const runner = read("scripts/run-checkout-refund-race-staging-e2e.mjs");
    expect(packageJson).toContain('"test:e2e:staging:v2:checkout-refund-race"');
    expect(packageJson).toContain('"test:e2e:staging:v2:checkout-refund-race:list"');
    expect(packageJson).toContain('"test:db:staging:v2:checkout-refund-race:preflight"');
    expect(packageJson).toContain('"test:db:staging:v2:checkout-refund-race:reconcile"');
    expect(runner).toContain('argument !== "--list"');
    expect(runner).toContain("release-b-checkout-refund-race-v2.e2e.ts");
    expect(runner).toContain("preflight-checkout-refund-race-staging.mjs");
  });

  it("preflights exact staging identity, empty floor, fresh fixture, bundle, actors, and compatibility", () => {
    const source = read("scripts/preflight-checkout-refund-race-staging.mjs");
    expect(source).toContain("STAGING_PROJECT_REF");
    expect(source).toContain("PRODUCTION_PROJECT_REF");
    expect(source).toContain('role.data !== "admin"');
    expect(source).toContain("openSessions.data.length === 0");
    expect(source).toContain("openTabs.data.length === 0");
    expect(source).toContain("artifactCollisions.length === 0");
    expect(source).toContain('openingStock: 2, price: 50');
    expect(source).toContain("!reviewed.safeToRun || !evidence.safeToRun");
    expect(source).toContain("reviewed_preflight_drift");
    expect(source).toContain('flag: "wx"');
  });

  it("captures checkout and refund once, then submits both simultaneously", () => {
    const source = read("tests/e2e/staging/release-b-checkout-refund-race-v2.e2e.ts");
    expect(source).toContain('name: "Finalize Customer Tab Bill"');
    expect(source).toContain('name: `Void or Refund - ${originalBillNumber}`');
    expect(source).toContain('selectOption("refund")');
    expect(source).toContain('"**/rest/v1/rpc/commit_checkout_bill_v2"');
    expect(source).toContain('"**/rest/v1/rpc/commit_financial_adjustment_v2"');
    expect(source).toContain("checkoutCommand.captureCount()).toBe(1)");
    expect(source).toContain("refundCommand.captureCount()).toBe(1)");
    expect(source).toContain("checkoutCommand.submit(checkoutEnvelope)");
    expect(source).toContain("refundCommand.submit(refundEnvelope)");
    expect(source.indexOf('persistCheckpoint("race-prepared"')).toBeLessThan(
      source.indexOf("checkoutCommand.submit(checkoutEnvelope)")
    );
    expect(source).toContain("raceSubmitted && !raceResolved");
    expect(source).toContain("command.settled");
    expect(source).toContain("quiescenceError");
    expect(source).toContain('flag: "wx"');
    expect(source).toContain('await signIn(page, credentials("A"))');
    expect(source).toContain('await signIn(observer.page, credentials("B"))');
    expect(source).not.toContain('Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))])');
  });

  it("postflight proves canonical finance, stock, actors, normalized-only behavior, and cleanup", () => {
    const source = read("scripts/reconcile-checkout-refund-race-staging.mjs");
    expect(source).toContain('selected.phase !== "final"');
    expect(source).toContain('status: "needs_guarded_recovery"');
    expect(source).toContain("safeForAutomaticRetry: false");
    expect(source).toContain("safeForIdentityBoundCleanup");
    expect(source).toContain("acknowledgedTabIds");
    expect(source).toContain("JSON.stringify(currentTabIds) === JSON.stringify(acknowledgedTabIds)");
    expect(source).toContain("acknowledgedReferencesExact");
    expect(source).toContain("event?.entity_id === result.entity_id");
    expect(source).toContain("event?.metadata?.mutation_id === result.mutation_id");
    expect(source).toContain("resultAudits.length === resultAuditIds.length");
    expect(source).toContain("productionAllowed: false");
    expect(source).toContain("Original canonical mutation result changed");
    expect(source).toContain("Checkout canonical mutation result changed");
    expect(source).toContain("Refund canonical mutation result changed");
    expect(source).toContain("Original bill is not refunded");
    expect(source).toContain("Refund actor is incorrect");
    expect(source).toContain("Stock movement arithmetic is incorrect");
    expect(source).toContain("Physical stock arithmetic is not exactly 2 - 1 - 1 + 1 = 1");
    expect(source).toContain('eventType: "financial_adjustment_committed_v2"');
    expect(source).toContain("Financial event changed_rows mismatch");
    expect(source).toContain("Archive audit identity/type/message/actor is incorrect");
    expect(source).toContain("Financial race changed app_state hash");
    expect(source).toContain("Only the exact archive compatibility write is expected after the race");
    expect(source).toContain("The staging floor is not empty");
    expect(source).toContain('flag: "wx"');
  });

  it("provides separately identified identity-bound cleanup with mandatory postflight", () => {
    const packageJson = read("package.json");
    const runner = read("scripts/run-checkout-refund-race-cleanup-staging-e2e.mjs");
    const scenario = read("tests/e2e/staging/release-b-checkout-replacement-race-cleanup.e2e.ts");
    const postflight = read("scripts/reconcile-checkout-replacement-race-cleanup-staging.mjs");
    expect(packageJson).toContain('"test:e2e:staging:v2:checkout-refund-race:cleanup"');
    expect(packageJson).toContain('"test:db:staging:v2:checkout-refund-race:cleanup-postflight"');
    expect(runner).toContain("safeForIdentityBoundCleanup !== true");
    expect(runner).toContain("safeForAutomaticRetry !== false");
    expect(runner).toContain("productionAllowed !== false");
    expect(runner).toContain("Cleanup E2E_RUN_ID must differ from the fixture run identity");
    expect(runner).toContain("collectCollisions(artifactRoot)");
    expect(runner).toContain('E2E_CLEANUP_RACE_KIND: "refund"');
    expect(scenario).toContain('cleanupKind = process.env.E2E_CLEANUP_RACE_KIND === "refund"');
    expect(scenario).toContain("expectExactAuthorizedRows(items, recoveryItems");
    expect(scenario).toContain("expectExactAuthorizedRows(tabItems, recovery.tabItems");
    expect(scenario).toContain("recovery.mutationKinds?.[index]");
    expect(scenario).toContain("recovery.mutationActors?.[mutationIndex]");
    expect(scenario).toContain('checkpointEvidence("prepared")');
    expect(scenario).toContain('checkpointEvidence(`reject-${index + 1}-acknowledged`)');
    expect(scenario).toContain('checkpointEvidence("archive-acknowledged")');
    expect(postflight).toContain('cleanupKind = env.E2E_CLEANUP_RACE_KIND === "refund"');
    expect(postflight).toContain("Cleanup changed committed bills");
    expect(postflight).toContain("Cleanup changed reservation source rows");
    expect(postflight).toContain("Cleanup created or changed stock movements");
    expect(postflight).toContain("exactly once per acknowledged cleanup command");
    expect(postflight).toContain("Cleanup audit identity/type/message/actor is incorrect");
  });
});
