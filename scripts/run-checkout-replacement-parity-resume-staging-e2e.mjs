import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertLiveCredentials, assertStagingBaseUrl, assertStagingSupabaseEnvironment, parseEnvFile, sanitizeRunId, STAGING_APP_URL } from "./playwright-staging-env.mjs";

const root = process.cwd();
const AUTHORIZED_SOURCE_RUN_ID = "replacement-parity-20260830-1542";
const AUTHORIZED_RECOVERY_SHA256 = "2879af27e847c5b321037f335c5494aac4b8d9dd4749518717eaf65241a087e7";
const args = process.argv.slice(2);
const listOnly = args.length === 1 && args[0] === "--list";
if (args.length > 1 || (args.length === 1 && !listOnly)) throw new Error("Replacement-parity resume accepts only optional --list.");
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const env = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
env.E2E_BASE_URL = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
env.E2E_RUN_ID = sanitizeRunId(env.E2E_RUN_ID || (listOnly ? "discovery-replacement-parity-resume" : undefined));

if (!listOnly) {
  assertLiveCredentials(env);
  env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID = sanitizeRunId(env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID);
  if (env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID !== AUTHORIZED_SOURCE_RUN_ID) throw new Error("Resume source run is not the independently reviewed run.");
  if (env.E2E_REPLACEMENT_PARITY_RECOVERY_SHA256 !== AUTHORIZED_RECOVERY_SHA256) throw new Error("Resume recovery SHA is not the independently reviewed SHA.");
  if (env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID === env.E2E_RUN_ID) throw new Error("Resume run ID must be fresh and distinct from the source run ID.");
  const recoveryPath = path.resolve(env.E2E_REPLACEMENT_PARITY_RECOVERY_ARTIFACT ?? "");
  const expectedPath = path.join(root, "test-artifacts", "evidence", `checkout-replacement-parity-reanalysis-${env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID}.json`);
  if (recoveryPath !== expectedPath) throw new Error("Resume accepts only the exact immutable read-only reanalysis artifact.");
  const recoveryRaw = fs.readFileSync(recoveryPath);
  const recoverySha = createHash("sha256").update(recoveryRaw).digest("hex");
  if (recoverySha !== env.E2E_REPLACEMENT_PARITY_RECOVERY_SHA256) throw new Error("Recovery artifact SHA-256 mismatch.");
  const recovery = JSON.parse(recoveryRaw.toString("utf8"));
  if (recovery.runId !== env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID || recovery.status !== "partial" || recovery.productionAllowed !== false || recovery.safeForAutomaticRetry !== false || recovery.safeForIdentityBoundCleanup !== true || recovery.integrityFailures?.length !== 0 || recovery.ambiguities?.length !== 0 || recovery.completionFailures?.join("|") !== "Browser terminal evidence is missing.") {
    throw new Error("The reanalysis artifact does not authorize a read-only downstream resume.");
  }
  const preflightPath = path.resolve(root, recovery.evidence?.preflight?.path ?? "");
  const preflightRaw = fs.readFileSync(preflightPath);
  if (createHash("sha256").update(preflightRaw).digest("hex") !== recovery.evidence?.preflight?.sha256) throw new Error("Source preflight SHA-256 mismatch.");
  const preflight = JSON.parse(preflightRaw.toString("utf8"));
  if (!preflight.pendingReceivable?.bill_number || Number(preflight.pendingReceivable.amount_due) <= 0) throw new Error("The source preflight no longer provides a bound pending receivable.");
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
  if (collisions.length) throw new Error(`Resume run ID collides with existing artifacts: ${collisions.join(", ")}`);
  env.E2E_REPLACEMENT_PARITY_RECOVERY_ARTIFACT = recoveryPath;
  env.E2E_REPLACEMENT_PARITY_PREFLIGHT_ARTIFACT = preflightPath;
}

console.log(JSON.stringify({ runner: "release-b-checkout-replacement-parity-resume", resumeRunId: env.E2E_RUN_ID, sourceRunId: env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID, discoveryOnly: listOnly, readOnly: true, productionAllowed: false, safeForAutomaticRetry: false, workers: 1, retries: 0 }));
const cli = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const result = spawnSync(process.execPath, [cli, "test", "--config=playwright.replacement-parity-resume.staging.config.ts", ...(listOnly ? ["--list"] : [])], { cwd: root, env, stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
