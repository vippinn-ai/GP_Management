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

async function verifyDeployedStagingArtifact(baseUrl) {
  const htmlResponse = await fetch(baseUrl, { redirect: "error" });
  if (!htmlResponse.ok) throw new Error(`Unable to read the staging application shell (${htmlResponse.status}).`);
  const html = await htmlResponse.text();
  const scriptPath = html.match(/<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i)?.[1];
  if (!scriptPath) throw new Error("Unable to identify the deployed staging JavaScript bundle.");
  const bundleUrl = new URL(scriptPath, baseUrl);
  if (bundleUrl.origin !== new URL(STAGING_APP_URL).origin) {
    throw new Error("The deployed bundle resolved outside the approved staging origin.");
  }
  const bundleResponse = await fetch(bundleUrl, { redirect: "error" });
  if (!bundleResponse.ok) throw new Error(`Unable to read the deployed staging bundle (${bundleResponse.status}).`);
  const bundle = await bundleResponse.text();
  if (!bundle.includes(STAGING_PROJECT_REF) || bundle.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error("The deployed staging bundle failed its Supabase project-reference guard.");
  }
  return {
    bundle: bundleUrl.pathname,
    sha256: createHash("sha256").update(bundle).digest("hex")
  };
}

const root = process.cwd();
const args = process.argv.slice(2);
const discoveryOnly = args.includes("--list") || args.includes("--help");
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const env = { ...localEnv, ...process.env };

assertStagingSupabaseEnvironment(stagingEnv);
env.E2E_BASE_URL = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
env.E2E_RUN_ID = sanitizeRunId(env.E2E_RUN_ID);
if (!discoveryOnly) assertLiveCredentials(env);
const deployedArtifact = discoveryOnly ? undefined : await verifyDeployedStagingArtifact(env.E2E_BASE_URL);

console.log(
  JSON.stringify({
    runner: "release-a-staging-playwright",
    baseUrl: env.E2E_BASE_URL,
    runId: env.E2E_RUN_ID,
    discoveryOnly,
    deployedArtifact,
    credentials: discoveryOnly ? "not-required" : "loaded-from-ignored-environment",
    productionAllowed: false,
    retries: 0
  })
);

const cliPath = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const result = spawnSync(
  process.execPath,
  [cliPath, "test", "--config=playwright.staging.config.ts", ...args],
  { cwd: root, env, stdio: "inherit", shell: false }
);

process.exit(result.status ?? 1);
