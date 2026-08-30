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
  throw new Error("Replacement-parity runner accepts only --list or one exact execution.");
}
const discovery = args[0] === "--list";
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const env = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
env.E2E_BASE_URL = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
env.E2E_RUN_ID = sanitizeRunId(discovery ? env.E2E_RUN_ID || "discovery-replacement-parity" : env.E2E_RUN_ID);

if (!discovery) {
  assertLiveCredentials(env);
  const artifactPath = path.join(root, "test-artifacts", "preflight", `checkout-replacement-parity-preflight-${env.E2E_RUN_ID}.json`);
  if (!fs.existsSync(artifactPath)) throw new Error("The reviewed exact replacement-parity preflight is missing.");
  const reviewed = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const verification = spawnSync(process.execPath, [path.join(root, "scripts", "preflight-checkout-replacement-parity-staging.mjs"), "--verify"], {
    cwd: root, env, stdio: "inherit", shell: false
  });
  if (verification.status !== 0) process.exit(verification.status ?? 1);
  env.E2E_REPLACEMENT_PARITY_CUSTOMER = reviewed.fixture.customerName;
  env.E2E_REPLACEMENT_PARITY_ITEM = reviewed.fixture.itemName;
  env.E2E_REPLACEMENT_PARITY_BARCODE = reviewed.fixture.itemBarcode;
  env.E2E_REPLACEMENT_PARITY_ORIGINAL_BILL = reviewed.fixture.originalBillNumber;
  env.E2E_REPLACEMENT_PARITY_REPLACEMENT_BILL = reviewed.fixture.replacementBillNumber;
  env.E2E_REPLACEMENT_PARITY_PENDING_BILL = reviewed.pendingReceivable?.bill_number || "";
  env.E2E_REPLACEMENT_PARITY_PREFLIGHT_VERSION = String(reviewed.appState.version);
  env.E2E_REPLACEMENT_PARITY_PREFLIGHT_HASH = reviewed.appState.hash;
}

console.log(JSON.stringify({
  runner: "release-b-checkout-replacement-parity",
  runId: env.E2E_RUN_ID,
  baseUrl: env.E2E_BASE_URL,
  discoveryOnly: discovery,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  workers: 1,
  retries: 0
}));

const cliPath = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const browser = spawnSync(process.execPath, [cliPath, "test", "--config=playwright.replacement-parity.staging.config.ts", ...(discovery ? ["--list"] : [])], {
  cwd: root, env, stdio: "inherit", shell: false
});
if (discovery) process.exit(browser.status ?? 1);
const reconciliation = spawnSync(process.execPath, [path.join(root, "scripts", "reconcile-checkout-replacement-parity-staging.mjs")], {
  cwd: root, env, stdio: "inherit", shell: false
});
process.exit(browser.status === 0 && reconciliation.status === 0 ? 0 : 1);
