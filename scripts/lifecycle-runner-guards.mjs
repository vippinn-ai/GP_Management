import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function lifecycleRuntimeIdentity(env) {
  if (Object.keys(env).some((key) => key.startsWith("E2E_GUARDED_") && env[key])) throw new Error("Maintenance-only environment overrides are forbidden.");
  const keys = ["E2E_BASE_URL", "E2E_RUN_ID", "E2E_HOP_STATION", "E2E_PAUSE_STATION", "E2E_OPERATIONAL_UNIT_STATION",
    "E2E_V2_HOP_RACE_STATION", "E2E_V2_REJECT_RACE_STATION", "E2E_V2_MULTIHOP_STATION", "E2E_V2_ROLE_HOP_STATION",
    "E2E_V2_ORGANIZATION_ID", "E2E_INVENTORY_CUSTOMER_NAME", "E2E_ROLE_MATRIX", "E2E_ROLE_MATRIX_PHASE",
    "E2E_BROWSER_CHANNEL", "E2E_HEADLESS", "E2E_OBSERVER_ADMIN_ACTOR_ID", "E2E_RECEPTIONIST_ACTOR_ID", "E2E_MANAGER_ACTOR_ID", "E2E_LIFECYCLE_MODE"];
  const inputs = Object.fromEntries(keys.map((key) => [key, env[key] ?? null]));
  return { inputs, sha256: sha256(JSON.stringify(inputs)) };
}

export function parseLifecycleArguments(args) {
  if (args.length === 0) return { discoveryOnly: false, args: [], mode: "full" };
  if (args.length === 1 && ["--list", "--help"].includes(args[0])) return { discoveryOnly: true, args, mode: "full" };
  if (JSON.stringify(args) === JSON.stringify(["--inventory-contract"]) || JSON.stringify(args) === JSON.stringify(["--inventory-contract", "--list"])) return { discoveryOnly: args.length === 2, args: args.slice(1), mode: "inventory-contract" };
  throw new Error("Lifecycle runner accepts only the complete suite, --list, --help, or --inventory-contract [--list]; arbitrary overrides and selectors are forbidden.");
}

export const INVENTORY_CONTRACT_TESTS = Object.freeze([
  Object.freeze({ file: "operational-lifecycle-v2-continuations.e2e.ts", project: "", title: "operational-lifecycle-v2-continuations.e2e.ts > Operational v2 continuation and unit-sale matrix > unit-sale session can hop and bill without losing its server-owned items" }),
  Object.freeze({ file: "operational-lifecycle-v2-hop-mutation-races.e2e.ts", project: "", title: "operational-lifecycle-v2-hop-mutation-races.e2e.ts > hop serializes safely against timing, pause, resume, add-item, and remove-item mutations" })
]);

export function lifecycleSuiteContract(mode) {
  if (!["full", "inventory-contract"].includes(mode)) throw new Error("Unknown lifecycle suite mode.");
  return { suite: mode === "full" ? "operational-lifecycle" : "operational-lifecycle-inventory-contract", mode,
    expectedTestCount: mode === "full" ? 31 : 2, fullReleaseGate: mode === "full" };
}

export function lifecycleSelectionArguments(mode) {
  lifecycleSuiteContract(mode);
  if (mode === "full") return [];
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return ["--grep", `^\\s*(?:${INVENTORY_CONTRACT_TESTS.map(entry => escape(entry.title.replaceAll(" > ", " "))).join("|")})$`];
}

export function assertLifecycleSuiteDiscovery(expected, mode) {
  const contract = lifecycleSuiteContract(mode);
  const key = ({file,project,title}) => JSON.stringify([file,project,title]);
  if (expected.length !== contract.expectedTestCount || new Set(expected.map(key)).size !== expected.length) throw new Error("Lifecycle discovery does not match the fixed suite size.");
  if (mode === "inventory-contract" && JSON.stringify(expected.map(key).sort()) !== JSON.stringify(INVENTORY_CONTRACT_TESTS.map(key).sort())) throw new Error("Inventory contract requires exactly the two approved full test identities.");
  return contract;
}

export function assertStagingBundleUrl(scriptPath, baseUrl) {
  const url = new URL(scriptPath, baseUrl);
  if (url.origin !== new URL(baseUrl).origin || url.username || url.password || url.search || url.hash
    || !/^\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(url.pathname)) {
    throw new Error("Bundle URL is outside the approved staging asset boundary.");
  }
  return url;
}

export const LIFECYCLE_FUNCTION_SOURCES = Object.freeze({
  hop_session_v2: "supabase/operational-lifecycle-v2.sql",
  reject_session_v2: "supabase/operational-lifecycle-v2.sql",
  reject_customer_tab_v2: "supabase/operational-lifecycle-v2.sql",
  start_session: "supabase/phase4-start-session-rpc.sql",
  open_customer_tab: "supabase/phase4-customer-tab-rpcs.sql",
  link_customer_tab_continuation: "supabase/phase4-link-customer-tab-continuation-rpc.sql",
  get_operational_performance_dataset_identity: "supabase/operational-performance-dataset-identity-staging.sql"
});

export function assertLifecycleSqlBinding(root, manifest) {
  const bodies = lifecycleSqlBodies(root);
  for (const [name, body] of Object.entries(bodies)) {
    if (sha256(body) !== manifest.expectedFunctionBodies?.[name]?.sha256) throw new Error(`Installed manifest does not bind current candidate SQL: ${name}.`);
  }
}

export function lifecycleSqlBodies(root) {
  const bodies = {};
  for (const [name, file] of Object.entries(LIFECYCLE_FUNCTION_SOURCES)) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const match = source.match(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)[\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`, "i"));
    if (!match) throw new Error(`Missing candidate SQL body: ${name}.`);
    bodies[name] = match[1].replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  }
  return bodies;
}

// Includes runtime, SQL, all QA dependencies, build configuration and lockfile;
// never includes env files, credentials, node_modules or generated evidence.
export function lifecycleSourceIdentity(root) {
  const paths = [];
  const visit = (relative) => {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected source link: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    } else paths.push(relative);
  };
  for (const dir of ["src", "scripts", "supabase", "tests"]) visit(dir);
  for (const name of fs.readdirSync(root).sort()) {
    if (/^(?:package(?:-lock)?\.json|(?:playwright|vite|vitest|eslint|tsconfig)[^/]*\.(?:ts|js|mjs|json)|index\.html)$/.test(name)) paths.push(name);
  }
  const files = paths.sort().map((file) => ({ path: file, sha256: sha256(fs.readFileSync(path.join(root, file))) }));
  return { schemaVersion: 1, sha256: sha256(JSON.stringify(files)), files };
}

export function assertCleanCandidate(root, expectedCommit) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? "")) throw new Error("Live lifecycle run requires the exact E2E_EXPECTED_COMMIT.");
  const git = (...args) => {
    const result = spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], { cwd: root, encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) throw new Error("Cannot verify candidate Git identity.");
    return result.stdout.trim();
  };
  if (git("rev-parse", "HEAD") !== expectedCommit) throw new Error("Candidate commit differs from the approved commit.");
  if (git("status", "--porcelain", "--untracked-files=all").length) throw new Error("Candidate worktree must be clean before live testing.");
}

export function expectedLifecycleTests(report) {
  const tests = [];
  const visit = (suite, ancestors = []) => {
    const parents = [...ancestors, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) {
      for (const project of spec.tests ?? []) tests.push({ file: spec.file.replaceAll("\\", "/"), project: project.projectName ?? "", title: [project.projectName, ...parents, spec.title].filter(Boolean).join(" > ") });
    }
    for (const child of suite.suites ?? []) visit(child, parents);
  };
  if (report.errors?.length) throw new Error("Lifecycle discovery reported errors.");
  for (const suite of report.suites ?? []) visit(suite);
  if (tests.length === 0 || new Set(tests.map((entry) => JSON.stringify(entry))).size !== tests.length) throw new Error("Lifecycle discovery must contain unique nonempty test identities.");
  return tests;
}

export function assertCompleteLifecycleSummary(summary, expected, runId) {
  const key = ({ file, project, title }) => JSON.stringify([file, project, title]);
  const wanted = expected.map(key).sort();
  const actual = (summary.tests ?? []).map(key).sort();
  if (summary.runId !== runId || summary.status !== "passed" || wanted.length === 0
    || JSON.stringify(wanted) !== JSON.stringify(actual)
    || summary.tests.some((entry) => entry.status !== "passed" || entry.retry !== 0)) {
    throw new Error("Lifecycle execution did not pass every expected test exactly once without retries or skips.");
  }
}
