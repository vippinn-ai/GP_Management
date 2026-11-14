import { defineConfig } from '@playwright/test';

const darwin = process.platform === 'darwin';
const endpoint = process.env.U1_DARWIN_BROWSER_WS_ENDPOINT;
const supervised = process.env.U1_SUPERVISED_DARWIN === 'owned-browser-v1';
if (darwin && !process.argv.includes('--list') && (!supervised || !endpoint || !/^ws:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9_-]+$/.test(endpoint))) {
  throw new Error('Darwin U1 requires the supervised owned loopback browser');
}
if (!darwin && (endpoint || supervised)) throw new Error('Darwin browser contract on wrong platform');

// Separate discovery; the existing31-case configuration is untouched.
export default defineConfig({
  testDir: './tests/e2e/u1', testMatch: 'ui-read-speed-baseline-50-reload-pairs.e2e.ts',
  projects: [{ name: 'u1-baseline', use: { browserName: 'chromium', channel: 'chrome' } }],
  fullyParallel: false, workers: 1, retries: 0, maxFailures: 1, forbidOnly: true,
  timeout: 3600000, expect: { timeout: 20000 },
  outputDir: './test-artifacts/u1-playwright', reporter: [['line']],
  use: { headless: true, actionTimeout: 15000, navigationTimeout: 30000,
    ...(darwin && supervised && endpoint ? { connectOptions: { wsEndpoint: endpoint, timeout: 15000 } } : {}),
    trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block',
    locale: 'en-IN', timezoneId: 'Asia/Calcutta' },
});
