import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  assertLiveCredentials,
  assertStagingBaseUrl,
  assertStagingSupabaseEnvironment,
  parseEnvFile,
  PRODUCTION_PROJECT_REF,
  sanitizeRunId,
  STAGING_APP_URL,
  STAGING_PROJECT_REF
} from "./playwright-staging-env.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const discoveryOnly = args.includes("--list") || args.includes("--help");
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const env = { ...localEnv, ...process.env };

assertStagingSupabaseEnvironment(stagingEnv, true);
for (const flag of [
  "VITE_BACKEND_OPERATIONAL_RPC_V2",
  "VITE_BACKEND_RPC_OPERATIONAL_WRITES",
  "VITE_BACKEND_NORMALIZED_BOOTSTRAP",
  "VITE_BACKEND_NORMALIZED_LIVE_READS",
  "VITE_BACKEND_NORMALIZED_REALTIME"
]) {
  if (stagingEnv[flag] !== "true") throw new Error(`Operational v2 staging E2E requires ${flag}=true.`);
}
env.E2E_BASE_URL = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
env.E2E_RUN_ID = sanitizeRunId(env.E2E_RUN_ID);
if (!discoveryOnly) assertLiveCredentials(env);

let deployedArtifact;
if (!discoveryOnly) {
  const htmlResponse = await fetch(env.E2E_BASE_URL, { redirect: "error" });
  if (!htmlResponse.ok) throw new Error(`Unable to read staging shell (${htmlResponse.status}).`);
  const html = await htmlResponse.text();
  const scriptPath = html.match(/<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i)?.[1];
  if (!scriptPath) throw new Error("Unable to identify the deployed staging JavaScript bundle.");
  const bundleUrl = new URL(scriptPath, env.E2E_BASE_URL);
  const bundleResponse = await fetch(bundleUrl, { redirect: "error" });
  if (!bundleResponse.ok) throw new Error(`Unable to read staging bundle (${bundleResponse.status}).`);
  const bundle = await bundleResponse.text();
  if (!bundle.includes(STAGING_PROJECT_REF) || bundle.includes(PRODUCTION_PROJECT_REF)) throw new Error("Deployed bundle failed the staging project guard.");
  deployedArtifact = { bundle: bundleUrl.pathname, sha256: createHash("sha256").update(bundle).digest("hex") };
}

console.log(JSON.stringify({
  runner: "operational-v2-staging-playwright",
  baseUrl: env.E2E_BASE_URL,
  runId: env.E2E_RUN_ID,
  discoveryOnly,
  deployedArtifact,
  credentials: discoveryOnly ? "not-required" : "loaded-from-ignored-environment",
  productionAllowed: false,
  retries: 0
}));

const cliPath = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const result = spawnSync(process.execPath, [cliPath, "test", "--config=playwright.operational-v2.staging.config.ts", ...args], {
  cwd: root, env, stdio: "inherit", shell: false
});
process.exit(result.status ?? 1);
