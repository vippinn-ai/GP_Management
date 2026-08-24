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
const expectedVersion = Number(env.E2E_POSTFLIGHT_EXPECTED_APP_STATE_VERSION);
const expectedHash = env.E2E_POSTFLIGHT_EXPECTED_APP_STATE_HASH?.trim().toLowerCase();
const runId = env.E2E_POSTFLIGHT_RUN_ID?.trim();
if (!Number.isInteger(expectedVersion) || !/^[a-f0-9]{64}$/.test(expectedHash ?? "")) {
  throw new Error("Exact expected app_state version and SHA-256 hash are required.");
}
if (!runId || !/^[A-Za-z0-9_-]{1,80}$/.test(runId)) {
  throw new Error("A path-safe E2E_POSTFLIGHT_RUN_ID is required.");
}

const sessionIds = [
  "qa-reject-proof-source-session",
  "qa-reject-proof-consumer-session",
  "qa-reject-proof-source-tab",
  "qa-reject-proof-stale-session",
  "qa-reject-proof-spoof-session",
  "qa-reject-proof-audit-session",
  "qa-reject-proof-malformed-session",
  "qa-reject-proof-start-source",
  "qa-reject-proof-start-stale-consumer",
  "qa-reject-proof-start-new-consumer",
  "qa-reject-proof-link-source"
];
const tabIds = [
  "qa-reject-proof-consumer-tab",
  "qa-reject-proof-link-stale-consumer",
  "qa-reject-proof-link-target"
];
const entityIds = [...sessionIds, ...tabIds];
const auditIds = [
  "qa-reject-proof-existing-audit",
  "qa-reject-proof-session-audit",
  "qa-reject-proof-tab-audit",
  "qa-reject-proof-stale-audit",
  "qa-reject-proof-spoof-audit",
  "qa-reject-proof-malformed-audit",
  "qa-reject-proof-inactive-audit"
];
const mutationIds = [
  "qa-reject-proof-session-mutation",
  "qa-reject-proof-tab-mutation",
  "qa-reject-proof-stale-mutation",
  "qa-reject-proof-spoof-mutation",
  "qa-reject-proof-audit-collision-mutation",
  "qa-reject-proof-malformed-mutation",
  "qa-reject-proof-inactive-mutation",
  "qa-reject-proof-start-mutation",
  "qa-reject-proof-link-mutation"
];

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey) throw new Error("Ignored staging Supabase configuration is incomplete.");
if (new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Reject RPC proof reconciliation is locked to the staging Supabase project.");
}
const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const lookup = await supabase.functions.invoke("resolve-login-email", {
  body: { username: env.E2E_USER_A.trim() }
});
if (lookup.error || !lookup.data?.email) {
  const status = lookup.error?.context?.status;
  const detail = lookup.error?.message ?? "response did not contain an email";
  throw new Error(
    `Unable to resolve the staging test username${status ? ` (HTTP ${status})` : ""}: ${detail}`
  );
}
const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate the staging test account.");
const role = await supabase.rpc("current_user_org_role", { target_organization_id: organizationId });
if (role.error || role.data !== "admin") throw new Error("Reconciliation requires an authoritative staging admin.");

const [sessions, tabs, station, auditsById, auditsByEntity, eventsByEntity, eventsByMutation, appState] = await Promise.all([
  supabase.from("sessions").select("id").eq("organization_id", organizationId).in("id", sessionIds),
  supabase.from("customer_tabs").select("id").eq("organization_id", organizationId).in("id", tabIds),
  supabase.from("stations").select("id").eq("organization_id", organizationId).eq("id", "qa-reject-proof-start-station"),
  supabase.from("audit_logs").select("id,entity_id").eq("organization_id", organizationId).in("id", auditIds),
  supabase.from("audit_logs").select("id,entity_id").eq("organization_id", organizationId).in("entity_id", entityIds),
  supabase.from("operational_events").select("id,entity_id,metadata").eq("organization_id", organizationId).in("entity_id", entityIds),
  supabase.from("operational_events").select("id,entity_id,metadata").eq("organization_id", organizationId).in("metadata->>mutation_id", mutationIds),
  supabase.from("app_state").select("version,data").eq("id", "primary").single()
]);
for (const [label, result] of Object.entries({ sessions, tabs, station, auditsById, auditsByEntity, eventsByEntity, eventsByMutation, appState })) {
  if (result.error) throw new Error(`${label} reconciliation query failed: ${result.error.message}`);
}

const appStateHash = createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex");
const appStateText = JSON.stringify(appState.data.data);
const fixtureIdsInAppState = [...entityIds, ...auditIds, "qa-reject-proof-start-station"].filter((id) => appStateText.includes(id));
const residualRows = {
  sessions: sessions.data,
  customerTabs: tabs.data,
  stations: station.data,
  auditsById: auditsById.data,
  auditsByEntity: auditsByEntity.data,
  eventsByEntity: eventsByEntity.data,
  eventsByMutation: eventsByMutation.data,
  fixtureIdsInAppState
};
const residualCount = Object.values(residualRows).reduce((count, rows) => count + rows.length, 0);
const passed = appState.data.version === expectedVersion && appStateHash === expectedHash && residualCount === 0;
const evidence = {
  runId,
  checkedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  organizationId,
  actorUserId: login.data.user.id,
  actorRole: role.data,
  expectedAppState: { version: expectedVersion, hash: expectedHash },
  actualAppState: { version: appState.data.version, hash: appStateHash },
  residualRows,
  residualCount,
  passed
};
const artifactDirectory = path.join(root, "test-artifacts", "reconciliation");
fs.mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = path.join(artifactDirectory, `reject-rpc-proof-${runId}.json`);
fs.writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
if (!passed) {
  console.error(JSON.stringify({ status: "failed", artifact: path.relative(root, artifactPath), evidence }, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({ status: "passed", artifact: path.relative(root, artifactPath), evidence }, null, 2));
}
