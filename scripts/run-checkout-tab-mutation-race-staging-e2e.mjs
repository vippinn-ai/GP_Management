import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnvFile, sanitizeRunId } from "./playwright-staging-env.mjs";
import { loadSessionItemRaceAdmin } from "./session-item-race-admin-env.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => argument !== "--list")) {
  throw new Error("Checkout-tab-mutation race runner accepts only --list or one exact execution.");
}
const discoveryOnly = args[0] === "--list";
const root = process.cwd();
const childEnv = { ...process.env };
childEnv.E2E_TAB_MUTATION_RACE_MODES = "add_item,update_item,remove_item,apply_combo";
childEnv.E2E_TAB_MUTATION_RACE_SCENARIOS = "checkout_first,mutation_first,simultaneous";

if (!discoveryOnly) {
  const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
  const temporaryAdmin = loadSessionItemRaceAdmin(root);
  Object.assign(childEnv, temporaryAdmin?.overlay || {});
  const runId = sanitizeRunId(childEnv.E2E_RUN_ID || localEnv.E2E_RUN_ID);
  const artifactPath = path.join(root, "test-artifacts", "preflight", `checkout-tab-mutation-race-preflight-${runId}.json`);
  if (!fs.existsSync(artifactPath)) throw new Error("The reviewed exact checkout-tab-mutation preflight is missing.");
  const evidence = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (!evidence.safeToRun || evidence.runId !== runId ||
      JSON.stringify(evidence.selectedModes) !== JSON.stringify(childEnv.E2E_TAB_MUTATION_RACE_MODES.split(",")) ||
      JSON.stringify(evidence.selectedScenarios) !== JSON.stringify(childEnv.E2E_TAB_MUTATION_RACE_SCENARIOS.split(","))) {
    throw new Error("The exact checkout-tab-mutation preflight is not safe.");
  }
  childEnv.E2E_TAB_MUTATION_RACE_PREFLIGHT_VERSION = String(evidence.appState.version);
  childEnv.E2E_TAB_MUTATION_RACE_PREFLIGHT_HASH = evidence.appState.hash;
  const verify = spawnSync(process.execPath, [
    path.join(root, "scripts", "preflight-checkout-tab-mutation-race-staging.mjs"), "--verify"
  ], { cwd: root, env: childEnv, stdio: "inherit", shell: false });
  if ((verify.status ?? 1) !== 0) process.exit(verify.status ?? 1);
}

const result = spawnSync(process.execPath, [
  path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs"),
  "tests/e2e/staging/release-b-checkout-tab-mutation-race-v2.e2e.ts",
  ...(discoveryOnly ? ["--list"] : [])
], { cwd: root, env: childEnv, stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
