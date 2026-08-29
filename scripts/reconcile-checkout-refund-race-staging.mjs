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
const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => argument !== "--void")) {
  throw new Error("Checkout disposition reconciliation accepts only refund or exact --void mode.");
}
const disposition = args[0] === "--void" ? "void" : "refund";
const temporaryAdmin = disposition === "void" ? loadSessionItemRaceAdmin(root, { required: true }) : null;
const env = {
  ...localEnv,
  ...process.env,
  ...(temporaryAdmin?.overlay ?? {}),
  E2E_CHECKOUT_REFUND_RACE_DISPOSITION: disposition
};
assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);

const runId = sanitizeRunId(env.E2E_REFUND_RACE_RECONCILE_RUN_ID || env.E2E_RUN_ID);
const organizationId = "org-primary";
const fixtureLabel = disposition === "void" ? "Void" : "Refund";
const artifactPrefix = disposition === "void" ? "checkout-void-race" : "checkout-refund-race";
const adjustmentMutationKind = disposition === "void" ? "voidBill" : "refundBill";
const adjustedBillStatus = disposition === "void" ? "voided" : "refunded";
const adjustmentAuditAction = disposition === "void" ? "bill_voided" : "bill_refunded";
const adjustmentAuditVerb = disposition === "void" ? "Voided" : "Refunded";
const itemName = `QA ${fixtureLabel} Race ${runId}`;
const customerNames = [`QA ${fixtureLabel} Source ${runId}`, `QA ${fixtureLabel} Checkout ${runId}`];
const billNumbers = ["ORIGINAL", "CHECKOUT"].map((suffix) =>
  `BILL-QA-${fixtureLabel.toUpperCase()}-RACE-${runId}-${suffix}`
);
const evidenceDirectory = path.join(root, "test-artifacts", "evidence");
const phases = [
  "final",
  "cleanup-acknowledged",
  "race-responses",
  "race-prepared",
  "checkout-item-added",
  "checkout-tab-opened",
  "original-committed",
  "original-prepared",
  "source-item-added",
  "source-tab-opened",
  "fixture-created",
  "setup-prepared"
];
const selected = phases
  .map((phase) => ({ phase, path: path.join(evidenceDirectory, `${artifactPrefix}-${phase}-${runId}.json`) }))
  .find((candidate) => fs.existsSync(candidate.path));
if (!selected) throw new Error("No immutable checkout disposition race checkpoint exists for this identity.");
const evidence = JSON.parse(fs.readFileSync(selected.path, "utf8"));
if (disposition === "refund" && evidence.disposition === undefined) {
  evidence.disposition = "refund";
  evidence.adjustmentMutationId ??= evidence.refundMutationId;
  evidence.adjustmentMutationKind ??= "refundBill";
  evidence.adjustmentMovementIds ??= evidence.refundMovementIds;
  evidence.adjustmentAuditIds ??= evidence.refundAuditIds;
  evidence.adjustmentReason ??= evidence.refundReason;
  if (evidence.responses?.refund && !evidence.responses.adjustment) {
    evidence.responses.adjustment = evidence.responses.refund;
  }
}
if (evidence.runId !== runId || evidence.disposition !== disposition) {
  throw new Error("Checkpoint identity or disposition mismatch.");
}
const preflightPath = path.join(root, "test-artifacts", "preflight", `${artifactPrefix}-preflight-${runId}.json`);
const preflightBytes = fs.existsSync(preflightPath) ? fs.readFileSync(preflightPath) : null;
const preflight = preflightBytes ? JSON.parse(preflightBytes.toString("utf8")) : null;
if (disposition === "void" && (!preflight || preflight.runId !== runId || preflight.disposition !== "void" ||
    preflight.projectRef !== STAGING_PROJECT_REF || preflight.productionAllowed !== false ||
    preflight.safeForAutomaticRetry !== false || preflight.safeToRun !== true || preflight.actorsDistinct !== true ||
    preflight.temporaryAdmin?.actorId !== evidence.actors?.observer ||
    JSON.stringify(preflight.actors?.map((actor) => actor.actorId)) !==
      JSON.stringify([evidence.actors?.origin, evidence.actors?.observer]))) {
  throw new Error("The immutable void-race preflight lineage is missing or invalid.");
}
const preflightLineage = preflightBytes ? {
  artifact: path.relative(root, preflightPath),
  sha256: createHash("sha256").update(preflightBytes).digest("hex")
} : null;

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
  const login = await client.auth.signInWithPassword({
    email: lookup.data.email,
    password: env[`E2E_PASSWORD_${slot}`]
  });
  if (login.error || !login.data.user) throw new Error(`Unable to authenticate staging slot ${slot}.`);
  const role = await client.rpc("current_user_org_role", { target_organization_id: organizationId });
  if (role.error || role.data !== "admin") throw new Error(`Staging slot ${slot} is not an authoritative admin.`);
  return { client, actorId: login.data.user.id };
}

const origin = await authenticate("A");
const observer = await authenticate("B");
const supabase = origin.client;

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
function hash(data) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
async function mutationStatus(client, mutationId, mutationKind) {
  const result = await client.rpc("get_financial_mutation_result", {
    payload: { organization_id: organizationId, mutation_id: mutationId, mutation_kind: mutationKind }
  });
  if (result.error) throw new Error(`Mutation lookup failed for ${mutationId}: ${result.error.message}`);
  return result.data;
}
function ensureOk(label, result) {
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
}

assert(
  evidence.actors?.origin === origin.actorId && evidence.actors?.observer === observer.actorId,
  "Current staging actors do not match the immutable execution actors."
);
if (disposition === "void") {
  assert(origin.actorId !== observer.actorId, "Void-race reconciliation requires distinct authenticated actors.");
}

async function baseSnapshot() {
  const [items, bills, tabs, openSessions, openTabs, appState] = await Promise.all([
    supabase.from("inventory_items")
      .select("id,name,stock_qty,active,archived_by_user_id,archive_reason")
      .eq("organization_id", organizationId).eq("name", itemName),
    supabase.from("bills")
      .select("id,bill_number,status,total,amount_paid,amount_due,void_reason,voided_at,voided_by_user_id,issued_by_user_id")
      .eq("organization_id", organizationId).in("bill_number", billNumbers),
    supabase.from("customer_tabs")
      .select("id,customer_name,status,close_disposition,closed_bill_id,close_reason")
      .eq("organization_id", organizationId).in("customer_name", customerNames),
    supabase.from("sessions").select("id,status,customer_name")
      .eq("organization_id", organizationId).neq("status", "closed"),
    supabase.from("customer_tabs").select("id,status,customer_name")
      .eq("organization_id", organizationId).eq("status", "open"),
    supabase.from("app_state").select("version,data").eq("id", "primary").single()
  ]);
  for (const [label, result] of Object.entries({ items, bills, tabs, openSessions, openTabs, appState })) {
    ensureOk(label, result);
  }
  return { items, bills, tabs, openSessions, openTabs, appState };
}

if (selected.phase !== "final") {
  const snapshot = await baseSnapshot();
  const itemIds = snapshot.items.data.map((row) => row.id);
  const billIds = snapshot.bills.data.map((row) => row.id);
  const mutationRequests = [
    { id: evidence.originalMutationId, kind: "commitCheckoutBill", actor: origin.actorId, client: origin.client },
    { id: evidence.checkoutMutationId, kind: "commitCheckoutBill", actor: origin.actorId, client: origin.client },
    { id: evidence.adjustmentMutationId, kind: adjustmentMutationKind, actor: observer.actorId, client: observer.client }
  ].filter((entry) => entry.id);
  const mutationStatuses = await Promise.all(
    mutationRequests.map((entry) => mutationStatus(entry.client, entry.id, entry.kind))
  );
  const acknowledgedResults = [
    evidence.itemResult,
    evidence.sourceTabResult,
    evidence.sourceItemResult,
    evidence.originalResponse,
    evidence.checkoutTabResult,
    evidence.checkoutItemResult
  ].filter(Boolean);
  const eventIds = Array.from(new Set([
    ...acknowledgedResults.map((result) => result.event_id).filter(Boolean),
    ...mutationStatuses.filter(Boolean).map((status) => status.event_id).filter(Boolean)
  ]));
  const auditIds = Array.from(new Set([
    ...acknowledgedResults.flatMap((result) => result.changed_rows?.audit_logs ?? []),
    ...mutationStatuses.filter(Boolean).flatMap((status) => status.changed_rows?.audit_logs ?? [])
  ]));
  const [tabItems, lines, payments, movements, events, audits] = await Promise.all([
    supabase.from("customer_tab_items").select("id,customer_tab_id,inventory_item_id,quantity,unit_price")
      .eq("organization_id", organizationId)
      .in("inventory_item_id", itemIds.length ? itemIds : ["missing-refund-race-item"]),
    supabase.from("bill_lines").select("id,bill_id,type,inventory_item_id,quantity,unit_price,total")
      .eq("organization_id", organizationId)
      .in("bill_id", billIds.length ? billIds : ["missing-refund-race-bill"]),
    supabase.from("payments").select("id,bill_id,mode,amount,received_by_user_id")
      .eq("organization_id", organizationId)
      .in("bill_id", billIds.length ? billIds : ["missing-refund-race-bill"]),
    supabase.from("stock_movements").select("id,item_id,type,quantity,related_bill_id,user_id")
      .eq("organization_id", organizationId)
      .in("item_id", itemIds.length ? itemIds : ["missing-refund-race-item"]),
    supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata")
      .eq("organization_id", organizationId)
      .in("id", eventIds.length ? eventIds : ["missing-refund-race-event"]),
    supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id")
      .eq("organization_id", organizationId)
      .in("id", auditIds.length ? auditIds : ["missing-refund-race-audit"])
  ]);
  for (const [label, result] of Object.entries({ tabItems, lines, payments, movements, events, audits })) {
    ensureOk(label, result);
  }
  const exactItemIdentity = snapshot.items.data.length === 1 && evidence.itemId && snapshot.items.data[0].id === evidence.itemId;
  const acknowledgedTabIds = [evidence.sourceTabResult, evidence.checkoutTabResult]
    .filter(Boolean)
    .map((result) => result.entity_id)
    .sort();
  const currentTabIds = snapshot.tabs.data.map((row) => row.id).sort();
  const exactTabIdentities =
    JSON.stringify(currentTabIds) === JSON.stringify(acknowledgedTabIds) &&
    snapshot.tabs.data.every((row) => customerNames.includes(row.customer_name)) &&
    new Set(snapshot.tabs.data.map((row) => row.customer_name)).size === snapshot.tabs.data.length;
  const exactBillIdentities = snapshot.bills.data.every((row) => billNumbers.includes(row.bill_number)) &&
    new Set(snapshot.bills.data.map((row) => row.bill_number)).size === snapshot.bills.data.length;
  const exactReferences = mutationStatuses.every((status, index) => {
    if (!status) return true;
    const request = mutationRequests[index];
    const event = events.data.find((row) => row.id === status.event_id);
    return status.mutation_id === request.id &&
      event?.metadata?.mutation_id === status.mutation_id &&
      event?.created_by === request.actor &&
      (status.changed_rows?.bills ?? []).every((id) => snapshot.bills.data.some((row) => row.id === id)) &&
      (status.changed_rows?.payments ?? []).every((id) => payments.data.some((row) => row.id === id)) &&
      (status.changed_rows?.stock_movements ?? []).every((id) => movements.data.some((row) => row.id === id)) &&
      (status.changed_rows?.audit_logs ?? []).every((id) => audits.data.some((row) => row.id === id)) &&
      (status.changed_rows?.customer_tabs ?? []).every((id) => snapshot.tabs.data.some((row) => row.id === id));
  });
  const acknowledgedReferencesExact = acknowledgedResults.every((result) => {
    const event = events.data.find((row) => row.id === result.event_id);
    const resultAuditIds = result.changed_rows?.audit_logs ?? [];
    const resultAudits = audits.data.filter((row) => resultAuditIds.includes(row.id));
    const resultOperationalEventIds = result.changed_rows?.operational_events ?? [];
    const changedEntityIds = Object.entries(result.changed_rows ?? {})
      .filter(([key]) => key !== "audit_logs" && key !== "operational_events")
      .flatMap(([, value]) => Array.isArray(value) ? value : []);
    const eventChangedRows = event?.metadata?.changed_rows;
    const expectedEventChangedRows = { ...(result.changed_rows ?? {}) };
    delete expectedEventChangedRows.operational_events;
    return event?.entity_type === result.entity_type &&
      event?.entity_id === result.entity_id &&
      event?.created_by === origin.actorId &&
      event?.metadata?.mutation_id === result.mutation_id &&
      (eventChangedRows === undefined ||
        JSON.stringify(stableJson(eventChangedRows)) === JSON.stringify(stableJson(expectedEventChangedRows))) &&
      (event?.metadata?.audit_log_id === undefined || resultAuditIds.includes(event.metadata.audit_log_id)) &&
      (event?.metadata?.customer_tab_id === undefined || event.metadata.customer_tab_id === result.entity_id) &&
      (resultOperationalEventIds.length === 0 ||
        (resultOperationalEventIds.length === 1 && resultOperationalEventIds[0] === result.event_id)) &&
      resultAudits.length === resultAuditIds.length &&
      resultAudits.every((audit) =>
        audit.user_id === origin.actorId &&
        (audit.entity_id === result.entity_id || changedEntityIds.includes(audit.entity_id))
      );
  });
  const recovery = {
    runId,
    disposition,
    reconciledAt: new Date().toISOString(),
    projectRef: STAGING_PROJECT_REF,
    preflightLineage,
    sourceCheckpoint: path.relative(root, selected.path),
    sourcePhase: selected.phase,
    status: "needs_guarded_recovery",
    safeForAutomaticRetry: false,
    safeForIdentityBoundCleanup:
      snapshot.openSessions.data.length === 0 &&
      snapshot.openTabs.data.every((row) => customerNames.includes(row.customer_name)) &&
      exactItemIdentity &&
      exactTabIdentities &&
      exactBillIdentities &&
      events.data.length === eventIds.length &&
      audits.data.length === auditIds.length &&
      events.data.every((row) => [origin.actorId, observer.actorId].includes(row.created_by)) &&
      audits.data.every((row) => [origin.actorId, observer.actorId].includes(row.user_id)) &&
      exactReferences &&
      acknowledgedReferencesExact,
    productionAllowed: false,
    actors: { origin: origin.actorId, observer: observer.actorId },
    items: snapshot.items.data,
    bills: snapshot.bills.data,
    tabs: snapshot.tabs.data,
    tabItems: tabItems.data,
    lines: lines.data,
    payments: payments.data,
    movements: movements.data,
    allItemMovements: movements.data,
    events: events.data,
    audits: audits.data,
    mutationIds: mutationRequests.map((entry) => entry.id),
    mutationKinds: mutationRequests.map((entry) => entry.kind),
    mutationActors: mutationRequests.map((entry) => entry.actor),
    mutationStatuses,
    openSessions: snapshot.openSessions.data,
    openTabs: snapshot.openTabs.data,
    appState: { version: snapshot.appState.data.version, hash: hash(snapshot.appState.data.data) }
  };
  const directory = path.join(root, "test-artifacts", "reconciliation");
  fs.mkdirSync(directory, { recursive: true });
  const artifactPath = path.join(directory, `${artifactPrefix}-recovery-${runId}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(recovery, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ artifact: path.relative(root, artifactPath), recovery }, null, 2));
  process.exitCode = 2;
} else {
  const required = [
    "itemId",
    "originalBillId",
    "checkoutBillId",
    "originalMutationId",
    "checkoutMutationId",
    "adjustmentMutationId",
    "adjustmentMutationKind",
    "originalTabId",
    "checkoutTabId",
    "appStateBeforeRace",
    "appStateAfterRace",
    "appStateAfterArchive",
    "archiveResult"
  ];
  for (const field of required) assert(evidence[field], `Final checkpoint is incomplete: ${field} is missing.`);
  assert(evidence.adjustmentMutationKind === adjustmentMutationKind, "Adjustment mutation kind changed.");

  const snapshot = await baseSnapshot();
  const billIds = [evidence.originalBillId, evidence.checkoutBillId];
  const tabIds = [evidence.originalTabId, evidence.checkoutTabId];
  const mutationIds = [evidence.originalMutationId, evidence.checkoutMutationId, evidence.adjustmentMutationId];
  const expectedPaymentIds = [...evidence.originalPaymentIds, ...evidence.checkoutPaymentIds];
  const expectedLineIds = [...evidence.originalLineIds, ...evidence.checkoutLineIds];
  const expectedMovementIds = [
    ...evidence.originalMovementIds,
    ...evidence.checkoutMovementIds,
    ...evidence.adjustmentMovementIds
  ];
  const expectedAuditIds = [...evidence.originalAuditIds, ...evidence.checkoutAuditIds, ...evidence.adjustmentAuditIds];
  const archiveAuditIds = evidence.archiveResult.changed_rows?.audit_logs ?? [];
  const archiveEventId = evidence.archiveResult.event_id;

  const [lines, payments, movements, audits, events, tabs, tabItems, allItemMovements, cleanupEvents, cleanupAudits, mutationStatuses] =
    await Promise.all([
      supabase.from("bill_lines").select("id,bill_id,type,inventory_item_id,quantity,unit_price,total")
        .eq("organization_id", organizationId).in("bill_id", billIds),
      supabase.from("payments").select("id,bill_id,mode,amount,received_by_user_id")
        .eq("organization_id", organizationId).in("id", expectedPaymentIds),
      supabase.from("stock_movements").select("id,item_id,type,quantity,reason,related_bill_id,user_id")
        .eq("organization_id", organizationId).in("id", expectedMovementIds),
      supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id")
        .eq("organization_id", organizationId).in("id", expectedAuditIds),
      supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata")
        .eq("organization_id", organizationId).in("id", [
          evidence.responses.original.event_id,
          evidence.responses.checkout.event_id,
          evidence.responses.adjustment.event_id
        ]),
      supabase.from("customer_tabs").select("id,customer_name,status,close_disposition,closed_bill_id,close_reason")
        .eq("organization_id", organizationId).in("id", tabIds),
      supabase.from("customer_tab_items")
        .select("id,customer_tab_id,inventory_item_id,name,quantity,unit_price,stock_units_per_sale")
        .eq("organization_id", organizationId).eq("inventory_item_id", evidence.itemId),
      supabase.from("stock_movements").select("id,item_id,type,quantity,related_bill_id,user_id")
        .eq("organization_id", organizationId).eq("item_id", evidence.itemId),
      supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata")
        .eq("organization_id", organizationId).eq("id", archiveEventId),
      supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id")
        .eq("organization_id", organizationId)
        .in("id", archiveAuditIds.length ? archiveAuditIds : ["missing-archive-audit"]),
      Promise.all([
        mutationStatus(origin.client, mutationIds[0], "commitCheckoutBill"),
        mutationStatus(origin.client, mutationIds[1], "commitCheckoutBill"),
        mutationStatus(observer.client, mutationIds[2], adjustmentMutationKind)
      ])
    ]);

  for (const [label, result] of Object.entries({
    lines,
    payments,
    movements,
    audits,
    events,
    tabs,
    tabItems,
    allItemMovements,
    cleanupEvents,
    cleanupAudits
  })) ensureOk(label, result);

  canonicalEqual(mutationStatuses[0], evidence.responses.original, "Original canonical mutation result changed.");
  canonicalEqual(mutationStatuses[1], evidence.responses.checkout, "Checkout canonical mutation result changed.");
  canonicalEqual(mutationStatuses[2], evidence.responses.adjustment, `${fixtureLabel} canonical mutation result changed.`);
  exact(ids(snapshot.items.data), [evidence.itemId], "QA fixture identity changed.");
  assert(snapshot.items.data[0].name === itemName, "QA fixture name changed.");
  assert(snapshot.items.data[0].active === false, "QA fixture was not archived.");
  assert(Number(snapshot.items.data[0].stock_qty) === 1, "Final stock is not exactly 1.");
  assert(snapshot.items.data[0].archived_by_user_id === origin.actorId, "Fixture archive actor is incorrect.");
  assert(snapshot.items.data[0].archive_reason === evidence.archiveReason, "Fixture archive reason changed.");

  exact(ids(snapshot.bills.data), billIds, "Race bill identities changed.");
  const original = snapshot.bills.data.find((row) => row.id === evidence.originalBillId);
  const checkout = snapshot.bills.data.find((row) => row.id === evidence.checkoutBillId);
  assert(original?.bill_number === billNumbers[0], "Original bill number changed.");
  assert(original?.status === adjustedBillStatus, `Original bill is not ${adjustedBillStatus}.`);
  assert(Number(original?.total) === 50 && Number(original?.amount_paid) === 50 && Number(original?.amount_due) === 0,
    "Original bill totals changed.");
  assert(original?.void_reason === evidence.adjustmentReason, `${fixtureLabel} reason changed.`);
  assert(original?.issued_by_user_id === origin.actorId, "Original issue actor is incorrect.");
  assert(original?.voided_by_user_id === observer.actorId, `${fixtureLabel} actor is incorrect.`);
  assert(checkout?.bill_number === billNumbers[1] && checkout?.status === "issued", "Checkout bill state changed.");
  assert(Number(checkout?.total) === 50 && Number(checkout?.amount_paid) === 50 && Number(checkout?.amount_due) === 0,
    "Checkout bill totals changed.");
  assert(checkout?.issued_by_user_id === origin.actorId, "Checkout issue actor is incorrect.");

  exact(ids(lines.data), expectedLineIds, "Bill-line IDs are not exact.");
  assert(lines.data.length === 2, "Exactly two bill lines must exist.");
  assert(lines.data.every((row) => row.inventory_item_id === evidence.itemId && Number(row.quantity) === 1 && Number(row.unit_price) === 50 && Number(row.total) === 50),
    "Bill-line mapping is incorrect.");
  assert(lines.data.find((row) => evidence.originalLineIds.includes(row.id))?.bill_id === evidence.originalBillId,
    "Original bill-line mapping is incorrect.");
  assert(lines.data.find((row) => evidence.checkoutLineIds.includes(row.id))?.bill_id === evidence.checkoutBillId,
    "Checkout bill-line mapping is incorrect.");
  exact(ids(payments.data), expectedPaymentIds, "Payment IDs are not exact.");
  assert(payments.data.length === 2 && payments.data.every((row) => Number(row.amount) === 50 && row.mode === "cash"),
    "Payment totals are incorrect.");
  assert(payments.data.every((row) => row.received_by_user_id === origin.actorId), "Payment actor is incorrect.");
  assert(payments.data.find((row) => evidence.originalPaymentIds.includes(row.id))?.bill_id === evidence.originalBillId,
    "Original payment mapping is incorrect.");
  assert(payments.data.find((row) => evidence.checkoutPaymentIds.includes(row.id))?.bill_id === evidence.checkoutBillId,
    "Checkout payment mapping is incorrect.");
  exact(ids(movements.data), expectedMovementIds, "Stock movement IDs are not exact.");
  const quantities = movements.data.map((row) => Number(row.quantity)).sort((a, b) => a - b);
  assert(JSON.stringify(quantities) === JSON.stringify([-1, -1, 1]), "Stock movement arithmetic is incorrect.");
  const adjustmentMovement = movements.data.find((row) => Number(row.quantity) === 1);
  assert(adjustmentMovement?.type === "void_refund_reversal" && adjustmentMovement.related_bill_id === evidence.originalBillId,
    `${fixtureLabel} reversal mapping is incorrect.`);
  assert(adjustmentMovement?.user_id === observer.actorId, `${fixtureLabel} movement actor is incorrect.`);
  assert(movements.data.filter((row) => Number(row.quantity) === -1).every((row) => row.type === "sale" && row.user_id === origin.actorId),
    "Sale movement actor/type is incorrect.");
  assert(movements.data.find((row) => evidence.originalMovementIds.includes(row.id))?.related_bill_id === evidence.originalBillId,
    "Original sale movement mapping is incorrect.");
  assert(movements.data.find((row) => evidence.checkoutMovementIds.includes(row.id))?.related_bill_id === evidence.checkoutBillId,
    "Checkout sale movement mapping is incorrect.");
  exact(ids(allItemMovements.data), expectedMovementIds, "Unexpected stock movement exists for the fixture.");
  assert(2 + allItemMovements.data.reduce((sum, row) => sum + Number(row.quantity), 0) === 1,
    "Physical stock arithmetic is not exactly 2 - 1 - 1 + 1 = 1.");

  exact(ids(audits.data), expectedAuditIds, "Financial audit IDs are not exact.");
  const expectedAudits = [
    { action: "bill_issued", entityId: evidence.originalBillId, message: `Issued ${billNumbers[0]}.`, actor: origin.actorId },
    { action: "bill_issued", entityId: evidence.checkoutBillId, message: `Issued ${billNumbers[1]}.`, actor: origin.actorId },
    { action: adjustmentAuditAction, entityId: evidence.originalBillId, message: `${adjustmentAuditVerb} ${billNumbers[0]}. Reason: ${evidence.adjustmentReason}.`, actor: observer.actorId }
  ];
  for (const expected of expectedAudits) {
    const actual = audits.data.find((row) => row.action === expected.action && row.entity_id === expected.entityId);
    assert(actual?.entity_type === "bill" && actual.message === expected.message && actual.user_id === expected.actor,
      `${expected.action} audit identity/message/actor is incorrect.`);
  }

  assert(events.data.length === 3, "Exactly three financial mutation events must exist.");
  const operations = [
    { result: evidence.responses.original, actor: origin.actorId, kind: "commitCheckoutBill", entityType: "customer_tab", entityId: evidence.originalTabId, eventType: "financial_checkout_committed_v2" },
    { result: evidence.responses.checkout, actor: origin.actorId, kind: "commitCheckoutBill", entityType: "customer_tab", entityId: evidence.checkoutTabId, eventType: "financial_checkout_committed_v2" },
    { result: evidence.responses.adjustment, actor: observer.actorId, kind: adjustmentMutationKind, entityType: "bill", entityId: evidence.originalBillId, eventType: "financial_adjustment_committed_v2" }
  ];
  for (const operation of operations) {
    const event = events.data.find((row) => row.id === operation.result.event_id);
    assert(event?.event_type === operation.eventType, "Financial event type is incorrect.");
    assert(event?.entity_type === operation.entityType && event?.entity_id === operation.entityId && event.created_by === operation.actor,
      "Financial event identity/actor is incorrect.");
    assert(event?.metadata?.mutation_id === operation.result.mutation_id && event?.metadata?.mutation_kind === operation.kind,
      "Financial event mutation metadata is incorrect.");
    canonicalEqual(event?.metadata?.changed_rows, operation.result.changed_rows, "Financial event changed_rows mismatch.");
  }

  exact(ids(tabs.data), tabIds, "Customer-tab identities changed.");
  assert(tabs.data.every((row) => row.status === "closed" && row.close_disposition === "billed"),
    "Both source tabs must remain closed and billed.");
  assert(tabs.data.find((row) => row.id === evidence.originalTabId)?.closed_bill_id === evidence.originalBillId,
    "Original tab bill link changed.");
  assert(tabs.data.find((row) => row.id === evidence.checkoutTabId)?.closed_bill_id === evidence.checkoutBillId,
    "Checkout tab bill link changed.");
  assert(tabItems.data.length === 2, "Reservation source rows changed.");
  assert(tabItems.data.every((row) => row.inventory_item_id === evidence.itemId && Number(row.quantity) === 1),
    "Reservation source rows are incorrect.");
  exact(ids(tabItems.data), evidence.reservationItems.map((row) => row.id), "Reservation source row IDs changed.");
  for (const expectedItem of evidence.reservationItems) {
    const actualItem = tabItems.data.find((row) => row.id === expectedItem.id);
    assert(actualItem?.customer_tab_id === expectedItem.customer_tab_id &&
      actualItem?.inventory_item_id === expectedItem.inventory_item_id &&
      Number(actualItem?.quantity) === Number(expectedItem.quantity) &&
      Number(actualItem?.unit_price) === Number(expectedItem.unit_price),
    "Reservation source row mapping is incorrect.");
  }
  assert(snapshot.openSessions.data.length === 0 && snapshot.openTabs.data.length === 0, "The staging floor is not empty.");

  assert(cleanupEvents.data.length === 1, "Archive event is missing or duplicated.");
  const cleanupEvent = cleanupEvents.data[0];
  assert(cleanupEvent.event_type === "admin_data_committed" && cleanupEvent.entity_type === evidence.archiveResult.entity_type &&
    cleanupEvent.entity_id === evidence.archiveResult.entity_id && cleanupEvent.created_by === origin.actorId,
    "Archive event identity/type/actor is incorrect.");
  canonicalEqual(cleanupEvent.metadata.changed_rows, evidence.archiveResult.changed_rows, "Archive event changed_rows mismatch.");
  assert(cleanupAudits.data.length === 1, "Archive audit is missing or duplicated.");
  const cleanupAudit = cleanupAudits.data[0];
  assert(cleanupAudit.action === "inventory_archived" && cleanupAudit.entity_type === "inventory_item" &&
    cleanupAudit.entity_id === evidence.itemId && cleanupAudit.user_id === origin.actorId &&
    cleanupAudit.message === `Archived ${itemName}. Reason: ${evidence.archiveReason}.`,
    "Archive audit identity/type/message/actor is incorrect.");

  assert(evidence.appStateAfterRace.version === evidence.appStateBeforeRace.version,
    "Financial race changed app_state version.");
  assert(evidence.appStateAfterRace.hash === evidence.appStateBeforeRace.hash,
    "Financial race changed app_state hash.");
  assert(snapshot.appState.data.version === evidence.appStateAfterRace.version + 1,
    "Only the exact archive compatibility write is expected after the race.");
  assert(hash(snapshot.appState.data.data) === evidence.appStateAfterArchive.hash,
    "Post-archive app_state hash changed.");
  const compatibilityItem = snapshot.appState.data.data.inventoryItems?.find((row) => row.id === evidence.itemId);
  canonicalEqual(compatibilityItem, evidence.appStateAfterArchive.compatibilityItem,
    "Post-archive compatibility item content changed.");

  const output = {
    runId,
    disposition,
    reconciledAt: new Date().toISOString(),
    projectRef: STAGING_PROJECT_REF,
    productionAllowed: false,
    safeForAutomaticRetry: false,
    preflightLineage,
    actors: { origin: origin.actorId, observer: observer.actorId },
    sourceCheckpoint: path.relative(root, selected.path),
    mutationStatuses,
    inventory: snapshot.items.data,
    bills: snapshot.bills.data,
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
    openSessions: snapshot.openSessions.data,
    openTabs: snapshot.openTabs.data,
    appState: { version: snapshot.appState.data.version, hash: hash(snapshot.appState.data.data) },
    checks: {
      bothRaceCommandsCommitted: true,
      dispositionLifecycleExact: true,
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
  const artifactPath = path.join(directory, `${artifactPrefix}-postflight-${runId}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ status: "passed", artifact: path.relative(root, artifactPath), output }, null, 2));
}
