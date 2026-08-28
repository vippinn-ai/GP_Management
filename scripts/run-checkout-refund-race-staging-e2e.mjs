import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnvFile, sanitizeRunId } from "./playwright-staging-env.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => argument !== "--list")) {
  throw new Error("Checkout-refund race runner accepts only --list or one exact execution.");
}

const root = process.cwd();
const discoveryOnly = args[0] === "--list";
const childEnv = { ...process.env };

if (!discoveryOnly) {
  const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
  const runId = sanitizeRunId(childEnv.E2E_RUN_ID || localEnv.E2E_RUN_ID);
  const artifactPath = path.join(
    root,
    "test-artifacts",
    "preflight",
    `checkout-refund-race-preflight-${runId}.json`
  );
  if (!fs.existsSync(artifactPath)) throw new Error("The reviewed exact checkout-refund preflight is missing.");
  const evidence = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (!evidence.safeToRun || evidence.runId !== runId) throw new Error("The exact preflight is not safe.");
  childEnv.E2E_REFUND_RACE_PREFLIGHT_VERSION = String(evidence.appState.version);
  childEnv.E2E_REFUND_RACE_PREFLIGHT_HASH = evidence.appState.hash;

  const verify = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "preflight-checkout-refund-race-staging.mjs"), "--verify"],
    { cwd: root, env: childEnv, stdio: "inherit", shell: false }
  );
  if ((verify.status ?? 1) !== 0) process.exit(verify.status ?? 1);
}

const result = spawnSync(
  process.execPath,
  [
    path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs"),
    "tests/e2e/staging/release-b-checkout-refund-race-v2.e2e.ts",
    ...args
  ],
  { cwd: root, env: childEnv, stdio: "inherit", shell: false }
);
process.exit(result.status ?? 1);
