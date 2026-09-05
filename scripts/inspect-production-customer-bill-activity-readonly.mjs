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

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const match = arg.match(/^--([a-z-]+)=(.+)$/);
  if (!match) throw new Error("Usage: --name=Vansh --date=2026-09-05");
  return [match[1], match[2]];
}));
const name = args.name?.trim();
const date = args.date?.trim();
if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new Error("Both --name and --date=YYYY-MM-DD are required.");

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
if (role.error || role.data !== "admin") throw new Error("Production activity inspection requires an active admin read identity.");

const from = new Date(`${date}T00:00:00+05:30`);
const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
const fromIso = from.toISOString();
const toIso = to.toISOString();
const nameFilter = `%${name.replace(/\s+/g, "%")}%`;

async function rows(label, query) {
  const result = await query;
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  return result.data ?? [];
}

const targetBills = await rows("target bills", client.from("bills")
  .select("id,bill_number,status,customer_id,customer_name,customer_phone,payment_mode,station_id,session_id,total,amount_paid,amount_due,issued_at,issued_by_user_id,replacement_of_bill_id,replaced_by_bill_id,replaced_at,replaced_by_user_id,replace_reason")
  .eq("organization_id", organizationId)
  .ilike("customer_name", nameFilter)
  .gte("issued_at", fromIso)
  .lt("issued_at", toIso)
  .order("issued_at", { ascending: true }));

const relatedIds = new Set(targetBills.flatMap((bill) => [bill.id, bill.replacement_of_bill_id, bill.replaced_by_bill_id]).filter(Boolean));
let relatedBills = [];
if (relatedIds.size) {
  relatedBills = await rows("related bills", client.from("bills")
    .select("id,bill_number,status,customer_id,customer_name,customer_phone,payment_mode,station_id,session_id,total,amount_paid,amount_due,issued_at,issued_by_user_id,replacement_of_bill_id,replaced_by_bill_id,replaced_at,replaced_by_user_id,replace_reason")
    .eq("organization_id", organizationId)
    .in("id", [...relatedIds])
    .order("issued_at", { ascending: true }));
}
const billIds = relatedBills.map((bill) => bill.id);
const billNumbers = relatedBills.map((bill) => bill.bill_number);
const sessionIds = [...new Set(relatedBills.map((bill) => bill.session_id).filter(Boolean))];

const neighborhoodFromIso = targetBills.length
  ? new Date(Math.min(...targetBills.map((bill) => new Date(bill.issued_at).getTime())) - 30 * 60 * 1000).toISOString()
  : fromIso;
const neighborhoodToIso = targetBills.length
  ? new Date(Math.max(...targetBills.map((bill) => new Date(bill.issued_at).getTime())) + 30 * 60 * 1000).toISOString()
  : toIso;

const [lines, payments, stockMovements, sessions, dayAudits, dayEvents, neighboringBills] = await Promise.all([
  billIds.length ? rows("bill lines", client.from("bill_lines").select("id,bill_id,type,description,quantity,unit_price,subtotal,discount_amount,total,linked_session_id,inventory_item_id,sold_as_pack_of,sale_variant_id,stock_units_per_sale,combo_application_id,combo_id,raw_data").eq("organization_id", organizationId).in("bill_id", billIds).order("bill_id").order("id")) : [],
  billIds.length ? rows("payments", client.from("payments").select("id,bill_id,mode,amount,created_at,received_by_user_id,settlement_group_id,related_checkout_bill_id").eq("organization_id", organizationId).in("bill_id", billIds).order("created_at")) : [],
  billIds.length ? rows("stock movements", client.from("stock_movements").select("id,item_id,type,quantity,reason,created_at,user_id,related_bill_id").eq("organization_id", organizationId).in("related_bill_id", billIds).order("created_at")) : [],
  sessionIds.length ? rows("sessions", client.from("sessions").select("id,station_id,station_name_snapshot,status,started_at,ended_at,customer_id,customer_name,close_disposition,closed_bill_id,close_reason").eq("organization_id", organizationId).in("id", sessionIds)) : [],
  rows("day audits", client.from("audit_logs").select("id,action,entity_type,entity_id,message,created_at,user_id").eq("organization_id", organizationId).gte("created_at", fromIso).lt("created_at", toIso).order("created_at")),
  rows("day events", client.from("operational_events").select("id,event_type,entity_type,entity_id,created_at,created_by,metadata").eq("organization_id", organizationId).gte("created_at", fromIso).lt("created_at", toIso).order("created_at")),
  targetBills.length ? rows("neighboring bills", client.from("bills").select("id,bill_number,status,customer_name,payment_mode,total,issued_at,issued_by_user_id,replacement_of_bill_id,replaced_by_bill_id").eq("organization_id", organizationId).gte("issued_at", neighborhoodFromIso).lt("issued_at", neighborhoodToIso).order("issued_at")) : []
]);

const relevantAudits = dayAudits.filter((audit) =>
  relatedIds.has(audit.entity_id) || billNumbers.some((number) => audit.message?.includes(number))
);
const relevantEvents = dayEvents.filter((event) =>
  relatedIds.has(event.entity_id) || billIds.some((billId) => JSON.stringify(event.metadata ?? {}).includes(billId))
);
const actorIds = [...new Set([
  ...relatedBills.flatMap((bill) => [bill.issued_by_user_id, bill.replaced_by_user_id]),
  ...payments.map((payment) => payment.received_by_user_id),
  ...relevantAudits.map((audit) => audit.user_id),
  ...relevantEvents.map((event) => event.created_by)
].filter(Boolean))];
const actors = actorIds.length ? await rows("actors", client.from("profiles").select("id,username,name,role,active").in("id", actorIds)) : [];

const output = {
  status: targetBills.length ? "matched" : "no-match",
  checkedAt: new Date().toISOString(),
  projectRef: PRODUCTION_PROJECT_REF,
  productionAllowed: false,
  mode: "read-only",
  criteria: { name, nameFilter, date, timezone: "Asia/Calcutta", fromIso, toIso },
  targetBills,
  neighborhood: { fromIso: neighborhoodFromIso, toIso: neighborhoodToIso, bills: neighboringBills },
  relatedBills,
  lines,
  payments,
  stockMovements,
  sessions,
  audits: relevantAudits,
  events: relevantEvents,
  actors
};
console.log(JSON.stringify(output, null, 2));
await client.auth.signOut({ scope: "local" });
