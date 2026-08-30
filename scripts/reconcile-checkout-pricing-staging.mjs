import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { assertLiveCredentials, assertStagingBaseUrl, assertStagingSupabaseEnvironment, parseEnvFile, sanitizeRunId, STAGING_APP_URL, STAGING_PROJECT_REF } from "./playwright-staging-env.mjs";

const root = process.cwd();
const organizationId = "org-primary";
const allowedCases = ["discount_rounding_positive", "ltp_zero", "bill_discount_zero", "true_zero_price_guard"];
const args = process.argv.slice(2);
const caseArgs = args.filter((argument) => argument.startsWith("--case="));
const reanalysis = args.includes("--reanalysis");
if (caseArgs.length !== 1 || args.some((argument) => argument !== "--reanalysis" && !argument.startsWith("--case=")) || args.filter((argument) => argument === "--reanalysis").length > 1) throw new Error("Pricing reconciliation accepts exactly one --case=<case> and optional --reanalysis.");
const selectedCase = caseArgs[0].slice("--case=".length);
if (!allowedCases.includes(selectedCase)) throw new Error("Unknown pricing reconciliation case.");
const env = { ...parseEnvFile(path.join(root, ".env.e2e.local")), ...process.env };
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
assertStagingSupabaseEnvironment(stagingEnv, true);
assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
assertLiveCredentials(env);
const runId = sanitizeRunId(env.E2E_RUN_ID);
if (env.E2E_PRICING_CASE !== selectedCase) throw new Error("Pricing reconciliation case/environment mismatch.");
const customerName = env.E2E_PRICING_CUSTOMER_NAME;
if (!customerName) throw new Error("Pricing customer identity is missing.");

const evidenceDir = path.join(root, "test-artifacts", "evidence");
const originalReconciliationPath = path.join(evidenceDir, `checkout-pricing-reconciliation-${selectedCase}-${runId}.json`);
let reanalysisOf = null;
if (reanalysis) {
  if (!fs.existsSync(originalReconciliationPath)) throw new Error("Reanalysis requires the exact immutable original reconciliation.");
  const raw = fs.readFileSync(originalReconciliationPath);
  const value = JSON.parse(raw.toString("utf8"));
  if (value.runId !== runId || value.selectedCase !== selectedCase || value.productionAllowed !== false || value.safeForAutomaticRetry !== false || value.status !== "failed") throw new Error("Original reconciliation is not eligible for a read-only reanalysis.");
  reanalysisOf = { path: path.relative(root, originalReconciliationPath), sha256: createHash("sha256").update(raw).digest("hex") };
}
function artifactPath(stage) { return path.join(evidenceDir, `checkout-pricing-${selectedCase}-${stage}-${runId}.json`); }
function load(stage) {
  const target = artifactPath(stage);
  if (!fs.existsSync(target)) return null;
  const raw = fs.readFileSync(target, "utf8");
  return { stage, path: target, raw, value: JSON.parse(raw) };
}
const stages = Object.fromEntries([
  "setup-session-start-prepared", "setup-session-start-submitted", "setup-session-start-response",
  "setup-session-edit-prepared", "setup-session-edit-submitted", "setup-session-edit-response",
  "fixture-create-prepared", "fixture-create-submitted", "fixture-create-response",
  "fixture-session-start-prepared", "fixture-session-start-submitted", "fixture-session-start-response",
  "guard-prepared", "financial-prepared", "financial-submitted", "financial-response", "terminal", "failure"
].map((stage) => [stage, load(stage)]));
if (!Object.values(stages).some(Boolean)) throw new Error("No immutable pricing evidence exists for this run; do not retry the same identity.");

const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-pricing-preflight-${selectedCase}-${runId}.json`);
if (!fs.existsSync(preflightPath)) throw new Error("Exact pricing preflight evidence is missing.");
const preflightRaw = fs.readFileSync(preflightPath, "utf8");
const preflight = JSON.parse(preflightRaw);
if (!preflight.safeToRun || preflight.projectRef !== STAGING_PROJECT_REF || preflight.productionAllowed !== false || preflight.safeForAutomaticRetry !== false || preflight.selectedCase !== selectedCase || preflight.fixture.customerName !== customerName) throw new Error("Pricing preflight lineage is invalid.");
const actorId = preflight.actors.find((actor) => actor.slot === "A")?.actorId;
if (!actorId) throw new Error("Pricing preflight origin actor is missing.");

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const anonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !anonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) throw new Error("Pricing reconciliation is locked to staging.");
const supabase = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const lookup = await supabase.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve pricing reconciliation actor.");
const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user || login.data.user.id !== actorId) throw new Error("Unable to authenticate the exact pricing origin actor.");
const role = await supabase.rpc("current_user_org_role", { target_organization_id: organizationId });
if (role.error || role.data !== "admin") throw new Error("Pricing reconciliation actor is not an authoritative admin.");

async function query(label, request) { const result = await request; if (result.error) throw new Error(`${label} query failed: ${result.error.message}`); return result.data; }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const ids = (rows) => rows.map((row) => row.id);
const sameIds = (left, right) => [...left].sort().join("|") === [...right].sort().join("|");
const money = (value) => Number(Number(value ?? 0).toFixed(2));
const integrityFailures = [];
const completionFailures = [];
const ambiguities = [];
const checkIntegrity = (condition, message) => { if (!condition) integrityFailures.push(message); };
const checkCompletion = (condition, message) => { if (!condition) completionFailures.push(message); };

const startPrefix = selectedCase === "true_zero_price_guard" ? "fixture-session-start" : "setup-session-start";
const startPrepared = stages[`${startPrefix}-prepared`]?.value;
const startSubmitted = stages[`${startPrefix}-submitted`]?.value;
const startResponse = stages[`${startPrefix}-response`]?.value;
const editPrepared = stages["setup-session-edit-prepared"]?.value;
const editSubmitted = stages["setup-session-edit-submitted"]?.value;
const editResponse = stages["setup-session-edit-response"]?.value;
const createPrepared = stages["fixture-create-prepared"]?.value;
const createSubmitted = stages["fixture-create-submitted"]?.value;
const createResponse = stages["fixture-create-response"]?.value;
const financialPrepared = stages["financial-prepared"]?.value;
const financialSubmitted = stages["financial-submitted"]?.value;
const financialResponse = stages["financial-response"]?.value;
const terminal = stages.terminal?.value;
const guard = stages["guard-prepared"]?.value;
const startCommand = startResponse?.request ?? startSubmitted?.request ?? startPrepared?.request;
const editCommand = editResponse?.request ?? editSubmitted?.request ?? editPrepared?.request;
const createCommand = createResponse?.request ?? createSubmitted?.request ?? createPrepared?.request;
const financialEnvelope = terminal?.command ?? financialResponse?.request ?? financialSubmitted?.request ?? financialPrepared?.request;
const financialMutationId = financialEnvelope?.payload?.mutation_id;
const financialCanonical = financialMutationId ? await query("mutation status", supabase.rpc("get_financial_mutation_result", { payload: { organization_id: organizationId, mutation_id: financialMutationId, mutation_kind: "commitCheckoutBill" } })) : null;
if (financialSubmitted && !financialResponse && !financialCanonical) ambiguities.push("Financial command was submitted once but has neither an HTTP response nor a canonical mutation result.");

const mutationIds = [startCommand?.payload?.mutation_id, editCommand?.payload?.mutation_id, createCommand?.payload?.mutation_id, financialMutationId].filter(Boolean);
const [sessions, bills, openSessions, openTabs, appState, runEvents] = await Promise.all([
  query("sessions", supabase.from("sessions").select("id,status,mode,customer_name,customer_phone,station_id,station_name_snapshot,started_at,ended_at,closed_bill_id,close_disposition,close_reason,play_mode,ltp_eligible,ltp_outcome,ltp_discount_applied,raw_data").eq("organization_id", organizationId).eq("customer_name", customerName)),
  query("bills", supabase.from("bills").select("id,bill_number,status,payment_mode,subtotal,total_discount_amount,bill_discount_amount,round_off_enabled,round_off_amount,total,amount_paid,amount_due,issued_by_user_id,session_id,raw_data").eq("organization_id", organizationId).eq("customer_name", customerName)),
  query("open sessions", supabase.from("sessions").select("id,customer_name,station_name_snapshot,status").eq("organization_id", organizationId).neq("status", "closed")),
  query("open tabs", supabase.from("customer_tabs").select("id,customer_name,status").eq("organization_id", organizationId).eq("status", "open")),
  query("app state", supabase.from("app_state").select("version,data").eq("id", "primary").single()),
  mutationIds.length ? query("run events", supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("metadata->>mutation_id", mutationIds)) : []
]);
const appStateIdentity = { version: appState.version, hash: createHash("sha256").update(JSON.stringify(appState.data)).digest("hex") };
const sourceSessionId = startResponse?.response?.body?.changed_rows?.sessions?.[0] ?? startCommand?.payload?.payload?.session?.id ?? sessions[0]?.id;
const sourceSession = sessions.find((row) => row.id === sourceSessionId);
const startEvent = runEvents.find((event) => event.metadata?.mutation_id === startCommand?.payload?.mutation_id);
const expectedStartAudits = startCommand?.payload?.payload?.auditLogs ?? [];
const expectedStartAuditIds = startResponse?.response?.body?.changed_rows?.audit_logs ?? expectedStartAudits.map((audit) => audit.id);
const startAudits = expectedStartAuditIds.length ? await query("start-session audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("id", expectedStartAuditIds)) : [];
if (startSubmitted && !startResponse && !(sourceSession && startEvent)) ambiguities.push("Session start was submitted once but is not canonically recoverable from its exact session/event.");

if (startResponse?.response?.status === 200 || (sourceSession && startEvent)) {
  const result = startResponse?.response?.body;
  const payload = startCommand?.payload;
  checkIntegrity(payload?.organization_id === organizationId && payload?.mutation_kind === "startSession" && payload?.entity_id === sourceSessionId && payload?.payload?.session?.id === sourceSessionId, "Start-session command identity is not exact.");
  checkIntegrity(sourceSession?.customer_name === customerName && sourceSession?.station_id === payload?.payload?.session?.stationId && sourceSession?.station_name_snapshot === payload?.payload?.session?.stationNameSnapshot && sourceSession?.mode === payload?.payload?.session?.mode, "Canonical source session differs from its start command.");
  if (result) {
    checkIntegrity(result.mutation_id === payload.mutation_id && result.entity_id === sourceSessionId && sameIds(result.changed_rows?.sessions ?? [], [sourceSessionId]), "Start-session response identity differs from its command.");
    checkIntegrity(startEvent?.id === result.event_id && sameIds(startEvent?.metadata?.session_item_ids ?? [], result.changed_rows?.session_items ?? []) && sameIds(startEvent?.metadata?.stock_movement_ids ?? [], result.changed_rows?.stock_movements ?? []) && sameIds(startEvent?.metadata?.audit_log_ids ?? [], result.changed_rows?.audit_logs ?? []), "Start-session event changed-row lineage is not exact.");
  }
  checkIntegrity(startEvent?.event_type === "start_session" && startEvent?.entity_type === "session" && startEvent?.entity_id === sourceSessionId && startEvent?.created_by === actorId && startEvent?.metadata?.mutation_id === payload?.mutation_id && startEvent?.metadata?.mutation_kind === "startSession", "Start-session event type/entity/actor/mutation is not exact.");
  checkIntegrity(startAudits.length === expectedStartAudits.length && expectedStartAudits.every((expected) => {
    const actual = startAudits.find((audit) => audit.id === expected.id);
    return actual?.action === expected.action && actual?.entity_type === expected.entityType && actual?.entity_id === expected.entityId && actual?.message === expected.message && actual?.user_id === actorId;
  }), "Start-session audit fields/message/actor are not exact.");
}

const editEvent = runEvents.find((event) => event.metadata?.mutation_id === editCommand?.payload?.mutation_id);
const expectedEditAuditIds = editResponse?.response?.body?.changed_rows?.audit_logs ?? (editCommand?.payload?.payload?.auditLog?.id ? [editCommand.payload.payload.auditLog.id] : []);
const editAudits = expectedEditAuditIds.length ? await query("save-session-details audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("id", expectedEditAuditIds)) : [];
if (editSubmitted && !editResponse && !(sourceSession && editEvent)) ambiguities.push("Session detail edit was submitted once but is not canonically recoverable from its exact session/event.");
if (editCommand && (editResponse?.response?.status === 200 || (sourceSession && editEvent))) {
  const payload = editCommand.payload;
  const result = editResponse?.response?.body;
  const audit = payload?.payload?.auditLog;
  checkIntegrity(payload?.organization_id === organizationId && payload?.mutation_kind === "saveLiveSessionDetails" && payload?.entity_type === "session" && payload?.entity_id === sourceSessionId && payload?.payload?.sessionId === sourceSessionId && payload?.user_id === actorId, "Save-session-details command identity/actor is not exact.");
  checkIntegrity(sourceSession?.customer_name === payload?.payload?.customerName && sourceSession?.customer_phone === (payload?.payload?.customerPhone || null) && Date.parse(sourceSession?.started_at) === Date.parse(payload?.payload?.startedAt), "Canonical source session differs from the acknowledged detail edit.");
  if (result) {
    checkIntegrity(result.mutation_id === payload.mutation_id && result.entity_type === "session" && result.entity_id === sourceSessionId && result.event_id === editEvent?.id && sameIds(result.changed_rows?.sessions ?? [], [sourceSessionId]) && sameIds(result.changed_rows?.audit_logs ?? [], expectedEditAuditIds) && sameIds(result.changed_rows?.operational_events ?? [], [editEvent?.id]), "Save-session-details response changed-row lineage is not exact.");
  }
  checkIntegrity(editEvent?.event_type === "save_live_session_details" && editEvent?.entity_type === "session" && editEvent?.entity_id === sourceSessionId && editEvent?.created_by === actorId && editEvent?.metadata?.mutation_id === payload?.mutation_id && editEvent?.metadata?.mutation_kind === "saveLiveSessionDetails" && editEvent?.metadata?.audit_log_id === (audit?.id ?? null), "Save-session-details event type/entity/actor/mutation/audit lineage is not exact.");
  checkIntegrity(editAudits.length === expectedEditAuditIds.length && (!audit || (editAudits.length === 1 && editAudits[0].id === audit.id && editAudits[0].action === audit.action && editAudits[0].entity_type === audit.entityType && editAudits[0].entity_id === sourceSessionId && editAudits[0].message === audit.message && editAudits[0].user_id === actorId)), "Save-session-details audit fields/message/actor are not exact.");
}

const billIds = ids(bills);
const [lines, payments, lineDiscounts, billDiscounts, movements, audits, financialEvents, runFinancialAudits] = await Promise.all([
  billIds.length ? query("bill lines", supabase.from("bill_lines").select("id,bill_id,type,description,quantity,unit_price,subtotal,discount_amount,total,linked_session_id,inventory_item_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("payments", supabase.from("payments").select("id,bill_id,mode,amount,received_by_user_id,settlement_group_id,related_checkout_bill_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("line discounts", supabase.from("bill_line_discounts").select("id,bill_id,target_id,discount_type,value,amount,reason,applied_by_user_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("bill discounts", supabase.from("bill_discounts").select("id,bill_id,discount_type,value,amount,reason,applied_by_user_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("movements", supabase.from("stock_movements").select("id,item_id,type,quantity,reason,user_id,related_bill_id").eq("organization_id", organizationId).in("related_bill_id", billIds)) : [],
  financialEnvelope?.payload?.payload?.audit_logs?.length ? query("financial audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("id", financialEnvelope.payload.payload.audit_logs.map((row) => row.id))) : [],
  sourceSessionId ? query("financial events", supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).eq("event_type", "financial_checkout_committed_v2").eq("entity_id", sourceSessionId)) : [],
  (sourceSessionId || billIds.length) ? query("run financial audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("action", ["bill_issued", "ltp_discount_applied", "session_checkout_details_updated"]).in("entity_id", [sourceSessionId, ...billIds].filter(Boolean))) : []
]);

const sameInstant = (left, right) => {
  if (left === "not set" || right === "not set") return left === right;
  const leftAt = Date.parse(left);
  const rightAt = Date.parse(right);
  return Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt === rightAt;
};
function canonicalSessionAuditMessageIsExact(actualMessage, expected, command) {
  if (typeof actualMessage !== "string" || !actualMessage.startsWith("Updated during checkout: ") || !actualMessage.endsWith(".")) return false;
  const update = command.session_updates?.find((entry) => entry.id === expected.entityId);
  const before = financialPrepared?.authoritativePreSubmitSessions?.find((entry) => entry.id === expected.entityId);
  if (!update || !before) return false;
  const expectedSegments = [];
  if (!sameInstant(before.started_at ?? "not set", update.startedAt ?? "not set")) expectedSegments.push({ label: "start time", before: before.started_at ?? "not set", after: update.startedAt ?? "not set", timestamp: true });
  if (!sameInstant(before.ended_at ?? "not set", update.endedAt ?? "not set")) expectedSegments.push({ label: "end time", before: before.ended_at ?? "not set", after: update.endedAt ?? "not set", timestamp: true });
  if ((before.customer_name || "not set") !== (update.customerName || "not set")) expectedSegments.push({ label: "customer name", before: before.customer_name || "not set", after: update.customerName || "not set", timestamp: false });
  if ((before.customer_phone || "not set") !== (update.customerPhone || "not set")) expectedSegments.push({ label: "customer phone", before: before.customer_phone || "not set", after: update.customerPhone || "not set", timestamp: false });
  const actualSegments = actualMessage.slice("Updated during checkout: ".length, -1).split("; ");
  if (actualSegments.length !== expectedSegments.length) return false;
  return expectedSegments.every((segment, index) => {
    const prefix = `${segment.label}: `;
    if (!actualSegments[index].startsWith(prefix)) return false;
    const [actualBefore, actualAfter, ...extras] = actualSegments[index].slice(prefix.length).split(" -> ");
    return extras.length === 0 && actualBefore !== undefined && actualAfter !== undefined && (segment.timestamp ? sameInstant(actualBefore, segment.before) && sameInstant(actualAfter, segment.after) : actualBefore === segment.before && actualAfter === segment.after);
  });
}
function canonicalAuditMessage(actual, expected, command) {
  if (expected.action === "bill_issued") return actual === `Issued ${command.primary_bill.billNumber}.`;
  if (expected.action === "ltp_discount_applied") return actual === `Applied the verified LTP win discount to ${sourceSession?.station_name_snapshot}.`;
  if (expected.action === "session_checkout_details_updated") return canonicalSessionAuditMessageIsExact(actual, expected, command);
  return actual === (expected.message || "Recorded financial action.");
}

let financialCommitted = false;
if (financialCanonical) {
  financialCommitted = true;
  const financial = financialEnvelope.payload.payload;
  const expectedBill = financial.primary_bill;
  const actualBill = bills.find((row) => row.id === expectedBill.id);
  checkIntegrity(financialCanonical.mutation_id === financialMutationId && financialCanonical.bill_id === expectedBill.id && financialCanonical.bill_number === expectedBill.billNumber, "Canonical financial mutation identity differs from its command.");
  if (financialResponse) checkIntegrity(financialResponse.response.status === 200 && same(financialCanonical, financialResponse.response.body), "Canonical mutation differs from the acknowledged HTTP response.");
  checkIntegrity(bills.length === 1 && actualBill?.bill_number === expectedBill.billNumber && actualBill?.status === expectedBill.status && actualBill?.payment_mode === expectedBill.paymentMode && money(actualBill?.subtotal) === money(expectedBill.subtotal) && money(actualBill?.total_discount_amount) === money(expectedBill.totalDiscountAmount) && money(actualBill?.bill_discount_amount) === money(expectedBill.billDiscountAmount) && actualBill?.round_off_enabled === expectedBill.roundOffEnabled && money(actualBill?.round_off_amount) === money(expectedBill.roundOffAmount) && money(actualBill?.total) === money(expectedBill.total) && money(actualBill?.amount_paid) === money(expectedBill.amountPaid) && money(actualBill?.amount_due) === money(expectedBill.amountDue) && actualBill?.issued_by_user_id === actorId && actualBill?.session_id === sourceSessionId, "Canonical bill fields differ from the command.");
  checkIntegrity(sourceSession?.status === "closed" && sourceSession?.close_disposition === "billed" && sourceSession?.closed_bill_id === expectedBill.id, "Source session is not closed/billed by the exact bill.");
  checkIntegrity(sameIds(ids(lines), expectedBill.lines.map((row) => row.id)), "Bill-line identity set differs from the command.");
  for (const expected of expectedBill.lines) {
    const actual = lines.find((row) => row.id === expected.id);
    checkIntegrity(actual?.bill_id === expectedBill.id && actual?.type === expected.type && actual?.description === expected.description && money(actual?.quantity) === money(expected.quantity) && money(actual?.unit_price) === money(expected.unitPrice) && money(actual?.subtotal) === money(expected.subtotal) && money(actual?.discount_amount) === money(expected.discountAmount) && money(actual?.total) === money(expected.total) && actual?.linked_session_id === (expected.linkedSessionId ?? null) && actual?.inventory_item_id === (expected.inventoryItemId ?? null), `Bill line ${expected.id} differs from the command.`);
  }
  checkIntegrity(sameIds(ids(payments), financial.payments.map((row) => row.id)), "Payment identity set differs from the command.");
  for (const expected of financial.payments) {
    const actual = payments.find((row) => row.id === expected.id);
    checkIntegrity(actual?.bill_id === expected.billId && actual?.mode === expected.mode && money(actual?.amount) === money(expected.amount) && actual?.received_by_user_id === actorId && actual?.settlement_group_id === (expected.settlementGroupId ?? null) && actual?.related_checkout_bill_id === (expected.relatedCheckoutBillId ?? null), `Payment ${expected.id} differs from the command.`);
  }
  checkIntegrity(sameIds(ids(lineDiscounts), expectedBill.lineDiscounts.map((row) => row.id)), "Line-discount identity set differs from the command.");
  for (const expected of expectedBill.lineDiscounts) {
    const actual = lineDiscounts.find((row) => row.id === expected.id);
    checkIntegrity(actual?.bill_id === expectedBill.id && actual?.target_id === expected.targetId && actual?.discount_type === expected.type && money(actual?.value) === money(expected.value) && money(actual?.amount) === money(expected.amount) && actual?.reason === expected.reason && actual?.applied_by_user_id === actorId, `Line discount ${expected.id} differs from the command.`);
  }
  const expectedBillDiscounts = expectedBill.billDiscount ? [expectedBill.billDiscount] : [];
  checkIntegrity(sameIds(ids(billDiscounts), expectedBillDiscounts.map((row) => row.id)), "Bill-discount identity set differs from the command.");
  for (const expected of expectedBillDiscounts) {
    const actual = billDiscounts.find((row) => row.id === expected.id);
    checkIntegrity(actual?.bill_id === expectedBill.id && actual?.discount_type === expected.type && money(actual?.value) === money(expected.value) && money(actual?.amount) === money(expected.amount) && actual?.reason === expected.reason && actual?.applied_by_user_id === actorId, `Bill discount ${expected.id} differs from the command.`);
  }
  checkIntegrity(sameIds(ids(audits), financial.audit_logs.map((row) => row.id)), "Financial audit identity set differs from the command.");
  checkIntegrity(sameIds(ids(runFinancialAudits), financial.audit_logs.map((row) => row.id)), "The run contains an extra or missing financial audit on its session/bill entities.");
  for (const expected of financial.audit_logs) {
    const actual = audits.find((row) => row.id === expected.id);
    checkIntegrity(actual?.action === expected.action && actual?.entity_type === expected.entityType && actual?.entity_id === expected.entityId && actual?.user_id === actorId && canonicalAuditMessage(actual?.message, expected, financial), `Financial audit ${expected.id} differs from the server-canonical contract.`);
  }
  checkIntegrity(movements.length === financial.stock_movements.length && sameIds(ids(movements), financial.stock_movements.map((row) => row.id)), "Stock-movement identity set differs from the command.");
  checkIntegrity(financial.stock_movements.length === 0 && movements.length === 0, "Pricing-only checkout unexpectedly wrote stock movements.");
  checkIntegrity(financialEvents.length === 1 && financialEvents[0].id === financialCanonical.event_id && financialEvents[0].entity_type === financialEnvelope.payload.entity_type && financialEvents[0].created_by === actorId && financialEvents[0].metadata?.mutation_id === financialMutationId && financialEvents[0].metadata?.mutation_kind === "commitCheckoutBill" && financialEvents[0].metadata?.bill_id === expectedBill.id && financialEvents[0].metadata?.bill_number === expectedBill.billNumber && same(financialEvents[0].metadata?.changed_rows, financialCanonical.changed_rows), "Financial event identity/actor/mutation/bill/changed_rows is not exact.");
  checkIntegrity(sameIds(financialCanonical.changed_rows?.bills ?? [], financial.bill_updates.map((row) => row.id)) && sameIds(financialCanonical.changed_rows?.payments ?? [], financial.payments.map((row) => row.id)) && sameIds(financialCanonical.changed_rows?.audit_logs ?? [], financial.audit_logs.map((row) => row.id)) && sameIds(financialCanonical.changed_rows?.stock_movements ?? [], financial.stock_movements.map((row) => row.id)), "Canonical changed-row sets differ from the command.");
  const before = terminal?.financialWindow?.before ?? financialPrepared?.beforeFinancial;
  const after = terminal?.financialWindow?.after ?? appStateIdentity;
  checkIntegrity(Boolean(before) && same(before, after) && same(after, appStateIdentity), "Financial checkout changed compatibility state.");
  checkCompletion(openSessions.length === 0 && openTabs.length === 0, "The staging floor is not empty after the committed case.");
  if (selectedCase === "discount_rounding_positive") {
    checkCompletion(money(actualBill?.subtotal) > 0 && lineDiscounts.length === 1 && money(lineDiscounts[0]?.amount) > 0 && billDiscounts.length === 1 && money(billDiscounts[0]?.amount) > 0 && Math.abs(money(actualBill?.round_off_amount)) > 0 && payments.length === 1 && payments[0].mode === "cash" && money(payments[0].amount) === money(actualBill?.total), "Positive discounts, nonzero rounding, and exact cash payment were not all persisted.");
  } else if (selectedCase === "ltp_zero") {
    checkCompletion(money(actualBill?.subtotal) > 0 && money(actualBill?.total) === 0 && money(actualBill?.amount_paid) === 0 && money(actualBill?.amount_due) === 0 && payments.length === 0 && lineDiscounts.length === 1 && lineDiscounts[0].reason === "LTP win - game charge waived" && money(lineDiscounts[0].amount) === money(actualBill?.subtotal) && billDiscounts.length === 0 && sourceSession?.play_mode === "solo" && sourceSession?.ltp_eligible === true && sourceSession?.ltp_outcome === "won" && sourceSession?.ltp_discount_applied === true && audits.some((row) => row.action === "ltp_discount_applied"), "LTP zero-total, session, audit, discount, or payment fields are not exact.");
  } else {
    checkCompletion(money(actualBill?.subtotal) > 0 && money(actualBill?.total) === 0 && money(actualBill?.amount_paid) === 0 && money(actualBill?.amount_due) === 0 && payments.length === 0 && lineDiscounts.length === 0 && billDiscounts.length === 1 && billDiscounts[0].discount_type === "percentage" && money(billDiscounts[0].value) === 100 && money(billDiscounts[0].amount) === money(actualBill?.subtotal), "Manual 100 percent zero-total bill is not exact.");
  }
}

let item = null;
let itemEvent = null;
let itemAudits = [];
let sessionItems = [];
let itemMovements = [];
if (selectedCase === "true_zero_price_guard") {
  const itemId = createResponse?.response?.body?.changed_rows?.inventory_items?.[0] ?? createCommand?.payload?.payload?.inventoryItems?.find((entry) => entry.name === env.E2E_PRICING_ZERO_ITEM_NAME)?.id;
  const [items, sourceItems, movementsForItem] = await Promise.all([
    query("zero item", supabase.from("inventory_items").select("id,name,category,price,stock_qty,low_stock_threshold,active,is_reusable,barcode,sell_base_item").eq("organization_id", organizationId).or(`name.eq.${env.E2E_PRICING_ZERO_ITEM_NAME},barcode.eq.${env.E2E_PRICING_ZERO_ITEM_BARCODE}`)),
    sourceSessionId ? query("zero session items", supabase.from("session_items").select("id,session_id,inventory_item_id,name,quantity,unit_price").eq("organization_id", organizationId).eq("session_id", sourceSessionId)) : [],
    itemId ? query("zero item movements", supabase.from("stock_movements").select("id,item_id,type,quantity,related_bill_id").eq("organization_id", organizationId).eq("item_id", itemId)) : []
  ]);
  item = items[0] ?? null;
  sessionItems = sourceItems;
  itemMovements = movementsForItem;
  itemEvent = runEvents.find((event) => event.metadata?.mutation_id === createCommand?.payload?.mutation_id) ?? null;
  const expectedAuditIds = createResponse?.response?.body?.changed_rows?.audit_logs ?? createCommand?.payload?.payload?.auditLogs?.map((row) => row.id) ?? [];
  itemAudits = expectedAuditIds.length ? await query("zero item audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("id", expectedAuditIds)) : [];
  if (createSubmitted && !createResponse && !(item && itemEvent)) ambiguities.push("Fixture create was submitted once but is not canonically recoverable from its exact item/event.");
  if (createResponse?.response?.status === 200 || (item && itemEvent)) {
    const result = createResponse?.response?.body;
    const expectedItem = createCommand?.payload?.payload?.inventoryItems?.find((entry) => entry.id === item?.id);
    checkIntegrity(createCommand?.payload?.organization_id === organizationId && createCommand?.payload?.mutation_kind === "commitAdminDataChange" && createCommand?.payload?.user_id === actorId && expectedItem?.name === env.E2E_PRICING_ZERO_ITEM_NAME && expectedItem?.barcode === env.E2E_PRICING_ZERO_ITEM_BARCODE && expectedItem?.category === "Arcade" && money(expectedItem?.price) === 0 && money(expectedItem?.stockQty) === 5 && expectedItem?.active === true, "Zero-item admin command fields/actor are not exact.");
    checkIntegrity(item?.id === expectedItem?.id && item?.name === expectedItem?.name && item?.barcode === expectedItem?.barcode && item?.category === "Arcade" && money(item?.price) === 0 && money(item?.stock_qty) === 5 && money(item?.low_stock_threshold) === 0 && item?.active === true && item?.is_reusable === false && item?.sell_base_item === true, "Canonical zero-price item differs from its admin command.");
    if (result) checkIntegrity(result.mutation_id === createCommand.payload.mutation_id && result.entity_id === createCommand.payload.entity_id && result.app_state_version === preflight.appState.version + 1 && sameIds(result.changed_rows?.inventory_items ?? [], [item.id]) && sameIds(result.changed_rows?.sale_variants ?? [], [item.id]) && sameIds(result.changed_rows?.audit_logs ?? [], expectedAuditIds) && (result.changed_rows?.stock_movements ?? []).length === 0, "Fixture-create response changed rows/version differ from the command.");
    checkIntegrity(itemEvent?.event_type === "admin_data_committed" && itemEvent?.entity_type === "admin_data" && itemEvent?.entity_id === createCommand?.payload?.entity_id && itemEvent?.created_by === actorId && itemEvent?.metadata?.mutation_id === createCommand?.payload?.mutation_id && itemEvent?.metadata?.mutation_kind === "commitAdminDataChange" && itemEvent?.metadata?.app_state_version === result?.app_state_version && same(itemEvent?.metadata?.changed_rows, result?.changed_rows), "Fixture-create event lifecycle is not exact.");
    checkIntegrity(itemAudits.length === 1 && itemAudits[0].action === "inventory_created" && itemAudits[0].entity_type === "inventory_item" && itemAudits[0].entity_id === item?.id && itemAudits[0].user_id === actorId && itemAudits[0].message === createCommand?.payload?.payload?.auditLogs?.find((row) => row.id === itemAudits[0].id)?.message, "Fixture-create audit lifecycle is not exact.");
  }
  checkIntegrity(sessionItems.length === (sourceSession ? 1 : 0) && (!sourceSession || (sessionItems[0].inventory_item_id === item?.id && sessionItems[0].name === item?.name && money(sessionItems[0].quantity) === 1 && money(sessionItems[0].unit_price) === 0)), "True-zero session item is not exact.");
  checkIntegrity(itemMovements.length === 0 && bills.length === 0 && financialEvents.length === 0 && !financialEnvelope, "True-zero guard created a financial request/effect or stock movement.");
  if (guard) checkIntegrity(guard.beforeGuard && same(guard.beforeGuard, appStateIdentity), "Compatibility changed during or after the true-zero guard proof.");
  if (terminal) checkCompletion(terminal.status === "guard-proved-cleanup-required" && terminal.financialRequests?.length === 0, "True-zero terminal did not prove the exact disabled no-request guard.");
}

const runOpenSessions = openSessions.filter((row) => row.customer_name === customerName);
const unrelatedOpenSessions = openSessions.filter((row) => row.customer_name !== customerName);
const itemCleanupCandidate = item?.active === true ? { id: item.id, name: item.name, barcode: item.barcode } : null;
const cleanupCandidates = runOpenSessions.length === 1 && sourceSession?.id === runOpenSessions[0].id && !financialCommitted ? [{ id: sourceSession.id, customerName, stationName: sourceSession.station_name_snapshot }] : [];
if (runOpenSessions.length > 1 || unrelatedOpenSessions.length || openTabs.length) integrityFailures.push("Open-floor state is outside the exact run-bound cleanup scope.");
if (!financialCommitted && bills.length) integrityFailures.push("A run bill exists without a canonical financial mutation.");
const cleanupNeeded = cleanupCandidates.length > 0 || Boolean(itemCleanupCandidate);
const safeForIdentityBoundCleanup = !financialCommitted && cleanupNeeded && integrityFailures.length === 0 && ambiguities.length === 0 && runOpenSessions.length <= 1;

let status;
if (financialCommitted) status = integrityFailures.length === 0 && completionFailures.length === 0 && ambiguities.length === 0 ? "passed" : "failed";
else if (safeForIdentityBoundCleanup) status = "partial";
else status = "failed";
if (!financialCommitted && !cleanupNeeded && ambiguities.length === 0) completionFailures.push("The case produced no committed financial result and no cleanup effect; close this run without retry and use a fresh identity.");

const report = {
  runId, selectedCase, generatedAt: new Date().toISOString(), projectRef: STAGING_PROJECT_REF, reanalysisOf,
  productionAllowed: false, safeForAutomaticRetry: false, safeForIdentityBoundCleanup, status,
  preflightArtifact: path.relative(root, preflightPath), preflightSha256: createHash("sha256").update(preflightRaw).digest("hex"),
  evidenceLineage: Object.fromEntries(Object.entries(stages).filter(([, entry]) => entry).map(([stage, entry]) => [stage, { path: path.relative(root, entry.path), sha256: createHash("sha256").update(entry.raw).digest("hex") }])),
  actorId, customerName, financialOutcome: financialCommitted ? "committed" : financialResponse?.response?.status >= 400 ? "deterministic_rejection" : financialSubmitted ? "ambiguous_or_absent" : "not_submitted",
  integrityFailures, completionFailures, ambiguities,
  snapshot: { sessions, startAudits, editAudits, bills, lines, payments, lineDiscounts, billDiscounts, movements, financialCanonical, financialEvents, audits, runFinancialAudits, runEvents, item, itemAudits, itemEvent, sessionItems, itemMovements, cleanupCandidates, itemCleanupCandidate },
  floor: { openSessions, openTabs }, appState: appStateIdentity
};
const serialized = JSON.stringify(report, null, 2);
if (/"(?:authorization|apikey|password|access_token|refresh_token)"\s*:/i.test(serialized) || /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(serialized)) throw new Error("Refusing to persist sensitive pricing reconciliation evidence.");
const output = path.join(evidenceDir, `${reanalysis ? "checkout-pricing-reanalysis" : "checkout-pricing-reconciliation"}-${selectedCase}-${runId}.json`);
fs.writeFileSync(output, `${serialized}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ status, artifact: path.relative(root, output), sha256: createHash("sha256").update(`${serialized}\n`).digest("hex"), integrityFailures, completionFailures, ambiguities, safeForIdentityBoundCleanup }, null, 2));
if (status !== "passed") process.exitCode = status === "partial" ? 2 : 1;
