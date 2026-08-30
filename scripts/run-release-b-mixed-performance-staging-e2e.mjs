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
  throw new Error("Mixed-performance runner accepts only one exact execution or --list.");
}
const discoveryOnly = args[0] === "--list";
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const baseEnv = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
baseEnv.E2E_BASE_URL = assertStagingBaseUrl(baseEnv.E2E_BASE_URL || STAGING_APP_URL);
if (!discoveryOnly) assertLiveCredentials(baseEnv);
if (!discoveryOnly && !baseEnv.E2E_RUN_ID?.trim()) throw new Error("An explicit E2E_RUN_ID is required.");
const umbrellaRunId = sanitizeRunId(discoveryOnly ? baseEnv.E2E_RUN_ID || "mixed-performance-discovery" : baseEnv.E2E_RUN_ID);
if (umbrellaRunId.length > 34) throw new Error("Mixed-performance E2E_RUN_ID must be at most 34 characters so scenario identities remain valid.");
const ids = {
  payment: sanitizeRunId(`${umbrellaRunId}-dues`),
  replacement: sanitizeRunId(`${umbrellaRunId}-replacement`),
  combo: sanitizeRunId(`${umbrellaRunId}-combo`)
};

function runOnce(label, script, scriptArgs, env, capture = false) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...scriptArgs], {
    cwd: root,
    env,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: capture ? "utf8" : undefined,
    shell: false
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} failed once with exit code ${result.status ?? "unknown"}; automatic retry is forbidden.`);
  }
  return capture ? result.stdout : "";
}

console.log(JSON.stringify({
  runner: "release-b-mixed-performance",
  umbrellaRunId,
  scenarioRunIds: ids,
  baseUrl: baseEnv.E2E_BASE_URL,
  discoveryOnly,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  workers: 1,
  retries: 0,
  scenarioOrder: ["partial_previous_dues", "replacement_quantity_decrease", "checkout_vs_repeat_combo_simultaneous"]
}));

if (discoveryOnly) {
  runOnce("payment discovery", "scripts/run-checkout-payment-matrix-staging-e2e.mjs", ["--partial-previous-dues-list"], { ...baseEnv, E2E_RUN_ID: ids.payment });
  runOnce("replacement discovery", "scripts/run-checkout-replacement-parity-staging-e2e.mjs", ["--list"], { ...baseEnv, E2E_RUN_ID: ids.replacement });
  runOnce("combo-race discovery", "scripts/run-checkout-repeat-combo-race-staging-e2e.mjs", ["--simultaneous-only-list"], { ...baseEnv, E2E_RUN_ID: ids.combo });
  process.exit(0);
}

const finalArtifact = path.join(root, "test-artifacts", "evidence", `release-b-mixed-performance-${umbrellaRunId}.json`);
if (fs.existsSync(finalArtifact)) throw new Error("The exact mixed-performance run identity already has a terminal artifact.");

const paymentEnv = { ...baseEnv, E2E_RUN_ID: ids.payment, E2E_PAYMENT_MATRIX_CASE: "partial_previous_dues" };
runOnce("payment preflight", "scripts/preflight-checkout-payment-matrix-staging.mjs", ["--case=partial_previous_dues"], paymentEnv);
runOnce("payment scenario", "scripts/run-checkout-payment-matrix-staging-e2e.mjs", ["--partial-previous-dues"], paymentEnv);

const replacementEnv = { ...baseEnv, E2E_RUN_ID: ids.replacement };
runOnce("replacement preflight", "scripts/preflight-checkout-replacement-parity-staging.mjs", [], replacementEnv);
runOnce("replacement scenario", "scripts/run-checkout-replacement-parity-staging-e2e.mjs", [], replacementEnv);

const comboDiscoveryRaw = runOnce("combo fixture discovery", "scripts/preflight-checkout-repeat-combo-race-staging.mjs", ["--discover"], { ...baseEnv, E2E_RUN_ID: ids.combo }, true);
let comboDiscovery;
try { comboDiscovery = JSON.parse(comboDiscoveryRaw); } catch { throw new Error("Combo fixture discovery did not return one JSON document."); }
const selectedCombo = comboDiscovery.eligibleFixtures?.[0];
if (!selectedCombo?.combo?.id || !comboDiscovery.station?.name) throw new Error("No staging combo fixture satisfies the reviewed stock and pricing preflight.");
const comboEnv = {
  ...baseEnv,
  E2E_RUN_ID: ids.combo,
  E2E_REPEAT_COMBO_ID: selectedCombo.combo.id,
  E2E_REPEAT_COMBO_STATION: comboDiscovery.station.name
};
runOnce("combo-race preflight", "scripts/preflight-checkout-repeat-combo-race-staging.mjs", [], comboEnv);
let comboBrowserStatus = 0;
try {
  runOnce("simultaneous combo race", "scripts/run-checkout-repeat-combo-race-staging-e2e.mjs", ["--simultaneous-only"], comboEnv);
} catch (error) {
  comboBrowserStatus = 1;
  console.error(error instanceof Error ? error.message : String(error));
}
runOnce("simultaneous combo-race reconciliation", "scripts/reconcile-checkout-repeat-combo-race-staging.mjs", [], {
  ...comboEnv,
  E2E_REPEAT_COMBO_RECONCILE_RUN_ID: ids.combo
});
if (comboBrowserStatus !== 0) throw new Error("The simultaneous combo race failed; reconciliation ran once and the scenario will not be retried.");

runOnce("mixed-performance reconciliation", "scripts/reconcile-release-b-mixed-performance-staging.mjs", [], { ...baseEnv, E2E_RUN_ID: umbrellaRunId });
