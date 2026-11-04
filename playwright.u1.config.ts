import { defineConfig } from '@playwright/test';

// Separate discovery; the existing31-case configuration is untouched.
export default defineConfig({
  testDir: './tests/e2e/u1', testMatch: 'ui-read-speed-baseline-50-reload-pairs.e2e.ts',
  projects: [{ name: 'u1-baseline', use: { browserName: 'chromium', channel: 'chrome' } }],
  fullyParallel: false, workers: 1, retries: 0, maxFailures: 1, forbidOnly: true,
  timeout: 900000, expect: { timeout: 20000 },
  outputDir: './test-artifacts/u1-playwright', reporter: [['line']],
  use: { headless: true, actionTimeout: 15000, navigationTimeout: 30000,
    trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block',
    locale: 'en-IN', timezoneId: 'Asia/Calcutta' },
});
