import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnvFile, sanitizeRunId } from "./playwright-staging-env.mjs";
import { loadSessionItemRaceAdmin } from "./session-item-race-admin-env.mjs";

const args = process.argv.slice(2);
const allowedModes = new Set(["--list", "--remaining-two", "--remaining-two-list"]);
if (args.length > 1 || args.some((argument) => !allowedModes.has(argument))) {
  throw new Error("Checkout-session-item race runner accepts only --list, --remaining-two, --remaining-two-list, or one exact execution.");
}

const root = process.cwd();
const mode = args[0] ?? "--all";
const discoveryOnly = mode === "--list" || mode === "--remaining-two-list";
const remainingTwo = mode === "--remaining-two" || mode === "--remaining-two-list";
const selectedScenarios = remainingTwo
  ? ["item_first", "simultaneous"]
  : ["checkout_first", "item_first", "simultaneous"];
const childEnv = { ...process.env };
childEnv.E2E_SESSION_ITEM_RACE_SCENARIOS = selectedScenarios.join(",");

if (!discoveryOnly) {
  const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
  const temporaryAdmin = loadSessionItemRaceAdmin(root);
  Object.assign(childEnv, temporaryAdmin?.overlay || {});
  const runId = sanitizeRunId(childEnv.E2E_RUN_ID || localEnv.E2E_RUN_ID);
  const artifactPath = path.join(
    root,
    "test-artifacts",
    "preflight",
    `checkout-session-item-race-preflight-${runId}.json`
  );
  if (!fs.existsSync(artifactPath)) throw new Error("The reviewed exact checkout-session-item preflight is missing.");
  const evidence = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (!evidence.safeToRun || evidence.runId !== runId || !evidence.fixture?.station?.name ||
      JSON.stringify(evidence.selectedScenarios) !== JSON.stringify(selectedScenarios)) {
    throw new Error("The exact checkout-session-item preflight is not safe.");
  }
  childEnv.E2E_SESSION_ITEM_RACE_STATION = evidence.fixture.station.name;
  childEnv.E2E_SESSION_ITEM_RACE_PREFLIGHT_VERSION = String(evidence.appState.version);
  childEnv.E2E_SESSION_ITEM_RACE_PREFLIGHT_HASH = evidence.appState.hash;

  const verify = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "preflight-checkout-session-item-race-staging.mjs"), remainingTwo ? "--verify-remaining-two" : "--verify"],
    { cwd: root, env: childEnv, stdio: "inherit", shell: false }
  );
  if ((verify.status ?? 1) !== 0) process.exit(verify.status ?? 1);
}

const result = spawnSync(
  process.execPath,
  [
    path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs"),
    "tests/e2e/staging/release-b-checkout-session-item-race-v2.e2e.ts",
    ...(discoveryOnly ? ["--list"] : [])
  ],
  { cwd: root, env: childEnv, stdio: "inherit", shell: false }
);
process.exit(result.status ?? 1);
