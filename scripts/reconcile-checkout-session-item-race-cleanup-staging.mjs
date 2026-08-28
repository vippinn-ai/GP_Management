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
const cleanupRunId = sanitizeRunId(env.E2E_RUN_ID);
const recoveryRequested = env.E2E_SESSION_ITEM_RACE_RECOVERY_ARTIFACT?.trim();
if (!recoveryRequested) throw new Error("E2E_SESSION_ITEM_RACE_RECOVERY_ARTIFACT is required.");
const recoveryPath = path.resolve(root, recoveryRequested);
const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
if (recovery.projectRef !== STAGING_PROJECT_REF || recovery.productionAllowed !== false || recovery.safeForIdentityBoundCleanup !== true) {
  throw new Error("The recovery artifact is not authorized for staging cleanup postflight.");
}
const fixtureRunId = sanitizeRunId(recovery.runId);
if (fixtureRunId === cleanupRunId) throw new Error("Cleanup and fixture run identities must differ.");
const finalPath = path.join(root, "test-artifacts", "evidence", `checkout-session-item-race-cleanup-final-${cleanupRunId}.json`);
if (!fs.existsSync(finalPath)) throw new Error("The exact cleanup final checkpoint is missing.");
const finalEvidence = JSON.parse(fs.readFileSync(finalPath, "utf8"));
if (finalEvidence.cleanupRunId !== cleanupRunId || finalEvidence.fixtureRunId !== fixtureRunId || finalEvidence.recoveryArtifact !== recoveryRequested) {
  throw new Error("Cleanup final evidence is not bound to the exact cleanup and recovery identities.");
}

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Cleanup postflight is locked to the exact staging project.");
}
const client = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const lookup = await client.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve staging credential slot A.");
const login = await client.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate staging credential slot A.");
const [role, profile] = await Promise.all([
  client.rpc("current_user_org_role", { target_organization_id: organizationId }),
  client.from("profiles").select("id,role,active").eq("id", login.data.user.id).single()
]);
if (role.error || role.data !== "admin" || profile.error || profile.data?.role !== "admin" || !profile.data.active ||
    login.data.user.id !== recovery.actors.checkout) {
  throw new Error("Cleanup postflight actor does not match the authorized origin actor.");
}

async function query(label, promise) {
  const result = await promise;
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  return result.data;
}
function stable(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((entry) => JSON.parse(stable(entry))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  if (value && typeof value === "object") return JSON.stringify(Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, JSON.parse(stable(entry))])));
  return JSON.stringify(value);
}
function changedIds(result, collection) {
  const values = result?.changed_rows?.[collection];
  return Array.isArray(values) ? values : [];
}

const sessionIds = recovery.acknowledgedSessionIds;
const billIds = recovery.snapshot.bills.map((row) => row.id);
const eventEntityIds = [...sessionIds, recovery.fixture.itemId].filter(Boolean);
const auditEntityIds = [...eventEntityIds, ...billIds];
const acknowledgements = finalEvidence.acknowledgements ?? [];
const knownEventIds = [...new Set([
  ...recovery.snapshot.events.map((row) => row.id),
  ...acknowledgements.flatMap((entry) => [
    ...(entry.result?.event_id ? [entry.result.event_id] : []),
    ...changedIds(entry.result, "operational_events")
  ])
])];
const [items, sessions, bills, openSessions, openTabs, lines, payments, sessionItems, movements, events, audits, state, mutationResults] = await Promise.all([
  recovery.fixture.itemId ? query("fixture item", client.from("inventory_items")
    .select("id,name,stock_qty,active,archived_by_user_id,archive_reason")
    .eq("organization_id", organizationId).eq("id", recovery.fixture.itemId)) : Promise.resolve([]),
  sessionIds.length ? query("run sessions", client.from("sessions").select("id,customer_name,status,close_disposition,closed_bill_id")
    .eq("organization_id", organizationId).in("id", sessionIds)) : Promise.resolve([]),
  billIds.length ? query("run bills", client.from("bills")
    .select("id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id")
    .eq("organization_id", organizationId).in("id", billIds)) : Promise.resolve([]),
  query("open sessions", client.from("sessions").select("id,customer_name,status")
    .eq("organization_id", organizationId).neq("status", "closed")),
  query("open tabs", client.from("customer_tabs").select("id,customer_name,status")
    .eq("organization_id", organizationId).eq("status", "open")),
  billIds.length ? query("bill lines", client.from("bill_lines")
    .select("id,bill_id,type,inventory_item_id,quantity,unit_price,total,linked_session_id,raw_data")
    .eq("organization_id", organizationId).in("bill_id", billIds)) : Promise.resolve([]),
  billIds.length ? query("payments", client.from("payments")
    .select("id,bill_id,amount,mode,received_by_user_id")
    .eq("organization_id", organizationId).in("bill_id", billIds)) : Promise.resolve([]),
  sessionIds.length ? query("session items", client.from("session_items")
    .select("id,session_id,inventory_item_id,name,quantity,unit_price,raw_data")
    .eq("organization_id", organizationId).in("session_id", sessionIds)) : Promise.resolve([]),
  recovery.fixture.itemId ? query("item movements", client.from("stock_movements")
    .select("id,item_id,type,quantity,user_id,related_bill_id")
    .eq("organization_id", organizationId).eq("item_id", recovery.fixture.itemId)) : Promise.resolve([]),
  eventEntityIds.length ? query("events", client.from("operational_events")
    .select("id,event_type,entity_type,entity_id,created_by,metadata")
    .eq("organization_id", organizationId).in("entity_id", eventEntityIds)) : Promise.resolve([]),
  auditEntityIds.length ? query("audits", client.from("audit_logs")
    .select("id,action,entity_type,entity_id,user_id,message")
    .eq("organization_id", organizationId).in("entity_id", auditEntityIds)) : Promise.resolve([]),
  query("app state", client.from("app_state").select("version,data").eq("id", "primary").single()),
  Promise.all(recovery.scenarioClassifications.filter((entry) => entry.checkoutMutationId).map(async (entry) => ({
    mutationId: entry.checkoutMutationId,
    result: await query(`${entry.scenario} mutation`, client.rpc("get_financial_mutation_result", {
      payload: {
        organization_id: organizationId,
        mutation_id: entry.checkoutMutationId,
        mutation_kind: "commitCheckoutBill"
      }
    }))
  })))
]);
if (knownEventIds.length) {
  const exactEvents = await query("exact acknowledged and prior events", client.from("operational_events")
    .select("id,event_type,entity_type,entity_id,created_by,metadata")
    .eq("organization_id", organizationId).in("id", knownEventIds));
  for (const event of exactEvents) {
    if (!events.some((existing) => existing.id === event.id)) events.push(event);
  }
}

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
check(recovery.snapshot.item.length === 0 ? items.length === 0 :
  items.length === 1 && items[0].id === recovery.fixture.itemId && items[0].name === recovery.fixture.itemName &&
    Number(items[0].stock_qty) === Number(recovery.snapshot.item[0]?.stock_qty) && items[0].active === false &&
    items[0].archived_by_user_id === recovery.actors.checkout,
"Cleanup did not preserve or archive the exact fixture at unchanged physical stock.");
check(sessions.length === recovery.snapshot.sessions.length, "Cleanup changed exact run-session cardinality.");
const rejectedSessionIds = new Set(recovery.actions.rejectSessions.map((entry) => entry.id));
for (const beforeSession of recovery.snapshot.sessions) {
  const afterSession = sessions.find((row) => row.id === beforeSession.id);
  if (rejectedSessionIds.has(beforeSession.id)) {
    check(afterSession?.customer_name === beforeSession.customer_name && afterSession?.status === "closed" &&
      afterSession?.close_disposition === "rejected" && afterSession?.closed_bill_id === null,
    `Cleanup did not transition authorized session ${beforeSession.id} to exact closed/rejected/null-bill state.`);
  } else {
    check(stable(afterSession) === stable(beforeSession),
      `Cleanup changed pre-existing closed session ${beforeSession.id} disposition, bill link, or identity.`);
  }
}
check(stable(sessions) === stable(finalEvidence.final?.sessions), "Cleanup final session evidence changed.");
check(openSessions.length === 0 && openTabs.length === 0, "Cleanup did not restore an empty staging floor.");
check(stable(bills) === stable(recovery.snapshot.bills), "Cleanup changed committed bills.");
check(stable(bills) === stable(finalEvidence.final?.bills), "Cleanup final bill evidence changed.");
check(stable(lines) === stable(recovery.snapshot.lines), "Cleanup changed committed bill lines.");
check(stable(payments) === stable(recovery.snapshot.payments), "Cleanup changed committed payments.");
check(stable(sessionItems) === stable(recovery.snapshot.sessionItems), "Cleanup changed reservation source rows.");
check(stable(movements) === stable(recovery.snapshot.movements), "Cleanup created or changed stock movements.");
check(stable(events) === stable(finalEvidence.final?.events), "Cleanup final event evidence changed.");
check(stable(audits) === stable(finalEvidence.final?.audits), "Cleanup final audit evidence changed.");
check(stable(mutationResults) === stable(finalEvidence.final?.mutationResults), "Cleanup changed canonical financial mutations.");
const priorEventIds = new Set(recovery.snapshot.events.map((row) => row.id));
const priorAuditIds = new Set(recovery.snapshot.audits.map((row) => row.id));
check(stable(events.filter((row) => priorEventIds.has(row.id))) === stable(recovery.snapshot.events),
  "Cleanup changed prior operational events.");
check(stable(audits.filter((row) => priorAuditIds.has(row.id))) === stable(recovery.snapshot.audits),
  "Cleanup changed prior audit rows.");
const expectedWrites = recovery.actions.rejectSessions.length + (recovery.actions.archiveItem ? 1 : 0);
check(acknowledgements.length === expectedWrites, "Cleanup acknowledgement count is not exact.");
check(state.version === recovery.snapshot.appState.version + expectedWrites,
  "Compatibility version did not advance exactly once per acknowledged cleanup command.");
check(finalEvidence.final?.appState?.version === state.version && finalEvidence.final?.appState?.hash ===
  createHash("sha256").update(JSON.stringify(state.data)).digest("hex"),
"Cleanup final compatibility evidence changed.");

for (const acknowledgement of acknowledgements.filter((entry) => entry.type === "reject_session")) {
  const auditIds = changedIds(acknowledgement.result, "audit_logs");
  const eventIds = changedIds(acknowledgement.result, "operational_events");
  const [auditRows, eventRows] = await Promise.all([
    query("cleanup audit", client.from("audit_logs").select("id,action,entity_type,entity_id,user_id,message")
      .eq("organization_id", organizationId).in("id", auditIds)),
    query("cleanup event", client.from("operational_events").select("id,event_type,entity_id,created_by,metadata")
      .eq("organization_id", organizationId).in("id", eventIds))
  ]);
  check(auditRows.length === 1 && auditRows[0].action === "session_rejected" &&
    auditRows[0].entity_type === "session" && auditRows[0].entity_id === acknowledgement.action.id &&
    auditRows[0].user_id === recovery.actors.checkout &&
    auditRows[0].message === `Rejected ${recovery.fixture.stationName}. Reason: ${acknowledgement.reason}`,
  "Cleanup audit identity/type/message/actor is incorrect.");
  check(eventRows.length === 1 && eventRows[0].event_type === "reject_session" &&
    eventRows[0].entity_id === acknowledgement.action.id && eventRows[0].created_by === recovery.actors.checkout &&
    eventRows[0].metadata?.mutation_id === acknowledgement.result.mutation_id,
  "Cleanup event identity/type/actor/mutation is incorrect.");
}

const archiveAcknowledgement = acknowledgements.find((entry) => entry.type === "archive_item");
if (archiveAcknowledgement) {
  const result = archiveAcknowledgement.result;
  const archiveAuditIds = changedIds(result, "audit_logs");
  const archiveEvent = events.find((row) => row.id === result.event_id);
  const archiveAudits = audits.filter((row) => archiveAuditIds.includes(row.id));
  check(items[0]?.archive_reason === archiveAcknowledgement.reason,
    "Archive reason changed on the normalized fixture row.");
  check(archiveEvent?.event_type === "admin_data_committed" && archiveEvent?.entity_type === result.entity_type &&
    archiveEvent?.entity_id === result.entity_id && archiveEvent?.created_by === recovery.actors.checkout &&
    stable(archiveEvent?.metadata?.changed_rows) === stable(result.changed_rows),
  "Archive event identity/type/actor/changed_rows is incorrect.");
  check(archiveAudits.length === 1 && archiveAudits[0].action === "inventory_archived" &&
    archiveAudits[0].entity_type === "inventory_item" && archiveAudits[0].entity_id === recovery.fixture.itemId &&
    archiveAudits[0].user_id === recovery.actors.checkout &&
    archiveAudits[0].message === `Archived ${recovery.fixture.itemName}. Reason: ${archiveAcknowledgement.reason}.`,
  "Archive audit identity/type/message/actor is incorrect.");
}
const acknowledgedEventIds = acknowledgements.flatMap((entry) => [
  ...(entry.result?.event_id ? [entry.result.event_id] : []),
  ...changedIds(entry.result, "operational_events")
]);
const acknowledgedAuditIds = acknowledgements.flatMap((entry) => changedIds(entry.result, "audit_logs"));
check(stable(events.filter((row) => !priorEventIds.has(row.id)).map((row) => row.id).sort()) ===
  stable([...new Set(acknowledgedEventIds)].sort()), "Cleanup created an unacknowledged event or missed an acknowledged event.");
check(stable(audits.filter((row) => !priorAuditIds.has(row.id)).map((row) => row.id).sort()) ===
  stable([...new Set(acknowledgedAuditIds)].sort()), "Cleanup created an unacknowledged audit or missed an acknowledged audit.");

const postflight = {
  status: failures.length ? "failed" : "passed",
  cleanupRunId,
  fixtureRunId,
  checkedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  productionAllowed: false,
  recoveryArtifact: path.relative(root, recoveryPath),
  cleanupEvidence: path.relative(root, finalPath),
  acknowledgements,
  fixture: items[0] ?? null,
  sessions,
  bills,
  events,
  audits,
  mutationResults,
  emptyFloor: { sessions: openSessions, tabs: openTabs },
  appState: { version: state.version, hash: createHash("sha256").update(JSON.stringify(state.data)).digest("hex") },
  failures
};
const outputDirectory = path.join(root, "test-artifacts", "reconciliation");
fs.mkdirSync(outputDirectory, { recursive: true });
const baseOutputPath = path.join(outputDirectory, `checkout-session-item-race-cleanup-postflight-${cleanupRunId}.json`);
const postflightId = env.E2E_POSTFLIGHT_ID?.trim();
if (fs.existsSync(baseOutputPath) && !postflightId) {
  throw new Error("E2E_POSTFLIGHT_ID is required to preserve the prior immutable cleanup postflight artifact.");
}
const outputPath = fs.existsSync(baseOutputPath)
  ? path.join(outputDirectory, `checkout-session-item-race-cleanup-postflight-${cleanupRunId}-${sanitizeRunId(postflightId)}.json`)
  : baseOutputPath;
fs.writeFileSync(outputPath, `${JSON.stringify(postflight, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
if (failures.length) {
  console.error(JSON.stringify({ ...postflight, artifact: path.relative(root, outputPath) }, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({ ...postflight, artifact: path.relative(root, outputPath) }, null, 2));
}
