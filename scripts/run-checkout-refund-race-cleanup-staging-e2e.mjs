import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sanitizeRunId } from "./playwright-staging-env.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => argument !== "--list")) {
  throw new Error("Refund-race cleanup accepts only --list or one exact execution.");
}

const root = process.cwd();
const discoveryOnly = args[0] === "--list";
const childEnv = { ...process.env, E2E_CLEANUP_RACE_KIND: "refund" };

if (!discoveryOnly) {
  const requestedCleanupRunId = process.env.E2E_RUN_ID?.trim();
  if (!requestedCleanupRunId) throw new Error("An explicit E2E_RUN_ID is required for refund-race cleanup.");
  const cleanupRunId = sanitizeRunId(requestedCleanupRunId);
  const requested = childEnv.E2E_REFUND_RACE_RECOVERY_ARTIFACT?.trim();
  if (!requested) throw new Error("E2E_REFUND_RACE_RECOVERY_ARTIFACT is required.");
  const recoveryPath = path.resolve(root, requested);
  const recoveryDirectory = path.resolve(root, "test-artifacts", "reconciliation");
  if (
    path.dirname(recoveryPath) !== recoveryDirectory ||
    !/^checkout-refund-race-recovery-[A-Za-z0-9_-]+\.json$/.test(path.basename(recoveryPath))
  ) {
    throw new Error("Cleanup accepts only an immutable refund-race recovery artifact.");
  }
  const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
  if (
    recovery.safeForIdentityBoundCleanup !== true ||
    recovery.safeForAutomaticRetry !== false ||
    recovery.productionAllowed !== false
  ) {
    throw new Error("Recovery evidence does not authorize identity-bound cleanup.");
  }
  const fixtureRunId = sanitizeRunId(recovery.runId);
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
  childEnv.E2E_REFUND_RACE_FIXTURE_RUN_ID = fixtureRunId;
  childEnv.E2E_REFUND_RACE_RECOVERY_ARTIFACT = path.relative(root, recoveryPath);
}

const result = spawnSync(
  process.execPath,
  [
    path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs"),
    "tests/e2e/staging/release-b-checkout-replacement-race-cleanup.e2e.ts",
    ...args
  ],
  { cwd: root, env: childEnv, stdio: "inherit", shell: false }
);
process.exit(result.status ?? 1);
