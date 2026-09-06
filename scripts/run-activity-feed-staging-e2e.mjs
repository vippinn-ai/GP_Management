import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertLiveCredentials,
  assertStagingBaseUrl,
  assertStagingSupabaseEnvironment,
  parseEnvFile,
  sanitizeRunId,
  STAGING_APP_URL
} from "./playwright-staging-env.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--list")) {
  throw new Error("Activity-feed runner accepts only --list or one exact execution.");
}
const discoveryOnly = args[0] === "--list";
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const stagingEnv = {
  ...parseEnvFile(path.join(root, ".env.staging")),
  ...parseEnvFile(path.join(root, ".env.staging.local"))
};
const env = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
if (stagingEnv.VITE_BACKEND_ACTIVITY_FEED !== "true") {
  throw new Error("Staging E2E requires VITE_BACKEND_ACTIVITY_FEED=true.");
}
env.E2E_BASE_URL = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
env.E2E_RUN_ID = sanitizeRunId(discoveryOnly ? env.E2E_RUN_ID || "discovery-activity-feed" : env.E2E_RUN_ID);
if (!discoveryOnly) assertLiveCredentials(env);

console.log(JSON.stringify({
  runner: "activity-feed",
  runId: env.E2E_RUN_ID,
  baseUrl: env.E2E_BASE_URL,
  discoveryOnly,
  productionAllowed: false,
  mutatesBusinessData: false,
  workers: 1,
  retries: 0
}));

const cliPath = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const result = spawnSync(process.execPath, [cliPath, "test", "--config=playwright.activity-feed.staging.config.ts", ...(discoveryOnly ? ["--list"] : [])], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: false
});
process.exit(result.status ?? 1);
