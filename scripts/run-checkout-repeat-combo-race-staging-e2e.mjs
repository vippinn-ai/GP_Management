import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnvFile, sanitizeRunId } from "./playwright-staging-env.mjs";

const args = process.argv.slice(2);
const allowed = new Set([
  "--list",
  "--remaining-two",
  "--remaining-two-list",
  "--simultaneous-only",
  "--simultaneous-only-list"
]);
if (args.some((argument) => !allowed.has(argument)) || args.length > 1) {
  throw new Error("The checkout-repeat-combo race runner accepts only one documented execution or discovery selector.");
}

const root = process.cwd();
const genericRunner = path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs");
const spec = "tests/e2e/staging/release-b-checkout-repeat-combo-race-v2.e2e.ts";
const mode = args[0] ?? "all";
const discoveryOnly = mode === "--list" || mode === "--remaining-two-list" || mode === "--simultaneous-only-list";
const childEnv = { ...process.env };

if (!discoveryOnly) {
  const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
  const runId = sanitizeRunId(childEnv.E2E_RUN_ID || localEnv.E2E_RUN_ID);
  const artifactPath = path.join(
    root,
    "test-artifacts",
    "preflight",
    `checkout-repeat-combo-race-preflight-${runId}.json`
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error("The reviewed exact checkout-repeat-combo preflight artifact is missing.");
  }
  const evidence = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (!evidence.safeToRun || evidence.runId !== runId || !evidence.fixture?.station || !evidence.fixture?.combo) {
    throw new Error("The exact checkout-repeat-combo preflight artifact is not safe or complete.");
  }
  childEnv.E2E_REPEAT_COMBO_STATION = evidence.fixture.station.name;
  childEnv.E2E_REPEAT_COMBO_ID = evidence.fixture.combo.id;
  childEnv.E2E_REPEAT_COMBO_NAME = evidence.fixture.combo.name;
  childEnv.E2E_REPEAT_COMBO_CHOICE_SELECTIONS = JSON.stringify(evidence.fixture.choiceSelections ?? []);
  childEnv.E2E_REPEAT_COMBO_PREFLIGHT_VERSION = String(evidence.appState.version);
  childEnv.E2E_REPEAT_COMBO_PREFLIGHT_HASH = evidence.appState.hash;
  const preflight = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "preflight-checkout-repeat-combo-race-staging.mjs"), "--verify"],
    { cwd: root, env: childEnv, stdio: "inherit", shell: false }
  );
  if ((preflight.status ?? 1) !== 0) process.exit(preflight.status ?? 1);
}

const playwrightArgs = mode === "--remaining-two" || mode === "--remaining-two-list"
  ? ["--grep", "combo_first|simultaneous", ...(discoveryOnly ? ["--list"] : [])]
  : mode === "--simultaneous-only" || mode === "--simultaneous-only-list"
    ? ["--grep", "simultaneous commits exactly one compatible session transition", ...(discoveryOnly ? ["--list"] : [])]
    : args;
const result = spawnSync(process.execPath, [genericRunner, spec, ...playwrightArgs], {
  cwd: root,
  env: childEnv,
  stdio: "inherit",
  shell: false
});
process.exit(result.status ?? 1);
