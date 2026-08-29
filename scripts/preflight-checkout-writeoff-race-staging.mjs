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

const args = process.argv.slice(2);
const allowedModes = new Set(["--verify", "--remaining-two", "--verify-remaining-two", "--simultaneous-only", "--verify-simultaneous-only"]);
if (args.length > 1 || args.some((argument) => !allowedModes.has(argument))) {
  throw new Error("Checkout-writeoff preflight accepts only full/remaining-two execution or exact verification.");
}
const mode = args[0] ?? "--all";
const verificationOnly = mode === "--verify" || mode === "--verify-remaining-two" || mode === "--verify-simultaneous-only";
const remainingTwo = mode === "--remaining-two" || mode === "--verify-remaining-two";
const simultaneousOnly = mode === "--simultaneous-only" || mode === "--verify-simultaneous-only";
const root = process.cwd();
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const temporaryAdmin = loadSessionItemRaceAdmin(root, { required: true });
const env = { ...localEnv, ...temporaryAdmin.overlay, ...process.env };
assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);
if (env.E2E_CHECKOUT_SETTLEMENT_RACE_MODE && env.E2E_CHECKOUT_SETTLEMENT_RACE_MODE !== "writeoff") {
  throw new Error("Checkout-writeoff preflight requires exact writeoff mode.");
}
if (!env.E2E_RUN_ID?.trim()) throw new Error("An explicit E2E_RUN_ID is required for checkout-writeoff preflight.");
const runId = sanitizeRunId(env.E2E_RUN_ID);
const organizationId = "org-primary";
const baseUrl = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
const scenarios = simultaneousOnly
  ? ["simultaneous"]
  : remainingTwo
    ? ["writeoff_first", "simultaneous"]
    : ["checkout_first", "writeoff_first", "simultaneous"];
const requestedScenarios = (env.E2E_CHECKOUT_WRITEOFF_SCENARIOS ?? scenarios.join(","))
  .split(",").map((value) => value.trim()).filter(Boolean);
if (JSON.stringify(requestedScenarios) !== JSON.stringify(scenarios)) {
  throw new Error("Checkout-writeoff preflight scenario selection does not match its exact mode.");
}
const customerNames = scenarios.map((scenario) => `QA Checkout Writeoff Race ${runId} ${scenario}`);
const candidateBillNumbers = scenarios.map((scenario) => `BILL-QA-WRITEOFF-RACE-${runId}-${scenario}`);
const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey) throw new Error("Ignored staging Supabase configuration is incomplete.");
if (new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Checkout-writeoff preflight is locked to the exact staging project.");
}

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

async function authenticateSlot(slot) {
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const lookup = await client.functions.invoke("resolve-login-email", { body: { username: env[`E2E_USER_${slot}`].trim() } });
  if (lookup.error || !lookup.data?.email) throw new Error(`Unable to resolve staging credential slot ${slot}.`);
  const login = await client.auth.signInWithPassword({ email: lookup.data.email, password: env[`E2E_PASSWORD_${slot}`] });
  if (login.error || !login.data.user) throw new Error(`Unable to authenticate staging credential slot ${slot}.`);
  const [role, profile] = await Promise.all([
    client.rpc("current_user_org_role", { target_organization_id: organizationId }),
    client.from("profiles").select("id,role,active").eq("id", login.data.user.id).single()
  ]);
  if (role.error || role.data !== "admin" || profile.error || profile.data?.role !== "admin" || !profile.data.active) {
    throw new Error(`Checkout-writeoff preflight requires slot ${slot} to be one active authoritative staging admin.`);
  }
  return { client, identity: { slot, actorId: login.data.user.id, role: role.data, active: true } };
}

const origin = await authenticateSlot("A");
const observer = await authenticateSlot("B");
if (origin.identity.actorId === observer.identity.actorId) {
  throw new Error("Checkout-writeoff preflight requires two distinct active staging admin actors.");
}
const supabase = origin.client;
const [artifact, openSessions, openTabs, appState, runSessions, runBillsByCustomer, candidateBills] = await Promise.all([
  deployedArtifact(),
  supabase.from("sessions").select("id,status,customer_name,station_name_snapshot").eq("organization_id", organizationId).neq("status", "closed"),
  supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single(),
  supabase.from("sessions").select("id,customer_name,status").eq("organization_id", organizationId).in("customer_name", customerNames),
  supabase.from("bills").select("id,bill_number,status,customer_name").eq("organization_id", organizationId)
    .in("customer_name", customerNames),
  supabase.from("bills").select("id,bill_number,status,customer_name").eq("organization_id", organizationId)
    .in("bill_number", candidateBillNumbers)
]);
for (const [label, result] of Object.entries({ openSessions, openTabs, appState, runSessions, runBillsByCustomer, candidateBills })) {
  if (result.error) throw new Error(`${label} preflight query failed: ${result.error.message}`);
}

const artifactRoot = path.join(root, "test-artifacts");
const outputDirectory = path.join(root, "test-artifacts", "preflight");
const outputPath = path.join(outputDirectory, `checkout-writeoff-race-preflight-${runId}.json`);
const artifactCollisions = [];
function scan(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (path.resolve(entryPath) !== path.resolve(outputPath) && path.relative(artifactRoot, entryPath).includes(runId)) {
      artifactCollisions.push(path.relative(root, entryPath));
    }
    if (entry.isDirectory()) scan(entryPath);
  }
}
scan(artifactRoot);
const snapshot = {
  openSessions: openSessions.data,
  openTabs: openTabs.data,
  runSessions: runSessions.data,
  runBillsByCustomer: runBillsByCustomer.data,
  candidateBills: candidateBills.data,
  appState: {
    version: appState.data.version,
    hash: createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex")
  }
};
const safeToRun = snapshot.openSessions.length === 0 && snapshot.openTabs.length === 0 &&
  snapshot.runSessions.length === 0 && snapshot.runBillsByCustomer.length === 0 && snapshot.candidateBills.length === 0 &&
  artifactCollisions.length === 0;
const evidence = {
  mode: "writeoff",
  runId,
  checkedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  organizationId,
  baseUrl,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  scenarios,
  actors: [origin.identity, observer.identity],
  actorsDistinct: true,
  temporaryAdmin: {
    accountRunId: temporaryAdmin.accountRunId,
    actorId: temporaryAdmin.actorId,
    createArtifact: path.relative(root, temporaryAdmin.createArtifactPath),
    createArtifactSha256: temporaryAdmin.createArtifactSha256
  },
  deployedArtifact: artifact,
  customerNames,
  candidateBillNumbers,
  artifactCollisions,
  snapshot,
  safeToRun
};
fs.mkdirSync(outputDirectory, { recursive: true });
if (verificationOnly) {
  if (!fs.existsSync(outputPath)) throw new Error("The reviewed immutable checkout-writeoff preflight is missing.");
  const prior = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const unchanged = prior.mode === "writeoff" && prior.runId === runId && prior.projectRef === STAGING_PROJECT_REF &&
    prior.baseUrl === baseUrl && prior.productionAllowed === false && prior.safeForAutomaticRetry === false &&
    prior.safeToRun === true && evidence.safeToRun === true && prior.actorsDistinct === true &&
    JSON.stringify(prior.scenarios) === JSON.stringify(scenarios) &&
    JSON.stringify(prior.actors) === JSON.stringify(evidence.actors) &&
    JSON.stringify(prior.temporaryAdmin) === JSON.stringify(evidence.temporaryAdmin) &&
    JSON.stringify(prior.snapshot) === JSON.stringify(snapshot) &&
    JSON.stringify(prior.customerNames) === JSON.stringify(customerNames) &&
    JSON.stringify(prior.candidateBillNumbers) === JSON.stringify(candidateBillNumbers);
  const artifactUnchanged = prior.deployedArtifact?.path === evidence.deployedArtifact.path &&
    prior.deployedArtifact?.sha256 === evidence.deployedArtifact.sha256 &&
    Array.isArray(prior.artifactCollisions) && prior.artifactCollisions.length === 0 && artifactCollisions.length === 0;
  if (!unchanged || !artifactUnchanged) throw new Error("The live staging state drifted from the reviewed checkout-writeoff preflight.");
  console.log(JSON.stringify({ status: "verified", artifact: path.relative(root, outputPath), evidence }, null, 2));
} else {
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ status: safeToRun ? "passed" : "blocked", artifact: path.relative(root, outputPath), evidence }, null, 2));
  if (!safeToRun) process.exitCode = 2;
}
