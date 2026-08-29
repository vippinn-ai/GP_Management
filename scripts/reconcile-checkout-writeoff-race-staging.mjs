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
const temporaryAdmin = loadSessionItemRaceAdmin(root, { required: true });
const env = { ...localEnv, ...temporaryAdmin.overlay, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);
if (!env.E2E_RUN_ID?.trim()) throw new Error("E2E_RUN_ID is required for checkout-writeoff reconciliation.");
const runId = sanitizeRunId(env.E2E_RUN_ID);
const reconciliationId = env.E2E_CHECKOUT_WRITEOFF_RECONCILIATION_ID?.trim()
  ? sanitizeRunId(env.E2E_CHECKOUT_WRITEOFF_RECONCILIATION_ID)
  : null;
const reconciliationRevisionId = env.E2E_CHECKOUT_WRITEOFF_RECONCILIATION_REVISION_ID?.trim()
  ? sanitizeRunId(env.E2E_CHECKOUT_WRITEOFF_RECONCILIATION_REVISION_ID)
  : null;
if (reconciliationId && reconciliationRevisionId) throw new Error("Choose cleanup postflight or read-only reconciliation revision, not both.");
let cleanupLineage = null;
if (reconciliationId) {
  const recoveryPath = env.E2E_CHECKOUT_WRITEOFF_RECOVERY_ARTIFACT?.trim();
  const recoverySha256 = env.E2E_CHECKOUT_WRITEOFF_RECOVERY_SHA256?.trim();
  const cleanupPath = env.E2E_CHECKOUT_WRITEOFF_CLEANUP_EVIDENCE?.trim();
  const cleanupSha256 = env.E2E_CHECKOUT_WRITEOFF_CLEANUP_EVIDENCE_SHA256?.trim();
  if (!recoveryPath || !recoverySha256 || !cleanupPath || !cleanupSha256 || !fs.existsSync(recoveryPath) || !fs.existsSync(cleanupPath)) {
    throw new Error("Cleanup postflight requires exact recovery and cleanup evidence paths plus SHA-256 values.");
  }
  const recoveryBytes = fs.readFileSync(recoveryPath);
  const cleanupBytes = fs.readFileSync(cleanupPath);
  if (createHash("sha256").update(recoveryBytes).digest("hex") !== recoverySha256 ||
      createHash("sha256").update(cleanupBytes).digest("hex") !== cleanupSha256) {
    throw new Error("Cleanup postflight lineage artifact SHA-256 mismatch.");
  }
  const recovery = JSON.parse(recoveryBytes.toString("utf8"));
  const cleanup = JSON.parse(cleanupBytes.toString("utf8"));
  if (recovery.runId !== runId || recovery.safeForIdentityBoundCleanup !== true || recovery.safeForAutomaticRetry !== false ||
      cleanup.sourceRunId !== runId || cleanup.cleanupRunId !== reconciliationId || cleanup.recoveryArtifact !== path.resolve(recoveryPath) ||
      cleanup.recoverySha256 !== recoverySha256) {
    throw new Error("Cleanup postflight evidence is not bound to the authorized recovery artifact.");
  }
  cleanupLineage = { recoveryPath, recoverySha256, cleanupPath, cleanupSha256, recovery, cleanup };
}
const organizationId = "org-primary";
const allScenarios = ["checkout_first", "writeoff_first", "simultaneous"];
const approvedSelections = [allScenarios, ["writeoff_first", "simultaneous"], ["simultaneous"]];
const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-writeoff-race-preflight-${runId}.json`);
if (!fs.existsSync(preflightPath)) throw new Error("The exact checkout-writeoff preflight is required for reconciliation.");
const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
const expectedScenarios = Array.isArray(preflight.scenarios) && approvedSelections.some((selection) =>
  JSON.stringify(selection) === JSON.stringify(preflight.scenarios)
) ? preflight.scenarios : null;
if (!expectedScenarios || preflight.runId !== runId || preflight.mode !== "writeoff" ||
    preflight.productionAllowed !== false || preflight.safeForAutomaticRetry !== false) {
  throw new Error("The checkout-writeoff preflight identity or scenario selection is invalid.");
}
const evidenceDirectory = path.join(root, "test-artifacts", "evidence");
const finalPath = path.join(evidenceDirectory, `checkout-writeoff-race-final-checkpoint-${runId}.json`);
const phases = ["reconciled", "cleanup-acknowledged", "responses", "prepared"];

function readCheckpoint(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return { value: JSON.parse(text), path: filePath, sha256: createHash("sha256").update(text).digest("hex") };
}

let sources = [];
if (fs.existsSync(finalPath)) {
  const final = readCheckpoint(finalPath);
  if (final.value.status !== "completed" || final.value.mode !== "writeoff" || final.value.runId !== runId ||
      final.value.productionAllowed !== false ||
      JSON.stringify(final.value.selectedScenarios) !== JSON.stringify(expectedScenarios) || !Array.isArray(final.value.scenarios) ||
      JSON.stringify(final.value.scenarios.map((entry) => entry.scenario)) !== JSON.stringify(expectedScenarios)) {
    throw new Error("The checkout-writeoff final checkpoint has an invalid identity or scenario set.");
  }
  sources = final.value.scenarios.map((value) => ({ scenario: value.scenario, phase: "final", value, path: final.path, sha256: final.sha256 }));
} else {
  sources = expectedScenarios.flatMap((scenario) => {
    const selected = phases.map((phase) => ({ phase, path: path.join(evidenceDirectory, `checkout-writeoff-race-${scenario}-${phase}-${runId}.json`) }))
      .find((candidate) => fs.existsSync(candidate.path));
    if (!selected) return [];
    const checkpoint = readCheckpoint(selected.path);
    if (checkpoint.value.runId !== runId || checkpoint.value.scenario !== scenario) throw new Error(`${scenario} checkpoint identity mismatch.`);
    return [{ scenario, phase: selected.phase, value: checkpoint.value, path: selected.path, sha256: checkpoint.sha256 }];
  });
}
if (!sources.length) throw new Error("No immutable checkout-writeoff checkpoint exists for this run identity.");

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Checkout-writeoff reconciliation is locked to exact staging.");
}
async function authenticate(slot) {
  const client = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const lookup = await client.functions.invoke("resolve-login-email", { body: { username: env[`E2E_USER_${slot}`].trim() } });
  if (lookup.error || !lookup.data?.email) throw new Error(`Unable to resolve staging slot ${slot}.`);
  const login = await client.auth.signInWithPassword({ email: lookup.data.email, password: env[`E2E_PASSWORD_${slot}`] });
  if (login.error || !login.data.user) throw new Error(`Unable to authenticate staging slot ${slot}.`);
  const role = await client.rpc("current_user_org_role", { target_organization_id: organizationId });
  if (role.error || role.data !== "admin") throw new Error(`Staging slot ${slot} is not an authoritative admin.`);
  return { client, actorId: login.data.user.id };
}
const origin = await authenticate("A");
const observer = await authenticate("B");
if (origin.actorId === observer.actorId) throw new Error("Reconciliation requires the two distinct execution actors.");
const supabase = origin.client;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const same = (actual, expected) => JSON.stringify(stable(actual)) === JSON.stringify(stable(expected));
const sameIds = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
const ids = (rows) => rows.map((row) => row.id);
const list = (values, fallback) => {
  const compact = [...new Set(values.filter(Boolean))];
  return compact.length ? compact : [fallback];
};
function check(condition, message, failures) {
  if (!condition) failures.push(message);
}
function ensureOk(label, result) {
  if (result.error) throw new Error(`${label} reconciliation query failed: ${result.error.message}`);
}
async function mutationStatus(client, mutationId, mutationKind) {
  if (!mutationId) return null;
  const result = await client.rpc("get_financial_mutation_result", {
    payload: { organization_id: organizationId, mutation_id: mutationId, mutation_kind: mutationKind }
  });
  ensureOk(`${mutationKind}:${mutationId}`, result);
  return result.data;
}

const failures = [];
const actors = { checkout: origin.actorId, writeoff: observer.actorId };
const presentScenarios = sources.map((entry) => entry.scenario);
check(JSON.stringify(presentScenarios) === JSON.stringify(expectedScenarios.slice(0, presentScenarios.length)),
  "Scenario checkpoints are not a contiguous prefix of the approved serial order.", failures);
for (const source of sources) {
  check(source.value.actors?.checkout === actors.checkout && source.value.actors?.writeoff === actors.writeoff,
    `${source.scenario}: checkpoint actors do not match reconciliation actors.`, failures);
}

const customerNames = expectedScenarios.map((scenario) => `QA Checkout Writeoff Race ${runId} ${scenario}`);
const candidateBillNumbers = expectedScenarios.map((scenario) => `BILL-QA-WRITEOFF-RACE-${runId}-${scenario}`);
const sessionIds = sources.flatMap(({ value }) => [value.firstSessionId, value.secondSessionId]).filter(Boolean);
const pendingBillIds = sources.map(({ value }) => value.pendingBillId).filter(Boolean);
const candidateBillIds = sources.map(({ value }) => value.candidateBillId).filter(Boolean);
const billIds = list([...pendingBillIds, ...candidateBillIds], "missing-writeoff-race-bill");
const setupAcknowledgements = sources.flatMap(({ value }) => value.setupOperationalEvidence ?? []).filter((entry) => entry.status < 300 && entry.mutationId);
const mutationIds = sources.flatMap(({ value }) => [value.setupMutationId, value.checkoutMutationId, value.writeoffMutationId, value.cleanup?.rejection?.mutationId]).filter(Boolean)
  .concat(setupAcknowledgements.map((entry) => entry.mutationId));
const entityIds = list([...sessionIds, ...pendingBillIds, ...candidateBillIds], "missing-writeoff-race-entity");
const explicitEventIds = list(setupAcknowledgements.map((entry) => entry.eventId), "missing-writeoff-race-event");
const explicitAuditIds = list(sources.flatMap(({ value }) => [
  ...(value.setupOperationalEvidence ?? []).flatMap((entry) => entry.changedRows?.audit_logs ?? []),
  ...(value.expectedCheckout?.audits ?? []).map((entry) => entry.id),
  ...(value.expectedWriteoff?.audits ?? []).map((entry) => entry.id),
  ...(value.cleanup?.rejection?.changedRows?.audit_logs ?? [])
]), "missing-writeoff-race-audit");
const [runSessions, runBills, numberedBills, lines, payments, movements, mutationEvents, entityEvents, explicitEvents, entityAudits, explicitAudits, openSessions, openTabs, appState] = await Promise.all([
  supabase.from("sessions").select("id,status,close_disposition,closed_bill_id,customer_name,station_name_snapshot").eq("organization_id", organizationId).in("customer_name", customerNames),
  supabase.from("bills").select("id,bill_number,customer_name,customer_phone,payment_mode,session_id,status,subtotal,total_discount_amount,bill_discount_amount,round_off_enabled,round_off_amount,total,amount_paid,amount_due,settled_at,voided_at,voided_by_user_id,void_reason,issued_by_user_id").eq("organization_id", organizationId).in("customer_name", customerNames),
  supabase.from("bills").select("id,bill_number,customer_name,customer_phone,payment_mode,session_id,status,subtotal,total_discount_amount,bill_discount_amount,round_off_enabled,round_off_amount,total,amount_paid,amount_due,settled_at,voided_at,voided_by_user_id,void_reason,issued_by_user_id").eq("organization_id", organizationId).in("bill_number", candidateBillNumbers),
  supabase.from("bill_lines").select("id,bill_id,type,description,quantity,unit_price,total,linked_session_id").eq("organization_id", organizationId).in("linked_session_id", list(sessionIds, "missing-writeoff-race-session")),
  supabase.from("payments").select("id,bill_id,amount,mode,received_by_user_id,related_checkout_bill_id").eq("organization_id", organizationId).in("bill_id", billIds),
  supabase.from("stock_movements").select("id,item_id,type,quantity,related_bill_id,user_id").eq("organization_id", organizationId).in("related_bill_id", billIds),
  supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("metadata->>mutation_id", list(mutationIds, "missing-writeoff-race-mutation")),
  supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("entity_id", entityIds),
  supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("id", explicitEventIds),
  supabase.from("audit_logs").select("id,action,entity_type,entity_id,user_id,message").eq("organization_id", organizationId).in("entity_id", entityIds),
  supabase.from("audit_logs").select("id,action,entity_type,entity_id,user_id,message").eq("organization_id", organizationId).in("id", explicitAuditIds),
  supabase.from("sessions").select("id,status,customer_name").eq("organization_id", organizationId).neq("status", "closed"),
  supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single()
]);
for (const [label, result] of Object.entries({ runSessions, runBills, numberedBills, lines, payments, movements, mutationEvents, entityEvents, explicitEvents, entityAudits, explicitAudits, openSessions, openTabs, appState })) ensureOk(label, result);
check(sameIds(ids(runSessions.data), sessionIds), "Run sessions do not exactly match checkpoint identities.", failures);
check(movements.data.length === 0, "The checkout/write-off run created stock movements.", failures);
const eventMap = new Map([...mutationEvents.data, ...entityEvents.data, ...explicitEvents.data].map((row) => [row.id, row]));
const auditMap = new Map([...entityAudits.data, ...explicitAudits.data].map((row) => [row.id, row]));
const uniqueBills = new Map([...runBills.data, ...numberedBills.data].map((row) => [row.id, row]));
const reports = [];
const cleanupCandidates = [];
const expectedBillIds = [];
const expectedEventIds = [];
const expectedAuditIds = [];

function serverAuditMessage(expected, patch) {
  if (expected.action === "session_checkout_details_updated") {
    const update = patch?.session_updates?.find((entry) => entry.id === (expected.entityId ?? expected.entity_id));
    if (!update?.endedAt) return null;
    return `Updated during checkout: end time: not set -> ${new Date(update.endedAt).toISOString()}.`;
  }
  if (expected.action === "bill_issued") {
    const bill = [patch?.primary_bill, ...(patch?.bill_updates ?? [])].find((entry) => entry?.id === (expected.entityId ?? expected.entity_id));
    return bill?.billNumber ? `Issued ${bill.billNumber}.` : null;
  }
  if (expected.action === "bill_pending") {
    const bill = [patch?.primary_bill, ...(patch?.bill_updates ?? [])].find((entry) => entry?.id === (expected.entityId ?? expected.entity_id));
    return bill?.billNumber && Number.isFinite(Number(bill.amountDue))
      ? `${bill.billNumber} issued as pending (due Rs ${Number(bill.amountDue).toFixed(2)}).`
      : null;
  }
  if (expected.action === "bill_settled") {
    const billId = expected.entityId ?? expected.entity_id;
    const settled = patch?.bill_updates?.find((entry) => entry.id === billId);
    const payment = patch?.payments?.find((entry) => entry.billId === billId);
    return settled?.billNumber && patch?.primary_bill?.billNumber && payment
      ? `Settled Rs ${Number(payment.amount).toFixed(2)} on ${settled.billNumber} during checkout ${patch.primary_bill.billNumber}. Remaining due: Rs ${Number(settled.amountDue).toFixed(2)}.`
      : null;
  }
  return expected.message;
}

for (const selected of sources) {
  const source = selected.value;
  const caseFailures = [];
  const expectedWinner = selected.scenario === "checkout_first" ? "checkout" : selected.scenario === "writeoff_first" ? "writeoff" : null;
  const [setupStatus, checkoutStatus, writeoffStatus] = await Promise.all([
    mutationStatus(origin.client, source.setupMutationId, "commitCheckoutBill"),
    mutationStatus(origin.client, source.checkoutMutationId, "commitCheckoutBill"),
    mutationStatus(observer.client, source.writeoffMutationId, "writeOffPendingBills")
  ]);
  check(Boolean(setupStatus), `${selected.scenario}: setup checkout mutation result is missing.`, caseFailures);
  check(Number(Boolean(checkoutStatus)) + Number(Boolean(writeoffStatus)) <= 1,
    `${selected.scenario}: both competing mutations committed.`, caseFailures);
  const winner = checkoutStatus ? "checkout" : writeoffStatus ? "writeoff" : null;
  if (expectedWinner && winner) check(winner === expectedWinner, `${selected.scenario}: deterministic winner changed.`, caseFailures);

  if (source.responses) {
    for (const [operation, result] of [["checkout", checkoutStatus], ["writeoff", writeoffStatus]]) {
      const response = source.responses[operation];
      check(Boolean(response), `${selected.scenario}: ${operation} response is missing.`, caseFailures);
      if (response?.status === 200) check(Boolean(result) && same(result, response.body), `${selected.scenario}: ${operation} canonical result differs from response.`, caseFailures);
      if (response?.status !== 200) check(result === null, `${selected.scenario}: losing ${operation} has a canonical result.`, caseFailures);
    }
  }

  const validateCanonical = (label, result, mutationId, entityId, actorId, eventType) => {
    if (!result) return;
    const event = eventMap.get(result.event_id);
    check(result.mutation_id === mutationId && result.entity_id === entityId, `${selected.scenario}: ${label} canonical identity is wrong.`, caseFailures);
    check(event?.event_type === eventType && event?.entity_id === entityId && event?.created_by === actorId && event?.metadata?.mutation_id === mutationId,
      `${selected.scenario}: ${label} event identity/type/actor is wrong.`, caseFailures);
    const changedRows = { ...(result.changed_rows ?? {}) };
    delete changedRows.operational_events;
    check(event && event.metadata?.changed_rows !== undefined && same(event.metadata.changed_rows, changedRows),
      `${selected.scenario}: ${label} event changed_rows mismatch.`, caseFailures);
    expectedEventIds.push(result.event_id);
    expectedAuditIds.push(...(result.changed_rows?.audit_logs ?? []));
  };
  validateCanonical("setup", setupStatus, source.setupMutationId, source.firstSessionId, actors.checkout, "financial_checkout_committed_v2");
  validateCanonical("checkout", checkoutStatus, source.checkoutMutationId, source.secondSessionId, actors.checkout, "financial_checkout_committed_v2");
  validateCanonical("writeoff", writeoffStatus, source.writeoffMutationId, source.pendingBillId, actors.writeoff, "financial_adjustment_committed_v2");
  if (source.setupResult) {
    check(source.setupResult.eventId === setupStatus?.event_id && sameIds(source.setupResult.changedRows?.bills ?? [], setupStatus?.changed_rows?.bills ?? []),
      `${selected.scenario}: setup acknowledgement differs from canonical result.`, caseFailures);
  }
  for (const acknowledgement of source.setupOperationalEvidence ?? []) {
    if (acknowledgement.status >= 300 || !acknowledgement.mutationId || !acknowledgement.eventId) continue;
    const event = eventMap.get(acknowledgement.eventId);
    const acknowledgementAudits = acknowledgement.changedRows?.audit_logs ?? [];
    check(event?.metadata?.mutation_id === acknowledgement.mutationId && event.created_by === actors.checkout,
      `${selected.scenario}: setup operational acknowledgement ${acknowledgement.rpc} event/actor is wrong.`, caseFailures);
    check((acknowledgement.changedRows?.operational_events ?? [acknowledgement.eventId]).includes(acknowledgement.eventId),
      `${selected.scenario}: setup operational acknowledgement ${acknowledgement.rpc} event self-reference is wrong.`, caseFailures);
    expectedEventIds.push(acknowledgement.eventId);
    expectedAuditIds.push(...acknowledgementAudits);
    const command = (source.setupCommands ?? []).find((entry) => entry.body?.payload?.mutation_id === acknowledgement.mutationId);
    const commandPayload = command?.body?.payload?.payload;
    const commandAudits = commandPayload?.auditLogs ?? commandPayload?.audit_logs ?? (commandPayload?.auditLog ? [commandPayload.auditLog] : []);
    check(Boolean(command), `${selected.scenario}: setup operational acknowledgement ${acknowledgement.rpc} command is missing.`, caseFailures);
    check(sameIds(acknowledgementAudits, commandAudits.map((entry) => entry.id)),
      `${selected.scenario}: setup operational acknowledgement ${acknowledgement.rpc} audit IDs are wrong.`, caseFailures);
    for (const expected of commandAudits) {
      const actual = auditMap.get(expected.id);
      const expectedMessage = serverAuditMessage(expected, commandPayload);
      check(actual?.action === expected.action && actual.entity_id === (expected.entityId ?? expected.entity_id) &&
        expectedMessage !== null && actual.message === expectedMessage && actual.user_id === actors.checkout,
      `${selected.scenario}: setup operational acknowledgement ${acknowledgement.rpc} audit ${expected.id} content is wrong.`, caseFailures);
    }
  }

  const firstSession = runSessions.data.find((row) => row.id === source.firstSessionId);
  const secondSession = runSessions.data.find((row) => row.id === source.secondSessionId);
  const pending = uniqueBills.get(source.pendingBillId);
  const candidate = uniqueBills.get(source.candidateBillId);
  const setupLines = lines.data.filter((row) => row.linked_session_id === source.firstSessionId);
  const secondLines = lines.data.filter((row) => row.linked_session_id === source.secondSessionId);
  const casePayments = payments.data.filter((row) => [source.pendingBillId, source.candidateBillId].includes(row.bill_id));
  expectedBillIds.push(source.pendingBillId);
  check(firstSession?.status === "closed" && firstSession.close_disposition === "billed" && firstSession.closed_bill_id === source.pendingBillId,
    `${selected.scenario}: setup session link is wrong.`, caseFailures);
  check(setupLines.length === 1 && setupLines[0].bill_id === source.pendingBillId && setupLines[0].type === "session_charge",
    `${selected.scenario}: setup line is not exact.`, caseFailures);
  const validateLines = (label, actualLines, expectedLines, billId) => {
    check(sameIds(ids(actualLines), expectedLines.map((row) => row.id)), `${selected.scenario}: ${label} line IDs are not exact.`, caseFailures);
    for (const expected of expectedLines) {
      const actual = actualLines.find((row) => row.id === expected.id);
      check(actual?.bill_id === billId && actual.type === expected.type && actual.description === expected.description &&
        Number(actual.quantity) === Number(expected.quantity) && Number(actual.unit_price) === Number(expected.unitPrice) &&
        Number(actual.total) === Number(expected.total) && (actual.linked_session_id ?? undefined) === expected.linkedSessionId,
      `${selected.scenario}: ${label} line ${expected.id} values are not exact.`, caseFailures);
    }
  };
  const setupPatch = source.setupCommand?.payload?.payload;
  check(Boolean(setupPatch?.primary_bill?.lines), `${selected.scenario}: setup canonical command lines are missing.`, caseFailures);
  if (setupPatch?.primary_bill?.lines) validateLines("setup", setupLines, setupPatch.primary_bill.lines, source.pendingBillId);
  const validateBill = (label, actual, primary, update, actorId, { mutableStatus = false } = {}) => {
    const expected = { ...(primary ?? {}), ...(update ?? {}) };
    check(actual?.id === expected.id && actual.bill_number === expected.billNumber &&
      (actual.customer_name ?? "") === (expected.customerName ?? "") && (actual.customer_phone ?? "") === (expected.customerPhone ?? "") &&
      actual.payment_mode === expected.paymentMode && (actual.session_id ?? "") === (expected.sessionId ?? "") &&
      Number(actual.subtotal) === Number(expected.subtotal) && Number(actual.total_discount_amount) === Number(expected.totalDiscountAmount) &&
      Number(actual.bill_discount_amount) === Number(expected.billDiscountAmount) && actual.round_off_enabled === expected.roundOffEnabled &&
      Number(actual.round_off_amount) === Number(expected.roundOffAmount) && Number(actual.total) === Number(expected.total) &&
      actual.issued_by_user_id === actorId && (mutableStatus || (actual.status === expected.status &&
        Number(actual.amount_paid) === Number(expected.amountPaid) && Number(actual.amount_due) === Number(expected.amountDue))),
    `${selected.scenario}: ${label} bill values are not exact.`, caseFailures);
  };
  const setupUpdate = setupPatch?.bill_updates?.find((entry) => entry.id === source.pendingBillId);
  validateBill("setup", pending, setupPatch?.primary_bill, setupUpdate, actors.checkout, { mutableStatus: true });

  if (winner === "checkout") {
    expectedBillIds.push(source.candidateBillId);
    check(pending?.status === "issued" && Number(pending.amount_due) === 0 && Number(pending.amount_paid) === Number(pending.total),
      `${selected.scenario}: pending bill was not settled exactly.`, caseFailures);
    check(candidate?.status === "issued" && candidate.bill_number === source.candidateBillNumber && candidate.issued_by_user_id === actors.checkout,
      `${selected.scenario}: candidate bill identity/actor is wrong.`, caseFailures);
    const checkoutCommandPatch = source.submissionPlan?.checkout?.payload?.payload;
    const checkoutUpdate = checkoutCommandPatch?.bill_updates?.find((entry) => entry.id === source.candidateBillId);
    validateBill("checkout", candidate, checkoutCommandPatch?.primary_bill, checkoutUpdate, actors.checkout);
    check(secondSession?.status === "closed" && secondSession.close_disposition === "billed" && secondSession.closed_bill_id === source.candidateBillId,
      `${selected.scenario}: checkout session state is wrong.`, caseFailures);
    check(secondLines.length === 1 && secondLines[0].bill_id === source.candidateBillId && secondLines[0].type === "session_charge",
      `${selected.scenario}: checkout line is not exact.`, caseFailures);
    validateLines("checkout", secondLines, source.expectedCheckout?.bill?.lines ?? [], source.candidateBillId);
    const expectedPayments = source.expectedCheckout?.payments ?? [];
    check(sameIds(ids(casePayments), expectedPayments.map((row) => row.id)), `${selected.scenario}: payment IDs are not exact.`, caseFailures);
    for (const expected of expectedPayments) {
      const actual = casePayments.find((row) => row.id === expected.id);
      check(actual && actual.bill_id === expected.billId && Number(actual.amount) === Number(expected.amount) && actual.received_by_user_id === actors.checkout &&
        actual.mode === expected.mode && (actual.related_checkout_bill_id ?? undefined) === expected.relatedCheckoutBillId,
      `${selected.scenario}: payment ${expected.id} amount/link/actor is wrong.`, caseFailures);
    }
  } else if (winner === "writeoff") {
    check(pending?.status === "voided" && Number(pending.amount_paid) === 0 && Number(pending.amount_due) === Number(source.authoritativePendingBillBefore?.amount_due) &&
      pending.void_reason === source.reason && pending.voided_by_user_id === actors.writeoff,
    `${selected.scenario}: write-off state/reason/actor is wrong.`, caseFailures);
    check(!candidate && !secondLines.length && !casePayments.length, `${selected.scenario}: losing checkout created financial rows.`, caseFailures);
    check(secondSession?.status === "active" || (secondSession?.status === "closed" && secondSession.close_disposition === "rejected"),
      `${selected.scenario}: write-off source session state is unsafe.`, caseFailures);
  } else {
    check(pending?.status === "pending" && Number(pending.amount_paid) === 0 && !candidate && !secondLines.length && !casePayments.length,
      `${selected.scenario}: zero-result race has financial effects.`, caseFailures);
    check((secondSession?.status === "active" && secondSession.close_disposition === null && secondSession.closed_bill_id === null) ||
      (secondSession?.status === "closed" && secondSession.close_disposition === "rejected" && secondSession.closed_bill_id === null),
    `${selected.scenario}: zero-result source session is not exact active/rejected.`, caseFailures);
  }
  if ((!winner || winner === "writeoff") && secondSession?.status === "active") {
    cleanupCandidates.push({ scenario: selected.scenario, sessionId: source.secondSessionId, customerName: source.customerName, station: source.station,
      reason: `Identity-bound checkout-writeoff recovery ${runId} ${selected.scenario}`, sourceCheckpoint: path.relative(root, selected.path) });
  }

  const expectedAudits = winner === "checkout" ? source.expectedCheckout?.audits ?? [] : winner === "writeoff" ? source.expectedWriteoff?.audits ?? [] : [];
  const setupAudits = setupPatch?.audit_logs ?? [];
  const validateAudits = (label, expectedRows, actorId, patch) => {
    for (const expected of expectedRows) {
      const audit = auditMap.get(expected.id);
      const entityId = expected.entityId ?? expected.entity_id;
      const expectedMessage = serverAuditMessage(expected, patch);
      check(audit?.action === expected.action && audit.entity_id === entityId && audit.user_id === actorId &&
        expectedMessage !== null && audit.message === expectedMessage, `${selected.scenario}: ${label} audit ${expected.id} is wrong.`, caseFailures);
    }
  };
  validateAudits("setup", setupAudits, actors.checkout, setupPatch);
  check(sameIds(setupStatus?.changed_rows?.audit_logs ?? [], setupAudits.map((row) => row.id)), `${selected.scenario}: setup audit IDs mismatch.`, caseFailures);
  const winnerPatch = winner === "checkout"
    ? source.submissionPlan?.checkout?.payload?.payload
    : source.submissionPlan?.writeoff?.payload?.payload;
  validateAudits("winner", expectedAudits, winner === "checkout" ? actors.checkout : actors.writeoff, winnerPatch);
  if (winner === "checkout") check(sameIds(checkoutStatus?.changed_rows?.audit_logs ?? [], expectedAudits.map((row) => row.id)), `${selected.scenario}: checkout audit IDs mismatch.`, caseFailures);
  if (winner === "writeoff") check(sameIds(writeoffStatus?.changed_rows?.audit_logs ?? [], expectedAudits.map((row) => row.id)), `${selected.scenario}: write-off audit IDs mismatch.`, caseFailures);

  const cleanup = source.cleanup?.rejection;
  if (cleanup) {
    const event = eventMap.get(cleanup.eventId);
    const auditIds = cleanup.changedRows?.audit_logs ?? [];
    const cleanupAudits = [...auditMap.values()].filter((row) => auditIds.includes(row.id));
    check(event?.event_type === "reject_session" && event.entity_id === source.secondSessionId && event.created_by === actors.checkout && event.metadata?.mutation_id === cleanup.mutationId,
      `${selected.scenario}: cleanup event is wrong.`, caseFailures);
    check(cleanupAudits.length === auditIds.length && cleanupAudits.every((row) => row.entity_id === source.secondSessionId && row.user_id === actors.checkout),
      `${selected.scenario}: cleanup audits are wrong.`, caseFailures);
    expectedEventIds.push(cleanup.eventId);
    expectedAuditIds.push(...auditIds);
  } else if (cleanupLineage && secondSession?.status === "closed" && secondSession.close_disposition === "rejected") {
    const recoveryReason = `Identity-bound checkout-writeoff recovery ${runId} ${selected.scenario}`;
    const rejectEvents = [...eventMap.values()].filter((row) => row.entity_id === source.secondSessionId && row.event_type === "reject_session");
    const rejectAudits = [...auditMap.values()].filter((row) => row.entity_id === source.secondSessionId && row.action === "session_rejected");
    const rejection = cleanupLineage.cleanup.rejection;
    check(cleanupLineage.cleanup.sessionId === source.secondSessionId && rejection?.entityId === source.secondSessionId &&
      rejectEvents.length === 1 && rejectEvents[0].id === rejection.eventId && rejectEvents[0].created_by === actors.checkout &&
      rejectEvents[0].metadata?.mutation_id === rejection.mutationId,
      `${selected.scenario}: identity-bound recovery reject event is not exact.`, caseFailures);
    check(sameIds(rejection?.changedRows?.audit_logs ?? [], ids(rejectAudits)) && rejectAudits.length === 1 && rejectAudits[0].user_id === actors.checkout &&
      rejectAudits[0].message === `Rejected ${source.station}. Reason: ${recoveryReason}`,
    `${selected.scenario}: identity-bound recovery reject audit is not exact.`, caseFailures);
    expectedEventIds.push(rejection?.eventId);
    expectedAuditIds.push(...(rejection?.changedRows?.audit_logs ?? []));
  }
  check(!source.compatibilityAfterFinancial || same(source.compatibilityBefore, source.compatibilityAfterFinancial),
    `${selected.scenario}: financial race changed app_state.`, caseFailures);
  failures.push(...caseFailures);
  reports.push({ scenario: selected.scenario, sourcePhase: selected.phase, sourceCheckpoint: path.relative(root, selected.path), sourceCheckpointSha256: selected.sha256,
    winner, failures: caseFailures, mutationResults: { setup: setupStatus, checkout: checkoutStatus, writeoff: writeoffStatus },
    database: { firstSession, secondSession, pendingBill: pending ?? null, candidateBill: candidate ?? null, lines: [...setupLines, ...secondLines], payments: casePayments } });
}

check(sameIds([...uniqueBills.keys()], expectedBillIds), "Run bills do not exactly match deterministic outcomes.", failures);
check(sameIds([...eventMap.keys()], [...new Set(expectedEventIds)]), "Run operational events do not exactly match acknowledged/canonical results.", failures);
check(sameIds([...auditMap.keys()], [...new Set(expectedAuditIds)]), "Run audits do not exactly match acknowledged/canonical results.", failures);
const unexpectedOpenSessions = openSessions.data.filter((row) => !cleanupCandidates.some((candidate) => candidate.sessionId === row.id));
check(openTabs.data.length === 0, "An open customer tab remains.", failures);
check(unexpectedOpenSessions.length === 0, "An open session outside exact cleanup candidates remains.", failures);
const complete = sources.length === expectedScenarios.length && reports.every((entry) => entry.winner) && cleanupCandidates.length === 0 && !openSessions.data.length && !openTabs.data.length;
const safeForIdentityBoundCleanup = failures.length === 0 && cleanupCandidates.length === 1 && openSessions.data.length === 1 && !unexpectedOpenSessions.length && !openTabs.data.length;
const status = failures.length ? "blocked" : complete ? "passed" : "partial";
const report = {
  status, mode: "writeoff", runId, checkedAt: new Date().toISOString(), projectRef: STAGING_PROJECT_REF, organizationId,
  reconciliationRevisionId,
  productionAllowed: false, safeForAutomaticRetry: false, safeForIdentityBoundCleanup, failures,
  selectedScenarios: expectedScenarios,
  sourceCheckpoints: sources.map((entry) => ({ scenario: entry.scenario, phase: entry.phase, path: path.relative(root, entry.path), sha256: entry.sha256 })),
  cleanupLineage: cleanupLineage ? {
    recoveryArtifact: path.relative(root, cleanupLineage.recoveryPath), recoverySha256: cleanupLineage.recoverySha256,
    cleanupEvidence: path.relative(root, cleanupLineage.cleanupPath), cleanupSha256: cleanupLineage.cleanupSha256,
    cleanupRunId: reconciliationId
  } : null,
  scenarios: reports, cleanupCandidates,
  exactRunData: { sessions: runSessions.data, bills: [...uniqueBills.values()], lines: lines.data, payments: payments.data, stockMovements: movements.data,
    mutationEvents: mutationEvents.data, entityEvents: [...eventMap.values()], entityAudits: [...auditMap.values()] },
  openFloor: { sessions: openSessions.data, tabs: openTabs.data },
  appState: { version: appState.data.version, hash: createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex") }
};
const outputDirectory = path.join(root, "test-artifacts", "reconciliation");
fs.mkdirSync(outputDirectory, { recursive: true });
const outputSuffix = reconciliationId ?? reconciliationRevisionId;
const outputPath = path.join(outputDirectory, `checkout-writeoff-race-reconciliation-${runId}${outputSuffix ? `-${outputSuffix}` : ""}.json`);
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ artifact: path.relative(root, outputPath), report }, null, 2));
if (status !== "passed") process.exitCode = 2;
