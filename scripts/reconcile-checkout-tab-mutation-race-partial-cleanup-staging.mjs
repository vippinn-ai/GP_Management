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
const organizationId = "org-primary";

assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);
const cleanupRunId = sanitizeRunId(env.E2E_PARTIAL_CLEANUP_RUN_ID?.trim() || "");
const recoveryId = sanitizeRunId(env.E2E_RECOVERY_ID?.trim() || "");
if (!cleanupRunId || !recoveryId || cleanupRunId === recoveryId) {
  throw new Error("Fresh, distinct E2E_PARTIAL_CLEANUP_RUN_ID and E2E_RECOVERY_ID values are required.");
}

function loadBoundJson(requested, directory, pattern, label) {
  if (!requested?.trim()) throw new Error(`${label} path is required.`);
  const fullPath = path.resolve(root, requested.trim());
  if (path.dirname(fullPath) !== path.resolve(root, directory) || !pattern.test(path.basename(fullPath))) {
    throw new Error(`${label} path is outside its immutable evidence directory or has an invalid name.`);
  }
  const bytes = fs.readFileSync(fullPath);
  return {
    fullPath,
    relativePath: path.relative(root, fullPath),
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    value: JSON.parse(bytes.toString("utf8"))
  };
}
function stable(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((entry) => JSON.parse(stable(entry)))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
  if (value && typeof value === "object") return JSON.stringify(Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, JSON.parse(stable(entry))])));
  return JSON.stringify(value);
}
function ids(values) {
  return [...new Set(values.filter((value) => typeof value === "string"))].sort();
}
function changedIds(result, collection) {
  const values = result?.changed_rows?.[collection] ?? result?.changedRows?.[collection];
  return Array.isArray(values) ? values.map(String).sort() : [];
}
function stateIdentity(row) {
  return { version: row.version, hash: createHash("sha256").update(JSON.stringify(row.data)).digest("hex") };
}
function readEvidence(name) {
  const target = path.join(root, "test-artifacts", "evidence", name);
  const bytes = fs.readFileSync(target);
  return {
    path: path.relative(root, target),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    value: JSON.parse(bytes.toString("utf8"))
  };
}
function findFiles(directory, predicate, matches = []) {
  if (!fs.existsSync(directory)) return matches;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) findFiles(entryPath, predicate, matches);
    else if (predicate(entry.name)) matches.push(entryPath);
  }
  return matches;
}

const original = loadBoundJson(
  env.E2E_TAB_MUTATION_RACE_RECOVERY_ARTIFACT,
  path.join("test-artifacts", "reconciliation"),
  /^checkout-tab-mutation-race-recovery-[A-Za-z0-9_-]+\.json$/,
  "Original recovery"
);
const partialRead = loadBoundJson(
  env.E2E_TAB_MUTATION_PARTIAL_READ_ARTIFACT,
  path.join("test-artifacts", "reconciliation"),
  /^checkout-tab-mutation-race-recovery-[A-Za-z0-9_-]+\.json$/,
  "Partial-cleanup read"
);
const sourceRunId = sanitizeRunId(original.value.runId);
if (original.value.projectRef !== STAGING_PROJECT_REF || original.value.productionAllowed !== false ||
    original.value.safeForAutomaticRetry !== false || original.value.safeForIdentityBoundCleanup !== true ||
    !Array.isArray(original.value.failures) || original.value.failures.length !== 0) {
  throw new Error("Original recovery does not authorize the cleanup lineage.");
}
const expectedPartialFailures = [
  "Unexpected or missing run-entity operational event exists.",
  "Unexpected or missing run-entity audit exists.",
  "Current app_state version differs from the latest acknowledged compatibility-writing response.",
  "Current app_state differs from the latest fully hydrated compatibility checkpoint."
];
if (partialRead.value.runId !== sourceRunId || partialRead.value.projectRef !== STAGING_PROJECT_REF ||
    partialRead.value.productionAllowed !== false || partialRead.value.safeForAutomaticRetry !== false ||
    partialRead.value.safeForIdentityBoundCleanup !== false || partialRead.value.status !== "blocked" ||
    stable(partialRead.value.failures) !== stable(expectedPartialFailures)) {
  throw new Error("Partial-cleanup read is not the exact expected blocked source-reconciliation snapshot.");
}

const prepared = readEvidence(`checkout-tab-mutation-race-cleanup-prepared-${cleanupRunId}.json`);
const rejectAcks = findFiles(path.join(root, "test-artifacts", "evidence"), (name) =>
  name.startsWith("checkout-tab-mutation-race-cleanup-reject-") &&
  name.endsWith(`-acknowledged-${cleanupRunId}.json`));
const rejectVerified = findFiles(path.join(root, "test-artifacts", "evidence"), (name) =>
  name.startsWith("checkout-tab-mutation-race-cleanup-reject-") &&
  name.endsWith(`-verified-${cleanupRunId}.json`));
if (rejectAcks.length !== 1 || rejectVerified.length !== 1) {
  throw new Error("Partial cleanup must have exactly one reject acknowledgement and verification checkpoint.");
}
const rejectAck = readEvidence(path.basename(rejectAcks[0]));
const rejectVerify = readEvidence(path.basename(rejectVerified[0]));
const comboAck = readEvidence(`checkout-tab-mutation-race-cleanup-combo-archive-acknowledged-${cleanupRunId}.json`);
const comboVerify = readEvidence(`checkout-tab-mutation-race-cleanup-combo-archive-verified-${cleanupRunId}.json`);
const forbidden = findFiles(path.join(root, "test-artifacts", "evidence"), (name) =>
  name.includes(cleanupRunId) && (name.includes("item-archive-") || name.includes("cleanup-final-")));
if (forbidden.length) throw new Error(`Partial cleanup unexpectedly contains item/final checkpoints: ${forbidden.join(", ")}`);
const attachments = findFiles(
  path.join(root, "test-artifacts", "playwright", `v2-run-${cleanupRunId}`),
  (name) => /^checkout-tab-mutation-race-cleanup-evidence-[a-f0-9]+\.json$/.test(name)
);
if (attachments.length !== 1) throw new Error("The failed cleanup must have exactly one immutable JSON attachment.");
const failureBytes = fs.readFileSync(attachments[0]);
const failureEvidence = JSON.parse(failureBytes.toString("utf8"));
const failureSha256 = createHash("sha256").update(failureBytes).digest("hex");

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const expectedRecoveryPath = original.relativePath;
for (const evidence of [prepared.value, rejectAck.value, rejectVerify.value, comboAck.value, comboVerify.value, failureEvidence]) {
  check(evidence.cleanupRunId === cleanupRunId && evidence.sourceRunId === sourceRunId &&
    path.resolve(root, evidence.recoveryArtifact) === original.fullPath && evidence.recoverySha256 === original.sha256 &&
    evidence.productionAllowed === false && evidence.safeForAutomaticRetry === false,
  "A partial-cleanup checkpoint is not bound to the exact source/recovery identity.");
}
check(stable(prepared.value.before?.item) === stable(original.value.snapshot.item) &&
  stable(prepared.value.before?.combo) === stable(original.value.snapshot.combo) &&
  stable(prepared.value.before?.tabs) === stable(original.value.snapshot.tabs) &&
  stable(prepared.value.before?.tabItems) === stable(original.value.snapshot.tabItems) &&
  stable(prepared.value.before?.comboApplications) === stable(original.value.snapshot.comboApplications) &&
  stable(prepared.value.before?.bills) === stable(original.value.snapshot.bills) &&
  stable(prepared.value.before?.lines) === stable(original.value.snapshot.lines) &&
  stable(prepared.value.before?.payments) === stable(original.value.snapshot.payments) &&
  stable(prepared.value.before?.movements) === stable(original.value.snapshot.movements) &&
  stable(prepared.value.before?.events) === stable(original.value.snapshot.events) &&
  stable(prepared.value.before?.audits) === stable(original.value.snapshot.audits) &&
  stable(prepared.value.before?.mutations) === stable(original.value.snapshot.mutationResults) &&
  stable(prepared.value.before?.appState) === stable(original.value.snapshot.appState),
"Partial cleanup did not checkpoint the exact authorized source snapshot before writing.");
const verifiedRejectAction = rejectVerify.value.actions?.[0];
check(rejectVerify.value.actions?.length === 1 && verifiedRejectAction?.type === "reject_customer_tab" &&
  stable(verifiedRejectAction?.tab) === stable(rejectAck.value.tab) && verifiedRejectAction?.reason === rejectAck.value.reason &&
  stable(verifiedRejectAction?.result) === stable(rejectAck.value.result) &&
  path.resolve(root, verifiedRejectAction?.acknowledgementPath) === path.resolve(root, rejectAck.path),
"Reject verification is not bound to the exact reject acknowledgement.");
const checkpointedComboActions = comboVerify.value.actions ?? [];
const attachedComboActions = failureEvidence.actions ?? [];
check(checkpointedComboActions.length === 2 && attachedComboActions.length === 2 &&
  checkpointedComboActions.every((action, index) => {
    const attached = attachedComboActions[index];
    return action.type === attached?.type && stable(action.tab) === stable(attached?.tab) &&
      action.reason === attached?.reason && action.comboId === attached?.comboId &&
      stable(action.result) === stable(attached?.result) &&
      action.acknowledgementPath === attached?.acknowledgementPath &&
      stable(action.compatibility) === stable(attached?.compatibility);
  }),
"Combo verification and failed attachment do not preserve the exact two acknowledged actions.");
check(String(failureEvidence.failure).includes("Received:") && String(failureEvidence.failure).includes("400"),
  "Failed attachment does not prove the deterministic HTTP 400 item-archive response.");

const actions = failureEvidence.actions;
const rejectAction = actions?.[0];
const comboAction = actions?.[1];
check(rejectAction?.type === "reject_customer_tab" && comboAction?.type === "archive_combo",
  "Acknowledged partial-cleanup actions are not exactly reject then combo archive.");
check(Number(rejectAction?.result?.app_state_version) === Number(original.value.snapshot.appState.version) + 1 &&
  Number(comboAction?.result?.app_state_version) === Number(original.value.snapshot.appState.version) + 2 &&
  Number(rejectAction?.compatibility?.version) === Number(original.value.snapshot.appState.version) + 1 &&
  Number(comboAction?.compatibility?.version) === Number(original.value.snapshot.appState.version) + 2,
"Acknowledged partial-cleanup compatibility versions are not exact and monotonic.");

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Partial-cleanup recovery is locked to the exact staging project.");
}
const client = createClient(supabaseUrl, supabaseAnonKey, { auth: {
  persistSession: false, autoRefreshToken: false, detectSessionInUrl: false
} });
const lookup = await client.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve staging credential slot A.");
const login = await client.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate staging credential slot A.");
const [role, profile] = await Promise.all([
  client.rpc("current_user_org_role", { target_organization_id: organizationId }),
  client.from("profiles").select("id,role,active").eq("id", login.data.user.id).single()
]);
if (role.error || role.data !== "admin" || profile.error || profile.data?.role !== "admin" || !profile.data.active ||
    login.data.user.id !== original.value.actors?.checkout) {
  throw new Error("Recovery actor does not match the authorized source checkout actor.");
}
async function query(label, promise) {
  const result = await promise;
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  return result.data;
}
const expected = partialRead.value.snapshot;
const itemId = original.value.fixture.itemId;
const comboId = original.value.fixture.comboId;
const tabIds = ids(expected.tabs.map((row) => row.id));
const billIds = ids(expected.bills.map((row) => row.id));
const priorEventIds = ids([...expected.events.map((row) => row.id), rejectAction?.result?.event_id, comboAction?.result?.event_id]);
const priorAuditIds = ids([...expected.audits.map((row) => row.id),
  ...changedIds(rejectAction?.result, "audit_logs"), ...changedIds(comboAction?.result, "audit_logs")]);
const mutationResultsPromise = Promise.all(expected.mutationResults.map(async (entry) => ({
  mutationId: entry.mutationId,
  result: await query(`mutation ${entry.mutationId}`, client.rpc("get_financial_mutation_result", { payload: {
    organization_id: organizationId, mutation_id: entry.mutationId, mutation_kind: "commitCheckoutBill"
  } }))
})));
const [item, combo, tabs, tabItems, comboApplications, bills, lines, payments, movements, priorEvents, priorAudits,
  openSessions, openTabs, appState, mutationResults, itemEvents, itemAudits, adminEventsAfterCombo] = await Promise.all([
  query("fixture item", client.from("inventory_items").select("id,name,stock_qty,active,archived_by_user_id,archive_reason")
    .eq("organization_id", organizationId).eq("id", itemId)),
  query("fixture combo", client.from("combos").select("id,name,type,active")
    .eq("organization_id", organizationId).eq("id", comboId)),
  query("run tabs", client.from("customer_tabs").select("id,customer_name,status,close_disposition,closed_bill_id")
    .eq("organization_id", organizationId).in("id", tabIds)),
  query("run tab items", client.from("customer_tab_items")
    .select("id,customer_tab_id,inventory_item_id,name,quantity,unit_price,combo_application_id,combo_id")
    .eq("organization_id", organizationId).in("customer_tab_id", tabIds)),
  query("run combo applications", client.from("customer_tab_combo_applications")
    .select("id,customer_tab_id,combo_id,combo_name,price").eq("organization_id", organizationId).in("customer_tab_id", tabIds)),
  query("run bills", client.from("bills").select("id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id")
    .eq("organization_id", organizationId).in("id", billIds)),
  query("run bill lines", client.from("bill_lines")
    .select("id,bill_id,type,description,inventory_item_id,quantity,unit_price,subtotal,discount_amount,total,combo_application_id,combo_id")
    .eq("organization_id", organizationId).in("bill_id", billIds)),
  query("run payments", client.from("payments")
    .select("id,bill_id,amount,mode,received_by_user_id,settlement_group_id,related_checkout_bill_id")
    .eq("organization_id", organizationId).in("bill_id", billIds)),
  query("fixture movements", client.from("stock_movements").select("id,item_id,type,quantity,reason,user_id,related_bill_id")
    .eq("organization_id", organizationId).eq("item_id", itemId)),
  query("prior events", client.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata")
    .eq("organization_id", organizationId).in("id", priorEventIds)),
  query("prior audits", client.from("audit_logs").select("id,action,entity_type,entity_id,user_id,message")
    .eq("organization_id", organizationId).in("id", priorAuditIds)),
  query("open sessions", client.from("sessions").select("id,status").eq("organization_id", organizationId).neq("status", "closed")),
  query("open tabs", client.from("customer_tabs").select("id,status").eq("organization_id", organizationId).eq("status", "open")),
  query("app state", client.from("app_state").select("version,data").eq("id", "primary").single()),
  mutationResultsPromise,
  query("item events", client.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata")
    .eq("organization_id", organizationId).eq("entity_id", itemId)),
  query("item audits", client.from("audit_logs").select("id,action,entity_type,entity_id,user_id,message")
    .eq("organization_id", organizationId).eq("entity_id", itemId)),
  query("admin events after combo", client.from("operational_events")
    .select("id,event_type,entity_type,entity_id,created_by,metadata,created_at")
    .eq("organization_id", organizationId).eq("event_type", "admin_data_committed")
    .gte("created_at", comboAction?.result?.server_time))
]);
const currentAppState = stateIdentity(appState);
const expectedEvents = ids([...expected.events.map((row) => row.id), rejectAction.result.event_id, comboAction.result.event_id]);
const expectedAudits = ids([...expected.audits.map((row) => row.id),
  ...changedIds(rejectAction.result, "audit_logs"), ...changedIds(comboAction.result, "audit_logs")]);
check(stable(item) === stable(expected.item) && item.length === 1 && item[0].active === true &&
  Number(item[0].stock_qty) === 62 && item[0].archived_by_user_id === null && item[0].archive_reason === null,
"Only the exact active stock-62 item with null archive fields may remain for cleanup.");
check(stable(combo) === stable(expected.combo) && combo.length === 1 && combo[0].active === false,
  "The exact combo is not already archived.");
check(stable(tabs) === stable(expected.tabs) && stable(tabItems) === stable(expected.tabItems) &&
  stable(comboApplications) === stable(expected.comboApplications) && stable(bills) === stable(expected.bills) &&
  stable(lines) === stable(expected.lines) && stable(payments) === stable(expected.payments) &&
  stable(movements) === stable(expected.movements) && stable(mutationResults) === stable(expected.mutationResults),
"Partial cleanup changed a protected source financial, tab, stock, or mutation row.");
check(openSessions.length === 0 && openTabs.length === 0, "Staging floor is not empty.");
check(stable(currentAppState) === stable(comboAction.compatibility) && stable(currentAppState) === stable(expected.appState),
  "Current compatibility identity is not the exact acknowledged v683 state.");
check(ids(priorEvents.map((row) => row.id)).join() === expectedEvents.join() &&
  ids(priorAudits.map((row) => row.id)).join() === expectedAudits.join(),
"Acknowledged partial-cleanup events/audits are not exact.");
check(itemEvents.every((row) => expectedEvents.includes(row.id)) && itemAudits.every((row) => expectedAudits.includes(row.id)),
  "The failed item archive produced an unacknowledged item event or audit.");
const itemAdminEventsAfterCombo = adminEventsAfterCombo.filter((row) =>
  Array.isArray(row.metadata?.changed_rows?.inventory_items) && row.metadata.changed_rows.inventory_items.includes(itemId));
check(itemAdminEventsAfterCombo.length === 0,
  "The failed item archive produced an admin event whose changed_rows includes the fixture item.");
check(rejectAction.result.entity_id === rejectAction.tab.id &&
  changedIds(rejectAction.result, "customer_tabs").join() === rejectAction.tab.id &&
  comboAction.comboId === comboId && changedIds(comboAction.result, "combos").join() === comboId,
"Partial-cleanup action acknowledgements are not bound to the exact tab/combo entities.");
const rejectEvent = priorEvents.find((row) => row.id === rejectAction.result.event_id);
const rejectAuditIds = changedIds(rejectAction.result, "audit_logs");
const rejectAudits = priorAudits.filter((row) => rejectAuditIds.includes(row.id));
const rejectEventChangedRows = Object.fromEntries(Object.entries(rejectAction.result.changed_rows ?? {})
  .filter(([key]) => key !== "operational_events"));
check(Boolean(rejectEvent && rejectEvent.event_type === "reject_customer_tab" &&
  rejectEvent.entity_type === "customer_tab" && rejectEvent.entity_id === rejectAction.tab.id &&
  rejectEvent.created_by === original.value.actors.checkout &&
  rejectEvent.metadata?.mutation_id === rejectAction.result.mutation_id &&
  stable(rejectEvent.metadata?.changed_rows) === stable(rejectEventChangedRows)),
"Persisted reject event type/entity/actor/mutation/changed_rows is not exact.");
check(rejectAudits.length === 1 && rejectAudits[0].action === "customer_tab_rejected" &&
  rejectAudits[0].entity_type === "customer_tab" && rejectAudits[0].entity_id === rejectAction.tab.id &&
  rejectAudits[0].user_id === original.value.actors.checkout &&
  rejectAudits[0].message === `Rejected customer tab for ${rejectAction.tab.customer_name}. Reason: ${rejectAction.reason}`,
"Persisted reject audit identity/actor/canonical message is not exact.");
const comboEvent = priorEvents.find((row) => row.id === comboAction.result.event_id);
const comboAuditIds = changedIds(comboAction.result, "audit_logs");
const comboAudits = priorAudits.filter((row) => comboAuditIds.includes(row.id));
check(Boolean(comboEvent && comboEvent.event_type === "admin_data_committed" &&
  comboEvent.entity_type === comboAction.result.entity_type && comboEvent.entity_id === comboAction.result.entity_id &&
  comboEvent.created_by === original.value.actors.checkout &&
  comboEvent.metadata?.mutation_id === comboAction.result.mutation_id &&
  stable(comboEvent.metadata?.changed_rows) === stable(comboAction.result.changed_rows)),
"Persisted combo event type/entity/actor/mutation/changed_rows is not exact.");
check(comboAudits.length === 1 && comboAudits[0].action === "combo_archived" &&
  comboAudits[0].entity_type === "combo" && comboAudits[0].entity_id === comboId &&
  comboAudits[0].user_id === original.value.actors.checkout &&
  comboAudits[0].message === `Archived combo ${original.value.fixture.comboName}.`,
"Persisted combo audit identity/actor/message is not exact.");

const snapshot = {
  item, combo, tabs, tabItems, comboApplications, bills, lines, payments, movements,
  events: priorEvents, audits: priorAudits, mutationResults, appState: currentAppState
};
const safeForItemOnlyCleanup = failures.length === 0;
const report = {
  status: safeForItemOnlyCleanup ? "item-cleanup-authorized" : "blocked",
  runId: recoveryId,
  sourceRunId,
  partialCleanupRunId: cleanupRunId,
  checkedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  organizationId,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  safeForIdentityBoundCleanup: false,
  safeForItemOnlyCleanup,
  allowedCleanupActions: ["archive_item"],
  failures,
  actors: original.value.actors,
  fixture: original.value.fixture,
  openFloor: { sessions: openSessions, tabs: openTabs },
  snapshot,
  lineage: {
    originalRecovery: expectedRecoveryPath,
    originalRecoverySha256: original.sha256,
    partialRead: partialRead.relativePath,
    partialReadSha256: partialRead.sha256,
    cleanupPrepared: prepared.path,
    cleanupPreparedSha256: prepared.sha256,
    rejectAcknowledgement: rejectAck.path,
    rejectAcknowledgementSha256: rejectAck.sha256,
    rejectVerification: rejectVerify.path,
    rejectVerificationSha256: rejectVerify.sha256,
    comboAcknowledgement: comboAck.path,
    comboAcknowledgementSha256: comboAck.sha256,
    comboVerification: comboVerify.path,
    comboVerificationSha256: comboVerify.sha256,
    failedAttachment: path.relative(root, attachments[0]),
    failedAttachmentSha256: failureSha256,
    acknowledgedActions: actions
  }
};
const outputDirectory = path.join(root, "test-artifacts", "reconciliation");
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory,
  `checkout-tab-mutation-race-item-cleanup-recovery-${sourceRunId}-${cleanupRunId}-${recoveryId}.json`);
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ artifact: path.relative(root, outputPath), report }, null, 2));
if (!safeForItemOnlyCleanup) process.exitCode = 2;
