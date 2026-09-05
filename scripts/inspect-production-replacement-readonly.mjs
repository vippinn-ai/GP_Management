import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const PRODUCTION_PROJECT_REF = "rrdwbxvuwrbxefarxnse";
const organizationId = "org-primary";

function readEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(fs.readFileSync(filePath, "utf8").split(/\r?\n/).flatMap((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) return [];
    const splitAt = line.indexOf("=");
    let value = line.slice(splitAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return [[line.slice(0, splitAt).trim(), value]];
  }));
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !/^--hours=\d+$/.test(args[0]))) {
  throw new Error("Usage: node scripts/inspect-production-replacement-readonly.mjs [--hours=N]");
}
const hours = args[0] ? Number(args[0].slice("--hours=".length)) : 168;
if (!Number.isInteger(hours) || hours < 1 || hours > 744) throw new Error("Hours must be between 1 and 744.");

const productionEnv = readEnv(".env.production");
const localEnv = { ...readEnv(".env.e2e.local"), ...process.env };
const supabaseUrl = productionEnv.VITE_SUPABASE_URL?.trim();
const anonKey = productionEnv.VITE_SUPABASE_ANON_KEY?.trim();
const username = localEnv.PRODUCTION_READONLY_USER?.trim() || localEnv.E2E_USER_A?.trim();
const password = localEnv.PRODUCTION_READONLY_PASSWORD?.trim() || localEnv.E2E_PASSWORD_A?.trim();
if (!supabaseUrl || !anonKey || !username || !password) throw new Error("Production read-only configuration is incomplete.");
if (new URL(supabaseUrl).hostname !== `${PRODUCTION_PROJECT_REF}.supabase.co`) throw new Error("This inspector is locked to production.");

const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const lookup = await client.functions.invoke("resolve-login-email", { body: { username } });
if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve the production read-only login.");
const login = await client.auth.signInWithPassword({ email: lookup.data.email, password });
if (login.error || !login.data.user) throw new Error("Unable to authenticate the production read-only login.");
const role = await client.rpc("current_user_org_role", { target_organization_id: organizationId });
if (role.error || role.data !== "admin") throw new Error("Production replacement inspection requires an active admin read identity.");

const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
const queries = await Promise.all([
  client.from("bills").select("id,bill_number,status,payment_mode,issued_at,replacement_of_bill_id,replace_reason,issued_by_user_id").eq("organization_id", organizationId).not("replacement_of_bill_id", "is", null).gte("issued_at", since).order("issued_at", { ascending: false }).limit(100),
  client.from("bills").select("id,bill_number,status,payment_mode,issued_at,replaced_at,replaced_by_bill_id,replace_reason,replaced_by_user_id").eq("organization_id", organizationId).eq("status", "replaced").gte("replaced_at", since).order("replaced_at", { ascending: false }).limit(100),
  client.from("audit_logs").select("id,action,entity_id,message,user_id,created_at").eq("organization_id", organizationId).eq("action", "bill_replaced").gte("created_at", since).order("created_at", { ascending: false }).limit(100),
  client.from("financial_mutations").select("mutation_id,mutation_kind,entity_type,entity_id,actor_user_id,status,created_at,committed_at").eq("organization_id", organizationId).eq("mutation_kind", "commitCheckoutBill").eq("entity_type", "bill").gte("created_at", since).order("created_at", { ascending: false }).limit(100)
]);
const labels = ["replacement bills", "replaced originals", "replacement audits", "bill mutations"];
queries.slice(0, 3).forEach((result, index) => {
  if (result.error) throw new Error(`${labels[index]} query failed: ${result.error.message}`);
});
const [replacementBills, replacedOriginals, replacementAudits] = queries.slice(0, 3).map((result) => result.data ?? []);
const billMutations = queries[3].data ?? [];
const billMutationsAvailability = queries[3].error ? "not-readable-by-app-admin" : "available";
const originalIds = new Set(replacedOriginals.map((bill) => bill.id));
const replacementByOriginalId = new Map(replacementBills.map((bill) => [bill.replacement_of_bill_id, bill]));
const incompleteLinks = replacedOriginals.filter((bill) => !bill.replaced_by_bill_id || !replacementByOriginalId.has(bill.id));
const orphanReplacements = replacementBills.filter((bill) => !bill.replacement_of_bill_id || !originalIds.has(bill.replacement_of_bill_id));

console.log(JSON.stringify({
  status: incompleteLinks.length || orphanReplacements.length ? "linkage-review" : "pass",
  checkedAt: new Date().toISOString(),
  projectRef: PRODUCTION_PROJECT_REF,
  productionAllowed: false,
  mode: "read-only",
  window: { hours, since },
  replacementBills,
  replacedOriginals,
  replacementAudits,
  billMutations,
  billMutationsAvailability,
  incompleteLinks,
  orphanReplacements
}, null, 2));

await client.auth.signOut({ scope: "local" });
