import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  assertLiveCredentials,
  assertStagingSupabaseEnvironment,
  parseEnvFile,
  sanitizeRunId,
  STAGING_PROJECT_REF
} from "./playwright-staging-env.mjs";

const root = process.cwd();
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };

assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);

function required(name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const runId = sanitizeRunId(required("E2E_RACE_RECONCILE_RUN_ID"));
const phase = required("E2E_RACE_RECONCILE_PHASE");
if (!new Set(["before-cleanup", "after-cleanup"]).has(phase)) {
  throw new Error("E2E_RACE_RECONCILE_PHASE must be before-cleanup or after-cleanup.");
}
const organizationId = "org-primary";
const customerName = `QA Checkout Settlement Race ${runId}`;
const station = "8 Ball Pool";
const setupSessionId = required("E2E_RACE_SETUP_SESSION_ID");
const activeSessionId = required("E2E_RACE_ACTIVE_SESSION_ID");
const settlementBillId = required("E2E_RACE_SETTLEMENT_BILL_ID");
const candidateBillId = required("E2E_RACE_CANDIDATE_BILL_ID");
const setupMutationId = required("E2E_RACE_SETUP_MUTATION_ID");
const checkoutMutationId = required("E2E_RACE_CHECKOUT_MUTATION_ID");
const adjustmentMutationId = required("E2E_RACE_ADJUSTMENT_MUTATION_ID");
const settlementPaymentId = required("E2E_RACE_SETTLEMENT_PAYMENT_ID");
const settlementAuditId = required("E2E_RACE_SETTLEMENT_AUDIT_ID");
const adjustmentEventId = required("E2E_RACE_ADJUSTMENT_EVENT_ID");
const retainedBillId = "bill-ea56ff7e-6233-46b0-8514-82cb7851e6f6";
const expectedAppStateVersion = Number(required("E2E_RACE_EXPECTED_APP_STATE_VERSION"));
const expectedAppStateHash = required("E2E_RACE_EXPECTED_APP_STATE_HASH");
if (!Number.isInteger(expectedAppStateVersion)) throw new Error("Expected app_state version must be an integer.");
const cleanupMutationId = phase === "after-cleanup" ? required("E2E_RACE_CLEANUP_MUTATION_ID") : null;
const cleanupEventId = phase === "after-cleanup" ? required("E2E_RACE_CLEANUP_EVENT_ID") : null;
const cleanupAuditId = phase === "after-cleanup" ? required("E2E_RACE_CLEANUP_AUDIT_ID") : null;
const cleanupReason = phase === "after-cleanup" ? required("E2E_RACE_CLEANUP_REASON") : null;

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey) throw new Error("Ignored staging Supabase configuration is incomplete.");
if (new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Checkout-settlement reconciliation is locked to staging.");
}
const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const lookup = await supabase.functions.invoke("resolve-login-email", {
  body: { username: env.E2E_USER_A.trim() }
});
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve the staging reconciliation account.");
const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate the staging reconciliation account.");
const role = await supabase.rpc("current_user_org_role", { target_organization_id: organizationId });
if (role.error || role.data !== "admin") throw new Error("Reconciliation requires an authoritative staging admin.");
const actorId = login.data.user.id;

const mutationStatuses = {};
for (const [label, mutationId, mutationKind] of [
  ["setup", setupMutationId, "commitCheckoutBill"],
  ["checkout", checkoutMutationId, "commitCheckoutBill"],
  ["adjustment", adjustmentMutationId, "settlePendingBills"]
]) {
  const status = await supabase.rpc("get_financial_mutation_result", {
    payload: { organization_id: organizationId, mutation_id: mutationId, mutation_kind: mutationKind }
  });
  if (status.error) throw new Error(`${label} mutation lookup failed: ${status.error.message}`);
  mutationStatuses[label] = status.data;
}

const financialMutationIds = [checkoutMutationId, adjustmentMutationId];
const [sessions, billLines, bills, candidateBills, payments, events, settlementAudits, suspiciousAudits, openSessions, openTabs, appState] = await Promise.all([
  supabase.from("sessions")
    .select("id,status,close_disposition,closed_bill_id,customer_name,station_name_snapshot,started_at,ended_at")
    .eq("organization_id", organizationId)
    .in("id", [setupSessionId, activeSessionId]),
  supabase.from("bill_lines")
    .select("id,bill_id,type,linked_session_id,total")
    .eq("organization_id", organizationId)
    .in("linked_session_id", [setupSessionId, activeSessionId]),
  supabase.from("bills")
    .select("id,bill_number,status,total,amount_paid,amount_due,settled_at,issued_by_user_id")
    .eq("organization_id", organizationId)
    .in("id", [settlementBillId, retainedBillId]),
  supabase.from("bills")
    .select("id,bill_number,status")
    .eq("organization_id", organizationId)
    .eq("id", candidateBillId),
  supabase.from("payments")
    .select("id,bill_id,amount,mode,received_by_user_id,related_checkout_bill_id")
    .eq("organization_id", organizationId)
    .in("bill_id", [settlementBillId, retainedBillId]),
  supabase.from("operational_events")
    .select("id,event_type,entity_id,metadata,created_by,created_at")
    .eq("organization_id", organizationId)
    .in("metadata->>mutation_id", financialMutationIds),
  supabase.from("audit_logs")
    .select("id,action,entity_id,message,user_id,audit_at")
    .eq("organization_id", organizationId)
    .eq("id", settlementAuditId),
  supabase.from("audit_logs")
    .select("id,action,entity_id,message,user_id,audit_at")
    .eq("organization_id", organizationId)
    .in("entity_id", [candidateBillId, activeSessionId])
    .in("action", ["bill_issued", "bill_settled", "session_checkout_details_updated"]),
  supabase.from("sessions")
    .select("id,status,customer_name,station_name_snapshot")
    .eq("organization_id", organizationId)
    .neq("status", "closed"),
  supabase.from("customer_tabs")
    .select("id,status,customer_name")
    .eq("organization_id", organizationId)
    .eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single()
]);
for (const [label, result] of Object.entries({
  sessions, billLines, bills, candidateBills, payments, events, settlementAudits,
  suspiciousAudits, openSessions, openTabs, appState
})) {
  if (result.error) throw new Error(`${label} reconciliation failed: ${result.error.message}`);
}

let cleanupEvents = { data: [], error: null };
let cleanupAudits = { data: [], error: null };
if (phase === "after-cleanup") {
  [cleanupEvents, cleanupAudits] = await Promise.all([
    supabase.from("operational_events")
      .select("id,event_type,entity_id,metadata,created_by,created_at")
      .eq("organization_id", organizationId)
      .eq("metadata->>mutation_id", cleanupMutationId),
    supabase.from("audit_logs")
      .select("id,action,entity_id,message,user_id,audit_at")
      .eq("organization_id", organizationId)
      .eq("id", cleanupAuditId)
  ]);
  if (cleanupEvents.error || cleanupAudits.error) throw new Error("Cleanup evidence query failed.");
}

const sessionById = new Map(sessions.data.map((row) => [row.id, row]));
const setupSession = sessionById.get(setupSessionId);
const activeSession = sessionById.get(activeSessionId);
assert(sessions.data.length === 2, "Both exact race sessions must exist.");
assert(setupSession?.status === "closed" && setupSession.close_disposition === "billed" && setupSession.closed_bill_id === settlementBillId, "Setup session terminal bill link is incorrect.");
assert(setupSession.customer_name === customerName && setupSession.station_name_snapshot === station, "Setup session identity changed.");
assert(activeSession?.customer_name === customerName && activeSession.station_name_snapshot === station, "Losing session identity changed.");
if (phase === "before-cleanup") {
  assert(activeSession.status === "active" && activeSession.close_disposition === null && activeSession.closed_bill_id === null, "Losing session is not uniquely active and unbilled.");
  assert(openSessions.data.length === 1 && openSessions.data[0].id === activeSessionId, "The race session is not the only open floor session.");
} else {
  assert(activeSession.status === "closed" && activeSession.close_disposition === "rejected" && activeSession.closed_bill_id === null, "Cleanup did not reject the exact losing session.");
  assert(openSessions.data.length === 0, "The session floor is not empty after cleanup.");
}
assert(openTabs.data.length === 0, "Open customer tabs remain.");

const settlementBill = bills.data.find((row) => row.id === settlementBillId);
const retainedBill = bills.data.find((row) => row.id === retainedBillId);
assert(bills.data.length === 2, "Settlement and retained bills must both exist.");
assert(settlementBill?.status === "issued" && Number(settlementBill.total) === 30 && Number(settlementBill.amount_paid) === 30 && Number(settlementBill.amount_due) === 0 && settlementBill.settled_at, "Settlement bill totals/status are incorrect.");
assert(settlementBill.issued_by_user_id === actorId, "Settlement bill actor changed.");
assert(retainedBill?.bill_number === "BILL-20260827-001" && retainedBill.status === "pending" && Number(retainedBill.total) === 45 && Number(retainedBill.amount_paid) === 0 && Number(retainedBill.amount_due) === 45, "Retained bill changed.");
assert(candidateBills.data.length === 0, "The losing checkout candidate bill exists.");

const settlementPayments = payments.data.filter((row) => row.bill_id === settlementBillId);
const retainedPayments = payments.data.filter((row) => row.bill_id === retainedBillId);
assert(settlementPayments.length === 1 && settlementPayments[0].id === settlementPaymentId && Number(settlementPayments[0].amount) === 30 && settlementPayments[0].mode === "cash", "Settlement payment is not exact.");
assert(settlementPayments[0].received_by_user_id === actorId && settlementPayments[0].related_checkout_bill_id === null, "Settlement payment attribution/link is incorrect.");
assert(retainedPayments.length === 0, "Retained bill gained a payment.");
assert(settlementAudits.data.length === 1 && settlementAudits.data[0].action === "bill_settled" && settlementAudits.data[0].entity_id === settlementBillId && settlementAudits.data[0].user_id === actorId, "Settlement audit is not exact.");
assert(settlementAudits.data[0].message === `Settled Rs 30.00 on ${settlementBill.bill_number}. Remaining due: Rs 0.00.`, "Settlement audit message is not exact.");
assert(suspiciousAudits.data.length === 0, "The losing checkout left a checkout audit.");

const setupLines = billLines.data.filter((row) => row.linked_session_id === setupSessionId);
const activeLines = billLines.data.filter((row) => row.linked_session_id === activeSessionId);
assert(setupLines.length === 1 && setupLines[0].bill_id === settlementBillId && setupLines[0].type === "session_charge" && Number(setupLines[0].total) === 30, "Setup bill line is not exact.");
assert(activeLines.length === 0, "The losing session gained a bill line.");

assert(mutationStatuses.setup?.bill_id === settlementBillId, "Setup mutation result changed.");
assert(mutationStatuses.checkout === null, "Losing checkout mutation unexpectedly committed.");
const adjustmentResult = mutationStatuses.adjustment;
assert(adjustmentResult?.mutation_id === adjustmentMutationId && adjustmentResult.entity_id === settlementBillId && adjustmentResult.event_id === adjustmentEventId, "Adjustment canonical identity is incorrect.");
assert(JSON.stringify([...(adjustmentResult.changed_rows?.bills ?? [])].sort()) === JSON.stringify([settlementBillId]), "Adjustment canonical bill changes are incorrect.");
assert(JSON.stringify([...(adjustmentResult.changed_rows?.payments ?? [])].sort()) === JSON.stringify([settlementPaymentId]), "Adjustment canonical payment changes are incorrect.");
assert(JSON.stringify([...(adjustmentResult.changed_rows?.audit_logs ?? [])].sort()) === JSON.stringify([settlementAuditId]), "Adjustment canonical audit changes are incorrect.");
assert(events.data.length === 1 && events.data[0].id === adjustmentEventId && events.data[0].event_type === "financial_adjustment_committed_v2" && events.data[0].entity_id === settlementBillId && events.data[0].created_by === actorId && events.data[0].metadata?.mutation_id === adjustmentMutationId, "Financial race events are not exact.");

if (phase === "after-cleanup") {
  assert(cleanupEvents.data.length === 1 && cleanupEvents.data[0].id === cleanupEventId && cleanupEvents.data[0].event_type === "reject_session" && cleanupEvents.data[0].entity_id === activeSessionId && cleanupEvents.data[0].created_by === actorId && cleanupEvents.data[0].metadata?.mutation_id === cleanupMutationId && Number(cleanupEvents.data[0].metadata?.app_state_version) === expectedAppStateVersion, "Cleanup event is not exact.");
  assert(cleanupAudits.data.length === 1 && cleanupAudits.data[0].action === "session_rejected" && cleanupAudits.data[0].entity_id === activeSessionId && cleanupAudits.data[0].user_id === actorId && cleanupAudits.data[0].message === `Rejected ${station}. Reason: ${cleanupReason}`, "Cleanup audit is not exact.");
}

const appStateHash = createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex");
assert(appState.data.version === expectedAppStateVersion && appStateHash === expectedAppStateHash, "app_state differs from the expected phase baseline.");

const evidence = {
  runId,
  phase,
  reconciledAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  organizationId,
  actorId,
  mutationStatuses,
  sessions: sessions.data,
  billLines: billLines.data,
  bills: bills.data,
  candidateBills: candidateBills.data,
  payments: payments.data,
  events: events.data,
  settlementAudits: settlementAudits.data,
  suspiciousAudits: suspiciousAudits.data,
  cleanupEvents: cleanupEvents.data,
  cleanupAudits: cleanupAudits.data,
  openSessions: openSessions.data,
  openTabs: openTabs.data,
  appState: { version: appState.data.version, hash: appStateHash }
};
const artifactDirectory = path.join(root, "test-artifacts", "reconciliation");
fs.mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = path.join(artifactDirectory, `checkout-settlement-race-${phase}-${runId}.json`);
if (fs.existsSync(artifactPath)) throw new Error("Refusing to overwrite an existing checkout-settlement reconciliation artifact.");
fs.writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: "passed", artifact: path.relative(root, artifactPath), evidence }, null, 2));
