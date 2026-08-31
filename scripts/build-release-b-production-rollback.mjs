import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionEnvPath = path.join(projectRoot, ".env.production");
const outputRoot = path.join(projectRoot, "dist-production-rollback");
const evidencePath = path.join(
  projectRoot,
  "test-artifacts",
  "evidence",
  "release-b-production-compatibility-rollback-build.json"
);
const productionProjectRef = "rrdwbxvuwrbxefarxnse";
const stagingProjectRef = "tkbdyzxwwbhkpztgjjxh";
const requiredTrueFlags = [
  "VITE_BACKEND_RPC_OPERATIONAL_WRITES",
  "VITE_BACKEND_NORMALIZED_LIVE_READS",
  "VITE_BACKEND_RPC_FINANCIAL_WRITES",
  "VITE_BACKEND_NORMALIZED_REALTIME",
  "VITE_BACKEND_NORMALIZED_BOOTSTRAP",
  "VITE_BACKEND_NORMALIZED_CUSTOMER_SEARCH_READS",
  "VITE_BACKEND_NORMALIZED_BILL_HISTORY_READS",
  "VITE_BACKEND_NORMALIZED_REPORT_READS",
  "VITE_BACKEND_ANALYTICS_SUMMARY_READS",
  "VITE_BACKEND_INVENTORY_REPORT_READS"
];

function parseEnv(raw) {
  const values = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "inherit",
    env: { ...process.env, ...extraEnv }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}.`);
  }
}

function runGit(args) {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${projectRoot.replaceAll("\\", "/")}`, ...args],
    { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Git inspection failed.");
  return result.stdout.trim();
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  }));
  return nested.flat().sort();
}

const env = parseEnv(await readFile(productionEnvPath, "utf8"));
const sourceChecks = {
  exactProductionProject:
    env.get("VITE_SUPABASE_URL") === `https://${productionProjectRef}.supabase.co`,
  stagingProjectExcluded:
    !(env.get("VITE_SUPABASE_URL") ?? "").includes(stagingProjectRef),
  anonymousKeyPresent: Boolean(env.get("VITE_SUPABASE_ANON_KEY")),
  normalizedAndV1FallbackFlagsReady:
    requiredTrueFlags.every((name) => env.get(name) === "true"),
  sourceReleaseIsV2: env.get("VITE_BACKEND_FINANCIAL_RPC_V2") === "true"
};
const sourceFailures = Object.entries(sourceChecks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
if (sourceFailures.length > 0) {
  throw new Error(`Compatibility rollback source preflight failed: ${sourceFailures.join(", ")}.`);
}

run(process.execPath, [path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "-b"]);
run(
  process.execPath,
  [path.join(projectRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--mode", "production", "--outDir", "dist-production-rollback", "--emptyOutDir"],
  { VITE_BACKEND_FINANCIAL_RPC_V2: "false" }
);

const files = await listFiles(outputRoot);
const textFiles = files.filter((file) => /\.(?:html|js|css|json|txt)$/i.test(file));
const searchable = Buffer.concat(await Promise.all(textFiles.map((file) => readFile(file)))).toString("utf8");
const javascriptFiles = files.filter((file) => /\.js$/i.test(file));
const largestJavascriptFile = (await Promise.all(javascriptFiles.map(async (file) => ({
  file,
  size: (await stat(file)).size
})))).sort((a, b) => b.size - a.size)[0];
const bundle = largestJavascriptFile ? await readFile(largestJavascriptFile.file) : Buffer.alloc(0);
const actualBuildFlag = searchable.match(/qa=undefined[\s\S]{0,500}?v2=(true|false)/)?.[1] ?? null;
const checks = {
  ...sourceChecks,
  indexHtmlPresent: files.some((file) => path.relative(outputRoot, file).replaceAll("\\", "/") === "index.html"),
  javascriptBundlePresent: javascriptFiles.length > 0,
  exactProductionProjectPresent: searchable.includes(productionProjectRef),
  stagingProjectAbsent: !searchable.includes(stagingProjectRef),
  normalizedBootstrapPresent: searchable.includes("bootstrap=true"),
  financialV2BuildFlagFalse: actualBuildFlag === "false",
  v1CheckoutPathPresent: searchable.includes("commit_checkout_bill"),
  v1AdjustmentPathPresent: searchable.includes("commit_financial_adjustment")
};
const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
const result = {
  schemaVersion: 1,
  purpose: "data-safe Release B compatibility rollback",
  checkedAt: new Date().toISOString(),
  productionProjectRef,
  productionWorker: "management",
  productionAccessed: false,
  productionWritePerformed: false,
  secretValuesPrinted: false,
  sourceCommit: runGit(["rev-parse", "HEAD"]),
  sourceTreeClean: runGit(["status", "--short"]) === "",
  compatibilityContract: {
    normalizedReadsRemainEnabled: true,
    financialRpcV2Enabled: false,
    v1FinancialFallbackEnabled: true,
    legacyAppStateReadRollbackAllowed: false
  },
  fileCount: files.length,
  bundle: largestJavascriptFile ? {
    path: path.relative(projectRoot, largestJavascriptFile.file).replaceAll("\\", "/"),
    bytes: largestJavascriptFile.size,
    sha256: createHash("sha256").update(bundle).digest("hex")
  } : null,
  checks,
  failures,
  status: failures.length === 0 ? "passed" : "failed"
};

await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
