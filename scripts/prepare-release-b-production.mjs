import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionProjectRef = "rrdwbxvuwrbxefarxnse";
const stagingProjectRef = "tkbdyzxwwbhkpztgjjxh";
const productionEnvPath = path.join(projectRoot, ".env.production");
const requiredTrueFlags = [
  "VITE_BACKEND_RPC_OPERATIONAL_WRITES",
  "VITE_BACKEND_NORMALIZED_LIVE_READS",
  "VITE_BACKEND_RPC_FINANCIAL_WRITES",
  "VITE_BACKEND_FINANCIAL_RPC_V2",
  "VITE_BACKEND_NORMALIZED_REALTIME",
  "VITE_BACKEND_NORMALIZED_BOOTSTRAP",
  "VITE_BACKEND_NORMALIZED_CUSTOMER_SEARCH_READS",
  "VITE_BACKEND_NORMALIZED_BILL_HISTORY_READS",
  "VITE_BACKEND_NORMALIZED_REPORT_READS",
  "VITE_BACKEND_ANALYTICS_SUMMARY_READS",
  "VITE_BACKEND_INVENTORY_REPORT_READS"
];
const evidenceFiles = [
  {
    path: "test-artifacts/evidence/release-b-mixed-performance-mixed-20260830-2004.json",
    sha256: "39ad4a4439fbbfcc3e7f4c62537200d0b76050b0e1ff46896978f840e1f07800"
  },
  {
    path: "test-artifacts/evidence/release-b-deployed-readonly-evidence-20260830-135438z.json",
    sha256: "43e8ffab19d95f812716914349890ff3bb63ee774d43ecee2f42d808beb84336"
  },
  {
    path: "test-artifacts/evidence/release-b-staging-log-gate-mixed-20260830-2004.json",
    sha256: "fd973cc6243b613a5d5cb8a4edfcf51ac8a583f3d0ede52afb7f67a15f9cc7b7"
  },
  {
    path: "test-artifacts/reconciliation/checkout-repeat-combo-fixture-cleanup-postflight-mixed-2004-fixture-cleanup.json",
    sha256: "cdbd15aa163cc583500f0f8080f7fa699391cc1c711c1c57901d063fdd6b2de6"
  }
];

function getArgument(name) {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function parseEnv(raw) {
  const values = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

function setEnvValues(raw, replacements) {
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const seen = new Set();
  const updated = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !replacements.has(match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${replacements.get(match[1])}`;
  });
  for (const [name, value] of replacements) {
    if (!seen.has(name)) updated.push(`${name}=${value}`);
  }
  return updated.join(newline).replace(new RegExp(`${newline}*$`), newline);
}

function runGit(args) {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${projectRoot.replaceAll("\\", "/")}`, ...args],
    { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}

async function sha256(relativePath) {
  const content = await readFile(path.join(projectRoot, relativePath));
  return createHash("sha256").update(content).digest("hex");
}

const apply = process.argv.includes("--apply");
const releaseCheck = process.argv.includes("--release-check");
const sourceEnv = getArgument("--source-env");
const expectedCommit = getArgument("--expected-commit");
const evidenceOutput = getArgument("--evidence-output");

if (apply) {
  const sourcePath = sourceEnv ? path.resolve(sourceEnv) : productionEnvPath;
  const sourceRaw = await readFile(sourcePath, "utf8");
  const sourceValues = parseEnv(sourceRaw);
  const expectedUrl = `https://${productionProjectRef}.supabase.co`;
  if (sourceValues.get("VITE_SUPABASE_URL") !== expectedUrl) {
    throw new Error("Production environment source does not target the exact production Supabase project.");
  }
  if (!sourceValues.get("VITE_SUPABASE_ANON_KEY")) {
    throw new Error("Production environment source is missing its Supabase anonymous key.");
  }
  const replacements = new Map(requiredTrueFlags.map((name) => [name, "true"]));
  await writeFile(productionEnvPath, setEnvValues(sourceRaw, replacements), "utf8");
}

const envRaw = await readFile(productionEnvPath, "utf8");
const env = parseEnv(envRaw);
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const wranglerPackage = JSON.parse(await readFile(path.join(projectRoot, "node_modules/wrangler/package.json"), "utf8"));
const evidence = await Promise.all(evidenceFiles.map(async (item) => {
  const actualSha256 = await sha256(item.path);
  return { ...item, actualSha256, matches: actualSha256 === item.sha256 };
}));
const branch = runGit(["branch", "--show-current"]);
const head = runGit(["rev-parse", "HEAD"]);
const dirtyEntries = runGit(["status", "--short"]).split(/\r?\n/).filter(Boolean);
const productionUrl = env.get("VITE_SUPABASE_URL") ?? "";
const flags = Object.fromEntries(requiredTrueFlags.map((name) => [name, env.get(name) === "true"]));
const deployCommand = packageJson.scripts?.["deploy:production"] ?? "";
const expectedCommitMatches = expectedCommit ? head === expectedCommit : !releaseCheck;

const checks = {
  productionEnvExists: true,
  exactProductionProject: productionUrl === `https://${productionProjectRef}.supabase.co`,
  stagingProjectExcluded: !productionUrl.includes(stagingProjectRef),
  anonymousKeyPresent: Boolean(env.get("VITE_SUPABASE_ANON_KEY")),
  allReleaseBFlagsTrue: Object.values(flags).every(Boolean),
  evidenceHashesMatch: evidence.every((item) => item.matches),
  expectedBranch: branch === "codex/checkout-app-state-decoupling",
  productionDeployScriptExact:
    deployCommand.includes("vite build --mode production") &&
    deployCommand.includes("wrangler deploy --name management"),
  wranglerV4OrLater: Number.parseInt(wranglerPackage.version.split(".")[0], 10) >= 4,
  worktreeCleanWhenReleaseChecked: !releaseCheck || dirtyEntries.length === 0,
  expectedCommitProvidedWhenReleaseChecked: !releaseCheck || Boolean(expectedCommit),
  expectedCommitMatches
};
const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
const result = {
  schemaVersion: 1,
  mode: releaseCheck ? "release-check" : apply ? "apply-and-prepare" : "prepare-check",
  checkedAt: new Date().toISOString(),
  productionProjectRef,
  productionWorker: "management",
  productionUrl: "https://management.breakperfectgaminglounge.workers.dev",
  productionAccessed: false,
  productionWritePerformed: false,
  secretValuesPrinted: false,
  branch,
  head,
  dirtyEntryCount: dirtyEntries.length,
  wranglerVersion: wranglerPackage.version,
  flags,
  evidence,
  checks,
  failures,
  status: failures.length === 0 ? "passed" : "failed"
};

const serializedResult = `${JSON.stringify(result, null, 2)}\n`;
if (evidenceOutput) {
  const outputPath = path.resolve(projectRoot, evidenceOutput);
  const allowedRoot = path.join(projectRoot, "test-artifacts", "preflight") + path.sep;
  if (!outputPath.startsWith(allowedRoot)) {
    throw new Error("Preparation evidence output must stay under test-artifacts/preflight.");
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializedResult, "utf8");
}
console.log(serializedResult.trimEnd());
if (failures.length > 0) process.exitCode = 1;
