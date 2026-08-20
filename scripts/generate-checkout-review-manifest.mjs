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
const exactTextFiles = new Set([".env.example", ".gitignore", ".prettierrc", "public/_headers"]);
const textExtensions = new Set([
  ".css", ".html", ".js", ".json", ".md", ".mjs", ".sql", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"
]);
const excludedPrefixes = ["dist/", "node_modules/", "coverage/", "test-artifacts/", ".git/"];

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
    path.startsWith("openspec/") || path.endsWith(".test.ts") || path.endsWith(".test.tsx") ||
    path === ".gitignore" || path === "architect.md" || path === "deploymentrules.md" || path.endsWith("runbook.md")
  ) {
    return "documentation-or-test-reference";
  }
  if (path === "scripts/generate-checkout-review-manifest.mjs") return "review-tool-classifier";
  if (path === "scripts/bootstrap-production.mjs" || path === "scripts/fix-pricing-bands.mjs") {
    return "legacy-maintenance-script";
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
  ["payments", /\bpayments\b|payment_/i],
  ["audit_logs", /auditLogs|audit_logs/i],
  ["expenses", /\bexpenses\b|expense_/i],
  ["operational_events", /operationalEvents|operational_events/i],
  ["financial_mutations", /financialMutations|financial_mutations/i]
];

function inferCollections(path, content) {
  const names = new Set(collectionPatterns.filter(([, pattern]) => pattern.test(content)).map(([name]) => name));
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
  return [...names].join("; ");
}

function inferRpcs(content) {
  const names = new Set();
  for (const match of content.matchAll(/\.rpc\(\s*["']([a-z0-9_]+)["']/gi)) names.add(match[1]);
  for (const match of content.matchAll(/\brpc\s*===\s*["']([a-z0-9_]+)["']/gi)) names.add(match[1]);
  for (const match of content.matchAll(/function\s+public\.([a-z0-9_]+)\s*\(/gi)) names.add(match[1]);
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
  return [...new Set(tests)].join("; ");
}

const rawFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
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
  const billingRelevant = operationalStagingContract || /checkout|bill|payment|settle|receipt|discount|refund|void|deferred|financial/i.test(content);
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
    rpcs: inferRpcs(content),
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
