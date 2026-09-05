import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("fractional session replacement staging harness", () => {
  it("uses one exact staging-only zero-retry identity from preflight through the browser", () => {
    const runner = read("scripts/run-fractional-session-replacement-staging-e2e.mjs");
    const preflight = read("scripts/preflight-checkout-replacement-parity-staging.mjs");
    const browser = read("tests/e2e/staging/release-b-replacement-v2.e2e.ts");

    expect(runner).toContain('env.E2E_V2_REPLACEMENT_CUSTOMER = `QA V2 Replace ${env.E2E_RUN_ID}`');
    expect(runner).toContain('env.E2E_V2_FRACTIONAL_TIMED_CHARGE = "true"');
    expect(runner).toContain('env.E2E_V2_ORIGINAL_PAYMENT_MODE = "upi"');
    expect(runner).toContain('env.E2E_V2_REPLACEMENT_PAYMENT_MODE = "cash"');
    expect(runner).toContain("safeForAutomaticRetry: false");
    expect(preflight).toContain("E2E_V2_REPLACEMENT_CUSTOMER");
    expect(browser).toContain("E2E_V2_REPLACEMENT_CUSTOMER");
  });

  it("reconciles complete fixture effects rather than trusting only reported row ids", () => {
    const reconciler = read("scripts/reconcile-session-replacement-staging.mjs");

    expect(reconciler).toContain('.eq("customer_name", preflight.fixture.customerName)');
    expect(reconciler).toContain('.in("bill_id", billIds)');
    expect(reconciler).toContain('.in("metadata->>mutation_id", mutationIds)');
    expect(reconciler).toContain("Expected exactly two traced bills.");
    expect(reconciler).toContain("Expected exactly one traced payment per bill.");
    expect(reconciler).toContain("A reported compact event is missing or an unreported event replaced it.");
    expect(reconciler).toContain("app_state changed during v2 checkout/replacement.");
  });
});
