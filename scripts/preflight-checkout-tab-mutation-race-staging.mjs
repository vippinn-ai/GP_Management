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
import { loadSessionItemRaceAdmin } from "./session-item-race-admin-env.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => argument !== "--verify")) {
  throw new Error("Checkout-tab-mutation race preflight accepts only --verify or one exact preflight.");
}
const verificationOnly = args[0] === "--verify";
const modes = ["add_item", "update_item", "remove_item", "apply_combo"];
const scenarios = ["checkout_first", "mutation_first", "simultaneous"];
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const temporaryAdmin = loadSessionItemRaceAdmin(root);
const env = { ...localEnv, ...process.env, ...(temporaryAdmin?.overlay || {}) };
const organizationId = "org-primary";

assertStagingSupabaseEnvironment(stagingEnv, true);
const baseUrl = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
assertLiveCredentials(env);
if (!env.E2E_RUN_ID?.trim()) throw new Error("An explicit E2E_RUN_ID is required.");
const runId = sanitizeRunId(env.E2E_RUN_ID);
const itemName = `QA Tab Mutation Race Item ${runId}`;
const comboName = `QA Tab Mutation Race Combo ${runId}`;
const customerNames = modes.flatMap((mutationMode) => scenarios.map((scenario) =>
  `QA Tab Mutation Race ${runId} ${mutationMode} ${scenario}`
));
const billNumbers = modes.flatMap((mutationMode) => scenarios.map((scenario) =>
  `BILL-QA-TAB-MUT-${runId}-${mutationMode}-${scenario}`
));

async function deployedArtifact() {
  const shell = await fetch(baseUrl, { redirect: "error" });
  if (!shell.ok) throw new Error(`Unable to read staging shell (${shell.status}).`);
  const html = await shell.text();
  const scriptPath = html.match(/<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i)?.[1];
  if (!scriptPath) throw new Error("Unable to identify the deployed staging bundle.");
  const bundleUrl = new URL(scriptPath, baseUrl);
  if (bundleUrl.origin !== new URL(STAGING_APP_URL).origin) throw new Error("Staging bundle escaped its approved origin.");
  const response = await fetch(bundleUrl, { redirect: "error" });
  if (!response.ok) throw new Error(`Unable to read staging bundle (${response.status}).`);
  const bundle = await response.text();
  if (!bundle.includes(STAGING_PROJECT_REF) || bundle.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error("The deployed bundle failed its staging project guard.");
  }
  return { path: bundleUrl.pathname, sha256: createHash("sha256").update(bundle).digest("hex") };
}

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey) throw new Error("Ignored staging Supabase configuration is incomplete.");
if (new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Checkout-tab-mutation race preflight is locked to staging.");
}

async function authenticate(slot) {
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const lookup = await client.functions.invoke("resolve-login-email", {
    body: { username: env[`E2E_USER_${slot}`].trim() }
  });
  if (lookup.error || !lookup.data?.email) throw new Error(`Unable to resolve staging slot ${slot}.`);
  const login = await client.auth.signInWithPassword({
    email: lookup.data.email,
    password: env[`E2E_PASSWORD_${slot}`]
  });
  if (login.error || !login.data.user) throw new Error(`Unable to authenticate staging slot ${slot}.`);
  const [role, profile] = await Promise.all([
    client.rpc("current_user_org_role", { target_organization_id: organizationId }),
    client.from("profiles").select("id,role,active").eq("id", login.data.user.id).single()
  ]);
  if (role.error || role.data !== "admin" || profile.error || profile.data?.role !== "admin" || !profile.data.active) {
    throw new Error(`Slot ${slot} must be an active authoritative staging admin.`);
  }
  return { client, identity: { slot, actorId: login.data.user.id, role: role.data, active: true } };
}

// Username resolution stays sequential because it is not a race target.
const origin = await authenticate("A");
const observer = await authenticate("B");
if (temporaryAdmin && observer.identity.actorId !== temporaryAdmin.actorId) {
  throw new Error("Slot B did not authenticate as the exact temporary staging admin checkpoint.");
}
const supabase = origin.client;
const [artifact, openSessions, openTabs, appState, categories, items, combos, tabs, bills] = await Promise.all([
  deployedArtifact(),
  supabase.from("sessions").select("id,status,customer_name").eq("organization_id", organizationId).neq("status", "closed"),
  supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single(),
  supabase.from("inventory_categories").select("id,name").eq("organization_id", organizationId).eq("name", "Beverages"),
  supabase.from("inventory_items").select("id,name,active,stock_qty").eq("organization_id", organizationId).eq("name", itemName),
  supabase.from("combos").select("id,name,active,type").eq("organization_id", organizationId).eq("name", comboName),
  supabase.from("customer_tabs").select("id,customer_name,status").eq("organization_id", organizationId).in("customer_name", customerNames),
  supabase.from("bills").select("id,bill_number,status").eq("organization_id", organizationId).in("bill_number", billNumbers)
]);
for (const [label, result] of Object.entries({ openSessions, openTabs, appState, categories, items, combos, tabs, bills })) {
  if (result.error) throw new Error(`${label} preflight query failed: ${result.error.message}`);
}

const artifactRoot = path.join(root, "test-artifacts");
const artifactDirectory = path.join(artifactRoot, "preflight");
const artifactPath = path.join(artifactDirectory, `checkout-tab-mutation-race-preflight-${runId}.json`);
const artifactCollisions = [];
function scan(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entryPath !== artifactPath && entry.name.includes(runId)) artifactCollisions.push(path.relative(root, entryPath));
    if (entry.isDirectory()) scan(entryPath);
  }
}
scan(artifactRoot);

const evidence = {
  runId,
  checkedAt: new Date().toISOString(),
  baseUrl,
  projectRef: STAGING_PROJECT_REF,
  organizationId,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  selectedModes: modes,
  selectedScenarios: scenarios,
  actors: [origin.identity, observer.identity],
  actorsDistinct: origin.identity.actorId !== observer.identity.actorId,
  temporaryAdmin: temporaryAdmin ? {
    accountRunId: temporaryAdmin.accountRunId,
    actorId: temporaryAdmin.actorId,
    credentialFile: path.basename(temporaryAdmin.filePath),
    createArtifact: path.relative(root, temporaryAdmin.createArtifactPath),
    createArtifactSha256: temporaryAdmin.createArtifactSha256
  } : null,
  deployedArtifact: artifact,
  fixture: {
    itemName,
    comboName,
    customerNames,
    billNumbers,
    openingStock: 64,
    itemPrice: 50,
    comboPrice: 25,
    category: "Beverages"
  },
  openSessions: openSessions.data,
  openTabs: openTabs.data,
  identityCollisions: { items: items.data, combos: combos.data, tabs: tabs.data, bills: bills.data, artifacts: artifactCollisions },
  appState: {
    version: appState.data.version,
    hash: createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex")
  }
};
evidence.safeToRun = openSessions.data.length === 0 && openTabs.data.length === 0 &&
  categories.data.length === 1 && evidence.actorsDistinct && items.data.length === 0 && combos.data.length === 0 &&
  tabs.data.length === 0 && bills.data.length === 0 && artifactCollisions.length === 0;

fs.mkdirSync(artifactDirectory, { recursive: true });
if (verificationOnly) {
  if (!fs.existsSync(artifactPath)) throw new Error("The reviewed checkout-tab-mutation preflight artifact is missing.");
  const reviewed = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const matches = reviewed.safeToRun && evidence.safeToRun && reviewed.runId === runId &&
    JSON.stringify(reviewed.selectedModes) === JSON.stringify(evidence.selectedModes) &&
    JSON.stringify(reviewed.selectedScenarios) === JSON.stringify(evidence.selectedScenarios) &&
    reviewed.projectRef === evidence.projectRef && JSON.stringify(reviewed.actors) === JSON.stringify(evidence.actors) &&
    reviewed.actorsDistinct === true && JSON.stringify(reviewed.temporaryAdmin) === JSON.stringify(evidence.temporaryAdmin) &&
    JSON.stringify(reviewed.fixture) === JSON.stringify(evidence.fixture) &&
    JSON.stringify(reviewed.openSessions) === JSON.stringify(evidence.openSessions) &&
    JSON.stringify(reviewed.openTabs) === JSON.stringify(evidence.openTabs) &&
    JSON.stringify(reviewed.identityCollisions) === JSON.stringify(evidence.identityCollisions) &&
    reviewed.appState?.version === evidence.appState.version && reviewed.appState?.hash === evidence.appState.hash &&
    reviewed.deployedArtifact?.path === evidence.deployedArtifact.path &&
    reviewed.deployedArtifact?.sha256 === evidence.deployedArtifact.sha256;
  if (!matches) throw new Error("reviewed_preflight_drift");
  console.log(JSON.stringify({ status: "verified", artifact: path.relative(root, artifactPath), evidence }, null, 2));
  process.exit(0);
}

fs.writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
if (!evidence.safeToRun) {
  console.error(JSON.stringify({ status: "blocked", artifact: path.relative(root, artifactPath), evidence }, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({ status: "passed", artifact: path.relative(root, artifactPath), evidence }, null, 2));
}
