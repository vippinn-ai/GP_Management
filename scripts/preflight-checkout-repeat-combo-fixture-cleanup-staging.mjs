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
const fixtureRunId = sanitizeRunId(env.E2E_FIXTURE_RUN_ID);
const cleanupRunId = sanitizeRunId(env.E2E_FIXTURE_CLEANUP_RUN_ID);
if (!fixtureRunId || !cleanupRunId || fixtureRunId === cleanupRunId) throw new Error("Distinct fixture and cleanup run IDs are required.");

const setupPath = path.join(root, "test-artifacts", "reconciliation", `checkout-repeat-combo-fixture-postflight-${fixtureRunId}.json`);
const outputPath = path.join(root, "test-artifacts", "preflight", `checkout-repeat-combo-fixture-cleanup-preflight-${cleanupRunId}.json`);
if (!fs.existsSync(setupPath)) throw new Error("Immutable fixture setup postflight is missing.");
if (fs.existsSync(outputPath)) throw new Error("Exact fixture cleanup preflight already exists; refusing overwrite.");
const setup = JSON.parse(fs.readFileSync(setupPath, "utf8"));
if (!setup.reconciled || setup.classification !== "complete" || setup.runId !== fixtureRunId || !setup.fixture?.item?.id || !setup.fixture?.combo?.id) {
  throw new Error("Fixture setup evidence is not complete or identity-bound.");
}

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const anonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !anonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) throw new Error("Fixture cleanup preflight is locked to staging.");
const supabase = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const lookup = await supabase.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve fixture cleanup preflight account.");
const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate fixture cleanup preflight account.");
const role = await supabase.rpc("current_user_org_role", { target_organization_id: "org-primary" });
if (role.error || role.data !== "admin") throw new Error("Fixture cleanup preflight requires an authoritative staging admin.");

const queried = await Promise.all([
  supabase.from("inventory_items").select("id,name,category,price,stock_qty,low_stock_threshold,is_reusable,barcode,active,sell_base_item").eq("organization_id", "org-primary").eq("id", setup.fixture.item.id),
  supabase.from("combos").select("id,name,type,active,price,included_minutes").eq("organization_id", "org-primary").eq("id", setup.fixture.combo.id),
  supabase.from("combo_station_targets").select("combo_id,station_id").eq("organization_id", "org-primary").eq("combo_id", setup.fixture.combo.id),
  supabase.from("combo_fixed_items").select("id,combo_id,sellable_option_id,quantity").eq("organization_id", "org-primary").eq("combo_id", setup.fixture.combo.id),
  supabase.from("sessions").select("id,status,customer_name").eq("organization_id", "org-primary").neq("status", "closed"),
  supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", "org-primary").eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single()
]);
for (const [index, result] of queried.entries()) if (result.error) throw new Error(`Fixture cleanup preflight query ${index} failed: ${result.error.message}`);
const [items, combos, stationTargets, fixedItems, sessions, tabs, appState] = queried.map((result) => result.data);
const item = items[0];
const combo = combos[0];
const exactItem = items.length === 1 && item.id === setup.fixture.item.id && item.name === setup.fixture.item.name && item.barcode === setup.fixture.item.barcode && item.active === true;
const exactCombo = combos.length === 1 && combo.id === setup.fixture.combo.id && combo.name === setup.fixture.combo.name && combo.active === true;
const exactTargets = stationTargets.length === setup.fixture.stationTargets.length && setup.fixture.stationTargets.every((expected) =>
  stationTargets.some((entry) => entry.combo_id === expected.combo_id && entry.station_id === expected.station_id)
);
const exactFixedItems = fixedItems.length === setup.fixture.fixedItems.length && setup.fixture.fixedItems.every((expected) =>
  fixedItems.some((entry) =>
    entry.id === expected.id &&
    entry.combo_id === expected.combo_id &&
    entry.sellable_option_id === expected.sellable_option_id &&
    Number(entry.quantity) === Number(expected.quantity)
  )
);
const artifactRoot = path.join(root, "test-artifacts");
const collisions = [];
function findCollisions(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.name.includes(cleanupRunId)) collisions.push(path.relative(root, entryPath));
    if (entry.isDirectory()) findCollisions(entryPath);
  }
}
findCollisions(artifactRoot);
const state = { version: appState.version, hash: createHash("sha256").update(JSON.stringify(appState.data)).digest("hex") };
const safeToRun = exactItem && exactCombo && exactTargets && exactFixedItems && sessions.length === 0 && tabs.length === 0 && collisions.length === 0 && Number(item.stock_qty) >= 0;
const evidence = {
  fixtureRunId,
  cleanupRunId,
  checkedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  actorId: login.data.user.id,
  fixture: { item, combo, stationTargets, fixedItems },
  effectCount: 2,
  openSessions: sessions,
  openTabs: tabs,
  artifactCollisions: collisions,
  appState: state,
  safeToRun
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ status: safeToRun ? "passed" : "blocked", artifact: path.relative(root, outputPath), evidence }, null, 2));
if (!safeToRun) process.exitCode = 2;
