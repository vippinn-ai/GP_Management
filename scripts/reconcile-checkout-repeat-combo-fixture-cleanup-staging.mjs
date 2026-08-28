import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { assertLiveCredentials, assertStagingSupabaseEnvironment, parseEnvFile, sanitizeRunId, STAGING_PROJECT_REF } from "./playwright-staging-env.mjs";

const root = process.cwd();
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);
const fixtureRunId = sanitizeRunId(env.E2E_FIXTURE_RUN_ID);
const cleanupRunId = sanitizeRunId(env.E2E_FIXTURE_CLEANUP_RUN_ID);
if (fixtureRunId === cleanupRunId) throw new Error("Cleanup reconciliation requires distinct setup and cleanup run IDs.");
const setupReportPath = path.join(root, "test-artifacts", "reconciliation", `checkout-repeat-combo-fixture-postflight-${fixtureRunId}.json`);
const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-repeat-combo-fixture-cleanup-preflight-${cleanupRunId}.json`);
const summaryPath = path.join(root, "test-artifacts", "playwright", `summary-${cleanupRunId}.json`);
if (!fs.existsSync(setupReportPath) || !fs.existsSync(preflightPath) || !fs.existsSync(summaryPath)) throw new Error("Setup postflight, cleanup preflight, or cleanup Playwright summary is missing.");
const setup = JSON.parse(fs.readFileSync(setupReportPath, "utf8"));
const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
if (!setup.reconciled || !["item_only", "complete"].includes(setup.classification) || summary.runId !== cleanupRunId || summary.tests?.length !== 1 || summary.tests[0].retry !== 0) throw new Error("Cleanup reconciliation refused mismatched or retried evidence.");
if (!preflight.safeToRun || preflight.fixtureRunId !== fixtureRunId || preflight.cleanupRunId !== cleanupRunId || preflight.effectCount !== setup.effectCount) throw new Error("Cleanup reconciliation refused an unsafe or mismatched cleanup preflight.");

function checkpoint(stage) {
  const file = path.join(root, "test-artifacts", "checkpoints", `checkout-repeat-combo-fixture-cleanup-${cleanupRunId}-${stage}.json`);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.fixtureRunId !== fixtureRunId || value.cleanupRunId !== cleanupRunId || value.stage !== stage) throw new Error(`Cleanup ${stage} checkpoint identity mismatch.`);
  return value;
}
const checkpoints = { prepared: checkpoint("prepared"), comboArchived: checkpoint("combo-archived"), itemArchived: checkpoint("item-archived"), final: checkpoint("final") };
const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const anonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !anonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) throw new Error("Cleanup reconciliation is locked to staging Supabase.");
const supabase = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const lookup = await supabase.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve cleanup reconciliation account.");
const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate cleanup reconciliation account.");
const role = await supabase.rpc("current_user_org_role", { target_organization_id: "org-primary" });
if (role.error || role.data !== "admin") throw new Error("Cleanup reconciliation requires an authoritative staging admin.");

const itemId = setup.fixture.item.id;
const comboId = setup.fixture.combo?.id ?? null;
const discoveryFrom = checkpoints.prepared?.recordedAt ?? summary.startedAt;
const queried = await Promise.all([
  supabase.from("inventory_items").select("id,name,active,stock_qty,archived_by_user_id,archive_reason").eq("organization_id", "org-primary").eq("id", itemId),
  comboId ? supabase.from("combos").select("id,name,active").eq("organization_id", "org-primary").eq("id", comboId) : Promise.resolve({ data: [], error: null }),
  supabase.from("audit_logs").select("id,action,entity_id,user_id,created_at").eq("organization_id", "org-primary").in("entity_id", [itemId, comboId].filter(Boolean)).gte("created_at", discoveryFrom).order("created_at"),
  supabase.from("operational_events").select("id,event_type,created_by,metadata,created_at").eq("organization_id", "org-primary").eq("event_type", "admin_data_committed").gte("created_at", discoveryFrom).order("created_at"),
  supabase.from("stock_movements").select("id,item_id,type,quantity,created_at").eq("organization_id", "org-primary").eq("item_id", itemId).gte("created_at", discoveryFrom),
  supabase.from("sessions").select("id").eq("organization_id", "org-primary").neq("status", "closed"),
  supabase.from("customer_tabs").select("id").eq("organization_id", "org-primary").eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single()
]);
for (const [index, result] of queried.entries()) if (result.error) throw new Error(`Cleanup reconciliation query ${index} failed: ${result.error.message}`);
const [items, combos, discoveredAudits, discoveredEvents, movements, sessions, tabs, appState] = queried.map((result) => result.data);
const itemArchived = items.length === 1 && items[0].active === false;
const comboArchived = comboId ? combos.length === 1 && combos[0].active === false : false;
const archivedCount = Number(itemArchived) + Number(comboArchived);
const expectedCount = setup.effectCount;
const changedIds = (event, collection) => Array.isArray(event.metadata?.changed_rows?.[collection]) ? event.metadata.changed_rows[collection] : [];
const itemEvents = itemArchived ? discoveredEvents.filter((event) => changedIds(event, "inventory_items").includes(itemId)) : [];
const comboEvents = comboArchived ? discoveredEvents.filter((event) => changedIds(event, "combos").includes(comboId)) : [];
const events = [...comboEvents, ...itemEvents];
const audits = discoveredAudits.filter((audit) =>
  (itemArchived && audit.action === "inventory_archived" && audit.entity_id === itemId) ||
  (comboArchived && audit.action === "combo_archived" && audit.entity_id === comboId)
);
const failures = [];
const checks = [];
function check(condition, message) { checks.push({ passed: Boolean(condition), message }); if (!condition) failures.push(message); }
check(items.length === 1 && items[0].id === itemId, "Exact fixture item remains identity-bound.");
check(!comboId || (combos.length === 1 && combos[0].id === comboId), "Exact fixture combo remains identity-bound.");
check(!(itemArchived && comboId && !comboArchived), "Cleanup order cannot archive the item before its combo.");
check(appState.version === preflight.appState.version + archivedCount, "Compatibility state advanced exactly once per acknowledged archive from the fresh cleanup baseline.");
check(events.length === archivedCount && events.every((event) => event.event_type === "admin_data_committed" && event.created_by === login.data.user.id), "Acknowledged cleanup events and actors match.");
check(audits.length === archivedCount && audits.every((audit) => audit.user_id === login.data.user.id), "Acknowledged cleanup audits and actors match.");
if (comboArchived) check(audits.some((audit) => audit.action === "combo_archived" && audit.entity_id === comboId), "Combo archive audit matches.");
if (itemArchived) check(audits.some((audit) => audit.action === "inventory_archived" && audit.entity_id === itemId), "Item archive audit matches.");
check(movements.length === 0, "Cleanup created no new stock movements.");
check(Number(items[0]?.stock_qty) === Number(preflight.fixture.item.stock_qty), "Cleanup preserved the fixture item physical stock quantity.");
check(sessions.length === 0 && tabs.length === 0, "Staging floor remains empty after cleanup.");
const compatibilityItem = appState.data.inventoryItems?.filter((entry) => entry.id === itemId) ?? [];
const compatibilityCombo = comboId ? appState.data.combos?.filter((entry) => entry.id === comboId) ?? [] : [];
check(compatibilityItem.length === 1 && compatibilityItem[0].active === !itemArchived, "Compatibility item archive state matches normalized data.");
if (comboId) check(compatibilityCombo.length === 1 && compatibilityCombo[0].active === !comboArchived, "Compatibility combo archive state matches normalized data.");
const cleanupComplete = archivedCount === expectedCount;
const stateHash = createHash("sha256").update(JSON.stringify(appState.data)).digest("hex");
const report = { fixtureRunId, cleanupRunId, checkedAt: new Date().toISOString(), projectRef: STAGING_PROJECT_REF, actorId: login.data.user.id, playwrightStatus: summary.status, archivedCount, expectedCount, cleanupComplete, transportEvidenceComplete: Boolean(summary.status === "passed" && checkpoints.prepared && checkpoints.itemArchived && (!comboId || checkpoints.comboArchived) && checkpoints.final), reconciledButPlaywrightFailed: summary.status !== "passed" && archivedCount > 0, checkpoints, item: items[0], combo: combos[0] ?? null, events, audits, stockMovements: movements, appState: { version: appState.version, hash: stateHash }, checks, failures, reconciled: failures.length === 0 };
const outputDirectory = path.join(root, "test-artifacts", "reconciliation");
const outputPath = path.join(outputDirectory, `checkout-repeat-combo-fixture-cleanup-postflight-${cleanupRunId}.json`);
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ artifact: path.relative(root, outputPath), report }, null, 2));
if (!report.reconciled || !report.cleanupComplete) process.exitCode = 1;
