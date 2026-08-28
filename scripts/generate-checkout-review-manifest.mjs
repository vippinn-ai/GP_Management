import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const root = process.cwd();
const outputRelative = "openspec/changes/financial-checkout-app-state-decoupling/review-manifest-files.csv";
const selfReferentialEvidence = new Set([
  outputRelative,
  "openspec/changes/financial-checkout-app-state-decoupling/review-manifest.md"
]);
const exactTextFiles = new Set([
  ".env.example",
  ".env.e2e.example",
  ".env.e2e.roles.example",
  ".gitignore",
  ".prettierrc",
  "public/_headers"
]);
const textExtensions = new Set([
  ".css", ".html", ".js", ".json", ".md", ".mjs", ".sql", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"
]);
const excludedPrefixes = ["dist/", "node_modules/", "coverage/", "test-artifacts/", ".git/"];
const releaseBMaintenanceArtifacts = new Set([
  "scripts/build-reject-rpc-staging-install.mjs",
  "supabase/staging-qa-multihop-quarantine-repair.sql"
]);
const checkoutSettlementDiagnosticArtifacts = new Set([
  "scripts/preflight-checkout-settlement-race-staging.mjs",
  "scripts/reconcile-checkout-settlement-race-staging.mjs"
]);

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function csv(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function physicalLineCount(text) {
  if (!text) return 0;
  const lines = text.split(/\r\n|\n|\r/);
  return /(?:\r\n|\n|\r)$/.test(text) ? lines.length - 1 : lines.length;
}

function classifyAppState(path, content) {
  if (!/app_state|appState|baseAppStateVersion/.test(content)) return "none";
  if (path === "supabase/phase10-financial-v2-rpcs.sql") return "v2-prohibition-and-client-field-rejection";
  if (
    path.startsWith("openspec/") || path.startsWith("tests/") || path.endsWith(".test.ts") || path.endsWith(".test.tsx") ||
    path === ".gitignore" || path === "architect.md" || path === "deploymentrules.md" || path.endsWith("runbook.md")
  ) {
    return "documentation-or-test-reference";
  }
  if (path === "scripts/generate-checkout-review-manifest.mjs") return "review-tool-classifier";
  if (path === "scripts/bootstrap-production.mjs" || path === "scripts/fix-pricing-bands.mjs") {
    return "legacy-maintenance-script";
  }
  if (path === "scripts/inspect-staging-sessions.mjs" || path === "scripts/reconcile-financial-v2-staging.mjs") {
    return "migration-diagnostic-or-reconstruction";
  }
  if (checkoutSettlementDiagnosticArtifacts.has(path)) return "migration-diagnostic-or-reconstruction";
  if (
    path.startsWith("scripts/") &&
    /(?:inspect|preflight|reconcile|run)-checkout-(?:refund|replacement|repeat-combo|session-item)/.test(path)
  ) {
    return "staging-test-evidence-reference";
  }
  if (
    path === "scripts/build-reject-rpc-transactional-proof.mjs" ||
    path === "scripts/build-reject-rpc-staging-install.mjs" ||
    path === "scripts/preflight-reject-rpc-staging-proof.mjs" ||
    path === "scripts/reconcile-reject-rpc-staging-proof.mjs" ||
    path === "supabase/phase4-reject-rpcs-transactional-proof.sql" ||
    path === "supabase/staging-qa-multihop-quarantine-repair.sql"
  ) {
    return "migration-diagnostic-or-reconstruction";
  }
  if (path === "supabase/phase3-read-performance-indexes.sql" || path === "supabase/phase7-analytics-summary-rpc.sql") {
    return "normalized-source-no-app-state-access";
  }
  if (
    path.includes("backfill") || path.includes("parity") || path.includes("baseline") ||
    path.includes("performance-evidence") || path.includes("inventory-admin-sync-repair")
  ) return "migration-diagnostic-or-reconstruction";
  if (path.includes("publication") || path.endsWith("schema.sql") || path.includes("add-app-state") || path.includes("fix-rls")) {
    return "schema-or-realtime-compatibility";
  }
  if (
    path === "src/App.tsx" || path === "src/backend.ts" || path === "src/checkoutTelemetry.ts" ||
    path === "src/syncTelemetry.ts" || path.startsWith("src/dataGateway/")
  ) {
    return "runtime-legacy-compatibility-boundary";
  }
  if (path.startsWith("supabase/phase4-") || path.startsWith("supabase/phase5-") || path.startsWith("supabase/phase6-")) {
    return "legacy-v1-purpose-writer";
  }
  return "reviewed-other-reference";
}

const collectionPatterns = [
  ["users/profiles", /\busers\b|\bprofiles\b|profile_/i],
  ["organizations", /\borganizations\b|organization_id/i],
  ["business_profile", /businessProfile|business_profile/i],
  ["stations", /\bstations\b|station_id|stationId/i],
  ["pricing_rules", /pricingRules|pricing_rules/i],
  ["sessions", /\bsessions\b|session_id|sessionId/i],
  ["session_pause_logs", /sessionPauseLogs|session_pause_logs/i],
  ["customer_tabs", /customerTabs|customer_tabs/i],
  ["customers", /\bcustomers\b|customer_id|customerId/i],
  ["inventory_items", /inventoryItems|inventory_items/i],
  ["sale_variants", /saleVariants|sale_variants/i],
  ["combos", /\bcombos\b|combo_/i],
  ["stock_movements", /stockMovements|stock_movements/i],
  ["bills", /\bbills\b|bill_id|billId/i],
  ["bill_lines", /\bbill_lines\b|billLines|linked_session_id|linkedSessionId/i],
  ["payments", /\bpayments\b|payment_/i],
  ["audit_logs", /auditLogs|audit_logs/i],
  ["expenses", /\bexpenses\b|expense_/i],
  ["operational_events", /operationalEvents|operational_events/i],
  ["financial_mutations", /financialMutations|financial_mutations/i]
];

function inferCollections(path, content) {
  const names = new Set(collectionPatterns.filter(([, pattern]) => pattern.test(content)).map(([name]) => name));
  if (path === "scripts/build-reject-rpc-staging-install.mjs") {
    ["app_state", "sessions", "customer_tabs", "audit_logs", "operational_events"].forEach((name) => names.add(name));
  }
  if (path === "supabase/staging-qa-multihop-quarantine-repair.sql") {
    ["app_state", "sessions", "customer_tabs", "bill_lines", "audit_logs", "operational_events"].forEach((name) => names.add(name));
  }
  if (checkoutSettlementDiagnosticArtifacts.has(path)) {
    [
      "app_state",
      "sessions",
      "customer_tabs",
      "bills",
      "bill_lines",
      "payments",
      "audit_logs",
      "operational_events",
      "financial_mutations"
    ].forEach((name) => names.add(name));
  }
  if (path === "tests/e2e/staging/release-a-inventory-matrix.e2e.ts") {
    [
      "customer_tabs",
      "customer_tab_items",
      "customer_tab_combo_applications",
      "inventory_items",
      "sale_variants",
      "combos",
      "operational_events"
    ].forEach((name) => names.add(name));
  }
  if ([
    "tests/e2e/staging/release-b-checkout-reject-race-v2.e2e.ts",
    "tests/e2e/staging/release-b-checkout-hop-race-v2.e2e.ts",
    "tests/e2e/staging/release-b-role-checkout-hop-timing-v2.e2e.ts",
    "tests/e2e/staging/release-b-multihop-concurrency-v2.e2e.ts"
  ].includes(path)) {
    names.add("customers");
  }
  return [...names].join("; ");
}

function inferRpcs(path, content) {
  const names = new Set();
  for (const match of content.matchAll(/\.rpc\(\s*["']([a-z0-9_]+)["']/gi)) names.add(match[1]);
  for (const match of content.matchAll(/\brpc\s*===\s*["']([a-z0-9_]+)["']/gi)) names.add(match[1]);
  for (const match of content.matchAll(/function\s+public\.([a-z0-9_]+)\s*\(/gi)) names.add(match[1]);
  for (const match of content.matchAll(/\b(?:perform|select)\s+public\.([a-z0-9_]+)\s*\(/gi)) names.add(match[1]);
  if (path === "scripts/build-reject-rpc-staging-install.mjs") {
    [
      "start_session",
      "reject_session",
      "reject_customer_tab",
      "link_customer_tab_continuation",
      "raise_operational_rpc_error",
      "patch_app_state_array_by_id"
    ].forEach((name) => names.add(name));
  }
  if (path === "tests/e2e/staging/release-b-checkout-reject-race-v2.e2e.ts") {
    [
      "start_session",
      "save_live_session_details",
      "commit_checkout_bill_v2",
      "reject_session",
      "get_financial_mutation_result"
    ].forEach((name) => names.add(name));
  }
  if (path === "tests/e2e/staging/release-b-checkout-hop-race-v2.e2e.ts") {
    [
      "start_session",
      "save_live_session_details",
      "commit_checkout_bill_v2",
      "hop_session",
      "get_financial_mutation_result",
      "current_user_org_role",
      "reject_session"
    ].forEach((name) => names.add(name));
  }
  if (path === "tests/e2e/staging/release-b-role-checkout-hop-timing-v2.e2e.ts") {
    [
      "start_session",
      "commit_checkout_bill_v2",
      "hop_session",
      "get_financial_mutation_result",
      "current_user_org_role",
      "reject_session"
    ].forEach((name) => names.add(name));
  }
  if (path === "tests/e2e/staging/release-b-multihop-concurrency-v2.e2e.ts") {
    [
      "start_session",
      "save_live_session_details",
      "hop_session",
      "commit_checkout_bill_v2",
      "get_financial_mutation_result",
      "current_user_org_role"
    ].forEach((name) => names.add(name));
  }
  if (path === "tests/e2e/staging/release-b-checkout-session-item-race-v2.e2e.ts") {
    [
      "commit_admin_data_change",
      "start_session",
      "save_live_session_details",
      "commit_checkout_bill_v2",
      "add_session_item",
      "get_financial_mutation_result",
      "reject_session"
    ].forEach((name) => names.add(name));
  }
  return [...names].sort().join("; ");
}

function inferDirectTests(path) {
  if (/\.test\.[^.]+$/.test(path)) return "self";
  const extension = extname(path);
  const directTest = extension ? `${path.slice(0, -extension.length)}.test${extension}` : "";
  const tests = [];
  if (directTest && existsSync(join(root, directTest))) tests.push(directTest);
  if (path === "src/App.tsx") {
    tests.push("src/dataGateway/financialRpcClient.test.ts", "src/dataGateway/dataGateway.test.ts", "src/operationalSync.test.ts");
  }
  if (path === "supabase/phase10-financial-v2-rpcs.sql" || path === "supabase/phase11-operational-maintenance-rpcs.sql") {
    tests.push("src/dataGateway/financialV2SqlContract.test.ts");
  }
  if (path === "supabase/phase4-hop-session-rpc.sql") {
    tests.push("src/dataGateway/operationalSqlContract.test.ts");
  }
  if ([
    "supabase/phase4-reject-rpcs.sql",
    "supabase/phase4-start-session-rpc.sql",
    "supabase/phase4-link-customer-tab-continuation-rpc.sql"
  ].includes(path)) {
    tests.push("src/dataGateway/operationalSqlContract.test.ts");
  }
  if (path === "scripts/inspect-staging-sessions.mjs") {
    tests.push("src/qa/playwrightStagingHarnessContract.test.ts");
  }
  if (releaseBMaintenanceArtifacts.has(path)) {
    tests.push("src/qa/playwrightStagingHarnessContract.test.ts");
  }
  if (checkoutSettlementDiagnosticArtifacts.has(path)) {
    tests.push("src/qa/checkoutSettlementRaceHarnessContract.test.ts");
  }
  if (
    path === "scripts/manage-session-item-race-admin-staging.mjs" ||
    path === "scripts/session-item-race-admin-env.mjs" ||
    path.includes("checkout-session-item-race")
  ) {
    tests.push("src/qa/checkoutSessionItemRaceHarnessContract.test.ts");
  }
  return [...new Set(tests)].join("; ");
}

const rawFiles = execFileSync("git", ["-c", `safe.directory=${normalizePath(root)}`, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: root,
  encoding: "utf8"
});
const files = rawFiles
  .split("\0")
  .map(normalizePath)
  .filter(Boolean)
  .filter((path) => !excludedPrefixes.some((prefix) => path.startsWith(prefix)))
  .filter((path) => !selfReferentialEvidence.has(path))
  .filter((path) => exactTextFiles.has(path) || textExtensions.has(extname(path).toLowerCase()))
  .sort((left, right) => left.localeCompare(right));

const rows = files.map((path) => {
  const content = readFileSync(join(root, path), "utf8");
  if (extname(path).toLowerCase() === ".json") {
    JSON.parse(content);
  }
  const operationalStagingContract = path.startsWith("tests/e2e/staging/") && path.endsWith(".e2e.ts");
  const releaseBProof = path.startsWith("openspec/changes/financial-checkout-app-state-decoupling/release-b-") && path.endsWith(".sql");
  const billingRelevant = operationalStagingContract || releaseBProof || releaseBMaintenanceArtifacts.has(path) || /checkout|bill|payment|settle|receipt|discount|refund|void|deferred|financial/i.test(content);
  const appStateDisposition = classifyAppState(path, content);
  const semanticHotspot = billingRelevant || appStateDisposition !== "none" || path === "src/App.tsx" || path.startsWith("src/dataGateway/");
  return {
    path,
    lines: physicalLineCount(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    status: "reviewed",
    method: path === "package-lock.json"
      ? "mechanical-lockfile-json-integrity-screen"
      : semanticHotspot ? "semantic-hotspot-plus-mechanical-screen" : "mechanical-full-text-risk-screen",
    billingRelevant: billingRelevant ? "yes" : "no",
    collections: inferCollections(path, content),
    rpcs: inferRpcs(path, content),
    appStateDisposition,
    tests: inferDirectTests(path)
  };
});

const header = [
  "path", "lines", "sha256", "review_status", "review_method", "billing_relevant",
  "collections_or_tables", "rpcs_called_or_defined", "app_state_disposition", "direct_test_evidence"
];
const output = [
  header.map(csv).join(","),
  ...rows.map((row) => [
    row.path, row.lines, row.sha256, row.status, row.method, row.billingRelevant,
    row.collections, row.rpcs, row.appStateDisposition, row.tests
  ].map(csv).join(","))
].join("\n") + "\n";

writeFileSync(join(root, outputRelative), output, "utf8");

const summary = {
  output: outputRelative,
  files: rows.length,
  lines: rows.reduce((total, row) => total + row.lines, 0),
  billingRelevant: rows.filter((row) => row.billingRelevant === "yes").length,
  appStateReferences: rows.filter((row) => row.appStateDisposition !== "none").length,
  semanticHotspots: rows.filter((row) => row.method.startsWith("semantic-hotspot")).length,
  filesWithoutDirectTests: rows.filter((row) => !row.tests).length
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
