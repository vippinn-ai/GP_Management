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
if (!env.E2E_REPEAT_COMBO_RECOVERY_RUN_ID?.trim()) throw new Error("E2E_REPEAT_COMBO_RECOVERY_RUN_ID is required.");
const runId = sanitizeRunId(env.E2E_REPEAT_COMBO_RECOVERY_RUN_ID);
const scenario = env.E2E_REPEAT_COMBO_RECOVERY_SCENARIO?.trim() || "checkout_first";
if (!["checkout_first", "combo_first", "simultaneous"].includes(scenario)) {
  throw new Error("E2E_REPEAT_COMBO_RECOVERY_SCENARIO must be checkout_first, combo_first, or simultaneous.");
}
const organizationId = "org-primary";
const customerName = `QA Combo Race ${runId} ${scenario}`;
const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-repeat-combo-race-preflight-${runId}.json`);
const scenarioPath = path.join(root, "test-artifacts", "reconciliation", `checkout-repeat-combo-race-${runId}-${scenario}.json`);
const outputPath = path.join(root, "test-artifacts", "reconciliation", `checkout-repeat-combo-race-recovery-v2-${runId}.json`);
if (!fs.existsSync(preflightPath)) throw new Error("Exact combo-race preflight is missing.");
if (!fs.existsSync(scenarioPath)) throw new Error("Exact combo-race scenario evidence is missing.");
if (fs.existsSync(outputPath)) throw new Error("Exact combo-race recovery artifact already exists; refusing overwrite.");
const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
const scenarioEvidence = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
if (!preflight.safeToRun || preflight.runId !== runId || preflight.projectRef !== STAGING_PROJECT_REF) {
  throw new Error("Exact combo-race preflight is invalid.");
}
if (scenarioEvidence.runId !== runId || scenarioEvidence.scenario !== scenario || !scenarioEvidence.sessionId) {
  throw new Error("Exact combo-race scenario identity is invalid.");
}

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const anonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !anonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Recovery diagnostic is locked to staging.");
}
const supabase = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const lookup = await supabase.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve recovery account.");
const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate recovery account.");
const role = await supabase.rpc("current_user_org_role", { target_organization_id: organizationId });
if (role.error || role.data !== "admin") throw new Error("Recovery diagnostic requires an authoritative staging admin.");

const required = (result, label) => {
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  return result.data ?? [];
};
const hash = (data) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const idsFromEvents = (events, collection) => [...new Set(events.flatMap((event) => {
  const changedValues = event.metadata?.changed_rows?.[collection];
  const directValues = event.metadata?.[`${collection.replace(/s$/, "")}_ids`] ?? event.metadata?.[`${collection}_ids`];
  return [
    ...(Array.isArray(changedValues) ? changedValues : []),
    ...(Array.isArray(directValues) ? directValues : [])
  ].map(String);
}))];

const [sessionsResult, openSessionsResult, openTabsResult, appStateResult, inventoryResult, checkoutMutationResult] = await Promise.all([
  supabase.from("sessions").select("id,status,close_disposition,closed_bill_id,customer_name,station_name_snapshot,started_at,created_at").eq("organization_id", organizationId).eq("customer_name", customerName),
  supabase.from("sessions").select("id,status,customer_name").eq("organization_id", organizationId).neq("status", "closed"),
  supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single(),
  supabase.from("inventory_items").select("id,stock_qty").eq("organization_id", organizationId).in("id", preflight.fixture.stockEvidence.map((entry) => entry.itemId)),
  supabase.rpc("get_financial_mutation_result", {
    payload: {
      organization_id: organizationId,
      mutation_id: scenarioEvidence.checkoutMutationId,
      mutation_kind: "commitCheckoutBill"
    }
  })
]);
const sessions = required(sessionsResult, "sessions");
const openSessions = required(openSessionsResult, "open sessions");
const openTabs = required(openTabsResult, "open tabs");
const inventory = required(inventoryResult, "inventory");
if (checkoutMutationResult.error) throw new Error(`checkout mutation status query failed: ${checkoutMutationResult.error.message}`);
const checkoutMutationStatus = checkoutMutationResult.data;
if (appStateResult.error) throw new Error(`app_state query failed: ${appStateResult.error.message}`);
if (sessions.length !== 1) throw new Error(`Expected exactly one recovery session, found ${sessions.length}.`);
const session = sessions[0];

const [eventsResult, combosResult, itemsResult, linesResult, auditsResult, runBillsResult] = await Promise.all([
  supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,created_at,metadata").eq("organization_id", organizationId).eq("entity_id", session.id).gte("created_at", preflight.checkedAt).order("created_at"),
  supabase.from("session_combo_applications").select("id,session_id,combo_id,combo_name,price,included_minutes,applied_at,created_at").eq("organization_id", organizationId).eq("session_id", session.id).order("created_at"),
  supabase.from("session_items").select("id,session_id,inventory_item_id,name,quantity,unit_price,combo_application_id,combo_id,created_at").eq("organization_id", organizationId).eq("session_id", session.id).order("created_at"),
  supabase.from("bill_lines").select("id,bill_id,type,linked_session_id,inventory_item_id,total,raw_data").eq("organization_id", organizationId).eq("linked_session_id", session.id),
  supabase.from("audit_logs").select("id,action,entity_type,entity_id,message,audit_at,user_id,created_at").eq("organization_id", organizationId).eq("entity_id", session.id).gte("created_at", preflight.checkedAt).order("created_at"),
  supabase.from("bills").select("id,bill_number,status,total,amount_paid,amount_due").eq("organization_id", organizationId).in("bill_number", ["checkout_first", "combo_first", "simultaneous"].map((scenario) => `BILL-QA-COMBO-RACE-${runId}-${scenario}`))
]);
const events = required(eventsResult, "events");
const combos = required(combosResult, "session combos");
const items = required(itemsResult, "session items");
const billLines = required(linesResult, "bill lines");
const audits = required(auditsResult, "audits");
const runBills = required(runBillsResult, "run bills");
const movementIds = idsFromEvents(events, "stock_movements");
const movements = movementIds.length === 0 ? [] : required(
  await supabase.from("stock_movements").select("id,item_id,type,quantity,reason,user_id,related_bill_id,created_at").eq("organization_id", organizationId).in("id", movementIds),
  "stock movements"
);
const eventTypes = events.map((event) => event.event_type);
const raceEventTypes = eventTypes.filter((type) => type === "repeat_session_combo" || type === "financial_checkout_committed_v2");
const appState = { version: appStateResult.data.version, hash: hash(appStateResult.data.data) };
const inventoryUnchanged = scenarioEvidence.inventoryBefore.every((before) => {
  const current = inventory.find((entry) => entry.id === before.id);
  return current && Number(current.stock_qty) === Number(before.stock_qty);
});
const onlyExactSessionOpen = openSessions.length === 1 && openSessions[0].id === session.id && openTabs.length === 0;
const movementIdsMatch = movementIds.length > 0 && movementIds.every((id) => movements.some((movement) => movement.id === id)) && movements.length === movementIds.length;
const reservationsAreExact = movements.every((movement) =>
  movement.type === "session_reservation" &&
  Number(movement.quantity) < 0 &&
  movement.user_id === login.data.user.id &&
  movement.related_bill_id === null
);
const comboWon = scenarioEvidence.responses?.combo?.status === 200 && scenarioEvidence.responses?.checkout?.status === 400;
const expectedEventTypes = comboWon
  ? ["start_session", "save_live_session_details", "repeat_session_combo"]
  : ["start_session", "save_live_session_details"];
const expectedAuditActions = comboWon
  ? ["session_started", "session_details_updated", "combo_repeated"]
  : ["session_started", "session_details_updated"];
const setupEventsAreExact = JSON.stringify(eventTypes) === JSON.stringify(expectedEventTypes);
const setupAuditsAreExact = JSON.stringify(audits.map((audit) => audit.action)) === JSON.stringify(expectedAuditActions) &&
  audits.every((audit) => audit.user_id === login.data.user.id);
const comboSnapshotIdsAreExact = comboWon
  ? new Set(combos.map((entry) => entry.id)).size === 2 &&
    combos.some((entry) => entry.id === scenarioEvidence.initialComboApplicationIds[0]) &&
    combos.some((entry) => entry.id === scenarioEvidence.repeatedComboApplicationId) &&
    new Set(items.map((entry) => entry.id)).size === scenarioEvidence.initialItemIds.length + scenarioEvidence.repeatedItemIds.length &&
    [...scenarioEvidence.initialItemIds, ...scenarioEvidence.repeatedItemIds].every((id) => items.some((entry) => entry.id === id))
  : combos.length === 1 && items.length === scenarioEvidence.initialItemIds.length;
const repeatedCombo = combos.find((entry) => entry.id === scenarioEvidence.repeatedComboApplicationId);
const repeatedItemIds = new Set(scenarioEvidence.repeatedItemIds);
const repeatedItems = items.filter((entry) => repeatedItemIds.has(entry.id));
const repeatedMovements = movements.filter((entry) => scenarioEvidence.repeatedStockMovementIds.includes(entry.id));
const expectedRepeated = scenarioEvidence.expectedOperational;
const snapshotEvidenceIsExact = !comboWon || Boolean(
  repeatedCombo &&
  repeatedCombo.combo_id === expectedRepeated.comboApplication.comboId &&
  repeatedCombo.combo_name === expectedRepeated.comboApplication.comboName &&
  Number(repeatedCombo.price) === Number(expectedRepeated.comboApplication.price) &&
  Number(repeatedCombo.included_minutes) === Number(expectedRepeated.comboApplication.includedMinutes) &&
  repeatedItems.length === expectedRepeated.items.length &&
  expectedRepeated.items.every((expected) => repeatedItems.some((entry) =>
    entry.id === expected.id &&
    entry.inventory_item_id === expected.inventoryItemId &&
    entry.name === expected.name &&
    Number(entry.quantity) === Number(expected.quantity) &&
    Number(entry.unit_price) === Number(expected.unitPrice) &&
    entry.combo_application_id === expected.comboApplicationId &&
    entry.combo_id === expected.comboId
  )) &&
  repeatedMovements.length === expectedRepeated.stockMovements.length &&
  expectedRepeated.stockMovements.every((expected) => repeatedMovements.some((entry) =>
    entry.id === expected.id &&
    entry.item_id === expected.itemId &&
    entry.type === expected.type &&
    Number(entry.quantity) === Number(expected.quantity) &&
    entry.reason === expected.reason &&
    entry.user_id === expected.userId &&
    entry.related_bill_id === null
  )) &&
  audits.some((entry) =>
    entry.id === expectedRepeated.auditLog.id &&
    entry.action === expectedRepeated.auditLog.action &&
    entry.entity_id === expectedRepeated.auditLog.entityId &&
    entry.message === expectedRepeated.auditLog.message &&
    entry.user_id === expectedRepeated.auditLog.userId
  )
);
const expectedMovementIds = [...scenarioEvidence.setupStockMovementIds, ...(comboWon ? scenarioEvidence.repeatedStockMovementIds : [])].sort();
const movementSetIsExact = JSON.stringify(movements.map((entry) => entry.id).sort()) === JSON.stringify(expectedMovementIds);
const expectedAppState = scenarioEvidence.appStateBefore;
const repeatResponse = scenarioEvidence.responses?.combo?.body;
const repeatEvent = events.find((entry) => entry.event_type === "repeat_session_combo");
const repeatChangedRows = repeatResponse?.changed_rows;
const exactArray = (actual, expected) => JSON.stringify([...(actual ?? [])].sort()) === JSON.stringify([...(expected ?? [])].sort());
const repeatEvidenceIsExact = !comboWon || Boolean(
  repeatEvent &&
  repeatResponse?.entity_id === scenarioEvidence.sessionId &&
  repeatEvent.id === repeatResponse.event_id &&
  repeatEvent.entity_id === scenarioEvidence.sessionId &&
  repeatEvent.created_by === scenarioEvidence.actors.combo &&
  repeatEvent.metadata?.mutation_id === scenarioEvidence.comboMutationId &&
  repeatEvent.metadata?.audit_log_id === scenarioEvidence.repeatedAuditId &&
  repeatEvent.metadata?.combo_application_id === scenarioEvidence.repeatedComboApplicationId &&
  exactArray(repeatEvent.metadata?.session_item_ids, scenarioEvidence.repeatedItemIds) &&
  exactArray(repeatEvent.metadata?.stock_movement_ids, scenarioEvidence.repeatedStockMovementIds) &&
  exactArray(repeatChangedRows?.sessions, [scenarioEvidence.sessionId]) &&
  exactArray(repeatChangedRows?.audit_logs, [scenarioEvidence.repeatedAuditId]) &&
  exactArray(repeatChangedRows?.session_items, scenarioEvidence.repeatedItemIds) &&
  exactArray(repeatChangedRows?.stock_movements, scenarioEvidence.repeatedStockMovementIds) &&
  exactArray(repeatChangedRows?.session_combo_applications, [scenarioEvidence.repeatedComboApplicationId]) &&
  exactArray(repeatChangedRows?.operational_events, [repeatResponse.event_id])
);
const safeForIdentityBoundCleanup =
  session.id === scenarioEvidence.sessionId &&
  session.status === "active" &&
  session.close_disposition === null &&
  session.closed_bill_id === null &&
  session.station_name_snapshot === preflight.fixture.station.name &&
  comboSnapshotIdsAreExact &&
  snapshotEvidenceIsExact &&
  combos.every((entry) => entry.combo_id === preflight.fixture.combo.id) &&
  items.length > 0 &&
  setupEventsAreExact &&
  setupAuditsAreExact &&
  repeatEvidenceIsExact &&
  movementIdsMatch &&
  movementSetIsExact &&
  reservationsAreExact &&
  raceEventTypes.length === (comboWon ? 1 : 0) &&
  checkoutMutationStatus === null &&
  runBills.length === 0 &&
  billLines.length === 0 &&
  appState.version === expectedAppState.version &&
  appState.hash === expectedAppState.hash &&
  inventoryUnchanged &&
  onlyExactSessionOpen;

const evidence = {
  runId,
  scenario,
  checkedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  actorId: login.data.user.id,
  checkoutMutationId: scenarioEvidence.checkoutMutationId,
  customerName,
  session,
  events,
  eventTypes,
  raceEventTypes,
  combos,
  items,
  audits,
  movements,
  runBills,
  billLines,
  checkoutMutationStatus,
  inventory,
  openSessions,
  openTabs,
  appState,
  safeForIdentityBoundCleanup
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ status: safeForIdentityBoundCleanup ? "cleanup-authorizable" : "blocked", artifact: path.relative(root, outputPath), evidence }, null, 2));
if (!safeForIdentityBoundCleanup) process.exitCode = 2;
