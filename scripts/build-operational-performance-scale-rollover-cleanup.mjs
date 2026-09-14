import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildRolloverCleanupPackage,
  parseJsonBytes,
  sameCanonical,
  scaleIdentityFromSnapshot,
  sha256,
  stableScaleIdentity,
  unwrapEvidence,
  validatePreflight,
  validateRunId
} from "./operational-performance-scale-fixture-lib.mjs";

const root = process.cwd();
const safeDirectory = root.replaceAll("\\", "/");
const worktreeStatus = execFileSync("git", ["-c", `safe.directory=${safeDirectory}`, "status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).trim();
if (worktreeStatus) throw new Error("Rollover cleanup packages must be generated from a clean committed worktree.");

function argument(name) {
  const marker = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
  if (!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return value;
}

function readBound(name, label) {
  const absolutePath = path.resolve(root, argument(name));
  const expected = argument(`${name}-sha256`).toLowerCase();
  const bytes = fs.readFileSync(absolutePath);
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${label} SHA-256 does not match.`);
  return { absolutePath, relativePath: path.relative(root, absolutePath), sha256: actual, value: parseJsonBytes(bytes) };
}

function verifyReference(entry, label) {
  if (!entry?.path || !/^[0-9a-f]{64}$/i.test(entry.sha256 ?? "")) throw new Error(`${label} reference is invalid.`);
  const bytes = fs.readFileSync(path.resolve(root, entry.path));
  if (sha256(bytes) !== entry.sha256.toLowerCase()) throw new Error(`${label} SHA-256 does not match.`);
}

const runId = validateRunId(argument("run-id"));
if (!runId.includes("-scale-rollover-cleanup-")) throw new Error("Rollover cleanup run ID must contain -scale-rollover-cleanup-.");
const fixtureManifestFile = readBound("fixture-manifest", "Applied fixture manifest");
const applyVerificationFile = readBound("apply-verification", "Applied fixture verification");
const postApplySnapshotFile = readBound("postapply-snapshot", "Applied fixture snapshot");
const currentSnapshotFile = readBound("current-snapshot", "Current rollover snapshot");
const fixtureManifest = fixtureManifestFile.value;
const applyVerification = applyVerificationFile.value;
const appliedSnapshot = unwrapEvidence(postApplySnapshotFile.value);
const currentSnapshot = unwrapEvidence(currentSnapshotFile.value);

if (
  fixtureManifest.operation !== "staging-operational-performance-scale-fixture"
  || fixtureManifest.target?.projectRef !== "tkbdyzxwwbhkpztgjjxh"
  || fixtureManifest.productionAllowed !== false
  || fixtureManifest.automaticRetryAllowed !== false
  || applyVerification.status !== "passed"
  || applyVerification.mode !== "apply"
  || applyVerification.runId !== fixtureManifest.runId
  || applyVerification.manifest?.sha256 !== fixtureManifestFile.sha256
  || applyVerification.snapshot?.sha256 !== postApplySnapshotFile.sha256
  || applyVerification.scaleApplied !== true
  || applyVerification.productionWritePerformed !== false
) throw new Error("Applied fixture lineage is not an accepted staging package.");
verifyReference(fixtureManifest.artifacts?.["cleanup.sql"], "Original cleanup SQL");
verifyReference(applyVerification.result, "Original apply result");

const preflightPath = path.resolve(root, fixtureManifest.bindingInput?.preflight?.path ?? "");
const preflightBytes = fs.readFileSync(preflightPath);
if (sha256(preflightBytes) !== fixtureManifest.bindingInput?.preflight?.sha256) throw new Error("Original preflight SHA-256 does not match the fixture manifest.");
const originalSnapshot = validatePreflight(unwrapEvidence(parseJsonBytes(preflightBytes)));
if (!sameCanonical(scaleIdentityFromSnapshot(appliedSnapshot).public_counts, fixtureManifest.plan?.targetCounts)) {
  throw new Error("Applied snapshot physical counts do not match the fixture manifest.");
}
if (!sameCanonical(appliedSnapshot.shape_counts, fixtureManifest.plan?.shape?.targetCounts)) {
  throw new Error("Applied snapshot workload shape does not match the fixture manifest.");
}
if (
  currentSnapshot.expected_project_ref !== "tkbdyzxwwbhkpztgjjxh"
  || currentSnapshot.identity_nonce !== fixtureManifest.target.identityNonce
  || currentSnapshot.organization_id !== "org-primary"
  || currentSnapshot.transaction_read_only !== true
  || currentSnapshot.scale_fixture_absent !== false
  || currentSnapshot.scale_fixture_key_absent !== false
  || currentSnapshot.scale_fixture_rpc_absent !== false
  || ["open_sessions", "open_customer_tabs", "recoverable_hopped_sessions", "processing_financial_mutations", "processing_operational_mutations"].some((field) => currentSnapshot[field] !== 0)
) throw new Error("Current rollover snapshot is not a clean, active staging fixture.");
if (!sameCanonical(stableScaleIdentity(scaleIdentityFromSnapshot(currentSnapshot)), stableScaleIdentity(scaleIdentityFromSnapshot(appliedSnapshot)))) {
  throw new Error("Current fixture differs from the applied fixture outside clock-derived shape counters.");
}

const generated = buildRolloverCleanupPackage({ rolloverRunId: runId, fixtureManifest, originalSnapshot, appliedSnapshot, currentSnapshot });
const sourcePaths = [
  "package.json",
  "scripts/build-operational-performance-scale-rollover-cleanup.mjs",
  "scripts/operational-performance-scale-fixture-lib.mjs",
  "scripts/verify-operational-performance-scale-rollover-cleanup.mjs",
  "scripts/operational-performance-scale-fixture-lib.test.mjs",
  "src/qa/operationalLifecycleV2PlaywrightContract.test.ts"
];
const sourceBindings = Object.fromEntries(sourcePaths.map((relativePath) => {
  const bytes = fs.readFileSync(path.join(root, relativePath));
  return [relativePath, { path: relativePath, bytes: bytes.length, sha256: sha256(bytes) }];
}));
const sourceCommit = execFileSync("git", ["-c", `safe.directory=${safeDirectory}`, "rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("Unable to bind rollover cleanup to a committed source revision.");

const outputDirectory = path.join(root, "test-artifacts", "operational-performance-scale-rollover", runId);
fs.mkdirSync(outputDirectory, { recursive: true });
const artifacts = {};
for (const [name, contents] of Object.entries({ "cleanup.sql": generated.cleanup, "rollback-only-proof.sql": generated.proof })) {
  const outputPath = path.join(outputDirectory, name);
  fs.writeFileSync(outputPath, contents, { encoding: "utf8", flag: "wx" });
  artifacts[name] = { path: path.relative(root, outputPath), bytes: fs.statSync(outputPath).size, sha256: sha256(fs.readFileSync(outputPath)) };
}
const manifest = {
  schemaVersion: 1,
  operation: "staging-operational-performance-scale-rollover-cleanup",
  runId,
  target: fixtureManifest.target,
  sourceCommit,
  fixture: {
    runId: fixtureManifest.runId,
    packageBindingSha256: fixtureManifest.packageBindingSha256,
    manifest: { path: fixtureManifestFile.relativePath, sha256: fixtureManifestFile.sha256 },
    applyVerification: { path: applyVerificationFile.relativePath, sha256: applyVerificationFile.sha256 },
    postApplySnapshot: { path: postApplySnapshotFile.relativePath, sha256: postApplySnapshotFile.sha256 },
    originalCleanup: fixtureManifest.artifacts["cleanup.sql"]
  },
  currentSnapshot: { path: currentSnapshotFile.relativePath, sha256: currentSnapshotFile.sha256 },
  originalPreflight: { path: path.relative(root, preflightPath), sha256: fixtureManifest.bindingInput.preflight.sha256 },
  temporalShapeBefore: generated.temporalShapeBefore,
  temporalShapeNow: generated.temporalShapeNow,
  invariantPolicy: {
    ignoredOnlyForRolloverComparison: ["current_business_day_bills", "current_business_day_payments", "recent_stock_movements"],
    exactStoredIdentityRequired: true,
    exactFixtureIdsAndCountsRequired: true,
    strictApplyAndDatasetShapeGatesUnchanged: true
  },
  sourceBindings,
  artifacts,
  createdAt: new Date().toISOString(),
  productionAllowed: false,
  automaticRetryAllowed: false
};
const manifestPath = path.join(outputDirectory, "manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ outputDirectory, manifestPath, manifestSha256: sha256(fs.readFileSync(manifestPath)), manifest }, null, 2) + "\n");
