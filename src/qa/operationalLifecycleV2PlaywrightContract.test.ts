import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("operational lifecycle v2 Playwright and performance contract", () => {
  it("locks the reusable runner to staging, the v2 dependency flags, and zero retries", () => {
    const runner = read("scripts/run-operational-v2-staging-e2e.mjs");
    const config = read("playwright.operational-v2.staging.config.ts");
    expect(runner).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(runner).toContain("VITE_BACKEND_OPERATIONAL_RPC_V2");
    expect(runner).toContain("bundle.includes(PRODUCTION_PROJECT_REF)");
    expect(runner).toContain("E2E_EXPECTED_BUNDLE_SHA256");
    expect(runner).toContain("E2E_DB_MANIFEST_SHA256");
    expect(runner).toContain("evidence-manifest-");
    expect(runner).toContain('productionAllowed: false');
    expect(read("scripts/playwright-compact-reporter.mjs")).toContain('flag: "wx"');
    expect(config).toMatch(/retries:\s*0/);
    expect(config).toMatch(/workers:\s*1/);
    expect(config).toMatch(/fullyParallel:\s*false/);
    expect(config).toContain("operational-lifecycle-v2.e2e.ts");
    for (const regressionSpec of [
      "release-a-hop-pause.e2e.ts",
      "release-b-checkout-reject-race-v2.e2e.ts",
      "release-b-checkout-hop-race-v2.e2e.ts",
      "release-b-hopped-concurrency-v2.e2e.ts",
      "release-b-multihop-concurrency-v2.e2e.ts",
      "release-b-role-checkout-hop-timing-v2.e2e.ts"
    ]) expect(config).toContain(regressionSpec);
  });

  it("covers canonical hop, paused rejection, same-ID replay, mismatch, actor, realtime, cleanup, and app_state invariance", () => {
    const spec = read("tests/e2e/staging/operational-lifecycle-v2.e2e.ts");
    for (const marker of [
      "hop_session_v2",
      "reject_session_v2",
      "mutation_identity_mismatch",
      "idempotent: true",
      "authenticatedJwtSubject",
      "operational_events",
      "appStateBefore",
      "appStateAfter",
      "cleanupBillId",
      "serverDurationMs",
      "acknowledgementMs",
      "observer.page.reload"
    ]) expect(spec).toContain(marker);
  });

  it("keeps heavy exports demand-loaded and removes the one-second App render cadence", () => {
    const exporters = read("src/exporters.ts");
    const app = read("src/App.tsx");
    expect(exporters).toMatch(/await import\("xlsx"\)/);
    expect(exporters).toMatch(/await import\("jspdf"\)/);
    expect(app).toContain("useClock(30_000)");
    expect(app).not.toContain("const now = useClock();");
  });
});
