import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configPath = process.argv[2];

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running bootstrap.");
}

if (!configPath) {
  throw new Error("Usage: node scripts/bootstrap-production.mjs <config-json-path>");
}

const rawConfig = await readFile(configPath, "utf8");
const config = JSON.parse(rawConfig);
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

function createHiddenEmail() {
  return `${crypto.randomUUID()}@users.breakperfect.local`;
}

async function ensureUser(userConfig) {
  const { data: existingProfile } = await supabase
    .from("profiles")
    .select("id, auth_email")
    .eq("username", userConfig.username)
    .maybeSingle();

  if (existingProfile) {
    await supabase
      .from("profiles")
      .update({
        name: userConfig.name,
        role: userConfig.role,
        active: userConfig.active ?? true
      })
      .eq("id", existingProfile.id);

    if (userConfig.password) {
      await supabase.auth.admin.updateUserById(existingProfile.id, {
        password: userConfig.password
      });
    }

    return existingProfile.id;
  }

  const hiddenEmail = createHiddenEmail();
  const { data, error } = await supabase.auth.admin.createUser({
    email: hiddenEmail,
    password: userConfig.password,
    email_confirm: true
  });

  if (error || !data.user) {
    throw new Error(error?.message ?? `Unable to create auth user for ${userConfig.username}`);
  }

  const { error: profileError } = await supabase.from("profiles").insert({
    id: data.user.id,
    username: userConfig.username,
    auth_email: hiddenEmail,
    name: userConfig.name,
    role: userConfig.role,
    active: userConfig.active ?? true
  });

  if (profileError) {
    throw new Error(profileError.message);
  }

  return data.user.id;
}

for (const user of config.users ?? []) {
  await ensureUser(user);
}

const appData = {
  businessProfile: config.businessProfile,
  inventoryCategories: config.inventoryCategories ?? [],
  stations: config.stations ?? [],
  pricingRules: config.pricingRules ?? [],
  sessions: [],
  sessionPauseLogs: [],
  customers: [],
  customerTabs: [],
  inventoryItems: config.inventoryItems ?? [],
  stockMovements: [],
  bills: [],
  payments: [],
  auditLogs: [],
  expenses: [],
  expenseTemplates: config.expenseTemplates ?? []
};

const { error: stateError } = await supabase.from("app_state").upsert(
  {
    id: "primary",
    data: appData
  },
  { onConflict: "id" }
);

if (stateError) {
  throw new Error(stateError.message);
}

console.log("Production bootstrap completed.");
