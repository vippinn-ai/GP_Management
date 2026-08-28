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
if (!env.E2E_RUN_ID?.trim()) throw new Error("An explicit E2E_RUN_ID is required.");
const runId = sanitizeRunId(env.E2E_RUN_ID);
const itemName = `QA Session Item Race ${runId}`;
const allScenarios = ["checkout_first", "item_first", "simultaneous"];
const approvedSelections = [allScenarios, ["item_first", "simultaneous"]];
const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-session-item-race-preflight-${runId}.json`);
let preflight = null;
try {
  preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
} catch {
  // Recovery remains fail-closed; broad names below retain discovery coverage.
}
const reviewedSelection = Array.isArray(preflight?.selectedScenarios) ? preflight.selectedScenarios : null;
const scenarios = approvedSelections.some((selection) =>
  JSON.stringify(selection) === JSON.stringify(reviewedSelection)
) ? reviewedSelection : allScenarios;
const customerNames = scenarios.map((scenario) => `QA Session Item Race ${runId} ${scenario}`);
const billNumbers = scenarios.map((scenario) => `BILL-QA-ITEM-RACE-${runId}-${scenario}`);

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey) throw new Error("Ignored staging Supabase configuration is incomplete.");
if (new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Checkout-session-item reconciliation is locked to staging.");
}

const client = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const lookup = await client.functions.invoke("resolve-login-email", {
  body: { username: env.E2E_USER_A.trim() }
});
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve staging credential slot A.");
const login = await client.auth.signInWithPassword({
  email: lookup.data.email,
  password: env.E2E_PASSWORD_A
});
if (login.error || !login.data.user) throw new Error("Unable to authenticate staging credential slot A.");
const [role, profile] = await Promise.all([
  client.rpc("current_user_org_role", { target_organization_id: organizationId }),
  client.from("profiles").select("id,role,active").eq("id", login.data.user.id).single()
]);
if (role.error || role.data !== "admin" || profile.error || profile.data?.role !== "admin" || !profile.data.active) {
  throw new Error("Reconciliation requires an active authoritative staging admin.");
}

const evidenceDirectory = path.join(root, "test-artifacts", "evidence");
const candidateFiles = fs.existsSync(evidenceDirectory)
  ? fs.readdirSync(evidenceDirectory)
    .filter((name) => name.startsWith("checkout-session-item-race-") && name.endsWith(`-${runId}.json`))
    .map((name) => ({ name, fullPath: path.join(evidenceDirectory, name) }))
  : [];
const parsedCandidates = candidateFiles.map((entry) => {
  try {
    return {
      ...entry,
      modified: fs.statSync(entry.fullPath).mtimeMs,
      value: JSON.parse(fs.readFileSync(entry.fullPath, "utf8")),
      parseError: null
    };
  } catch (error) {
    return {
      ...entry,
      modified: fs.statSync(entry.fullPath).mtimeMs,
      value: null,
      parseError: error instanceof Error ? error.message : String(error)
    };
  }
});
const validCandidates = parsedCandidates.filter((entry) => entry.value?.runId === runId);
const corruptCandidates = parsedCandidates.filter((entry) => entry.parseError || entry.value?.runId !== runId);
const finalCandidate = validCandidates.find((entry) => entry.name === `checkout-session-item-race-final-${runId}.json`);
const selected = finalCandidate ?? validCandidates
  .sort((left, right) => right.modified - left.modified)[0];

async function query(label, promise) {
  const result = await promise;
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  return result.data;
}

const liveSnapshot = async () => {
  const [items, sessions, bills, openSessions, openTabs, appState] = await Promise.all([
    query("fixture item", client.from("inventory_items").select("id,name,stock_qty,active")
      .eq("organization_id", organizationId).eq("name", itemName)),
    query("run sessions", client.from("sessions").select("id,customer_name,status,close_disposition,closed_bill_id")
      .eq("organization_id", organizationId).in("customer_name", customerNames)),
    query("run bills", client.from("bills").select("id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id")
      .eq("organization_id", organizationId).in("bill_number", billNumbers)),
    query("open sessions", client.from("sessions").select("id,customer_name,status")
      .eq("organization_id", organizationId).neq("status", "closed")),
    query("open tabs", client.from("customer_tabs").select("id,customer_name,status")
      .eq("organization_id", organizationId).eq("status", "open")),
    query("app state", client.from("app_state").select("version,data").eq("id", "primary").single())
  ]);
  return { items, sessions, bills, openSessions, openTabs, appState };
};

if (!selected || !finalCandidate) {
  const snapshot = await liveSnapshot();
  const checkpoint = selected?.value ?? {};
  const actors = checkpoint.actors ?? (
    preflight?.actors?.length === 2
      ? { checkout: preflight.actors[0].actorId, item: preflight.actors[1].actorId }
      : null
  );
  const acknowledgedScenarios = Array.isArray(checkpoint.scenarios) ? checkpoint.scenarios : [];
  const acknowledgedSessionIds = acknowledgedScenarios
    .map((entry) => entry.sessionId)
    .filter((value) => typeof value === "string");
  const itemId = checkpoint.fixture?.itemId ?? snapshot.items[0]?.id ?? null;
  const runSessionIds = snapshot.sessions.map((row) => row.id);
  const runBillIds = snapshot.bills.map((row) => row.id);
  const [sessionItems, itemMovements, billLines, payments, events, audits, sessionDetails] = await Promise.all([
    runSessionIds.length
      ? query("recovery session items", client.from("session_items")
        .select("id,session_id,inventory_item_id,name,quantity,unit_price,raw_data")
        .eq("organization_id", organizationId).in("session_id", runSessionIds))
      : Promise.resolve([]),
    itemId
      ? query("recovery item movements", client.from("stock_movements")
        .select("id,item_id,type,quantity,user_id,related_bill_id")
        .eq("organization_id", organizationId).eq("item_id", itemId))
      : Promise.resolve([]),
    runBillIds.length
      ? query("recovery bill lines", client.from("bill_lines")
        .select("id,bill_id,type,inventory_item_id,quantity,unit_price,total,linked_session_id,raw_data")
        .eq("organization_id", organizationId).in("bill_id", runBillIds))
      : Promise.resolve([]),
    runBillIds.length
      ? query("recovery payments", client.from("payments")
        .select("id,bill_id,amount,mode,received_by_user_id")
        .eq("organization_id", organizationId).in("bill_id", runBillIds))
      : Promise.resolve([]),
    (runSessionIds.length || itemId)
      ? query("recovery events", client.from("operational_events")
        .select("id,event_type,entity_type,entity_id,created_by,metadata")
        .eq("organization_id", organizationId).in("entity_id", [...runSessionIds, itemId].filter(Boolean)))
      : Promise.resolve([]),
    (runSessionIds.length || itemId || runBillIds.length)
      ? query("recovery audits", client.from("audit_logs")
        .select("id,action,entity_type,entity_id,user_id,message")
        .eq("organization_id", organizationId).in("entity_id", [...runSessionIds, itemId, ...runBillIds].filter(Boolean)))
      : Promise.resolve([]),
    runSessionIds.length
      ? query("recovery session details", client.from("sessions")
        .select("id,raw_data").eq("organization_id", organizationId).in("id", runSessionIds))
      : Promise.resolve([])
  ]);
  const knownAdminEventIds = [
    checkpoint.fixture?.createdBody?.event_id,
    checkpoint.cleanup?.archivedBody?.event_id
  ].filter((value) => typeof value === "string");
  if (knownAdminEventIds.length) {
    const adminEvents = await query("recovery admin events", client.from("operational_events")
      .select("id,event_type,entity_type,entity_id,created_by,metadata")
      .eq("organization_id", organizationId).in("id", knownAdminEventIds));
    for (const event of adminEvents) {
      if (!events.some((existing) => existing.id === event.id)) events.push(event);
    }
  }

  const recoveryFailures = [];
  const requireRecovery = (condition, message) => {
    if (!condition) recoveryFailures.push(message);
  };
  requireRecovery(preflight?.safeToRun === true && preflight?.actorsDistinct === true,
    "Exact distinct-actor preflight is missing or unsafe.");
  requireRecovery(approvedSelections.some((selection) =>
    JSON.stringify(selection) === JSON.stringify(preflight?.selectedScenarios)),
  "Exact reviewed scenario selection is missing or invalid.");
  requireRecovery(JSON.stringify(checkpoint.selectedScenarios) === JSON.stringify(preflight?.selectedScenarios),
    "Checkpoint scenario selection does not match the exact preflight.");
  requireRecovery(acknowledgedScenarios.map((entry) => entry.scenario).join(",") ===
    scenarios.slice(0, acknowledgedScenarios.length).join(","),
  "Acknowledged scenarios are not an exact ordered prefix of the reviewed selection.");
  requireRecovery(actors?.checkout === preflight?.actors?.[0]?.actorId && actors?.item === preflight?.actors?.[1]?.actorId,
    "Checkpoint actors do not match the exact preflight actors.");
  requireRecovery(snapshot.items.length <= 1 && (!snapshot.items.length ||
    (snapshot.items[0].id === itemId && snapshot.items[0].name === itemName)),
  "Fixture item identity is ambiguous.");
  requireRecovery(snapshot.sessions.every((row) => acknowledgedSessionIds.includes(row.id)),
    "A run-named session lacks an immediate acknowledged session identity.");
  requireRecovery(snapshot.openSessions.every((row) => acknowledgedSessionIds.includes(row.id)),
    "An open staging session is outside the exact acknowledged run identity.");
  requireRecovery(snapshot.openTabs.length === 0, "An open customer tab is outside this session-only cleanup scope.");
  const normalized = (value) => {
    if (Array.isArray(value)) return `[${value.map(normalized).sort().join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${normalized(entry)}`).join(",")}}`;
    }
    return JSON.stringify(value);
  };
  const sortedIds = (values) => [...values].map(String).sort();
  const idsMatch = (rows, expectedIds) =>
    JSON.stringify(sortedIds(rows.map((row) => row.id))) === JSON.stringify(sortedIds(expectedIds));
  const changedIds = (result, collection) => {
    const values = result?.changed_rows?.[collection];
    return Array.isArray(values) ? values.map(String) : [];
  };
  const expectedEventIds = new Set();
  const expectedAuditIds = new Set();
  const expectedAuditPayloads = new Map();
  const lifecycleResults = [];
  const registerCommandAudits = (command, actor) => {
    const payload = command?.payload?.payload;
    const auditRows = [
      ...(Array.isArray(payload?.auditLogs) ? payload.auditLogs : []),
      ...(payload?.auditLog ? [payload.auditLog] : [])
    ];
    for (const audit of auditRows) {
      if (!audit?.id) continue;
      expectedAuditIds.add(String(audit.id));
      expectedAuditPayloads.set(String(audit.id), { ...audit, actor });
    }
  };
  const registerLifecycle = (result, expected) => {
    if (!result || typeof result !== "object") return;
    if (result.event_id) expectedEventIds.add(String(result.event_id));
    changedIds(result, "operational_events").forEach((id) => expectedEventIds.add(id));
    changedIds(result, "audit_logs").forEach((id) => expectedAuditIds.add(id));
    lifecycleResults.push({ result, ...expected });
  };
  registerLifecycle(checkpoint.fixture?.createdBody, {
    eventType: "admin_data_committed",
    entityType: checkpoint.fixture?.createdBody?.entity_type,
    entityId: checkpoint.fixture?.createdBody?.entity_id,
    actor: actors?.checkout
  });
  registerCommandAudits(checkpoint.fixture?.createdCommand, actors?.checkout);
  registerLifecycle(checkpoint.cleanup?.archivedBody, {
    eventType: "admin_data_committed",
    entityType: checkpoint.cleanup?.archivedBody?.entity_type,
    entityId: checkpoint.cleanup?.archivedBody?.entity_id,
    actor: actors?.checkout
  });
  registerCommandAudits(checkpoint.cleanup?.archivedCommand, actors?.checkout);
  for (const expected of acknowledgedScenarios) {
    registerLifecycle(expected.startResult, {
      eventType: "start_session", entityType: "session", entityId: expected.sessionId, actor: actors?.checkout
    });
    registerCommandAudits(expected.startCommand, actors?.checkout);
    registerLifecycle(expected.saveResult, {
      eventType: "save_live_session_details", entityType: "session", entityId: expected.sessionId, actor: actors?.checkout
    });
    registerCommandAudits(expected.saveCommand, actors?.checkout);
    registerLifecycle(expected.cleanupAcknowledgement ?? expected.cleanup?.acknowledgedResult, {
      eventType: "reject_session", entityType: "session", entityId: expected.sessionId, actor: actors?.item
    });
    registerCommandAudits(expected.cleanupCommand, actors?.item);
  }

  const scenarioClassifications = [];
  const expectedBillIds = [];
  const expectedLineIds = [];
  const expectedPaymentIds = [];
  const expectedSessionItemIds = [];
  const expectedMovementIds = [];
  for (const expected of acknowledgedScenarios) {
    const bill = snapshot.bills.find((row) => row.id === expected.candidateBillId) ?? null;
    const addedItem = sessionItems.find((row) => row.id === expected.candidateSessionItemId) ?? null;
    const checkoutEvent = events.find((row) => row.metadata?.mutation_id === expected.checkoutMutationId) ?? null;
    const itemEvent = events.find((row) => row.metadata?.mutation_id === expected.itemMutationId) ?? null;
    let mutationStatus = null;
    if (expected.checkoutMutationId) {
      mutationStatus = await query(`${expected.scenario} recovery mutation`, client.rpc("get_financial_mutation_result", {
        payload: {
          organization_id: organizationId,
          mutation_id: expected.checkoutMutationId,
          mutation_kind: "commitCheckoutBill"
        }
      }));
    }
    const checkoutEffect = Boolean(bill || checkoutEvent || mutationStatus);
    const itemEffect = Boolean(addedItem || itemEvent);
    requireRecovery(!(checkoutEffect && itemEffect), `${expected.scenario}: both competing effects are present.`);
    if (checkoutEffect) {
      requireRecovery(Boolean(bill && checkoutEvent && mutationStatus?.bill_id === bill.id),
        `${expected.scenario}: checkout effect is only partially committed.`);
      const capturedBill = expected.expectedFinancial?.bill;
      const capturedLines = expected.expectedFinancial?.lines ?? [];
      const capturedPayments = expected.expectedFinancial?.payments ?? [];
      const capturedAudits = expected.expectedFinancial?.audits ?? [];
      const scenarioLines = billLines.filter((row) => row.bill_id === expected.candidateBillId);
      const scenarioPayments = payments.filter((row) => row.bill_id === expected.candidateBillId);
      const scenarioAudits = audits.filter((row) => capturedAudits.some((audit) => audit.id === row.id));
      requireRecovery(Boolean(capturedBill && bill?.bill_number === expected.candidateBillNumber && bill?.status === "issued" &&
        Number(bill?.total) === Number(capturedBill.total) && Number(bill?.amount_paid) === Number(capturedBill.amountPaid) &&
        Number(bill?.amount_due) === Number(capturedBill.amountDue) && bill?.issued_by_user_id === actors?.checkout),
      `${expected.scenario}: canonical bill fields or actor differ from the captured envelope.`);
      requireRecovery(idsMatch(scenarioLines, capturedLines.map((row) => row.id)),
        `${expected.scenario}: bill-line cardinality or ids differ from the captured envelope.`);
      for (const line of capturedLines) {
        const actual = scenarioLines.find((row) => row.id === line.id);
        requireRecovery(Boolean(actual && actual.type === line.type &&
          actual.inventory_item_id === (line.inventoryItemId ?? null) &&
          Number(actual.quantity) === Number(line.quantity) && Number(actual.unit_price) === Number(line.unitPrice) &&
          Number(actual.total) === Number(line.total) && actual.linked_session_id === expected.sessionId),
        `${expected.scenario}: bill-line values or relationships differ from the captured envelope.`);
      }
      requireRecovery(idsMatch(scenarioPayments, capturedPayments.map((row) => row.id)),
        `${expected.scenario}: payment cardinality or ids differ from the captured envelope.`);
      for (const payment of capturedPayments) {
        const actual = scenarioPayments.find((row) => row.id === payment.id);
        requireRecovery(Boolean(actual && actual.bill_id === expected.candidateBillId &&
          Number(actual.amount) === Number(payment.amount) && actual.mode === payment.mode &&
          actual.received_by_user_id === actors?.checkout),
        `${expected.scenario}: payment amount/mode/relationship/actor differs from the captured envelope.`);
      }
      requireRecovery(idsMatch(scenarioAudits, capturedAudits.map((row) => row.id)) &&
        scenarioAudits.every((row) => row.user_id === actors?.checkout),
      `${expected.scenario}: checkout audit cardinality/identity/actor differs from the captured envelope.`);
      for (const capturedAudit of capturedAudits) {
        const actual = scenarioAudits.find((row) => row.id === capturedAudit.id);
        const endedAt = sessionDetails.find((row) => row.id === expected.sessionId)?.raw_data?.endedAt;
        const serverExpected = capturedAudit.action === "bill_issued"
          ? {
              action: "bill_issued",
              entityType: "bill",
              entityId: expected.candidateBillId,
              message: `Issued ${expected.candidateBillNumber}.`
            }
          : capturedAudit.action === "session_checkout_details_updated" && endedAt
            ? {
                action: "session_checkout_details_updated",
                entityType: "session",
                entityId: expected.sessionId,
                message: `Updated during checkout: end time: not set -> ${endedAt}.`
              }
            : null;
        requireRecovery(Boolean(actual && serverExpected && actual.action === serverExpected.action &&
          actual.entity_type === serverExpected.entityType && actual.entity_id === serverExpected.entityId &&
          actual.message === serverExpected.message),
        `${expected.scenario}: checkout audit action/entity/message differs from the captured envelope.`);
        if (serverExpected) {
          expectedAuditPayloads.set(String(capturedAudit.id), { ...serverExpected, actor: actors?.checkout });
        }
      }
      requireRecovery(checkoutEvent?.id === mutationStatus?.event_id &&
        checkoutEvent?.event_type === "financial_checkout_committed_v2" && checkoutEvent?.entity_type === "session" &&
        checkoutEvent?.entity_id === expected.sessionId && checkoutEvent?.created_by === actors?.checkout &&
        checkoutEvent?.metadata?.mutation_id === expected.checkoutMutationId &&
        checkoutEvent?.metadata?.mutation_kind === "commitCheckoutBill" &&
        checkoutEvent?.metadata?.bill_id === expected.candidateBillId &&
        normalized(checkoutEvent?.metadata?.changed_rows) === normalized(mutationStatus?.changed_rows),
      `${expected.scenario}: checkout event id/entity/actor/mutation/bill/changed_rows is not canonical.`);
      requireRecovery(mutationStatus?.mutation_id === expected.checkoutMutationId &&
        mutationStatus?.entity_id === expected.sessionId && mutationStatus?.bill_id === expected.candidateBillId &&
        mutationStatus?.bill_number === expected.candidateBillNumber,
      `${expected.scenario}: financial mutation result does not match the captured checkout.`);
      if (expected.responses?.checkout?.status === 200) {
        requireRecovery(normalized(mutationStatus) === normalized(expected.responses.checkout.body),
          `${expected.scenario}: canonical mutation result changed from the acknowledged response.`);
      }
      expectedBillIds.push(expected.candidateBillId);
      expectedLineIds.push(...capturedLines.map((row) => row.id));
      expectedPaymentIds.push(...capturedPayments.map((row) => row.id));
      capturedAudits.forEach((row) => expectedAuditIds.add(String(row.id)));
      expectedEventIds.add(String(checkoutEvent?.id));
    }
    if (itemEffect) {
      const movement = itemMovements.find((row) => row.id === expected.candidateReservationId);
      const audit = audits.find((row) => row.id === expected.candidateItemAuditId);
      requireRecovery(Boolean(addedItem && itemEvent && movement && audit),
        `${expected.scenario}: item effect is only partially committed.`);
      const captured = expected.expectedOperational;
      requireRecovery(Boolean(captured && addedItem?.session_id === expected.sessionId &&
        addedItem?.inventory_item_id === itemId && addedItem?.name === itemName &&
        Number(addedItem?.quantity) === Number(captured.item.quantity) &&
        Number(addedItem?.unit_price) === Number(captured.item.unitPrice)),
      `${expected.scenario}: exact session-item values or relationships differ from the captured command.`);
      requireRecovery(Boolean(movement && movement.id === captured?.stockMovement?.id && movement.item_id === itemId &&
        movement.type === "session_reservation" && Number(movement.quantity) === Number(captured.stockMovement.quantity) &&
        movement.user_id === actors?.item && movement.related_bill_id === null),
      `${expected.scenario}: exact reservation id/quantity/relationship/actor differs from the captured command.`);
      requireRecovery(Boolean(audit && audit.id === captured?.auditLog?.id && audit.action === "session_item_added" &&
        audit.entity_type === "session" && audit.entity_id === expected.sessionId && audit.user_id === actors?.item &&
        audit.message === captured?.auditLog?.message),
      `${expected.scenario}: exact item audit identity/type/actor differs from the captured command.`);
      requireRecovery(Boolean(itemEvent && itemEvent.event_type === "add_session_item" && itemEvent.entity_type === "session" &&
        itemEvent.entity_id === expected.sessionId && itemEvent.created_by === actors?.item &&
        itemEvent.metadata?.mutation_id === expected.itemMutationId && itemEvent.metadata?.mutation_kind === "addSessionItem" &&
        itemEvent.metadata?.session_item_id === captured?.item?.id &&
        itemEvent.metadata?.stock_movement_id === captured?.stockMovement?.id &&
        itemEvent.metadata?.audit_log_id === captured?.auditLog?.id),
      `${expected.scenario}: item event identity/actor/mutation/self-references differ from the captured command.`);
      expectedSessionItemIds.push(captured.item.id);
      expectedMovementIds.push(captured.stockMovement.id);
      expectedAuditIds.add(String(captured.auditLog.id));
      expectedAuditPayloads.set(String(captured.auditLog.id), { ...captured.auditLog, actor: actors?.item });
      expectedEventIds.add(String(itemEvent.id));
    }
    scenarioClassifications.push({
      scenario: expected.scenario,
      sessionId: expected.sessionId,
      checkoutMutationId: expected.checkoutMutationId ?? null,
      itemMutationId: expected.itemMutationId ?? null,
      outcome: checkoutEffect ? "checkout" : itemEffect ? "item" : "none",
      mutationStatus,
      billId: bill?.id ?? null,
      sessionItemId: addedItem?.id ?? null,
      checkoutEventId: checkoutEvent?.id ?? null,
      itemEventId: itemEvent?.id ?? null
    });
  }

  requireRecovery(idsMatch(snapshot.bills, expectedBillIds), "Run bill cardinality is not exactly the classified checkout winners.");
  requireRecovery(idsMatch(billLines, expectedLineIds), "Run bill-line cardinality is not exactly the captured winning lines.");
  requireRecovery(idsMatch(payments, expectedPaymentIds), "Run payment cardinality is not exactly the captured winning payments.");
  requireRecovery(idsMatch(sessionItems, expectedSessionItemIds), "Run session-item cardinality is not exactly the classified item winners.");
  requireRecovery(idsMatch(itemMovements, expectedMovementIds), "Fixture movement cardinality is not exactly the classified item winners.");
  for (const lifecycle of lifecycleResults) {
    const event = events.find((row) => row.id === lifecycle.result.event_id);
    requireRecovery(Boolean(event && event.event_type === lifecycle.eventType && event.entity_type === lifecycle.entityType &&
      event.entity_id === lifecycle.entityId && event.created_by === lifecycle.actor &&
      event.metadata?.mutation_id === lifecycle.result.mutation_id),
    `Lifecycle event ${lifecycle.result.event_id} identity/type/actor/mutation is incorrect.`);
    if (lifecycle.eventType === "admin_data_committed") {
      requireRecovery(normalized(event?.metadata?.changed_rows) === normalized(lifecycle.result.changed_rows),
        `Admin lifecycle event ${lifecycle.result.event_id} changed_rows is incorrect.`);
    }
  }
  requireRecovery(idsMatch(events, [...expectedEventIds]), "Run event cardinality includes a missing or extra event.");
  requireRecovery(idsMatch(audits, [...expectedAuditIds]), "Run audit cardinality includes a missing or extra audit.");
  requireRecovery(events.every((row) => [actors?.checkout, actors?.item].includes(row.created_by)),
    "A run event actor is outside the exact authenticated contexts.");
  requireRecovery(audits.every((row) => [actors?.checkout, actors?.item].includes(row.user_id)),
    "A run audit actor is outside the exact authenticated contexts.");
  for (const [auditId, expectedAudit] of expectedAuditPayloads) {
    const actual = audits.find((row) => row.id === auditId);
    requireRecovery(Boolean(actual && actual.action === expectedAudit.action &&
      actual.entity_type === expectedAudit.entityType && actual.entity_id === expectedAudit.entityId &&
      actual.message === expectedAudit.message && actual.user_id === expectedAudit.actor),
    `Lifecycle audit ${auditId} action/entity/message/actor differs from the acknowledged command.`);
  }

  const recovery = {
    status: recoveryFailures.length === 0 ? "needs_identity_bound_cleanup" : "blocked",
    runId,
    checkedAt: new Date().toISOString(),
    projectRef: STAGING_PROJECT_REF,
    productionAllowed: false,
    safeForAutomaticRetry: false,
    safeForIdentityBoundCleanup: recoveryFailures.length === 0,
    reason: selected ? "The final immutable browser checkpoint is absent." : "No valid browser checkpoint exists for this run.",
    latestCheckpoint: selected ? path.relative(root, selected.fullPath) : null,
    corruptCandidates: corruptCandidates.map((entry) => ({
      path: path.relative(root, entry.fullPath),
      error: entry.parseError ?? "run_identity_mismatch"
    })),
    actors,
    temporaryAdmin: preflight?.temporaryAdmin ?? null,
    selectedScenarios: scenarios,
    fixture: { itemId, itemName, stationName: preflight?.fixture?.station?.name ?? null },
    acknowledgedSessionIds,
    scenarioClassifications,
    actions: {
      rejectSessions: snapshot.openSessions.map((row) => ({ id: row.id, customerName: row.customer_name })),
      archiveItem: snapshot.items[0]?.active ? { id: snapshot.items[0].id, name: snapshot.items[0].name } : null
    },
    snapshot: {
      item: snapshot.items,
      sessions: snapshot.sessions,
      bills: snapshot.bills,
      lines: billLines,
      payments,
      sessionItems,
      movements: itemMovements,
      events,
      audits,
      openSessions: snapshot.openSessions,
      openTabs: snapshot.openTabs,
      appState: {
        version: snapshot.appState.version,
        hash: createHash("sha256").update(JSON.stringify(snapshot.appState.data)).digest("hex")
      }
    },
    failures: recoveryFailures
  };
  const recoveryDirectory = path.join(root, "test-artifacts", "reconciliation");
  const baseRecoveryPath = path.join(recoveryDirectory, `checkout-session-item-race-recovery-${runId}.json`);
  const reconciliationId = env.E2E_RECONCILIATION_ID?.trim();
  if (fs.existsSync(baseRecoveryPath) && !reconciliationId) {
    throw new Error("E2E_RECONCILIATION_ID is required to preserve the prior immutable recovery artifact.");
  }
  const recoveryPath = fs.existsSync(baseRecoveryPath)
    ? path.join(recoveryDirectory, `checkout-session-item-race-recovery-${runId}-${sanitizeRunId(reconciliationId)}.json`)
    : baseRecoveryPath;
  fs.mkdirSync(recoveryDirectory, { recursive: true });
  fs.writeFileSync(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.error(JSON.stringify({ ...recovery, artifact: path.relative(root, recoveryPath) }, null, 2));
  process.exitCode = 2;
} else {
  const evidence = JSON.parse(fs.readFileSync(finalCandidate.fullPath, "utf8"));
  if (evidence.runId !== runId || evidence.itemName !== itemName || !Array.isArray(evidence.scenarios) ||
      JSON.stringify(evidence.selectedScenarios) !== JSON.stringify(scenarios)) {
    throw new Error("The final browser checkpoint is not bound to this exact run identity.");
  }
  if (evidence.scenarios.length !== scenarios.length ||
      evidence.scenarios.map((entry) => entry.scenario).join(",") !== scenarios.join(",")) {
    throw new Error("The final checkpoint does not contain the exact reviewed scenario selection.");
  }
  const itemId = evidence.fixture?.itemId;
  if (!itemId) throw new Error("The final checkpoint omitted the acknowledged fixture item id.");

  const failures = [];
  const scenarioPostflight = [];
  const assert = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const sorted = (values) => [...values].sort();
  const exactIds = (rows, expected) => JSON.stringify(sorted(rows.map((row) => row.id))) === JSON.stringify(sorted(expected));

  for (const scenario of evidence.scenarios) {
    const expectedFinancial = scenario.expectedFinancial;
    const expectedOperational = scenario.expectedOperational;
    const sessionId = scenario.sessionId;
    const billId = scenario.candidateBillId;
    const checkoutMutationId = scenario.checkoutMutationId;
    const itemMutationId = scenario.itemMutationId;
    const checkoutActor = evidence.actors.checkout;
    const itemActor = evidence.actors.item;
    const checkoutAuditIds = expectedFinancial.audits.map((row) => String(row.id));
    const [
      sessions,
      bills,
      lines,
      payments,
      checkoutEvents,
      itemEvents,
      checkoutAudits,
      itemAudits,
      sessionItems,
      reservationMovements,
      mutation
    ] = await Promise.all([
      query(`${scenario.scenario} session`, client.from("sessions")
        .select("id,customer_name,status,close_disposition,closed_bill_id")
        .eq("organization_id", organizationId).eq("id", sessionId)),
      query(`${scenario.scenario} bill`, client.from("bills")
        .select("id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id")
        .eq("organization_id", organizationId).eq("id", billId)),
      query(`${scenario.scenario} lines`, client.from("bill_lines")
        .select("id,bill_id,type,inventory_item_id,quantity,unit_price,total,linked_session_id,raw_data")
        .eq("organization_id", organizationId).eq("bill_id", billId)),
      query(`${scenario.scenario} payments`, client.from("payments")
        .select("id,bill_id,amount,mode,received_by_user_id")
        .eq("organization_id", organizationId).eq("bill_id", billId)),
      query(`${scenario.scenario} checkout event`, client.from("operational_events")
        .select("id,event_type,entity_type,entity_id,created_by,metadata")
        .eq("organization_id", organizationId).eq("metadata->>mutation_id", checkoutMutationId)),
      query(`${scenario.scenario} item event`, client.from("operational_events")
        .select("id,event_type,entity_type,entity_id,created_by,metadata")
        .eq("organization_id", organizationId).eq("metadata->>mutation_id", itemMutationId)),
      checkoutAuditIds.length
        ? query(`${scenario.scenario} checkout audits`, client.from("audit_logs")
          .select("id,action,entity_type,entity_id,user_id")
          .eq("organization_id", organizationId).in("id", checkoutAuditIds))
        : Promise.resolve([]),
      query(`${scenario.scenario} item audit`, client.from("audit_logs")
        .select("id,action,entity_type,entity_id,user_id")
        .eq("organization_id", organizationId).eq("id", expectedOperational.auditLog.id)),
      query(`${scenario.scenario} item row`, client.from("session_items")
        .select("id,session_id,inventory_item_id,name,quantity,unit_price,raw_data")
        .eq("organization_id", organizationId).eq("id", expectedOperational.item.id)),
      query(`${scenario.scenario} reservation`, client.from("stock_movements")
        .select("id,item_id,type,quantity,user_id,related_bill_id")
        .eq("organization_id", organizationId).eq("id", expectedOperational.stockMovement.id)),
      query(`${scenario.scenario} financial mutation`, client.rpc("get_financial_mutation_result", {
        payload: {
          organization_id: organizationId,
          mutation_id: checkoutMutationId,
          mutation_kind: "commitCheckoutBill"
        }
      }))
    ]);

    assert(sessions.length === 1, `${scenario.scenario}: exact session is missing.`);
    if (scenario.winner === "checkout") {
      assert(sessions[0]?.status === "closed" && sessions[0]?.close_disposition === "billed" && sessions[0]?.closed_bill_id === billId,
        `${scenario.scenario}: checkout winner did not leave the exact billed session.`);
      assert(bills.length === 1 && bills[0].bill_number === scenario.candidateBillNumber && bills[0].status === "issued",
        `${scenario.scenario}: canonical bill is missing or changed.`);
      assert(Number(bills[0]?.total) === Number(expectedFinancial.bill.total) &&
        Number(bills[0]?.amount_paid) === Number(expectedFinancial.bill.amountPaid) &&
        Number(bills[0]?.amount_due) === Number(expectedFinancial.bill.amountDue),
      `${scenario.scenario}: bill arithmetic changed.`);
      assert(bills[0]?.issued_by_user_id === checkoutActor, `${scenario.scenario}: bill actor changed.`);
      assert(exactIds(lines, expectedFinancial.lines.map((row) => String(row.id))), `${scenario.scenario}: line ids changed.`);
      assert(lines.every((row) => row.bill_id === billId && row.linked_session_id === sessionId),
        `${scenario.scenario}: bill line relationship changed.`);
      assert(exactIds(payments, expectedFinancial.payments.map((row) => String(row.id))), `${scenario.scenario}: payment ids changed.`);
      assert(payments.every((row) => row.bill_id === billId && row.received_by_user_id === checkoutActor),
        `${scenario.scenario}: payment actor or bill relationship changed.`);
      assert(exactIds(checkoutAudits, checkoutAuditIds) && checkoutAudits.every((row) => row.user_id === checkoutActor),
        `${scenario.scenario}: checkout audits changed.`);
      assert(checkoutEvents.length === 1 && checkoutEvents[0].event_type === "financial_checkout_committed_v2" &&
        checkoutEvents[0].entity_id === sessionId && checkoutEvents[0].created_by === checkoutActor &&
        checkoutEvents[0].metadata?.mutation_id === checkoutMutationId,
      `${scenario.scenario}: checkout event changed.`);
      assert(mutation?.mutation_id === checkoutMutationId && mutation?.bill_id === billId,
      `${scenario.scenario}: canonical financial mutation changed.`);
      assert(itemEvents.length === 0 && itemAudits.length === 0 && sessionItems.length === 0 && reservationMovements.length === 0,
        `${scenario.scenario}: losing item command left an effect.`);
    } else if (scenario.winner === "item") {
      assert(sessions[0]?.status === "closed" && sessions[0]?.close_disposition === "rejected" && sessions[0]?.closed_bill_id === null,
        `${scenario.scenario}: item winner cleanup did not close the exact session as rejected.`);
      assert(bills.length === 0 && lines.length === 0 && payments.length === 0 && checkoutEvents.length === 0 &&
        checkoutAudits.length === 0 && mutation === null,
      `${scenario.scenario}: losing checkout left a financial effect.`);
      assert(sessionItems.length === 1 && sessionItems[0].session_id === sessionId &&
        sessionItems[0].inventory_item_id === itemId && sessionItems[0].name === itemName &&
        Number(sessionItems[0].quantity) === 1 && Number(sessionItems[0].unit_price) === 50,
      `${scenario.scenario}: exact session item changed.`);
      assert(reservationMovements.length === 1 && reservationMovements[0].item_id === itemId &&
        reservationMovements[0].type === "session_reservation" && Number(reservationMovements[0].quantity) === -1 &&
        reservationMovements[0].user_id === itemActor && reservationMovements[0].related_bill_id === null,
      `${scenario.scenario}: exact reservation changed.`);
      assert(itemAudits.length === 1 && itemAudits[0].action === "session_item_added" &&
        itemAudits[0].entity_id === sessionId && itemAudits[0].user_id === itemActor,
      `${scenario.scenario}: item audit changed.`);
      assert(itemEvents.length === 1 && itemEvents[0].event_type === "add_session_item" &&
        itemEvents[0].entity_id === sessionId && itemEvents[0].created_by === itemActor &&
        itemEvents[0].metadata?.mutation_id === itemMutationId,
      `${scenario.scenario}: item event changed.`);
      assert(scenario.cleanup?.result?.mutationId && scenario.cleanup?.result?.eventId,
        `${scenario.scenario}: acknowledged cleanup identity is absent.`);
    } else {
      failures.push(`${scenario.scenario}: winner was not reconciled.`);
    }

    assert(scenario.captureCounts?.checkout === 1 && scenario.captureCounts?.item === 1,
      `${scenario.scenario}: captured command cardinality is not exactly one each.`);
    scenarioPostflight.push({
      scenario: scenario.scenario,
      winner: scenario.winner,
      session: sessions[0],
      billCount: bills.length,
      lineIds: sorted(lines.map((row) => row.id)),
      paymentIds: sorted(payments.map((row) => row.id)),
      checkoutEventIds: sorted(checkoutEvents.map((row) => row.id)),
      itemEventIds: sorted(itemEvents.map((row) => row.id)),
      sessionItemIds: sorted(sessionItems.map((row) => row.id)),
      reservationIds: sorted(reservationMovements.map((row) => row.id)),
      mutationPresent: mutation !== null
    });
  }

  const snapshot = await liveSnapshot();
  assert(snapshot.items.length === 1 && snapshot.items[0].id === itemId && snapshot.items[0].name === itemName &&
    Number(snapshot.items[0].stock_qty) === 3 && snapshot.items[0].active === false,
  "The exact QA fixture is not archived at unchanged physical stock 3.");
  assert(snapshot.sessions.length === scenarios.length && snapshot.sessions.every((row) => row.status === "closed"),
    "The exact selected QA sessions are not all closed.");
  assert(snapshot.openSessions.length === 0 && snapshot.openTabs.length === 0, "The staging floor is not empty.");
  const itemWinnerCount = evidence.scenarios.filter((entry) => entry.winner === "item").length;
  assert(snapshot.appState.version === evidence.fixture.appState.version + itemWinnerCount + 1,
    "Compatibility version did not advance exactly once per item-winner rejection plus fixture archive.");
  assert(evidence.scenarios.every((entry) =>
    entry.database?.appState?.version === evidence.fixture.appState.version +
      evidence.scenarios.slice(0, evidence.scenarios.indexOf(entry)).filter((prior) => prior.winner === "item").length
  ), "A financial/item race unexpectedly changed app_state compatibility.");

  const postflight = {
    status: failures.length === 0 ? "passed" : "failed",
    runId,
    checkedAt: new Date().toISOString(),
    projectRef: STAGING_PROJECT_REF,
    productionAllowed: false,
    sourceEvidence: path.relative(root, finalCandidate.fullPath),
    selectedScenarios: scenarios,
    scenarioPostflight,
    fixture: snapshot.items[0] ?? null,
    runSessions: snapshot.sessions,
    runBills: snapshot.bills,
    emptyFloor: { sessions: snapshot.openSessions, tabs: snapshot.openTabs },
    appState: {
      version: snapshot.appState.version,
      hash: createHash("sha256").update(JSON.stringify(snapshot.appState.data)).digest("hex")
    },
    failures
  };
  const outputDirectory = path.join(root, "test-artifacts", "reconciliation");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `checkout-session-item-race-postflight-${runId}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(postflight, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  if (failures.length) {
    console.error(JSON.stringify({ ...postflight, artifact: path.relative(root, outputPath) }, null, 2));
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify({ ...postflight, artifact: path.relative(root, outputPath) }, null, 2));
  }
}
