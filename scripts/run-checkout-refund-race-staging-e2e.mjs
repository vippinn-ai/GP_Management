import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnvFile, sanitizeRunId, STAGING_APP_URL, STAGING_PROJECT_REF } from "./playwright-staging-env.mjs";
import { loadSessionItemRaceAdmin } from "./session-item-race-admin-env.mjs";

const args = process.argv.slice(2);
const allowed = new Set(["--list", "--void", "--void-list"]);
if (args.length > 1 || args.some((argument) => !allowed.has(argument))) {
  throw new Error("Checkout disposition race runner accepts only refund/void execution or read-only discovery.");
}

const root = process.cwd();
const disposition = args[0]?.startsWith("--void") ? "void" : "refund";
const discoveryOnly = args[0] === "--list" || args[0] === "--void-list";
const temporaryAdmin = disposition === "void" && !discoveryOnly
  ? loadSessionItemRaceAdmin(root, { required: true })
  : null;
const childEnv = {
  ...process.env,
  ...(temporaryAdmin?.overlay ?? {}),
  E2E_CHECKOUT_REFUND_RACE_DISPOSITION: disposition
};
const artifactPrefix = disposition === "void" ? "checkout-void-race" : "checkout-refund-race";

if (!discoveryOnly) {
  const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
  const runId = sanitizeRunId(childEnv.E2E_RUN_ID || localEnv.E2E_RUN_ID);
  const artifactPath = path.join(
    root,
    "test-artifacts",
    "preflight",
    `${artifactPrefix}-preflight-${runId}.json`
  );
  if (!fs.existsSync(artifactPath)) throw new Error("The reviewed exact checkout disposition preflight is missing.");
  const evidence = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (!evidence.safeToRun || evidence.runId !== runId || evidence.disposition !== disposition ||
      evidence.projectRef !== STAGING_PROJECT_REF || evidence.baseUrl !== STAGING_APP_URL ||
      evidence.productionAllowed !== false || evidence.safeForAutomaticRetry !== false ||
      (disposition === "void" && (evidence.actorsDistinct !== true ||
        evidence.temporaryAdmin?.actorId !== temporaryAdmin?.actorId ||
        evidence.temporaryAdmin?.createArtifactSha256 !== temporaryAdmin?.createArtifactSha256))) {
    throw new Error("The exact disposition preflight is not safe.");
  }
  childEnv.E2E_REFUND_RACE_PREFLIGHT_VERSION = String(evidence.appState.version);
  childEnv.E2E_REFUND_RACE_PREFLIGHT_HASH = evidence.appState.hash;

  const verify = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "preflight-checkout-refund-race-staging.mjs"), disposition === "void" ? "--verify-void" : "--verify"],
    { cwd: root, env: childEnv, stdio: "inherit", shell: false }
  );
  if ((verify.status ?? 1) !== 0) process.exit(verify.status ?? 1);
}

const result = spawnSync(
  process.execPath,
  [
    path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs"),
    "tests/e2e/staging/release-b-checkout-refund-race-v2.e2e.ts",
    ...(discoveryOnly ? ["--list"] : [])
  ],
  { cwd: root, env: childEnv, stdio: "inherit", shell: false }
);
process.exit(result.status ?? 1);
