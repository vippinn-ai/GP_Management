import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(modulePath), "..");
const expectedProjectRef = "rrdwbxvuwrbxefarxnse";
const expectedOrganizationId = "org-primary";
const expectedBaselineSqlPath = "supabase/release-b-production-baseline-readonly.sql";
const expectedBaselineSqlSha256 = "650d67292814417f168dcc33f61c6d930d5493d3c6096f80341be940a22ef2c8";
const defaultMaximumAgeMs = 15 * 60 * 1000;

function sha256(raw) {
  return createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex");
}

function canonicalizeSqlText(raw) {
  return raw.replace(/\r\n/g, "\n");
}

function resolveEvidenceChild(projectRoot, candidate, label) {
  if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`${label} is required.`);
  const evidenceRoot = path.join(projectRoot, "test-artifacts", "evidence");
  const resolved = path.resolve(projectRoot, candidate);
  const relative = path.relative(evidenceRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay under test-artifacts/evidence.`);
  }
  return resolved;
}

function exactBaselineRow(rawExport) {
  const exportedRows = JSON.parse(rawExport);
  if (!Array.isArray(exportedRows) || exportedRows.length !== 1) {
    throw new Error("Raw Supabase export must contain exactly one result row.");
  }
  const rowKeys = Object.keys(exportedRows[0] ?? {});
  if (rowKeys.length !== 1 || rowKeys[0] !== "release_b_production_baseline") {
    throw new Error("Raw Supabase export does not match the baseline query result contract.");
  }
  return { exportedRows, row: exportedRows[0].release_b_production_baseline };
}

export async function verifyReleaseBProductionBaseline({
  baselineEvidencePath,
  projectRoot = defaultProjectRoot,
  maximumAgeMs = defaultMaximumAgeMs,
  nowMs = Date.now()
}) {
  const normalizedPath = resolveEvidenceChild(projectRoot, baselineEvidencePath, "Baseline evidence");
  const normalizedRaw = await readFile(normalizedPath, "utf8");
  const baseline = JSON.parse(normalizedRaw);
  const rawExportPath = resolveEvidenceChild(projectRoot, baseline.provenance?.rawExport?.path, "Raw export");
  const [rawExport, baselineSql] = await Promise.all([
    readFile(rawExportPath, "utf8"),
    readFile(path.join(projectRoot, expectedBaselineSqlPath), "utf8")
  ]);
  const { exportedRows, row: raw } = exactBaselineRow(rawExport);
  const capturedAtMs = Date.parse(raw?.captured_at);
  const normalizedCapturedAtMs = Date.parse(baseline.capturedAt);
  const ageMs = nowMs - capturedAtMs;
  const expectedCapturedAt = Number.isFinite(capturedAtMs) ? new Date(capturedAtMs).toISOString() : null;
  const actualRawFileSha256 = sha256(rawExport);
  const actualRawCanonicalSha256 = sha256(JSON.stringify(exportedRows));
  const actualBaselineSqlSha256 = sha256(canonicalizeSqlText(baselineSql));
  const dashboardUrl = new URL(baseline.provenance?.dashboardUrl ?? "https://invalid.invalid/");
  const dashboardProjectMatch = dashboardUrl.pathname.match(/^\/dashboard\/project\/([^/]+)\/sql(?:\/|$)/);
  const appStateVersion = Number(raw?.app_state?.version);

  const checks = {
    normalizedContract:
      baseline.schemaVersion === 2 && baseline.environment === "production" &&
      baseline.projectRef === expectedProjectRef && baseline.productionWritePerformed === false &&
      baseline.status === "passed" && baseline.provenance?.captureMethod === "supabase-sql-editor-copy-as-json",
    dashboardCaptureIdentity:
      dashboardUrl.protocol === "https:" && dashboardUrl.hostname === "supabase.com" &&
      dashboardProjectMatch?.[1] === expectedProjectRef &&
      baseline.provenance?.dashboardTitle?.toLowerCase().includes("breakperfect-production"),
    exactBaselineSql:
      baseline.provenance?.baselineSql?.path === expectedBaselineSqlPath &&
      baseline.provenance?.baselineSql?.sha256 === expectedBaselineSqlSha256 &&
      actualBaselineSqlSha256 === expectedBaselineSqlSha256,
    rawFileHashMatches: baseline.provenance?.rawExport?.fileSha256 === actualRawFileSha256,
    rawCanonicalHashMatches: baseline.provenance?.rawExport?.sha256 === actualRawCanonicalSha256,
    rawIdentity:
      raw?.schema_version === 1 && raw?.expected_project_ref === expectedProjectRef &&
      raw?.organization_id === expectedOrganizationId,
    rawReadOnlyEmptyFloor:
      raw?.transaction_read_only === "on" && raw?.production_write_allowed === false &&
      raw?.open_active_sessions === 0 && raw?.open_customer_tabs === 0,
    freshCapture:
      Number.isFinite(capturedAtMs) && ageMs >= -2 * 60 * 1000 && ageMs <= maximumAgeMs,
    capturedAtMatches:
      normalizedCapturedAtMs === capturedAtMs && baseline.databaseDiscovery?.capturedAt === expectedCapturedAt,
    discoveryMatches:
      baseline.databaseDiscovery?.transactionReadOnly === true &&
      baseline.databaseDiscovery?.openActiveSessions === raw.open_active_sessions &&
      baseline.databaseDiscovery?.openCustomerTabs === raw.open_customer_tabs,
    appStateMatches:
      Number.isSafeInteger(appStateVersion) && /^[0-9a-f]{64}$/.test(raw?.app_state?.data_hash ?? "") &&
      raw?.app_state?.data_selected === false && baseline.databaseBaseline?.transactionReadOnly === true &&
      baseline.databaseBaseline?.appState?.version === appStateVersion &&
      baseline.databaseBaseline?.appState?.bytes === Number(raw.app_state.bytes) &&
      baseline.databaseBaseline?.appState?.dataHashSha256 === raw.app_state.data_hash &&
      baseline.databaseBaseline?.appState?.dataSelected === false,
    collectionsMatch:
      isDeepStrictEqual(baseline.databaseBaseline?.publicCounts, raw.public_counts) &&
      isDeepStrictEqual(baseline.databaseBaseline?.financialTotals, raw.financial_totals) &&
      isDeepStrictEqual(baseline.databaseBaseline?.latestTimestamps, raw.latest_timestamps) &&
      isDeepStrictEqual(baseline.databaseBaseline?.managedSchemaCounts, raw.managed_schema_counts)
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failures.length > 0) throw new Error(`Production baseline lineage verification failed: ${failures.join(", ")}.`);

  return {
    baseline, normalizedPath, normalizedRaw, normalizedSha256: sha256(normalizedRaw),
    rawExportPath, rawExportFileSha256: actualRawFileSha256,
    rawExportCanonicalSha256: actualRawCanonicalSha256,
    baselineSqlSha256: actualBaselineSqlSha256, capturedAtMs, ageMs, checks
  };
}

function getArgument(name) {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const verified = await verifyReleaseBProductionBaseline({ baselineEvidencePath: getArgument("--baseline-evidence") });
  console.log(JSON.stringify({
    schemaVersion: 1,
    productionAccessed: false,
    productionWritePerformed: false,
    normalizedEvidenceSha256: verified.normalizedSha256,
    baselineSqlSha256: verified.baselineSqlSha256,
    rawExportCanonicalSha256: verified.rawExportCanonicalSha256,
    rawExportFileSha256: verified.rawExportFileSha256,
    capturedAt: new Date(verified.capturedAtMs).toISOString(),
    checks: verified.checks,
    status: "passed"
  }, null, 2));
}
