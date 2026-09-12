import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function argument(name) {
  const marker = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
  if (!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return value;
}
function readBound(name, label) {
  const filePath = path.resolve(root, argument(name));
  const expectedSha = argument(`${name}-sha256`).toLowerCase();
  const bytes = fs.readFileSync(filePath);
  const actualSha = sha256(bytes);
  if (actualSha !== expectedSha) throw new Error(`${label} SHA-256 does not match.`);
  return { path: filePath, sha256: actualSha, value: JSON.parse(bytes.toString("utf8")) };
}
const unwrap = (value) => value.evidence ?? value?.[0]?.evidence ?? value;
const runId = argument("run-id");
if (!/^normops-\d{8}-\d{4}-dataset-[a-z0-9-]+$/i.test(runId)) throw new Error("Use --run-id=normops-YYYYMMDD-HHMM-dataset-<suffix>.");
const snapshotFile = readBound("snapshot", "Staging dataset snapshot");
const restoreFile = readBound("restore-manifest", "Production-scale restore manifest");
const restoreDrillFile = readBound("restore-drill", "Production-scale disposable restore drill");
const productionFile = readBound("production-baseline", "Production scale baseline");
const snapshot = unwrap(snapshotFile.value);
const production = productionFile.value;
const restoreDrill = restoreDrillFile.value;
if (
  snapshot.schema_version !== 1
  || snapshot.expected_project_ref !== "tkbdyzxwwbhkpztgjjxh"
  || snapshot.organization_id !== "org-primary"
  || snapshot.transaction_read_only !== true
  || !Number.isInteger(snapshot.app_state?.version)
  || !Number.isInteger(snapshot.app_state?.bytes)
  || snapshot.app_state.bytes <= 0
  || !/^[0-9a-f]{32}$/.test(snapshot.app_state?.md5 ?? "")
  || snapshot.open_sessions !== 0
  || snapshot.open_customer_tabs !== 0
  || snapshot.processing_financial_mutations !== 0
  || snapshot.processing_operational_mutations !== 0
) throw new Error("Staging dataset snapshot is not a clean, read-only, identity-bound state.");
const expectedFingerprintTables = ["audit_logs", "bill_lines", "bills", "customer_tabs", "customers", "operational_events", "payments", "sessions", "stock_movements"];
if (
  JSON.stringify(Object.keys(snapshot.public_fingerprints ?? {}).sort()) !== JSON.stringify(expectedFingerprintTables)
  || Object.values(snapshot.public_fingerprints ?? {}).some((value) => !/^[0-9a-f]{32}$/.test(value))
) throw new Error("Staging dataset snapshot content fingerprints are incomplete.");
const expectedRestoreFiles = ["public-auth-storage-data.sql", "public-schema.sql", "roles.sql"];
if (
  restoreFile.value.schemaVersion !== 1
  || restoreFile.value.projectRef !== "rrdwbxvuwrbxefarxnse"
  || restoreFile.value.baselineEvidence?.sha256 !== productionFile.sha256
  || restoreFile.value.validation?.allFilesPresent !== true
  || restoreFile.value.validation?.allFilesNonEmpty !== true
  || restoreFile.value.validation?.hashesRecorded !== true
  || !Array.isArray(restoreFile.value.files)
  || JSON.stringify(restoreFile.value.files.map((entry) => entry.name).sort()) !== JSON.stringify(expectedRestoreFiles)
) {
  throw new Error("Restore manifest is not a production backup.");
}
for (const entry of restoreFile.value.files) {
  const filePath = path.join(path.dirname(restoreFile.path), entry.name);
  const bytes = fs.readFileSync(filePath);
  if (!Number.isInteger(entry.bytes) || entry.bytes <= 0 || bytes.length !== entry.bytes || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "") || sha256(bytes) !== entry.sha256) {
    throw new Error(`Restore artifact ${entry.name} failed integrity validation.`);
  }
}
if (production.status !== "passed" || production.projectRef !== "rrdwbxvuwrbxefarxnse" || production.databaseBaseline?.transactionReadOnly !== true) {
  throw new Error("Production scale baseline is not accepted read-only evidence.");
}
if (
  !Number.isInteger(production.databaseBaseline.appState?.bytes)
  || production.databaseBaseline.appState.bytes <= 0
  || production.databaseBaseline.appState?.dataSelected !== false
) throw new Error("Production scale baseline lacks a safe compatibility-document identity.");
const productionCounts = production.databaseBaseline.publicCounts ?? {};
const requiredScaleCounts = ["sessions", "customer_tabs", "bills", "bill_lines", "payments", "customers", "audit_logs", "operational_events", "stock_movements"];
const requiredDrillChecks = ["targetGuardPassed", "backupHashesPassed", "managedRolesPassed", "publicCountsPassed", "financialTotalsPassed", "managedSchemaCountsPassed", "timestampsPassed", "appStateIdentityPassed", "appStateBytesNonZero", "emptyFloorPassed"];
if (
  restoreDrill.schemaVersion !== 1
  || restoreDrill.status !== "passed"
  || restoreDrill.sourceProjectRef !== "rrdwbxvuwrbxefarxnse"
  || restoreDrill.targetProjectRef === restoreDrill.sourceProjectRef
  || restoreDrill.sourceManifest?.sha256 !== restoreFile.sha256
  || restoreDrill.sourceManifest?.baselineSha256 !== productionFile.sha256
  || requiredDrillChecks.some((name) => restoreDrill.checks?.[name] !== true)
  || restoreDrill.restoredBaseline?.app_state?.version !== production.databaseBaseline.appState.version
  || restoreDrill.restoredBaseline?.app_state?.data_hash !== production.databaseBaseline.appState.dataHashSha256
  || restoreDrill.restoredBaseline?.app_state?.data_selected !== false
) throw new Error("Disposable production-backup restore drill is missing, failed, or not bound to the selected source evidence.");
for (const table of requiredScaleCounts) {
  if (Number(restoreDrill.restoredBaseline?.public_counts?.[table]) !== Number(productionCounts[table])) {
    throw new Error(`Disposable restore drill count differs from the production baseline for ${table}.`);
  }
}
for (const table of requiredScaleCounts) {
  if (!Number.isInteger(snapshot.public_counts?.[table]) || snapshot.public_counts[table] < Number(productionCounts[table] ?? Number.POSITIVE_INFINITY)) {
    throw new Error(`Staging dataset is below the production logical scale for ${table}.`);
  }
}
if (Number(snapshot.app_state.bytes) < Number(production.databaseBaseline.appState?.bytes)) {
  throw new Error("Staging compatibility document is below the production logical size.");
}
const sourcePath = path.join(root, "supabase", "operational-performance-dataset-readonly.sql");
const source = fs.readFileSync(sourcePath);
const manifest = {
  schemaVersion: 1,
  runId,
  target: { environment: "staging", projectRef: "tkbdyzxwwbhkpztgjjxh", organizationId: "org-primary" },
  snapshot,
  snapshotArtifact: { path: path.relative(root, snapshotFile.path), sha256: snapshotFile.sha256 },
  scaleSource: {
    restoreManifest: { path: path.relative(root, restoreFile.path), sha256: restoreFile.sha256 },
    restoreDrill: { path: path.relative(root, restoreDrillFile.path), sha256: restoreDrillFile.sha256, targetProjectRef: restoreDrill.targetProjectRef },
    productionBaseline: { path: path.relative(root, productionFile.path), sha256: productionFile.sha256 }
  },
  source: { path: path.relative(root, sourcePath), sha256: sha256(source) },
  verifiedRestoreFiles: restoreFile.value.files.map((entry) => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 })),
  createdAt: new Date().toISOString()
};
const outputDirectory = path.join(root, "test-artifacts", "operational-performance-dataset", runId);
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, "dataset-manifest.json");
fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ outputPath, sha256: sha256(fs.readFileSync(outputPath)), manifest }, null, 2) + "\n");
