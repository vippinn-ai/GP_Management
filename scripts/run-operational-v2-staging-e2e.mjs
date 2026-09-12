import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  assertLiveCredentials,
  assertOperationalRunId,
  assertStagingBaseUrl,
  assertStagingSupabaseEnvironment,
  parseEnvFile,
  PRODUCTION_PROJECT_REF,
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
const generatedRunStamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
env.E2E_RUN_ID = assertOperationalRunId(env.E2E_RUN_ID || `normops-${generatedRunStamp.slice(0, 8)}-${generatedRunStamp.slice(8)}-discovery`);
env.E2E_ROLE_MATRIX = "release-b-receptionist-manager";
env.E2E_ROLE_MATRIX_PHASE = "all";
if (!discoveryOnly) assertLiveCredentials(env);

const evidenceRoot = path.join(root, "test-artifacts", "playwright");
const outputDir = path.join(evidenceRoot, `operational-v2-run-${env.E2E_RUN_ID}`);
const summaryPath = path.join(evidenceRoot, `summary-${env.E2E_RUN_ID}.json`);
const evidenceManifestPath = path.join(evidenceRoot, `evidence-manifest-${env.E2E_RUN_ID}.json`);
for (const evidencePath of [outputDir, summaryPath, evidenceManifestPath]) {
  if (fs.existsSync(evidencePath)) throw new Error(`Run id ${env.E2E_RUN_ID} already has evidence; choose a fresh run id.`);
}

let databaseManifest;
let databaseManifestPath;
if (!discoveryOnly) {
  if (!/^[a-f0-9]{64}$/i.test(env.E2E_EXPECTED_BUNDLE_SHA256 || "")) {
    throw new Error("Live staging E2E requires E2E_EXPECTED_BUNDLE_SHA256 from the approved candidate deployment.");
  }
  if (!env.E2E_DB_MANIFEST_PATH || !env.E2E_DB_MANIFEST_SHA256) {
    throw new Error("Live staging E2E requires E2E_DB_MANIFEST_PATH and E2E_DB_MANIFEST_SHA256.");
  }
  databaseManifestPath = path.resolve(root, env.E2E_DB_MANIFEST_PATH);
  const databaseManifestText = fs.readFileSync(databaseManifestPath, "utf8");
  const actualManifestSha = createHash("sha256").update(databaseManifestText).digest("hex");
  if (actualManifestSha !== env.E2E_DB_MANIFEST_SHA256.toLowerCase()) throw new Error("Database manifest SHA-256 does not match the approved value.");
  databaseManifest = JSON.parse(databaseManifestText);
  if (databaseManifest.target?.projectRef !== STAGING_PROJECT_REF) throw new Error("Database manifest is not for staging.");
}

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
  if (deployedArtifact.sha256 !== env.E2E_EXPECTED_BUNDLE_SHA256.toLowerCase()) {
    throw new Error("Deployed staging bundle SHA-256 is not the approved candidate.");
  }
}

console.log(JSON.stringify({
  runner: "operational-v2-staging-playwright",
  baseUrl: env.E2E_BASE_URL,
  runId: env.E2E_RUN_ID,
  discoveryOnly,
  deployedArtifact,
  databaseManifest: databaseManifest ? { path: path.relative(root, databaseManifestPath), runId: databaseManifest.runId, sha256: env.E2E_DB_MANIFEST_SHA256 } : undefined,
  credentials: discoveryOnly ? "not-required" : "loaded-from-ignored-environment",
  productionAllowed: false,
  retries: 0
}));

const cliPath = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const result = spawnSync(process.execPath, [cliPath, "test", "--config=playwright.operational-v2.staging.config.ts", ...args], {
  cwd: root, env, stdio: "inherit", shell: false
});

if (!discoveryOnly) {
  const files = [];
  const visit = (entryPath) => {
    if (!fs.existsSync(entryPath)) return;
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entryPath).sort()) visit(path.join(entryPath, name));
      return;
    }
    const bytes = fs.readFileSync(entryPath);
    files.push({ path: path.relative(root, entryPath), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  };
  visit(outputDir);
  visit(summaryPath);
  fs.writeFileSync(evidenceManifestPath, JSON.stringify({
    runId: env.E2E_RUN_ID,
    createdAt: new Date().toISOString(),
    exitCode: result.status ?? 1,
    deployedArtifact,
    databaseManifest: { path: path.relative(root, databaseManifestPath), sha256: env.E2E_DB_MANIFEST_SHA256 },
    files
  }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}
process.exit(result.status ?? 1);
