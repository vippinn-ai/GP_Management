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
import { loadSessionItemRaceAdmin } from "./session-item-race-admin-env.mjs";

const root = process.cwd();
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const requestedCleanupKind = process.env.E2E_CLEANUP_RACE_KIND ?? "replacement";
if (requestedCleanupKind !== "replacement" && requestedCleanupKind !== "refund" && requestedCleanupKind !== "void") {
  throw new Error("E2E_CLEANUP_RACE_KIND must be exactly replacement, refund, or void.");
}
const temporaryAdmin = requestedCleanupKind === "void" ? loadSessionItemRaceAdmin(root, { required: true }) : null;
const env = { ...localEnv, ...process.env, ...(temporaryAdmin?.overlay ?? {}) };
assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);
const cleanupKind = requestedCleanupKind;
const isRefundCleanup = cleanupKind === "refund";
const isVoidCleanup = cleanupKind === "void";
const isDispositionCleanup = isRefundCleanup || isVoidCleanup;
const cleanupRunId = sanitizeRunId(
  (isDispositionCleanup ? env.E2E_DISPOSITION_RACE_CLEANUP_RUN_ID || env.E2E_REFUND_RACE_CLEANUP_RUN_ID : env.E2E_REPLACEMENT_RACE_CLEANUP_RUN_ID) || env.E2E_RUN_ID
);
const artifactPrefix = isDispositionCleanup ? `checkout-${cleanupKind}-race-cleanup` : "checkout-replacement-race-cleanup";
const evidencePath = path.join(root, "test-artifacts", "evidence", `${artifactPrefix}-final-${cleanupRunId}.json`);
if (!fs.existsSync(evidencePath)) throw new Error(`Immutable ${cleanupKind}-race cleanup evidence is missing.`);
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
if (evidence.cleanupRunId !== cleanupRunId ||
    (isVoidCleanup ? evidence.cleanupKind !== "void" : evidence.cleanupKind && evidence.cleanupKind !== cleanupKind)) {
  throw new Error("Cleanup evidence identity or disposition mismatch.");
}
const recoveryPath = path.resolve(root, evidence.recoveryArtifact);
const recoveryBytes = fs.readFileSync(recoveryPath);
const recoverySha256 = createHash("sha256").update(recoveryBytes).digest("hex");
const recovery = JSON.parse(recoveryBytes.toString("utf8"));
if (recovery.runId !== evidence.fixtureRunId || recovery.safeForIdentityBoundCleanup !== true ||
    recovery.productionAllowed !== false || recovery.safeForAutomaticRetry !== false ||
    (isVoidCleanup && recovery.disposition !== "void") ||
    (isDispositionCleanup && recovery.disposition && recovery.disposition !== cleanupKind) ||
    (isDispositionCleanup && evidence.recoverySha256 && recoverySha256 !== evidence.recoverySha256)) {
  throw new Error("Cleanup recovery authority changed.");
}
const organizationId = "org-primary";
const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Cleanup postflight is locked to staging.");
}
async function authenticate(slot) {
  const client = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const lookup = await client.functions.invoke("resolve-login-email", { body: { username: env[`E2E_USER_${slot}`].trim() } });
  if (lookup.error || !lookup.data?.email) throw new Error(`Unable to resolve staging slot ${slot}.`);
  const login = await client.auth.signInWithPassword({ email: lookup.data.email, password: env[`E2E_PASSWORD_${slot}`] });
  if (login.error || !login.data.user) throw new Error(`Unable to authenticate staging slot ${slot}.`);
  const role = await client.rpc("current_user_org_role", { target_organization_id: organizationId });
  if (role.error || role.data !== "admin") throw new Error(`Staging slot ${slot} is not an admin.`);
  return { client, actorId: login.data.user.id };
}
const origin = await authenticate("A");
const observer = await authenticate("B");
if (origin.actorId !== evidence.actors.origin || observer.actorId !== evidence.actors.observer) {
  throw new Error("Current staging actors do not match cleanup evidence actors.");
}
const supabase = origin.client;
const eventIds = evidence.cleanupResults.map((entry) => entry.result.event_id);
const auditIds = evidence.cleanupResults.flatMap((entry) => entry.result.changed_rows?.audit_logs ?? []);
const priorEventIds = evidence.before.events.map((entry) => entry.id);
const priorAuditIds = evidence.before.audits.map((entry) => entry.id);
const dispositionLabel = isVoidCleanup ? "Void" : "Refund";
const billNumbers = isDispositionCleanup
  ? ["ORIGINAL", "CHECKOUT"].map((suffix) => `BILL-QA-${dispositionLabel.toUpperCase()}-RACE-${evidence.fixtureRunId}-${suffix}`)
  : ["ORIGINAL", "CHECKOUT", "REPLACEMENT"].map((suffix) => `BILL-QA-REPLACE-RACE-${evidence.fixtureRunId}-${suffix}`);
const customerNames = isDispositionCleanup
  ? [`QA ${dispositionLabel} Source ${evidence.fixtureRunId}`, `QA ${dispositionLabel} Checkout ${evidence.fixtureRunId}`]
  : [`QA Replacement Source ${evidence.fixtureRunId}`, `QA Replacement Checkout ${evidence.fixtureRunId}`];
const [items, bills, tabs, tabItems, movements, lines, payments, events, audits, priorEvents, priorAudits, mutationStatuses, openSessions, openTabs, appState] = await Promise.all([
  supabase.from("inventory_items").select("id,name,stock_qty,active,archived_by_user_id,archive_reason").eq("organization_id", organizationId).eq("id", evidence.itemId),
  supabase.from("bills").select("id,bill_number,status,total,amount_paid,amount_due,replacement_of_bill_id,replaced_by_bill_id,replace_reason,replaced_by_user_id,void_reason,voided_at,voided_by_user_id,issued_by_user_id").eq("organization_id", organizationId).in("bill_number", billNumbers),
  supabase.from("customer_tabs").select("id,customer_name,status,close_disposition,closed_bill_id,close_reason").eq("organization_id", organizationId).in("customer_name", customerNames),
  supabase.from("customer_tab_items").select("id,customer_tab_id,inventory_item_id,quantity,unit_price").eq("organization_id", organizationId).eq("inventory_item_id", evidence.itemId),
  supabase.from("stock_movements").select("id,item_id,type,quantity,related_bill_id,user_id").eq("organization_id", organizationId).eq("item_id", evidence.itemId),
  supabase.from("bill_lines").select("id,bill_id,type,inventory_item_id,quantity,unit_price,total").eq("organization_id", organizationId).in("bill_id", evidence.before.bills.length ? evidence.before.bills.map((row) => row.id) : ["missing-bill"]),
  supabase.from("payments").select("id,bill_id,mode,amount,received_by_user_id").eq("organization_id", organizationId).in("bill_id", evidence.before.bills.length ? evidence.before.bills.map((row) => row.id) : ["missing-bill"]),
  supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("id", eventIds.length ? eventIds : ["missing-cleanup-event"]),
  supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("id", auditIds.length ? auditIds : ["missing-cleanup-audit"]),
  supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("id", priorEventIds.length ? priorEventIds : ["missing-prior-event"]),
  supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("id", priorAuditIds.length ? priorAuditIds : ["missing-prior-audit"]),
  Promise.all((recovery.mutationIds ?? []).map(async (mutationId, index) => {
    const mutationActor = recovery.mutationActors?.[index] ?? recovery.actors.origin;
    const mutationClient = mutationActor === recovery.actors.observer ? observer.client : origin.client;
    const result = await mutationClient.rpc("get_financial_mutation_result", {
      payload: {
        organization_id: organizationId,
        mutation_id: mutationId,
        mutation_kind: recovery.mutationKinds?.[index] ?? "commitCheckoutBill"
      }
    });
    if (result.error) throw new Error(`Cleanup mutation lookup failed: ${result.error.message}`);
    return result.data;
  })),
  supabase.from("sessions").select("id,status,customer_name").eq("organization_id", organizationId).neq("status", "closed"),
  supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single()
]);
for (const [label, result] of Object.entries({ items, bills, tabs, tabItems, movements, lines, payments, events, audits, priorEvents, priorAudits, openSessions, openTabs, appState })) {
  if (result.error) throw new Error(`${label} cleanup postflight failed: ${result.error.message}`);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function exact(actual, expected, message) {
  if (JSON.stringify(stable(actual)) !== JSON.stringify(stable(expected))) throw new Error(message);
}
function sortRows(rows, key = "id") {
  return [...rows].sort((left, right) => String(left[key] ?? "").localeCompare(String(right[key] ?? "")));
}
exact(sortRows(bills.data, "bill_number"), sortRows(evidence.before.bills, "bill_number"), "Cleanup changed committed bills.");
exact(sortRows(tabItems.data), sortRows(evidence.before.tabItems), "Cleanup changed reservation source rows.");
exact(sortRows(movements.data), sortRows(evidence.before.movements), "Cleanup created or changed stock movements.");
exact(sortRows(lines.data), sortRows(evidence.before.lines), "Cleanup changed bill-line rows.");
exact(sortRows(payments.data), sortRows(evidence.before.payments), "Cleanup changed payment rows.");
exact(sortRows(priorEvents.data), sortRows(evidence.before.events), "Cleanup changed prior operational events.");
exact(sortRows(priorAudits.data), sortRows(evidence.before.audits), "Cleanup changed prior audit rows.");
exact(mutationStatuses, evidence.before.mutationStatuses, "Cleanup changed financial mutation results.");
exact(items.data, evidence.after.items, "Cleanup item state changed after acknowledgement.");
exact(sortRows(tabs.data), sortRows(evidence.after.tabs), "Cleanup tab state changed after acknowledgement.");
if (openSessions.data.length !== 0 || openTabs.data.length !== 0) throw new Error("The staging floor is not empty after cleanup.");
if (items.data.length !== 1 || items.data[0].active !== false || items.data[0].archived_by_user_id !== origin.actorId) {
  throw new Error("The exact fixture was not archived by the cleanup actor.");
}
for (const before of evidence.before.tabs) {
  const after = tabs.data.find((row) => row.id === before.id);
  if (!after) throw new Error(`Cleanup lost exact tab ${before.id}.`);
  if (before.status === "open") {
    if (after.status !== "closed" || after.close_disposition !== "rejected" || after.closed_bill_id !== null) throw new Error(`Open QA tab ${before.id} was not exactly rejected.`);
  } else {
    exact(after, before, `Cleanup changed already-terminal tab ${before.id}.`);
  }
}
if (events.data.length !== eventIds.length || audits.data.length !== auditIds.length) throw new Error("Cleanup event/audit cardinality is incorrect.");
const cleanupReason = `Identity-bound ${cleanupKind}-race cleanup ${cleanupRunId}`;
for (const cleanup of evidence.cleanupResults) {
  const result = cleanup.result;
  const event = events.data.find((row) => row.id === result.event_id);
  const isArchive = cleanup.operation === "archive_inventory_item";
  const expectedEventType = isArchive ? "admin_data_committed" : "reject_customer_tab";
  if (!event || event.event_type !== expectedEventType || event.entity_type !== result.entity_type || event.entity_id !== result.entity_id || event.created_by !== origin.actorId) {
    throw new Error(`Cleanup event identity/type/actor is incorrect for ${cleanup.entityId}.`);
  }
  const expectedEventChangedRows = { ...result.changed_rows };
  delete expectedEventChangedRows.operational_events;
  exact(event.metadata.changed_rows, expectedEventChangedRows, `Cleanup event changed_rows mismatch for ${cleanup.entityId}.`);
  if (!isArchive) exact(result.changed_rows.operational_events, [result.event_id], `Cleanup result event self-reference is incorrect for ${cleanup.entityId}.`);
  if (!isArchive) {
    exact(event.metadata.released_continued_from_session_ids ?? [], [], `Cleanup unexpectedly released prior-game continuations for ${cleanup.entityId}.`);
  }
  const expectedAction = isArchive ? "inventory_archived" : "customer_tab_rejected";
  const expectedEntityType = isArchive ? "inventory_item" : "customer_tab";
  const cleanupAuditIds = result.changed_rows?.audit_logs ?? [];
  if (cleanupAuditIds.length !== 1) throw new Error(`Cleanup audit cardinality is not exactly one for ${cleanup.entityId}.`);
  const customerName = evidence.before.tabs.find((row) => row.id === cleanup.entityId)?.customer_name;
  const expectedMessage = isArchive
    ? `Archived ${evidence.before.items[0].name}. Reason: ${cleanupReason}.`
    : `Rejected customer tab for ${customerName}. Reason: ${cleanupReason}`;
  for (const auditId of cleanupAuditIds) {
    const audit = audits.data.find((row) => row.id === auditId);
    if (!audit || audit.action !== expectedAction || audit.entity_type !== expectedEntityType || audit.entity_id !== cleanup.entityId || audit.user_id !== origin.actorId || audit.message !== expectedMessage) {
      throw new Error(`Cleanup audit identity/type/message/actor is incorrect for ${cleanup.entityId}.`);
    }
  }
}
const stateHash = createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex");
exact(
  { version: appState.data.version, hash: stateHash },
  { version: evidence.after.appState.version, hash: evidence.after.appState.hash },
  "Cleanup app_state changed after acknowledgement."
);
if (appState.data.version !== evidence.before.appState.version + evidence.cleanupResults.length) {
  throw new Error("Cleanup app_state version did not advance exactly once per acknowledged cleanup command.");
}
const compatibilityItem = appState.data.data.inventoryItems?.find((item) => item.id === evidence.itemId);
if (!compatibilityItem || compatibilityItem.active !== false || Number(compatibilityItem.stockQty) !== Number(items.data[0].stock_qty)) {
  throw new Error("Cleanup compatibility item does not match normalized state.");
}
exact(compatibilityItem, evidence.after.appState.compatibilityItem, "Cleanup compatibility item changed after acknowledgement.");
const compatibilityTabs = (appState.data.data.customerTabs ?? [])
  .filter((tab) => tabs.data.some((row) => row.id === tab.id))
  .map((tab) => ({
    id: tab.id,
    customer_name: tab.customerName,
    status: tab.status,
    close_disposition: tab.closeDisposition ?? null,
    closed_bill_id: tab.closedBillId ?? null,
    close_reason: tab.closeReason ?? null
  }));
exact(sortRows(compatibilityTabs), sortRows(tabs.data), "Cleanup compatibility customer tabs do not match normalized terminal states.");
exact(sortRows(compatibilityTabs), sortRows(evidence.after.appState.compatibilityTabs), "Cleanup compatibility customer tabs changed after acknowledgement.");
const output = {
  cleanupKind,
  cleanupRunId,
  fixtureRunId: evidence.fixtureRunId,
  reconciledAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  actors: evidence.actors,
  cleanupResults: evidence.cleanupResults,
  items: items.data,
  bills: bills.data,
  tabs: tabs.data,
  tabItems: tabItems.data,
  movements: movements.data,
  lines: lines.data,
  payments: payments.data,
  priorEvents: priorEvents.data,
  priorAudits: priorAudits.data,
  mutationStatuses,
  events: events.data,
  audits: audits.data,
  appState: { version: appState.data.version, hash: stateHash, compatibilityItem, compatibilityTabs },
  checks: {
    exactTabsClosed: true,
    committedBillsPreserved: true,
    reservationsReleased: true,
    fixtureArchived: true,
    noCleanupStockMovement: true,
    cleanupActorsExact: true,
    cleanupEventTypesAndAuditMessagesExact: true,
    compatibilityTabsExact: true,
    floorEmpty: true
  }
};
const directory = path.join(root, "test-artifacts", "reconciliation");
fs.mkdirSync(directory, { recursive: true });
const artifactPath = path.join(directory, `${artifactPrefix}-postflight-${cleanupRunId}.json`);
fs.writeFileSync(artifactPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ status: "passed", artifact: path.relative(root, artifactPath), output }, null, 2));
