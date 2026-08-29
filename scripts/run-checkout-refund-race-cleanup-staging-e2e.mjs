import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sanitizeRunId } from "./playwright-staging-env.mjs";
import { loadSessionItemRaceAdmin } from "./session-item-race-admin-env.mjs";

const args = process.argv.slice(2);
const allowed = new Set(["--list", "--void", "--void-list"]);
if (args.length > 1 || args.some((argument) => !allowed.has(argument))) {
  throw new Error("Disposition-race cleanup accepts only refund/void execution or read-only discovery.");
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
  E2E_CLEANUP_RACE_KIND: disposition,
  E2E_CHECKOUT_REFUND_RACE_DISPOSITION: disposition
};
const artifactPrefix = disposition === "void" ? "checkout-void-race" : "checkout-refund-race";

if (!discoveryOnly) {
  const requestedCleanupRunId = process.env.E2E_RUN_ID?.trim();
  if (!requestedCleanupRunId) throw new Error("An explicit E2E_RUN_ID is required for disposition-race cleanup.");
  const cleanupRunId = sanitizeRunId(requestedCleanupRunId);
  const requested = childEnv.E2E_CHECKOUT_DISPOSITION_RACE_RECOVERY_ARTIFACT?.trim() ||
    childEnv.E2E_REFUND_RACE_RECOVERY_ARTIFACT?.trim();
  if (!requested) throw new Error("E2E_CHECKOUT_DISPOSITION_RACE_RECOVERY_ARTIFACT is required.");
  const recoveryPath = path.resolve(root, requested);
  const recoveryDirectory = path.resolve(root, "test-artifacts", "reconciliation");
  if (path.dirname(recoveryPath) !== recoveryDirectory || !fs.existsSync(recoveryPath)) {
    throw new Error("Cleanup accepts only an exact immutable disposition-race recovery artifact.");
  }
  const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
  const recoverySha256 = createHash("sha256").update(fs.readFileSync(recoveryPath)).digest("hex");
  const fixtureRunId = sanitizeRunId(recovery.runId);
  if (
    path.basename(recoveryPath) !== `${artifactPrefix}-recovery-${fixtureRunId}.json` ||
    (disposition === "void" ? recovery.disposition !== "void" : recovery.disposition && recovery.disposition !== "refund") ||
    recovery.safeForIdentityBoundCleanup !== true ||
    recovery.safeForAutomaticRetry !== false ||
    recovery.productionAllowed !== false
  ) {
    throw new Error("Recovery evidence does not authorize identity-bound cleanup.");
  }
  if (disposition === "void") {
    const preflightPath = path.resolve(root, recovery.preflightLineage?.artifact ?? "");
    const preflightDirectory = path.resolve(root, "test-artifacts", "preflight");
    if (path.dirname(preflightPath) !== preflightDirectory ||
        path.basename(preflightPath) !== `${artifactPrefix}-preflight-${fixtureRunId}.json` ||
        !fs.existsSync(preflightPath)) {
      throw new Error("Void cleanup recovery has invalid preflight lineage.");
    }
    const preflightBytes = fs.readFileSync(preflightPath);
    const preflight = JSON.parse(preflightBytes.toString("utf8"));
    if (createHash("sha256").update(preflightBytes).digest("hex") !== recovery.preflightLineage.sha256 ||
        preflight.runId !== fixtureRunId || preflight.disposition !== "void" ||
        preflight.productionAllowed !== false || preflight.safeForAutomaticRetry !== false) {
      throw new Error("Void cleanup preflight lineage changed.");
    }
  }
  if (cleanupRunId === fixtureRunId) throw new Error("Cleanup E2E_RUN_ID must differ from the fixture run identity.");
  const artifactRoot = path.join(root, "test-artifacts");
  const artifactCollisions = [];
  function collectCollisions(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (path.relative(artifactRoot, entryPath).includes(cleanupRunId)) {
        artifactCollisions.push(path.relative(root, entryPath));
      }
      if (entry.isDirectory()) collectCollisions(entryPath);
    }
  }
  collectCollisions(artifactRoot);
  if (artifactCollisions.length > 0) {
    throw new Error(`Cleanup identity collides with existing artifacts: ${artifactCollisions.sort().join(", ")}`);
  }
  childEnv.E2E_RUN_ID = cleanupRunId;
  childEnv.E2E_DISPOSITION_RACE_FIXTURE_RUN_ID = fixtureRunId;
  childEnv.E2E_CHECKOUT_DISPOSITION_RACE_RECOVERY_ARTIFACT = path.relative(root, recoveryPath);
  childEnv.E2E_CHECKOUT_DISPOSITION_RACE_RECOVERY_SHA256 = recoverySha256;
}

const result = spawnSync(
  process.execPath,
  [
    path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs"),
    "tests/e2e/staging/release-b-checkout-replacement-race-cleanup.e2e.ts",
    ...(discoveryOnly ? ["--list"] : [])
  ],
  { cwd: root, env: childEnv, stdio: "inherit", shell: false }
);
process.exit(result.status ?? 1);
