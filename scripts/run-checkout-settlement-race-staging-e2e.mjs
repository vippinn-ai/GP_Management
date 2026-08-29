import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sanitizeRunId } from "./playwright-staging-env.mjs";
import { loadSessionItemRaceAdmin } from "./session-item-race-admin-env.mjs";

const args = process.argv.slice(2);
const allowed = new Set(["--list", "--writeoff", "--writeoff-list"]);
if (args.some((argument) => !allowed.has(argument)) || args.length > 1) {
  throw new Error("The checkout-settlement race runner accepts only settlement execution/list or exact write-off execution/list mode.");
}

const root = process.cwd();
const genericRunner = path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs");
const writeoffMode = args[0] === "--writeoff" || args[0] === "--writeoff-list";
const discoveryOnly = args[0] === "--list" || args[0] === "--writeoff-list";
const temporaryAdmin = writeoffMode && !discoveryOnly
  ? loadSessionItemRaceAdmin(root, { required: true })
  : null;
const childEnv = {
  ...process.env,
  ...(temporaryAdmin?.overlay ?? {}),
  E2E_CHECKOUT_SETTLEMENT_RACE_MODE: writeoffMode ? "writeoff" : "settlement"
};
const spec = writeoffMode
  ? "tests/e2e/staging/release-b-checkout-writeoff-race-v2.e2e.ts"
  : "tests/e2e/staging/release-b-checkout-settlement-race-v2.e2e.ts";

if (!discoveryOnly && writeoffMode) {
  if (!childEnv.E2E_RUN_ID?.trim()) throw new Error("A fresh explicit E2E_RUN_ID is required for write-off execution.");
  const runId = sanitizeRunId(childEnv.E2E_RUN_ID);
  const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-writeoff-race-preflight-${runId}.json`);
  if (!fs.existsSync(preflightPath)) throw new Error("The exact reviewed checkout-writeoff preflight artifact is missing.");
  const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
  if (preflight.runId !== runId || preflight.mode !== "writeoff" || preflight.safeToRun !== true ||
      preflight.productionAllowed !== false || preflight.safeForAutomaticRetry !== false ||
      preflight.actorsDistinct !== true || !preflight.deployedArtifact?.path || !preflight.deployedArtifact?.sha256 ||
      !Array.isArray(preflight.artifactCollisions) || preflight.artifactCollisions.length !== 0 ||
      !Array.isArray(preflight.snapshot?.candidateBills) || preflight.snapshot.candidateBills.length !== 0 ||
      !Array.isArray(preflight.scenarios) ||
      JSON.stringify(preflight.scenarios) !== JSON.stringify(["checkout_first", "writeoff_first", "simultaneous"])) {
    throw new Error("The exact checkout-writeoff preflight is not safe.");
  }
  const verify = spawnSync(process.execPath, [
    path.join(root, "scripts", "preflight-checkout-writeoff-race-staging.mjs"), "--verify"
  ], { cwd: root, env: childEnv, stdio: "inherit", shell: false });
  if ((verify.status ?? 1) !== 0) process.exit(verify.status ?? 1);
}

const result = spawnSync(process.execPath, [genericRunner, spec, ...(discoveryOnly ? ["--list"] : [])], {
  cwd: root,
  env: childEnv,
  stdio: "inherit",
  shell: false
});

process.exit(result.status ?? 1);
