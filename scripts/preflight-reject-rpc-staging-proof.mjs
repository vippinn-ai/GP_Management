import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  assertLiveCredentials,
  assertStagingSupabaseEnvironment,
  parseEnvFile,
  STAGING_PROJECT_REF
} from "./playwright-staging-env.mjs";

const root = process.cwd();
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };

assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);

const organizationId = "org-primary";
if (env.E2E_PREFLIGHT_ORGANIZATION_ID?.trim() && env.E2E_PREFLIGHT_ORGANIZATION_ID.trim() !== organizationId) {
  throw new Error("Reject RPC proof preflight is hard-locked to org-primary.");
}
const runId = env.E2E_PREFLIGHT_RUN_ID?.trim() || new Date().toISOString().replace(/[:.]/g, "-");
if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) {
  throw new Error("E2E_PREFLIGHT_RUN_ID must contain only letters, numbers, underscores, or hyphens.");
}
const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey) throw new Error("Ignored staging Supabase configuration is incomplete.");
if (new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Reject RPC proof preflight is locked to the staging Supabase project.");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const lookup = await supabase.functions.invoke("resolve-login-email", {
  body: { username: env.E2E_USER_A.trim() }
});
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve the staging test username.");
const login = await supabase.auth.signInWithPassword({
  email: lookup.data.email,
  password: env.E2E_PASSWORD_A
});
if (login.error || !login.data.user) throw new Error("Unable to authenticate the staging test account.");
const role = await supabase.rpc("current_user_org_role", { target_organization_id: organizationId });
if (role.error || role.data !== "admin") {
  throw new Error("Reject RPC proof preflight requires an authoritative staging admin.");
}

const [openSessions, openTabs, appState] = await Promise.all([
  supabase
    .from("sessions")
    .select("id,status,close_disposition,customer_name,station_name_snapshot,started_at,updated_at")
    .eq("organization_id", organizationId)
    .neq("status", "closed")
    .order("started_at", { ascending: true }),
  supabase
    .from("customer_tabs")
    .select("id,status,close_disposition,customer_name,opened_at,updated_at")
    .eq("organization_id", organizationId)
    .eq("status", "open")
    .order("opened_at", { ascending: true }),
  supabase.from("app_state").select("version,data").eq("id", "primary").single()
]);
for (const [label, result] of Object.entries({ openSessions, openTabs, appState })) {
  if (result.error) throw new Error(`${label} preflight query failed: ${result.error.message}`);
}

const evidence = {
  runId,
  checkedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  organizationId,
  actorUserId: login.data.user.id,
  actorRole: role.data,
  openSessions: openSessions.data,
  openCustomerTabs: openTabs.data,
  appState: {
    version: appState.data.version,
    hash: createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex")
  },
  safeToRunRollbackProof: openSessions.data.length === 0 && openTabs.data.length === 0
};
const artifactDirectory = path.join(root, "test-artifacts", "preflight");
fs.mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = path.join(artifactDirectory, `reject-rpc-proof-preflight-${runId}.json`);
fs.writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

if (!evidence.safeToRunRollbackProof) {
  console.error(JSON.stringify({ status: "blocked", artifact: path.relative(root, artifactPath), evidence }, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({ status: "passed", artifact: path.relative(root, artifactPath), evidence }, null, 2));
}
