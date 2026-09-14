import fs from "node:fs";
import path from "node:path";
import {
  assertRolloverStableIdentity,
  parseJsonBytes,
  sameCanonical,
  scaleIdentityFromSnapshot,
  sha256,
  stableScaleIdentity,
  unwrapEvidence
} from "./operational-performance-scale-fixture-lib.mjs";

const root = process.cwd();
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
  return { absolutePath, path: path.relative(root, absolutePath), sha256: actual, value: parseJsonBytes(bytes) };
}
function readReference(entry, label) {
  if (!entry?.path || !/^[0-9a-f]{64}$/i.test(entry.sha256 ?? "")) throw new Error(`${label} reference is invalid.`);
  const absolutePath = path.resolve(root, entry.path);
  const bytes = fs.readFileSync(absolutePath);
  if (sha256(bytes) !== entry.sha256.toLowerCase()) throw new Error(`${label} SHA-256 does not match.`);
  return { absolutePath, bytes, value: entry.path.endsWith(".json") ? parseJsonBytes(bytes) : null };
}

const mode = argument("mode");
if (!["proof", "cleanup"].includes(mode)) throw new Error("Mode must be proof or cleanup.");
const manifestFile = readBound("manifest", "Rollover cleanup manifest");
const resultFile = readBound("result", "Rollover cleanup SQL result");
const snapshotFile = readBound("snapshot", "Rollover cleanup read-only snapshot");
const manifest = manifestFile.value;
const result = unwrapEvidence(resultFile.value);
const snapshot = unwrapEvidence(snapshotFile.value);

if (
  manifest.schemaVersion !== 1
  || manifest.operation !== "staging-operational-performance-scale-rollover-cleanup"
  || manifest.target?.projectRef !== "tkbdyzxwwbhkpztgjjxh"
  || manifest.productionAllowed !== false
  || manifest.automaticRetryAllowed !== false
  || manifest.invariantPolicy?.exactStoredIdentityRequired !== true
  || manifest.invariantPolicy?.exactFixtureIdsAndCountsRequired !== true
  || manifest.invariantPolicy?.strictApplyAndDatasetShapeGatesUnchanged !== true
  || !sameCanonical(manifest.invariantPolicy?.ignoredOnlyForRolloverComparison, ["current_business_day_bills", "current_business_day_payments", "recent_stock_movements"])
) throw new Error("Manifest is not an approved staging-only rollover cleanup package.");
for (const [name, entry] of Object.entries(manifest.sourceBindings ?? {})) readReference(entry, `Source binding ${name}`);
const artifactName = mode === "proof" ? "rollback-only-proof.sql" : "cleanup.sql";
readReference(manifest.artifacts?.[artifactName], `Selected ${mode} SQL artifact`);
const fixtureManifestReference = readReference(manifest.fixture?.manifest, "Applied fixture manifest");
const applyVerificationReference = readReference(manifest.fixture?.applyVerification, "Applied fixture verification");
readReference(manifest.fixture?.postApplySnapshot, "Applied fixture snapshot");
readReference(manifest.fixture?.originalCleanup, "Original cleanup SQL");
const originalPreflightFile = readReference(manifest.originalPreflight, "Original fixture preflight");
const currentSnapshotReference = readReference(manifest.currentSnapshot, "Rollover input snapshot");
const originalSnapshot = unwrapEvidence(originalPreflightFile.value);
const rolloverInput = unwrapEvidence(currentSnapshotReference.value);
const fixtureManifest = fixtureManifestReference.value;
const applyVerification = applyVerificationReference.value;
if (
  fixtureManifest?.runId !== manifest.fixture.runId
  || fixtureManifest?.packageBindingSha256 !== manifest.fixture.packageBindingSha256
  || fixtureManifest?.productionAllowed !== false
  || fixtureManifest?.automaticRetryAllowed !== false
  || applyVerification?.status !== "passed"
  || applyVerification?.mode !== "apply"
  || applyVerification?.runId !== manifest.fixture.runId
  || applyVerification?.manifest?.sha256 !== manifest.fixture.manifest.sha256
  || applyVerification?.snapshot?.sha256 !== manifest.fixture.postApplySnapshot.sha256
) throw new Error("Referenced applied-fixture lineage does not match the rollover manifest.");

if (
  result.status !== "passed"
  || result.operation !== manifest.operation
  || result.rollover_run_id !== manifest.runId
  || result.fixture_run_id !== manifest.fixture.runId
  || result.fixture_package_binding_sha256 !== manifest.fixture.packageBindingSha256
  || result.production_write_allowed !== false
) throw new Error("SQL result does not match the immutable rollover cleanup package.");
if (
  snapshot.expected_project_ref !== "tkbdyzxwwbhkpztgjjxh"
  || snapshot.identity_nonce !== manifest.target.identityNonce
  || snapshot.organization_id !== "org-primary"
  || snapshot.transaction_read_only !== true
  || ["open_sessions", "open_customer_tabs", "recoverable_hopped_sessions", "processing_financial_mutations", "processing_operational_mutations"].some((field) => snapshot[field] !== 0)
) throw new Error("Read-only snapshot is not a clean approved staging environment.");

const snapshotIdentity = scaleIdentityFromSnapshot(snapshot);
const originalIdentity = scaleIdentityFromSnapshot(originalSnapshot);
const rolloverInputIdentity = scaleIdentityFromSnapshot(rolloverInput);
stableScaleIdentity(snapshotIdentity);
stableScaleIdentity(result.identity);
if (mode === "proof") {
  if (result.rollback_only !== true || result.cleanup_complete !== false) throw new Error("Proof result is not rollback-only.");
  if (snapshot.scale_fixture_absent !== false || snapshot.scale_fixture_key_absent !== false || snapshot.scale_fixture_rpc_absent !== false) {
    throw new Error("Rollback proof did not preserve the applied fixture.");
  }
  assertRolloverStableIdentity(snapshotIdentity, rolloverInputIdentity, "Rollback proof post-state");
  assertRolloverStableIdentity(result.identity, originalIdentity, "Rollback proof cleanup result");
} else {
  if (result.cleanup_complete !== true || result.rollback_only !== false) throw new Error("Cleanup result is not committed cleanup evidence.");
  if (snapshot.scale_fixture_absent !== true || snapshot.scale_fixture_key_absent !== true || snapshot.scale_fixture_rpc_absent !== true) {
    throw new Error("Committed cleanup left fixture state behind.");
  }
  assertRolloverStableIdentity(snapshotIdentity, originalIdentity, "Committed cleanup post-state");
  assertRolloverStableIdentity(result.identity, originalIdentity, "Committed cleanup SQL result");
  if (!sameCanonical(result.identity, snapshotIdentity)) throw new Error("Committed cleanup result and read-only post-state differ.");
}

const verification = {
  schemaVersion: 1,
  status: "passed",
  mode,
  runId: manifest.runId,
  fixtureRunId: manifest.fixture.runId,
  projectRef: manifest.target.projectRef,
  manifest: { path: manifestFile.path, sha256: manifestFile.sha256 },
  result: { path: resultFile.path, sha256: resultFile.sha256 },
  snapshot: { path: snapshotFile.path, sha256: snapshotFile.sha256 },
  exactStoredIdentityRestored: true,
  temporalShapeComparison: "observed-not-frozen",
  originalTemporalShape: manifest.temporalShapeBefore,
  rolloverInputTemporalShape: manifest.temporalShapeNow,
  observedTemporalShape: snapshot.shape_counts,
  scaleApplied: mode === "proof",
  productionWritePerformed: false,
  verifiedAt: new Date().toISOString()
};
const outputPath = path.join(path.dirname(manifestFile.absolutePath), `verification-${mode}.json`);
fs.writeFileSync(outputPath, JSON.stringify(verification, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ outputPath, sha256: sha256(fs.readFileSync(outputPath)), verification }, null, 2) + "\n");
