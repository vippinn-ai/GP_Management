import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { assertLiveCredentials, assertStagingSupabaseEnvironment, parseEnvFile, sanitizeRunId, STAGING_PROJECT_REF } from "./playwright-staging-env.mjs";

const root = process.cwd();
const organizationId = "org-primary";
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);
const runId = sanitizeRunId(env.E2E_RUN_ID);
const customerName = env.E2E_REPLACEMENT_PARITY_CUSTOMER;
const itemName = env.E2E_REPLACEMENT_PARITY_ITEM;
const originalBillNumber = env.E2E_REPLACEMENT_PARITY_ORIGINAL_BILL;
const replacementBillNumber = env.E2E_REPLACEMENT_PARITY_REPLACEMENT_BILL;
const replacementPaymentMode = env.E2E_REPLACEMENT_PAYMENT_MODE === "upi" ? "upi" : "cash";
if (!customerName || !itemName || !originalBillNumber || !replacementBillNumber) throw new Error("Exact replacement-parity identity bindings are required.");

const evidenceDirectory = path.join(root, "test-artifacts", "evidence");
const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-replacement-parity-preflight-${runId}.json`);
const terminalPath = path.join(evidenceDirectory, `checkout-replacement-parity-terminal-${runId}.json`);
const failurePath = path.join(evidenceDirectory, `checkout-replacement-parity-failure-${runId}.json`);
const summaryPath = path.join(root, "test-artifacts", "playwright", `summary-${runId}.json`);
const reanalysis = env.E2E_REPLACEMENT_PARITY_REANALYZE === "true";
if (!fs.existsSync(preflightPath)) throw new Error("Replacement-parity preflight artifact is missing.");
const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
const terminal = fs.existsSync(terminalPath) ? JSON.parse(fs.readFileSync(terminalPath, "utf8")) : null;
const failure = fs.existsSync(failurePath) ? JSON.parse(fs.readFileSync(failurePath, "utf8")) : null;
const summary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, "utf8")) : null;
function loadStage(stage) {
  const target = path.join(evidenceDirectory, `checkout-replacement-parity-${stage}-${runId}.json`);
  return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : null;
}
const stageNames = { create: "fixture-create", open: "tab-open", add: "tab-item-add", update: "tab-item-quantity", original: "original-checkout", replacement: "replacement-checkout", archive: "fixture-archive" };
const stages = Object.fromEntries(Object.entries(stageNames).map(([key, value]) => [key, loadStage(`${value}-response`)]));
const preparedStages = Object.fromEntries(Object.entries(stageNames).map(([key, value]) => [key, loadStage(`${value}-prepared`)]));
const submittedStages = Object.fromEntries(Object.entries(stageNames).map(([key, value]) => [key, loadStage(`${value}-submitted`)]));

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) throw new Error("Replacement-parity reconciliation is locked to staging.");
async function authenticate(slot) {
  const client = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const lookup = await client.functions.invoke("resolve-login-email", { body: { username: env[`E2E_USER_${slot}`].trim() } });
  if (lookup.error || !lookup.data?.email) throw new Error(`Unable to resolve staging reconciliation slot ${slot}.`);
  const login = await client.auth.signInWithPassword({ email: lookup.data.email, password: env[`E2E_PASSWORD_${slot}`] });
  if (login.error || !login.data.user) throw new Error(`Unable to authenticate staging reconciliation slot ${slot}.`);
  const role = await client.rpc("current_user_org_role", { target_organization_id: organizationId });
  if (role.error || role.data !== "admin") throw new Error(`Reconciliation slot ${slot} requires an active staging admin.`);
  return { client, actorId: login.data.user.id };
}
const origin = await authenticate("A");
const observer = await authenticate("B");
const supabase = origin.client;

const integrityFailures = [];
const completionFailures = [];
const ambiguities = [];
function checkIntegrity(condition, message) { if (!condition) integrityFailures.push(message); }
function checkCompletion(condition, message) { if (!condition) completionFailures.push(message); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function same(left, right) { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }
function sameIds(actual = [], expected = []) { return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()); }
function sameKeys(actual = {}, expected = []) { return sameIds(Object.keys(actual), expected); }
function money(value) { return Number(Number(value ?? 0).toFixed(2)); }
function body(stage) { return stage?.response?.body ?? null; }
function envelope(stage) { return stage?.request?.payload ?? null; }
function command(stage) { return envelope(stage)?.payload ?? {}; }
function mutationId(stage) { return body(stage)?.mutation_id ?? envelope(stage)?.mutation_id ?? null; }
function auditCommands(stage) {
  const payload = command(stage);
  if (Array.isArray(payload.audit_logs)) return payload.audit_logs;
  if (Array.isArray(payload.auditLogs)) return payload.auditLogs;
  return payload.auditLog ? [payload.auditLog] : [];
}
function changed(stage, key) { return body(stage)?.changed_rows?.[key] ?? []; }
function isDeterministicFinancialRejection(name, stage) {
  return ["original", "replacement"].includes(name) && Number(stage?.response?.status) >= 400 && Number(stage?.response?.status) < 500;
}
function eventChangedRows(result) { return Object.fromEntries(Object.entries(result?.changed_rows ?? {}).filter(([key]) => key !== "operational_events")); }
async function query(label, request) {
  const result = await request;
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  return result.data ?? [];
}
async function canonical(client, stage) {
  if (!mutationId(stage)) return null;
  const result = await client.rpc("get_financial_mutation_result", { payload: { organization_id: organizationId, mutation_id: mutationId(stage), mutation_kind: "commitCheckoutBill" } });
  if (result.error) throw new Error(`Canonical mutation ${mutationId(stage)} lookup failed: ${result.error.message}`);
  return result.data;
}

for (const name of Object.keys(stageNames)) {
  const response = stages[name];
  const prepared = preparedStages[name];
  const submitted = submittedStages[name];
  if (response && (!prepared || !submitted)) ambiguities.push(`${name} has a response checkpoint without its prepared/submitted lineage.`);
  if (submitted && !prepared) ambiguities.push(`${name} has a submitted checkpoint without its captured-not-submitted checkpoint.`);
  if (submitted && !response && !["original", "replacement"].includes(name)) ambiguities.push(`${name} was submitted but its non-financial outcome is unknown.`);
  if (response) {
    if (isDeterministicFinancialRejection(name, response)) {
      let details = {};
      try { details = JSON.parse(response.response?.body?.details ?? "{}"); } catch { details = {}; }
      checkIntegrity(response.response?.status === 400 && response.response?.body?.code === "P0001" && details.code === "invalid_payload" && details.message === response.response?.body?.message, `${name} deterministic rejection envelope is not exact.`);
    } else {
      checkIntegrity(response.response?.status === 200, `${name} response is not HTTP 200.`);
    }
    checkIntegrity(response.submissionCount === 1 && response.captureCount === 1, `${name} response does not prove one capture/submission.`);
    checkIntegrity(prepared?.submissionCount === 0 && prepared?.captureCount === 1, `${name} prepared checkpoint is not captured-not-submitted.`);
    checkIntegrity(submitted?.submissionCount === 1 && submitted?.captureCount === 1 && submitted?.status === "submitted-once-response-pending", `${name} submitted checkpoint is not exact.`);
    checkIntegrity(same(prepared?.request, submitted?.request) && same(submitted?.request, response?.request), `${name} request changed across immutable checkpoints.`);
  }
}
checkIntegrity(preflight.actors?.[0]?.actorId === origin.actorId && preflight.actors?.[1]?.actorId === observer.actorId, "Current actor identities differ from reviewed preflight.");
if (terminal) checkIntegrity(terminal.actors?.origin === origin.actorId && terminal.actors?.observer === observer.actorId, "Terminal actor identities differ from authenticated actors.");

const itemId = body(stages.create)?.changed_rows?.inventory_items?.[0] ?? null;
const tabId = body(stages.open)?.entity_id ?? null;
const tabItemId = body(stages.add)?.changed_rows?.customer_tab_items?.[0] ?? null;
const originalBillId = body(stages.original)?.bill_id ?? null;
const replacementBillId = body(stages.replacement)?.bill_id ?? null;
const billIds = [originalBillId, replacementBillId].filter(Boolean);
const allResponses = Object.values(stages).filter(Boolean);
const expectedEventIds = allResponses.map((stage) => body(stage)?.event_id).filter(Boolean);
const expectedAuditIds = [...new Set(allResponses.flatMap((stage) => changed(stage, "audit_logs")))];
const allMutationIds = allResponses.map(mutationId).filter(Boolean);
const originalCanonical = await canonical(origin.client, stages.original ?? submittedStages.original);
const replacementCanonical = await canonical(observer.client, stages.replacement ?? submittedStages.replacement);
const mutationStatuses = [originalCanonical, replacementCanonical].filter(Boolean);
if (submittedStages.original && !stages.original && !originalCanonical) ambiguities.push("Original checkout was submitted but has neither response nor canonical result.");
if (submittedStages.replacement && !stages.replacement && !replacementCanonical) ambiguities.push("Replacement checkout was submitted but has neither response nor canonical result.");

const [items, tabs, tabItems, bills, lines, payments, movements, audits, events, runEvents, runAudits, openSessions, openTabs, appState] = await Promise.all([
  itemId ? query("item", supabase.from("inventory_items").select("id,name,barcode,category,price,stock_qty,active,archived_by_user_id,archive_reason").eq("organization_id", organizationId).eq("id", itemId)) : [],
  tabId ? query("tab", supabase.from("customer_tabs").select("id,status,close_disposition,closed_bill_id,customer_id,customer_name,close_reason").eq("organization_id", organizationId).eq("id", tabId)) : [],
  tabId ? query("tab items", supabase.from("customer_tab_items").select("id,customer_tab_id,inventory_item_id,name,quantity,unit_price,stock_units_per_sale").eq("organization_id", organizationId).eq("customer_tab_id", tabId)) : [],
  query("bills", supabase.from("bills").select("id,bill_number,status,total,amount_paid,amount_due,replacement_of_bill_id,replaced_by_bill_id,replace_reason,replaced_by_user_id,issued_by_user_id,customer_id,customer_name").eq("organization_id", organizationId).in("bill_number", [originalBillNumber, replacementBillNumber])),
  billIds.length ? query("lines", supabase.from("bill_lines").select("id,bill_id,type,description,inventory_item_id,quantity,unit_price,subtotal,discount_amount,total,linked_session_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("payments", supabase.from("payments").select("id,bill_id,mode,amount,received_by_user_id,settlement_group_id,related_checkout_bill_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  itemId ? query("movements", supabase.from("stock_movements").select("id,item_id,type,quantity,reason,related_bill_id,user_id").eq("organization_id", organizationId).eq("item_id", itemId)) : [],
  expectedAuditIds.length ? query("audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id,created_at").eq("organization_id", organizationId).in("id", expectedAuditIds)) : [],
  expectedEventIds.length ? query("events", supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata,created_at").eq("organization_id", organizationId).in("id", expectedEventIds)) : [],
  allMutationIds.length ? query("run events", supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata,created_at").eq("organization_id", organizationId).in("metadata->>mutation_id", allMutationIds)) : [],
  [itemId, tabId, ...billIds].filter(Boolean).length ? query("run audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id,created_at").eq("organization_id", organizationId).in("entity_id", [itemId, tabId, ...billIds].filter(Boolean)).gte("created_at", preflight.checkedAt)) : [],
  query("open sessions", supabase.from("sessions").select("id,status,customer_name").eq("organization_id", organizationId).neq("status", "closed")),
  query("open tabs", supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open")),
  query("app state", supabase.from("app_state").select("version,data").eq("id", "primary"))
]);

const expectedEventType = { create: "admin_data_committed", open: "open_customer_tab", add: "add_customer_tab_item", update: "update_customer_tab_item_quantity", original: "financial_checkout_committed_v2", replacement: "financial_checkout_committed_v2", archive: "admin_data_committed" };
const expectedActor = { create: origin.actorId, open: origin.actorId, add: origin.actorId, update: origin.actorId, original: origin.actorId, replacement: observer.actorId, archive: origin.actorId };
for (const [name, stage] of Object.entries(stages)) {
  if (!stage) continue;
  if (isDeterministicFinancialRejection(name, stage)) continue;
  const result = body(stage);
  const request = envelope(stage);
  const event = events.find((row) => row.id === result.event_id);
  checkIntegrity(result.mutation_id === request?.mutation_id && result.organization_id === organizationId, `${name} response mutation/organization differs from command.`);
  checkIntegrity(event?.event_type === expectedEventType[name] && event?.entity_type === result.entity_type && event?.entity_id === result.entity_id && event?.created_by === expectedActor[name], `${name} event id/type/entity/actor is not exact.`);
  checkIntegrity(event?.metadata?.mutation_id === request?.mutation_id && event?.metadata?.mutation_kind === request?.mutation_kind, `${name} event mutation lineage is not exact.`);
  if (["create", "archive", "original", "replacement"].includes(name)) {
    checkIntegrity(same(event?.metadata?.changed_rows, eventChangedRows(result)), `${name} event changed_rows differ from acknowledgement.`);
  } else {
    checkIntegrity(sameIds(result.changed_rows?.operational_events ?? [], [result.event_id]), `${name} acknowledgement does not bind its exact event id.`);
    checkIntegrity(event?.metadata?.changed_rows === undefined, `${name} event unexpectedly stores a non-contract changed_rows payload.`);
    if (name === "open") {
      checkIntegrity(sameKeys(event?.metadata, ["audit_log_id", "customer_id", "customer_tab_id", "mutation_id", "mutation_kind"]) && event?.metadata?.customer_tab_id === result.entity_id && event?.metadata?.customer_id === (result.changed_rows?.customers?.[0] ?? null) && event?.metadata?.audit_log_id === (result.changed_rows?.audit_logs?.[0] ?? null), "open event customer/tab/audit metadata is not exact.");
    } else if (name === "add") {
      checkIntegrity(sameKeys(event?.metadata, ["audit_log_id", "line_id", "mutation_id", "mutation_kind"]) && event?.metadata?.line_id === result.changed_rows?.customer_tab_items?.[0] && event?.metadata?.audit_log_id === (result.changed_rows?.audit_logs?.[0] ?? null), "add event line/audit metadata is not exact.");
    } else {
      checkIntegrity(sameKeys(event?.metadata, ["line_id", "mutation_id", "mutation_kind", "quantity"]) && event?.metadata?.line_id === result.changed_rows?.customer_tab_items?.[0] && Number(event?.metadata?.quantity) === Number(command(stage).quantity), "update event line/quantity metadata is not exact.");
    }
  }
  const requestedAudits = auditCommands(stage);
  checkIntegrity(sameIds(result.changed_rows?.audit_logs ?? [], requestedAudits.map((row) => row.id)), `${name} audit changed_rows differ from command.`);
  for (const expected of requestedAudits) {
    const actual = audits.find((row) => row.id === expected.id);
    const expectedMessage = name === "original" ? `Issued ${originalBillNumber}.` : name === "replacement" ? `Issued replacement ${replacementBillNumber} for ${originalBillNumber}. Reason: ${command(stage).primary_bill.replaceReason}.` : expected.message;
    checkIntegrity(actual?.action === expected.action && actual?.entity_type === expected.entityType && actual?.entity_id === expected.entityId && actual?.message === expectedMessage && actual?.user_id === expectedActor[name], `${name} audit ${expected.id} action/entity/message/actor is not exact.`);
  }
  const expectedChangedRowKeys = {
    create: ["audit_logs", "inventory_items", "sale_variants"],
    open: ["audit_logs", "customer_tabs", "customers", "operational_events"],
    add: ["audit_logs", "customer_tab_items", "customer_tabs", "operational_events"],
    update: ["customer_tab_items", "customer_tabs", "operational_events"],
    original: ["audit_logs", "bills", "customer_tabs", "customers", "inventory_items", "payments", "sessions", "stock_movements"],
    replacement: ["audit_logs", "bills", "customer_tabs", "customers", "inventory_items", "payments", "sessions", "stock_movements"],
    archive: ["audit_logs", "inventory_items", "sale_variants"]
  };
  checkIntegrity(sameKeys(result.changed_rows, expectedChangedRowKeys[name]), `${name} changed_rows keys are not exact.`);
}

if (stages.create) {
  const createdItem = command(stages.create).inventoryItems?.find((row) => row.id === itemId);
  checkIntegrity(itemId && items.length === 1 && createdItem, "Fixture creation did not resolve to one command-bound item.");
  checkIntegrity(items[0]?.name === itemName && items[0]?.barcode === createdItem?.barcode && items[0]?.category === createdItem?.category && money(items[0]?.price) === 50, "Fixture item identity/catalog values changed.");
  checkIntegrity(sameIds(changed(stages.create, "inventory_items"), [itemId]) && sameIds(changed(stages.create, "sale_variants"), [itemId]), "Fixture-create changed rows are not exact.");
  checkIntegrity(body(stages.create)?.app_state_version === preflight.appState.version + 1, "Fixture-create compatibility version is not preflight plus one.");
}
if (stages.open) {
  checkIntegrity(tabId && tabs.length === 1 && tabs[0].customer_name === customerName, "Customer-tab identity is not exact.");
  checkIntegrity(sameIds(changed(stages.open, "customer_tabs"), [tabId]), "Open-tab changed_rows does not contain the exact tab.");
}
if (stages.add) {
  const requestedLine = command(stages.add).line;
  checkIntegrity(tabItemId && sameIds(changed(stages.add, "customer_tab_items"), [tabItemId]), "Add-item changed_rows does not contain the exact tab item.");
  checkIntegrity(requestedLine?.inventoryItemId === itemId && tabItems.some((row) => row.id === tabItemId && row.customer_tab_id === tabId && row.inventory_item_id === itemId && row.name === itemName && money(row.unit_price) === 50), "Added tab item differs from its command.");
}
if (stages.update) {
  checkIntegrity(sameIds(changed(stages.update, "customer_tab_items"), [tabItemId]), "Quantity-update changed_rows does not contain the exact tab item.");
  checkIntegrity(Number(command(stages.update).quantity) === 2 && tabItems.some((row) => row.id === tabItemId && money(row.quantity) === 2), "Tab-item quantity is not the commanded value 2.");
}

for (const [name, stage, canonicalResult] of [["original", stages.original, originalCanonical], ["replacement", stages.replacement, replacementCanonical]]) {
  if (!stage) continue;
  if (isDeterministicFinancialRejection(name, stage)) {
    checkIntegrity(canonicalResult === null, `${name} deterministic rejection unexpectedly has a canonical mutation result.`);
    continue;
  }
  const financial = command(stage);
  checkIntegrity(Boolean(canonicalResult), `${name} canonical mutation result is missing.`);
  checkIntegrity(same(canonicalResult, body(stage)), `Canonical mutation result differs for ${mutationId(stage)}.`);
  checkIntegrity(canonicalResult?.mutation_id === envelope(stage)?.mutation_id && canonicalResult?.bill_id === financial.primary_bill.id, `${name} canonical mutation/bill identity differs from command.`);
  checkIntegrity(sameIds(canonicalResult?.changed_rows?.bills, financial.bill_updates.map((row) => row.id)), `${name} changed bill IDs differ from command.`);
  checkIntegrity(sameIds(canonicalResult?.changed_rows?.payments, financial.payments.map((row) => row.id)), `${name} changed payment IDs differ from command.`);
  checkIntegrity(sameIds(canonicalResult?.changed_rows?.stock_movements, financial.stock_movements.map((row) => row.id)), `${name} changed movement IDs differ from command.`);
  checkIntegrity(sameIds(canonicalResult?.changed_rows?.audit_logs, financial.audit_logs.map((row) => row.id)), `${name} changed audit IDs differ from command.`);
  checkIntegrity(sameIds(canonicalResult?.changed_rows?.customer_tabs, (financial.customer_tab_updates ?? []).map((row) => row.id)), `${name} changed tab IDs differ from command.`);
  checkIntegrity(sameIds(canonicalResult?.changed_rows?.inventory_items, (financial.inventory_expectations ?? []).map((row) => row.itemId)), `${name} changed inventory IDs differ from command.`);
  const event = events.find((row) => row.id === canonicalResult?.event_id);
  checkIntegrity(same(event?.metadata?.changed_rows, canonicalResult?.changed_rows), `${name} financial event changed_rows differ from canonical result.`);
  for (const expected of financial.primary_bill.lines) {
    const actual = lines.find((row) => row.id === expected.id && row.bill_id === financial.primary_bill.id);
    checkIntegrity(actual?.bill_id === financial.primary_bill.id && actual?.type === expected.type && actual?.inventory_item_id === (expected.inventoryItemId ?? null) && Number(actual?.quantity) === Number(expected.quantity) && Number(actual?.unit_price) === Number(expected.unitPrice) && Number(actual?.subtotal) === Number(expected.subtotal) && Number(actual?.discount_amount) === Number(expected.discountAmount) && Number(actual?.total) === Number(expected.total), `${name} bill line ${expected.id} differs from command.`);
  }
  for (const expected of financial.payments) {
    const actual = payments.find((row) => row.id === expected.id);
    checkIntegrity(actual?.bill_id === expected.billId && actual?.mode === expected.mode && Number(actual?.amount) === Number(expected.amount) && actual?.received_by_user_id === expectedActor[name] && actual?.related_checkout_bill_id === (expected.relatedCheckoutBillId ?? null), `${name} payment ${expected.id} identity/amount/actor differs from command.`);
  }
  for (const expected of financial.stock_movements) {
    const actual = movements.find((row) => row.id === expected.id);
    checkIntegrity(actual?.item_id === expected.itemId && actual?.type === expected.type && Number(actual?.quantity) === Number(expected.quantity) && actual?.reason === expected.reason && actual?.related_bill_id === (expected.relatedBillId ?? null) && actual?.user_id === expectedActor[name], `${name} movement ${expected.id} differs from command.`);
  }
}

if (stages.original && stages.replacement) {
  const originalBill = bills.find((bill) => bill.id === originalBillId);
  const replacementBill = bills.find((bill) => bill.id === replacementBillId);
  checkIntegrity(bills.length === 2, "Expected exactly the original and replacement bills.");
  checkIntegrity(originalBill?.bill_number === originalBillNumber && originalBill?.status === "replaced" && originalBill?.replaced_by_bill_id === replacementBillId && originalBill?.issued_by_user_id === origin.actorId && originalBill?.replaced_by_user_id === observer.actorId, "Original replacement linkage/status/actors are incorrect.");
  checkIntegrity(money(originalBill?.total) === 100 && money(originalBill?.amount_paid) === 100 && money(originalBill?.amount_due) === 0, "Original totals are incorrect.");
  checkIntegrity(replacementBill?.bill_number === replacementBillNumber && replacementBill?.status === "issued" && replacementBill?.replacement_of_bill_id === originalBillId && replacementBill?.issued_by_user_id === observer.actorId, "Replacement linkage/status/actor is incorrect.");
  checkIntegrity(money(replacementBill?.total) === 50 && money(replacementBill?.amount_paid) === 50 && money(replacementBill?.amount_due) === 0, "Replacement totals are incorrect.");
  checkIntegrity(lines.length === 2 && lines.some((line) => line.bill_id === originalBillId && line.inventory_item_id === itemId && money(line.quantity) === 2 && money(line.total) === 100) && lines.some((line) => line.bill_id === replacementBillId && line.inventory_item_id === itemId && money(line.quantity) === 1 && money(line.total) === 50), "Bill lines do not prove quantity 2 to 1.");
  checkIntegrity(payments.length === 2 && payments.some((payment) => payment.bill_id === originalBillId && payment.mode === "cash" && money(payment.amount) === 100 && payment.received_by_user_id === origin.actorId) && payments.some((payment) => payment.bill_id === replacementBillId && payment.mode === replacementPaymentMode && money(payment.amount) === 50 && payment.received_by_user_id === observer.actorId), "Payment linkage/amount/actors are incorrect.");
  checkIntegrity(movements.length === 2 && movements.some((movement) => movement.related_bill_id === originalBillId && movement.item_id === itemId && movement.type === "sale" && money(movement.quantity) === -2 && movement.user_id === origin.actorId) && movements.some((movement) => movement.related_bill_id === replacementBillId && movement.item_id === itemId && movement.type === "void_refund_reversal" && money(movement.quantity) === 1 && movement.user_id === observer.actorId), "Stock movements do not prove exact -2 sale and +1 reversal with actors.");
  checkIntegrity(items[0]?.stock_qty !== undefined && money(items[0].stock_qty) === 4, "Final physical stock is not 4.");
  checkIntegrity(tabs.length === 1 && tabs[0].status === "closed" && tabs[0].close_disposition === "billed" && tabs[0].closed_bill_id === originalBillId, "Source tab closure is incorrect.");
}

checkIntegrity(sameIds(events.map((row) => row.id), expectedEventIds) && sameIds(runEvents.map((row) => row.id), expectedEventIds), "Run contains an extra or missing compact event.");
checkIntegrity(sameIds(audits.map((row) => row.id), expectedAuditIds) && sameIds(runAudits.map((row) => row.id), expectedAuditIds), "Run contains an extra or missing audit row.");

const financialState = terminal?.financialState;
if (terminal) {
  checkCompletion(summary?.status === "passed", "Playwright summary is not passed.");
  checkCompletion(terminal.status === "passed", "Terminal checkpoint is not passed.");
  checkIntegrity(terminal.uiParity?.hardRefreshContexts === 2, "Two-context hard-refresh evidence is missing.");
  checkIntegrity(terminal.uiParity?.billRegister?.original?.id === originalBillId && terminal.uiParity?.billRegister?.replacement?.id === replacementBillId, "Bill Register evidence is not identity-bound.");
  checkIntegrity(terminal.uiParity?.receipt?.billId === replacementBillId && terminal.uiParity?.receipt?.payment?.id === payments.find((row) => row.bill_id === replacementBillId)?.id, "Receipt evidence is not bound to the exact replacement/payment.");
  checkIntegrity(terminal.uiParity?.pendingReceivable?.billNumber === preflight.pendingReceivable?.bill_number && terminal.uiParity?.pendingReceivable?.backend?.bill_number === preflight.pendingReceivable?.bill_number, "Pending-receivable evidence is not exact.");
  checkIntegrity(Number(terminal.uiParity?.analytics?.renderedGross) === Number(terminal.uiParity?.analytics?.backendGross), "Analytics rendered/backend gross differs.");
  checkIntegrity(terminal.uiParity?.customerAnalytics?.customerName === customerName && terminal.uiParity?.customerAnalytics?.recentBillNumber === replacementBillNumber, "Customer analytics evidence is not exact.");
  checkIntegrity(terminal.uiParity?.inventoryReport?.backendRow?.item_id === itemId && terminal.uiParity?.inventoryReport?.backendDetails?.length === 2, "Inventory report evidence is not exact.");
  checkIntegrity(financialState?.version === preflight.appState.version + 1, "Fixture create did not advance compatibility exactly once before financial work.");
  checkIntegrity(terminal.operations?.original?.response?.app_state_version === undefined && terminal.operations?.replacement?.response?.app_state_version === undefined, "Financial responses unexpectedly expose compatibility writes.");
  checkIntegrity(terminal.finalState?.version === financialState?.version + 1, "Fixture archive did not advance compatibility exactly once after financial work.");
  checkIntegrity(appState.length === 1 && appState[0].version === terminal.finalState.version && createHash("sha256").update(JSON.stringify(appState[0].data)).digest("hex") === terminal.finalState.hash, "Final app_state version/hash differs from terminal evidence.");
  checkIntegrity(items[0]?.active === false && items[0]?.archive_reason === `Replacement parity fixture cleanup ${runId}` && items[0]?.archived_by_user_id === origin.actorId, "Exact fixture item was not archived by the origin actor after parity checks.");
  checkIntegrity(openSessions.length === 0 && openTabs.length === 0, "Staging floor is not empty after replacement parity.");
} else checkCompletion(false, "Browser terminal evidence is missing.");

const activeItem = items[0]?.active === true ? { id: items[0].id, name: items[0].name } : null;
const openSourceTab = tabs[0]?.status === "open" ? { id: tabs[0].id, customerName: tabs[0].customer_name } : null;
const deterministicFinancialRejections = Object.entries(stages).filter(([name, stage]) => isDeterministicFinancialRejection(name, stage)).map(([name, stage]) => ({ name, mutationId: mutationId(stage), status: stage.response.status, body: stage.response.body }));
if (deterministicFinancialRejections.length) {
  checkIntegrity(bills.length === 0 && lines.length === 0 && payments.length === 0 && movements.length === 0 && mutationStatuses.length === 0, "A deterministic financial rejection left a bill, line, payment, movement, or canonical mutation effect.");
  checkIntegrity(tabs.length === 1 && tabs[0].status === "open" && items.length === 1 && money(items[0].stock_qty) === 5, "Setup state after deterministic financial rejection is not exactly recoverable.");
}
const status = integrityFailures.length === 0 && completionFailures.length === 0 && ambiguities.length === 0 ? "passed" : "partial";
const safeForIdentityBoundCleanup = integrityFailures.length === 0 && ambiguities.length === 0 && Boolean(openSourceTab || activeItem) && expectedEventIds.length === runEvents.length && expectedAuditIds.length === runAudits.length;
const report = {
  runId, generatedAt: new Date().toISOString(), projectRef: STAGING_PROJECT_REF, productionAllowed: false, safeForAutomaticRetry: false, status,
  failures: [...integrityFailures, ...completionFailures], integrityFailures, completionFailures, ambiguities, deterministicFinancialRejections, playwright: summary, sourceFailure: failure,
  actors: { origin: origin.actorId, observer: observer.actorId },
  identities: { customerName, itemName, itemId, tabId, tabItemId, originalBillId, originalBillNumber, replacementBillId, replacementBillNumber },
  evidence: Object.fromEntries(Object.entries({ preflight: preflightPath, terminal: terminal ? terminalPath : null, failure: failure ? failurePath : null }).filter(([, value]) => value).map(([key, value]) => [key, { path: path.relative(root, value), sha256: createHash("sha256").update(fs.readFileSync(value)).digest("hex") }])),
  snapshot: { items, tabs, tabItems, bills, lines, payments, movements, mutationStatuses, audits, events, runEvents, runAudits, openSessions, openTabs, appState: appState[0] ? { version: appState[0].version, hash: createHash("sha256").update(JSON.stringify(appState[0].data)).digest("hex") } : null },
  recovery: { rejectTab: openSourceTab, archiveItem: activeItem }, safeForIdentityBoundCleanup
};
const outputPath = path.join(evidenceDirectory, `checkout-replacement-parity-${reanalysis ? "reanalysis" : "reconciliation"}-${runId}.json`);
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
const sha256 = createHash("sha256").update(fs.readFileSync(outputPath)).digest("hex");
console.log(JSON.stringify({ status, artifact: path.relative(root, outputPath), sha256, integrityFailures, completionFailures, ambiguities, safeForIdentityBoundCleanup }, null, 2));
if (status !== "passed") process.exitCode = 1;
