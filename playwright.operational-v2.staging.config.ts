import path from "node:path";
import { defineConfig } from "@playwright/test";
import { assertOperationalRunId, assertStagingBaseUrl, STAGING_APP_URL } from "./scripts/playwright-staging-env.mjs";

const baseURL = assertStagingBaseUrl(process.env.E2E_BASE_URL || STAGING_APP_URL);
const runId = assertOperationalRunId(process.env.E2E_RUN_ID);

export default defineConfig({
  testDir: "./tests/e2e/staging",
  testMatch: [
    "operational-lifecycle-v2.e2e.ts",
    "operational-lifecycle-v2-concurrency.e2e.ts",
    "release-a-hop-pause.e2e.ts",
    "release-a-inventory-matrix.e2e.ts",
    "release-a-report-exports.e2e.ts",
    "release-b-checkout-reject-race-v2.e2e.ts",
    "release-b-checkout-hop-race-v2.e2e.ts",
    "release-b-hopped-concurrency-v2.e2e.ts",
    "release-b-multihop-concurrency-v2.e2e.ts",
    "release-b-role-checkout-hop-timing-v2.e2e.ts"
  ],
  outputDir: path.join("test-artifacts", "playwright", `operational-v2-run-${runId}`),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["line"], ["./scripts/playwright-compact-reporter.mjs", { runId }]],
  use: {
    baseURL,
    browserName: "chromium",
    channel: process.env.E2E_BROWSER_CHANNEL || "chrome",
    headless: process.env.E2E_HEADLESS !== "false",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "off",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "en-IN",
    timezoneId: "Asia/Calcutta"
  }
});
