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
const timedStationName = "8 Ball Pool";
const cases = ["discount_rounding_positive", "ltp_zero", "bill_discount_zero", "true_zero_price_guard"];
const args = process.argv.slice(2);
const verifyOnly = args.includes("--verify");
const caseArgs = args.filter((argument) => argument.startsWith("--case="));
if (args.some((argument) => argument !== "--verify" && !argument.startsWith("--case=")) ||
    caseArgs.length !== 1 || args.filter((argument) => argument === "--verify").length > 1) {
  throw new Error("Pricing preflight accepts exactly one --case=<case> and optional --verify.");
}
const selectedCase = caseArgs[0].slice("--case=".length);
if (!cases.includes(selectedCase)) throw new Error(`Pricing case must be exactly one of: ${cases.join(", ")}.`);

const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
const baseUrl = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
assertLiveCredentials(env);
if (!env.E2E_RUN_ID?.trim()) throw new Error("An explicit E2E_RUN_ID is required.");
const runId = sanitizeRunId(env.E2E_RUN_ID);
if (env.E2E_PRICING_CASE && env.E2E_PRICING_CASE !== selectedCase) {
  throw new Error("The pricing case does not match its exact environment binding.");
}

const customerName = `QA Pricing ${selectedCase.replaceAll("_", " ")} ${runId}`;
const itemName = `QA Zero Arcade ${runId}`;
const itemBarcode = `QA-ZERO-${runId}`;
const artifactDirectory = path.join(root, "test-artifacts", "preflight");
const artifactPath = path.join(artifactDirectory, `checkout-pricing-preflight-${selectedCase}-${runId}.json`);

async function deployedArtifact() {
  const htmlResponse = await fetch(baseUrl, { redirect: "error" });
  if (!htmlResponse.ok) throw new Error(`Unable to read staging shell (${htmlResponse.status}).`);
  const html = await htmlResponse.text();
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
if (new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) throw new Error("Pricing preflight is locked to staging.");

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
const [artifact, openSessions, openTabs, appState, timedStations, unitStations, pricingRules, sessionCollisions, billCollisions, itemNameCollisions, barcodeCollisions] = await Promise.all([
  deployedArtifact(),
  supabase.from("sessions").select("id,status,customer_name,station_name_snapshot").eq("organization_id", organizationId).neq("status", "closed"),
  supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single(),
  supabase.from("stations").select("id,name,mode,active,ltp_enabled").eq("organization_id", organizationId).eq("name", timedStationName),
  supabase.from("stations").select("id,name,mode,active,ltp_enabled").eq("organization_id", organizationId).eq("mode", "unit_sale").eq("active", true).order("name"),
  supabase.from("pricing_rules").select("id,station_id,label,start_minute,end_minute,hourly_rate").eq("organization_id", organizationId),
  supabase.from("sessions").select("id,status,customer_name,closed_bill_id").eq("organization_id", organizationId).eq("customer_name", customerName),
  supabase.from("bills").select("id,bill_number,status,customer_name").eq("organization_id", organizationId).eq("customer_name", customerName),
  supabase.from("inventory_items").select("id,name,active").eq("organization_id", organizationId).eq("name", itemName),
  supabase.from("inventory_items").select("id,barcode,active").eq("organization_id", organizationId).eq("barcode", itemBarcode)
]);
for (const [label, result] of Object.entries({ openSessions, openTabs, appState, timedStations, unitStations, pricingRules, sessionCollisions, billCollisions, itemNameCollisions, barcodeCollisions })) {
  if (result.error) throw new Error(`${label} preflight query failed: ${result.error.message}`);
}

const timedStation = timedStations.data[0];
const unitStation = unitStations.data[0];
const stationPricing = pricingRules.data.filter((rule) => rule.station_id === timedStation?.id || rule.station_id === null);
const artifactCollisions = [];
function scan(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entryPath !== artifactPath && entry.name.includes(runId)) artifactCollisions.push(path.relative(root, entryPath));
    if (entry.isDirectory()) scan(entryPath);
  }
}
scan(path.join(root, "test-artifacts"));

const evidence = {
  runId, selectedCase, checkedAt: new Date().toISOString(), projectRef: STAGING_PROJECT_REF, baseUrl,
  organizationId, productionAllowed: false, safeForAutomaticRetry: false,
  actors: [origin.identity, observer.identity], deployedArtifact: artifact,
  fixture: { customerName, timedStationName, unitStationName: unitStation?.name ?? null, unitStationId: unitStation?.id ?? null, itemName, itemBarcode },
  timedStation, unitStation, stationPricing,
  openSessions: openSessions.data, openTabs: openTabs.data,
  identityCollisions: { sessions: sessionCollisions.data, bills: billCollisions.data, itemNames: itemNameCollisions.data, barcodes: barcodeCollisions.data, artifacts: artifactCollisions },
  appState: { version: appState.data.version, hash: createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex") }
};
const collisionsEmpty = Object.values(evidence.identityCollisions).every((rows) => rows.length === 0);
evidence.safeToRun =
  openSessions.data.length === 0 && openTabs.data.length === 0 && timedStations.data.length === 1 &&
  timedStation?.mode === "timed" && timedStation.active === true && timedStation.ltp_enabled === true && stationPricing.length > 0 &&
  (selectedCase !== "true_zero_price_guard" || unitStations.data.length > 0) && collisionsEmpty;

fs.mkdirSync(artifactDirectory, { recursive: true });
if (verifyOnly) {
  if (!fs.existsSync(artifactPath)) throw new Error("The reviewed exact pricing preflight artifact is missing.");
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
