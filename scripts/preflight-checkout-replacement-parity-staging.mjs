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
const organizationId = "org-primary";
const args = process.argv.slice(2);
const verifyOnly = args.length === 1 && args[0] === "--verify";
if (args.length > 1 || (args.length === 1 && !verifyOnly)) {
  throw new Error("Replacement-parity preflight accepts only optional --verify.");
}

const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);
const baseUrl = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
if (!env.E2E_RUN_ID?.trim()) throw new Error("An explicit E2E_RUN_ID is required.");
const runId = sanitizeRunId(env.E2E_RUN_ID);
const fixture = {
  customerName:
    env.E2E_V2_REPLACEMENT_CUSTOMER?.trim() ||
    env.E2E_REPLACEMENT_PARITY_CUSTOMER?.trim() ||
    `QA Replacement Parity ${runId}`,
  itemName: `QA Replacement Item ${runId}`,
  itemBarcode: `QA-REPLACE-${runId}`,
  originalBillNumber: `BILL-QA-REPLACE-PARITY-${runId}-ORIGINAL`,
  replacementBillNumber: `BILL-QA-REPLACE-PARITY-${runId}-REPLACEMENT`
};
const artifactDirectory = path.join(root, "test-artifacts", "preflight");
const artifactPath = path.join(artifactDirectory, `checkout-replacement-parity-preflight-${runId}.json`);

async function readDeployedArtifact() {
  const shell = await fetch(baseUrl, { redirect: "error" });
  if (!shell.ok) throw new Error(`Unable to read staging shell (${shell.status}).`);
  const html = await shell.text();
  const scriptPath = html.match(/<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i)?.[1];
  if (!scriptPath) throw new Error("Unable to identify the deployed staging bundle.");
  const url = new URL(scriptPath, baseUrl);
  if (url.origin !== new URL(STAGING_APP_URL).origin) throw new Error("Staging bundle escaped its approved origin.");
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`Unable to read staging bundle (${response.status}).`);
  const body = await response.text();
  if (!body.includes(STAGING_PROJECT_REF) || body.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error("The deployed bundle failed its staging-project guard.");
  }
  return { path: url.pathname, sha256: createHash("sha256").update(body).digest("hex") };
}

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey) throw new Error("Ignored staging Supabase configuration is incomplete.");
if (new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) throw new Error("Replacement-parity preflight is locked to staging.");

async function authenticate(slot) {
  const client = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const lookup = await client.functions.invoke("resolve-login-email", { body: { username: env[`E2E_USER_${slot}`].trim() } });
  if (lookup.error || !lookup.data?.email) throw new Error(`Unable to resolve staging slot ${slot}.`);
  const login = await client.auth.signInWithPassword({ email: lookup.data.email, password: env[`E2E_PASSWORD_${slot}`] });
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

const origin = await authenticate("A");
const observer = await authenticate("B");
const supabase = origin.client;
const [bundle, openSessions, openTabs, appState, customers, bills, itemNames, barcodes, pendingBills] = await Promise.all([
  readDeployedArtifact(),
  supabase.from("sessions").select("id,status,customer_name,station_name_snapshot").eq("organization_id", organizationId).neq("status", "closed"),
  supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single(),
  supabase.from("customers").select("id,name,phone").eq("organization_id", organizationId).eq("name", fixture.customerName),
  supabase.from("bills").select("id,bill_number,status,customer_name").eq("organization_id", organizationId).in("bill_number", [fixture.originalBillNumber, fixture.replacementBillNumber]),
  supabase.from("inventory_items").select("id,name,active").eq("organization_id", organizationId).eq("name", fixture.itemName),
  supabase.from("inventory_items").select("id,barcode,active").eq("organization_id", organizationId).eq("barcode", fixture.itemBarcode),
  supabase.from("bills").select("id,bill_number,status,customer_name,customer_phone,amount_due").eq("organization_id", organizationId).eq("status", "pending").gt("amount_due", 0).order("issued_at", { ascending: false }).limit(1)
]);
for (const [label, result] of Object.entries({ openSessions, openTabs, appState, customers, bills, itemNames, barcodes, pendingBills })) {
  if (result.error) throw new Error(`${label} preflight query failed: ${result.error.message}`);
}

const artifactCollisions = [];
function scan(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (target !== artifactPath && entry.name.includes(runId)) artifactCollisions.push(path.relative(root, target));
    if (entry.isDirectory()) scan(target);
  }
}
scan(path.join(root, "test-artifacts"));

const evidence = {
  runId,
  checkedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  baseUrl,
  organizationId,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  actors: [origin.identity, observer.identity],
  deployedArtifact: bundle,
  fixture,
  pendingReceivable: pendingBills.data[0] ?? null,
  openSessions: openSessions.data,
  openTabs: openTabs.data,
  identityCollisions: { customers: customers.data, bills: bills.data, itemNames: itemNames.data, barcodes: barcodes.data, artifacts: artifactCollisions },
  appState: {
    version: appState.data.version,
    hash: createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex")
  }
};
const collisionsEmpty = Object.values(evidence.identityCollisions).every((rows) => rows.length === 0);
evidence.safeToRun = openSessions.data.length === 0 && openTabs.data.length === 0 && pendingBills.data.length === 1 && collisionsEmpty;

fs.mkdirSync(artifactDirectory, { recursive: true });
if (verifyOnly) {
  if (!fs.existsSync(artifactPath)) throw new Error("The reviewed exact replacement-parity preflight is missing.");
  const reviewed = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (!reviewed.safeToRun || !evidence.safeToRun || JSON.stringify(reviewed) !== JSON.stringify({ ...evidence, checkedAt: reviewed.checkedAt })) {
    throw new Error("reviewed_preflight_drift");
  }
  console.log(JSON.stringify({ status: "verified", artifact: path.relative(root, artifactPath), evidence }, null, 2));
  process.exit(0);
}
fs.writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ status: evidence.safeToRun ? "passed" : "blocked", artifact: path.relative(root, artifactPath), evidence }, null, 2));
if (!evidence.safeToRun) process.exitCode = 2;
