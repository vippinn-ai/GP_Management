import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { assertLiveCredentials, assertStagingSupabaseEnvironment, parseEnvFile, sanitizeRunId, STAGING_PROJECT_REF } from "./playwright-staging-env.mjs";

const root = process.cwd();
const organizationId = "org-primary";
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);
const cleanupRunId = sanitizeRunId(env.E2E_RUN_ID);
const sourceRunId = sanitizeRunId(env.E2E_PAYMENT_MATRIX_SOURCE_RUN_ID);
const selectedCase = env.E2E_PAYMENT_MATRIX_CASE;
if (!["upi", "split", "partial_previous_dues"].includes(selectedCase) || cleanupRunId === sourceRunId) throw new Error("Cleanup postflight identity is invalid.");

const hash = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
};
const sortedRows = (value) => [...value].sort((left, right) => String(left.id).localeCompare(String(right.id))).map(stable);
const sameRows = (left, right) => JSON.stringify(sortedRows(left)) === JSON.stringify(sortedRows(right));
const assertNoSecrets = (value) => {
  const forbidden = [];
  const scan = (entry, currentPath) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) return entry.forEach((item, index) => scan(item, `${currentPath}[${index}]`));
    for (const [key, child] of Object.entries(entry)) {
      const childPath = `${currentPath}.${key}`;
      if (/^(authorization|apikey|password|access_token|refresh_token)$/i.test(key)) forbidden.push(childPath);
      scan(child, childPath);
    }
  };
  scan(value, "report");
  if (forbidden.length) throw new Error(`Refusing to persist sensitive cleanup postflight evidence: ${forbidden.join(", ")}`);
};

const recoveryPath = path.resolve(env.E2E_PAYMENT_MATRIX_RECOVERY_ARTIFACT ?? "");
const recoveryDirectory = path.resolve(root, "test-artifacts", "reconciliation");
if (path.dirname(recoveryPath) !== recoveryDirectory || path.basename(recoveryPath) !== `checkout-payment-matrix-reconciliation-${selectedCase}-${sourceRunId}.json`) {
  throw new Error("Cleanup postflight accepts only the exact reconciliation artifact.");
}
const recoveryRaw = fs.readFileSync(recoveryPath);
const recovery = JSON.parse(recoveryRaw.toString("utf8"));
if (hash(recoveryRaw) !== env.E2E_PAYMENT_MATRIX_RECOVERY_SHA256 || recovery.safeForIdentityBoundCleanup !== true ||
    recovery.runId !== sourceRunId || recovery.selectedCase !== selectedCase || recovery.status !== "partial" ||
    recovery.productionAllowed !== false || recovery.safeForAutomaticRetry !== false || recovery.integrityFailures?.length !== 0 ||
    recovery.outcomeClassification?.some((entry) => entry.outcome === "ambiguous")) throw new Error("Cleanup postflight lineage is invalid.");
const cleanupPath = path.join(root, "test-artifacts", "evidence", `checkout-payment-matrix-cleanup-${selectedCase}-final-${cleanupRunId}.json`);
const cleanupRaw = fs.readFileSync(cleanupPath);
const cleanup = JSON.parse(cleanupRaw.toString("utf8"));
if (cleanup.productionAllowed !== false || cleanup.safeForAutomaticRetry !== false || cleanup.sourceRunId !== sourceRunId ||
    cleanup.selectedCase !== selectedCase || cleanup.status !== "cleanup-confirmed" ||
    cleanup.recoverySha256 !== env.E2E_PAYMENT_MATRIX_RECOVERY_SHA256 || cleanup.actions.length !== recovery.snapshot.cleanupCandidates.length) {
  throw new Error("Cleanup browser evidence is invalid.");
}

const url = stagingEnv.VITE_SUPABASE_URL.trim();
if (new URL(url).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) throw new Error("Cleanup postflight is locked to staging.");
const supabase = createClient(url, stagingEnv.VITE_SUPABASE_ANON_KEY.trim(), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const lookup = await supabase.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve cleanup actor.");
const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate cleanup actor.");
if (cleanup.actorId !== login.data.user.id || recovery.actorId !== login.data.user.id) throw new Error("Cleanup actor lineage changed.");
const query = async (label, request) => { const result = await request; if (result.error) throw new Error(`${label}: ${result.error.message}`); return result.data ?? []; };
const candidateIds = recovery.snapshot.cleanupCandidates.map((row) => row.id);
const billIds = recovery.snapshot.bills.map((row) => row.id);
const cleanupEventIds = cleanup.actions.map((entry) => entry.eventId);
const cleanupAuditIds = cleanup.actions.map((entry) => entry.auditId);
const allEventIds = [...recovery.snapshot.events.map((entry) => entry.id), ...cleanupEventIds];
const allAuditIds = [...recovery.snapshot.audits.map((entry) => entry.id), ...cleanupAuditIds];
const runEntityIds = [...recovery.snapshot.sessions.map((entry) => entry.id), ...billIds];
const [sessions, bills, lines, payments, lineDiscounts, billDiscounts, movements, events, audits, runEvents, runAudits, openSessions, openTabs, appState, mutationStatuses] = await Promise.all([
  query("sessions", supabase.from("sessions").select("id,status,station_name_snapshot,customer_name,started_at,ended_at,closed_bill_id,close_disposition,close_reason,raw_data").eq("organization_id", organizationId).eq("customer_name", recovery.customerName)),
  query("bills", supabase.from("bills").select("id,bill_number,customer_name,status,payment_mode,subtotal,total_discount_amount,bill_discount_amount,round_off_enabled,round_off_amount,total,amount_paid,amount_due,issued_by_user_id,session_id,settled_at,settled_by_user_id,raw_data").eq("organization_id", organizationId).eq("customer_name", recovery.customerName)),
  billIds.length ? query("lines", supabase.from("bill_lines").select("id,bill_id,type,description,quantity,unit_price,subtotal,discount_amount,total,linked_session_id,inventory_item_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("payments", supabase.from("payments").select("id,bill_id,mode,amount,received_by_user_id,settlement_group_id,related_checkout_bill_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("line discounts", supabase.from("bill_line_discounts").select("id,bill_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("bill discounts", supabase.from("bill_discounts").select("id,bill_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("movements", supabase.from("stock_movements").select("id,item_id,related_bill_id,type,quantity,user_id").eq("organization_id", organizationId).in("related_bill_id", billIds)) : [],
  allEventIds.length ? query("events", supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("id", allEventIds)) : [],
  allAuditIds.length ? query("audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("id", allAuditIds)) : [],
  runEntityIds.length ? query("run events", supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata")
    .eq("organization_id", organizationId).in("event_type", ["financial_checkout_committed_v2", "reject_session"]).in("entity_id", runEntityIds)) : [],
  runEntityIds.length ? query("run audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id")
    .eq("organization_id", organizationId).in("action", ["bill_issued", "bill_pending", "bill_settled", "session_checkout_details_updated", "session_rejected"]).in("entity_id", runEntityIds)) : [],
  query("open sessions", supabase.from("sessions").select("id").eq("organization_id", organizationId).neq("status", "closed")),
  query("open tabs", supabase.from("customer_tabs").select("id").eq("organization_id", organizationId).eq("status", "open")),
  query("app_state", supabase.from("app_state").select("version,data").eq("id", "primary").single()),
  Promise.all(recovery.snapshot.mutationStatuses.map(async (expected) => {
    const result = await supabase.rpc("get_financial_mutation_result", { payload: { organization_id: organizationId, mutation_id: expected.mutation_id, mutation_kind: "commitCheckoutBill" } });
    if (result.error) throw new Error(`Canonical mutation ${expected.mutation_id}: ${result.error.message}`);
    return result.data;
  }))
]);

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const preservedSessions = recovery.snapshot.sessions.filter((entry) => !candidateIds.includes(entry.id));
check(sessions.length === recovery.snapshot.sessions.length, "The exact run session cardinality changed during cleanup.");
check(sameRows(sessions.filter((entry) => !candidateIds.includes(entry.id)), preservedSessions), "An already-closed session changed during cleanup.");
for (const action of cleanup.actions) {
  const candidate = sessions.find((entry) => entry.id === action.id);
  check(candidate?.status === "closed" && candidate.close_disposition === "rejected" && candidate.closed_bill_id === null &&
    candidate.customer_name === recovery.customerName && candidate.station_name_snapshot === action.stationName && candidate.close_reason === action.reason,
    `Cleanup session ${action.id} is not the exact rejected/unbilled row.`);
  const event = events.find((entry) => entry.id === action.eventId);
  const responseChangedRowsWithoutEvent = Object.fromEntries(Object.entries(action.response.changed_rows ?? {}).filter(([key]) => key !== "operational_events"));
  check(event?.event_type === "reject_session" && event.entity_type === "session" && event.entity_id === action.id && event.created_by === cleanup.actorId &&
    event.metadata?.mutation_id === action.mutationId && event.metadata?.mutation_kind === "rejectSession" &&
    JSON.stringify(stable(event.metadata?.changed_rows)) === JSON.stringify(stable(responseChangedRowsWithoutEvent)),
    `Cleanup event ${action.eventId} id/type/entity/actor/mutation/changed_rows is not exact.`);
  const audit = audits.find((entry) => entry.id === action.auditId);
  check(audit?.action === "session_rejected" && audit.entity_type === "session" && audit.entity_id === action.id && audit.user_id === cleanup.actorId &&
    audit.message === `Rejected ${action.stationName}. Reason: ${action.reason}`, `Cleanup audit ${action.auditId} identity/message/actor is not exact.`);
  check(action.response?.mutation_id === action.mutationId && action.response?.event_id === action.eventId &&
    action.response?.changed_rows?.sessions?.length === 1 && action.response.changed_rows.sessions[0] === action.id &&
    action.response?.changed_rows?.audit_logs?.length === 1 && action.response.changed_rows.audit_logs[0] === action.auditId,
    `Cleanup acknowledgement for ${action.id} is not exact.`);
}
check(sameRows(bills, recovery.snapshot.bills), "Committed bills changed during cleanup.");
check(sameRows(lines, recovery.snapshot.lines), "Committed bill lines changed during cleanup.");
check(sameRows(payments, recovery.snapshot.payments), "Committed payments changed during cleanup.");
check(sameRows(lineDiscounts, recovery.snapshot.lineDiscounts), "Committed line discounts changed during cleanup.");
check(sameRows(billDiscounts, recovery.snapshot.billDiscounts), "Committed bill discounts changed during cleanup.");
check(sameRows(movements, recovery.snapshot.movements), "Stock movements changed during cleanup.");
check(sameRows(events.filter((entry) => recovery.snapshot.events.some((expected) => expected.id === entry.id)), recovery.snapshot.events), "Pre-existing financial events changed during cleanup.");
check(sameRows(audits.filter((entry) => recovery.snapshot.audits.some((expected) => expected.id === entry.id)), recovery.snapshot.audits), "Pre-existing financial audits changed during cleanup.");
check(JSON.stringify(runEvents.map((entry) => entry.id).sort()) === JSON.stringify(allEventIds.sort()), "The run contains an extra or missing financial/cleanup event.");
check(JSON.stringify(runAudits.map((entry) => entry.id).sort()) === JSON.stringify(allAuditIds.sort()), "The run contains an extra or missing financial/cleanup audit.");
check(JSON.stringify(mutationStatuses.map(stable)) === JSON.stringify(recovery.snapshot.mutationStatuses.map(stable)), "Canonical financial mutation results changed during cleanup.");
check(openSessions.length === 0 && openTabs.length === 0, "The floor is not empty after cleanup.");
check(Number(appState.version) === Number(recovery.snapshot.appState.version) + candidateIds.length, "Compatibility version did not advance exactly once per rejection.");
check(Number(appState.version) === Number(cleanup.appStateAfter.version) && hash(JSON.stringify(appState.data)) === cleanup.appStateAfter.hash,
  "Postflight app_state version/hash differs from the browser-confirmed cleanup state.");
const sessionProjection = (appState.data?.sessions ?? []).filter((entry) => candidateIds.includes(entry.id)).map(stable);
check(JSON.stringify(sessionProjection) === JSON.stringify(cleanup.appStateAfter.sessionProjection), "Postflight app_state session content differs from the browser-confirmed cleanup state.");

const report = {
  cleanupRunId,
  sourceRunId,
  selectedCase,
  checkedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  status: failures.length ? "blocked" : "passed",
  failures,
  recoveryArtifact: path.relative(root, recoveryPath),
  recoverySha256: env.E2E_PAYMENT_MATRIX_RECOVERY_SHA256,
  cleanupArtifact: path.relative(root, cleanupPath),
  cleanupSha256: hash(cleanupRaw),
  snapshot: {
    sessions, bills, lines, payments, lineDiscounts, billDiscounts, movements, events, audits, runEvents, runAudits, mutationStatuses, openSessions, openTabs,
    appState: { version: appState.version, hash: hash(JSON.stringify(appState.data)), sessionProjection }
  }
};
assertNoSecrets(report);
const directory = path.join(root, "test-artifacts", "reconciliation");
fs.mkdirSync(directory, { recursive: true });
const target = path.join(directory, `checkout-payment-matrix-cleanup-postflight-${selectedCase}-${cleanupRunId}.json`);
const temporary = `${target}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
fs.renameSync(temporary, target);
console.log(JSON.stringify({ artifact: path.relative(root, target), status: report.status, failures }, null, 2));
if (failures.length) process.exitCode = 2;
