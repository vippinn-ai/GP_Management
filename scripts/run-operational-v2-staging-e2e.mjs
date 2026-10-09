import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { loadLifecycleDatabaseLineage } from "./lifecycle-database-lineage.mjs";
import { executeActorGatedSuite, loadLifecycleRoleEnvironment, runLifecycleActorPreflight } from './lifecycle-actor-preflight.mjs';
const require = createRequire(import.meta.url);
import { parseLifecycleArguments, assertStagingBundleUrl, assertLifecycleSqlBinding, lifecycleSourceIdentity,
  assertCleanCandidate, expectedLifecycleTests, assertCompleteLifecycleSummary, lifecycleRuntimeIdentity,
  lifecycleSuiteContract, lifecycleSelectionArguments, assertLifecycleSuiteDiscovery } from "./lifecycle-runner-guards.mjs";
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
const { discoveryOnly, args: playwrightArgs, mode } = parseLifecycleArguments(args);
const suiteContract = lifecycleSuiteContract(mode);
const selectionArgs = lifecycleSelectionArguments(mode);
if (args[0] === "--help") {
  console.log("Usage: node scripts/run-operational-v2-staging-e2e.mjs [--list | --help | --inventory-contract [--list]]\nNo arguments runs the complete 31-case gate. Inventory contract is a fixed two-case supplemental run, never release acceptance. Arbitrary selectors/overrides remain forbidden.");
  process.exit(0);
}
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
let env = { ...localEnv, ...process.env };
env.E2E_LIFECYCLE_MODE = mode;

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
if (!discoveryOnly && !env.E2E_RUN_ID) throw new Error("Live lifecycle testing requires an explicit unique E2E_RUN_ID.");
env.E2E_RUN_ID = assertOperationalRunId(env.E2E_RUN_ID || `normops-${generatedRunStamp.slice(0, 8)}-${generatedRunStamp.slice(8)}-discovery`);
env.E2E_ROLE_MATRIX = "release-b-receptionist-manager";
env.E2E_ROLE_MATRIX_PHASE = "all";
if (!discoveryOnly) assertLiveCredentials(env);
if (!discoveryOnly) env = loadLifecycleRoleEnvironment(env, parseEnvFile(path.join(root, '.env.e2e.roles.local')));

const evidenceRoot = path.join(root, "test-artifacts", "playwright");
const outputDir = path.join(evidenceRoot, `operational-v2-run-${env.E2E_RUN_ID}`);
const summaryPath = path.join(evidenceRoot, `summary-${env.E2E_RUN_ID}.json`);
const evidenceManifestPath = path.join(evidenceRoot, `evidence-manifest-${env.E2E_RUN_ID}.json`);
const reservationPath = path.join(evidenceRoot, `run-start-${env.E2E_RUN_ID}.json`);
const actorPreflightPath = path.join(evidenceRoot, `actor-preflight-${env.E2E_RUN_ID}.json`);
const REQUIRED_NEGATIVE_CASES = [
  "actor-spoof", "anonymous-actor", "audit-collision", "billed-session-target", "billed-tab-target",
  "closed-tab-target", "compatibility-version-authority", "empty-hop-entity-type", "empty-hop-mutation-kind",
  "empty-reason", "empty-reject-session-entity-type", "empty-reject-session-mutation-kind",
  "empty-reject-tab-entity-type", "empty-reject-tab-mutation-kind", "end-before-open-pause",
  "foreign-open-pause", "future-session-time", "inactive-actor", "malformed-session-time",
  "malformed-tab-time", "missing-audit", "missing-canonical-start", "missing-entity",
  "missing-entity-type", "missing-mutation-id", "missing-mutation-kind", "missing-open-pause",
  "missing-organization", "missing-session-target", "missing-tab-target", "multiple-open-pauses",
  "missing-reject-session-entity-type", "missing-reject-session-mutation-kind",
  "missing-reject-tab-entity-type", "missing-reject-tab-mutation-kind",
  "nested-array", "outer-inner-mismatch", "rejected-session-target", "root-array",
  "same-id-different-audit", "same-id-different-entity", "same-id-different-intent",
  "same-id-different-kind", "session-end-before-start", "tab-before-open", "unsupported-role",
  "wrong-entity-type", "wrong-kind", "wrong-organization"
].sort();
for (const evidencePath of [outputDir, summaryPath, evidenceManifestPath, reservationPath, actorPreflightPath]) {
  if (fs.existsSync(evidencePath)) throw new Error(`Run id ${env.E2E_RUN_ID} already has evidence; choose a fresh run id.`);
}

let databaseManifest;
let databaseManifestPath;
let postflightVerification;
let postflightVerificationPath;
let transactionalProofManifest;
let transactionalProofResult;
let proofRollbackVerification;
let sourceIdentity;
let runtimeIdentity;
let aclLineage;
function revalidateAclLineage() {
  return loadLifecycleDatabaseLineage({ root,
    descriptorPath: env.E2E_ACL_LINEAGE_PATH, descriptorSha256: env.E2E_ACL_LINEAGE_SHA256,
    installManifestPath: databaseManifestPath, installManifestSha256: env.E2E_DB_MANIFEST_SHA256?.toLowerCase(),
    verificationPath: postflightVerificationPath, verificationSha256: env.E2E_DB_POSTFLIGHT_VERIFICATION_SHA256?.toLowerCase() });
}
function revalidateProofArtifacts() {
  for (const entry of [transactionalProofManifest, transactionalProofResult, proofRollbackVerification]) {
    if (createHash("sha256").update(fs.readFileSync(entry.absolutePath)).digest("hex") !== entry.sha256) throw new Error("Transactional proof evidence changed before or during testing.");
  }
}
if (!discoveryOnly) {
  assertCleanCandidate(root, env.E2E_EXPECTED_COMMIT);
  sourceIdentity = lifecycleSourceIdentity(root);
  if (sourceIdentity.sha256 !== env.E2E_EXPECTED_SOURCE_SHA256) throw new Error("Candidate source/harness identity differs from the approved identity.");
  runtimeIdentity = lifecycleRuntimeIdentity(env);
  if (runtimeIdentity.sha256 !== env.E2E_EXPECTED_RUNTIME_SHA256) throw new Error("Runtime fixture inputs differ from the approved identity.");
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
  assertLifecycleSqlBinding(root, databaseManifest);
  if (!env.E2E_DB_POSTFLIGHT_VERIFICATION_PATH || !env.E2E_DB_POSTFLIGHT_VERIFICATION_SHA256) {
    throw new Error("Live staging E2E requires the immutable database postflight verification path and SHA-256.");
  }
  postflightVerificationPath = path.resolve(root, env.E2E_DB_POSTFLIGHT_VERIFICATION_PATH);
  const postflightText = fs.readFileSync(postflightVerificationPath, "utf8");
  const postflightSha = createHash("sha256").update(postflightText).digest("hex");
  if (postflightSha !== env.E2E_DB_POSTFLIGHT_VERIFICATION_SHA256.toLowerCase()) throw new Error("Database postflight verification SHA-256 does not match.");
  postflightVerification = JSON.parse(postflightText);
  aclLineage = loadLifecycleDatabaseLineage({ root,
    descriptorPath: env.E2E_ACL_LINEAGE_PATH, descriptorSha256: env.E2E_ACL_LINEAGE_SHA256,
    installManifestPath: databaseManifestPath, installManifestSha256: actualManifestSha,
    verificationPath: postflightVerificationPath, verificationSha256: postflightSha });
  if (
    postflightVerification.projectRef !== STAGING_PROJECT_REF
    || postflightVerification.runId !== databaseManifest.runId
    || postflightVerification.manifestSha256 !== actualManifestSha
    || postflightVerification.appStateUnchanged !== true
    || postflightVerification.incompleteMutations !== 0
  ) throw new Error("Database postflight verification is not the approved unchanged staging installation.");
  if (!env.E2E_DB_PROOF_MANIFEST_PATH || !env.E2E_DB_PROOF_MANIFEST_SHA256 || !env.E2E_DB_PROOF_RESULT_PATH || !env.E2E_DB_PROOF_RESULT_SHA256) {
    throw new Error("Live staging E2E requires immutable transactional proof manifest and result paths with SHA-256 values.");
  }
  const readBoundProof = (pathValue, shaValue, label) => {
    const absolutePath = path.resolve(root, pathValue);
    const content = fs.readFileSync(absolutePath, "utf8");
    const actualSha = createHash("sha256").update(content).digest("hex");
    if (actualSha !== shaValue.toLowerCase()) throw new Error(`${label} SHA-256 does not match.`);
    return { absolutePath, sha256: actualSha, value: JSON.parse(content) };
  };
  transactionalProofManifest = readBoundProof(env.E2E_DB_PROOF_MANIFEST_PATH, env.E2E_DB_PROOF_MANIFEST_SHA256, "Transactional proof manifest");
  transactionalProofResult = readBoundProof(env.E2E_DB_PROOF_RESULT_PATH, env.E2E_DB_PROOF_RESULT_SHA256, "Transactional proof result");
  if (!env.E2E_DB_PROOF_ROLLBACK_VERIFICATION_PATH || !env.E2E_DB_PROOF_ROLLBACK_VERIFICATION_SHA256) {
    throw new Error("Live staging E2E requires immutable transactional proof post-rollback verification.");
  }
  proofRollbackVerification = readBoundProof(
    env.E2E_DB_PROOF_ROLLBACK_VERIFICATION_PATH,
    env.E2E_DB_PROOF_ROLLBACK_VERIFICATION_SHA256,
    "Transactional proof post-rollback verification"
  );
  const proof = transactionalProofResult.value.evidence ?? transactionalProofResult.value?.[0]?.evidence ?? transactionalProofResult.value;
  const proofPerformance = proof?.performance ?? {};
  const proofComparison = proof?.performance_comparison ?? {};
  const proofNegativeCases = proof?.negative_cases ?? {};
  const performancePassed = ["hop_session_v2", "reject_session_v2", "reject_customer_tab_v2"].every((name) =>
    proofPerformance[name]?.samples === 20
      && Number(proofPerformance[name]?.p95_ms) < 500
      && Number(proofPerformance[name]?.max_ms) < 2_000
      && proofComparison[name]?.v2_at_least_50_percent_faster === true
      && proofComparison[name]?.large_small_within_budget === true
  );
  const negativeMatrixPassed = JSON.stringify(Object.keys(proofNegativeCases).sort()) === JSON.stringify(REQUIRED_NEGATIVE_CASES)
    && Object.values(proofNegativeCases).every((entry) => entry?.expected_code === entry?.observed_code);
  if (
    transactionalProofManifest.value.target?.projectRef !== STAGING_PROJECT_REF
    || transactionalProofManifest.value.installManifest?.sha256 !== actualManifestSha
    || transactionalProofManifest.value.postflightVerification?.sha256 !== postflightSha
    || transactionalProofManifest.value.aclLineage?.sha256 !== aclLineage.sha256
    || transactionalProofManifest.value.codeIdentity?.commit !== env.E2E_EXPECTED_COMMIT
    || transactionalProofManifest.value.codeIdentity?.sourceSha256 !== sourceIdentity.sha256
    || proof?.acl_lineage_sha256 !== aclLineage.sha256
    || proofRollbackVerification.value.lineage?.aclLineageSha256 !== aclLineage.sha256
    || proof?.proof !== "passed"
    || proof?.run_id !== transactionalProofManifest.value.runId
    || proof?.project_ref !== STAGING_PROJECT_REF
    || proof?.v2_app_state_unchanged !== true
    || proof?.app_state_compatibility_fields_restored !== true
    || proof?.fixture_app_state_touched !== true
    || proof?.rollback_required !== true
    || proofRollbackVerification.value.status !== "passed"
    || proofRollbackVerification.value.rollbackProven !== true
    || proofRollbackVerification.value.proofRunId !== transactionalProofManifest.value.runId
    || proofRollbackVerification.value.lineage?.proofResultSha256 !== transactionalProofResult.sha256
    || proofRollbackVerification.value.lineage?.proofManifestSha256 !== transactionalProofManifest.sha256
    || !performancePassed
    || !negativeMatrixPassed
  ) throw new Error("Transactional database proof is not bound to the approved staging installation.");
}

async function readDeployedArtifact() {
  const htmlResponse = await fetch(env.E2E_BASE_URL, { redirect: "error" });
  if (!htmlResponse.ok) throw new Error(`Unable to read staging shell (${htmlResponse.status}).`);
  const html = await htmlResponse.text();
  const scriptPath = html.match(/<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i)?.[1];
  if (!scriptPath) throw new Error("Unable to identify the deployed staging JavaScript bundle.");
  const bundleUrl = assertStagingBundleUrl(scriptPath, env.E2E_BASE_URL);
  const bundleResponse = await fetch(bundleUrl, { redirect: "error" });
  if (!bundleResponse.ok) throw new Error(`Unable to read staging bundle (${bundleResponse.status}).`);
  const bundle = await bundleResponse.text();
  if (!bundle.includes(STAGING_PROJECT_REF) || bundle.includes(PRODUCTION_PROJECT_REF)) throw new Error("Deployed bundle failed the staging project guard.");
  return { bundle: bundleUrl.pathname, sha256: createHash("sha256").update(bundle).digest("hex") };
}
let deployedArtifact;
if (!discoveryOnly) {
  deployedArtifact = await readDeployedArtifact();
  if (deployedArtifact.sha256 !== env.E2E_EXPECTED_BUNDLE_SHA256.toLowerCase()) throw new Error("Deployed staging bundle SHA-256 is not the approved candidate.");
}

console.log(JSON.stringify({
  runner: "operational-v2-staging-playwright",
  ...suiteContract,
  baseUrl: env.E2E_BASE_URL,
  runId: env.E2E_RUN_ID,
  discoveryOnly,
  aclLineage: aclLineage ? { path: aclLineage.path, sha256: aclLineage.sha256 } : undefined,
  deployedArtifact,
  databaseManifest: databaseManifest ? { path: path.relative(root, databaseManifestPath), runId: databaseManifest.runId, sha256: env.E2E_DB_MANIFEST_SHA256 } : undefined,
  postflightVerification: postflightVerification ? { path: path.relative(root, postflightVerificationPath), sha256: env.E2E_DB_POSTFLIGHT_VERIFICATION_SHA256 } : undefined,
  transactionalProof: transactionalProofManifest ? {
    manifest: { path: path.relative(root, transactionalProofManifest.absolutePath), sha256: transactionalProofManifest.sha256 },
    result: { path: path.relative(root, transactionalProofResult.absolutePath), sha256: transactionalProofResult.sha256 }
  } : undefined,
  proofRollbackVerification: proofRollbackVerification ? {
    path: path.relative(root, proofRollbackVerification.absolutePath),
    sha256: proofRollbackVerification.sha256
  } : undefined,
  credentials: discoveryOnly ? "not-required" : "loaded-from-ignored-environment",
  productionAllowed: false,
  retries: 0
}));

const cliPath = require.resolve("@playwright/test/cli");
const configPath = "playwright.operational-v2.staging.config.ts";
// JSON discovery neither executes fixtures nor writes the compact live summary.
const discoveryEnv = { ...env };
for (const key of ["PLAYWRIGHT_JSON_OUTPUT_NAME", "PLAYWRIGHT_JSON_OUTPUT_DIR", "PLAYWRIGHT_JSON_OUTPUT_FILE"]) delete discoveryEnv[key];
const discovery = spawnSync(process.execPath, [cliPath, "test", `--config=${configPath}`, ...selectionArgs, "--list", "--reporter=json"], {
  cwd: root, env: discoveryEnv, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, shell: false, windowsHide: true
});
if (discovery.error || discovery.status !== 0) throw new Error("Offline test discovery failed; live execution was not started.");
const expectedTests = expectedLifecycleTests(JSON.parse(discovery.stdout));
assertLifecycleSuiteDiscovery(expectedTests, mode);
if (discoveryOnly) {
  console.log(JSON.stringify({ ...suiteContract, discoveryOnly: true, executedTests: 0, expectedTests }, null, 2));
  process.exit(0);
}
// Reserve the identity before any test mutation, including a crash before summary.
assertCleanCandidate(root, env.E2E_EXPECTED_COMMIT);
revalidateAclLineage();
revalidateProofArtifacts();
if (lifecycleSourceIdentity(root).sha256 !== sourceIdentity.sha256) throw new Error("Candidate source changed during discovery; live execution was not started.");
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(reservationPath, JSON.stringify({
  ...suiteContract,
  runId: env.E2E_RUN_ID, candidateCommit: env.E2E_EXPECTED_COMMIT, sourceIdentity, expectedTests, playwrightArgs,
  runtimeIdentity, baseUrl: env.E2E_BASE_URL, projectRef: STAGING_PROJECT_REF, organizationId: "org-primary",
  databaseManifest: { path: databaseManifestPath, sha256: env.E2E_DB_MANIFEST_SHA256 },
  aclLineage: { path: aclLineage.path, sha256: aclLineage.sha256 },
  postflight: { path: postflightVerificationPath, sha256: env.E2E_DB_POSTFLIGHT_VERIFICATION_SHA256 },
  proofManifest: { path: transactionalProofManifest.absolutePath, sha256: transactionalProofManifest.sha256 },
  proofResult: { path: transactionalProofResult.absolutePath, sha256: transactionalProofResult.sha256 },
  proofRollback: { path: proofRollbackVerification.absolutePath, sha256: proofRollbackVerification.sha256 },
  deployedArtifact, actorPreflightPath, createdAt: new Date().toISOString()
}, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
const { receipt: actorPreflight, sha256: actorPreflightSha256, result } = await executeActorGatedSuite({ env,
  reservationPath, receiptPath: actorPreflightPath, preflight: runLifecycleActorPreflight,
  launch: () => spawnSync(process.execPath, [cliPath, "test", `--config=${configPath}`, ...selectionArgs], {
  cwd: root, env, stdio: "inherit", shell: false, windowsHide: true
}) });
let gateError;
let postRunArtifact;
try {
  if (actorPreflight.status !== 'passed') throw new Error('Authoritative actor preflight failed before acceptance tests.');
  if (result.error || result.status !== 0) throw new Error("Lifecycle Playwright process failed.");
  assertCompleteLifecycleSummary(JSON.parse(fs.readFileSync(summaryPath, "utf8")), expectedTests, env.E2E_RUN_ID);
} catch (error) { gateError = error.message; }
// Seal drift evidence even when the process or summary failed. Each check runs
// independently so a secondary failure cannot hide the primary failure.
for (const verify of [
  () => assertCleanCandidate(root, env.E2E_EXPECTED_COMMIT),
  revalidateAclLineage,
  revalidateProofArtifacts,
  () => { if (createHash('sha256').update(fs.readFileSync(actorPreflightPath)).digest('hex') !== actorPreflightSha256) throw new Error('Actor preflight receipt changed during testing.'); },
  () => { if (lifecycleSourceIdentity(root).sha256 !== sourceIdentity.sha256) throw new Error("Candidate source changed during testing."); }
]) {
  try { verify(); }
  catch (error) { gateError = [gateError, error.message].filter(Boolean).join("; "); }
}
try {
  postRunArtifact = await readDeployedArtifact();
  if (JSON.stringify(postRunArtifact) !== JSON.stringify(deployedArtifact)) throw new Error("Deployed bundle changed during lifecycle testing.");
} catch (error) { gateError = [gateError, error.message].filter(Boolean).join("; "); }

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
  visit(reservationPath);
  visit(actorPreflightPath);
  visit(summaryPath);
  fs.writeFileSync(evidenceManifestPath, JSON.stringify({
    ...suiteContract,
    runId: env.E2E_RUN_ID,
    createdAt: new Date().toISOString(),
    exitCode: gateError ? 1 : 0,
    gateError,
    candidateCommit: env.E2E_EXPECTED_COMMIT,
    sourceIdentity,
    runtimeIdentity,
    aclLineage: { path: aclLineage.path, sha256: aclLineage.sha256 },
    expectedTests,
    deployedArtifact,
    postRunArtifact,
    actorPreflight: { path: actorPreflightPath, sha256: actorPreflightSha256, status: actorPreflight.status },
    databaseManifest: { path: path.relative(root, databaseManifestPath), sha256: env.E2E_DB_MANIFEST_SHA256 },
    postflightVerification: { path: path.relative(root, postflightVerificationPath), sha256: env.E2E_DB_POSTFLIGHT_VERIFICATION_SHA256 },
    transactionalProof: {
      manifest: { path: path.relative(root, transactionalProofManifest.absolutePath), sha256: transactionalProofManifest.sha256 },
      result: { path: path.relative(root, transactionalProofResult.absolutePath), sha256: transactionalProofResult.sha256 }
    },
    proofRollbackVerification: {
      path: path.relative(root, proofRollbackVerification.absolutePath),
      sha256: proofRollbackVerification.sha256
    },
    files
  }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}
if (gateError) console.error(gateError);
process.exit(gateError ? 1 : 0);
