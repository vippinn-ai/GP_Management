import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  assertStagingSupabaseEnvironment,
  parseEnvFile,
  sanitizeRunId,
  STAGING_PROJECT_REF
} from "./playwright-staging-env.mjs";
import { loadSessionItemRaceAdmin } from "./session-item-race-admin-env.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => argument !== "--postflight")) {
  throw new Error("Checkout-tab-mutation reconciliation accepts only --postflight or one exact recovery reconciliation.");
}
const postflight = args[0] === "--postflight";
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const temporaryAdmin = loadSessionItemRaceAdmin(root);
const env = { ...localEnv, ...process.env, ...(temporaryAdmin?.overlay || {}) };
assertStagingSupabaseEnvironment(stagingEnv, true);
if (!env.E2E_RUN_ID?.trim()) throw new Error("An explicit E2E_RUN_ID is required.");
const runId = sanitizeRunId(env.E2E_RUN_ID);
const organizationId = "org-primary";
const itemName = `QA Tab Mutation Race Item ${runId}`;
const comboName = `QA Tab Mutation Race Combo ${runId}`;
const modes = ["add_item", "update_item", "remove_item", "apply_combo"];
const scenarios = ["checkout_first", "mutation_first", "simultaneous"];
const allCases = modes.flatMap((mode) => scenarios.map((scenario) => ({ mode, scenario })));
const modeContracts = {
  add_item: { eventType: "add_customer_tab_item", mutationKind: "addCustomerTabItem", auditAction: "customer_tab_item_added", auditCount: 1, raceReservation: 2 },
  update_item: { eventType: "update_customer_tab_item_quantity", mutationKind: "updateCustomerTabItemQuantity", auditAction: null, auditCount: 0, raceReservation: 2 },
  remove_item: { eventType: "remove_customer_tab_item", mutationKind: "removeCustomerTabItem", auditAction: "customer_tab_item_removed", auditCount: 1, raceReservation: 0 },
  apply_combo: { eventType: "apply_customer_tab_combo", mutationKind: "applyCustomerTabCombo", auditAction: "customer_tab_combo_applied", auditCount: 1, raceReservation: 2 }
};

function stable(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((entry) => JSON.parse(stable(entry))).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
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
function appStateIdentity(row) {
  return { version: row.version, hash: createHash("sha256").update(JSON.stringify(row.data)).digest("hex") };
}
function collectAcknowledgedAppStateVersions(value, versions = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectAcknowledgedAppStateVersions(entry, versions));
  } else if (value && typeof value === "object") {
    if (Number.isInteger(value.app_state_version)) versions.push(value.app_state_version);
    Object.values(value).forEach((entry) => collectAcknowledgedAppStateVersions(entry, versions));
  }
  return versions;
}

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Checkout-tab-mutation reconciliation is locked to staging.");
}
if (!env.E2E_USER_A?.trim() || !env.E2E_PASSWORD_A?.trim()) throw new Error("Staging credential slot A is required.");
const client = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const lookup = await client.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve staging credential slot A.");
const login = await client.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate staging credential slot A.");
const [role, profile] = await Promise.all([
  client.rpc("current_user_org_role", { target_organization_id: organizationId }),
  client.from("profiles").select("id,role,active").eq("id", login.data.user.id).single()
]);
if (role.error || role.data !== "admin" || profile.error || profile.data?.role !== "admin" || !profile.data.active) {
  throw new Error("Reconciliation requires an active authoritative staging admin.");
}
async function query(label, promise) {
  const result = await promise;
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  return result.data;
}

const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-tab-mutation-race-preflight-${runId}.json`);
if (!fs.existsSync(preflightPath)) throw new Error("The exact checkout-tab-mutation preflight artifact is missing.");
const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
const selectedPhase = preflight.selectedPhase;
const selectedCases = preflight.selectedCases;
const reviewedSelectedCases = selectedPhase === "all"
  ? allCases
  : selectedPhase === "remaining-eleven"
    ? allCases.slice(1)
    : selectedPhase === "remaining-four"
      ? allCases.slice(8)
      : null;
if (!preflight.safeToRun || preflight.runId !== runId || preflight.projectRef !== STAGING_PROJECT_REF ||
    !reviewedSelectedCases || JSON.stringify(selectedCases) !== JSON.stringify(reviewedSelectedCases) ||
    JSON.stringify(preflight.selectedModes) !== JSON.stringify(modes) ||
    JSON.stringify(preflight.selectedScenarios) !== JSON.stringify(scenarios)) {
  throw new Error("The exact checkout-tab-mutation preflight is invalid.");
}
const expectedCaseKeys = selectedCases.map(({ mode, scenario }) => `${mode}-${scenario}`);

const evidenceDirectory = path.join(root, "test-artifacts", "evidence");
const candidates = fs.existsSync(evidenceDirectory) ? fs.readdirSync(evidenceDirectory)
  .filter((name) => name.startsWith("checkout-tab-mutation-race-") && !name.startsWith("checkout-tab-mutation-race-cleanup-") && name.endsWith(`-${runId}.json`))
  .map((name) => {
    const fullPath = path.join(evidenceDirectory, name);
    try { return { name, fullPath, modified: fs.statSync(fullPath).mtimeMs, value: JSON.parse(fs.readFileSync(fullPath, "utf8")), error: null }; }
    catch (error) { return { name, fullPath, modified: fs.statSync(fullPath).mtimeMs, value: null, error: error instanceof Error ? error.message : String(error) }; }
  }) : [];
const corrupt = candidates.filter((entry) => entry.error || entry.value?.runId !== runId);
const valid = candidates.filter((entry) => !entry.error && entry.value?.runId === runId);
const finalCandidate = valid.find((entry) => entry.name === `checkout-tab-mutation-race-final-${runId}.json`);
const selected = finalCandidate ?? valid.sort((left, right) => right.modified - left.modified)[0];
if (!selected) throw new Error("No exact checkout-tab-mutation checkpoint exists for reconciliation.");
if (postflight && !finalCandidate) throw new Error("Postflight requires the immutable source-run final checkpoint.");
const checkpoint = selected.value;
const cases = Array.isArray(checkpoint.cases) ? checkpoint.cases : [];
const actors = checkpoint.actors;
const fixtureItemId = checkpoint.fixture?.itemId ??
  changedIds(checkpoint.itemResult ?? checkpoint.fixture?.itemResult, "inventory_items")[0];
const fixtureComboId = checkpoint.fixture?.comboId ??
  changedIds(checkpoint.comboResult ?? checkpoint.fixture?.comboResult, "combos")[0];
const caseTabIds = ids(cases.map((entry) => entry.tabId));
const candidateBillIds = ids(cases.map((entry) => entry.candidateBillId));
const customerNames = preflight.fixture.customerNames;
const billNumbers = preflight.fixture.billNumbers;
const knownEventIds = new Set();
const knownAuditIds = new Set();
function registerResult(result) {
  if (!result || typeof result !== "object") return;
  if (typeof result.event_id === "string") knownEventIds.add(result.event_id);
  changedIds(result, "operational_events").forEach((id) => knownEventIds.add(id));
  changedIds(result, "audit_logs").forEach((id) => knownAuditIds.add(id));
}
[
  checkpoint.fixture?.itemResult,
  checkpoint.fixture?.comboResult,
  checkpoint.itemResult,
  checkpoint.comboResult,
  checkpoint.comboArchive,
  checkpoint.itemArchive,
  checkpoint.cleanup?.comboArchive,
  checkpoint.cleanup?.itemArchive
].forEach(registerResult);
for (const entry of cases) {
  [entry.openResult, entry.baselineAddResult, entry.cleanup?.result, entry.responses?.checkout?.body, entry.responses?.mutation?.body]
    .forEach(registerResult);
  if (entry.responses?.checkout?.status === 200) {
    (entry.checkoutEnvelope?.payload?.payload?.audit_logs ?? []).forEach((audit) => knownAuditIds.add(String(audit.id)));
  }
  if (entry.responses?.mutation?.status === 200 && typeof entry.candidateAuditId === "string") {
    knownAuditIds.add(entry.candidateAuditId);
  }
}
const eventEntityIds = ids([...caseTabIds, ...candidateBillIds, fixtureItemId, fixtureComboId]);

const [itemsByName, combosByName, namedTabs, namedBills, tabItems, comboApplications, lines, payments,
  entityEvents, entityAudits, exactEvents, exactAudits, movements, openSessions, openTabs, appState] = await Promise.all([
  query("fixture items", client.from("inventory_items").select("id,name,stock_qty,active,archived_by_user_id,archive_reason")
    .eq("organization_id", organizationId).eq("name", itemName)),
  query("fixture combos", client.from("combos").select("id,name,type,active").eq("organization_id", organizationId).eq("name", comboName)),
  query("run-named tabs", client.from("customer_tabs").select("id,customer_name,status,close_disposition,closed_bill_id")
    .eq("organization_id", organizationId).in("customer_name", customerNames)),
  query("run-numbered bills", client.from("bills").select("id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id")
    .eq("organization_id", organizationId).in("bill_number", billNumbers)),
  caseTabIds.length ? query("tab items", client.from("customer_tab_items")
    .select("id,customer_tab_id,inventory_item_id,name,quantity,unit_price,combo_application_id,combo_id")
    .eq("organization_id", organizationId).in("customer_tab_id", caseTabIds)) : Promise.resolve([]),
  caseTabIds.length ? query("combo applications", client.from("customer_tab_combo_applications")
    .select("id,customer_tab_id,combo_id,combo_name,price").eq("organization_id", organizationId).in("customer_tab_id", caseTabIds)) : Promise.resolve([]),
  candidateBillIds.length ? query("bill lines", client.from("bill_lines")
    .select("id,bill_id,type,description,inventory_item_id,quantity,unit_price,subtotal,discount_amount,total,combo_application_id,combo_id")
    .eq("organization_id", organizationId).in("bill_id", candidateBillIds)) : Promise.resolve([]),
  candidateBillIds.length ? query("payments", client.from("payments")
    .select("id,bill_id,amount,mode,received_by_user_id,settlement_group_id,related_checkout_bill_id")
    .eq("organization_id", organizationId).in("bill_id", candidateBillIds)) : Promise.resolve([]),
  eventEntityIds.length ? query("run-entity events", client.from("operational_events")
    .select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("entity_id", eventEntityIds)) : Promise.resolve([]),
  eventEntityIds.length ? query("run-entity audits", client.from("audit_logs")
    .select("id,action,entity_type,entity_id,user_id,message").eq("organization_id", organizationId).in("entity_id", eventEntityIds)) : Promise.resolve([]),
  knownEventIds.size ? query("exact acknowledged events", client.from("operational_events")
    .select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("id", [...knownEventIds])) : Promise.resolve([]),
  knownAuditIds.size ? query("exact acknowledged audits", client.from("audit_logs")
    .select("id,action,entity_type,entity_id,user_id,message").eq("organization_id", organizationId).in("id", [...knownAuditIds])) : Promise.resolve([]),
  fixtureItemId ? query("fixture movements", client.from("stock_movements")
    .select("id,item_id,type,quantity,reason,user_id,related_bill_id").eq("organization_id", organizationId).eq("item_id", fixtureItemId)) : Promise.resolve([]),
  query("open sessions", client.from("sessions").select("id,customer_name,status").eq("organization_id", organizationId).neq("status", "closed")),
  query("open tabs", client.from("customer_tabs").select("id,customer_name,status").eq("organization_id", organizationId).eq("status", "open")),
  query("app state", client.from("app_state").select("version,data").eq("id", "primary").single())
]);

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
check(corrupt.length === 0, "One or more source-run checkpoints are corrupt or identity-mismatched.");
check(JSON.stringify(checkpoint.modes) === JSON.stringify(modes) && JSON.stringify(checkpoint.scenarios) === JSON.stringify(scenarios),
  "Checkpoint matrix selection or order is not exact.");
check(checkpoint.phase === selectedPhase && JSON.stringify(checkpoint.selectedCases) === JSON.stringify(selectedCases),
  "Checkpoint phase or selected cases differ from the immutable preflight.");
check(actors?.checkout === preflight.actors?.[0]?.actorId && actors?.mutation === preflight.actors?.[1]?.actorId &&
  actors.checkout !== actors.mutation, "Checkpoint actors do not match the exact distinct preflight actors.");
check(login.data.user.id === actors?.checkout, "Reconciliation actor differs from the source checkout actor.");
check(itemsByName.length <= 1 && (!fixtureItemId || itemsByName[0]?.id === fixtureItemId), "Fixture item identity is ambiguous or drifted.");
check(combosByName.length <= 1 && (!fixtureComboId || combosByName[0]?.id === fixtureComboId), "Fixture combo identity is ambiguous or drifted.");
check(namedTabs.every((row) => caseTabIds.includes(row.id)), "A run-named tab lacks an acknowledged exact ID.");
check(namedBills.every((row) => candidateBillIds.includes(row.id)), "A run-numbered bill lacks an acknowledged candidate ID.");
check(openSessions.length === 0, "An open session exists outside this tab-only recovery scope.");
check(openTabs.every((row) => caseTabIds.includes(row.id)), "An open tab exists outside exact acknowledged source identities.");
const acknowledgedKeys = cases.map((entry) => `${entry.mode}-${entry.scenario}`);
check(acknowledgedKeys.every((key, index) => key === expectedCaseKeys[index]), "Acknowledged cases are not an exact ordered matrix prefix.");

const events = [...entityEvents];
for (const row of exactEvents) if (!events.some((entry) => entry.id === row.id)) events.push(row);
const audits = [...entityAudits];
for (const row of exactAudits) if (!audits.some((entry) => entry.id === row.id)) audits.push(row);

function validateChangedRows(label, result, expected) {
  const actualKeys = Object.keys(result?.changed_rows ?? {}).sort();
  const expectedKeys = Object.keys(expected).sort();
  check(actualKeys.join() === expectedKeys.join(), `${label}: changed_rows collections are not exact.`);
  for (const [collection, expectedIds] of Object.entries(expected)) {
    check(changedIds(result, collection).join() === ids(expectedIds).join(),
      `${label}: changed_rows.${collection} identities are not exact.`);
  }
}
function validateAudit(label, auditId, expected, actor) {
  const matching = audits.filter((row) => row.id === auditId);
  check(matching.length === 1 && matching[0].action === expected.action &&
    matching[0].entity_type === expected.entityType && matching[0].entity_id === expected.entityId &&
    matching[0].message === expected.message && matching[0].user_id === actor,
  `${label}: audit identity, action, message, or actor differs.`);
}
function validateOperationalLifecycle(
  label,
  result,
  command,
  eventType,
  actor,
  expectedChangedRows,
  expectedMetadata,
  expectedAudit = (_result, payload) => payload?.auditLog
) {
  if (!result) return;
  const envelope = command?.payload;
  const payload = envelope?.payload;
  const event = events.find((row) => row.id === result.event_id);
  check(Boolean(envelope && result.organization_id === organizationId && result.mutation_id === envelope.mutation_id &&
    result.entity_type === envelope.entity_type && result.entity_id === envelope.entity_id),
  `${label}: acknowledgement does not match its exact captured command identity.`);
  check(Boolean(event && event.event_type === eventType && event.entity_type === envelope?.entity_type &&
    event.entity_id === envelope?.entity_id && event.created_by === actor &&
    event.metadata?.mutation_id === envelope?.mutation_id && event.metadata?.mutation_kind === envelope?.mutation_kind),
  `${label}: event type, entity, mutation, or actor differs.`);
  validateChangedRows(label, result, expectedChangedRows(result, payload));
  const metadata = expectedMetadata(result, payload);
  for (const [field, expectedValue] of Object.entries(metadata)) {
    check(stable(event?.metadata?.[field]) === stable(expectedValue),
      `${label}: event metadata.${field} differs from the captured command or acknowledgement.`);
  }
  if (event?.metadata?.changed_rows) {
    const withoutSelf = Object.fromEntries(Object.entries(result.changed_rows ?? {})
      .filter(([key]) => key !== "operational_events"));
    check(stable(event.metadata.changed_rows) === stable(withoutSelf),
      `${label}: event changed_rows differs from the acknowledgement without its self-reference.`);
  }
  const audit = expectedAudit(result, payload);
  if (audit) validateAudit(label, audit.id, audit, actor);
}
function validateAdminLifecycle(label, result, expected) {
  if (!result) return;
  const event = events.find((row) => row.id === result.event_id);
  check(result.organization_id === organizationId && result.entity_type === "admin_data" &&
    typeof result.entity_id === "string" && typeof result.mutation_id === "string",
  `${label}: admin acknowledgement identity is incomplete.`);
  check(Boolean(event && event.event_type === "admin_data_committed" && event.entity_type === "admin_data" &&
    event.entity_id === result.entity_id && event.created_by === actors.checkout &&
    event.metadata?.mutation_id === result.mutation_id && event.metadata?.mutation_kind === "commitAdminDataChange" &&
    stable(event.metadata?.changed_rows) === stable(result.changed_rows)),
  `${label}: admin lifecycle event identity, actor, or changed_rows differs.`);
  validateChangedRows(label, result, expected.changedRows);
  const auditIdsForResult = changedIds(result, "audit_logs");
  check(auditIdsForResult.length === 1, `${label}: admin audit cardinality is not exact.`);
  if (auditIdsForResult.length === 1) validateAudit(label, auditIdsForResult[0], expected.audit, actors.checkout);
}

const itemCreateResult = checkpoint.fixture?.itemResult ?? checkpoint.itemResult;
const comboCreateResult = checkpoint.fixture?.comboResult ?? checkpoint.comboResult;
const comboArchiveResult = checkpoint.comboArchive ?? checkpoint.cleanup?.comboArchive;
const itemArchiveResult = checkpoint.itemArchive ?? checkpoint.cleanup?.itemArchive;
const itemArchiveReason = checkpoint.archiveReason ?? checkpoint.cleanup?.archiveReason;
if (itemCreateResult && fixtureItemId) validateAdminLifecycle("fixture item creation", itemCreateResult, {
  changedRows: { inventory_items: [fixtureItemId], sale_variants: [fixtureItemId], audit_logs: changedIds(itemCreateResult, "audit_logs") },
  audit: { action: "inventory_created", entityType: "inventory_item", entityId: fixtureItemId, message: `Created ${itemName}.` }
});
if (comboCreateResult && fixtureComboId) validateAdminLifecycle("fixture combo creation", comboCreateResult, {
  changedRows: { combos: [fixtureComboId], audit_logs: changedIds(comboCreateResult, "audit_logs") },
  audit: { action: "combo_created", entityType: "combo", entityId: fixtureComboId, message: `Created combo ${comboName}.` }
});
if (comboArchiveResult && fixtureComboId) validateAdminLifecycle("fixture combo archive", comboArchiveResult, {
  changedRows: { combos: [fixtureComboId], audit_logs: changedIds(comboArchiveResult, "audit_logs") },
  audit: { action: "combo_archived", entityType: "combo", entityId: fixtureComboId, message: `Archived combo ${comboName}.` }
});
if (itemArchiveResult && fixtureItemId) validateAdminLifecycle("fixture item archive", itemArchiveResult, {
  changedRows: { inventory_items: [fixtureItemId], sale_variants: [fixtureItemId], audit_logs: changedIds(itemArchiveResult, "audit_logs") },
  audit: {
    action: "inventory_archived", entityType: "inventory_item", entityId: fixtureItemId,
    message: `Archived ${itemName}. Reason: ${itemArchiveReason}.`
  }
});

const classifications = [];
const mutationResults = [];
for (const entry of cases) {
  const key = `${entry.mode}-${entry.scenario}`;
  const contract = modeContracts[entry.mode];
  check(Boolean(contract) && expectedCaseKeys.includes(key), `${key}: mode/scenario is outside the reviewed matrix.`);
  registerResult(entry.openResult);
  registerResult(entry.baselineAddResult);
  registerResult(entry.cleanup?.result);
  const checkoutEnvelope = entry.checkoutEnvelope?.payload;
  const operationalEnvelope = entry.operationalEnvelope?.payload;
  const checkoutResponse = entry.responses?.checkout;
  const operationalResponse = entry.responses?.mutation;
  const primaryBill = checkoutEnvelope?.payload?.primary_bill;
  const expectedLines = primaryBill?.lines ?? [];
  const expectedPayments = checkoutEnvelope?.payload?.payments ?? [];
  const expectedCheckoutAudits = checkoutEnvelope?.payload?.audit_logs ?? [];
  const expectedMovements = checkoutEnvelope?.payload?.stock_movements ?? [];
  const tab = namedTabs.find((row) => row.id === entry.tabId) ?? null;
  const bill = namedBills.find((row) => row.id === entry.candidateBillId) ?? null;
  const checkoutEvent = events.find((row) => row.metadata?.mutation_id === entry.checkoutMutationId) ?? null;
  const operationalEvent = events.find((row) => row.metadata?.mutation_id === entry.operationalMutationId) ?? null;
  const caseLines = lines.filter((row) => row.bill_id === entry.candidateBillId);
  const casePayments = payments.filter((row) => row.bill_id === entry.candidateBillId);
  const caseItems = tabItems.filter((row) => row.customer_tab_id === entry.tabId);
  const caseCombos = comboApplications.filter((row) => row.customer_tab_id === entry.tabId);
  const operationalAudit = entry.candidateAuditId ? audits.filter((row) => row.id === entry.candidateAuditId) : [];
  const checkoutAudits = audits.filter((row) => expectedCheckoutAudits.some((expected) => expected.id === row.id));
  const openAudit = entry.openCommand?.payload?.payload?.auditLog;
  const baselineAudit = entry.baselineAddCommand?.payload?.payload?.auditLog;
  validateOperationalLifecycle(`${key} tab open`, entry.openResult, entry.openCommand, "open_customer_tab", actors.checkout,
    (result, payload) => ({
      customer_tabs: [entry.tabId], customers: [payload?.customer?.id],
      audit_logs: [openAudit?.id], operational_events: [result.event_id]
    }), (_result, payload) => ({
      customer_tab_id: entry.tabId,
      customer_id: payload?.customer?.id,
      audit_log_id: payload?.auditLog?.id
    }));
  validateOperationalLifecycle(`${key} baseline item add`, entry.baselineAddResult, entry.baselineAddCommand,
    "add_customer_tab_item", actors.checkout, (result, payload) => ({
      customer_tabs: [entry.tabId], customer_tab_items: [payload?.line?.id],
      audit_logs: [baselineAudit?.id], operational_events: [result.event_id]
    }), (_result, payload) => ({ line_id: payload?.line?.id, audit_log_id: payload?.auditLog?.id }));
  if (entry.cleanup?.result) {
    const cleanupAudit = entry.cleanup.command?.payload?.payload?.auditLog;
    validateOperationalLifecycle(`${key} rejected operational-winner cleanup`, entry.cleanup.result, entry.cleanup.command,
      "reject_customer_tab", actors.mutation, (result) => ({
        customer_tabs: [entry.tabId], audit_logs: [cleanupAudit?.id], operational_events: [result.event_id]
      }), (result) => ({
        app_state_version: result.app_state_version,
        released_continued_from_session_ids: []
      }), (_result, payload) => ({
        ...payload.auditLog,
        message: `Rejected customer tab for ${entry.customerName}. Reason: ${payload.tab.closeReason}`
      }));
  }
  let mutationResult = null;
  if (entry.checkoutMutationId) {
    mutationResult = await query(`${key} mutation result`, client.rpc("get_financial_mutation_result", { payload: {
      organization_id: organizationId,
      mutation_id: entry.checkoutMutationId,
      mutation_kind: "commitCheckoutBill"
    } }));
    mutationResults.push({ mutationId: entry.checkoutMutationId, result: mutationResult });
  }
  const financialParts = [Boolean(bill), Boolean(checkoutEvent), Boolean(mutationResult)];
  const financialEffect = financialParts.some(Boolean);
  const operationalEffect = Boolean(operationalEvent);
  check(!(financialEffect && operationalEffect), `${key}: both competing effects exist.`);
  check(!financialEffect || financialParts.every(Boolean), `${key}: financial effect is partial.`);
  if (checkoutResponse || operationalResponse) {
    check([200, 400].includes(checkoutResponse?.status) && [200, 400].includes(operationalResponse?.status) &&
      Number(checkoutResponse.status === 200) + Number(operationalResponse.status === 200) === 1,
    `${key}: immutable response checkpoint is not one 200 winner and one 400 loser.`);
  }
  if (financialEffect) {
    registerResult(checkoutResponse?.body);
    check(checkoutResponse?.status === 200 && operationalResponse?.status === 400, `${key}: financial database winner differs from response checkpoint.`);
    check(bill.id === primaryBill?.id && bill.bill_number === primaryBill?.billNumber && bill.status === primaryBill?.status &&
      Number(bill.total) === Number(primaryBill?.total) && Number(bill.amount_paid) === Number(primaryBill?.amountPaid) &&
      Number(bill.amount_due) === Number(primaryBill?.amountDue) && bill.issued_by_user_id === actors.checkout,
    `${key}: canonical bill fields or actor differ from the captured checkout.`);
    check(ids(caseLines.map((row) => row.id)).join() === ids(expectedLines.map((row) => row.id)).join(), `${key}: bill-line IDs differ.`);
    for (const expected of expectedLines) {
      const actual = caseLines.find((row) => row.id === expected.id);
      check(Boolean(actual && actual.type === expected.type && actual.description === expected.description &&
        actual.inventory_item_id === (expected.inventoryItemId ?? null) && Number(actual.quantity) === Number(expected.quantity) &&
        Number(actual.unit_price) === Number(expected.unitPrice) && Number(actual.subtotal) === Number(expected.subtotal) &&
        Number(actual.discount_amount) === Number(expected.discountAmount) && Number(actual.total) === Number(expected.total) &&
        actual.combo_application_id === (expected.comboApplicationId ?? null) && actual.combo_id === (expected.comboId ?? null)),
      `${key}: bill line ${expected.id} differs from the captured canonical values.`);
    }
    check(ids(casePayments.map((row) => row.id)).join() === ids(expectedPayments.map((row) => row.id)).join(), `${key}: payment IDs differ.`);
    for (const expected of expectedPayments) {
      const actual = casePayments.find((row) => row.id === expected.id);
      check(Boolean(actual && actual.bill_id === expected.billId && actual.mode === expected.mode &&
        Number(actual.amount) === Number(expected.amount) && actual.received_by_user_id === actors.checkout &&
        actual.settlement_group_id === (expected.settlementGroupId ?? null) &&
        actual.related_checkout_bill_id === (expected.relatedCheckoutBillId ?? null)), `${key}: payment ${expected.id} differs.`);
    }
    check(checkoutEvent.event_type === "financial_checkout_committed_v2" && checkoutEvent.entity_type === "customer_tab" &&
      checkoutEvent.entity_id === entry.tabId && checkoutEvent.created_by === actors.checkout &&
      checkoutEvent.metadata?.mutation_id === entry.checkoutMutationId &&
      checkoutEvent.metadata?.mutation_kind === "commitCheckoutBill", `${key}: financial event identity/type/actor differs.`);
    check(mutationResult?.bill_id === bill.id && mutationResult?.bill_number === bill.bill_number &&
      mutationResult?.event_id === checkoutEvent.id && mutationResult?.mutation_id === entry.checkoutMutationId,
    `${key}: canonical mutation result differs from bill/event identity.`);
    check(tab?.status === "closed" && tab?.close_disposition === "billed" && tab?.closed_bill_id === bill.id,
      `${key}: financial winner tab closure is incorrect.`);
    check(checkoutAudits.length === expectedCheckoutAudits.length, `${key}: checkout audit cardinality differs.`);
    for (const expected of expectedCheckoutAudits) {
      const actual = checkoutAudits.find((row) => row.id === expected.id);
      const expectedMessage = expected.action === "bill_issued"
        ? `Issued ${bill.bill_number}.`
        : expected.message;
      check(Boolean(actual && actual.action === expected.action && actual.entity_type === expected.entityType &&
        actual.entity_id === expected.entityId && actual.message === expectedMessage &&
        actual.user_id === actors.checkout), `${key}: checkout audit ${expected.id} fields or actor differ.`);
    }
    check(operationalAudit.length === 0, `${key}: losing operational audit exists.`);
    check(caseCombos.length === 0 && caseItems.length === 1 && caseItems[0].id === entry.baselineLineId && Number(caseItems[0].quantity) === 1,
      `${key}: losing operational command changed source item/combo rows.`);
    expectedCheckoutAudits.forEach((audit) => knownAuditIds.add(String(audit.id)));
    expectedMovements.forEach((movement) => {
      const actual = movements.find((row) => row.id === movement.id);
      check(Boolean(actual && actual.item_id === movement.itemId && actual.type === movement.type &&
        Number(actual.quantity) === Number(movement.quantity) && actual.user_id === actors.checkout &&
        actual.related_bill_id === movement.relatedBillId && actual.reason === movement.reason),
      `${key}: sale movement ${movement.id} differs.`);
    });
  } else if (operationalEffect) {
    registerResult(operationalResponse?.body);
    check(checkoutResponse?.status === 400 && operationalResponse?.status === 200 && mutationResult === null,
      `${key}: operational database winner differs from response/mutation evidence.`);
    check(operationalEnvelope?.mutation_kind === contract.mutationKind && operationalEnvelope?.entity_id === entry.tabId &&
      operationalEnvelope?.user_id === actors.mutation, `${key}: operational envelope identity/kind/actor differs.`);
    check(operationalEvent.event_type === contract.eventType && operationalEvent.entity_type === "customer_tab" &&
      operationalEvent.entity_id === entry.tabId && operationalEvent.created_by === actors.mutation &&
      operationalEvent.metadata?.mutation_id === entry.operationalMutationId &&
      operationalEvent.metadata?.mutation_kind === contract.mutationKind,
    `${key}: operational event identity/type/actor differs.`);
    const expectedOperationalMetadata = entry.mode === "add_item"
      ? { line_id: entry.baselineLineId, audit_log_id: operationalEnvelope.payload?.auditLog?.id }
      : entry.mode === "update_item"
        ? { line_id: operationalEnvelope.payload?.lineId, quantity: operationalEnvelope.payload?.quantity }
        : entry.mode === "remove_item"
          ? { line_id: operationalEnvelope.payload?.lineId, audit_log_id: operationalEnvelope.payload?.auditLog?.id }
          : {
              combo_application_id: operationalEnvelope.payload?.comboApplication?.id,
              customer_tab_item_ids: (operationalEnvelope.payload?.items ?? []).map((row) => row.id),
              audit_log_id: operationalEnvelope.payload?.auditLog?.id
            };
    for (const [field, expectedValue] of Object.entries(expectedOperationalMetadata)) {
      check(stable(operationalEvent.metadata?.[field]) === stable(expectedValue),
        `${key}: operational event metadata.${field} differs from the captured command.`);
    }
    check(changedIds(operationalResponse.body, "operational_events").join() === operationalEvent.id,
      `${key}: operational changed_rows event is not exact.`);
    check(changedIds(operationalResponse.body, "customer_tabs").join() === entry.tabId,
      `${key}: operational changed_rows tab identity is not exact.`);
    check(changedIds(operationalResponse.body, "stock_movements").length === 0,
      `${key}: operational source mutation unexpectedly reports stock movement rows.`);
    check(operationalAudit.length === contract.auditCount, `${key}: operational audit cardinality differs.`);
    if (contract.auditCount === 1) {
      check(operationalAudit[0].action === contract.auditAction && operationalAudit[0].entity_type === "customer_tab" &&
        operationalAudit[0].entity_id === entry.tabId && operationalAudit[0].user_id === actors.mutation &&
        operationalAudit[0].message === operationalEnvelope.payload?.auditLog?.message,
      `${key}: operational audit action/entity/actor differs.`);
      check(changedIds(operationalResponse.body, "audit_logs").join() === entry.candidateAuditId,
        `${key}: operational changed_rows audit is not exact.`);
      knownAuditIds.add(entry.candidateAuditId);
    } else {
      check(changedIds(operationalResponse.body, "audit_logs").length === 0, `${key}: update unexpectedly reports an audit.`);
    }
    const expectedRaceReservation = contract.raceReservation;
    const recordedRaceReservation = entry.database?.logicalReservation;
    check(Number(recordedRaceReservation) === expectedRaceReservation,
      `${key}: immutable race checkpoint lacks exact logical reservation arithmetic.`);
    if (entry.mode === "add_item" || entry.mode === "update_item") {
      const expectedLineId = entry.mode === "add_item" ? entry.baselineLineId : operationalEnvelope.payload?.lineId;
      const checkpointItems = entry.database?.tabItems ?? [];
      check(changedIds(operationalResponse.body, "customer_tab_items").join() === expectedLineId &&
        changedIds(operationalResponse.body, "customer_tab_combo_applications").length === 0,
      `${key}: item add/update changed_rows is not exact.`);
      check(caseCombos.length === 0 && checkpointItems.length === 1 &&
        checkpointItems[0].id === expectedLineId && stable(caseItems) === stable(checkpointItems),
        `${key}: item add/update canonical row is incorrect.`);
    } else if (entry.mode === "remove_item") {
      check(changedIds(operationalResponse.body, "customer_tab_items").join() === entry.baselineLineId &&
        changedIds(operationalResponse.body, "customer_tab_combo_applications").length === 0,
      `${key}: item removal changed_rows is not exact.`);
      check(caseCombos.length === 0 && caseItems.length === 0, `${key}: removed item remains present.`);
    } else {
      const expectedCombo = operationalEnvelope.payload?.comboApplication;
      const expectedComboItems = operationalEnvelope.payload?.items ?? [];
      check(changedIds(operationalResponse.body, "customer_tab_combo_applications").join() === expectedCombo?.id &&
        changedIds(operationalResponse.body, "customer_tab_items").join() === ids(expectedComboItems.map((row) => row.id)).join(),
      `${key}: combo changed_rows is not exact.`);
      check(caseCombos.length === 1 && caseCombos[0].id === expectedCombo?.id && caseCombos[0].combo_id === expectedCombo?.comboId &&
        caseCombos[0].combo_name === expectedCombo?.comboName && Number(caseCombos[0].price) === Number(expectedCombo?.price),
      `${key}: combo application row differs.`);
      check(ids(caseItems.map((row) => row.id)).join() === ids([entry.baselineLineId, ...expectedComboItems.map((row) => row.id)]).join(),
        `${key}: combo item IDs differ.`);
      for (const expected of expectedComboItems) {
        const actual = caseItems.find((row) => row.id === expected.id);
        check(Boolean(actual && actual.customer_tab_id === entry.tabId &&
          actual.inventory_item_id === expected.inventoryItemId && actual.name === expected.name &&
          Number(actual.quantity) === Number(expected.quantity) && Number(actual.unit_price) === Number(expected.unitPrice) &&
          actual.combo_application_id === (expected.comboApplicationId ?? null) &&
          actual.combo_id === (expected.comboId ?? null)), `${key}: combo item ${expected.id} differs.`);
      }
    }
    check(tab?.status === "open" || (tab?.status === "closed" && tab?.close_disposition === "rejected" && tab?.closed_bill_id === null),
      `${key}: operational winner tab is neither open nor exact rejected cleanup.`);
  } else {
    check(!entry.responses, `${key}: response evidence exists but neither canonical effect exists.`);
  }
  if (entry.winner) check(entry.winner === (financialEffect ? "checkout" : operationalEffect ? "mutation" : null),
    `${key}: recorded winner differs from canonical database effect.`);
  classifications.push({
    key, mode: entry.mode, scenario: entry.scenario, tabId: entry.tabId ?? null,
    checkoutMutationId: entry.checkoutMutationId ?? null, operationalMutationId: entry.operationalMutationId ?? null,
    candidateBillId: entry.candidateBillId ?? null, winner: financialEffect ? "checkout" : operationalEffect ? "mutation" : null,
    financialEffect, operationalEffect, mutationResult, tab, bill, lines: caseLines, payments: casePayments,
    items: caseItems, comboApplications: caseCombos, checkoutEvent, operationalEvent, operationalAudit
  });
}

check(ids(events.map((row) => row.id)).join() === ids([...knownEventIds]).join(), "Unexpected or missing run-entity operational event exists.");
check(ids(audits.map((row) => row.id)).join() === ids([...knownAuditIds]).join(), "Unexpected or missing run-entity audit exists.");
const checkoutWinnerKeys = new Set(classifications.filter((entry) => entry.winner === "checkout").map((entry) => entry.key));
const expectedMovementIds = ids(cases.filter((entry) => checkoutWinnerKeys.has(`${entry.mode}-${entry.scenario}`))
  .flatMap((entry) => entry.checkoutEnvelope?.payload?.payload?.stock_movements?.map((row) => row.id) ?? []));
check(ids(movements.map((row) => row.id)).join() === expectedMovementIds.join(), "Fixture stock movement IDs differ from checkout winners.");
check(movements.every((row) => row.type === "sale" && Number(row.quantity) === -1 && row.user_id === actors?.checkout && candidateBillIds.includes(row.related_bill_id)),
  "Fixture contains a non-sale, wrong-quantity, wrong-actor, or unrelated movement.");
const checkoutWinnerCount = classifications.filter((entry) => entry.winner === "checkout").length;
check(!itemsByName.length || Number(itemsByName[0].stock_qty) === preflight.fixture.openingStock - checkoutWinnerCount,
  "Physical stock does not equal opening stock minus exact checkout winners.");

const currentAppState = appStateIdentity(appState);
const acknowledgedAppStateVersions = collectAcknowledgedAppStateVersions(checkpoint, [preflight.appState.version]);
const latestAcknowledgedAppStateVersion = Math.max(...acknowledgedAppStateVersions);
check(currentAppState.version === latestAcknowledgedAppStateVersion,
  "Current app_state version differs from the latest acknowledged compatibility-writing response.");
if (checkpoint.latestCompatibility?.version === latestAcknowledgedAppStateVersion) {
  check(stable(checkpoint.latestCompatibility) === stable(currentAppState),
    "Current app_state differs from the latest fully hydrated compatibility checkpoint.");
} else {
  check(!checkpoint.latestCompatibility || checkpoint.latestCompatibility.version < latestAcknowledgedAppStateVersion,
    "Compatibility checkpoint ordering is invalid.");
}
if (postflight) {
  check(acknowledgedKeys.length === expectedCaseKeys.length && classifications.every((entry) => entry.winner),
    `Postflight does not contain all ${expectedCaseKeys.length} selected classified race cases.`);
  check(openSessions.length === 0 && openTabs.length === 0, "Postflight floor is not empty.");
  check(itemsByName.length === 1 && itemsByName[0].active === false, "Postflight item is not exactly archived.");
  check(combosByName.length === 1 && combosByName[0].active === false, "Postflight combo is not exactly archived.");
  check(stable(checkpoint.final?.appState) === stable(currentAppState), "Final checkpoint app_state differs from current state.");
}

const snapshot = {
  item: itemsByName,
  combo: combosByName,
  tabs: namedTabs,
  tabItems,
  comboApplications,
  bills: namedBills,
  lines,
  payments,
  movements,
  events,
  audits,
  mutationResults,
  appState: currentAppState
};
const safeForIdentityBoundCleanup = !postflight && failures.length === 0 && openSessions.length === 0 &&
  openTabs.every((row) => caseTabIds.includes(row.id));
const report = {
  status: failures.length === 0 ? (postflight ? "postflight-passed" : "reconciled") : "blocked",
  runId,
  checkedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  organizationId,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  safeForIdentityBoundCleanup,
  sourceCheckpoint: path.relative(root, selected.fullPath),
  sourceCheckpointSha256: createHash("sha256").update(fs.readFileSync(selected.fullPath)).digest("hex"),
  postflight,
  failures,
  actors,
  modes,
  scenarios,
  selectedPhase,
  selectedCases,
  checkpointCases: cases,
  fixture: { itemId: fixtureItemId ?? null, itemName, comboId: fixtureComboId ?? null, comboName },
  appState: currentAppState,
  latestAcknowledgedAppStateVersion,
  openFloor: { sessions: openSessions, tabs: openTabs },
  acknowledgedCaseKeys: acknowledgedKeys,
  classifications,
  snapshot
};
const outputDirectory = path.join(root, "test-artifacts", "reconciliation");
fs.mkdirSync(outputDirectory, { recursive: true });
const baseOutputPath = path.join(outputDirectory,
  `checkout-tab-mutation-race-${postflight ? "postflight" : "recovery"}-${runId}.json`);
let reconciliationId = null;
let outputPath = baseOutputPath;
if (fs.existsSync(baseOutputPath)) {
  if (!env.E2E_RECONCILIATION_ID?.trim()) {
    throw new Error("A fresh E2E_RECONCILIATION_ID is required to preserve the prior immutable reconciliation artifact.");
  }
  reconciliationId = sanitizeRunId(env.E2E_RECONCILIATION_ID);
  if (reconciliationId === runId) throw new Error("Reconciliation identity must differ from the source run identity.");
  outputPath = path.join(outputDirectory,
    `checkout-tab-mutation-race-${postflight ? "postflight" : "recovery"}-${runId}-${reconciliationId}.json`);
  if (fs.existsSync(outputPath)) throw new Error("Reconciliation identity collides with an existing immutable artifact.");
}
report.reconciliationId = reconciliationId;
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ artifact: path.relative(root, outputPath), report }, null, 2));
if (failures.length) process.exitCode = 2;
