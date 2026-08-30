import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertLiveCredentials, assertStagingBaseUrl, assertStagingSupabaseEnvironment, parseEnvFile, sanitizeRunId, STAGING_APP_URL } from "./playwright-staging-env.mjs";

const root = process.cwd();
function recursiveArtifactCollisions(directory, identity) {
  if (!fs.existsSync(directory)) return [];
  const matches = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.toLowerCase().includes(identity.toLowerCase())) matches.push(path.relative(root, target));
    }
  };
  visit(directory);
  return matches.sort();
}
const args = process.argv.slice(2);
const listOnly = args.includes("--list");
if (args.some((argument) => argument !== "--list")) throw new Error("Payment-matrix cleanup accepts only optional --list.");
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const env = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
env.E2E_BASE_URL = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
env.E2E_RUN_ID = sanitizeRunId(env.E2E_RUN_ID || (listOnly ? "payment-matrix-cleanup-discovery" : undefined));
if (!listOnly) assertLiveCredentials(env);
const selectedCase = env.E2E_PAYMENT_MATRIX_CASE || (listOnly ? "upi" : undefined);
if (!["upi", "split", "partial_previous_dues"].includes(selectedCase)) throw new Error("Cleanup requires an exact payment-matrix case.");
env.E2E_PAYMENT_MATRIX_CASE = selectedCase;

if (!listOnly) {
  env.E2E_PAYMENT_MATRIX_SOURCE_RUN_ID = sanitizeRunId(env.E2E_PAYMENT_MATRIX_SOURCE_RUN_ID);
  if (env.E2E_PAYMENT_MATRIX_SOURCE_RUN_ID === env.E2E_RUN_ID) throw new Error("Cleanup requires a fresh run identity.");
  const recoveryDirectory = path.resolve(root, "test-artifacts", "reconciliation");
  const recoveryPath = path.resolve(root, env.E2E_PAYMENT_MATRIX_RECOVERY_ARTIFACT ?? "");
  if (path.dirname(recoveryPath) !== recoveryDirectory ||
      path.basename(recoveryPath) !== `checkout-payment-matrix-reconciliation-${selectedCase}-${env.E2E_PAYMENT_MATRIX_SOURCE_RUN_ID}.json`) {
    throw new Error("Cleanup accepts only the exact immutable payment-matrix reconciliation artifact.");
  }
  const raw = fs.readFileSync(recoveryPath);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (sha256 !== env.E2E_PAYMENT_MATRIX_RECOVERY_SHA256) throw new Error("The payment-matrix recovery SHA-256 does not match.");
  const recovery = JSON.parse(raw.toString("utf8"));
  if (recovery.productionAllowed !== false || recovery.safeForAutomaticRetry !== false ||
      recovery.safeForIdentityBoundCleanup !== true || recovery.status !== "partial" ||
      recovery.runId !== env.E2E_PAYMENT_MATRIX_SOURCE_RUN_ID || recovery.selectedCase !== selectedCase ||
      !Array.isArray(recovery.integrityFailures) || recovery.integrityFailures.length !== 0 ||
      recovery.outcomeClassification?.some((entry) => entry.outcome === "ambiguous") ||
      !Array.isArray(recovery.snapshot?.cleanupCandidates) || recovery.snapshot.cleanupCandidates.length === 0) {
    throw new Error("The payment-matrix recovery artifact does not authorize cleanup.");
  }
  const cleanupArtifactCollisions = recursiveArtifactCollisions(path.join(root, "test-artifacts"), env.E2E_RUN_ID);
  if (cleanupArtifactCollisions.length !== 0) {
    throw new Error(`Cleanup run identity already exists in test-artifacts: ${cleanupArtifactCollisions.join(", ")}`);
  }
  env.E2E_PAYMENT_MATRIX_RECOVERY_ARTIFACT = recoveryPath;
}

console.log(JSON.stringify({ runner: "checkout-payment-matrix-cleanup", selectedCase, cleanupRunId: env.E2E_RUN_ID,
  sourceRunId: env.E2E_PAYMENT_MATRIX_SOURCE_RUN_ID, discoveryOnly: listOnly, productionAllowed: false,
  safeForAutomaticRetry: false, workers: 1, retries: 0 }));
const cli = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const browser = spawnSync(process.execPath, [cli, "test", "--config=playwright.payment-matrix-cleanup.staging.config.ts", ...(listOnly ? ["--list"] : [])],
  { cwd: root, env, stdio: "inherit", shell: false });
if (listOnly) process.exit(browser.status ?? 1);
const postflight = spawnSync(process.execPath, [path.join(root, "scripts", "reconcile-checkout-payment-matrix-cleanup-staging.mjs")],
  { cwd: root, env, stdio: "inherit", shell: false });
process.exit(browser.status === 0 && postflight.status === 0 ? 0 : 1);
