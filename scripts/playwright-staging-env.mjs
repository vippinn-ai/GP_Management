import fs from "node:fs";

export const STAGING_APP_URL = "https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev/";
export const STAGING_PROJECT_REF = "tkbdyzxwwbhkpztgjjxh";
export const PRODUCTION_PROJECT_REF = "rrdwbxvuwrbxefarxnse";
export const STAGING_MUTATION_CONFIRMATION = "release-a-staging-only";

export function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsAt = line.indexOf("=");
    if (equalsAt < 1) continue;
    const key = line.slice(0, equalsAt).trim();
    let value = line.slice(equalsAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function assertStagingBaseUrl(value) {
  const candidate = value?.trim() || STAGING_APP_URL;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("E2E_BASE_URL must be a valid absolute staging URL.");
  }
  if (
    parsed.href !== STAGING_APP_URL ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Staging E2E is locked to ${STAGING_APP_URL}`);
  }
  if (candidate.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error("Production project references are forbidden in staging E2E configuration.");
  }
  return parsed.href;
}

export function assertStagingSupabaseEnvironment(stagingEnv, expectedFinancialV2 = false) {
  const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
  if (!supabaseUrl) {
    throw new Error(".env.staging must contain VITE_SUPABASE_URL before staging E2E can run.");
  }
  const hostname = new URL(supabaseUrl).hostname;
  const expectedHostname = `${STAGING_PROJECT_REF}.supabase.co`;
  if (hostname !== expectedHostname || supabaseUrl.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error("The staging build environment does not point to the approved staging Supabase project.");
  }
  if (stagingEnv.VITE_BACKEND_FINANCIAL_RPC_V2 !== String(expectedFinancialV2)) {
    throw new Error(
      `Staging E2E requires VITE_BACKEND_FINANCIAL_RPC_V2=${expectedFinancialV2}.`
    );
  }
}

export function assertLiveCredentials(env) {
  const required = ["E2E_USER_A", "E2E_PASSWORD_A", "E2E_USER_B", "E2E_PASSWORD_B"];
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) {
    throw new Error(`Missing staging E2E credentials: ${missing.join(", ")}. Copy .env.e2e.example to .env.e2e.local and fill staging-only values.`);
  }
  if (env.E2E_CONFIRM_STAGING_MUTATIONS !== STAGING_MUTATION_CONFIRMATION) {
    throw new Error(`Set E2E_CONFIRM_STAGING_MUTATIONS=${STAGING_MUTATION_CONFIRMATION} to acknowledge staging-only test writes.`);
  }
}

export function sanitizeRunId(value = "") {
  const candidate = value.trim() || new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  if (!/^[A-Za-z0-9_-]{6,48}$/.test(candidate)) {
    throw new Error("E2E_RUN_ID must contain 6-48 letters, digits, underscores, or hyphens.");
  }
  return candidate;
}
