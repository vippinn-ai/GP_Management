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
const modes = {
  "--upi": { selectedCase: "upi", discovery: false },
  "--upi-list": { selectedCase: "upi", discovery: true },
  "--split": { selectedCase: "split", discovery: false },
  "--split-list": { selectedCase: "split", discovery: true },
  "--partial-previous-dues": { selectedCase: "partial_previous_dues", discovery: false },
  "--partial-previous-dues-list": { selectedCase: "partial_previous_dues", discovery: true }
};
const args = process.argv.slice(2);
if (args.length !== 1 || !modes[args[0]]) {
  throw new Error("Payment-matrix runner requires exactly one named case or its read-only list variant.");
}
const mode = modes[args[0]];
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const childEnv = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
childEnv.E2E_BASE_URL = assertStagingBaseUrl(childEnv.E2E_BASE_URL || STAGING_APP_URL);
childEnv.E2E_PAYMENT_MATRIX_CASE = mode.selectedCase;
if (mode.discovery) {
  childEnv.E2E_RUN_ID = sanitizeRunId(childEnv.E2E_RUN_ID || `discovery-${mode.selectedCase}`);
} else {
  assertLiveCredentials(childEnv);
  childEnv.E2E_RUN_ID = sanitizeRunId(childEnv.E2E_RUN_ID);
  const artifact = path.join(root, "test-artifacts", "preflight", `checkout-payment-matrix-preflight-${mode.selectedCase}-${childEnv.E2E_RUN_ID}.json`);
  if (!fs.existsSync(artifact)) throw new Error("The reviewed exact payment-matrix preflight artifact is missing.");
  const verification = spawnSync(process.execPath, [
    path.join(root, "scripts", "preflight-checkout-payment-matrix-staging.mjs"),
    `--case=${mode.selectedCase}`,
    "--verify"
  ], { cwd: root, env: childEnv, stdio: "inherit", shell: false });
  if (verification.status !== 0) process.exit(verification.status ?? 1);
}

console.log(JSON.stringify({
  runner: "release-b-checkout-payment-matrix",
  selectedCase: mode.selectedCase,
  runId: childEnv.E2E_RUN_ID,
  baseUrl: childEnv.E2E_BASE_URL,
  discoveryOnly: mode.discovery,
  credentials: mode.discovery ? "not-required" : "loaded-from-ignored-environment",
  productionAllowed: false,
  safeForAutomaticRetry: false,
  workers: 1,
  retries: 0
}));

const cliPath = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const browser = spawnSync(process.execPath, [
  cliPath,
  "test",
  "--config=playwright.payment-matrix.staging.config.ts",
  ...(mode.discovery ? ["--list"] : [])
], { cwd: root, env: childEnv, stdio: "inherit", shell: false });
if (mode.discovery) process.exit(browser.status ?? 1);

const reconciliation = spawnSync(process.execPath, [
  path.join(root, "scripts", "reconcile-checkout-payment-matrix-staging.mjs"),
  `--case=${mode.selectedCase}`
], { cwd: root, env: childEnv, stdio: "inherit", shell: false });
process.exit(browser.status === 0 && reconciliation.status === 0 ? 0 : 1);
