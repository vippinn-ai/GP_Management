import path from "node:path";
import { defineConfig } from "@playwright/test";
import { assertStagingBaseUrl, sanitizeRunId, STAGING_APP_URL } from "./scripts/playwright-staging-env.mjs";

const baseURL = assertStagingBaseUrl(process.env.E2E_BASE_URL || STAGING_APP_URL);
const runId = sanitizeRunId(process.env.E2E_RUN_ID);

export default defineConfig({
  testDir: "./tests/e2e/staging",
  testMatch: "bill-register-search-stability.e2e.ts",
  outputDir: path.join("test-artifacts", "playwright", `bill-search-stability-${runId}`),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: [["line"], ["./scripts/playwright-compact-reporter.mjs", { runId }]],
  use: {
    baseURL,
    browserName: "chromium",
    channel: process.env.E2E_BROWSER_CHANNEL || "chrome",
    headless: process.env.E2E_HEADLESS !== "false",
    viewport: { width: 390, height: 844 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
    locale: "en-IN",
    timezoneId: "Asia/Calcutta"
  }
});
