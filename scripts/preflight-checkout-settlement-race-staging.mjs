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

const organizationId = "org-primary";
if (!env.E2E_RUN_ID?.trim()) throw new Error("An explicit E2E_RUN_ID is required for the race preflight.");
const runId = sanitizeRunId(env.E2E_RUN_ID);
const retainedBillId = "bill-ea56ff7e-6233-46b0-8514-82cb7851e6f6";
const retainedBillNumber = "BILL-20260827-001";
const customerName = `QA Checkout Settlement Race ${runId}`;
const raceBillNumber = `BILL-QA-SETTLE-RACE-${runId}`;

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey) throw new Error("Ignored staging Supabase configuration is incomplete.");
if (new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Checkout-settlement preflight is locked to the staging Supabase project.");
}

async function authenticateSlot(slot) {
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const lookup = await client.functions.invoke("resolve-login-email", {
    body: { username: env[`E2E_USER_${slot}`].trim() }
  });
  if (lookup.error || !lookup.data?.email) throw new Error(`Unable to resolve staging credential slot ${slot}.`);
  const login = await client.auth.signInWithPassword({
    email: lookup.data.email,
    password: env[`E2E_PASSWORD_${slot}`]
  });
  if (login.error || !login.data.user) throw new Error(`Unable to authenticate staging credential slot ${slot}.`);
  const [role, profile] = await Promise.all([
    client.rpc("current_user_org_role", { target_organization_id: organizationId }),
    client.from("profiles").select("id,role,active").eq("id", login.data.user.id).single()
  ]);
  if (role.error || role.data !== "admin") {
    throw new Error(`Checkout-settlement preflight requires slot ${slot} to be an authoritative staging admin.`);
  }
  if (profile.error || profile.data?.id !== login.data.user.id || profile.data.role !== "admin" || !profile.data.active) {
    throw new Error(`Checkout-settlement preflight requires slot ${slot} to have one active admin profile.`);
  }
  return {
    client,
    identity: {
      slot,
      actorId: login.data.user.id,
      organizationRole: role.data,
      profileRole: profile.data.role,
      active: profile.data.active
    }
  };
}

const [origin, observer] = await Promise.all([authenticateSlot("A"), authenticateSlot("B")]);
const supabase = origin.client;

const [openSessions, openTabs, appState, retainedBills, retainedPayments, runSessions, runBills] = await Promise.all([
  supabase
    .from("sessions")
    .select("id,status,close_disposition,customer_name,station_name_snapshot,started_at,updated_at")
    .eq("organization_id", organizationId)
    .neq("status", "closed")
    .order("started_at", { ascending: true }),
  supabase
    .from("customer_tabs")
    .select("id,status,close_disposition,customer_name,opened_at,updated_at")
    .eq("organization_id", organizationId)
    .eq("status", "open")
    .order("opened_at", { ascending: true }),
  supabase.from("app_state").select("version,data").eq("id", "primary").single(),
  supabase
    .from("bills")
    .select("id,bill_number,status,total,amount_paid,amount_due")
    .eq("organization_id", organizationId)
    .eq("id", retainedBillId),
  supabase
    .from("payments")
    .select("id,bill_id,amount")
    .eq("organization_id", organizationId)
    .eq("bill_id", retainedBillId),
  supabase
    .from("sessions")
    .select("id,customer_name,status")
    .eq("organization_id", organizationId)
    .eq("customer_name", customerName),
  supabase
    .from("bills")
    .select("id,bill_number,status")
    .eq("organization_id", organizationId)
    .eq("bill_number", raceBillNumber)
]);
for (const [label, result] of Object.entries({
  openSessions,
  openTabs,
  appState,
  retainedBills,
  retainedPayments,
  runSessions,
  runBills
})) {
  if (result.error) throw new Error(`${label} preflight query failed: ${result.error.message}`);
}

const artifactRoot = path.join(root, "test-artifacts");
const artifactCollisions = [];
function findArtifactCollisions(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.name.includes(runId)) artifactCollisions.push(path.relative(root, entryPath));
    if (entry.isDirectory()) findArtifactCollisions(entryPath);
  }
}
findArtifactCollisions(artifactRoot);

const retainedBill = retainedBills.data[0];
const retainedBillMatches =
  retainedBills.data.length === 1 &&
  retainedBill.id === retainedBillId &&
  retainedBill.bill_number === retainedBillNumber &&
  retainedBill.status === "pending" &&
  Number(retainedBill.total) === 45 &&
  Number(retainedBill.amount_paid) === 0 &&
  Number(retainedBill.amount_due) === 45 &&
  retainedPayments.data.length === 0;
const identityIsFresh =
  runSessions.data.length === 0 && runBills.data.length === 0 && artifactCollisions.length === 0;
const safeToRun =
  openSessions.data.length === 0 &&
  openTabs.data.length === 0 &&
  retainedBillMatches &&
  identityIsFresh;

const evidence = {
  runId,
  checkedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  organizationId,
  actors: [origin.identity, observer.identity],
  openSessions: openSessions.data,
  openCustomerTabs: openTabs.data,
  retainedBill: retainedBill ?? null,
  retainedPayments: retainedPayments.data,
  identityCollisions: {
    sessions: runSessions.data,
    bills: runBills.data,
    artifacts: artifactCollisions
  },
  appState: {
    version: appState.data.version,
    hash: createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex")
  },
  safeToRun
};
const artifactDirectory = path.join(root, "test-artifacts", "preflight");
fs.mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = path.join(artifactDirectory, `checkout-settlement-race-preflight-${runId}.json`);
fs.writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

if (!safeToRun) {
  console.error(JSON.stringify({ status: "blocked", artifact: path.relative(root, artifactPath), evidence }, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({ status: "passed", artifact: path.relative(root, artifactPath), evidence }, null, 2));
}
