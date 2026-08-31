import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(projectRoot, "test-artifacts", "evidence");
const expectedProjectRef = "rrdwbxvuwrbxefarxnse";
const expectedOrganizationId = "org-primary";
const expectedDashboardTitleFragment = "breakperfect-production";
const baselineSqlRelativePath = "supabase/release-b-production-baseline-readonly.sql";
const expectedBaselineSqlSha256 = "650d67292814417f168dcc33f61c6d930d5493d3c6096f80341be940a22ef2c8";

function getArgument(name) {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function resolveEvidencePath(argument, label) {
  if (!argument) throw new Error(`${label} is required.`);
  const resolved = path.resolve(projectRoot, argument);
  const relative = path.relative(evidenceRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay under test-artifacts/evidence.`);
  }
  return resolved;
}

function sha256(raw) {
  return createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex");
}

const rawExportPath = resolveEvidencePath(getArgument("--raw-export"), "--raw-export");
const outputPath = resolveEvidencePath(getArgument("--output"), "--output");
const dashboardUrl = getArgument("--dashboard-url");
const dashboardTitle = getArgument("--dashboard-title");
if (!dashboardUrl || !dashboardTitle) {
  throw new Error("--dashboard-url and --dashboard-title are required capture identity fields.");
}

const parsedDashboardUrl = new URL(dashboardUrl);
const dashboardProjectMatch = parsedDashboardUrl.pathname.match(/^\/dashboard\/project\/([^/]+)\/sql(?:\/|$)/);
const dashboardProjectRef = dashboardProjectMatch?.[1] ?? null;
if (
  parsedDashboardUrl.protocol !== "https:" ||
  parsedDashboardUrl.hostname !== "supabase.com" ||
  dashboardProjectRef !== expectedProjectRef ||
  !dashboardTitle.toLowerCase().includes(expectedDashboardTitleFragment)
) {
  throw new Error("Dashboard capture identity does not match exact production.");
}

const baselineSqlPath = path.join(projectRoot, baselineSqlRelativePath);
const [rawExport, baselineSql] = await Promise.all([
  readFile(rawExportPath, "utf8"),
  readFile(baselineSqlPath, "utf8")
]);
const baselineSqlSha256 = sha256(baselineSql);
if (baselineSqlSha256 !== expectedBaselineSqlSha256) {
  throw new Error("Baseline SQL hash drifted; independently review and pin the new query before capture.");
}

const exportedRows = JSON.parse(rawExport);
const rawExportCanonicalSha256 = sha256(JSON.stringify(exportedRows));
if (!Array.isArray(exportedRows) || exportedRows.length !== 1) {
  throw new Error("Raw Supabase export must contain exactly one result row.");
}
const rowKeys = Object.keys(exportedRows[0] ?? {});
if (rowKeys.length !== 1 || rowKeys[0] !== "release_b_production_baseline") {
  throw new Error("Raw Supabase export does not match the baseline query result contract.");
}
const raw = exportedRows[0].release_b_production_baseline;
const capturedAtMs = Date.parse(raw?.captured_at);
const appStateVersion = Number(raw?.app_state?.version);
const appStateHash = raw?.app_state?.data_hash;
const checks = {
  schemaVersion: raw?.schema_version === 1,
  exactProductionProject: raw?.expected_project_ref === expectedProjectRef,
  exactOrganization: raw?.organization_id === expectedOrganizationId,
  readOnly: raw?.transaction_read_only === "on" && raw?.production_write_allowed === false,
  emptyFloor: raw?.open_active_sessions === 0 && raw?.open_customer_tabs === 0,
  validCapturedAt: Number.isFinite(capturedAtMs),
  validAppStateIdentity: Number.isSafeInteger(appStateVersion) && /^[0-9a-f]{64}$/.test(appStateHash ?? ""),
  appStateNotSelected: raw?.app_state?.data_selected === false,
  publicCountsPresent: raw?.public_counts && typeof raw.public_counts === "object",
  financialTotalsPresent: raw?.financial_totals && typeof raw.financial_totals === "object",
  managedSchemaCountsPresent: raw?.managed_schema_counts && typeof raw.managed_schema_counts === "object"
};
const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
if (failures.length > 0) {
  throw new Error(`Raw production baseline verification failed: ${failures.join(", ")}.`);
}

const normalized = {
  schemaVersion: 2,
  environment: "production",
  projectRef: expectedProjectRef,
  capturedAt: new Date(capturedAtMs).toISOString(),
  productionWritePerformed: false,
  provenance: {
    captureMethod: "supabase-sql-editor-copy-as-json",
    dashboardUrl,
    dashboardTitle,
    baselineSql: {
      path: baselineSqlRelativePath,
      sha256: baselineSqlSha256
    },
    rawExport: {
      path: path.relative(projectRoot, rawExportPath).replaceAll("\\", "/"),
      sha256: rawExportCanonicalSha256,
      fileSha256: sha256(rawExport)
    }
  },
  databaseDiscovery: {
    capturedAt: new Date(capturedAtMs).toISOString(),
    transactionReadOnly: true,
    openActiveSessions: raw.open_active_sessions,
    openCustomerTabs: raw.open_customer_tabs
  },
  databaseBaseline: {
    transactionReadOnly: true,
    appState: {
      version: appStateVersion,
      bytes: Number(raw.app_state.bytes),
      dataHashSha256: appStateHash,
      dataSelected: false
    },
    publicCounts: raw.public_counts,
    financialTotals: raw.financial_totals,
    latestTimestamps: raw.latest_timestamps,
    managedSchemaCounts: raw.managed_schema_counts
  },
  checks,
  status: "passed"
};

await writeFile(outputPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({
  output: path.relative(projectRoot, outputPath).replaceAll("\\", "/"),
  normalizedEvidenceSha256: sha256(`${JSON.stringify(normalized, null, 2)}\n`),
  baselineSqlSha256,
  rawExportSha256: normalized.provenance.rawExport.sha256,
  rawExportFileSha256: normalized.provenance.rawExport.fileSha256,
  capturedAt: normalized.capturedAt,
  status: normalized.status
}, null, 2));
