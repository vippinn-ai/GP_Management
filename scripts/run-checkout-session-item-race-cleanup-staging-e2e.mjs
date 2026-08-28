import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sanitizeRunId, STAGING_PROJECT_REF } from "./playwright-staging-env.mjs";
import { loadSessionItemRaceAdmin } from "./session-item-race-admin-env.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => argument !== "--list")) {
  throw new Error("Session-item race cleanup accepts only --list or one exact execution.");
}

const root = process.cwd();
const discoveryOnly = args[0] === "--list";
const childEnv = { ...process.env };

if (!discoveryOnly) {
  const cleanupRunId = sanitizeRunId(childEnv.E2E_RUN_ID);
  const requested = childEnv.E2E_SESSION_ITEM_RACE_RECOVERY_ARTIFACT?.trim();
  if (!requested) throw new Error("E2E_SESSION_ITEM_RACE_RECOVERY_ARTIFACT is required.");
  const recoveryPath = path.resolve(root, requested);
  const recoveryDirectory = path.resolve(root, "test-artifacts", "reconciliation");
  if (
    path.dirname(recoveryPath) !== recoveryDirectory ||
    !/^checkout-session-item-race-recovery-[A-Za-z0-9_-]+\.json$/.test(path.basename(recoveryPath))
  ) {
    throw new Error("Cleanup accepts only an immutable session-item race recovery artifact.");
  }
  const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
  if (
    recovery.safeForIdentityBoundCleanup !== true ||
    recovery.safeForAutomaticRetry !== false ||
    recovery.productionAllowed !== false ||
    recovery.projectRef !== STAGING_PROJECT_REF
  ) {
    throw new Error("Recovery evidence does not authorize identity-bound staging cleanup.");
  }
  if (recovery.temporaryAdmin) {
    const temporaryAdmin = loadSessionItemRaceAdmin(root, { required: true });
    if (
      recovery.temporaryAdmin.accountRunId !== temporaryAdmin.accountRunId ||
      recovery.temporaryAdmin.actorId !== temporaryAdmin.actorId ||
      recovery.temporaryAdmin.createArtifactSha256 !== temporaryAdmin.createArtifactSha256 ||
      recovery.actors?.item !== temporaryAdmin.actorId
    ) {
      throw new Error("Recovery evidence does not match the exact active temporary staging admin lifecycle.");
    }
    Object.assign(childEnv, temporaryAdmin.overlay);
  }
  const fixtureRunId = sanitizeRunId(recovery.runId);
  if (cleanupRunId === fixtureRunId) throw new Error("Cleanup E2E_RUN_ID must differ from the fixture run identity.");
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
  childEnv.E2E_SESSION_ITEM_RACE_FIXTURE_RUN_ID = fixtureRunId;
  childEnv.E2E_SESSION_ITEM_RACE_RECOVERY_ARTIFACT = path.relative(root, recoveryPath);
}

const result = spawnSync(
  process.execPath,
  [
    path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs"),
    "tests/e2e/staging/release-b-checkout-session-item-race-cleanup.e2e.ts",
    ...args
  ],
  { cwd: root, env: childEnv, stdio: "inherit", shell: false }
);
process.exit(result.status ?? 1);
