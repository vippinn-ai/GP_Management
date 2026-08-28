import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { assertLiveCredentials, assertStagingSupabaseEnvironment, parseEnvFile, sanitizeRunId, STAGING_PROJECT_REF } from "./playwright-staging-env.mjs";

const root = process.cwd();
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };
const organizationId = "org-primary";
assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);
if (!env.E2E_FIXTURE_RUN_ID?.trim()) throw new Error("E2E_FIXTURE_RUN_ID is required.");
const runId = sanitizeRunId(env.E2E_FIXTURE_RUN_ID);
const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-repeat-combo-fixture-preflight-${runId}.json`);
const summaryPath = path.join(root, "test-artifacts", "playwright", `summary-fixture-${runId}.json`);
if (!fs.existsSync(preflightPath) || !fs.existsSync(summaryPath)) throw new Error("Fixture preflight or Playwright summary is missing.");
const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
if (!preflight.safeToRun || preflight.runId !== runId || summary.runId !== `fixture-${runId}` || summary.tests?.length !== 1 || summary.tests[0].retry !== 0) {
  throw new Error("Fixture reconciliation refused an unsafe, mismatched, or retried execution.");
}

const checkpointDirectory = path.join(root, "test-artifacts", "checkpoints");
function readCheckpoint(stage) {
  const checkpointPath = path.join(checkpointDirectory, `checkout-repeat-combo-fixture-${runId}-${stage}.json`);
  if (!fs.existsSync(checkpointPath)) return null;
  const value = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  if (value.runId !== runId || value.stage !== stage) throw new Error(`Fixture ${stage} checkpoint identity mismatch.`);
  return value;
}
const checkpoints = {
  prepared: readCheckpoint("prepared"),
  itemCreated: readCheckpoint("item-created"),
  comboCreated: readCheckpoint("combo-created"),
  final: readCheckpoint("final")
};
const attachment = summary.tests[0].attachments?.find((entry) => entry.name === "checkout-repeat-combo-fixture-setup-evidence");
let playwrightEvidence = null;
if (attachment?.path) {
  playwrightEvidence = JSON.parse(fs.readFileSync(path.join(root, attachment.path), "utf8"));
  if (![runId, `fixture-${runId}`].includes(playwrightEvidence.runId)) throw new Error("Fixture evidence identity mismatch.");
}

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const anonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !anonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) throw new Error("Fixture reconciliation is locked to staging Supabase.");
const supabase = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const lookup = await supabase.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve the fixture reconciliation account.");
const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate the fixture reconciliation account.");
const role = await supabase.rpc("current_user_org_role", { target_organization_id: organizationId });
if (role.error || role.data !== "admin") throw new Error("Fixture reconciliation requires an authoritative staging admin.");

const itemName = preflight.fixture.item.name;
const comboName = preflight.fixture.combo.name;
const barcode = preflight.fixture.item.barcode;
const queried = await Promise.all([
  supabase.from("inventory_items").select("id,name,category,price,stock_qty,low_stock_threshold,is_reusable,barcode,active,sell_base_item").eq("organization_id", organizationId).eq("name", itemName),
  supabase.from("inventory_items").select("id,name,barcode").eq("organization_id", organizationId).eq("barcode", barcode),
  supabase.from("combos").select("id,name,type,active,price,included_minutes,raw_data").eq("organization_id", organizationId).eq("name", comboName),
  supabase.from("audit_logs").select("id,action,entity_type,entity_id,user_id,message,created_at").eq("organization_id", organizationId).gte("created_at", preflight.checkedAt).order("created_at"),
  supabase.from("operational_events").select("id,event_type,entity_type,entity_id,created_by,metadata,created_at").eq("organization_id", organizationId).eq("event_type", "admin_data_committed").gte("created_at", preflight.checkedAt).order("created_at"),
  supabase.from("sessions").select("id,status,customer_name").eq("organization_id", organizationId).neq("status", "closed"),
  supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single()
]);
for (const [index, result] of queried.entries()) if (result.error) throw new Error(`Fixture reconciliation query ${index} failed: ${result.error.message}`);
const [items, barcodeRows, combos, recentAudits, recentEvents, sessions, tabs, appState] = queried.map((result) => result.data);
const item = items[0] ?? null;
const combo = combos[0] ?? null;
const itemId = item?.id ?? null;
const comboId = combo?.id ?? null;
const dependent = await Promise.all([
  comboId ? supabase.from("combo_station_targets").select("combo_id,station_id").eq("organization_id", organizationId).eq("combo_id", comboId) : Promise.resolve({ data: [], error: null }),
  comboId ? supabase.from("combo_fixed_items").select("combo_id,id,sellable_option_id,quantity").eq("organization_id", organizationId).eq("combo_id", comboId) : Promise.resolve({ data: [], error: null }),
  itemId ? supabase.from("stock_movements").select("id,item_id,type,quantity").eq("organization_id", organizationId).eq("item_id", itemId) : Promise.resolve({ data: [], error: null })
]);
for (const [index, result] of dependent.entries()) if (result.error) throw new Error(`Fixture dependent query ${index} failed: ${result.error.message}`);
const [targets, fixedItems, movements] = dependent.map((result) => result.data);

const failures = [];
const checks = [];
function check(condition, message) { checks.push({ passed: Boolean(condition), message }); if (!condition) failures.push(message); }
const changedIds = (event, collection) => Array.isArray(event.metadata?.changed_rows?.[collection]) ? event.metadata.changed_rows[collection] : [];
const itemEvents = itemId ? recentEvents.filter((event) => changedIds(event, "inventory_items").includes(itemId)) : [];
const comboEvents = comboId ? recentEvents.filter((event) => changedIds(event, "combos").includes(comboId)) : [];
const relatedEvents = [...itemEvents, ...comboEvents];
const relatedAudits = recentAudits.filter((audit) => audit.entity_id === itemId || audit.entity_id === comboId);
const effectCount = Number(Boolean(item)) + Number(Boolean(combo));
const classification = effectCount === 0 ? "no_effect" : effectCount === 1 && item ? "item_only" : effectCount === 2 ? "complete" : "invalid_combo_without_item";

check(items.length <= 1, "Generated item name resolves to at most one row.");
check(barcodeRows.length <= 1 && (!item || barcodeRows[0]?.id === itemId), "Generated barcode resolves to the same single item.");
check(combos.length <= 1, "Generated combo name resolves to at most one row.");
check(!combo || Boolean(item), "A combo cannot exist without its isolated item.");
if (item) {
  check(item.name === itemName && item.category === "Food" && Number(item.price) === 0 && Number(item.stock_qty) === 20 && Number(item.low_stock_threshold) === 0 && item.is_reusable === false && item.barcode === barcode && item.active === true && item.sell_base_item === true, "Isolated inventory row matches the reviewed fixture.");
  check(itemEvents.length === 1 && itemEvents[0].created_by === login.data.user.id, "Item has exactly one canonical admin event and authenticated actor.");
  check(relatedAudits.filter((audit) => audit.entity_id === itemId).length === 1 && relatedAudits.some((audit) => audit.action === "inventory_created" && audit.entity_id === itemId && audit.user_id === login.data.user.id), "Item has exactly one creation audit and authenticated actor.");
  check(movements.length === 0, "Fixture item has no stock movements.");
  if (checkpoints.itemCreated) check(checkpoints.itemCreated.itemId === itemId && checkpoints.itemCreated.result?.event_id === itemEvents[0]?.id, "Item checkpoint binds to the exact row and event.");
}
if (combo) {
  check(combo.name === comboName && combo.type === "game" && combo.active === true && Number(combo.price) === 199 && Number(combo.included_minutes) === 60, "Isolated combo row matches the reviewed fixture.");
  check(targets.length === 1 && targets[0].station_id === preflight.fixture.combo.station.id, "Combo has exactly the approved 8 Ball Pool target.");
  check(fixedItems.length === 1 && fixedItems[0].sellable_option_id === itemId && Number(fixedItems[0].quantity) === 1, "Combo has exactly one unit of the isolated base item.");
  check(comboEvents.length === 1 && comboEvents[0].created_by === login.data.user.id, "Combo has exactly one canonical admin event and authenticated actor.");
  check(relatedAudits.filter((audit) => audit.entity_id === comboId).length === 1 && relatedAudits.some((audit) => audit.action === "combo_created" && audit.entity_id === comboId && audit.user_id === login.data.user.id), "Combo has exactly one creation audit and authenticated actor.");
  if (checkpoints.comboCreated) check(checkpoints.comboCreated.comboId === comboId && checkpoints.comboCreated.result?.event_id === comboEvents[0]?.id, "Combo checkpoint binds to the exact row and event.");
}
check(sessions.length === 0 && tabs.length === 0, "Staging floor remains empty.");
check(appState.version === preflight.appState.version + effectCount, "Compatibility state advanced exactly once per acknowledged effect.");
const compatibilityItems = appState.data.inventoryItems?.filter((entry) => entry.name === itemName || entry.barcode === barcode) ?? [];
const compatibilityCombos = appState.data.combos?.filter((entry) => entry.name === comboName) ?? [];
check(compatibilityItems.length === Number(Boolean(item)), "Compatibility item presence exactly matches normalized state.");
check(compatibilityCombos.length === Number(Boolean(combo)), "Compatibility combo presence exactly matches normalized state.");
if (item) check(compatibilityItems[0].id === itemId && compatibilityItems[0].stockQty === 20 && compatibilityItems[0].isReusable === false, "Compatibility item fields match the isolated item.");
if (combo) check(compatibilityCombos[0].id === comboId && JSON.stringify(compatibilityCombos[0].stationIds) === JSON.stringify([preflight.fixture.combo.station.id]) && compatibilityCombos[0].fixedItems?.length === 1 && compatibilityCombos[0].fixedItems[0].sellableOptionId === itemId && compatibilityCombos[0].fixedItems[0].quantity === 1, "Compatibility combo target and fixed item match normalized state.");
if (classification === "complete") {
  check(relatedEvents.length === 2 && new Set(relatedEvents.map((event) => event.metadata?.mutation_id)).size === 2, "Complete fixture has exactly two distinct canonical admin mutations.");
}

const stateHash = createHash("sha256").update(JSON.stringify(appState.data)).digest("hex");
const report = {
  runId, checkedAt: new Date().toISOString(), projectRef: STAGING_PROJECT_REF, actorId: login.data.user.id,
  playwrightStatus: summary.status, classification, effectCount, fixtureComplete: classification === "complete",
  transportEvidenceComplete: Boolean(summary.status === "passed" && checkpoints.prepared && checkpoints.itemCreated && checkpoints.comboCreated && checkpoints.final),
  reconciledButPlaywrightFailed: summary.status !== "passed" && ["item_only", "complete"].includes(classification),
  fixture: { item, combo: combo ? { ...combo, raw_data: undefined } : null, stationTargets: targets, fixedItems },
  checkpoints, playwrightEvidence, events: relatedEvents, audits: relatedAudits, stockMovements: movements,
  appState: { version: appState.version, hash: stateHash }, checks, failures, reconciled: failures.length === 0
};
const outputDirectory = path.join(root, "test-artifacts", "reconciliation");
const outputPath = path.join(outputDirectory, `checkout-repeat-combo-fixture-postflight-${runId}.json`);
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ artifact: path.relative(root, outputPath), report }, null, 2));
if (!report.reconciled || !report.fixtureComplete) process.exitCode = 1;
