import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertLiveCredentials, assertStagingBaseUrl, assertStagingSupabaseEnvironment, parseEnvFile, sanitizeRunId, STAGING_APP_URL } from "./playwright-staging-env.mjs";

const root = process.cwd();
const modes = {
  "--discount-rounding-positive": { selectedCase: "discount_rounding_positive", discovery: false },
  "--discount-rounding-positive-list": { selectedCase: "discount_rounding_positive", discovery: true },
  "--ltp-zero": { selectedCase: "ltp_zero", discovery: false },
  "--ltp-zero-list": { selectedCase: "ltp_zero", discovery: true },
  "--bill-discount-zero": { selectedCase: "bill_discount_zero", discovery: false },
  "--bill-discount-zero-list": { selectedCase: "bill_discount_zero", discovery: true },
  "--true-zero-price-guard": { selectedCase: "true_zero_price_guard", discovery: false },
  "--true-zero-price-guard-list": { selectedCase: "true_zero_price_guard", discovery: true }
};
const args = process.argv.slice(2);
if (args.length !== 1 || !modes[args[0]]) throw new Error("Pricing runner requires exactly one named case or its read-only list variant.");
const mode = modes[args[0]];
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const childEnv = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
childEnv.E2E_BASE_URL = assertStagingBaseUrl(childEnv.E2E_BASE_URL || STAGING_APP_URL);
childEnv.E2E_PRICING_CASE = mode.selectedCase;
childEnv.E2E_RUN_ID = sanitizeRunId(mode.discovery ? childEnv.E2E_RUN_ID || `discovery-${mode.selectedCase}` : childEnv.E2E_RUN_ID);
let reviewed;
if (!mode.discovery) {
  assertLiveCredentials(childEnv);
  const artifact = path.join(root, "test-artifacts", "preflight", `checkout-pricing-preflight-${mode.selectedCase}-${childEnv.E2E_RUN_ID}.json`);
  if (!fs.existsSync(artifact)) throw new Error("The reviewed exact pricing preflight artifact is missing.");
  reviewed = JSON.parse(fs.readFileSync(artifact, "utf8"));
  const verification = spawnSync(process.execPath, [path.join(root, "scripts", "preflight-checkout-pricing-staging.mjs"), `--case=${mode.selectedCase}`, "--verify"], { cwd: root, env: childEnv, stdio: "inherit", shell: false });
  if (verification.status !== 0) process.exit(verification.status ?? 1);
  childEnv.E2E_PRICING_CUSTOMER_NAME = reviewed.fixture.customerName;
  childEnv.E2E_PRICING_TIMED_STATION = reviewed.fixture.timedStationName;
  childEnv.E2E_PRICING_UNIT_STATION = reviewed.fixture.unitStationName || "";
  childEnv.E2E_PRICING_ZERO_ITEM_NAME = reviewed.fixture.itemName;
  childEnv.E2E_PRICING_ZERO_ITEM_BARCODE = reviewed.fixture.itemBarcode;
  childEnv.E2E_PRICING_PREFLIGHT_VERSION = String(reviewed.appState.version);
  childEnv.E2E_PRICING_PREFLIGHT_HASH = reviewed.appState.hash;
}
console.log(JSON.stringify({ runner: "release-b-checkout-pricing", selectedCase: mode.selectedCase, runId: childEnv.E2E_RUN_ID, baseUrl: childEnv.E2E_BASE_URL, discoveryOnly: mode.discovery, productionAllowed: false, safeForAutomaticRetry: false, workers: 1, retries: 0 }));
const cliPath = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const browser = spawnSync(process.execPath, [cliPath, "test", "--config=playwright.pricing.staging.config.ts", ...(mode.discovery ? ["--list"] : [])], { cwd: root, env: childEnv, stdio: "inherit", shell: false });
if (mode.discovery) process.exit(browser.status ?? 1);
const reconciliation = spawnSync(process.execPath, [path.join(root, "scripts", "reconcile-checkout-pricing-staging.mjs"), `--case=${mode.selectedCase}`], { cwd: root, env: childEnv, stdio: "inherit", shell: false });
process.exit(browser.status === 0 && reconciliation.status === 0 ? 0 : 1);
