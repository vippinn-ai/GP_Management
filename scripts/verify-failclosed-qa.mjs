import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { loadEnv } from "vite";

const STAGING_PROJECT_REF = "tkbdyzxwwbhkpztgjjxh";
const PRODUCTION_PROJECT_REF = "rrdwbxvuwrbxefarxnse";
const QA_WORKER_NAME = "gp-management-staging-failclosed-qa";
const QA_HOSTNAME = `${QA_WORKER_NAME}.breakperfectgaminglounge.workers.dev`;
const QA_FLAG = "VITE_QA_NORMALIZED_READ_FAILURES";
const QA_BUILD_ID_FLAG = "VITE_QA_FAIL_CLOSED_BUILD_ID";
const QA_BUILD_ID_VALUE = "release-a-failclosed-qa-v1";
const QA_BUILD_ARTIFACT_PREFIX = "qa-failclosed-build-id=";
const REQUIRED_TRUE_FLAGS = [
  "VITE_BACKEND_NORMALIZED_BOOTSTRAP",
  "VITE_BACKEND_NORMALIZED_CUSTOMER_SEARCH_READS",
  "VITE_BACKEND_NORMALIZED_BILL_HISTORY_READS",
  "VITE_BACKEND_NORMALIZED_REPORT_READS",
  "VITE_BACKEND_ANALYTICS_SUMMARY_READS",
  "VITE_BACKEND_INVENTORY_REPORT_READS"
];
const EXPECTED_BUILD_CONTRACT =
  "qa=true|bootstrap=true|customer=true|bills=true|reports=true|analytics=true|inventory=true|v2=false";

function parseEnvFile(path) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      })
  );
}

function collectJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectJavaScriptFiles(path);
    return extname(entry.name) === ".js" ? [path] : [];
  });
}

function verifyStagingConfiguration() {
  const stagingEnv = parseEnvFile(resolve(".env.staging"));
  const resolvedViteEnv = loadEnv("staging", process.cwd(), "");
  const stagingUrl = new URL(stagingEnv.VITE_SUPABASE_URL ?? "https://invalid.invalid");

  if (stagingUrl.hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
    throw new Error("Fail-closed QA build refused: .env.staging does not target the approved staging Supabase project.");
  }
  if (!stagingEnv.VITE_SUPABASE_ANON_KEY?.trim()) {
    throw new Error("Fail-closed QA build refused: the staging anonymous key is missing.");
  }
  for (const flag of REQUIRED_TRUE_FLAGS) {
    if (stagingEnv[flag] !== "true") {
      throw new Error(`Fail-closed QA build refused: ${flag} must be true in .env.staging.`);
    }
  }
  if (stagingEnv.VITE_BACKEND_FINANCIAL_RPC_V2 !== "false") {
    throw new Error("Fail-closed QA build refused: financial v2 must remain false.");
  }
  for (const qaOnlyFlag of [QA_FLAG, QA_BUILD_ID_FLAG]) {
    if (Object.prototype.hasOwnProperty.call(stagingEnv, qaOnlyFlag)) {
      throw new Error(`Fail-closed QA build refused: ${qaOnlyFlag} must be absent from ordinary staging configuration.`);
    }
  }
  const protectedKeys = [
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_ANON_KEY",
    ...REQUIRED_TRUE_FLAGS,
    "VITE_BACKEND_FINANCIAL_RPC_V2"
  ];
  for (const key of protectedKeys) {
    if (resolvedViteEnv[key] !== stagingEnv[key]) {
      throw new Error(`Fail-closed QA build refused: resolved ${key} does not match .env.staging.`);
    }
  }
  for (const qaOnlyFlag of [QA_FLAG, QA_BUILD_ID_FLAG]) {
    if (Object.prototype.hasOwnProperty.call(resolvedViteEnv, qaOnlyFlag)) {
      throw new Error(`Fail-closed QA build refused: resolved ordinary staging environment contains ${qaOnlyFlag}.`);
    }
  }
}

function verifyBuiltArtifact() {
  const bundle = collectJavaScriptFiles(resolve("dist")).map((path) => readFileSync(path, "utf8")).join("\n");
  const requiredMarkers = [
    `${STAGING_PROJECT_REF}.supabase.co`,
    QA_HOSTNAME,
    "qaNormalizedReadFailure",
    "Controlled QA failure: normalized",
    EXPECTED_BUILD_CONTRACT,
    QA_BUILD_ARTIFACT_PREFIX
  ];
  for (const marker of requiredMarkers) {
    if (!bundle.includes(marker)) {
      throw new Error(`Fail-closed QA build refused: built artifact is missing marker ${marker}.`);
    }
  }
  if (bundle.includes(`${PRODUCTION_PROJECT_REF}.supabase.co`)) {
    throw new Error("Fail-closed QA build refused: built artifact contains the production Supabase project reference.");
  }
  if (bundle.split(QA_BUILD_ID_VALUE).length - 1 < 2) {
    throw new Error("Fail-closed QA build refused: the QA build ID was not compiled into the runtime value.");
  }
}

const action = process.argv[2];
verifyStagingConfiguration();
if (action === "artifact") {
  verifyBuiltArtifact();
  console.info(`Verified isolated QA artifact for ${STAGING_PROJECT_REF} with financial v2 disabled.`);
} else if (action !== "precheck") {
  throw new Error("Usage: node scripts/verify-failclosed-qa.mjs precheck|artifact");
}
