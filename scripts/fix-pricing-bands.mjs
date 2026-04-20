// Updates pricing band times: 10:00-21:00 / 21:00-10:00  →  11:00-22:00 / 22:00-11:00
// Usage: SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/fix-pricing-bands.mjs

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://rrdwbxvuwrbxefarxnse.supabase.co";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!serviceRoleKey) {
  throw new Error("Set SUPABASE_SERVICE_ROLE_KEY before running.");
}

const supabase = createClient(SUPABASE_URL, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const { data: row, error: fetchError } = await supabase
  .from("app_state")
  .select("id, data, version")
  .eq("id", "primary")
  .single();

if (fetchError || !row) {
  throw new Error(`Failed to fetch app_state: ${fetchError?.message}`);
}

const appData = row.data;
const before = appData.pricingRules.map((r) => `  ${r.id}: ${r.label} ${r.startMinute}-${r.endMinute}`).join("\n");
console.log("Before:\n" + before);

const OLD_DAY_START = 600;   // 10:00
const OLD_DAY_END = 1260;    // 21:00
const NEW_DAY_START = 660;   // 11:00
const NEW_DAY_END = 1320;    // 22:00

let changed = 0;
appData.pricingRules = appData.pricingRules.map((rule) => {
  if (rule.startMinute === OLD_DAY_START && rule.endMinute === OLD_DAY_END) {
    changed++;
    return { ...rule, startMinute: NEW_DAY_START, endMinute: NEW_DAY_END };
  }
  if (rule.startMinute === OLD_DAY_END && rule.endMinute === OLD_DAY_START) {
    changed++;
    return { ...rule, startMinute: NEW_DAY_END, endMinute: NEW_DAY_START };
  }
  return rule;
});

const after = appData.pricingRules.map((r) => `  ${r.id}: ${r.label} ${r.startMinute}-${r.endMinute}`).join("\n");
console.log("After:\n" + after);
console.log(`Rules changed: ${changed}`);

if (changed === 0) {
  console.log("Nothing to update — rules already correct or did not match expected values.");
  process.exit(0);
}

const { error: updateError } = await supabase
  .from("app_state")
  .update({ data: appData, version: row.version + 1 })
  .eq("id", "primary")
  .eq("version", row.version);

if (updateError) {
  throw new Error(`Failed to update app_state: ${updateError.message}`);
}

console.log("Done. Production pricing bands updated successfully.");
