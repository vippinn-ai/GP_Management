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

const runId = env.E2E_INSPECT_RUN_ID?.trim();
const organizationId = env.E2E_INSPECT_ORGANIZATION_ID?.trim() || "org-primary";
const expectedActorRole = env.E2E_INSPECT_EXPECTED_ROLE?.trim() || "admin";
if (!new Set(["admin", "manager", "receptionist"]).has(expectedActorRole)) {
  throw new Error("E2E_INSPECT_EXPECTED_ROLE must be admin, manager, or receptionist.");
}
const sessionIds = (env.E2E_INSPECT_SESSION_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const billIds = (env.E2E_INSPECT_BILL_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const mutationIds = (env.E2E_INSPECT_MUTATION_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (!runId || sessionIds.length === 0 || new Set(sessionIds).size !== sessionIds.length) {
  throw new Error("E2E_INSPECT_RUN_ID and unique E2E_INSPECT_SESSION_IDS are required.");
}
if (new Set(billIds).size !== billIds.length || new Set(mutationIds).size !== mutationIds.length) {
  throw new Error("Optional E2E_INSPECT_BILL_IDS and E2E_INSPECT_MUTATION_IDS must be unique.");
}

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey) throw new Error("Ignored staging Supabase configuration is incomplete.");
if (new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Session inspection is locked to the staging Supabase project.");
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
if (role.error || role.data !== expectedActorRole) {
  throw new Error(`Session inspection requires the authoritative expected staging role: ${expectedActorRole}.`);
}

const [sessions, events, audits, billLines, bills, payments, appState] = await Promise.all([
  supabase.from("sessions")
    .select("id,status,close_disposition,closed_bill_id,continued_from_session_ids,customer_name,station_name_snapshot,started_at,ended_at,updated_at,raw_data")
    .eq("organization_id", organizationId)
    .in("id", sessionIds),
  supabase.from("operational_events")
    .select("id,event_type,entity_id,metadata,created_at")
    .eq("organization_id", organizationId)
    .in("entity_id", sessionIds)
    .order("created_at", { ascending: true }),
  supabase.from("audit_logs")
    .select("id,action,entity_id,message,audit_at,user_id")
    .eq("organization_id", organizationId)
    .in("entity_id", sessionIds)
    .order("audit_at", { ascending: true }),
  supabase.from("bill_lines")
    .select("id,bill_id,type,linked_session_id,total")
    .eq("organization_id", organizationId)
    .in("linked_session_id", sessionIds),
  billIds.length
    ? supabase.from("bills")
      .select("id,bill_number,status,total,amount_paid,amount_due,payment_mode,issued_by_user_id,created_at")
      .eq("organization_id", organizationId)
      .in("id", billIds)
    : Promise.resolve({ data: [], error: null }),
  billIds.length
    ? supabase.from("payments")
      .select("id,bill_id,amount,mode,received_by_user_id,paid_at")
      .eq("organization_id", organizationId)
      .in("bill_id", billIds)
    : Promise.resolve({ data: [], error: null }),
  supabase.from("app_state").select("version,data").eq("id", "primary").single()
]);
for (const [label, result] of Object.entries({ sessions, events, audits, billLines, bills, payments, appState })) {
  if (result.error) throw new Error(`${label} inspection failed: ${result.error.message}`);
}
if (sessions.data.length !== sessionIds.length) throw new Error("Not every exact session ID was found.");
if (billIds.length && bills.data.length !== billIds.length) throw new Error("Not every exact bill ID was found.");

const mutationStatuses = [];
for (const mutationId of mutationIds) {
  const status = await supabase.rpc("get_financial_mutation_result", {
    payload: { organization_id: organizationId, mutation_id: mutationId, mutation_kind: "commitCheckoutBill" }
  });
  if (status.error) throw new Error(`Mutation inspection failed: ${status.error.message}`);
  mutationStatuses.push({ mutationId, result: status.data });
}

const evidence = {
  runId,
  inspectedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  organizationId,
  actorUserId: login.data.user.id,
  actorRole: role.data,
  requestedSessionIds: sessionIds,
  requestedBillIds: billIds,
  requestedMutationIds: mutationIds,
  sessions: sessions.data,
  events: events.data,
  audits: audits.data,
  billLines: billLines.data,
  bills: bills.data,
  payments: payments.data,
  mutationStatuses,
  appState: {
    version: appState.data.version,
    hash: createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex")
  }
};
const artifactDirectory = path.join(root, "test-artifacts", "reconciliation");
fs.mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = path.join(artifactDirectory, `staging-sessions-${runId}.json`);
fs.writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  status: "passed",
  artifact: path.relative(root, artifactPath),
  evidence,
  passwordsPrinted: false
}, null, 2));
