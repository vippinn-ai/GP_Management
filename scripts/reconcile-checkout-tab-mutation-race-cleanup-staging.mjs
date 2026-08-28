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
if (!env.E2E_RUN_ID?.trim()) throw new Error("An explicit cleanup E2E_RUN_ID is required.");
const cleanupRunId = sanitizeRunId(env.E2E_RUN_ID);
if (!env.E2E_POSTFLIGHT_ID?.trim()) throw new Error("A fresh explicit E2E_POSTFLIGHT_ID is required.");
const postflightId = sanitizeRunId(env.E2E_POSTFLIGHT_ID);
const requestedRecovery = env.E2E_TAB_MUTATION_RACE_RECOVERY_ARTIFACT?.trim();
if (!requestedRecovery) throw new Error("E2E_TAB_MUTATION_RACE_RECOVERY_ARTIFACT is required.");
const recoveryPath = path.resolve(root, requestedRecovery);
const recoveryDirectory = path.resolve(root, "test-artifacts", "reconciliation");
if (path.dirname(recoveryPath) !== recoveryDirectory ||
    !/^checkout-tab-mutation-race-recovery-[A-Za-z0-9_-]+\.json$/.test(path.basename(recoveryPath))) {
  throw new Error("Cleanup postflight accepts only the exact immutable tab-mutation recovery artifact.");
}
const recoveryBytes = fs.readFileSync(recoveryPath);
const recoverySha256 = createHash("sha256").update(recoveryBytes).digest("hex");
const recovery = JSON.parse(recoveryBytes.toString("utf8"));
if (recovery.projectRef !== STAGING_PROJECT_REF || recovery.productionAllowed !== false ||
    recovery.safeForAutomaticRetry !== false || recovery.safeForIdentityBoundCleanup !== true ||
    !Array.isArray(recovery.failures) || recovery.failures.length !== 0) {
  throw new Error("The recovery artifact is not authorized for identity-bound staging cleanup postflight.");
}
const sourceRunId = sanitizeRunId(recovery.runId);
if (sourceRunId === cleanupRunId) throw new Error("Cleanup and source run identities must differ.");
if (postflightId === cleanupRunId || postflightId === sourceRunId) {
  throw new Error("Cleanup postflight identity must differ from both cleanup and source identities.");
}
const artifactRoot = path.join(root, "test-artifacts");
const postflightCollisions = [];
function scanForPostflightIdentity(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (path.relative(artifactRoot, entryPath).includes(postflightId)) {
      postflightCollisions.push(path.relative(root, entryPath));
    }
    if (entry.isDirectory()) scanForPostflightIdentity(entryPath);
  }
}
scanForPostflightIdentity(artifactRoot);
if (postflightCollisions.length) {
  throw new Error(`Cleanup postflight identity collides with existing artifacts: ${postflightCollisions.sort().join(", ")}`);
}

const finalPath = path.join(root, "test-artifacts", "evidence", `checkout-tab-mutation-race-cleanup-final-${cleanupRunId}.json`);
if (!fs.existsSync(finalPath)) throw new Error("The exact immutable cleanup final checkpoint is missing.");
const finalBytes = fs.readFileSync(finalPath);
const finalEvidence = JSON.parse(finalBytes.toString("utf8"));
if (finalEvidence.cleanupRunId !== cleanupRunId || finalEvidence.sourceRunId !== sourceRunId ||
    path.resolve(root, finalEvidence.recoveryArtifact) !== recoveryPath ||
    finalEvidence.recoverySha256 !== recoverySha256 || finalEvidence.productionAllowed !== false ||
    finalEvidence.safeForAutomaticRetry !== false || !finalEvidence.final) {
  throw new Error("Cleanup final evidence is not bound to the exact cleanup, source, and recovery identities.");
}

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Cleanup postflight is locked to the exact staging project.");
}
const client = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const lookup = await client.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve staging credential slot A.");
const login = await client.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate staging credential slot A.");
const [role, profile] = await Promise.all([
  client.rpc("current_user_org_role", { target_organization_id: organizationId }),
  client.from("profiles").select("id,role,active").eq("id", login.data.user.id).single()
]);
if (role.error || role.data !== "admin" || profile.error || profile.data?.role !== "admin" ||
    !profile.data.active || login.data.user.id !== recovery.actors?.checkout) {
  throw new Error("Cleanup postflight actor does not match the authorized source checkout actor.");
}

async function query(label, promise) {
  const result = await promise;
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  return result.data;
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

const actions = Array.isArray(finalEvidence.actions) ? finalEvidence.actions : [];
const tabIds = ids(recovery.snapshot.tabs.map((row) => row.id));
const billIds = ids(recovery.snapshot.bills.map((row) => row.id));
const itemId = recovery.fixture?.itemId ?? null;
const comboId = recovery.fixture?.comboId ?? null;
const priorEventIds = ids(recovery.snapshot.events.map((row) => row.id));
const priorAuditIds = ids(recovery.snapshot.audits.map((row) => row.id));
const actionEventIds = ids(actions.flatMap((entry) => [
  ...(typeof entry.result?.event_id === "string" ? [entry.result.event_id] : []),
  ...changedIds(entry.result, "operational_events")
]));
const actionAuditIds = ids(actions.flatMap((entry) => changedIds(entry.result, "audit_logs")));
const entityIds = ids([...tabIds, ...billIds, itemId, comboId]);

const mutationResultsPromise = Promise.all(recovery.snapshot.mutationResults.map(async (expected) => ({
  mutationId: expected.mutationId,
  result: await query(`mutation ${expected.mutationId}`, client.rpc("get_financial_mutation_result", { payload: {
    organization_id: organizationId,
    mutation_id: expected.mutationId,
    mutation_kind: "commitCheckoutBill"
  } }))
})));
const [items, combos, tabs, tabItems, comboApplications, bills, lines, payments, movements,
  priorEvents, priorAudits, actionEvents, actionAudits, entityEvents, entityAudits,
  openSessions, openTabs, appState, mutationResults] = await Promise.all([
  itemId ? query("fixture item", client.from("inventory_items")
    .select("id,name,stock_qty,active,archived_by_user_id,archive_reason")
    .eq("organization_id", organizationId).eq("id", itemId)) : Promise.resolve([]),
  comboId ? query("fixture combo", client.from("combos").select("id,name,type,active")
    .eq("organization_id", organizationId).eq("id", comboId)) : Promise.resolve([]),
  tabIds.length ? query("run tabs", client.from("customer_tabs")
    .select("id,customer_name,status,close_disposition,closed_bill_id")
    .eq("organization_id", organizationId).in("id", tabIds)) : Promise.resolve([]),
  tabIds.length ? query("run tab items", client.from("customer_tab_items")
    .select("id,customer_tab_id,inventory_item_id,name,quantity,unit_price,combo_application_id,combo_id")
    .eq("organization_id", organizationId).in("customer_tab_id", tabIds)) : Promise.resolve([]),
  tabIds.length ? query("run combo applications", client.from("customer_tab_combo_applications")
    .select("id,customer_tab_id,combo_id,combo_name,price")
    .eq("organization_id", organizationId).in("customer_tab_id", tabIds)) : Promise.resolve([]),
  billIds.length ? query("run bills", client.from("bills")
    .select("id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id")
    .eq("organization_id", organizationId).in("id", billIds)) : Promise.resolve([]),
  billIds.length ? query("run bill lines", client.from("bill_lines")
    .select("id,bill_id,type,description,inventory_item_id,quantity,unit_price,subtotal,discount_amount,total,combo_application_id,combo_id")
    .eq("organization_id", organizationId).in("bill_id", billIds)) : Promise.resolve([]),
  billIds.length ? query("run payments", client.from("payments")
    .select("id,bill_id,amount,mode,received_by_user_id,settlement_group_id,related_checkout_bill_id")
    .eq("organization_id", organizationId).in("bill_id", billIds)) : Promise.resolve([]),
  itemId ? query("fixture movements", client.from("stock_movements")
    .select("id,item_id,type,quantity,reason,user_id,related_bill_id")
    .eq("organization_id", organizationId).eq("item_id", itemId)) : Promise.resolve([]),
  priorEventIds.length ? query("prior events", client.from("operational_events")
    .select("id,event_type,entity_type,entity_id,created_by,metadata")
    .eq("organization_id", organizationId).in("id", priorEventIds)) : Promise.resolve([]),
  priorAuditIds.length ? query("prior audits", client.from("audit_logs")
    .select("id,action,entity_type,entity_id,user_id,message")
    .eq("organization_id", organizationId).in("id", priorAuditIds)) : Promise.resolve([]),
  actionEventIds.length ? query("cleanup events", client.from("operational_events")
    .select("id,event_type,entity_type,entity_id,created_by,metadata")
    .eq("organization_id", organizationId).in("id", actionEventIds)) : Promise.resolve([]),
  actionAuditIds.length ? query("cleanup audits", client.from("audit_logs")
    .select("id,action,entity_type,entity_id,user_id,message")
    .eq("organization_id", organizationId).in("id", actionAuditIds)) : Promise.resolve([]),
  entityIds.length ? query("all run-entity events", client.from("operational_events")
    .select("id,event_type,entity_type,entity_id,created_by,metadata")
    .eq("organization_id", organizationId).in("entity_id", entityIds)) : Promise.resolve([]),
  entityIds.length ? query("all run-entity audits", client.from("audit_logs")
    .select("id,action,entity_type,entity_id,user_id,message")
    .eq("organization_id", organizationId).in("entity_id", entityIds)) : Promise.resolve([]),
  query("open sessions", client.from("sessions").select("id,status")
    .eq("organization_id", organizationId).neq("status", "closed")),
  query("open tabs", client.from("customer_tabs").select("id,status")
    .eq("organization_id", organizationId).eq("status", "open")),
  query("app state", client.from("app_state").select("version,data").eq("id", "primary").single()),
  mutationResultsPromise
]);
const actionMutationEvents = await Promise.all(actions.map(async (action) => ({
  type: action.type,
  mutationId: action.result?.mutation_id ?? null,
  rows: action.result?.mutation_id ? await query(`${action.type} mutation event`, client.from("operational_events")
    .select("id,event_type,entity_type,entity_id,created_by,metadata")
    .eq("organization_id", organizationId).eq("metadata->>mutation_id", action.result.mutation_id)) : []
})));

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
check(stable(finalEvidence.before?.item) === stable(recovery.snapshot.item) &&
  stable(finalEvidence.before?.combo) === stable(recovery.snapshot.combo) &&
  stable(finalEvidence.before?.tabs) === stable(recovery.snapshot.tabs) &&
  stable(finalEvidence.before?.tabItems) === stable(recovery.snapshot.tabItems) &&
  stable(finalEvidence.before?.comboApplications) === stable(recovery.snapshot.comboApplications) &&
  stable(finalEvidence.before?.bills) === stable(recovery.snapshot.bills) &&
  stable(finalEvidence.before?.lines) === stable(recovery.snapshot.lines) &&
  stable(finalEvidence.before?.payments) === stable(recovery.snapshot.payments) &&
  stable(finalEvidence.before?.movements) === stable(recovery.snapshot.movements) &&
  stable(finalEvidence.before?.events) === stable(recovery.snapshot.events) &&
  stable(finalEvidence.before?.audits) === stable(recovery.snapshot.audits) &&
  stable(finalEvidence.before?.mutations) === stable(recovery.snapshot.mutationResults) &&
  stable(finalEvidence.before?.appState) === stable(recovery.snapshot.appState),
"Cleanup did not checkpoint the exact authorized recovery snapshot before its first write.");

check(stable(tabItems) === stable(recovery.snapshot.tabItems), "Cleanup changed source customer-tab item rows.");
check(stable(comboApplications) === stable(recovery.snapshot.comboApplications), "Cleanup changed source combo-application rows.");
check(stable(bills) === stable(recovery.snapshot.bills), "Cleanup changed committed bills.");
check(stable(lines) === stable(recovery.snapshot.lines), "Cleanup changed committed bill lines.");
check(stable(payments) === stable(recovery.snapshot.payments), "Cleanup changed committed payments.");
check(stable(movements) === stable(recovery.snapshot.movements), "Cleanup created or changed stock movements.");
check(stable(priorEvents) === stable(recovery.snapshot.events), "Cleanup changed prior operational events.");
check(stable(priorAudits) === stable(recovery.snapshot.audits), "Cleanup changed prior audit rows.");
check(stable(mutationResults) === stable(recovery.snapshot.mutationResults), "Cleanup changed canonical financial mutation results.");
check(openSessions.length === 0 && openTabs.length === 0, "Cleanup did not restore an empty staging floor.");

const expectedRejectedIds = ids(recovery.openFloor.tabs.map((row) => row.id));
const rejectActions = actions.filter((entry) => entry.type === "reject_customer_tab");
const comboActions = actions.filter((entry) => entry.type === "archive_combo");
const itemActions = actions.filter((entry) => entry.type === "archive_item");
check(ids(rejectActions.map((entry) => entry.tab?.id)).join() === expectedRejectedIds.join(),
  "Cleanup rejection acknowledgements do not exactly match the authorized open tabs.");
check(comboActions.length === Number(Boolean(recovery.snapshot.combo[0]?.active)),
  "Cleanup combo-archive acknowledgement count is not exact.");
check(itemActions.length === Number(Boolean(recovery.snapshot.item[0]?.active)),
  "Cleanup item-archive acknowledgement count is not exact.");
check(actions.length === rejectActions.length + comboActions.length + itemActions.length,
  "Cleanup contains an unrecognized action type.");
actions.forEach((action, index) => {
  const expectedVersion = Number(recovery.snapshot.appState.version) + index + 1;
  check(Number(action.result?.app_state_version) === expectedVersion &&
    Number(action.compatibility?.version) === expectedVersion,
  `${action.type}: acknowledged and hydrated compatibility versions are not the exact monotonic sequence.`);
});

for (const before of recovery.snapshot.tabs) {
  const after = tabs.find((row) => row.id === before.id);
  if (expectedRejectedIds.includes(before.id)) {
    check(Boolean(after && after.customer_name === before.customer_name && after.status === "closed" &&
      after.close_disposition === "rejected" && after.closed_bill_id === null),
    `Authorized open tab ${before.id} was not closed as rejected with a null bill link.`);
  } else {
    check(stable(after) === stable(before), `Cleanup changed pre-existing closed tab ${before.id}.`);
  }
}
if (recovery.snapshot.item.length) {
  check(items.length === 1 && items[0].id === itemId && items[0].name === recovery.snapshot.item[0].name &&
    Number(items[0].stock_qty) === Number(recovery.snapshot.item[0].stock_qty) && items[0].active === false &&
    items[0].archived_by_user_id === recovery.actors.checkout,
  "Cleanup did not preserve and archive the exact item at unchanged physical stock.");
} else check(items.length === 0, "Cleanup found an unexpected fixture item.");
if (recovery.snapshot.combo.length) {
  check(combos.length === 1 && combos[0].id === comboId && combos[0].name === recovery.snapshot.combo[0].name &&
    combos[0].type === recovery.snapshot.combo[0].type && combos[0].active === false,
  "Cleanup did not preserve and archive the exact combo.");
} else check(combos.length === 0, "Cleanup found an unexpected fixture combo.");

for (const action of actions) {
  const result = action.result ?? {};
  const event = actionEvents.find((row) => row.id === result.event_id);
  const auditIdsForAction = changedIds(result, "audit_logs");
  const auditsForAction = actionAudits.filter((row) => auditIdsForAction.includes(row.id));
  const eventChangedRows = action.type === "reject_customer_tab"
    ? Object.fromEntries(Object.entries(result.changed_rows ?? {}).filter(([key]) => key !== "operational_events"))
    : result.changed_rows;
  check(Boolean(event && event.created_by === recovery.actors.checkout &&
    event.metadata?.mutation_id === result.mutation_id &&
    stable(event.metadata?.changed_rows) === stable(eventChangedRows)),
  `${action.type}: event actor, mutation identity, or changed_rows differs from its acknowledgement.`);
  if (action.type === "reject_customer_tab") {
    check(event?.event_type === "reject_customer_tab" && event?.entity_type === "customer_tab" &&
      event?.entity_id === action.tab.id && changedIds(result, "customer_tabs").join() === action.tab.id &&
      changedIds(result, "operational_events").join() === event.id,
    "Rejected-tab event/entity/changed_rows is incorrect.");
    check(auditsForAction.length === 1 && auditsForAction[0].action === "customer_tab_rejected" &&
      auditsForAction[0].entity_type === "customer_tab" && auditsForAction[0].entity_id === action.tab.id &&
      auditsForAction[0].user_id === recovery.actors.checkout &&
      auditsForAction[0].message === `Rejected ${action.tab.customer_name}'s tab. Reason: ${action.reason}`,
    "Rejected-tab audit identity, actor, or message is incorrect.");
  } else if (action.type === "archive_combo") {
    check(event?.event_type === "admin_data_committed" && changedIds(result, "combos").join() === comboId,
      "Combo-archive event or changed_rows is incorrect.");
    check(auditsForAction.length === 1 && auditsForAction[0].action === "combo_archived" &&
      auditsForAction[0].entity_type === "combo" && auditsForAction[0].entity_id === comboId &&
      auditsForAction[0].user_id === recovery.actors.checkout &&
      auditsForAction[0].message === `Archived combo ${recovery.fixture.comboName}.`,
    "Combo-archive audit identity, actor, or message is incorrect.");
  } else if (action.type === "archive_item") {
    check(event?.event_type === "admin_data_committed" && changedIds(result, "inventory_items").join() === itemId,
      "Item-archive event or changed_rows is incorrect.");
    check(auditsForAction.length === 1 && auditsForAction[0].action === "inventory_archived" &&
      auditsForAction[0].entity_type === "inventory_item" && auditsForAction[0].entity_id === itemId &&
      auditsForAction[0].user_id === recovery.actors.checkout &&
      auditsForAction[0].message === `Archived ${recovery.fixture.itemName}. Reason: ${action.reason}.` &&
      items[0]?.archive_reason === action.reason,
    "Item-archive audit identity, actor, reason, or message is incorrect.");
  }
}
for (const entry of actionMutationEvents) {
  const expectedAction = actions.find((action) => action.result?.mutation_id === entry.mutationId);
  check(entry.rows.length === 1 && entry.rows[0].id === expectedAction?.result?.event_id,
    `${entry.type}: mutation identity does not resolve to exactly one acknowledged event.`);
}

check(ids(actionEvents.map((row) => row.id)).join() === actionEventIds.join(),
  "Cleanup is missing an acknowledged event or returned an extra exact event.");
check(ids(actionAudits.map((row) => row.id)).join() === actionAuditIds.join(),
  "Cleanup is missing an acknowledged audit or returned an extra exact audit.");
const allowedEventIds = ids([...priorEventIds, ...actionEventIds]);
const allowedAuditIds = ids([...priorAuditIds, ...actionAuditIds]);
check(entityEvents.every((row) => allowedEventIds.includes(row.id)), "An unacknowledged event exists for a run entity.");
check(entityAudits.every((row) => allowedAuditIds.includes(row.id)), "An unacknowledged audit exists for a run entity.");

const appStateIdentity = stateIdentity(appState);
check(appState.version === Number(recovery.snapshot.appState.version) + actions.length,
  "Compatibility version did not advance exactly once per acknowledged cleanup action.");
check(stable(finalEvidence.final?.appState) === stable(appStateIdentity),
  "Current app_state differs from the immutable cleanup final checkpoint.");
check(stable(finalEvidence.final?.tabItems) === stable(tabItems) &&
  stable(finalEvidence.final?.item) === stable(items) && stable(finalEvidence.final?.combo) === stable(combos) &&
  stable(finalEvidence.final?.tabs) === stable(tabs) &&
  stable(finalEvidence.final?.comboApplications) === stable(comboApplications) &&
  stable(finalEvidence.final?.bills) === stable(bills) && stable(finalEvidence.final?.lines) === stable(lines) &&
  stable(finalEvidence.final?.payments) === stable(payments) && stable(finalEvidence.final?.movements) === stable(movements) &&
  stable(finalEvidence.final?.priorEvents) === stable(priorEvents) && stable(finalEvidence.final?.priorAudits) === stable(priorAudits) &&
  stable(finalEvidence.final?.actionEvents) === stable(actionEvents) && stable(finalEvidence.final?.actionAudits) === stable(actionAudits) &&
  stable(finalEvidence.final?.mutationResults) === stable(mutationResults),
"Current canonical rows differ from the immutable cleanup final checkpoint.");

const report = {
  status: failures.length ? "failed" : "passed",
  cleanupRunId,
  sourceRunId,
  postflightId,
  checkedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  organizationId,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  recoveryArtifact: path.relative(root, recoveryPath),
  recoverySha256,
  cleanupEvidence: path.relative(root, finalPath),
  cleanupEvidenceSha256: createHash("sha256").update(finalBytes).digest("hex"),
  actions,
  snapshot: {
    item: items, combo: combos, tabs, tabItems, comboApplications, bills, lines, payments, movements,
    priorEvents, priorAudits, actionEvents, actionAudits, actionMutationEvents, mutationResults,
    openFloor: { sessions: openSessions, tabs: openTabs }, appState: appStateIdentity
  },
  failures
};
const outputDirectory = path.join(root, "test-artifacts", "reconciliation");
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory,
  `checkout-tab-mutation-race-cleanup-postflight-${cleanupRunId}-${postflightId}.json`);
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ artifact: path.relative(root, outputPath), report }, null, 2));
if (failures.length) process.exitCode = 2;
