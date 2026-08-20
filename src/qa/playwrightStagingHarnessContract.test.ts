import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("staging Playwright harness contract", () => {
  it("is reproducible and excluded from the Vitest unit run", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const viteConfig = read("vite.config.ts");

    expect(packageJson.devDependencies["@playwright/test"]).toBe("^1.59.1");
    expect(packageJson.scripts["test:e2e:staging"]).toBe("node scripts/run-staging-e2e.mjs");
    expect(viteConfig).toContain('"tests/e2e/**"');
  });

  it("fails closed against production and requires explicit staging mutation confirmation", () => {
    const guard = read("scripts/playwright-staging-env.mjs");
    const runner = read("scripts/run-staging-e2e.mjs");
    const config = read("playwright.staging.config.ts");

    expect(guard).toContain('STAGING_PROJECT_REF = "tkbdyzxwwbhkpztgjjxh"');
    expect(guard).toContain('PRODUCTION_PROJECT_REF = "rrdwbxvuwrbxefarxnse"');
    expect(guard).toContain('STAGING_MUTATION_CONFIRMATION = "release-a-staging-only"');
    expect(guard).toContain("parsed.href !== STAGING_APP_URL");
    expect(guard).toContain("hostname !== expectedHostname");
    expect(guard).toContain('`${STAGING_PROJECT_REF}.supabase.co`');
    expect(guard).toContain('VITE_BACKEND_FINANCIAL_RPC_V2 !== "false"');
    expect(runner).toContain("assertLiveCredentials(env)");
    expect(runner).toContain("verifyDeployedStagingArtifact");
    expect(runner).toContain("!bundle.includes(STAGING_PROJECT_REF) || bundle.includes(PRODUCTION_PROJECT_REF)");
    expect(config).toContain("retries: 0");
    expect(config).toContain('trace: "off"');
    expect(config).toContain('screenshot: "only-on-failure"');
    expect(config).toContain('video: "retain-on-failure"');
  });

  it("uses two browser contexts, compact RPC evidence, and cleanup branches", () => {
    const support = read("tests/e2e/staging/support/app.ts");
    const scenario = read("tests/e2e/staging/release-a-hop-pause.e2e.ts");
    const reporter = read("scripts/playwright-compact-reporter.mjs");

    expect(support).toContain("browser.newContext");
    expect(support).toContain('const marker = "/rest/v1/rpc/"');
    expect(support).toContain('getByText(/^Synced(?:\\s|$)/)');
    expect(scenario).toContain('entry.rpc === "edit_pause_log"');
    expect(scenario).toContain('entry.rpc === "hop_session"');
    expect(scenario).toContain('entry.rpc === "record_session_audit"');
    expect(scenario).toContain("rejectSessionIfOpen");
    expect(support).toContain("Cleanup refused because the station no longer belongs to the exact QA customer.");
    expect(support).toContain("Cleanup refused because the stored session customer no longer matches the exact QA customer.");
    expect(support).toContain('modal.getByLabel("Customer Name", { exact: true })');
    expect(scenario).toContain("billNewestHoppedSession");
    expect(scenario).toContain('changedRowIds(checkout, "sessions").includes(hopSessionId)');
    expect(scenario).toContain('changedRowIds(committedCheckout, "sessions").includes(hopSessionId)');
    expect(scenario).toContain("cleanupBillId = committedCheckout.billId");
    expect(scenario).toContain("cleanupBillingAttempted && !cleanupBilled");
    expect(scenario.match(/sessionStarted = sessionStarted \|\| rpcEvidence\.some/g)).toHaveLength(2);
    expect(scenario).toContain("no automatic retry was issued");
    expect(reporter).toContain("summary-${this.runId}.json");
  });
});
