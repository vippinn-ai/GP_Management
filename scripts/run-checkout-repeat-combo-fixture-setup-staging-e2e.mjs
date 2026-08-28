import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnvFile, sanitizeRunId } from "./playwright-staging-env.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => argument !== "--list")) {
  throw new Error("The fixture setup runner accepts only the optional --list discovery flag.");
}

const root = process.cwd();
const genericRunner = path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs");
const spec = "tests/e2e/staging/release-b-checkout-repeat-combo-fixture-setup.e2e.ts";
const discoveryOnly = args[0] === "--list";
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const childEnv = { ...process.env };

if (!discoveryOnly) {
  const fixtureRunId = sanitizeRunId(childEnv.E2E_FIXTURE_RUN_ID || localEnv.E2E_FIXTURE_RUN_ID);
  const artifactPath = path.join(root, "test-artifacts", "preflight", `checkout-repeat-combo-fixture-preflight-${fixtureRunId}.json`);
  if (!fs.existsSync(artifactPath)) throw new Error("The reviewed exact fixture preflight artifact is missing.");
  const evidence = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (!evidence.safeToRun || evidence.runId !== fixtureRunId || !evidence.fixture?.combo?.station?.id) {
    throw new Error("The exact fixture preflight artifact is not safe or complete.");
  }
  childEnv.E2E_FIXTURE_RUN_ID = fixtureRunId;
  childEnv.E2E_RUN_ID = `fixture-${fixtureRunId}`;
  childEnv.E2E_FIXTURE_ITEM_NAME = evidence.fixture.item.name;
  childEnv.E2E_FIXTURE_COMBO_NAME = evidence.fixture.combo.name;
  childEnv.E2E_FIXTURE_STATION_NAME = evidence.fixture.combo.station.name;
  childEnv.E2E_FIXTURE_STATION_ID = evidence.fixture.combo.station.id;
  childEnv.E2E_FIXTURE_PREFLIGHT_VERSION = String(evidence.appState.version);
  childEnv.E2E_FIXTURE_PREFLIGHT_HASH = evidence.appState.hash;
  const verify = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "preflight-checkout-repeat-combo-fixture-staging.mjs"), "--verify"],
    { cwd: root, env: childEnv, stdio: "inherit", shell: false }
  );
  if ((verify.status ?? 1) !== 0) process.exit(verify.status ?? 1);
}

const result = spawnSync(process.execPath, [genericRunner, spec, ...args], {
  cwd: root,
  env: childEnv,
  stdio: "inherit",
  shell: false
});
process.exit(result.status ?? 1);
