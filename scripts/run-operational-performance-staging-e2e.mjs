import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
const mode = env.E2E_PERFORMANCE_MODE === "baseline" ? "baseline" : env.E2E_PERFORMANCE_MODE === "candidate" ? "candidate" : undefined;
if (!mode && !discoveryOnly) throw new Error("E2E_PERFORMANCE_MODE must be baseline or candidate.");

assertStagingSupabaseEnvironment(stagingEnv, true);
env.E2E_BASE_URL = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
const generatedRunStamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
env.E2E_RUN_ID = assertOperationalRunId(env.E2E_RUN_ID || `normops-${generatedRunStamp.slice(0, 8)}-${generatedRunStamp.slice(8)}-perf-discovery`);
env.E2E_PERFORMANCE_MODE = mode || "baseline";
env.E2E_PERFORMANCE_SAMPLES = "30";
if (!discoveryOnly && (!env.E2E_USER_A?.trim() || !env.E2E_PASSWORD_A?.trim())) {
  throw new Error("Performance E2E requires the staging-only browser A credentials.");
}

const artifactRoot = path.join(root, "test-artifacts", "playwright");
const outputDir = path.join(artifactRoot, `operational-performance-${env.E2E_RUN_ID}`);
const summaryPath = path.join(artifactRoot, `summary-${env.E2E_RUN_ID}.json`);
const manifestPath = path.join(artifactRoot, `performance-evidence-manifest-${env.E2E_RUN_ID}.json`);
for (const evidencePath of [outputDir, summaryPath, manifestPath]) {
  if (fs.existsSync(evidencePath)) throw new Error(`Run id ${env.E2E_RUN_ID} already has performance evidence.`);
}

let deployedArtifact;
if (!discoveryOnly) {
  const htmlResponse = await fetch(env.E2E_BASE_URL, { redirect: "error" });
  if (!htmlResponse.ok) throw new Error(`Unable to read staging shell (${htmlResponse.status}).`);
  const html = await htmlResponse.text();
  const scriptPath = html.match(/<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i)?.[1];
  if (!scriptPath) throw new Error("Unable to identify the deployed staging bundle.");
  const bundleUrl = new URL(scriptPath, env.E2E_BASE_URL);
  const bundleResponse = await fetch(bundleUrl, { redirect: "error" });
  if (!bundleResponse.ok) throw new Error(`Unable to read staging bundle (${bundleResponse.status}).`);
  const bundle = await bundleResponse.text();
  if (!bundle.includes(STAGING_PROJECT_REF) || bundle.includes(PRODUCTION_PROJECT_REF)) throw new Error("Performance target is not the staging bundle.");
  deployedArtifact = { bundle: bundleUrl.pathname, sha256: createHash("sha256").update(bundle).digest("hex") };
  if (mode === "candidate") {
    if (!/^[a-f0-9]{64}$/i.test(env.E2E_EXPECTED_BUNDLE_SHA256 || "") || deployedArtifact.sha256 !== env.E2E_EXPECTED_BUNDLE_SHA256.toLowerCase()) {
      throw new Error("Candidate performance target does not match the approved bundle SHA-256.");
    }
    if (!env.E2E_PERFORMANCE_BASELINE_PATH || !/^[a-f0-9]{64}$/i.test(env.E2E_PERFORMANCE_BASELINE_SHA256 || "")) {
      throw new Error("Candidate performance run requires the immutable baseline artifact and SHA-256.");
    }
  }
}

console.log(JSON.stringify({
  runner: "operational-performance-staging-playwright",
  baseUrl: env.E2E_BASE_URL,
  runId: env.E2E_RUN_ID,
  mode: env.E2E_PERFORMANCE_MODE,
  sampleCount: 30,
  discoveryOnly,
  deployedArtifact,
  productionAllowed: false,
  writesAllowed: false,
  workers: 1,
  retries: 0
}));

const cli = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const result = spawnSync(process.execPath, [cli, "test", "--config=playwright.operational-performance.staging.config.ts", ...args], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: false
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
  fs.writeFileSync(manifestPath, JSON.stringify({
    runId: env.E2E_RUN_ID,
    mode: env.E2E_PERFORMANCE_MODE,
    sampleCount: 30,
    createdAt: new Date().toISOString(),
    exitCode: result.status ?? 1,
    deployedArtifact,
    baseline: mode === "candidate" ? {
      path: env.E2E_PERFORMANCE_BASELINE_PATH,
      sha256: env.E2E_PERFORMANCE_BASELINE_SHA256
    } : undefined,
    files
  }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}

process.exit(result.status ?? 1);
