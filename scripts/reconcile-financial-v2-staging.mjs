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

function requiredIds(name) {
  const ids = (env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error(`${name} must contain one or more unique comma-separated IDs.`);
  }
  return ids;
}

function required(name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const runId = required("E2E_RECONCILE_RUN_ID");
const organizationId = required("E2E_RECONCILE_ORGANIZATION_ID");
const mutationIds = requiredIds("E2E_RECONCILE_MUTATION_IDS");
const billIds = requiredIds("E2E_RECONCILE_BILL_IDS");
const sessionIds = requiredIds("E2E_RECONCILE_SESSION_IDS");
const expectedMutationCount = Number(required("E2E_RECONCILE_MUTATION_COUNT"));
const expectedBillCount = Number(required("E2E_RECONCILE_BILL_COUNT"));
const expectedSessionCount = Number(required("E2E_RECONCILE_SESSION_COUNT"));
const expectedCustomer = required("E2E_RECONCILE_CUSTOMER");
const expectedStation = required("E2E_RECONCILE_STATION");
const expectedAppStateVersion = Number(required("E2E_RECONCILE_APP_STATE_VERSION"));
const expectedAppStateHash = required("E2E_RECONCILE_APP_STATE_HASH");
if (!Number.isInteger(expectedAppStateVersion)) throw new Error("Expected app_state version must be an integer.");
if (
  !Number.isInteger(expectedMutationCount) || !Number.isInteger(expectedBillCount) || !Number.isInteger(expectedSessionCount) ||
  mutationIds.length !== expectedMutationCount || billIds.length !== expectedBillCount || sessionIds.length !== expectedSessionCount ||
  expectedMutationCount < 1 || expectedBillCount < 1 || expectedSessionCount !== 3
) {
  throw new Error("Reconciliation ID counts do not match the exact expected counts.");
}

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey) throw new Error("Ignored staging Supabase configuration is incomplete.");
if (new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Reconciliation is locked to the staging Supabase project.");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const lookup = await supabase.functions.invoke("resolve-login-email", {
  body: { username: env.E2E_USER_A.trim() }
});
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve the staging test username.");
const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate the staging test account.");

const role = await supabase.rpc("current_user_org_role", { target_organization_id: organizationId });
if (role.error || role.data !== "admin") throw new Error("Reconciliation requires an authoritative staging admin.");

const mutationStatuses = [];
for (const mutationId of mutationIds) {
  const status = await supabase.rpc("get_financial_mutation_result", {
    payload: { organization_id: organizationId, mutation_id: mutationId, mutation_kind: "commitCheckoutBill" }
  });
  if (status.error) throw status.error;
  mutationStatuses.push({ mutationId, result: status.data });
}

const [bills, payments, events, sessions, appState] = await Promise.all([
  supabase.from("bills").select("id,bill_number,status,total,amount_paid,amount_due").eq("organization_id", organizationId).in("id", billIds),
  supabase.from("payments").select("id,bill_id,amount").eq("organization_id", organizationId).in("bill_id", billIds),
  supabase.from("operational_events").select("id,entity_id,metadata,created_at").eq("organization_id", organizationId).in("metadata->>mutation_id", mutationIds),
  supabase.from("sessions").select("id,status,close_disposition,closed_bill_id,continued_from_session_ids,customer_name,station_name_snapshot").eq("organization_id", organizationId).in("id", sessionIds),
  supabase.from("app_state").select("version,data").eq("id", "primary").single()
]);
for (const [label, result] of Object.entries({ bills, payments, events, sessions, appState })) {
  if (result.error) throw new Error(`${label} reconciliation failed: ${result.error.message}`);
}

const appStateHash = createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex");
const evidence = {
  runId,
  reconciledAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  organizationId,
  actorUserId: login.data.user.id,
  actorRole: role.data,
  mutationStatuses,
  bills: bills.data,
  payments: payments.data,
  events: events.data,
  sessions: sessions.data,
  appState: { version: appState.data.version, hash: appStateHash }
};

if (mutationStatuses.some((entry) => entry.result !== null)) throw new Error("At least one mutation committed; stop before cleanup.");
if (bills.data.length || payments.data.length || events.data.length) throw new Error("A rejected mutation left a financial effect; stop before cleanup.");
if (sessions.data.length !== sessionIds.length) throw new Error("Not every exact session ID was found.");
const sessionsById = new Map(sessions.data.map((session) => [session.id, session]));
const [firstSessionId, secondSessionId, thirdSessionId] = sessionIds;
const firstSession = sessionsById.get(firstSessionId);
const secondSession = sessionsById.get(secondSessionId);
const thirdSession = sessionsById.get(thirdSessionId);
for (const session of [firstSession, secondSession, thirdSession]) {
  if (
    !session ||
    session.customer_name !== expectedCustomer ||
    session.station_name_snapshot !== expectedStation ||
    session.closed_bill_id !== null
  ) {
    throw new Error("An exact session identity or unbilled invariant changed; stop before cleanup.");
  }
}
if (firstSession.status !== "closed" || firstSession.close_disposition !== "hopped") {
  throw new Error("The first source is no longer an unbilled hopped session.");
}
if (
  secondSession.status !== "closed" ||
  secondSession.close_disposition !== "hopped" ||
  JSON.stringify(secondSession.continued_from_session_ids ?? []) !== JSON.stringify([firstSessionId])
) {
  throw new Error("The second source no longer has the exact first-hop linkage.");
}
if (
  thirdSession.status !== "active" ||
  thirdSession.close_disposition !== null ||
  JSON.stringify(thirdSession.continued_from_session_ids ?? []) !== JSON.stringify([firstSessionId, secondSessionId])
) {
  throw new Error("The third session no longer has the exact active multi-hop linkage.");
}
if (appState.data.version !== expectedAppStateVersion || appStateHash !== expectedAppStateHash) {
  throw new Error("app_state changed after the rejected race; stop before cleanup.");
}

const artifactDirectory = path.join(root, "test-artifacts", "reconciliation");
fs.mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = path.join(artifactDirectory, `financial-v2-${runId}.json`);
fs.writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: "passed", artifact: path.relative(root, artifactPath), evidence }, null, 2));
