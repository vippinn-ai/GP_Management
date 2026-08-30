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
const organizationId = "org-primary";
const cases = ["upi", "split", "partial_previous_dues"];
const args = process.argv.slice(2);
if (args.length !== 1 || !args[0].startsWith("--case=")) throw new Error("Payment-matrix reconciliation accepts exactly one --case=<case>.");
const selectedCase = args[0].slice("--case=".length);
if (!cases.includes(selectedCase)) throw new Error(`Unknown payment-matrix case: ${selectedCase}.`);

const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);
const runId = sanitizeRunId(env.E2E_RUN_ID);
const customerName = `QA Payment Matrix ${selectedCase.replaceAll("_", " ")} ${runId}`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function sameIds(left, right) {
  return JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
}

function assertNoSecrets(value) {
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
  if (forbidden.length) throw new Error(`Refusing to persist sensitive payment reconciliation evidence: ${forbidden.join(", ")}`);
}

function readJsonIfPresent(target) {
  if (!fs.existsSync(target)) return null;
  const raw = fs.readFileSync(target);
  return { value: JSON.parse(raw.toString("utf8")), sha256: sha256(raw), path: path.relative(root, target) };
}

const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-payment-matrix-preflight-${selectedCase}-${runId}.json`);
const preflightFile = readJsonIfPresent(preflightPath);
if (!preflightFile) throw new Error("The exact payment-matrix preflight artifact is missing.");
const preflight = preflightFile.value;
if (!preflight.safeToRun || preflight.productionAllowed !== false || preflight.safeForAutomaticRetry !== false ||
    preflight.runId !== runId || preflight.selectedCase !== selectedCase || preflight.projectRef !== STAGING_PROJECT_REF ||
    preflight.fixture?.customerName !== customerName) throw new Error("The payment-matrix preflight lineage is invalid.");

const evidenceDirectory = path.join(root, "test-artifacts", "evidence");
const terminalFile = readJsonIfPresent(path.join(evidenceDirectory, `checkout-payment-matrix-${selectedCase}-final-${runId}.json`)) ??
  readJsonIfPresent(path.join(evidenceDirectory, `checkout-payment-matrix-${selectedCase}-failure-${runId}.json`));
const labels = selectedCase === "partial_previous_dues" ? ["source", "current"] : ["current"];
const checkpoints = labels.map((label) => ({
  label,
  prepared: readJsonIfPresent(path.join(evidenceDirectory, `checkout-payment-matrix-${selectedCase}-${label}-prepared-${runId}.json`)),
  response: readJsonIfPresent(path.join(evidenceDirectory, `checkout-payment-matrix-${selectedCase}-${label}-response-${runId}.json`))
}));

const lineageFailures = [];
for (const checkpoint of checkpoints) {
  if (!checkpoint.prepared && checkpoint.response) lineageFailures.push(`${checkpoint.label}: response exists without a prepared checkpoint.`);
  if (!checkpoint.prepared) continue;
  const prepared = checkpoint.prepared.value;
  const command = prepared.command;
  const payload = command?.payload;
  const financial = payload?.payload;
  if (prepared.runId !== runId || prepared.selectedCase !== selectedCase || prepared.productionAllowed !== false || prepared.safeForAutomaticRetry !== false ||
      prepared.status !== "captured-not-submitted" || prepared.captureCount !== 1 || prepared.submissionCount !== 0 ||
      payload?.organization_id !== organizationId || payload?.mutation_kind !== "commitCheckoutBill" || !payload?.mutation_id || !payload?.entity_id ||
      !financial?.primary_bill?.id || !financial?.primary_bill?.billNumber) {
    lineageFailures.push(`${checkpoint.label}: prepared command lineage is invalid.`);
  }
  if (checkpoint.response) {
    const response = checkpoint.response.value;
    if (response.runId !== runId || response.selectedCase !== selectedCase || response.productionAllowed !== false || response.safeForAutomaticRetry !== false ||
        response.status !== "response-received" || response.preparedPath !== checkpoint.prepared.path || response.captureCount !== 1 || response.submissionCount !== 1 ||
        !same(response.commandSummary, prepared.commandSummary) || !Number.isInteger(response.response?.status)) {
      lineageFailures.push(`${checkpoint.label}: response checkpoint lineage is invalid.`);
    }
  }
}

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) throw new Error("Payment-matrix reconciliation is locked to staging.");
const supabase = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const lookup = await supabase.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve staging origin account.");
const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate staging origin account.");
const actorId = login.data.user.id;
if (actorId !== preflight.actors?.[0]?.actorId) throw new Error("The reconciliation actor differs from preflight.");

const query = async (label, request) => {
  const result = await request;
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  return result.data ?? [];
};
const preparedOperations = checkpoints.filter((entry) => entry.prepared).map((entry) => ({
  ...entry,
  command: entry.prepared.value.command,
  envelope: entry.prepared.value.command.payload,
  financial: entry.prepared.value.command.payload.payload,
  responseStatus: entry.response?.value.response?.status,
  responseBody: entry.response?.value.response?.body
}));
const mutationStatuses = await Promise.all(preparedOperations.map(async (operation) => {
  const result = await supabase.rpc("get_financial_mutation_result", {
    payload: { organization_id: organizationId, mutation_id: operation.envelope.mutation_id, mutation_kind: "commitCheckoutBill" }
  });
  if (result.error) throw new Error(`Mutation ${operation.envelope.mutation_id} lookup failed: ${result.error.message}`);
  return result.data;
}));

const outcomes = preparedOperations.map((operation, index) => {
  const canonical = mutationStatuses[index];
  if (operation.responseStatus === 200) return { ...operation, canonical, outcome: "acknowledged_success" };
  if (Number.isInteger(operation.responseStatus) && operation.responseStatus >= 400 && operation.responseStatus < 500) {
    return { ...operation, canonical, outcome: "deterministic_rejection" };
  }
  if (!operation.response && canonical) return { ...operation, canonical, outcome: "canonical_recovery" };
  return { ...operation, canonical, outcome: "ambiguous" };
});
const successful = outcomes.filter((entry) => entry.outcome === "acknowledged_success" || entry.outcome === "canonical_recovery");
const deterministicRejections = outcomes.filter((entry) => entry.outcome === "deterministic_rejection");
const ambiguous = outcomes.filter((entry) => entry.outcome === "ambiguous");

const [sessions, bills, openSessions, openTabs, appState] = await Promise.all([
  query("sessions", supabase.from("sessions").select("id,status,station_name_snapshot,customer_name,started_at,ended_at,closed_bill_id,close_disposition,close_reason,raw_data")
    .eq("organization_id", organizationId).eq("customer_name", customerName)),
  query("bills", supabase.from("bills").select("id,bill_number,customer_name,status,payment_mode,subtotal,total_discount_amount,bill_discount_amount,round_off_enabled,round_off_amount,total,amount_paid,amount_due,issued_by_user_id,session_id,settled_at,settled_by_user_id,raw_data")
    .eq("organization_id", organizationId).eq("customer_name", customerName)),
  query("open sessions", supabase.from("sessions").select("id,customer_name,station_name_snapshot,status,close_disposition,closed_bill_id").eq("organization_id", organizationId).neq("status", "closed")),
  query("open tabs", supabase.from("customer_tabs").select("id,customer_name,status").eq("organization_id", organizationId).eq("status", "open")),
  query("app_state", supabase.from("app_state").select("version,data").eq("id", "primary").single())
]);
const billIds = bills.map((row) => row.id);
const sessionIds = sessions.map((row) => row.id);
const canonicalEventIds = successful.map((entry) => entry.canonical?.event_id).filter(Boolean);
const expectedAuditIds = successful.flatMap((entry) => entry.financial.audit_logs.map((row) => row.id));
const expectedLineIds = successful.flatMap((entry) => entry.financial.primary_bill.lines.map((row) => row.id));
const expectedPaymentIds = successful.flatMap((entry) => entry.financial.payments.map((row) => row.id));
const expectedBillIds = [...new Set(successful.flatMap((entry) => entry.financial.bill_updates.map((row) => row.id)))];
const [lines, payments, lineDiscounts, billDiscounts, movements, events, audits] = await Promise.all([
  billIds.length ? query("bill lines", supabase.from("bill_lines").select("id,bill_id,type,description,quantity,unit_price,subtotal,discount_amount,total,linked_session_id,inventory_item_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("payments", supabase.from("payments").select("id,bill_id,mode,amount,received_by_user_id,settlement_group_id,related_checkout_bill_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("line discounts", supabase.from("bill_line_discounts").select("id,bill_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("bill discounts", supabase.from("bill_discounts").select("id,bill_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("stock movements", supabase.from("stock_movements").select("id,item_id,related_bill_id,type,quantity,user_id").eq("organization_id", organizationId).in("related_bill_id", billIds)) : [],
  canonicalEventIds.length ? query("events", supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("id", canonicalEventIds)) : [],
  expectedAuditIds.length ? query("audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("id", expectedAuditIds)) : []
]);
const runFinancialEvents = sessionIds.length ? await query("run financial events", supabase.from("operational_events")
  .select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId)
  .eq("event_type", "financial_checkout_committed_v2").in("entity_id", sessionIds)) : [];
const runAuditEntityIds = [...sessionIds, ...billIds];
const runFinancialAudits = runAuditEntityIds.length ? await query("run financial audits", supabase.from("audit_logs")
  .select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId)
  .in("action", ["bill_issued", "bill_pending", "bill_settled", "session_checkout_details_updated"])
  .in("entity_id", runAuditEntityIds)) : [];

const integrityFailures = [...lineageFailures];
const completionFailures = [];
const checkIntegrity = (condition, message) => { if (!condition) integrityFailures.push(message); };
const checkCompletion = (condition, message) => { if (!condition) completionFailures.push(message); };

const money = (value) => Number(value ?? 0).toFixed(2);
const sameInstant = (left, right) => {
  if (left === "not set" || right === "not set") return left === right;
  const leftAt = Date.parse(left);
  const rightAt = Date.parse(right);
  return Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt === rightAt;
};
function canonicalSessionAuditMessageIsExact(actualMessage, expectedAudit, operation) {
  if (typeof actualMessage !== "string" || !actualMessage.startsWith("Updated during checkout: ") || !actualMessage.endsWith(".")) return false;
  const update = operation.financial.session_updates?.find((entry) => entry.id === expectedAudit.entityId);
  const before = operation.prepared.value.authoritativePreSubmitSessions?.find((entry) => entry.id === expectedAudit.entityId);
  if (!update || !before) return false;
  const expectedSegments = [];
  if (!sameInstant(before.started_at ?? "not set", update.startedAt ?? "not set")) {
    expectedSegments.push({ label: "start time", before: before.started_at ?? "not set", after: update.startedAt ?? "not set", timestamp: true });
  }
  if (!sameInstant(before.ended_at ?? "not set", update.endedAt ?? "not set")) {
    expectedSegments.push({ label: "end time", before: before.ended_at ?? "not set", after: update.endedAt ?? "not set", timestamp: true });
  }
  if ((before.customer_name || "not set") !== (update.customerName || "not set")) {
    expectedSegments.push({ label: "customer name", before: before.customer_name || "not set", after: update.customerName || "not set", timestamp: false });
  }
  if ((before.customer_phone || "not set") !== (update.customerPhone || "not set")) {
    expectedSegments.push({ label: "customer phone", before: before.customer_phone || "not set", after: update.customerPhone || "not set", timestamp: false });
  }
  const actualSegments = actualMessage.slice("Updated during checkout: ".length, -1).split("; ");
  if (actualSegments.length !== expectedSegments.length) return false;
  return expectedSegments.every((expected, index) => {
    const prefix = `${expected.label}: `;
    if (!actualSegments[index].startsWith(prefix)) return false;
    const [actualBefore, actualAfter, ...extras] = actualSegments[index].slice(prefix.length).split(" -> ");
    if (extras.length || actualBefore === undefined || actualAfter === undefined) return false;
    return expected.timestamp
      ? sameInstant(actualBefore, expected.before) && sameInstant(actualAfter, expected.after)
      : actualBefore === expected.before && actualAfter === expected.after;
  });
}
function canonicalAuditMessageIsExact(actualMessage, expectedAudit, operation) {
  const bill = operation.financial.bill_updates.find((entry) => entry.id === expectedAudit.entityId);
  switch (expectedAudit.action) {
    case "bill_issued":
      return Boolean(bill) && actualMessage === `Issued ${bill.billNumber}.`;
    case "bill_pending":
      return Boolean(bill) && actualMessage === `${bill.billNumber} issued as pending (due Rs ${money(bill.amountDue)}).`;
    case "bill_settled": {
      if (!bill) return false;
      const settledAmount = operation.financial.payments
        .filter((payment) => payment.billId === expectedAudit.entityId)
        .reduce((sum, payment) => sum + Number(payment.amount), 0);
      return actualMessage === `Settled Rs ${money(settledAmount)} on ${bill.billNumber} during checkout ${operation.financial.primary_bill.billNumber}. Remaining due: Rs ${money(bill.amountDue)}.`;
    }
    case "session_checkout_details_updated":
      return canonicalSessionAuditMessageIsExact(actualMessage, expectedAudit, operation);
    default:
      return actualMessage === (expectedAudit.message || "Recorded financial action.");
  }
}

checkIntegrity(ambiguous.length === 0, `Ambiguous command outcomes remain: ${ambiguous.map((entry) => entry.label).join(", ") || "none"}.`);
for (const operation of deterministicRejections) {
  checkIntegrity(operation.canonical === null, `${operation.label}: deterministic rejection unexpectedly has a canonical result.`);
}
for (const operation of successful) {
  const canonical = operation.canonical;
  const command = operation.financial;
  checkIntegrity(Boolean(canonical), `${operation.label}: canonical mutation result is missing.`);
  checkIntegrity(canonical?.mutation_id === operation.envelope.mutation_id && canonical?.bill_id === command.primary_bill.id,
    `${operation.label}: canonical mutation/bill identity differs from the command.`);
  if (operation.outcome === "acknowledged_success") {
    checkIntegrity(same(canonical, operation.responseBody), `${operation.label}: canonical result differs from the captured HTTP response.`);
  }
  checkIntegrity(sameIds(canonical?.changed_rows?.bills, command.bill_updates.map((row) => row.id)), `${operation.label}: changed bill IDs differ from the command.`);
  checkIntegrity(sameIds(canonical?.changed_rows?.payments, command.payments.map((row) => row.id)), `${operation.label}: changed payment IDs differ from the command.`);
  checkIntegrity(sameIds(canonical?.changed_rows?.audit_logs, command.audit_logs.map((row) => row.id)), `${operation.label}: changed audit IDs differ from the command.`);
  checkIntegrity(sameIds(canonical?.changed_rows?.stock_movements, command.stock_movements.map((row) => row.id)), `${operation.label}: changed movement IDs differ from the command.`);
  const event = events.find((row) => row.id === canonical?.event_id);
  checkIntegrity(event?.event_type === "financial_checkout_committed_v2" && event.entity_id === operation.envelope.entity_id &&
    event.created_by === actorId && event.metadata?.mutation_id === operation.envelope.mutation_id &&
    event.metadata?.mutation_kind === "commitCheckoutBill" && same(event.metadata?.changed_rows, canonical?.changed_rows),
    `${operation.label}: event id/type/entity/actor/mutation_kind/changed_rows is not exact.`);

  for (const expected of command.primary_bill.lines) {
    const actual = lines.find((row) => row.id === expected.id);
    checkIntegrity(actual?.bill_id === command.primary_bill.id && actual.type === expected.type &&
      Number(actual.quantity) === Number(expected.quantity) && Number(actual.unit_price) === Number(expected.unitPrice) &&
      Number(actual.subtotal) === Number(expected.subtotal) && Number(actual.discount_amount) === Number(expected.discountAmount) &&
      Number(actual.total) === Number(expected.total) && actual.linked_session_id === (expected.linkedSessionId ?? null),
      `${operation.label}: bill line ${expected.id} differs from its command.`);
  }
  for (const expected of command.payments) {
    const actual = payments.find((row) => row.id === expected.id);
    checkIntegrity(actual?.bill_id === expected.billId && actual.mode === expected.mode && Number(actual.amount) === Number(expected.amount) &&
      actual.received_by_user_id === actorId && actual.related_checkout_bill_id === (expected.relatedCheckoutBillId ?? null) &&
      actual.settlement_group_id === (expected.settlementGroupId ?? null), `${operation.label}: payment ${expected.id} differs from its command.`);
  }
  for (const expected of command.audit_logs) {
    const actual = audits.find((row) => row.id === expected.id);
    checkIntegrity(actual?.action === expected.action && actual.entity_type === expected.entityType && actual.entity_id === expected.entityId &&
      canonicalAuditMessageIsExact(actual.message, expected, operation) && actual.user_id === actorId,
      `${operation.label}: audit ${expected.id} action/entity/server-canonical message/actor is not exact.`);
  }
}

checkIntegrity(sameIds(billIds, successful.map((entry) => entry.financial.primary_bill.id)), "Run-wide bill identities contain a missing or extra bill.");
checkIntegrity(sameIds(lines.map((row) => row.id), expectedLineIds), "Run-wide bill-line identities contain a missing or extra row.");
checkIntegrity(sameIds(payments.map((row) => row.id), expectedPaymentIds), "Run-wide payment identities contain a missing or extra row.");
checkIntegrity(sameIds(audits.map((row) => row.id), expectedAuditIds), "Run-wide audit identities contain a missing or extra financial audit.");
checkIntegrity(sameIds(runFinancialAudits.map((row) => row.id), expectedAuditIds), "Run/entity-scoped financial audits contain a missing or extra row.");
checkIntegrity(sameIds(events.map((row) => row.id), canonicalEventIds) && sameIds(runFinancialEvents.map((row) => row.id), canonicalEventIds),
  "Run-wide financial event identities contain a missing or extra event.");
checkIntegrity(sameIds(bills.map((row) => row.id), expectedBillIds), "Run-wide bill updates do not resolve to the exact expected bills.");
checkIntegrity(lineDiscounts.length === 0 && billDiscounts.length === 0 && movements.length === 0, "Payment cases created an unexpected discount or stock movement.");
checkIntegrity(bills.every((row) => row.issued_by_user_id === actorId), "A bill actor differs from the authenticated origin.");

const expectedSuccessfulCount = selectedCase === "partial_previous_dues" ? 2 : 1;
checkCompletion(terminalFile?.value?.status === "browser-passed", "The browser did not produce a terminal passed artifact.");
checkCompletion(successful.length === expectedSuccessfulCount && deterministicRejections.length === 0,
  `Expected ${expectedSuccessfulCount} successful commands and no rejection.`);
checkCompletion(sessions.length === expectedSuccessfulCount && sessions.every((row) => row.status === "closed" && row.close_disposition === "billed" && billIds.includes(row.closed_bill_id)),
  "Every expected session must be closed and billed exactly once.");
for (const window of terminalFile?.value?.financialWindows ?? []) {
  checkIntegrity(window.after && window.before?.version === window.after.version && window.before?.hash === window.after.hash,
    `${window.label}: app_state changed across the financial mutation.`);
}

if (selectedCase === "upi" && successful.length === 1) {
  const bill = bills.find((row) => row.id === successful[0].financial.primary_bill.id);
  checkIntegrity(bill?.payment_mode === "upi" && bill.status === "issued" && Number(bill.amount_paid) === Number(bill.total) && Number(bill.amount_due) === 0,
    "UPI bill status/totals are incorrect.");
  checkIntegrity(payments.length === 1 && payments[0].mode === "upi" && Number(payments[0].amount) === Number(bill?.total), "UPI payment is not exact.");
}
if (selectedCase === "split" && successful.length === 1) {
  const bill = bills.find((row) => row.id === successful[0].financial.primary_bill.id);
  const cash = payments.filter((row) => row.mode === "cash");
  const upi = payments.filter((row) => row.mode === "upi");
  checkIntegrity(bill?.payment_mode === "split" && bill.status === "issued" && Number(bill.amount_paid) === Number(bill.total) && Number(bill.amount_due) === 0,
    "Split bill status/totals are incorrect.");
  checkIntegrity(payments.length === 2 && cash.length === 1 && upi.length === 1 && Number(cash[0]?.amount) === 10 &&
    Number(cash[0]?.amount) + Number(upi[0]?.amount) === Number(bill?.total), "Split payments are not exact.");
}
if (selectedCase === "partial_previous_dues" && successful.length === 2) {
  const sourceOperation = successful.find((entry) => entry.label === "source");
  const currentOperation = successful.find((entry) => entry.label === "current");
  const sourceId = sourceOperation?.financial.primary_bill.id;
  const currentId = currentOperation?.financial.primary_bill.id;
  const source = bills.find((row) => row.id === sourceId);
  const current = bills.find((row) => row.id === currentId);
  const sourcePayments = payments.filter((row) => row.bill_id === sourceId);
  const currentPayments = payments.filter((row) => row.bill_id === currentId);
  checkIntegrity(source?.status === "issued" && Number(source.amount_paid) === Number(source.total) && Number(source.amount_due) === 0 && source.settled_by_user_id === actorId,
    "Previous-due source bill was not settled exactly.");
  checkIntegrity(current?.status === "pending" && current.payment_mode === "deferred" && Number(current.amount_paid) === 20 &&
    Number(current.amount_due) === Number(current.total) - 20, "Current partial deferred bill is incorrect.");
  checkIntegrity(currentPayments.length === 1 && currentPayments[0].mode === "upi" && Number(currentPayments[0].amount) === 20,
    "Current upfront UPI payment is incorrect.");
  checkIntegrity(sourcePayments.length === 2 && sourcePayments.some((row) => row.mode === "cash" && Number(row.amount) === 10) &&
    sourcePayments.some((row) => row.mode === "upi" && Number(row.amount) === Number(source?.total) - 10), "Previous-due split settlement is incorrect.");
  checkIntegrity(sourcePayments.every((row) => row.related_checkout_bill_id === currentId) &&
    new Set(sourcePayments.map((row) => row.settlement_group_id)).size === 1 && Boolean(sourcePayments[0]?.settlement_group_id),
    "Previous-due settlement linkage/group is incorrect.");
  const settlementAudits = audits.filter((row) => row.action === "bill_settled" && row.entity_id === sourceId);
  const expectedSettlementAudits = currentOperation.financial.audit_logs.filter((row) => row.action === "bill_settled" && row.entityId === sourceId);
  checkIntegrity(settlementAudits.length === 1 && expectedSettlementAudits.length === 1 && settlementAudits[0].id === expectedSettlementAudits[0].id &&
    canonicalAuditMessageIsExact(settlementAudits[0].message, expectedSettlementAudits[0], currentOperation),
    "The exact bill_settled audit identity/server-canonical message is incorrect.");
  checkIntegrity(currentOperation.canonical?.changed_rows?.bills?.includes(sourceId), "The settlement canonical result omits the source bill.");
}

const cleanupCandidates = sessions.filter((row) => row.status !== "closed" && row.close_disposition === null && row.closed_bill_id === null)
  .map((row) => ({ id: row.id, customerName: row.customer_name, stationName: row.station_name_snapshot }));
const openFloorIsExact = openTabs.length === 0 && openSessions.length === cleanupCandidates.length &&
  openSessions.every((row) => cleanupCandidates.some((candidate) => candidate.id === row.id)) &&
  cleanupCandidates.every((row) => row.customerName === customerName && row.stationName === "8 Ball Pool");
checkCompletion(openSessions.length === 0 && openTabs.length === 0, "The staging floor is not empty after the completed case.");
const complete = integrityFailures.length === 0 && completionFailures.length === 0;
const safeForIdentityBoundCleanup = !complete && integrityFailures.length === 0 && ambiguous.length === 0 && cleanupCandidates.length > 0 && openFloorIsExact;
const status = complete ? "passed" : safeForIdentityBoundCleanup ? "partial" : "blocked";
const appStateSessionProjection = (appState.data?.sessions ?? [])
  .filter((entry) => sessionIds.includes(entry.id))
  .map(stable);
const report = {
  runId,
  selectedCase,
  reconciledAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  safeForIdentityBoundCleanup,
  status,
  failures: [...integrityFailures, ...completionFailures],
  integrityFailures,
  completionFailures,
  actorId,
  customerName,
  outcomeClassification: outcomes.map((entry) => ({
    label: entry.label,
    outcome: entry.outcome,
    mutationId: entry.envelope.mutation_id,
    billId: entry.financial.primary_bill.id,
    responseStatus: entry.responseStatus ?? null,
    canonicalPresent: Boolean(entry.canonical)
  })),
  preflight: preflightFile.path,
  preflightSha256: preflightFile.sha256,
  browserEvidence: terminalFile?.path ?? null,
  browserEvidenceSha256: terminalFile?.sha256 ?? null,
  commandCheckpoints: checkpoints.map((entry) => ({
    label: entry.label,
    prepared: entry.prepared?.path ?? null,
    preparedSha256: entry.prepared?.sha256 ?? null,
    response: entry.response?.path ?? null,
    responseSha256: entry.response?.sha256 ?? null
  })),
  snapshot: {
    sessions,
    bills,
    lines,
    payments,
    lineDiscounts,
    billDiscounts,
    movements,
    events,
    audits,
    runFinancialAudits,
    mutationStatuses,
    openSessions,
    openTabs,
    cleanupCandidates,
    appState: { version: appState.version, hash: sha256(JSON.stringify(appState.data)), sessionProjection: appStateSessionProjection }
  }
};
assertNoSecrets(report);
const directory = path.join(root, "test-artifacts", "reconciliation");
fs.mkdirSync(directory, { recursive: true });
const target = path.join(directory, `checkout-payment-matrix-reconciliation-${selectedCase}-${runId}.json`);
const temporary = `${target}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
fs.renameSync(temporary, target);
console.log(JSON.stringify({ artifact: path.relative(root, target), report: { ...report, snapshot: "retained in immutable artifact" } }, null, 2));
if (report.status !== "passed") process.exitCode = 2;
