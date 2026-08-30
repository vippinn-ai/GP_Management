import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertLiveCredentials, assertStagingBaseUrl, assertStagingSupabaseEnvironment, parseEnvFile, sanitizeRunId, STAGING_APP_URL } from "./playwright-staging-env.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const listOnly = args.length === 1 && args[0] === "--list";
if (args.length > 1 || (args.length === 1 && !listOnly)) throw new Error("Replacement-parity cleanup accepts only optional --list.");
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const env = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
env.E2E_BASE_URL = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
env.E2E_RUN_ID = sanitizeRunId(env.E2E_RUN_ID || (listOnly ? "discovery-replacement-parity-cleanup" : undefined));

if (!listOnly) {
  assertLiveCredentials(env);
  env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID = sanitizeRunId(env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID);
  if (env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID === env.E2E_RUN_ID) throw new Error("Cleanup run ID must be fresh and distinct from the source run ID.");
  const recoveryPath = path.resolve(env.E2E_REPLACEMENT_PARITY_RECOVERY_ARTIFACT ?? "");
  const expectedPaths = ["reconciliation", "reanalysis"].map((kind) => path.join(root, "test-artifacts", "evidence", `checkout-replacement-parity-${kind}-${env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID}.json`));
  if (!expectedPaths.includes(recoveryPath)) throw new Error("Cleanup accepts only the exact immutable replacement-parity reconciliation or reanalysis artifact.");
  const raw = fs.readFileSync(recoveryPath);
  if (createHash("sha256").update(raw).digest("hex") !== env.E2E_REPLACEMENT_PARITY_RECOVERY_SHA256) throw new Error("Recovery artifact SHA-256 mismatch.");
  const recovery = JSON.parse(raw.toString("utf8"));
  if (recovery.runId !== env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID || recovery.status !== "partial" || recovery.productionAllowed !== false || recovery.safeForAutomaticRetry !== false || recovery.safeForIdentityBoundCleanup !== true || recovery.integrityFailures?.length !== 0 || recovery.ambiguities?.length !== 0 || (!recovery.recovery?.rejectTab && !recovery.recovery?.archiveItem)) {
    throw new Error("The recovery artifact does not authorize exact identity-bound cleanup.");
  }
  const collisions = [];
  const scan = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.name.includes(env.E2E_RUN_ID)) collisions.push(path.relative(root, target));
      if (entry.isDirectory()) scan(target);
    }
  };
  scan(path.join(root, "test-artifacts"));
  if (collisions.length) throw new Error(`Cleanup run ID collides with existing artifacts: ${collisions.join(", ")}`);
  env.E2E_REPLACEMENT_PARITY_RECOVERY_ARTIFACT = recoveryPath;
}

console.log(JSON.stringify({ runner: "release-b-checkout-replacement-parity-cleanup", cleanupRunId: env.E2E_RUN_ID, sourceRunId: env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID, discoveryOnly: listOnly, productionAllowed: false, safeForAutomaticRetry: false, workers: 1, retries: 0 }));
const cli = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const browser = spawnSync(process.execPath, [cli, "test", "--config=playwright.replacement-parity-cleanup.staging.config.ts", ...(listOnly ? ["--list"] : [])], { cwd: root, env, stdio: "inherit", shell: false });
if (listOnly) process.exit(browser.status ?? 1);
const postflight = spawnSync(process.execPath, [path.join(root, "scripts", "reconcile-checkout-replacement-parity-cleanup-staging.mjs")], { cwd: root, env, stdio: "inherit", shell: false });
process.exit(browser.status === 0 && postflight.status === 0 ? 0 : 1);
