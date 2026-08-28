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

const runId = sanitizeRunId(env.E2E_REPLACEMENT_RACE_RECONCILE_RUN_ID || env.E2E_RUN_ID);
const organizationId = "org-primary";
const evidenceDirectory = path.join(root, "test-artifacts", "evidence");
const candidates = [
  "final",
  "cleanup-acknowledged",
  "race-responses",
  "race-prepared",
  "reservation-created",
  "checkout-item-added",
  "checkout-tab-opened",
  "original-committed",
  "original-prepared",
  "source-item-added",
  "source-tab-opened",
  "fixture-created",
  "setup-prepared"
].map((phase) => ({
  phase,
  path: path.join(evidenceDirectory, `checkout-replacement-race-${phase}-${runId}.json`)
}));
const selected = candidates.find((candidate) => fs.existsSync(candidate.path));
if (!selected) throw new Error("No immutable checkout-replacement race checkpoint exists for this identity.");
const evidence = JSON.parse(fs.readFileSync(selected.path, "utf8"));
if (evidence.runId !== runId) throw new Error("Checkpoint identity mismatch.");

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Reconciliation is locked to the approved staging project.");
}
async function authenticate(slot) {
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const lookup = await client.functions.invoke("resolve-login-email", {
    body: { username: env[`E2E_USER_${slot}`].trim() }
  });
  if (lookup.error || !lookup.data?.email) throw new Error(`Unable to resolve staging slot ${slot}.`);
  const login = await client.auth.signInWithPassword({ email: lookup.data.email, password: env[`E2E_PASSWORD_${slot}`] });
  if (login.error || !login.data.user) throw new Error(`Unable to authenticate staging slot ${slot}.`);
  const role = await client.rpc("current_user_org_role", { target_organization_id: organizationId });
  if (role.error || role.data !== "admin") throw new Error(`Staging slot ${slot} is not an authoritative admin.`);
  return { client, actorId: login.data.user.id };
}
const origin = await authenticate("A");
const observer = await authenticate("B");
const supabase = origin.client;
const originActorId = origin.actorId;
const observerActorId = observer.actorId;
assert(
  evidence.actors?.origin === originActorId && evidence.actors?.observer === observerActorId,
  "Current staging actors do not match the immutable execution actors."
);

async function expandCanonicalEvidence(mutationStatuses, events, audits) {
  const canonicalEventIds = mutationStatuses.filter(Boolean).map((status) => status.event_id).filter(Boolean);
  const canonicalAuditIds = mutationStatuses.filter(Boolean).flatMap((status) => status.changed_rows?.audit_logs ?? []);
  const missingEventIds = canonicalEventIds.filter((id) => !events.data.some((row) => row.id === id));
  const missingAuditIds = canonicalAuditIds.filter((id) => !audits.data.some((row) => row.id === id));
  if (missingEventIds.length > 0) {
    const additionalEvents = await supabase.from("operational_events")
      .select("id,event_type,entity_type,entity_id,created_by,metadata")
      .eq("organization_id", organizationId)
      .in("id", missingEventIds);
    if (additionalEvents.error) throw new Error(`Canonical recovery event query failed: ${additionalEvents.error.message}`);
    events.data.push(...additionalEvents.data);
  }
  if (missingAuditIds.length > 0) {
    const additionalAudits = await supabase.from("audit_logs")
      .select("id,action,entity_type,entity_id,message,user_id")
      .eq("organization_id", organizationId)
      .in("id", missingAuditIds);
    if (additionalAudits.error) throw new Error(`Canonical recovery audit query failed: ${additionalAudits.error.message}`);
    audits.data.push(...additionalAudits.data);
  }
}

function canonicalRecoveryReferencesAreExact({ mutationIds, mutationStatuses, bills, lines, payments, movements, audits, events, tabs }) {
  return mutationStatuses.every((status, index) => {
    if (!status) return true;
    const event = events.find((row) => row.id === status.event_id);
    const expectedActor = status.mutation_id === evidence.replacementMutationId ? observerActorId : originActorId;
    return status.mutation_id === mutationIds[index] &&
      bills.some((row) => row.id === status.bill_id) &&
      event?.metadata?.mutation_id === status.mutation_id &&
      event.created_by === expectedActor &&
      (status.changed_rows?.bills ?? []).every((id) => bills.some((row) => row.id === id)) &&
      (status.changed_rows?.bill_lines ?? []).every((id) => lines.some((row) => row.id === id)) &&
      (status.changed_rows?.payments ?? []).every((id) => payments.some((row) => row.id === id)) &&
      (status.changed_rows?.stock_movements ?? []).every((id) => movements.some((row) => row.id === id)) &&
      (status.changed_rows?.audit_logs ?? []).every((id) => audits.some((row) => row.id === id)) &&
      (status.changed_rows?.customer_tabs ?? []).every((id) => tabs.some((row) => row.id === id));
  });
}

const detailedPhases = new Set(["final", "cleanup-acknowledged", "race-responses", "race-prepared"]);
if (!detailedPhases.has(selected.phase)) {
  const billNumbers = ["ORIGINAL", "CHECKOUT", "REPLACEMENT"].map((suffix) => `BILL-QA-REPLACE-RACE-${runId}-${suffix}`);
  const customerNames = [`QA Replacement Source ${runId}`, `QA Replacement Checkout ${runId}`];
  const acknowledgedResults = [
    evidence.itemResult,
    evidence.sourceTabResult,
    evidence.sourceItemResult,
    evidence.originalResponse,
    evidence.checkoutTabResult,
    evidence.checkoutItemResult
  ].filter(Boolean);
  const eventIds = acknowledgedResults.map((result) => result.event_id).filter(Boolean);
  const auditIds = acknowledgedResults.flatMap((result) => result.changed_rows?.audit_logs ?? []);
  const mutationIds = [evidence.originalMutationId, evidence.checkoutMutationId, evidence.replacementMutationId].filter(Boolean);
  const [items, bills, tabs, events, audits, openSessions, openTabs, appState, mutationStatuses] = await Promise.all([
    supabase.from("inventory_items").select("id,name,stock_qty,active,archived_by_user_id,archive_reason").eq("organization_id", organizationId).eq("name", `QA Replacement Race ${runId}`),
    supabase.from("bills").select("id,bill_number,status,total,amount_paid,amount_due,replacement_of_bill_id,replaced_by_bill_id,replace_reason,replaced_by_user_id,issued_by_user_id").eq("organization_id", organizationId).in("bill_number", billNumbers),
    supabase.from("customer_tabs").select("id,customer_name,status,close_disposition,closed_bill_id,close_reason").eq("organization_id", organizationId).in("customer_name", customerNames),
    supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("id", eventIds.length ? eventIds : ["missing-recovery-event"]),
    supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("id", auditIds.length ? auditIds : ["missing-recovery-audit"]),
    supabase.from("sessions").select("id,status,customer_name").eq("organization_id", organizationId).neq("status", "closed"),
    supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
    supabase.from("app_state").select("version,data").eq("id", "primary").single(),
    Promise.all(mutationIds.map(mutationStatus))
  ]);
  for (const [label, result] of Object.entries({ items, bills, tabs, events, audits, openSessions, openTabs, appState })) {
    if (result.error) throw new Error(`${label} recovery query failed: ${result.error.message}`);
  }
  await expandCanonicalEvidence(mutationStatuses, events, audits);
  let tabItems = { data: [], error: null };
  let movements = { data: [], error: null };
  if (items.data.length === 1) {
    [tabItems, movements] = await Promise.all([
      supabase.from("customer_tab_items").select("id,customer_tab_id,inventory_item_id,quantity,unit_price").eq("organization_id", organizationId).eq("inventory_item_id", items.data[0].id),
      supabase.from("stock_movements").select("id,item_id,type,quantity,related_bill_id,user_id").eq("organization_id", organizationId).eq("item_id", items.data[0].id)
    ]);
    if (tabItems.error || movements.error) throw new Error("Fixture recovery detail query failed.");
  }
  let lines = { data: [], error: null };
  let payments = { data: [], error: null };
  if (bills.data.length > 0) {
    [lines, payments] = await Promise.all([
      supabase.from("bill_lines").select("id,bill_id,type,inventory_item_id,quantity,unit_price,total").eq("organization_id", organizationId).in("bill_id", bills.data.map((row) => row.id)),
      supabase.from("payments").select("id,bill_id,mode,amount,received_by_user_id").eq("organization_id", organizationId).in("bill_id", bills.data.map((row) => row.id))
    ]);
    if (lines.error || payments.error) throw new Error("Financial recovery detail query failed.");
  }
  const exactOpenTabs = openTabs.data.every((row) => customerNames.includes(row.customer_name));
  const canonicalReferencesExact = canonicalRecoveryReferencesAreExact({
    mutationIds,
    mutationStatuses,
    bills: bills.data,
    lines: lines.data,
    payments: payments.data,
    movements: movements.data,
    audits: audits.data,
    events: events.data,
    tabs: tabs.data
  });
  const safeForIdentityBoundCleanup =
    openSessions.data.length === 0 && exactOpenTabs && items.data.length === 1 &&
    bills.data.every((row) => billNumbers.includes(row.bill_number)) && canonicalReferencesExact;
  const recovery = {
    runId,
    inspectedAt: new Date().toISOString(),
    projectRef: STAGING_PROJECT_REF,
    sourceCheckpoint: path.relative(root, selected.path),
    classification: `${selected.phase}_setup_incomplete`,
    actors: { origin: originActorId, observer: observerActorId },
    items: items.data,
    bills: bills.data,
    lines: lines.data,
    payments: payments.data,
    tabs: tabs.data,
    tabItems: tabItems.data,
    movements: movements.data,
    events: events.data,
    audits: audits.data,
    mutationIds,
    mutationStatuses,
    openSessions: openSessions.data,
    openTabs: openTabs.data,
    appState: { version: appState.data.version, hash: createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex") },
    safeForIdentityBoundCleanup,
    safeForAutomaticRetry: false,
    productionAllowed: false
  };
  const directory = path.join(root, "test-artifacts", "reconciliation");
  fs.mkdirSync(directory, { recursive: true });
  const artifactPath = path.join(directory, `checkout-replacement-race-recovery-${runId}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(recovery, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.error(JSON.stringify({ status: "needs_identity_bound_cleanup", artifact: path.relative(root, artifactPath), recovery }, null, 2));
  process.exit(2);
}

const required = [
  "itemId", "originalBillId", "originalMutationId", "originalTabId",
  "checkoutMutationId", "replacementMutationId", "checkoutBillId", "replacementBillId", "checkoutTabId"
];
for (const field of required) {
  if (!evidence[field]) throw new Error(`Checkpoint is incomplete: ${field} is missing.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function ids(rows) {
  return rows.map((row) => row.id).sort();
}
function exact(actual, expected, message) {
  assert(JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()), message);
}
function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}
function canonicalEqual(actual, expected, message) {
  assert(JSON.stringify(stableJson(actual)) === JSON.stringify(stableJson(expected)), message);
}
async function mutationStatus(mutationId) {
  const result = await supabase.rpc("get_financial_mutation_result", {
    payload: { organization_id: organizationId, mutation_id: mutationId, mutation_kind: "commitCheckoutBill" }
  });
  if (result.error) throw new Error(`Mutation lookup failed for ${mutationId}: ${result.error.message}`);
  return result.data;
}

const billIds = [evidence.originalBillId, evidence.checkoutBillId, evidence.replacementBillId];
const tabIds = [evidence.originalTabId, evidence.checkoutTabId];
const mutationIds = [evidence.originalMutationId, evidence.checkoutMutationId, evidence.replacementMutationId];
const cleanupAuditIds = evidence.archiveResult?.changed_rows?.audit_logs ?? [];
const [inventory, bills, lines, payments, movements, audits, events, tabs, tabItems, allItemMovements, cleanupEvents, cleanupAudits, openSessions, openTabs, appState, mutationStatuses] = await Promise.all([
  supabase.from("inventory_items").select("id,name,stock_qty,active,archived_by_user_id,archive_reason").eq("organization_id", organizationId).eq("id", evidence.itemId),
  supabase.from("bills").select("id,bill_number,status,total,amount_paid,amount_due,replacement_of_bill_id,replaced_by_bill_id,replace_reason,replaced_by_user_id,issued_by_user_id").eq("organization_id", organizationId).in("id", billIds),
  supabase.from("bill_lines").select("id,bill_id,type,inventory_item_id,quantity,unit_price,total").eq("organization_id", organizationId).in("bill_id", billIds),
  supabase.from("payments").select("id,bill_id,mode,amount,received_by_user_id").eq("organization_id", organizationId).in("bill_id", billIds),
  supabase.from("stock_movements").select("id,item_id,type,quantity,related_bill_id,user_id").eq("organization_id", organizationId).in("related_bill_id", billIds),
  supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("id", [
    ...(evidence.originalAuditIds ?? []), ...(evidence.checkoutAuditIds ?? []), ...(evidence.replacementAuditIds ?? [])
  ]),
  supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("metadata->>mutation_id", mutationIds),
  supabase.from("customer_tabs").select("id,customer_name,status,close_disposition,closed_bill_id,close_reason").eq("organization_id", organizationId).in("id", tabIds),
  supabase.from("customer_tab_items").select("id,customer_tab_id,inventory_item_id,name,quantity,unit_price,stock_units_per_sale").eq("organization_id", organizationId).in("customer_tab_id", tabIds),
  supabase.from("stock_movements").select("id,item_id,type,quantity,related_bill_id,user_id").eq("organization_id", organizationId).eq("item_id", evidence.itemId),
  supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).eq("id", evidence.archiveResult?.event_id ?? "missing-cleanup-event"),
  supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("id", cleanupAuditIds.length ? cleanupAuditIds : ["missing-cleanup-audit"]),
  supabase.from("sessions").select("id,status,customer_name").eq("organization_id", organizationId).neq("status", "closed"),
  supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single(),
  Promise.all(mutationIds.map(mutationStatus))
]);
for (const [label, result] of Object.entries({ inventory, bills, lines, payments, movements, audits, events, tabs, tabItems, allItemMovements, cleanupEvents, cleanupAudits, openSessions, openTabs, appState })) {
  if (result.error) throw new Error(`${label} postflight query failed: ${result.error.message}`);
}
await expandCanonicalEvidence(mutationStatuses, events, audits);

if (selected.phase !== "final") {
  const committedMutations = mutationStatuses.filter(Boolean);
  const committedRaceMutations = mutationStatuses.slice(1).filter(Boolean);
  const canonicalReferencesExact = canonicalRecoveryReferencesAreExact({
    mutationIds,
    mutationStatuses,
    bills: bills.data,
    lines: lines.data,
    payments: payments.data,
    movements: allItemMovements.data,
    audits: audits.data,
    events: events.data,
    tabs: tabs.data
  });
  const safeForIdentityBoundCleanup =
    openSessions.data.length === 0 &&
    openTabs.data.every((row) => tabIds.includes(row.id)) &&
    inventory.data.length === 1 && inventory.data[0].id === evidence.itemId &&
    bills.data.every((row) => billIds.includes(row.id)) && canonicalReferencesExact;
  const recovery = {
    runId,
    inspectedAt: new Date().toISOString(),
    projectRef: STAGING_PROJECT_REF,
    sourceCheckpoint: path.relative(root, selected.path),
    classification: `${committedRaceMutations.length}_of_2_race_mutations_committed`,
    actors: { origin: originActorId, observer: observerActorId },
    mutationIds,
    mutationStatuses,
    inventory: inventory.data,
    bills: bills.data,
    lines: lines.data,
    payments: payments.data,
    movements: movements.data,
    audits: audits.data,
    events: events.data,
    tabs: tabs.data,
    tabItems: tabItems.data,
    allItemMovements: allItemMovements.data,
    openSessions: openSessions.data,
    openTabs: openTabs.data,
    appState: {
      version: appState.data.version,
      hash: createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex")
    },
    committedMutationCount: committedMutations.length,
    committedRaceMutationCount: committedRaceMutations.length,
    safeForIdentityBoundCleanup,
    safeForAutomaticRetry: false,
    productionAllowed: false
  };
  const recoveryDirectory = path.join(root, "test-artifacts", "reconciliation");
  fs.mkdirSync(recoveryDirectory, { recursive: true });
  const recoveryPath = path.join(recoveryDirectory, `checkout-replacement-race-recovery-${runId}.json`);
  fs.writeFileSync(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.error(JSON.stringify({ status: "needs_guarded_recovery", artifact: path.relative(root, recoveryPath), recovery }, null, 2));
  process.exit(2);
}

assert(selected.phase === "final", `Race checkpoint is ${selected.phase}; database evidence requires guarded recovery review.`);
assert(evidence.responses?.checkout?.bill_id === evidence.checkoutBillId, "Final checkout response identity changed.");
assert(evidence.responses?.replacement?.bill_id === evidence.replacementBillId, "Final replacement response identity changed.");
assert(mutationStatuses.every(Boolean), "All three financial mutations must have canonical results.");
exact(mutationStatuses.map((status) => status.mutation_id), mutationIds, "Mutation results are not exact.");
exact(mutationStatuses.map((status) => status.bill_id), billIds, "Mutation bill identities are not exact.");
canonicalEqual(mutationStatuses[0], evidence.originalResponse, "Original canonical mutation result changed.");
canonicalEqual(mutationStatuses[1], evidence.responses.checkout, "Checkout canonical mutation result changed.");
canonicalEqual(mutationStatuses[2], evidence.responses.replacement, "Replacement canonical mutation result changed.");

function changed(result, table) {
  return result?.changed_rows?.[table] ?? [];
}
const operationEvidence = [
  { label: "original", result: evidence.originalResponse, command: evidence.originalCommand, billId: evidence.originalBillId },
  { label: "checkout", result: evidence.responses.checkout, command: evidence.checkoutCommand, billId: evidence.checkoutBillId },
  { label: "replacement", result: evidence.responses.replacement, command: evidence.replacementCommand, billId: evidence.replacementBillId }
];
for (const operation of operationEvidence) {
  const expected = operation.command.payload;
  exact(changed(operation.result, "payments"), expected.payments.map((row) => row.id), `${operation.label} canonical payments changed_rows mismatch.`);
  exact(changed(operation.result, "stock_movements"), expected.stock_movements.map((row) => row.id), `${operation.label} canonical movements changed_rows mismatch.`);
  exact(changed(operation.result, "audit_logs"), expected.audit_logs.map((row) => row.id), `${operation.label} canonical audits changed_rows mismatch.`);
  assert(operation.result.event_id, `${operation.label} canonical event is missing.`);
}

assert(inventory.data.length === 1, "The exact QA item is missing or duplicated.");
assert(inventory.data[0].name === `QA Replacement Race ${runId}`, "QA item identity changed.");
assert(Number(inventory.data[0].stock_qty) === 0, "Final stock is not exactly zero.");
assert(inventory.data[0].active === false && inventory.data[0].archived_by_user_id === originActorId, "QA item cleanup is not exact.");
assert(inventory.data[0].archive_reason === `Release B replacement-race fixture cleanup ${runId}`, "QA item archive reason changed.");

assert(bills.data.length === 3, "Exactly three race bills must exist.");
const original = bills.data.find((row) => row.id === evidence.originalBillId);
const checkout = bills.data.find((row) => row.id === evidence.checkoutBillId);
const replacement = bills.data.find((row) => row.id === evidence.replacementBillId);
assert(original?.status === "replaced" && original.replaced_by_bill_id === evidence.replacementBillId, "Original bill replacement link is incorrect.");
assert(original.replaced_by_user_id === observerActorId && original.issued_by_user_id === originActorId, "Original bill actors are incorrect.");
assert(Number(original.total) === 50 && Number(original.amount_paid) === 50 && Number(original.amount_due) === 0, "Original totals changed.");
assert(checkout?.status === "issued" && Number(checkout.total) === 50 && Number(checkout.amount_paid) === 50 && Number(checkout.amount_due) === 0, "Concurrent checkout bill is incorrect.");
assert(checkout.issued_by_user_id === originActorId, "Checkout actor is incorrect.");
assert(replacement?.status === "issued" && replacement.replacement_of_bill_id === evidence.originalBillId, "Replacement link/status is incorrect.");
assert(Number(replacement.total) === 100 && Number(replacement.amount_paid) === 100 && Number(replacement.amount_due) === 0, "Replacement totals are incorrect.");
assert(replacement.issued_by_user_id === observerActorId, "Replacement actor is incorrect.");

assert(lines.data.length === 3, "Exactly three inventory bill lines must exist.");
assert(lines.data.every((row) => row.type === "inventory_item" && row.inventory_item_id === evidence.itemId && Number(row.unit_price) === 50), "Bill-line source/rate changed.");
for (const [billId, expectedQuantity, expectedTotal] of [
  [evidence.originalBillId, 1, 50],
  [evidence.checkoutBillId, 1, 50],
  [evidence.replacementBillId, 2, 100]
]) {
  const row = lines.data.find((entry) => entry.bill_id === billId);
  assert(row && Number(row.quantity) === expectedQuantity && Number(row.total) === expectedTotal, `Bill-line mapping is incorrect for ${billId}.`);
}
for (const operation of operationEvidence) {
  const expectedLines = operation.command.payload.primary_bill.lines;
  const actualLines = lines.data.filter((row) => row.bill_id === operation.billId);
  exact(ids(actualLines), expectedLines.map((row) => row.id), `${operation.label} bill-line IDs are not exact.`);
  for (const expected of expectedLines) {
    const actual = actualLines.find((row) => row.id === expected.id);
    assert(
      actual?.inventory_item_id === expected.inventoryItemId &&
      Number(actual.quantity) === Number(expected.quantity) &&
      Number(actual.unit_price) === Number(expected.unitPrice) &&
      Number(actual.total) === Number(expected.total),
      `${operation.label} bill-line row is not exact.`
    );
  }
}

const expectedPaymentIds = [...evidence.originalPaymentIds, ...evidence.checkoutPaymentIds, ...evidence.replacementPaymentIds];
const expectedMovementIds = [...evidence.originalMovementIds, ...evidence.checkoutMovementIds, ...evidence.replacementMovementIds];
const expectedAuditIds = [...evidence.originalAuditIds, ...evidence.checkoutAuditIds, ...evidence.replacementAuditIds];
exact(ids(payments.data), expectedPaymentIds, "Payment IDs are not exact.");
assert(payments.data.length === 3 && payments.data.every((row) => row.mode === "cash"), "Payment modes are incorrect.");
assert(payments.data.find((row) => row.bill_id === evidence.originalBillId)?.received_by_user_id === originActorId, "Original payment actor is incorrect.");
assert(payments.data.find((row) => row.bill_id === evidence.checkoutBillId)?.received_by_user_id === originActorId, "Checkout payment actor is incorrect.");
assert(payments.data.find((row) => row.bill_id === evidence.replacementBillId)?.received_by_user_id === observerActorId, "Replacement payment actor is incorrect.");
assert(JSON.stringify(payments.data.map((row) => Number(row.amount)).sort((a, b) => a - b)) === JSON.stringify([50, 50, 100]), "Payment amounts are incorrect.");
for (const operation of operationEvidence) {
  const expected = operation.command.payload.payments[0];
  const actual = payments.data.find((row) => row.id === expected.id);
  assert(actual?.bill_id === expected.billId && actual.mode === expected.mode && Number(actual.amount) === Number(expected.amount), `${operation.label} payment row is not exact.`);
}
exact(ids(movements.data), expectedMovementIds, "Movement IDs are not exact.");
assert(movements.data.length === 3 && movements.data.every((row) => row.item_id === evidence.itemId && row.type === "sale" && Number(row.quantity) === -1), "Stock movement arithmetic is incorrect.");
assert(movements.data.find((row) => row.related_bill_id === evidence.originalBillId)?.user_id === originActorId, "Original movement actor is incorrect.");
assert(movements.data.find((row) => row.related_bill_id === evidence.checkoutBillId)?.user_id === originActorId, "Checkout movement actor is incorrect.");
assert(movements.data.find((row) => row.related_bill_id === evidence.replacementBillId)?.user_id === observerActorId, "Replacement movement actor is incorrect.");
for (const operation of operationEvidence) {
  const expected = operation.command.payload.stock_movements[0];
  const actual = movements.data.find((row) => row.id === expected.id);
  assert(actual?.item_id === expected.itemId && actual.related_bill_id === expected.relatedBillId && Number(actual.quantity) === Number(expected.quantity), `${operation.label} movement row is not exact.`);
}
exact(ids(audits.data), expectedAuditIds, "Audit IDs are not exact.");
assert(audits.data.filter((row) => evidence.originalAuditIds.includes(row.id)).every((row) => row.user_id === originActorId), "Original audit attribution is incorrect.");
assert(audits.data.filter((row) => evidence.checkoutAuditIds.includes(row.id)).every((row) => row.user_id === originActorId), "Checkout audit attribution is incorrect.");
assert(audits.data.filter((row) => evidence.replacementAuditIds.includes(row.id)).every((row) => row.user_id === observerActorId), "Replacement audit attribution is incorrect.");
for (const operation of operationEvidence) {
  for (const expected of operation.command.payload.audit_logs) {
    const actual = audits.data.find((row) => row.id === expected.id);
    const auditBill = bills.data.find((row) => row.id === expected.entityId);
    const originalBill = auditBill?.replacement_of_bill_id
      ? bills.data.find((row) => row.id === auditBill.replacement_of_bill_id)
      : undefined;
    const expectedMessage = expected.action === "bill_issued"
      ? `Issued ${auditBill?.bill_number}.`
      : expected.action === "bill_replaced"
        ? `Issued replacement ${auditBill?.bill_number} for ${originalBill?.bill_number}. Reason: ${auditBill?.replace_reason ?? "Not provided"}.`
        : expected.message;
    assert(auditBill && actual?.action === expected.action && actual.entity_type === expected.entityType && actual.entity_id === expected.entityId && actual.message === expectedMessage, `${operation.label} audit row is not exact.`);
  }
}
assert(events.data.length === 3 && events.data.every((row) => row.event_type === "financial_checkout_committed_v2"), "Financial events are not exact.");
assert(events.data.find((row) => row.metadata.mutation_id === evidence.originalMutationId)?.created_by === originActorId, "Original event actor is incorrect.");
assert(events.data.find((row) => row.metadata.mutation_id === evidence.checkoutMutationId)?.created_by === originActorId, "Checkout event actor is incorrect.");
assert(events.data.find((row) => row.metadata.mutation_id === evidence.replacementMutationId)?.created_by === observerActorId, "Replacement event actor is incorrect.");
exact(events.data.map((row) => row.metadata.mutation_id), mutationIds, "Event mutation IDs are not exact.");
for (const operation of operationEvidence) {
  const actual = events.data.find((row) => row.id === operation.result.event_id);
  assert(actual?.entity_id === operation.result.entity_id && actual.metadata.mutation_id === operation.result.mutation_id, `${operation.label} financial event identity is incorrect.`);
  canonicalEqual(actual?.metadata.changed_rows, operation.result.changed_rows, `${operation.label} event changed_rows mismatch.`);
}

assert(tabs.data.length === 2, "Both exact customer tabs must exist.");
assert(tabs.data.every((row) => row.status === "closed" && row.close_disposition === "billed"), "Both tabs must be closed and billed.");
assert(tabs.data.find((row) => row.id === evidence.originalTabId)?.closed_bill_id === evidence.originalBillId, "Source tab bill link is incorrect.");
assert(tabs.data.find((row) => row.id === evidence.checkoutTabId)?.closed_bill_id === evidence.checkoutBillId, "Concurrent tab bill link is incorrect.");
assert(tabItems.data.length === 2, "Both exact reservation source rows must remain for historical reconstruction.");
assert(tabItems.data.every((row) => row.inventory_item_id === evidence.itemId && Number(row.quantity) === 1 && Number(row.unit_price) === 50), "Reservation source rows are not exact.");
exact(tabItems.data.map((row) => row.id), evidence.reservationItems.map((row) => row.id), "Reservation row identities changed.");
canonicalEqual(
  [...tabItems.data].sort((left, right) => left.id.localeCompare(right.id)),
  [...evidence.reservationItems].sort((left, right) => left.id.localeCompare(right.id)),
  "Reservation rows changed from their captured field-for-field snapshots."
);
const activeReservationQuantity = tabItems.data.reduce((sum, row) => {
  const tab = tabs.data.find((entry) => entry.id === row.customer_tab_id);
  return sum + (tab?.status === "open" ? Number(row.quantity) * Number(row.stock_units_per_sale ?? 1) : 0);
}, 0);
assert(activeReservationQuantity === 0, "An active reservation remains after both tabs closed.");
assert(openSessions.data.length === 0 && openTabs.data.length === 0, "The staging floor is not empty.");

assert(allItemMovements.data.length === 3, "Fixture cleanup or reservation handling created an unexpected stock movement.");
exact(ids(allItemMovements.data), expectedMovementIds, "The complete item movement set is not exact.");
assert(3 + allItemMovements.data.reduce((sum, row) => sum + Number(row.quantity), 0) === 0, "Physical stock arithmetic is not exactly 3 - 1 - 1 - 1 = 0.");
assert(evidence.archiveResult?.event_id && cleanupAuditIds.length === 1, "Archive acknowledgement is incomplete.");
assert(cleanupEvents.data.length === 1 && cleanupEvents.data[0].id === evidence.archiveResult.event_id && cleanupEvents.data[0].event_type === "admin_data_committed" && cleanupEvents.data[0].entity_type === evidence.archiveResult.entity_type && cleanupEvents.data[0].entity_id === evidence.archiveResult.entity_id && cleanupEvents.data[0].created_by === originActorId, "Archive event identity/type/actor is incorrect.");
canonicalEqual(cleanupEvents.data[0].metadata.changed_rows, evidence.archiveResult.changed_rows, "Archive event changed_rows mismatch.");
const expectedArchiveMessage = `Archived QA Replacement Race ${runId}. Reason: Release B replacement-race fixture cleanup ${runId}.`;
assert(cleanupAudits.data.length === 1 && cleanupAudits.data[0].id === cleanupAuditIds[0] && cleanupAudits.data[0].action === "inventory_archived" && cleanupAudits.data[0].entity_type === "inventory_item" && cleanupAudits.data[0].entity_id === evidence.itemId && cleanupAudits.data[0].message === expectedArchiveMessage && cleanupAudits.data[0].user_id === originActorId, "Archive audit identity/type/message/actor is incorrect.");

const currentHash = createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex");
assert(evidence.appStateAfterRace.version === evidence.appStateBeforeRace.version, "Financial race changed app_state version.");
assert(evidence.appStateAfterRace.hash === evidence.appStateBeforeRace.hash, "Financial race changed app_state hash.");
assert(appState.data.version === evidence.appStateAfterRace.version + 1, "Only the exact archive compatibility write is expected after the race.");
assert(
  appState.data.version === evidence.appStateAfterArchive.version && currentHash === evidence.appStateAfterArchive.hash,
  "Post-archive app_state version/hash changed."
);
const currentCompatibilityItem = appState.data.data.inventoryItems?.find((item) => item.id === evidence.itemId);
canonicalEqual(currentCompatibilityItem, evidence.appStateAfterArchive.compatibilityItem, "Post-archive compatibility item content changed.");

const output = {
  runId,
  reconciledAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  actors: { origin: originActorId, observer: observerActorId },
  sourceCheckpoint: path.relative(root, selected.path),
  mutationStatuses,
  inventory: inventory.data,
  bills: bills.data,
  lines: lines.data,
  payments: payments.data,
  movements: movements.data,
  audits: audits.data,
  events: events.data,
  tabs: tabs.data,
  tabItems: tabItems.data,
  allItemMovements: allItemMovements.data,
  cleanupEvents: cleanupEvents.data,
  cleanupAudits: cleanupAudits.data,
  openSessions: openSessions.data,
  openTabs: openTabs.data,
  appState: { version: appState.data.version, hash: currentHash },
  checks: {
    bothRaceCommandsCommitted: true,
    replacementLinksExact: true,
    stockArithmeticExact: true,
    actorsExact: true,
    reservationsReleased: true,
    cleanupEvidenceExact: true,
    financialAppStateUnchanged: true,
    fixtureArchived: true,
    floorEmpty: true
  }
};
const directory = path.join(root, "test-artifacts", "reconciliation");
fs.mkdirSync(directory, { recursive: true });
const artifactPath = path.join(directory, `checkout-replacement-race-postflight-${runId}.json`);
fs.writeFileSync(artifactPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ status: "passed", artifact: path.relative(root, artifactPath), output }, null, 2));
