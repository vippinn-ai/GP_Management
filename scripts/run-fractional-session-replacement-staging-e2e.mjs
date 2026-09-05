import fs from "node:fs";
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
  throw new Error("Fractional-session replacement runner accepts only --list or one exact execution.");
}
const discoveryOnly = args[0] === "--list";
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const env = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
env.E2E_BASE_URL = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
env.E2E_RUN_ID = sanitizeRunId(discoveryOnly ? env.E2E_RUN_ID || "discovery-fractional-replacement" : env.E2E_RUN_ID);
env.E2E_V2_REPLACEMENT_STATION = "Snooker Star Table";
env.E2E_V2_ORIGINAL_PAYMENT_MODE = "upi";
env.E2E_V2_REPLACEMENT_PAYMENT_MODE = "cash";
env.E2E_V2_FRACTIONAL_TIMED_CHARGE = "true";

if (!discoveryOnly) {
  assertLiveCredentials(env);
  const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-replacement-parity-preflight-${env.E2E_RUN_ID}.json`);
  if (!fs.existsSync(preflightPath)) throw new Error("Run and review the exact fail-closed preflight before this mutation test.");
  const verification = spawnSync(process.execPath, [path.join(root, "scripts", "preflight-checkout-replacement-parity-staging.mjs"), "--verify"], {
    cwd: root, env, stdio: "inherit", shell: false
  });
  if (verification.status !== 0) process.exit(verification.status ?? 1);
}

console.log(JSON.stringify({
  runner: "fractional-session-replacement-staging",
  runId: env.E2E_RUN_ID,
  baseUrl: env.E2E_BASE_URL,
  discoveryOnly,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  workers: 1,
  retries: 0
}));

const browserArgs = [path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs"), "tests/e2e/staging/release-b-replacement-v2.e2e.ts"];
if (discoveryOnly) browserArgs.push("--list");
const browser = spawnSync(process.execPath, browserArgs, { cwd: root, env, stdio: "inherit", shell: false });
if (discoveryOnly || browser.status !== 0) process.exit(browser.status ?? 1);
const reconciliation = spawnSync(process.execPath, [path.join(root, "scripts", "reconcile-session-replacement-staging.mjs")], {
  cwd: root, env, stdio: "inherit", shell: false
});
process.exit(reconciliation.status ?? 1);
