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

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing.`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function rows(result, label) {
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  return result.data ?? [];
}

function hash(data) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

const sourceRunId = sanitizeRunId(required("E2E_REPEAT_COMBO_RECOVERY_RUN_ID"));
const cleanupRunId = sanitizeRunId(required("E2E_REPEAT_COMBO_CLEANUP_RUN_ID"));
assert(sourceRunId !== cleanupRunId, "Source and cleanup run IDs must be different.");

const organizationId = "org-primary";
const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-repeat-combo-race-preflight-${sourceRunId}.json`);
const recoveryPath = path.join(root, "test-artifacts", "reconciliation", `checkout-repeat-combo-race-recovery-v2-${sourceRunId}.json`);
const summaryPath = path.join(root, "test-artifacts", "playwright", `summary-${cleanupRunId}.json`);
const outputPath = path.join(
  root,
  "test-artifacts",
  "reconciliation",
  `checkout-repeat-combo-race-cleanup-postflight-${sourceRunId}-${cleanupRunId}.json`
);
if (fs.existsSync(outputPath)) throw new Error("Exact combo-race cleanup postflight already exists; refusing overwrite.");

const preflight = readJson(preflightPath, "Exact combo-race preflight");
const recovery = readJson(recoveryPath, "Exact pre-cleanup recovery evidence");
const cleanupSummary = readJson(summaryPath, "Exact cleanup Playwright summary");
assert(preflight.safeToRun && preflight.runId === sourceRunId && preflight.projectRef === STAGING_PROJECT_REF, "Preflight identity is invalid.");
assert(recovery.safeForIdentityBoundCleanup && recovery.runId === sourceRunId && recovery.projectRef === STAGING_PROJECT_REF, "Recovery evidence did not authorize cleanup.");
assert(cleanupSummary.runId === cleanupRunId && cleanupSummary.status === "passed", "Cleanup summary is not a passing exact run.");
assert(cleanupSummary.tests?.length === 1 && cleanupSummary.tests[0].status === "passed" && cleanupSummary.tests[0].retry === 0, "Cleanup was not one passing zero-retry test.");

const evidenceAttachment = cleanupSummary.tests[0].attachments?.find((entry) => entry.name === "checkout-settlement-adjustment-winner-cleanup");
assert(evidenceAttachment?.path, "Cleanup evidence attachment is missing.");
const cleanup = readJson(path.resolve(root, evidenceAttachment.path), "Cleanup evidence attachment");
const rejection = cleanup.rejection;
assert(cleanup.cleanupRunId === cleanupRunId && cleanup.sourceRunId === sourceRunId, "Cleanup attachment run identity is invalid.");
assert(cleanup.sessionId === recovery.session.id && cleanup.actorId === recovery.actorId, "Cleanup attachment session or actor differs from authorized recovery evidence.");
assert(rejection?.rpc === "reject_session" && rejection.status === 200 && rejection.entityId === recovery.session.id, "Cleanup attachment does not contain the exact successful rejection.");
assert(rejection.mutationId && rejection.eventId, "Cleanup mutation/event identity is incomplete.");
assert(rejection.changedRows?.sessions?.length === 1 && rejection.changedRows.sessions[0] === recovery.session.id, "Cleanup changed an unexpected session set.");
assert(rejection.changedRows?.audit_logs?.length === 1, "Cleanup did not report exactly one audit row.");
assert(cleanup.appStateBefore?.version === recovery.appState.version && cleanup.appStateBefore?.hash === recovery.appState.hash, "Cleanup started from a different app_state baseline.");
assert(cleanup.appStateAfter?.version === recovery.appState.version + 1, "Cleanup app_state version did not increment exactly once.");

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const anonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !anonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Cleanup postflight is locked to staging.");
}
const supabase = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const lookup = await supabase.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve cleanup reconciliation account.");
const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate cleanup reconciliation account.");
const role = await supabase.rpc("current_user_org_role", { target_organization_id: organizationId });
if (role.error || role.data !== "admin") throw new Error("Cleanup reconciliation requires an authoritative staging admin.");
assert(login.data.user.id === cleanup.actorId, "Authenticated reconciliation actor differs from the cleanup actor.");

const sessionId = recovery.session.id;
const stockItemIds = preflight.fixture.stockEvidence.map((entry) => entry.itemId);
const initialMovementIds = recovery.movements.map((entry) => entry.id);
const cleanupStartedAt = cleanupSummary.startedAt;
const cleanupFinishedAt = cleanupSummary.finishedAt;
const [sessionResult, openSessionsResult, openTabsResult, appStateResult, inventoryResult, eventsResult, auditsResult,
  combosResult, itemsResult, linesResult, runBillsResult, initialMovementsResult, cleanupWindowMovementsResult] = await Promise.all([
  supabase.from("sessions").select("id,status,close_disposition,close_reason,closed_bill_id,customer_name,station_name_snapshot,ended_at").eq("organization_id", organizationId).eq("id", sessionId),
  supabase.from("sessions").select("id,status,customer_name").eq("organization_id", organizationId).neq("status", "closed"),
  supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single(),
  supabase.from("inventory_items").select("id,stock_qty").eq("organization_id", organizationId).in("id", stockItemIds),
  supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,created_at,metadata").eq("organization_id", organizationId).eq("entity_id", sessionId).gte("created_at", preflight.checkedAt).order("created_at"),
  supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,audit_at,user_id,created_at").eq("organization_id", organizationId).eq("entity_id", sessionId).gte("created_at", preflight.checkedAt).order("created_at"),
  supabase.from("session_combo_applications").select("id,session_id,combo_id,combo_name,price,included_minutes").eq("organization_id", organizationId).eq("session_id", sessionId),
  supabase.from("session_items").select("id,session_id,inventory_item_id,name,quantity,unit_price,combo_application_id,combo_id").eq("organization_id", organizationId).eq("session_id", sessionId),
  supabase.from("bill_lines").select("id,bill_id,type,linked_session_id,inventory_item_id,total,raw_data").eq("organization_id", organizationId).eq("linked_session_id", sessionId),
  supabase.from("bills").select("id,bill_number,status,total,amount_paid,amount_due").eq("organization_id", organizationId).in("bill_number", ["checkout_first", "combo_first", "simultaneous"].map((scenario) => `BILL-QA-COMBO-RACE-${sourceRunId}-${scenario}`)),
  supabase.from("stock_movements").select("id,item_id,type,quantity,reason,user_id,related_bill_id,created_at").eq("organization_id", organizationId).in("id", initialMovementIds),
  supabase.from("stock_movements").select("id,item_id,type,quantity,reason,user_id,related_bill_id,created_at").eq("organization_id", organizationId).in("item_id", stockItemIds).gte("created_at", cleanupStartedAt).lte("created_at", cleanupFinishedAt)
]);

const sessions = rows(sessionResult, "session");
const openSessions = rows(openSessionsResult, "open sessions");
const openTabs = rows(openTabsResult, "open tabs");
const inventory = rows(inventoryResult, "inventory");
const events = rows(eventsResult, "events");
const audits = rows(auditsResult, "audits");
const combos = rows(combosResult, "session combos");
const items = rows(itemsResult, "session items");
const billLines = rows(linesResult, "bill lines");
const runBills = rows(runBillsResult, "run bills");
const initialMovements = rows(initialMovementsResult, "initial reservation movements");
const cleanupWindowMovements = rows(cleanupWindowMovementsResult, "cleanup-window stock movements");
if (appStateResult.error) throw new Error(`app_state query failed: ${appStateResult.error.message}`);

assert(sessions.length === 1, "Exact cleanup session is missing or duplicated.");
const session = sessions[0];
assert(session.status === "closed" && session.close_disposition === "rejected" && session.closed_bill_id === null, "Exact cleanup session is not closed/rejected/unbilled.");
assert(session.customer_name === cleanup.customerName && session.station_name_snapshot === cleanup.station && session.close_reason === cleanup.reason, "Cleanup session identity or reason changed.");
assert(openSessions.length === 0 && openTabs.length === 0, "The staging floor is not empty after cleanup.");

assert(events.length === recovery.events.length + 1, "Session operational event chain length is not exact.");
assert(recovery.events.every((expected, index) => events[index]?.id === expected.id && events[index]?.event_type === expected.event_type), "Cleanup changed the pre-authorized operational event chain.");
const rejectEvent = events.at(-1);
assert(rejectEvent?.event_type === "reject_session", "The final operational event is not reject_session.");
assert(rejectEvent.id === rejection.eventId && rejectEvent.entity_type === "session" && rejectEvent.entity_id === sessionId && rejectEvent.created_by === cleanup.actorId, "Reject event identity or actor is incorrect.");
assert(rejectEvent.metadata?.mutation_id === rejection.mutationId && rejectEvent.metadata?.mutation_kind === "rejectSession", "Reject event mutation identity is incorrect.");
assert(Number(rejectEvent.metadata?.app_state_version) === cleanup.appStateAfter.version, "Reject event app_state version is incorrect.");
assert(events.every((entry) => entry.event_type !== "financial_checkout_committed_v2"), "The failed race or cleanup left a financial checkout event.");

assert(audits.length === recovery.audits.length + 1, "Session audit chain length is not exact.");
assert(recovery.audits.every((expected, index) => audits[index]?.id === expected.id && audits[index]?.action === expected.action), "Cleanup changed the pre-authorized audit chain.");
const rejectAudit = audits.at(-1);
assert(rejectAudit?.action === "session_rejected", "The final audit is not session_rejected.");
assert(rejectAudit.id === rejection.changedRows.audit_logs[0] && rejectAudit.entity_type === "session" && rejectAudit.entity_id === sessionId && rejectAudit.user_id === cleanup.actorId, "Reject audit identity or actor is incorrect.");
assert(rejectAudit.message === `Rejected ${cleanup.station}. Reason: ${cleanup.reason}`, "Reject audit message is not exact.");

assert(combos.length === recovery.combos.length && items.length === recovery.items.length, "Cleanup changed the persisted session combo/item snapshot.");
assert(recovery.combos.every((expected) => combos.some((entry) => JSON.stringify(entry) === JSON.stringify({
  id: expected.id,
  session_id: expected.session_id,
  combo_id: expected.combo_id,
  combo_name: expected.combo_name,
  price: expected.price,
  included_minutes: expected.included_minutes
}))), "Cleanup changed an authorized combo snapshot.");
assert(recovery.items.every((expected) => items.some((entry) => JSON.stringify(entry) === JSON.stringify({
  id: expected.id,
  session_id: expected.session_id,
  inventory_item_id: expected.inventory_item_id,
  name: expected.name,
  quantity: expected.quantity,
  unit_price: expected.unit_price,
  combo_application_id: expected.combo_application_id,
  combo_id: expected.combo_id
}))), "Cleanup changed an authorized session-item snapshot.");
assert(runBills.length === 0 && billLines.length === 0, "The failed race or cleanup created a bill or bill line.");
assert(initialMovements.length === initialMovementIds.length && new Set(initialMovements.map((entry) => entry.id)).size === initialMovementIds.length, "Initial reservation movement evidence changed.");
assert(initialMovements.every((entry) => entry.type === "session_reservation" && Number(entry.quantity) < 0 && entry.user_id === cleanup.actorId && entry.related_bill_id === null), "Initial reservation movements changed identity or attribution.");
assert(cleanupWindowMovements.length === 0, "Cleanup unexpectedly wrote stock movements; deployed reject_session does not include them in its transaction contract.");

const inventoryUnchanged = recovery.inventory.every((before) => {
  const current = inventory.find((entry) => entry.id === before.id);
  return current && Number(current.stock_qty) === Number(before.stock_qty);
});
assert(inventoryUnchanged, "Physical inventory quantities differ from the authorized recovery baseline.");
const currentAppState = { version: appStateResult.data.version, hash: hash(appStateResult.data.data) };
assert(currentAppState.version === cleanup.appStateAfter.version && currentAppState.hash === cleanup.appStateAfter.hash, "Current app_state differs from the exact post-cleanup Playwright result.");

const evidence = {
  sourceRunId,
  scenario: recovery.scenario,
  cleanupRunId,
  reconciledAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  organizationId,
  actorId: cleanup.actorId,
  cleanupExecution: {
    startedAt: cleanupStartedAt,
    finishedAt: cleanupFinishedAt,
    retry: cleanupSummary.tests[0].retry,
    mutationId: rejection.mutationId,
    eventId: rejection.eventId,
    auditId: rejection.changedRows.audit_logs[0],
    reason: cleanup.reason
  },
  session,
  events,
  audits,
  combos,
  items,
  runBills,
  billLines,
  initialMovements,
  cleanupWindowMovements,
  inventory,
  openSessions,
  openTabs,
  appState: currentAppState,
  result: {
    exactSessionRejected: true,
    emptyFloor: true,
    noFinancialEffect: true,
    physicalInventoryUnchanged: true,
    noCleanupStockMovementExpectedByRejectRpc: true,
    passed: true
  }
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ status: "passed", artifact: path.relative(root, outputPath), result: evidence.result }, null, 2));
