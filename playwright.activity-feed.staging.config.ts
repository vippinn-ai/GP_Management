import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { assertStagingBaseUrl, sanitizeRunId, STAGING_APP_URL } from "./scripts/playwright-staging-env.mjs";

const baseURL = assertStagingBaseUrl(process.env.E2E_BASE_URL || STAGING_APP_URL);
const runId = sanitizeRunId(process.env.E2E_RUN_ID);

export default defineConfig({
  testDir: "./tests/e2e/staging",
  testMatch: "activity-feed.e2e.ts",
  outputDir: path.join("test-artifacts", "playwright", `activity-feed-${runId}`),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 75_000,
  expect: { timeout: 20_000 },
  reporter: [["line"], ["./scripts/playwright-compact-reporter.mjs", { runId }]],
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 360, height: 780 } } }
  ],
  use: {
    baseURL,
    browserName: "chromium",
    channel: process.env.E2E_BROWSER_CHANNEL || "chrome",
    headless: process.env.E2E_HEADLESS !== "false",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
    locale: "en-IN",
    timezoneId: "Asia/Calcutta"
  }
});
