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
const cleanupRunId = sanitizeRunId(env.E2E_RUN_ID);
const sourceRunId = sanitizeRunId(env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID);
const postflightReanalysis = env.E2E_REPLACEMENT_PARITY_CLEANUP_REANALYZE === "true";
const recoveryPath = path.resolve(env.E2E_REPLACEMENT_PARITY_RECOVERY_ARTIFACT ?? "");
const recoveryRaw = fs.readFileSync(recoveryPath);
if (createHash("sha256").update(recoveryRaw).digest("hex") !== env.E2E_REPLACEMENT_PARITY_RECOVERY_SHA256) throw new Error("Recovery SHA-256 changed before cleanup postflight.");
const recovery = JSON.parse(recoveryRaw.toString("utf8"));
const terminalPath = path.join(root, "test-artifacts", "evidence", `checkout-replacement-parity-cleanup-terminal-${cleanupRunId}.json`);
if (!fs.existsSync(terminalPath)) throw new Error("Cleanup terminal evidence is missing.");
const terminal = JSON.parse(fs.readFileSync(terminalPath, "utf8"));
const preparedPath = path.resolve(root, terminal.preparedPath);
if (!fs.existsSync(preparedPath)) throw new Error("Cleanup prepared evidence is missing.");
const prepared = JSON.parse(fs.readFileSync(preparedPath, "utf8"));
const summaryPath = path.join(root, "test-artifacts", "playwright", `summary-${cleanupRunId}.json`);
const summary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, "utf8")) : null;

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) throw new Error("Cleanup postflight is locked to staging.");
async function authenticate(slot) {
  const client = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const lookup = await client.functions.invoke("resolve-login-email", { body: { username: env[`E2E_USER_${slot}`].trim() } });
  if (lookup.error || !lookup.data?.email) throw new Error(`Unable to resolve staging cleanup slot ${slot}.`);
  const login = await client.auth.signInWithPassword({ email: lookup.data.email, password: env[`E2E_PASSWORD_${slot}`] });
  if (login.error || !login.data.user) throw new Error(`Unable to authenticate staging cleanup slot ${slot}.`);
  const role = await client.rpc("current_user_org_role", { target_organization_id: organizationId });
  if (role.error || role.data !== "admin") throw new Error(`Cleanup postflight slot ${slot} requires an active staging admin.`);
  return { client, actorId: login.data.user.id };
}
const origin = await authenticate("A");
const observer = await authenticate("B");
const supabase = origin.client;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function sorted(rows) { return [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id))).map(stable); }
function sameRows(left, right) { return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right)); }
function sameIds(left = [], right = []) { return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()); }
function sameKeys(actual = {}, expected = []) { return sameIds(Object.keys(actual), expected); }
function dataHash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function query(label, request) {
  const result = await request;
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  return result.data ?? [];
}
async function mutationStatus(client, expected) {
  const result = await client.rpc("get_financial_mutation_result", { payload: { organization_id: organizationId, mutation_id: expected.mutation_id, mutation_kind: "commitCheckoutBill" } });
  if (result.error) throw new Error(`Canonical mutation ${expected.mutation_id} query failed: ${result.error.message}`);
  return result.data;
}
const failures = [];
function check(condition, message) { if (!condition) failures.push(message); }
function validateActionEvidence(action) {
  check(Array.isArray(action.evidence) && action.evidence.length === 3, `${action.type} does not have prepared/submitted/response evidence.`);
  const records = (action.evidence ?? []).map((relative) => {
    const target = path.resolve(root, relative);
    check(fs.existsSync(target), `${action.type} evidence is missing: ${relative}.`);
    return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : null;
  });
  const [preparedRecord, submittedRecord, responseRecord] = records;
  check(preparedRecord?.status === "captured-not-submitted" && preparedRecord?.captureCount === 1 && preparedRecord?.submissionCount === 0, `${action.type} prepared evidence is not exact.`);
  check(submittedRecord?.status === "submitted-once-response-pending" && submittedRecord?.captureCount === 1 && submittedRecord?.submissionCount === 1, `${action.type} submitted evidence is not exact.`);
  check(responseRecord?.status === "response-received" && responseRecord?.captureCount === 1 && responseRecord?.submissionCount === 1 && responseRecord?.response?.status === 200, `${action.type} response evidence is not exact.`);
  check(JSON.stringify(stable(preparedRecord?.request)) === JSON.stringify(stable(submittedRecord?.request)) && JSON.stringify(stable(submittedRecord?.request)) === JSON.stringify(stable(responseRecord?.request)), `${action.type} request changed across cleanup checkpoints.`);
  check(JSON.stringify(stable(responseRecord?.response?.body)) === JSON.stringify(stable(action.response)), `${action.type} terminal response differs from immutable response evidence.`);
  check(Date.parse(preparedRecord?.recordedAt) <= Date.parse(submittedRecord?.recordedAt) && Date.parse(submittedRecord?.recordedAt) <= Date.parse(responseRecord?.recordedAt), `${action.type} checkpoint chronology is invalid.`);
}
const snapshot = recovery.snapshot;
const itemId = recovery.identities.itemId;
const tabId = recovery.identities.tabId;
const billIds = snapshot.bills.map((row) => row.id);
const missing = "00000000-0000-0000-0000-000000000000";
const sourceEventIds = snapshot.events.map((row) => row.id);
const sourceAuditIds = snapshot.audits.map((row) => row.id);
const cleanupEventIds = terminal.actions.map((action) => action.eventId);
const cleanupAuditIds = terminal.actions.map((action) => action.auditId);
const cleanupMutationIds = terminal.actions.map((action) => action.mutationId);
const allEventIds = [...sourceEventIds, ...cleanupEventIds];
const allAuditIds = [...sourceAuditIds, ...cleanupAuditIds];
const [items, tabs, bills, lines, payments, movements, events, audits, cleanupRunEvents, cleanupRunAudits, openSessions, openTabs, appState, mutationStatuses] = await Promise.all([
  itemId ? query("item", supabase.from("inventory_items").select("id,name,barcode,category,price,stock_qty,active,archived_by_user_id,archive_reason").eq("organization_id", organizationId).eq("id", itemId)) : [],
  tabId ? query("tab", supabase.from("customer_tabs").select("id,status,close_disposition,closed_bill_id,customer_id,customer_name,close_reason").eq("organization_id", organizationId).eq("id", tabId)) : [],
  query("bills", supabase.from("bills").select("id,bill_number,status,total,amount_paid,amount_due,replacement_of_bill_id,replaced_by_bill_id,replace_reason,replaced_by_user_id,issued_by_user_id,customer_id,customer_name").eq("organization_id", organizationId).in("bill_number", [recovery.identities.originalBillNumber, recovery.identities.replacementBillNumber])),
  query("lines", supabase.from("bill_lines").select("id,bill_id,type,description,inventory_item_id,quantity,unit_price,subtotal,discount_amount,total,linked_session_id").eq("organization_id", organizationId).in("bill_id", billIds.length ? billIds : [missing])),
  query("payments", supabase.from("payments").select("id,bill_id,mode,amount,received_by_user_id,settlement_group_id,related_checkout_bill_id").eq("organization_id", organizationId).in("bill_id", billIds.length ? billIds : [missing])),
  query("movements", supabase.from("stock_movements").select("id,item_id,type,quantity,reason,related_bill_id,user_id").eq("organization_id", organizationId).in("related_bill_id", billIds.length ? billIds : [missing])),
  allEventIds.length ? query("all source and cleanup events", supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata,created_at").eq("organization_id", organizationId).in("id", allEventIds)) : [],
  allAuditIds.length ? query("all source and cleanup audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id,created_at").eq("organization_id", organizationId).in("id", allAuditIds)) : [],
  cleanupMutationIds.length ? query("cleanup run events", supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata,created_at").eq("organization_id", organizationId).in("metadata->>mutation_id", cleanupMutationIds)) : [],
  cleanupAuditIds.length ? query("cleanup run audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id,created_at").eq("organization_id", organizationId).in("id", cleanupAuditIds).gte("created_at", prepared.recordedAt)) : [],
  query("open sessions", supabase.from("sessions").select("id,status,customer_name").eq("organization_id", organizationId).neq("status", "closed")),
  query("open tabs", supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open")),
  query("app state", supabase.from("app_state").select("version,data").eq("id", "primary")),
  Promise.all((snapshot.mutationStatuses ?? []).map((expected, index) => mutationStatus(index === 0 ? origin.client : observer.client, expected)))
]);

check(summary?.status === "passed", "Cleanup Playwright summary is not passed.");
check(terminal.status === "cleanup-confirmed" && terminal.sourceRunId === sourceRunId, "Cleanup terminal lineage/status changed.");
check(terminal.actorId === origin.actorId && terminal.observerActorId === observer.actorId && recovery.actors.origin === origin.actorId && recovery.actors.observer === observer.actorId, "Cleanup/source actor lineage changed.");
check(sameRows(bills, snapshot.bills), "Source bills changed during cleanup.");
check(sameRows(lines, snapshot.lines), "Source bill lines changed during cleanup.");
check(sameRows(payments, snapshot.payments), "Source payments changed during cleanup.");
check(sameRows(movements, snapshot.movements), "Source stock movements changed during cleanup.");
check(sameRows(events.filter((row) => sourceEventIds.includes(row.id)), snapshot.events), "Source operational events changed during cleanup.");
check(sameRows(audits.filter((row) => sourceAuditIds.includes(row.id)), snapshot.audits), "Source audit logs changed during cleanup.");
check(JSON.stringify(mutationStatuses.map(stable)) === JSON.stringify((snapshot.mutationStatuses ?? []).map(stable)), "Canonical financial mutation results changed during cleanup.");
check(openSessions.length === 0 && openTabs.length === 0, "Final staging floor is not empty.");
check(appState.length === 1 && appState[0].version === snapshot.appState.version + terminal.actions.length, "Cleanup compatibility version did not advance exactly once per acknowledged action.");
check(appState.length === 1 && appState[0].version === terminal.final.appState.version && dataHash(appState[0].data) === terminal.final.appState.hash, "Cleanup final compatibility version/hash differs from terminal evidence.");
check(terminal.actions.length === Number(Boolean(recovery.recovery.rejectTab)) + Number(Boolean(recovery.recovery.archiveItem)), "Cleanup action cardinality differs from authorization.");

for (const action of terminal.actions) {
  validateActionEvidence(action);
  const isArchive = action.type === "archive_inventory_item";
  const entityId = isArchive ? itemId : tabId;
  const expectedEventType = isArchive ? "admin_data_committed" : "reject_customer_tab";
  const expectedEntityType = isArchive ? "admin_data" : "customer_tab";
  const expectedAuditAction = isArchive ? "inventory_archived" : "customer_tab_rejected";
  const expectedAuditEntityType = isArchive ? "inventory_item" : "customer_tab";
  const event = events.find((row) => row.id === action.eventId);
  const audit = audits.find((row) => row.id === action.auditId);
  const releasedContinuationIds = event?.metadata?.released_continued_from_session_ids ?? [];
  const expectedAuditMessage = isArchive
    ? `Archived ${snapshot.items[0].name}. Reason: ${action.reason}.`
    : `Rejected customer tab for ${snapshot.tabs[0].customer_name}. Reason: ${action.reason}${releasedContinuationIds.length ? ` Released ${releasedContinuationIds.length} prior game continuation${releasedContinuationIds.length === 1 ? "" : "s"}.` : ""}`;
  const responseChangedRowsWithoutEvent = Object.fromEntries(Object.entries(action.response?.changed_rows ?? {}).filter(([key]) => key !== "operational_events"));
  check(action.response?.mutation_id === action.mutationId && action.response?.event_id === action.eventId && action.response?.entity_type === expectedEntityType, `${action.type} acknowledgement mutation/event/entity is not exact.`);
  check(sameIds(action.response?.changed_rows?.audit_logs, [action.auditId]), `${action.type} acknowledgement audit changed_rows is not exact.`);
  check(isArchive ? sameIds(action.response?.changed_rows?.inventory_items, [itemId]) : sameIds(action.response?.changed_rows?.customer_tabs, [tabId]), `${action.type} acknowledgement entity changed_rows is not exact.`);
  check(isArchive ? !("operational_events" in (action.response?.changed_rows ?? {})) : sameIds(action.response?.changed_rows?.operational_events, [action.eventId]), `${action.type} acknowledgement event changed_rows contract is not exact.`);
  check(sameKeys(action.response?.changed_rows, isArchive ? ["audit_logs", "inventory_items", "sale_variants"] : ["audit_logs", "customer_tabs", "operational_events"]), `${action.type} acknowledgement changed_rows keys are not exact.`);
  if (isArchive) check(sameIds(action.response?.changed_rows?.sale_variants, [itemId]), `${action.type} sale-variant refresh identity is not exact.`);
  check(event?.event_type === expectedEventType && event?.entity_type === expectedEntityType && event?.entity_id === action.response?.entity_id && event?.created_by === origin.actorId && event?.metadata?.mutation_id === action.mutationId && event?.metadata?.mutation_kind === (isArchive ? "commitAdminDataChange" : "rejectCustomerTab") && JSON.stringify(stable(event?.metadata?.changed_rows)) === JSON.stringify(stable(responseChangedRowsWithoutEvent)), `${action.type} event id/type/entity/actor/mutation/changed_rows is not exact.`);
  check(audit?.action === expectedAuditAction && audit?.entity_type === expectedAuditEntityType && audit?.entity_id === entityId && audit?.user_id === origin.actorId && audit?.message === expectedAuditMessage, `${action.type} audit id/action/entity/message/actor is not exact.`);
}

if (recovery.recovery.rejectTab) {
  const action = terminal.actions.find((entry) => entry.type === "reject_customer_tab");
  check(Boolean(action), "Authorized tab rejection action is missing.");
  check(tabs.length === 1 && tabs[0].id === tabId && tabs[0].status === "closed" && tabs[0].close_disposition === "rejected" && tabs[0].closed_bill_id === null && tabs[0].close_reason === action?.reason, "Exact source tab was not rejected with the authorized reason.");
}
if (recovery.recovery.archiveItem) {
  const action = terminal.actions.find((entry) => entry.type === "archive_inventory_item");
  check(Boolean(action), "Authorized item archive action is missing.");
  check(items.length === 1 && items[0].id === itemId && items[0].active === false && Number(items[0].stock_qty) === Number(snapshot.items[0].stock_qty) && items[0].archived_by_user_id === origin.actorId && items[0].archive_reason === action?.reason, "Exact fixture item was not archived with preserved stock and authorized actor/reason.");
}
check(sameIds(cleanupRunEvents.map((row) => row.id), cleanupEventIds) && sameIds(events.filter((row) => cleanupEventIds.includes(row.id)).map((row) => row.id), cleanupEventIds), "Cleanup has an extra or missing compact event.");
check(sameIds(cleanupRunAudits.map((row) => row.id), cleanupAuditIds) && sameIds(audits.filter((row) => cleanupAuditIds.includes(row.id)).map((row) => row.id), cleanupAuditIds), "Cleanup has an extra or missing audit row.");

const report = {
  cleanupRunId, sourceRunId, generatedAt: new Date().toISOString(), projectRef: STAGING_PROJECT_REF,
  productionAllowed: false, safeForAutomaticRetry: false, status: failures.length ? "failed" : "passed", failures,
  recoveryArtifact: path.relative(root, recoveryPath), recoverySha256: env.E2E_REPLACEMENT_PARITY_RECOVERY_SHA256,
  terminalArtifact: { path: path.relative(root, terminalPath), sha256: createHash("sha256").update(fs.readFileSync(terminalPath)).digest("hex") },
  actions: terminal.actions,
  snapshot: { items, tabs, bills, lines, payments, movements, events, audits, cleanupRunEvents, cleanupRunAudits, mutationStatuses, openSessions, openTabs, appState: appState[0] ? { version: appState[0].version, hash: dataHash(appState[0].data) } : null }
};
const outputPath = path.join(root, "test-artifacts", "evidence", `checkout-replacement-parity-cleanup-postflight${postflightReanalysis ? "-reanalysis" : ""}-${sourceRunId}-${cleanupRunId}.json`);
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
const sha256 = createHash("sha256").update(fs.readFileSync(outputPath)).digest("hex");
console.log(JSON.stringify({ status: report.status, artifact: path.relative(root, outputPath), sha256, failures }, null, 2));
if (failures.length) process.exitCode = 1;
