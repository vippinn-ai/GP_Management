import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const stagingProjectRef = "tkbdyzxwwbhkpztgjjxh";
const organizationId = "org-primary";
const schemaVersion = 1;

const args = process.argv.slice(2);
if (args.length !== 1 || !args[0].startsWith("--run-id=")) {
  throw new Error("Expected exactly one --run-id=<unique-read-only-run-id> argument.");
}
const runId = args[0].slice("--run-id=".length);
if (!/^[a-z0-9][a-z0-9-]{7,79}$/.test(runId)) throw new Error("The aggregation run ID is invalid.");

const scaleEvidence = {
  path: "openspec/changes/financial-checkout-app-state-decoupling/release-b-staging-evidence-2026-08-20.md",
  sha256: "2fb0f67b75bec89ad011c71563821bdf936f0506867fdcca21d529c79e77df09",
  requiredClaims: [
    "Corrected run `20260820141559` executed 50 sequential Arcade 1 unit-sale session/inventory checkouts in one zero-retry test:",
    "- full-domain database p95 `478.066 ms`, maximum `530.476 ms`;",
    "- browser p95 `4,261 ms`, maximum `5,051 ms`;",
    "- database and browser thresholds passed (`<2 s` p95, `<5 s` DB max, `<7 s` browser max);",
    "This performance claim is deliberately scoped to repeated Arcade session/inventory checkout. It does not represent a mixed session/customer-tab/carryover/combo/settlement workload."
  ],
  metrics: {
    cases: 50,
    workload: "repeated_arcade_unit_sale_session_inventory_checkout",
    databaseP95Ms: 478.066,
    databaseMaxMs: 530.476,
    browserP95Ms: 4261,
    browserMaxMs: 5051,
    mixedRepresentative: false
  }
};

const sources = [
  ["payment_upi", "payments", "test-artifacts/reconciliation/checkout-payment-matrix-reconciliation-upi-paymatrix-upi-20260830-1257.json", "d378c55fa55473f8bcdc2cffd330e3f7015ceb7d1d0fc966fd4c1f2986649ef2", "paymatrix-upi-20260830-1257", "status:passed"],
  ["payment_split", "payments", "test-artifacts/reconciliation/checkout-payment-matrix-reconciliation-split-paymatrix-split3-20260830-1330.json", "cac10df9ffe58a0ba551e299604d3f01a80414592b65c4643f415c4b75346ed8", "paymatrix-split3-20260830-1330", "status:passed"],
  ["payment_partial_previous_dues", "payments", "test-artifacts/reconciliation/checkout-payment-matrix-reconciliation-partial_previous_dues-paymatrix-dues4-20260830-1500.json", "f4053ab7a689db04dd2f76715f6b6bee6b0be8680eca2e19fe1146edb17f0726", "paymatrix-dues4-20260830-1500", "status:passed"],
  ["discount_rounding", "pricing", "test-artifacts/evidence/checkout-pricing-reanalysis-discount_rounding_positive-pricing-positive3-20260830-1450.json", "77e2d67f437920fba73bcebac38ee1ea427fbfb0045c80bbd7d66007641e1ba9", "pricing-positive3-20260830-1450", "status:passed"],
  ["ltp_zero", "pricing", "test-artifacts/evidence/checkout-pricing-reconciliation-ltp_zero-pricing-ltp2-20260830-1520.json", "3d2e281fbdbb971f6dc89845c1baa893cc42e6564c0cd8f01748aaaa2683d452", "pricing-ltp2-20260830-1520", "status:passed"],
  ["bill_discount_zero", "pricing", "test-artifacts/evidence/checkout-pricing-reconciliation-bill_discount_zero-pricing-billzero2-20260830-1545.json", "24451f0c933206de8e8b40ed8c489e4226e4a6539dde275860169116e279d6ba", "pricing-billzero2-20260830-1545", "status:passed"],
  ["replacement_quantity_decrease", "replacement", "test-artifacts/evidence/checkout-replacement-parity-reanalysis-replacement-parity-20260830-1542.json", "2879af27e847c5b321037f335c5494aac4b8d9dd4749518717eaf65241a087e7", "replacement-parity-20260830-1542", "replacement:partial-known-browser-terminal-gap"],
  ["refund_race", "financial_writer_race", "test-artifacts/reconciliation/checkout-refund-race-postflight-refund-race-20260828082130.json", "784ea0af0c0024e82882e7725c4c72ab39dcc259de4551df226f2461477a3df6", "refund-race-20260828082130", "checks:all-true"],
  ["void_race", "financial_writer_race", "test-artifacts/reconciliation/checkout-void-race-postflight-void-race-20260829-2027.json", "1249f2f6d3a9abfae4b42103182de95e129350715f93c89058e72bf152bf6905", "void-race-20260829-2027", "checks:all-true"],
  ["repeat_combo_race", "combo", "test-artifacts/reconciliation/checkout-repeat-combo-race-postflight-20260828-combo-race-010807-review1.json", "04c874bdd4b53b9769c72b4a56ce4ecf016c99f5f303761d2c09d0acb0ee917c", "20260828-combo-race-010807", "passed-and-checks:all-true"],
  ["settlement_race", "financial_writer_race", "test-artifacts/reconciliation/checkout-settlement-race-after-cleanup-20260827115031.json", "c6f3e7a0bcb4d21c31470ee9821da74c8825a2dfcd5c052772b114ed31bfda3f", "20260827115031", "settlement:after-cleanup-exact"],
  ["multi_hop_carryover", "carryover", "test-artifacts/reconciliation/staging-sessions-multihop-rerun-20260825122028-passed.json", "7cc62e3f8f46999cdc1da66495a175ffa42a8eed79a1a3f41e5a66c774e06fab", "multihop-rerun-20260825122028-passed", "multihop:three-closed-billed"],
  ["tab_combo_mutation_race", "combo", "test-artifacts/reconciliation/checkout-tab-mutation-race-recovery-tab-mut-rem4-20260829-1338.json", "f2688ae97749f1492c089cf720de76ebf44b1fac2ee16318ead0baa8ab98c2ae", "tab-mut-rem4-20260829-1338", "status:reconciled"],
  ["writeoff_race", "financial_writer_race", "test-artifacts/reconciliation/checkout-writeoff-race-reconciliation-writeoff-sim-20260829-1457-writeoff-sim-cleanup-20260829-1957.json", "f3ca9034c8bcddbb8d9ea0b178099a2014e6f27367fd7c87b2f6b94bf34ac79a", "writeoff-sim-20260829-1457", "status:passed"]
].map(([caseName, family, sourcePath, sha256, expectedRunId, terminalContract]) => ({
  caseName,
  family,
  path: sourcePath,
  sha256,
  expectedRunId,
  terminalContract
}));

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function valueSha256(value) {
  return value == null ? null : sha256(Buffer.from(JSON.stringify(stable(value))));
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)];
}

function stats(records, key) {
  const values = records.map((record) => record[key]).filter(Number.isFinite);
  return {
    count: values.length,
    p95Ms: percentile(values, 0.95),
    maxMs: values.length ? Math.max(...values) : null
  };
}

function scanSensitive(value, currentPath = "report", failures = []) {
  if (!value || typeof value !== "object") return failures;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${currentPath}.${key}`;
    if (/^(authorization|apikey|password|access_token|refresh_token)$/i.test(key)) failures.push(childPath);
    scanSensitive(child, childPath, failures);
  }
  return failures;
}

function walk(value, visitor, currentPath = "$") {
  visitor(value, currentPath);
  if (Array.isArray(value)) value.forEach((child, index) => walk(child, visitor, `${currentPath}[${index}]`));
  else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, child]) => walk(child, visitor, `${currentPath}.${key}`));
  }
}

function collectExplicitBrowserDurations(value) {
  const records = [];
  walk(value, (candidate, currentPath) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
    for (const [key, child] of Object.entries(candidate)) {
      if (/^(browserDurationMs|browser_completion_ms|checkoutBrowserDurationMs)$/i.test(key) && Number.isFinite(child)) {
        records.push({ path: `${currentPath}.${key}`, browserDurationMs: child });
      }
    }
  });
  return records;
}

function collectFinancialMutationDurations(value, source) {
  const records = [];
  walk(value, (candidate, currentPath) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
    const mutationId = candidate.mutation_id ?? candidate.mutationId;
    const serverDurationMs = candidate.server_duration_ms ?? candidate.serverDurationMs;
    if (typeof mutationId !== "string" || !mutationId.startsWith("financial-") || !Number.isFinite(serverDurationMs)) return;
    const mutationKind = candidate.mutation_kind ?? candidate.mutationKind ??
      (mutationId.startsWith("financial-adjustment-") ? "financialAdjustment" : "commitCheckoutBill");
    const candidateOrganizationId = candidate.organization_id ?? candidate.organizationId ?? organizationId;
    records.push({
      key: `${candidateOrganizationId}|${mutationId}|${mutationKind}`,
      organizationId: candidateOrganizationId,
      mutationId,
      mutationKind,
      serverDurationMs,
      coreDurationMs: candidate.core_duration_ms ?? candidate.coreDurationMs ?? null,
      eventId: candidate.event_id ?? candidate.eventId ?? null,
      changedRowsSha256: valueSha256(candidate.changed_rows ?? candidate.changedRows ?? null),
      canonicalBillSha256: valueSha256(candidate.canonical_bill ?? candidate.canonicalBill ?? null),
      canonicalPaymentsSha256: valueSha256(candidate.canonical_payments ?? candidate.canonicalPayments ?? null),
      family: source.family,
      caseName: source.caseName,
      sourcePath: source.path,
      jsonPath: currentPath
    });
  });
  return records;
}

function validateSource(source, value) {
  const failures = [];
  if (value.projectRef !== stagingProjectRef) failures.push(`projectRef must equal ${stagingProjectRef}`);
  if (value.runId !== source.expectedRunId) failures.push(`runId must equal ${source.expectedRunId}`);
  if (value.productionAllowed === true) failures.push("productionAllowed must not be true");
  if (source.terminalContract.startsWith("status:") && value.status !== source.terminalContract.slice("status:".length)) {
    failures.push(`terminal status must satisfy ${source.terminalContract}`);
  }
  for (const key of ["integrityFailures", "ambiguities"]) {
    if (Array.isArray(value[key]) && value[key].length) failures.push(`${key} must be empty`);
  }
  if (source.terminalContract === "replacement:partial-known-browser-terminal-gap") {
    const acceptedLimitation = ["Browser terminal evidence is missing."];
    if (JSON.stringify(value.failures) !== JSON.stringify(acceptedLimitation) ||
        JSON.stringify(value.completionFailures) !== JSON.stringify(acceptedLimitation)) {
      failures.push("replacement reanalysis must contain only the accepted missing-browser-terminal limitation");
    }
    if (value.safeForIdentityBoundCleanup !== true) failures.push("replacement reanalysis must be safe for identity-bound cleanup");
  } else {
    for (const key of ["failures", "completionFailures"]) {
      if (Array.isArray(value[key]) && value[key].length) failures.push(`${key} must be empty`);
    }
  }
  if (source.terminalContract === "checks:all-true" &&
      (!value.checks || Array.isArray(value.checks) || Object.values(value.checks).some((check) => check !== true))) {
    failures.push("every named terminal check must be true");
  }
  if (source.terminalContract === "passed-and-checks:all-true" &&
      (value.passed !== true || !Array.isArray(value.checks) || !value.checks.length || value.checks.some((check) => check?.passed !== true))) {
    failures.push("terminal passed flag and every array check must be true");
  }
  if (source.terminalContract === "settlement:after-cleanup-exact" &&
      (value.phase !== "after-cleanup" || !value.mutationStatuses?.setup || value.mutationStatuses?.checkout !== null ||
       !value.mutationStatuses?.adjustment || value.openSessions?.length !== 0 || value.openTabs?.length !== 0)) {
    failures.push("settlement terminal shape must be exact after cleanup");
  }
  if (source.terminalContract === "multihop:three-closed-billed" &&
      (value.requestedSessionIds?.length !== 3 || value.sessions?.length !== 3 ||
       value.sessions.some((session) => session.status !== "closed" || session.close_disposition !== "billed") || value.billLines?.length !== 3)) {
    failures.push("multi-hop terminal shape must contain three requested closed/billed sessions and three bill lines");
  }
  return failures;
}

const lineageFailures = [];
const scaleRaw = fs.readFileSync(path.join(root, scaleEvidence.path));
if (sha256(scaleRaw) !== scaleEvidence.sha256) lineageFailures.push(`${scaleEvidence.path}: SHA-256 mismatch`);
const scaleText = scaleRaw.toString("utf8");
for (const claim of scaleEvidence.requiredClaims) {
  if (!scaleText.includes(claim)) lineageFailures.push(`${scaleEvidence.path}: required scale claim is missing`);
}

const sourceReports = [];
const mutationCandidates = [];
const complexBrowserDurations = [];
const diagnosticFailures = [];
for (const source of sources) {
  const absolutePath = path.join(root, source.path);
  if (!fs.existsSync(absolutePath)) {
    lineageFailures.push(`${source.path}: missing`);
    continue;
  }
  const raw = fs.readFileSync(absolutePath);
  const actualSha256 = sha256(raw);
  if (actualSha256 !== source.sha256) lineageFailures.push(`${source.path}: SHA-256 mismatch`);
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    lineageFailures.push(`${source.path}: invalid JSON (${error.message})`);
    continue;
  }
  const validationFailures = validateSource(source, value);
  lineageFailures.push(...validationFailures.map((failure) => `${source.path}: ${failure}`));
  const mutations = collectFinancialMutationDurations(value, source);
  const browserDurations = collectExplicitBrowserDurations(value).map((record) => ({ ...record, family: source.family, caseName: source.caseName, sourcePath: source.path }));
  mutationCandidates.push(...mutations);
  complexBrowserDurations.push(...browserDurations);
  walk(value, (candidate, currentPath) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
    for (const [key, child] of Object.entries(candidate)) {
      if (!/^(code|error|message|details|failure)$/i.test(key) || typeof child !== "string") continue;
      if (/\b57014\b|deadlock detected|statement timeout|client timeout|timed out|timeout.*exceeded/i.test(child)) {
        diagnosticFailures.push({ sourcePath: source.path, path: `${currentPath}.${key}`, value: child });
      }
    }
  });
  sourceReports.push({
    caseName: source.caseName,
    family: source.family,
    path: source.path,
    sha256: actualSha256,
    runId: value.runId,
    terminalContract: source.terminalContract,
    status: value.status ?? (value.passed === true ? "passed" : "verified-by-explicit-terminal-contract"),
    mutationCandidateCount: mutations.length,
    explicitBrowserDurationCount: browserDurations.length,
    validationFailures
  });
}

const uniqueMutations = new Map();
const duplicateConflicts = [];
const exactInvariantFields = ["serverDurationMs", "family", "caseName"];
const nullableInvariantFields = ["coreDurationMs", "eventId", "changedRowsSha256", "canonicalBillSha256", "canonicalPaymentsSha256"];
for (const candidate of mutationCandidates) {
  const existing = uniqueMutations.get(candidate.key);
  if (!existing) {
    uniqueMutations.set(candidate.key, { ...candidate, duplicateLocations: [], enrichmentProvenance: {} });
    continue;
  }
  const fieldConflicts = [];
  for (const field of exactInvariantFields) {
    if (existing[field] !== candidate[field]) fieldConflicts.push(field);
  }
  for (const field of nullableInvariantFields) {
    if (existing[field] != null && candidate[field] != null && existing[field] !== candidate[field]) fieldConflicts.push(field);
  }
  if (fieldConflicts.length) {
    duplicateConflicts.push({ key: candidate.key, fields: fieldConflicts, first: existing, conflicting: candidate });
    continue;
  }
  existing.duplicateLocations.push({ sourcePath: candidate.sourcePath, jsonPath: candidate.jsonPath });
  for (const field of nullableInvariantFields) {
    if (existing[field] == null && candidate[field] != null) {
      existing[field] = candidate[field];
      existing.enrichmentProvenance[field] = { sourcePath: candidate.sourcePath, jsonPath: candidate.jsonPath };
    }
  }
}
const mutationRecords = [...uniqueMutations.values()].sort((left, right) => left.key.localeCompare(right.key));
const families = Object.fromEntries([...new Set(sources.map((source) => source.family))].sort().map((family) => {
  const records = mutationRecords.filter((record) => record.family === family);
  return [family, { ...stats(records, "serverDurationMs"), mutationIds: records.map((record) => record.mutationId) }];
}));
const databaseMetrics = stats(mutationRecords, "serverDurationMs");
const complexBrowserMetrics = stats(complexBrowserDurations, "browserDurationMs");

const thresholds = {
  databaseP95MsExclusive: 2000,
  databaseMaxMsExclusive: 5000,
  browserMaxMsExclusive: 7000,
  scaleDatabasePassed: scaleEvidence.metrics.databaseP95Ms < 2000 && scaleEvidence.metrics.databaseMaxMs < 5000,
  scaleBrowserPassed: scaleEvidence.metrics.browserMaxMs < 7000,
  aggregatedComplexDatabasePassed: databaseMetrics.count > 0 && databaseMetrics.p95Ms < 2000 && databaseMetrics.maxMs < 5000,
  aggregatedComplexBrowserPassed: complexBrowserMetrics.count > 0 && complexBrowserMetrics.maxMs < 7000
};

const blockingReasons = [];
if (lineageFailures.length) blockingReasons.push("One or more SHA-bound source artifacts failed lineage validation.");
if (duplicateConflicts.length) blockingReasons.push("The same organization/mutation/kind key has conflicting timing evidence.");
if (diagnosticFailures.length) blockingReasons.push("A selected source contains SQLSTATE 57014, deadlock, statement-timeout, or client-timeout diagnostics.");
if (!thresholds.aggregatedComplexDatabasePassed) blockingReasons.push("The SHA-bound complex database sample does not satisfy the database thresholds.");
if (!thresholds.aggregatedComplexBrowserPassed) blockingReasons.push("No explicit complex checkout browser-completion timing distribution proves the <7 second browser threshold.");

const report = {
  schemaVersion,
  runId,
  generatedAt: new Date().toISOString(),
  mode: "read-only-historical-evidence-aggregation",
  projectRef: stagingProjectRef,
  organizationId,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  sourceCount: sourceReports.length + 1,
  sourceReports,
  scaleEvidence: { path: scaleEvidence.path, sha256: sha256(scaleRaw), metrics: scaleEvidence.metrics },
  complexEvidence: {
    mutationKeyContract: "organization_id|mutation_id|mutation_kind",
    mutationRecords,
    duplicateConflicts,
    databaseMetrics,
    familyMetrics: families,
    explicitBrowserDurationRecords: complexBrowserDurations,
    complexBrowserMetrics
  },
  diagnostics: {
    lineageFailures,
    forbiddenDatabaseOrClientErrors: diagnosticFailures
  },
  thresholds,
  gateClosed: blockingReasons.length === 0,
  blockingReasons,
  conclusion: blockingReasons.length === 0
    ? "The selected SHA-bound evidence closes the mixed representative performance subgate."
    : "Historical aggregation alone does not close the mixed representative performance subgate."
};

const sensitivePaths = scanSensitive(report);
if (sensitivePaths.length) throw new Error(`Refusing to persist sensitive aggregation evidence: ${sensitivePaths.join(", ")}`);
if (lineageFailures.length) throw new Error(`Historical evidence lineage failed: ${lineageFailures.join(" | ")}`);
if (duplicateConflicts.length) throw new Error("Historical evidence contains conflicting duplicate mutation timing records.");

const outputDirectory = path.join(root, "test-artifacts", "evidence");
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, `release-b-performance-aggregation-${runId}.json`);
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", encoding: "utf8" });
const outputRaw = fs.readFileSync(outputPath);
console.log(JSON.stringify({
  status: report.gateClosed ? "passed" : "partial",
  outputPath: path.relative(root, outputPath),
  sha256: sha256(outputRaw),
  mutationCount: mutationRecords.length,
  databaseMetrics,
  complexBrowserMetrics,
  blockingReasons
}, null, 2));
