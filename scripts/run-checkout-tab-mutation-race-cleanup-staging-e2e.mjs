import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sanitizeRunId, STAGING_PROJECT_REF } from "./playwright-staging-env.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => argument !== "--list")) {
  throw new Error("Checkout-tab-mutation cleanup accepts only --list or one exact execution.");
}
const root = process.cwd();
const discoveryOnly = args[0] === "--list";
const childEnv = { ...process.env };

if (!discoveryOnly) {
  if (!childEnv.E2E_RUN_ID?.trim()) throw new Error("A fresh explicit E2E_RUN_ID is required for cleanup.");
  const cleanupRunId = sanitizeRunId(childEnv.E2E_RUN_ID);
  const requested = childEnv.E2E_TAB_MUTATION_RACE_RECOVERY_ARTIFACT?.trim();
  if (!requested) throw new Error("E2E_TAB_MUTATION_RACE_RECOVERY_ARTIFACT is required.");
  const recoveryPath = path.resolve(root, requested);
  const recoveryDirectory = path.resolve(root, "test-artifacts", "reconciliation");
  if (path.dirname(recoveryPath) !== recoveryDirectory ||
      !/^checkout-tab-mutation-race-recovery-[A-Za-z0-9_-]+\.json$/.test(path.basename(recoveryPath))) {
    throw new Error("Cleanup accepts only an immutable checkout-tab-mutation recovery artifact.");
  }
  const recoveryBytes = fs.readFileSync(recoveryPath);
  const recovery = JSON.parse(recoveryBytes.toString("utf8"));
  if (recovery.safeForIdentityBoundCleanup !== true || recovery.safeForAutomaticRetry !== false ||
      recovery.productionAllowed !== false || recovery.projectRef !== STAGING_PROJECT_REF ||
      !Array.isArray(recovery.failures) || recovery.failures.length !== 0) {
    throw new Error("Recovery evidence does not authorize identity-bound staging cleanup.");
  }
  const sourceRunId = sanitizeRunId(recovery.runId);
  if (cleanupRunId === sourceRunId) throw new Error("Cleanup E2E_RUN_ID must differ from the source race identity.");
  const artifactRoot = path.join(root, "test-artifacts");
  const collisions = [];
  function scan(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (path.relative(artifactRoot, entryPath).includes(cleanupRunId)) collisions.push(path.relative(root, entryPath));
      if (entry.isDirectory()) scan(entryPath);
    }
  }
  scan(artifactRoot);
  if (collisions.length) throw new Error(`Cleanup identity collides with existing artifacts: ${collisions.sort().join(", ")}`);
  childEnv.E2E_RUN_ID = cleanupRunId;
  childEnv.E2E_TAB_MUTATION_SOURCE_RUN_ID = sourceRunId;
  childEnv.E2E_TAB_MUTATION_RACE_RECOVERY_ARTIFACT = path.relative(root, recoveryPath);
  childEnv.E2E_TAB_MUTATION_RECOVERY_SHA256 = createHash("sha256").update(recoveryBytes).digest("hex");
}

const result = spawnSync(process.execPath, [
  path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs"),
  "tests/e2e/staging/release-b-checkout-tab-mutation-race-cleanup.e2e.ts",
  ...args
], { cwd: root, env: childEnv, stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
