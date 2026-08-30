import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { assertLiveCredentials, assertStagingBaseUrl, assertStagingSupabaseEnvironment, parseEnvFile, sanitizeRunId, STAGING_APP_URL, STAGING_PROJECT_REF } from "./playwright-staging-env.mjs";

const root = process.cwd();
const organizationId = "org-primary";
const postflightArgs = process.argv.slice(2);
const reanalysis = postflightArgs.length === 1 && postflightArgs[0] === "--reanalysis";
if (postflightArgs.length && !reanalysis) throw new Error("Pricing cleanup postflight accepts only optional --reanalysis.");
const allowedCases = ["discount_rounding_positive", "ltp_zero", "bill_discount_zero", "true_zero_price_guard"];
const env = { ...parseEnvFile(path.join(root, ".env.e2e.local")), ...process.env };
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
assertStagingSupabaseEnvironment(stagingEnv, true);
assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
assertLiveCredentials(env);

const cleanupRunId = sanitizeRunId(env.E2E_RUN_ID);
const sourceRunId = sanitizeRunId(env.E2E_PRICING_SOURCE_RUN_ID);
const selectedCase = env.E2E_PRICING_CASE;
if (!allowedCases.includes(selectedCase) || cleanupRunId === sourceRunId) throw new Error("Pricing cleanup postflight identity is invalid.");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
};
const sortedRows = (rows) => [...(rows ?? [])].sort((left, right) => String(left.id).localeCompare(String(right.id))).map(stable);
const sameRows = (left, right) => JSON.stringify(sortedRows(left)) === JSON.stringify(sortedRows(right));
const sameIds = (left, right) => [...(left ?? [])].sort().join("|") === [...(right ?? [])].sort().join("|");
const evidenceDirectory = path.resolve(root, "test-artifacts", "evidence");
const recoveryPath = path.resolve(env.E2E_PRICING_RECOVERY_ARTIFACT ?? "");
const acceptedRecoveryNames = [`checkout-pricing-reconciliation-${selectedCase}-${sourceRunId}.json`, `checkout-pricing-reanalysis-${selectedCase}-${sourceRunId}.json`];
if (path.dirname(recoveryPath) !== evidenceDirectory || !acceptedRecoveryNames.includes(path.basename(recoveryPath))) throw new Error("Cleanup postflight accepts only the exact pricing reconciliation artifact.");
const recoveryRaw = fs.readFileSync(recoveryPath);
const recovery = JSON.parse(recoveryRaw.toString("utf8"));
if (hash(recoveryRaw) !== env.E2E_PRICING_RECOVERY_SHA256 || recovery.runId !== sourceRunId || recovery.selectedCase !== selectedCase || recovery.projectRef !== STAGING_PROJECT_REF || recovery.status !== "partial" || recovery.productionAllowed !== false || recovery.safeForAutomaticRetry !== false || recovery.safeForIdentityBoundCleanup !== true || recovery.integrityFailures?.length !== 0 || recovery.ambiguities?.length !== 0) throw new Error("Pricing cleanup recovery lineage is invalid.");
if (recovery.reanalysisOf) {
  const original = path.resolve(root, recovery.reanalysisOf.path);
  if (path.dirname(original) !== evidenceDirectory || path.basename(original) !== `checkout-pricing-reconciliation-${selectedCase}-${sourceRunId}.json` || !fs.existsSync(original) || hash(fs.readFileSync(original)) !== recovery.reanalysisOf.sha256) throw new Error("Pricing cleanup reanalysis original lineage changed.");
}

for (const [stage, lineage] of Object.entries(recovery.evidenceLineage ?? {})) {
  const target = path.resolve(root, lineage.path);
  if (path.dirname(target) !== evidenceDirectory || path.basename(target) !== `checkout-pricing-${selectedCase}-${stage}-${sourceRunId}.json` || !fs.existsSync(target) || hash(fs.readFileSync(target)) !== lineage.sha256) throw new Error(`Source evidence lineage changed at ${stage}.`);
}

function loadCleanup(stage, required) {
  const target = path.join(evidenceDirectory, `checkout-pricing-zero-cleanup-${stage}-${cleanupRunId}.json`);
  if (!fs.existsSync(target)) {
    if (required) throw new Error(`Required cleanup evidence is missing: ${stage}.`);
    return null;
  }
  const raw = fs.readFileSync(target);
  return { path: target, raw, value: JSON.parse(raw.toString("utf8")) };
}
const sessionCandidate = recovery.snapshot.cleanupCandidates?.[0] ?? null;
const itemCandidate = recovery.snapshot.itemCleanupCandidate ?? null;
const expectedEffects = Number(Boolean(sessionCandidate)) + Number(Boolean(itemCandidate));
if (recovery.snapshot.cleanupCandidates?.length > 1 || expectedEffects < 1 || Number(env.E2E_PRICING_CLEANUP_EXPECTED_EFFECTS) !== expectedEffects) throw new Error("Cleanup action cardinality is not exact.");
const cleanupPrepared = loadCleanup("prepared", true);
const rejectPrepared = loadCleanup("session-reject-prepared", Boolean(sessionCandidate));
const rejectResponse = loadCleanup("session-reject-response", Boolean(sessionCandidate));
const archivePrepared = loadCleanup("item-archive-prepared", Boolean(itemCandidate));
const archiveResponse = loadCleanup("item-archive-response", Boolean(itemCandidate));
const terminal = loadCleanup("terminal", true);
if (terminal.value.status !== "browser-passed" || terminal.value.sourceRunId !== sourceRunId || terminal.value.cleanupRunId !== cleanupRunId || terminal.value.expectedEffects !== expectedEffects) throw new Error("Cleanup terminal evidence is invalid.");

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const anonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !anonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) throw new Error("Pricing cleanup postflight is locked to staging.");
const supabase = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const lookup = await supabase.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve cleanup actor.");
const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate cleanup actor.");
const role = await supabase.rpc("current_user_org_role", { target_organization_id: organizationId });
if (role.error || role.data !== "admin" || login.data.user.id !== recovery.actorId || login.data.user.id !== terminal.value.actorId || login.data.user.id !== cleanupPrepared.value.actorId) throw new Error("Cleanup actor differs from the authoritative source lineage.");
const actorId = login.data.user.id;
const query = async (label, request) => { const result = await request; if (result.error) throw new Error(`${label}: ${result.error.message}`); return result.data ?? []; };

const sourceSessionIds = recovery.snapshot.sessions.map((row) => row.id);
const billIds = recovery.snapshot.bills.map((row) => row.id);
const sourceEventIds = recovery.snapshot.runEvents.map((row) => row.id);
const sourceAudits = [...recovery.snapshot.startAudits, ...recovery.snapshot.editAudits, ...recovery.snapshot.audits, ...recovery.snapshot.itemAudits]
  .filter((row, index, rows) => rows.findIndex((candidate) => candidate.id === row.id) === index);
const sourceAuditIds = sourceAudits.map((row) => row.id);
const rejectCommand = rejectPrepared?.value?.request?.payload;
const rejectResult = rejectResponse?.value?.response?.body;
const archiveCommand = archivePrepared?.value?.request?.payload;
const archiveResult = archiveResponse?.value?.response?.body;
const cleanupEventIds = [rejectResult?.event_id, archiveResult?.event_id].filter(Boolean);
const cleanupAuditIds = [...(rejectResult?.changed_rows?.audit_logs ?? []), ...(archiveResult?.changed_rows?.audit_logs ?? [])];
const allMutationIds = [...Object.values(recovery.evidenceLineage ?? {}).map((lineage) => {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(root, lineage.path), "utf8"));
  return parsed.request?.payload?.mutation_id;
}), rejectCommand?.mutation_id, archiveCommand?.mutation_id].filter(Boolean);
const runEntityIds = [...sourceSessionIds, ...billIds, recovery.snapshot.item?.id].filter(Boolean);
const runAuditActions = [...new Set([...sourceAudits.map((row) => row.action), "session_rejected", "inventory_archived"] )];

const [sessions, bills, lines, payments, lineDiscounts, billDiscounts, movements, sourceEvents, sourceAuditRows, cleanupEvents, cleanupAudits, runEvents, runAudits, sessionItems, itemMovements, itemRows, openSessions, openTabs, appState] = await Promise.all([
  query("sessions", supabase.from("sessions").select("id,status,mode,customer_name,customer_phone,station_id,station_name_snapshot,started_at,ended_at,closed_bill_id,close_disposition,close_reason,play_mode,ltp_eligible,ltp_outcome,ltp_discount_applied,raw_data").eq("organization_id", organizationId).eq("customer_name", recovery.customerName)),
  query("bills", supabase.from("bills").select("id,bill_number,status,payment_mode,subtotal,total_discount_amount,bill_discount_amount,round_off_enabled,round_off_amount,total,amount_paid,amount_due,issued_by_user_id,session_id,raw_data").eq("organization_id", organizationId).eq("customer_name", recovery.customerName)),
  billIds.length ? query("bill lines", supabase.from("bill_lines").select("id,bill_id,type,description,quantity,unit_price,subtotal,discount_amount,total,linked_session_id,inventory_item_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("payments", supabase.from("payments").select("id,bill_id,mode,amount,received_by_user_id,settlement_group_id,related_checkout_bill_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("line discounts", supabase.from("bill_line_discounts").select("id,bill_id,target_id,discount_type,value,amount,reason,applied_by_user_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("bill discounts", supabase.from("bill_discounts").select("id,bill_id,discount_type,value,amount,reason,applied_by_user_id").eq("organization_id", organizationId).in("bill_id", billIds)) : [],
  billIds.length ? query("stock movements", supabase.from("stock_movements").select("id,item_id,type,quantity,reason,user_id,related_bill_id").eq("organization_id", organizationId).in("related_bill_id", billIds)) : [],
  sourceEventIds.length ? query("source events", supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("id", sourceEventIds)) : [],
  sourceAuditIds.length ? query("source audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("id", sourceAuditIds)) : [],
  cleanupEventIds.length ? query("cleanup events", supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("id", cleanupEventIds)) : [],
  cleanupAuditIds.length ? query("cleanup audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("id", cleanupAuditIds)) : [],
  allMutationIds.length ? query("run events", supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata").eq("organization_id", organizationId).in("metadata->>mutation_id", allMutationIds)) : [],
  runEntityIds.length ? query("run audits", supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("action", runAuditActions).in("entity_id", runEntityIds)) : [],
  sourceSessionIds.length ? query("session items", supabase.from("session_items").select("id,session_id,inventory_item_id,name,quantity,unit_price").eq("organization_id", organizationId).in("session_id", sourceSessionIds)) : [],
  recovery.snapshot.item?.id ? query("item movements", supabase.from("stock_movements").select("id,item_id,type,quantity,related_bill_id").eq("organization_id", organizationId).eq("item_id", recovery.snapshot.item.id)) : [],
  recovery.snapshot.item?.id ? query("item", supabase.from("inventory_items").select("id,name,category,price,stock_qty,low_stock_threshold,active,is_reusable,barcode,sell_base_item,archived_at,archived_by_user_id,archive_reason").eq("organization_id", organizationId).eq("id", recovery.snapshot.item.id)) : [],
  query("open sessions", supabase.from("sessions").select("id").eq("organization_id", organizationId).neq("status", "closed")),
  query("open tabs", supabase.from("customer_tabs").select("id").eq("organization_id", organizationId).eq("status", "open")),
  query("app state", supabase.from("app_state").select("version,data").eq("id", "primary").single())
]);

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
check(sameRows(bills, recovery.snapshot.bills), "Source bills changed during cleanup.");
check(sameRows(lines, recovery.snapshot.lines), "Source bill lines changed during cleanup.");
check(sameRows(payments, recovery.snapshot.payments), "Source payments changed during cleanup.");
check(sameRows(lineDiscounts, recovery.snapshot.lineDiscounts), "Source line discounts changed during cleanup.");
check(sameRows(billDiscounts, recovery.snapshot.billDiscounts), "Source bill discounts changed during cleanup.");
check(sameRows(movements, recovery.snapshot.movements), "Source financial stock movements changed during cleanup.");
check(sameRows(sourceEvents, recovery.snapshot.runEvents), "A source lifecycle/financial event changed during cleanup.");
check(sameRows(sourceAuditRows, sourceAudits), "A source lifecycle/financial audit changed during cleanup.");
check(sameRows(sessionItems, recovery.snapshot.sessionItems), "Source session items changed during cleanup.");
check(sameRows(itemMovements, recovery.snapshot.itemMovements), "Source item movements changed during cleanup.");

for (const expected of recovery.snapshot.sessions) {
  const actual = sessions.find((row) => row.id === expected.id);
  if (sessionCandidate?.id === expected.id) {
    check(actual?.status === "closed" && actual?.close_disposition === "rejected" && actual?.closed_bill_id === null && actual?.close_reason === terminal.value.reason && actual?.customer_name === expected.customer_name && actual?.customer_phone === expected.customer_phone && actual?.station_id === expected.station_id && actual?.station_name_snapshot === expected.station_name_snapshot && Date.parse(actual?.started_at) === Date.parse(expected.started_at) && Date.parse(actual?.ended_at) === Date.parse(rejectCommand?.payload?.session?.endedAt) && actual?.play_mode === expected.play_mode && actual?.ltp_eligible === expected.ltp_eligible && actual?.ltp_outcome === expected.ltp_outcome && actual?.ltp_discount_applied === expected.ltp_discount_applied, `Session ${expected.id} was not rejected with exact preserved source fields and command-bound end time.`);
  } else check(JSON.stringify(stable(actual)) === JSON.stringify(stable(expected)), `Non-cleanup session ${expected.id} changed.`);
}
check(sessions.length === recovery.snapshot.sessions.length, "Source session cardinality changed during cleanup.");

if (itemCandidate) {
  const expected = recovery.snapshot.item;
  const actual = itemRows[0];
  check(itemRows.length === 1 && actual?.id === expected.id && actual?.name === expected.name && actual?.category === expected.category && Number(actual?.price) === Number(expected.price) && Number(actual?.stock_qty) === Number(expected.stock_qty) && Number(actual?.low_stock_threshold) === Number(expected.low_stock_threshold) && actual?.is_reusable === expected.is_reusable && actual?.barcode === expected.barcode && actual?.sell_base_item === expected.sell_base_item && actual?.active === false && actual?.archived_by_user_id === actorId && actual?.archive_reason === terminal.value.reason && Boolean(actual?.archived_at), "Exact zero-price item was not archived with preserved fields and exact actor/reason.");
}

function verifyReject() {
  if (!sessionCandidate) return;
  const result = rejectResult;
  const command = rejectCommand;
  const auditCommand = command?.payload?.auditLog;
  const event = cleanupEvents.find((row) => row.id === result?.event_id);
  const audit = cleanupAudits.find((row) => row.id === auditCommand?.id);
  const changedRowsWithoutEvent = Object.fromEntries(Object.entries(result?.changed_rows ?? {}).filter(([key]) => key !== "operational_events"));
  check(rejectResponse.value.response.status === 200 && command?.organization_id === organizationId && command?.mutation_kind === "rejectSession" && command?.entity_id === sessionCandidate.id && command?.payload?.session?.id === sessionCandidate.id && command?.payload?.session?.closeReason === terminal.value.reason, "Reject-session command/HTTP acknowledgement is not exact.");
  check(result?.mutation_id === command?.mutation_id && result?.entity_type === "session" && result?.entity_id === sessionCandidate.id && sameIds(result?.changed_rows?.sessions, [sessionCandidate.id]) && sameIds(result?.changed_rows?.audit_logs, [auditCommand?.id]) && sameIds(result?.changed_rows?.operational_events, [result?.event_id]), "Reject-session response changed-row lineage is not exact.");
  check(event?.event_type === "reject_session" && event?.entity_type === "session" && event?.entity_id === sessionCandidate.id && event?.created_by === actorId && event?.metadata?.mutation_id === command?.mutation_id && event?.metadata?.mutation_kind === "rejectSession" && Number(event?.metadata?.app_state_version) === Number(result?.app_state_version) && JSON.stringify(stable(event?.metadata?.changed_rows)) === JSON.stringify(stable(changedRowsWithoutEvent)), "Reject-session event identity/actor/version/changed_rows is not exact.");
  check(audit?.action === "session_rejected" && audit?.entity_type === "session" && audit?.entity_id === sessionCandidate.id && audit?.user_id === actorId && audit?.message === `Rejected ${sessionCandidate.stationName}. Reason: ${terminal.value.reason}` && audit?.message === auditCommand?.message, "Reject-session audit identity/actor/canonical message is not exact.");
}

function verifyArchive() {
  if (!itemCandidate) return;
  const result = archiveResult;
  const command = archiveCommand;
  const expectedItem = command?.payload?.inventoryItems?.find((row) => row.id === itemCandidate.id);
  const auditCommand = command?.payload?.auditLogs?.find((row) => row.action === "inventory_archived" && row.entityId === itemCandidate.id);
  const event = cleanupEvents.find((row) => row.id === result?.event_id);
  const audit = cleanupAudits.find((row) => row.id === auditCommand?.id);
  check(archiveResponse.value.response.status === 200 && command?.organization_id === organizationId && command?.mutation_kind === "commitAdminDataChange" && command?.user_id === actorId && expectedItem?.active === false && expectedItem?.archiveReason === terminal.value.reason && expectedItem?.archivedByUserId === actorId, "Archive command/HTTP acknowledgement is not exact.");
  check(result?.mutation_id === command?.mutation_id && result?.entity_type === "admin_data" && result?.entity_id === command?.entity_id && sameIds(result?.changed_rows?.inventory_items, [itemCandidate.id]) && sameIds(result?.changed_rows?.sale_variants, [itemCandidate.id]) && sameIds(result?.changed_rows?.audit_logs, [auditCommand?.id]) && (result?.changed_rows?.stock_movements ?? []).length === 0, "Archive response changed-row lineage is not exact.");
  check(event?.event_type === "admin_data_committed" && event?.entity_type === "admin_data" && event?.entity_id === command?.entity_id && event?.created_by === actorId && event?.metadata?.mutation_id === command?.mutation_id && event?.metadata?.mutation_kind === "commitAdminDataChange" && Number(event?.metadata?.app_state_version) === Number(result?.app_state_version) && JSON.stringify(stable(event?.metadata?.changed_rows)) === JSON.stringify(stable(result?.changed_rows)), "Archive event identity/actor/version/changed_rows is not exact.");
  check(audit?.action === "inventory_archived" && audit?.entity_type === "inventory_item" && audit?.entity_id === itemCandidate.id && audit?.user_id === actorId && audit?.message === `Archived ${itemCandidate.name}. Reason: ${terminal.value.reason}.` && audit?.message === auditCommand?.message, "Archive audit identity/actor/canonical message is not exact.");
}
verifyReject();
verifyArchive();

const expectedEventIds = [...sourceEventIds, ...cleanupEventIds];
const expectedAuditIds = [...sourceAuditIds, ...cleanupAuditIds];
check(sameIds(runEvents.map((row) => row.id), expectedEventIds), "The run contains an extra or missing source/cleanup event.");
check(sameIds(runAudits.map((row) => row.id), expectedAuditIds), "The run contains an extra or missing source/cleanup audit.");
check(openSessions.length === 0 && openTabs.length === 0, "The staging floor is not empty after cleanup.");
const appStateIdentity = { version: appState.version, hash: hash(JSON.stringify(appState.data)) };
check(Number(appState.version) === Number(recovery.appState.version) + expectedEffects, "Compatibility version did not advance exactly once per acknowledged cleanup command.");
check(Number(appState.version) === Number(terminal.value.finalState.version) && appStateIdentity.hash === terminal.value.finalState.hash, "Postflight app_state version/hash differs from browser-confirmed terminal state.");

const originalPostflightPath = path.join(evidenceDirectory, `checkout-pricing-zero-cleanup-postflight-${selectedCase}-${sourceRunId}-${cleanupRunId}.json`);
let reanalysisOf = null;
if (reanalysis) {
  if (!fs.existsSync(originalPostflightPath)) throw new Error("Cleanup postflight reanalysis requires the immutable original postflight.");
  const raw = fs.readFileSync(originalPostflightPath);
  const value = JSON.parse(raw.toString("utf8"));
  if (value.status !== "blocked" || value.cleanupRunId !== cleanupRunId || value.sourceRunId !== sourceRunId || value.productionAllowed !== false) throw new Error("Original cleanup postflight is not eligible for reanalysis.");
  reanalysisOf = { path: path.relative(root, originalPostflightPath), sha256: hash(raw) };
}
const report = {
  cleanupRunId, sourceRunId, selectedCase, generatedAt: new Date().toISOString(), projectRef: STAGING_PROJECT_REF,
  productionAllowed: false, safeForAutomaticRetry: false, status: failures.length ? "blocked" : "passed", failures,
  recoveryArtifact: path.relative(root, recoveryPath), recoverySha256: env.E2E_PRICING_RECOVERY_SHA256,
  cleanupEvidence: Object.fromEntries([cleanupPrepared, rejectPrepared, rejectResponse, archivePrepared, archiveResponse, terminal].filter(Boolean).map((entry) => [path.basename(entry.path), hash(entry.raw)])),
  actorId, expectedEffects, reanalysisOf,
  snapshot: { sessions, bills, lines, payments, lineDiscounts, billDiscounts, movements, sourceEvents, sourceAudits: sourceAuditRows, cleanupEvents, cleanupAudits, runEvents, runAudits, sessionItems, itemMovements, item: itemRows[0] ?? null, openSessions, openTabs, appState: appStateIdentity }
};
const serialized = JSON.stringify(report, null, 2);
if (/"(?:authorization|apikey|password|access_token|refresh_token)"\s*:/i.test(serialized) || /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(serialized)) throw new Error("Refusing to persist sensitive pricing cleanup evidence.");
const target = path.join(evidenceDirectory, `checkout-pricing-zero-cleanup-${reanalysis ? "postflight-reanalysis" : "postflight"}-${selectedCase}-${sourceRunId}-${cleanupRunId}.json`);
const temporary = `${target}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${serialized}\n`, { encoding: "utf8", flag: "wx" });
try { fs.linkSync(temporary, target); } finally { fs.unlinkSync(temporary); }
console.log(JSON.stringify({ status: report.status, artifact: path.relative(root, target), sha256: hash(`${serialized}\n`), failures }, null, 2));
if (failures.length) process.exitCode = 2;
