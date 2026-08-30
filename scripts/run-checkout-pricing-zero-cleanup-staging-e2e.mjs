import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertLiveCredentials, assertStagingBaseUrl, assertStagingSupabaseEnvironment, parseEnvFile, sanitizeRunId, STAGING_APP_URL, STAGING_PROJECT_REF } from "./playwright-staging-env.mjs";

const root = process.cwd();
const allowedCases = ["discount_rounding_positive", "ltp_zero", "bill_discount_zero", "true_zero_price_guard"];
const args = process.argv.slice(2);
const discovery = args.length === 1 && args[0] === "--list";
if ((!discovery && args.length !== 0) || (discovery && args.length !== 1)) throw new Error("Pricing cleanup accepts no arguments or exactly --list.");
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
env.E2E_BASE_URL = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
env.E2E_RUN_ID = sanitizeRunId(discovery ? env.E2E_RUN_ID || "discovery-pricing-cleanup" : env.E2E_RUN_ID);

let recoveryPath;
if (!discovery) {
  assertLiveCredentials(env);
  if (!env.E2E_PRICING_SOURCE_RUN_ID || !env.E2E_PRICING_RECOVERY_ARTIFACT || !env.E2E_PRICING_RECOVERY_SHA256) throw new Error("Exact source run, recovery artifact, and SHA-256 are required.");
  const sourceRunId = sanitizeRunId(env.E2E_PRICING_SOURCE_RUN_ID);
  if (env.E2E_RUN_ID === sourceRunId) throw new Error("Cleanup run ID must be fresh and distinct from the source run ID.");
  recoveryPath = path.resolve(env.E2E_PRICING_RECOVERY_ARTIFACT);
  const expectedDirectory = path.resolve(root, "test-artifacts", "evidence");
  if (path.dirname(recoveryPath) !== expectedDirectory) throw new Error("Recovery artifact is outside the exact pricing evidence directory.");
  const raw = fs.readFileSync(recoveryPath);
  if (createHash("sha256").update(raw).digest("hex") !== env.E2E_PRICING_RECOVERY_SHA256) throw new Error("Recovery artifact SHA-256 mismatch.");
  const recovery = JSON.parse(raw.toString("utf8"));
  const recoveryBasename = path.basename(recoveryPath);
  const exactRecoveryNames = [
    `checkout-pricing-reconciliation-${recovery.selectedCase}-${sourceRunId}.json`,
    `checkout-pricing-reanalysis-${recovery.selectedCase}-${sourceRunId}.json`
  ];
  if (!allowedCases.includes(recovery.selectedCase) || !exactRecoveryNames.includes(recoveryBasename)) throw new Error("Recovery artifact filename/case/source identity is not exact.");
  if (recoveryBasename.startsWith("checkout-pricing-reanalysis-") && (!recovery.reanalysisOf?.path || !recovery.reanalysisOf?.sha256)) throw new Error("Reanalysis recovery is missing its immutable original lineage.");
  if (recovery.projectRef !== STAGING_PROJECT_REF || recovery.productionAllowed !== false || recovery.safeForAutomaticRetry !== false || recovery.status !== "partial" || recovery.safeForIdentityBoundCleanup !== true || recovery.integrityFailures.length !== 0 || recovery.ambiguities.length !== 0 || recovery.runId !== sourceRunId) throw new Error("Recovery artifact does not authorize exact identity-bound cleanup.");
  const sessions = recovery.snapshot.cleanupCandidates ?? [];
  const item = recovery.snapshot.itemCleanupCandidate ?? null;
  if (sessions.length > 1 || (sessions.length === 0 && !item)) throw new Error("Recovery artifact has no singular exact cleanup action set.");
  const collisions = [];
  function scan(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.name.includes(env.E2E_RUN_ID)) collisions.push(path.relative(root, target));
      if (entry.isDirectory()) scan(target);
    }
  }
  scan(path.join(root, "test-artifacts"));
  if (collisions.length) throw new Error(`Cleanup run ID collides with existing artifacts: ${collisions.join(", ")}`);
  const session = sessions[0] ?? null;
  env.E2E_PRICING_CASE = recovery.selectedCase;
  env.E2E_PRICING_RECOVERY_ARTIFACT = recoveryPath;
  env.E2E_PRICING_SOURCE_RUN_ID = sourceRunId;
  env.E2E_PRICING_CLEANUP_SESSION_ID = session?.id ?? "";
  env.E2E_PRICING_CUSTOMER_NAME = recovery.customerName;
  env.E2E_PRICING_UNIT_STATION = session?.stationName ?? "";
  env.E2E_PRICING_ZERO_ITEM_ID = item?.id ?? "";
  env.E2E_PRICING_ZERO_ITEM_NAME = item?.name ?? "";
  env.E2E_PRICING_ZERO_ITEM_BARCODE = item?.barcode ?? "";
  env.E2E_PRICING_CLEANUP_BASE_VERSION = String(recovery.appState.version);
  env.E2E_PRICING_CLEANUP_BASE_HASH = recovery.appState.hash;
  env.E2E_PRICING_CLEANUP_EXPECTED_EFFECTS = String(sessions.length + (item ? 1 : 0));
}
console.log(JSON.stringify({ runner: "release-b-checkout-pricing-cleanup", runId: env.E2E_RUN_ID, discoveryOnly: discovery, recoveryArtifact: recoveryPath ? path.relative(root, recoveryPath) : null, productionAllowed: false, safeForAutomaticRetry: false, workers: 1, retries: 0 }));
const cli = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const browser = spawnSync(process.execPath, [cli, "test", "--config=playwright.pricing-zero-cleanup.staging.config.ts", ...(discovery ? ["--list"] : [])], { cwd: root, env, stdio: "inherit", shell: false });
if (discovery) process.exit(browser.status ?? 1);
const postflight = spawnSync(process.execPath, [path.join(root, "scripts", "reconcile-checkout-pricing-zero-cleanup-staging.mjs")], { cwd: root, env, stdio: "inherit", shell: false });
process.exit(browser.status === 0 && postflight.status === 0 ? 0 : 1);
