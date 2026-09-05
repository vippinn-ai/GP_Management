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
const organizationId = "org-primary";
const env = { ...parseEnvFile(path.join(root, ".env.e2e.local")), ...process.env };
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);
if (!env.E2E_RUN_ID?.trim()) throw new Error("An explicit E2E_RUN_ID is required.");
const runId = sanitizeRunId(env.E2E_RUN_ID);

function findOne(directory, pattern) {
  const matches = [];
  function visit(target) {
    if (!fs.existsSync(target)) return;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const fullPath = path.join(target, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (pattern.test(entry.name)) matches.push(fullPath);
    }
  }
  visit(directory);
  if (matches.length !== 1) throw new Error(`Expected one evidence file, found ${matches.length}.`);
  return matches[0];
}

const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-replacement-parity-preflight-${runId}.json`);
if (!fs.existsSync(preflightPath)) throw new Error("The exact preflight evidence is missing.");
const browserRoot = path.join(root, "test-artifacts", "playwright", `v2-run-${runId}`);
const browserEvidencePath = findOne(browserRoot, /^release-b-replacement-v2-evidence-.+\.json$/);
const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
const browser = JSON.parse(fs.readFileSync(browserEvidencePath, "utf8"));
if (preflight.runId !== runId || browser.runId !== runId || !preflight.safeToRun) {
  throw new Error("Evidence lineage does not match the requested safe run.");
}

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const anonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !anonKey || new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Reconciliation is locked to staging.");
}
const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const lookup = await client.functions.invoke("resolve-login-email", { body: { username: env.E2E_USER_A.trim() } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve staging login.");
const login = await client.auth.signInWithPassword({ email: lookup.data.email, password: env.E2E_PASSWORD_A });
if (login.error || !login.data.user) throw new Error("Unable to authenticate staging reconciliation.");

async function rows(label, request) {
  const result = await request;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data ?? [];
}

const originalBillId = browser.originalResult.billId;
const replacementBillId = browser.replacementResult.billId;
const billIds = [originalBillId, replacementBillId];
const paymentIds = [browser.originalResult.changedRows.payments[0], browser.replacementResult.changedRows.payments[0]];
const eventIds = [browser.originalResult.eventId, browser.replacementResult.eventId];
const mutationIds = [browser.originalResult.mutationId, browser.replacementResult.mutationId];
const sessionId = browser.originalResult.entityId;

const [bills, lines, payments, audits, events, session, appState, mutationResults] = await Promise.all([
  rows("bills", client.from("bills").select("id,bill_number,status,total,amount_paid,amount_due,payment_mode,replacement_of_bill_id,replaced_by_bill_id,replaced_by_user_id,issued_by_user_id").eq("organization_id", organizationId).in("id", billIds)),
  rows("lines", client.from("bill_lines").select("id,bill_id,type,description,quantity,unit_price,subtotal,discount_amount,total,linked_session_id").eq("organization_id", organizationId).in("bill_id", billIds)),
  rows("payments", client.from("payments").select("id,bill_id,mode,amount,received_by_user_id").eq("organization_id", organizationId).in("id", paymentIds)),
  rows("audits", client.from("audit_logs").select("id,action,entity_type,entity_id,message,user_id").eq("organization_id", organizationId).in("entity_id", billIds)),
  rows("events", client.from("operational_events").select("id,event_type,entity_type,entity_id,metadata,created_by").eq("organization_id", organizationId).in("id", eventIds)),
  client.from("sessions").select("id,status,close_disposition,closed_bill_id").eq("organization_id", organizationId).eq("id", sessionId).single(),
  client.from("app_state").select("version,data").eq("id", "primary").single(),
  Promise.all(mutationIds.map(async (mutationId) => {
    const result = await client.rpc("get_financial_mutation_result", {
      payload: { organization_id: organizationId, mutation_id: mutationId, mutation_kind: "commitCheckoutBill" }
    });
    if (result.error) throw new Error(`mutation ${mutationId}: ${result.error.message}`);
    return result.data;
  }))
]);
if (session.error) throw new Error(`session: ${session.error.message}`);
if (appState.error) throw new Error(`app_state: ${appState.error.message}`);

const original = bills.find((bill) => bill.id === originalBillId);
const replacement = bills.find((bill) => bill.id === replacementBillId);
const originalPayment = payments.find((payment) => payment.bill_id === originalBillId);
const replacementPayment = payments.find((payment) => payment.bill_id === replacementBillId);
const originalLine = lines.find((line) => line.bill_id === originalBillId);
const replacementLine = lines.find((line) => line.bill_id === replacementBillId);
const postHash = createHash("sha256").update(JSON.stringify(appState.data.data)).digest("hex");
const failures = [];
function check(condition, message) { if (!condition) failures.push(message); }
check(bills.length === 2, "Expected exactly two traced bills.");
check(original?.status === "replaced" && original.replaced_by_bill_id === replacementBillId, "Original bill linkage/status mismatch.");
check(replacement?.status === "issued" && replacement.replacement_of_bill_id === originalBillId, "Replacement bill linkage/status mismatch.");
check(originalPayment?.mode === browser.originalPaymentMode, "Original payment mode mismatch.");
check(replacementPayment?.mode === browser.replacementPaymentMode, "Replacement payment mode mismatch.");
check(payments.length === 2, "Expected exactly one traced payment per bill.");
check(lines.length === 2 && originalLine?.type === "session_charge" && replacementLine?.type === "session_charge", "Expected one session line per bill.");
check(originalLine?.linked_session_id === sessionId && replacementLine?.linked_session_id === sessionId, "Session linkage was not preserved.");
check(Number(originalLine?.unit_price) === Number(replacementLine?.unit_price), "Replacement changed the immutable normalized session rate.");
check(session.data?.status === "closed" && session.data?.close_disposition === "billed" && session.data?.closed_bill_id === originalBillId, "Original session lifecycle changed.");
check(audits.filter((audit) => audit.action === "bill_replaced" && audit.entity_id === replacementBillId).length === 1, "Replacement audit mismatch.");
check(events.length === 2 && events.every((event) => event.event_type === "financial_checkout_committed_v2"), "Compact event evidence mismatch.");
check(
  mutationResults.length === 2
    && mutationResults.every((result) => mutationIds.includes(result?.mutation_id))
    && mutationResults.some((result) => result?.bill_id === originalBillId)
    && mutationResults.some((result) => result?.bill_id === replacementBillId),
  "Canonical mutation recovery results do not match both committed bills."
);
check(appState.data.version === preflight.appState.version && postHash === preflight.appState.hash, "app_state changed during v2 checkout/replacement.");

const evidence = {
  status: failures.length === 0 ? "passed" : "failed",
  checkedAt: new Date().toISOString(),
  runId,
  projectRef: STAGING_PROJECT_REF,
  productionAllowed: false,
  browserEvidence: path.relative(root, browserEvidencePath),
  preflightEvidence: path.relative(root, preflightPath),
  appState: { version: appState.data.version, hash: postHash, unchanged: appState.data.version === preflight.appState.version && postHash === preflight.appState.hash },
  bills,
  lines,
  payments,
  audits,
  events,
  session: session.data,
  mutationResults,
  failures
};
const outputPath = path.join(root, "test-artifacts", "evidence", `session-replacement-reconciliation-${runId}-verified.json`);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ status: evidence.status, artifact: path.relative(root, outputPath), failures, appState: evidence.appState }, null, 2));
await client.auth.signOut({ scope: "local" });
if (failures.length > 0) process.exitCode = 1;
