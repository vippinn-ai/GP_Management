import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  assertLiveCredentials,
  assertStagingBaseUrl,
  assertStagingSupabaseEnvironment,
  parseEnvFile,
  PRODUCTION_PROJECT_REF,
  sanitizeRunId,
  STAGING_APP_URL,
  STAGING_PROJECT_REF
} from "./playwright-staging-env.mjs";

const root = process.cwd();
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };
const organizationId = "org-primary";
const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => argument !== "--verify")) {
  throw new Error("Fixture preflight accepts only the optional --verify flag.");
}
const verificationOnly = args[0] === "--verify";

assertStagingSupabaseEnvironment(stagingEnv, true);
const baseUrl = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
assertLiveCredentials(env);
if (!env.E2E_FIXTURE_RUN_ID?.trim()) throw new Error("E2E_FIXTURE_RUN_ID is required.");
const runId = sanitizeRunId(env.E2E_FIXTURE_RUN_ID);
const itemName = `QA Repeat Item ${runId}`;
const comboName = `QA Repeat Combo ${runId}`;
const stationName = "8 Ball Pool";

async function deployedArtifactEvidence() {
  const htmlResponse = await fetch(baseUrl, { redirect: "error" });
  if (!htmlResponse.ok) throw new Error(`Unable to read staging shell (${htmlResponse.status}).`);
  const html = await htmlResponse.text();
  const scriptPath = html.match(/<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i)?.[1];
  if (!scriptPath) throw new Error("Unable to identify the staging bundle.");
  const bundleUrl = new URL(scriptPath, baseUrl);
  if (bundleUrl.origin !== new URL(STAGING_APP_URL).origin) throw new Error("Staging bundle resolved outside the approved origin.");
  const bundleResponse = await fetch(bundleUrl, { redirect: "error" });
  if (!bundleResponse.ok) throw new Error(`Unable to read staging bundle (${bundleResponse.status}).`);
  const bundle = await bundleResponse.text();
  if (!bundle.includes(STAGING_PROJECT_REF) || bundle.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error("The deployed bundle failed the staging/production reference guard.");
  }
  return { path: bundleUrl.pathname, sha256: createHash("sha256").update(bundle).digest("hex") };
}

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const anonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !anonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Fixture preflight is locked to staging Supabase.");
}
const supabase = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const lookup = await supabase.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve the staging fixture account.");
const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate the staging fixture account.");
const [role, profile, deployedArtifact] = await Promise.all([
  supabase.rpc("current_user_org_role", { target_organization_id: organizationId }),
  supabase.from("profiles").select("id,role,active").eq("id", login.data.user.id).single(),
  deployedArtifactEvidence()
]);
if (role.error || role.data !== "admin" || profile.error || profile.data?.role !== "admin" || !profile.data.active) {
  throw new Error("Fixture setup requires an active authoritative staging admin.");
}

const [openSessions, openTabs, appState, stations, categories, itemCollisions, comboCollisions] = await Promise.all([
  supabase.from("sessions").select("id,status,customer_name").eq("organization_id", organizationId).neq("status", "closed"),
  supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single(),
  supabase.from("stations").select("id,name,mode,active").eq("organization_id", organizationId).eq("name", stationName),
  supabase.from("inventory_categories").select("id,name").eq("organization_id", organizationId).eq("name", "Food"),
  supabase.from("inventory_items").select("id,name,active,stock_qty").eq("organization_id", organizationId).eq("name", itemName),
  supabase.from("combos").select("id,name,active,price").eq("organization_id", organizationId).eq("name", comboName)
]);
for (const [label, result] of Object.entries({ openSessions, openTabs, appState, stations, categories, itemCollisions, comboCollisions })) {
  if (result.error) throw new Error(`${label} fixture preflight query failed: ${result.error.message}`);
}

const artifactRoot = path.join(root, "test-artifacts");
const artifactDirectory = path.join(artifactRoot, "preflight");
const artifactPath = path.join(artifactDirectory, `checkout-repeat-combo-fixture-preflight-${runId}.json`);
const artifactCollisions = [];
function findArtifactCollisions(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entryPath !== artifactPath && entry.name.includes(runId)) artifactCollisions.push(path.relative(root, entryPath));
    if (entry.isDirectory()) findArtifactCollisions(entryPath);
  }
}
findArtifactCollisions(artifactRoot);

const station = stations.data.length === 1 && stations.data[0].active && stations.data[0].mode === "timed"
  ? stations.data[0]
  : null;
const hash = (data) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const fixture = {
  item: {
    name: itemName,
    category: "Food",
    price: 0,
    stockQty: 20,
    lowStockThreshold: 0,
    isReusable: false,
    barcode: `QA-${runId}`
  },
  combo: {
    name: comboName,
    type: "game",
    price: 199,
    includedMinutes: 60,
    active: true,
    station
  }
};
const safeToRun = Boolean(
  station &&
  categories.data.length === 1 &&
  openSessions.data.length === 0 &&
  openTabs.data.length === 0 &&
  itemCollisions.data.length === 0 &&
  comboCollisions.data.length === 0 &&
  artifactCollisions.length === 0
);
const evidence = {
  runId,
  checkedAt: new Date().toISOString(),
  baseUrl,
  projectRef: STAGING_PROJECT_REF,
  deployedArtifact,
  organizationId,
  actor: { actorId: login.data.user.id, role: role.data, active: true },
  openSessions: openSessions.data,
  openTabs: openTabs.data,
  fixture,
  existingCategory: categories.data,
  identityCollisions: {
    inventoryItems: itemCollisions.data,
    combos: comboCollisions.data,
    artifacts: artifactCollisions
  },
  appState: { version: appState.data.version, hash: hash(appState.data.data) },
  safeToRun
};

fs.mkdirSync(artifactDirectory, { recursive: true });
if (verificationOnly) {
  if (!fs.existsSync(artifactPath)) throw new Error("Reviewed fixture preflight artifact is missing.");
  const reviewed = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const stable = (value) => ({
    runId: value.runId,
    baseUrl: value.baseUrl,
    projectRef: value.projectRef,
    deployedArtifact: value.deployedArtifact,
    organizationId: value.organizationId,
    actor: value.actor,
    openSessions: value.openSessions,
    openTabs: value.openTabs,
    fixture: value.fixture,
    existingCategory: value.existingCategory,
    identityCollisions: value.identityCollisions,
    appState: value.appState,
    safeToRun: value.safeToRun
  });
  if (!reviewed.safeToRun || JSON.stringify(stable(reviewed)) !== JSON.stringify(stable(evidence))) {
    throw new Error("Reviewed fixture preflight drifted before execution.");
  }
  console.log(JSON.stringify({ status: "verified", artifact: path.relative(root, artifactPath), evidence }, null, 2));
} else {
  fs.writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ status: safeToRun ? "passed" : "blocked", artifact: path.relative(root, artifactPath), evidence }, null, 2));
  if (!safeToRun) process.exitCode = 2;
}
