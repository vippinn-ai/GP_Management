import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
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
if (!discoveryOnly && !/^[a-z0-9][a-z0-9._-]{5,80}$/i.test(env.E2E_PERFORMANCE_PROFILE_ID?.trim() || "")) {
  throw new Error("Performance E2E requires a stable E2E_PERFORMANCE_PROFILE_ID describing the host and network window.");
}

function readBoundJson(pathValue, shaValue, label) {
  if (!pathValue || !/^[a-f0-9]{64}$/i.test(shaValue || "")) throw new Error(`${label} path and SHA-256 are required.`);
  const absolutePath = path.resolve(root, pathValue);
  const textValue = fs.readFileSync(absolutePath, "utf8");
  const actualSha = createHash("sha256").update(textValue).digest("hex");
  if (actualSha !== shaValue.toLowerCase()) throw new Error(`${label} SHA-256 does not match.`);
  return { absolutePath, sha256: actualSha, value: JSON.parse(textValue) };
}

let datasetManifest;
let postflightVerification;
let profileManifest;
let baselineManifest;
let databaseManifest;
if (!discoveryOnly) {
  profileManifest = readBoundJson(
    env.E2E_PERFORMANCE_PROFILE_MANIFEST_PATH,
    env.E2E_PERFORMANCE_PROFILE_MANIFEST_SHA256,
    "Performance environment profile manifest"
  );
  const currentHostFingerprint = createHash("sha256")
    .update(`${os.hostname()}|${os.platform()}|${os.release()}|${os.arch()}`)
    .digest("hex");
  if (
    profileManifest.value.schemaVersion !== 1
    || profileManifest.value.profileId !== env.E2E_PERFORMANCE_PROFILE_ID
    || !profileManifest.value.expectedBrowserVersion
    || profileManifest.value.browserChannel !== (env.E2E_BROWSER_CHANNEL || "chrome")
    || profileManifest.value.hostFingerprint !== currentHostFingerprint
    || !profileManifest.value.networkProfile
    || profileManifest.value.cachePolicy !== "new-context-cold-cache-service-workers-blocked"
    || profileManifest.value.viewport?.width !== 1440
    || profileManifest.value.viewport?.height !== 900
  ) throw new Error("Performance environment profile manifest is incomplete, incompatible, or belongs to another host.");
  env.E2E_EXPECTED_BROWSER_VERSION = profileManifest.value.expectedBrowserVersion;
  env.E2E_NETWORK_PROFILE = profileManifest.value.networkProfile;
  env.E2E_PERFORMANCE_PROFILE_MANIFEST_SHA256 = profileManifest.sha256;
  datasetManifest = readBoundJson(
    env.E2E_PERFORMANCE_DATASET_MANIFEST_PATH,
    env.E2E_PERFORMANCE_DATASET_MANIFEST_SHA256,
    "Performance dataset manifest"
  );
  const dataset = datasetManifest.value.snapshot ?? datasetManifest.value.evidence ?? datasetManifest.value;
  if (dataset.expected_project_ref !== STAGING_PROJECT_REF && dataset.target?.projectRef !== STAGING_PROJECT_REF) {
    throw new Error("Performance dataset manifest is not for staging.");
  }
  if (!Number.isInteger(dataset.app_state?.version) || !dataset.app_state?.md5) {
    throw new Error("Performance dataset manifest lacks the compatibility app_state identity.");
  }
  if (
    datasetManifest.value.schemaVersion !== 1
    || !datasetManifest.value.snapshotArtifact?.sha256
    || !datasetManifest.value.scaleSource?.restoreManifest?.sha256
    || !datasetManifest.value.scaleSource?.restoreDrill?.sha256
    || datasetManifest.value.scaleSource?.restoreDrill?.targetProjectRef === "rrdwbxvuwrbxefarxnse"
    || !datasetManifest.value.scaleSource?.productionBaseline?.sha256
    || !dataset.public_counts
    || !dataset.public_fingerprints
  ) throw new Error("Performance dataset manifest lacks immutable snapshot or production-scale restore lineage.");
  const allowedDatasetTables = [
    "audit_logs", "bill_lines", "bills", "combos", "customer_tab_items", "customer_tabs", "customers",
    "inventory_items", "operational_events", "payments", "session_items", "session_pause_logs", "sessions",
    "stations", "stock_movements"
  ];
  if (
    JSON.stringify(Object.keys(dataset.public_counts).sort()) !== JSON.stringify(allowedDatasetTables)
    || Object.values(dataset.public_counts).some((value) => !Number.isInteger(value) || value < 0)
  ) throw new Error("Performance dataset contains an unsafe table set or invalid row count.");
  const allowedFingerprintTables = ["audit_logs", "bill_lines", "bills", "customer_tabs", "customers", "operational_events", "payments", "sessions", "stock_movements"];
  if (
    JSON.stringify(Object.keys(dataset.public_fingerprints).sort()) !== JSON.stringify(allowedFingerprintTables)
    || Object.values(dataset.public_fingerprints).some((value) => !/^[0-9a-f]{32}$/.test(value))
  ) throw new Error("Performance dataset contains an invalid content-fingerprint set.");
  env.E2E_EXPECTED_DATASET_IDENTITY = JSON.stringify({
    organization_id: "org-primary",
    app_state: dataset.app_state,
    public_counts: dataset.public_counts,
    public_fingerprints: dataset.public_fingerprints
  });
  if (dataset.open_sessions !== 0 || dataset.open_customer_tabs !== 0 || dataset.processing_financial_mutations !== 0 || dataset.processing_operational_mutations !== 0) {
    throw new Error("Performance dataset does not have a clean staging operational floor.");
  }
  env.E2E_EXPECTED_APP_STATE_VERSION = String(dataset.app_state.version);
  if (mode === "candidate") {
    databaseManifest = readBoundJson(
      env.E2E_DB_MANIFEST_PATH,
      env.E2E_DB_MANIFEST_SHA256,
      "Candidate database install manifest"
    );
    if (databaseManifest.value.target?.projectRef !== STAGING_PROJECT_REF) {
      throw new Error("Candidate database install manifest is not for staging.");
    }
    postflightVerification = readBoundJson(
      env.E2E_DB_POSTFLIGHT_VERIFICATION_PATH,
      env.E2E_DB_POSTFLIGHT_VERIFICATION_SHA256,
      "Candidate database postflight verification"
    );
    if (
      postflightVerification.value.projectRef !== STAGING_PROJECT_REF
      || postflightVerification.value.runId !== databaseManifest.value.runId
      || postflightVerification.value.manifestSha256 !== databaseManifest.sha256
      || postflightVerification.value.appStateUnchanged !== true
      || postflightVerification.value.incompleteMutations !== 0
    ) {
      throw new Error("Candidate database postflight verification is not an unchanged staging installation.");
    }
    if (JSON.stringify(postflightVerification.value.appState) !== JSON.stringify(dataset.app_state)) {
      throw new Error("Candidate postflight and performance dataset app_state identities differ.");
    }
    baselineManifest = readBoundJson(
      env.E2E_PERFORMANCE_BASELINE_MANIFEST_PATH,
      env.E2E_PERFORMANCE_BASELINE_MANIFEST_SHA256,
      "Performance baseline evidence manifest"
    );
  }
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
  deployedArtifact = {
    bundle: bundleUrl.pathname,
    sha256: createHash("sha256").update(bundle).digest("hex"),
    minifiedBytes: Buffer.byteLength(bundle),
    gzipBytes: gzipSync(Buffer.from(bundle)).byteLength
  };
  const expectedBundleSha = mode === "baseline" ? env.E2E_EXPECTED_BASELINE_BUNDLE_SHA256 : env.E2E_EXPECTED_BUNDLE_SHA256;
  if (!/^[a-f0-9]{64}$/i.test(expectedBundleSha || "") || deployedArtifact.sha256 !== expectedBundleSha.toLowerCase()) {
    throw new Error(`${mode} performance target does not match the approved bundle SHA-256.`);
  }
  if (mode === "candidate") {
    if (!env.E2E_PERFORMANCE_BASELINE_PATH || !/^[a-f0-9]{64}$/i.test(env.E2E_PERFORMANCE_BASELINE_SHA256 || "")) {
      throw new Error("Candidate performance run requires the immutable baseline artifact and SHA-256.");
    }
    const baselineAbsolutePath = path.resolve(root, env.E2E_PERFORMANCE_BASELINE_PATH);
    const baselineEntry = baselineManifest.value.files?.find((entry) =>
      path.resolve(root, entry.path) === baselineAbsolutePath
    );
    if (
      baselineManifest.value.mode !== "baseline"
      || baselineManifest.value.exitCode !== 0
      || baselineManifest.value.deployedArtifact?.sha256 !== env.E2E_EXPECTED_BASELINE_BUNDLE_SHA256?.toLowerCase()
      || baselineManifest.value.profileManifest?.sha256 !== profileManifest.sha256
      || baselineManifest.value.datasetManifest?.sha256 !== datasetManifest.sha256
      || baselineEntry?.sha256 !== env.E2E_PERFORMANCE_BASELINE_SHA256.toLowerCase()
    ) throw new Error("Candidate baseline artifact is not transitively bound to its deployment, dataset, and environment profile.");
  }
  env.E2E_DEPLOYED_BUNDLE_SHA256 = deployedArtifact.sha256;
}

console.log(JSON.stringify({
  runner: "operational-performance-staging-playwright",
  baseUrl: env.E2E_BASE_URL,
  runId: env.E2E_RUN_ID,
  mode: env.E2E_PERFORMANCE_MODE,
  sampleCount: 30,
  profileId: env.E2E_PERFORMANCE_PROFILE_ID,
  profileManifest: profileManifest ? { path: path.relative(root, profileManifest.absolutePath), sha256: profileManifest.sha256 } : undefined,
  discoveryOnly,
  deployedArtifact,
  datasetManifest: datasetManifest ? { path: path.relative(root, datasetManifest.absolutePath), sha256: datasetManifest.sha256 } : undefined,
  postflightVerification: postflightVerification ? { path: path.relative(root, postflightVerification.absolutePath), sha256: postflightVerification.sha256 } : undefined,
  databaseManifest: databaseManifest ? { path: path.relative(root, databaseManifest.absolutePath), sha256: databaseManifest.sha256 } : undefined,
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
    profileId: env.E2E_PERFORMANCE_PROFILE_ID,
    profileManifest: { path: path.relative(root, profileManifest.absolutePath), sha256: profileManifest.sha256 },
    datasetManifest: { path: path.relative(root, datasetManifest.absolutePath), sha256: datasetManifest.sha256 },
    postflightVerification: postflightVerification ? { path: path.relative(root, postflightVerification.absolutePath), sha256: postflightVerification.sha256 } : undefined,
    databaseManifest: databaseManifest ? { path: path.relative(root, databaseManifest.absolutePath), sha256: databaseManifest.sha256 } : undefined,
    baseline: mode === "candidate" ? {
      path: env.E2E_PERFORMANCE_BASELINE_PATH,
      sha256: env.E2E_PERFORMANCE_BASELINE_SHA256
    } : undefined,
    files
  }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}

process.exit(result.status ?? 1);
