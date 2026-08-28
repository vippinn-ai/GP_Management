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
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };
const organizationId = "org-primary";
const scenarios = ["checkout_first", "combo_first", "simultaneous"];
const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => !new Set(["--discover", "--verify"]).has(argument))) {
  throw new Error("Combo-race preflight accepts only --discover or --verify.");
}
const discoveryOnly = args[0] === "--discover";
const verificationOnly = args[0] === "--verify";

assertStagingSupabaseEnvironment(stagingEnv, true);
const baseUrl = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
assertLiveCredentials(env);
if (!env.E2E_RUN_ID?.trim()) throw new Error("An explicit E2E_RUN_ID is required for combo-race preflight.");
const runId = sanitizeRunId(env.E2E_RUN_ID);
const stationName = env.E2E_REPEAT_COMBO_STATION?.trim() || "8 Ball Pool";
const requestedComboId = env.E2E_REPEAT_COMBO_ID?.trim() || null;
if (!discoveryOnly && !requestedComboId) {
  throw new Error("E2E_REPEAT_COMBO_ID must explicitly select the approved positive-price QA combo.");
}

async function verifyDeployedArtifact() {
  const htmlResponse = await fetch(baseUrl, { redirect: "error" });
  if (!htmlResponse.ok) throw new Error(`Unable to read the staging application shell (${htmlResponse.status}).`);
  const html = await htmlResponse.text();
  const scriptPath = html.match(/<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i)?.[1];
  if (!scriptPath) throw new Error("Unable to identify the deployed staging bundle.");
  const bundleUrl = new URL(scriptPath, baseUrl);
  if (bundleUrl.origin !== new URL(STAGING_APP_URL).origin) throw new Error("The staging bundle resolved outside the approved origin.");
  const bundleResponse = await fetch(bundleUrl, { redirect: "error" });
  if (!bundleResponse.ok) throw new Error(`Unable to read the deployed staging bundle (${bundleResponse.status}).`);
  const bundle = await bundleResponse.text();
  if (!bundle.includes(STAGING_PROJECT_REF) || bundle.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error("The deployed bundle failed its staging/production project-reference guard.");
  }
  return { path: bundleUrl.pathname, sha256: createHash("sha256").update(bundle).digest("hex") };
}
const deployedArtifact = await verifyDeployedArtifact();

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey) throw new Error("Ignored staging Supabase configuration is incomplete.");
if (new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Checkout-repeat-combo preflight is locked to the staging Supabase project.");
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
  if (role.error || role.data !== "admin" || profile.error || profile.data?.role !== "admin" || !profile.data.active) {
    throw new Error(`Combo-race preflight requires slot ${slot} to be an active authoritative staging admin.`);
  }
  return {
    client,
    identity: { slot, actorId: login.data.user.id, organizationRole: role.data, profileRole: profile.data.role, active: true }
  };
}

// Resolve identical credential slots sequentially so the username resolver is not raced against itself.
const origin = await authenticateSlot("A");
const observer = await authenticateSlot("B");
const supabase = origin.client;

const queryEntries = await Promise.all([
  supabase.from("sessions").select("id,status,customer_name,station_name_snapshot").eq("organization_id", organizationId).neq("status", "closed"),
  supabase.from("customer_tabs").select("id,status,customer_name").eq("organization_id", organizationId).eq("status", "open"),
  supabase.from("app_state").select("version,data").eq("id", "primary").single(),
  supabase.from("stations").select("id,name,mode,active").eq("organization_id", organizationId).eq("name", stationName),
  supabase.from("combos").select("id,name,type,active,price,included_minutes").eq("organization_id", organizationId).eq("active", true),
  supabase.from("combo_station_targets").select("combo_id,station_id").eq("organization_id", organizationId),
  supabase.from("combo_fixed_items").select("combo_id,id,sellable_option_id,quantity").eq("organization_id", organizationId),
  supabase.from("combo_choice_groups").select("combo_id,id,label,required_quantity").eq("organization_id", organizationId),
  supabase.from("combo_choice_options").select("combo_id,choice_group_id,option_id").eq("organization_id", organizationId),
  supabase.from("inventory_items").select("id,name,stock_qty,is_reusable,active,sell_base_item").eq("organization_id", organizationId),
  supabase.from("sale_variants").select("id,inventory_item_id,name,stock_units_per_sale,active").eq("organization_id", organizationId),
  supabase.from("sessions").select("id,customer_name,status").eq("organization_id", organizationId).like("customer_name", `QA Combo Race ${runId}%`),
  supabase.from("bills").select("id,bill_number,status").eq("organization_id", organizationId).in("bill_number", scenarios.map((scenario) => `BILL-QA-COMBO-RACE-${runId}-${scenario}`))
]);
const labels = ["openSessions", "openTabs", "appState", "stations", "combos", "targets", "fixedItems", "choiceGroups", "choiceOptions", "inventory", "variants", "runSessions", "runBills"];
const results = Object.fromEntries(labels.map((label, index) => [label, queryEntries[index]]));
for (const [label, result] of Object.entries(results)) {
  if (result.error) throw new Error(`${label} preflight query failed: ${result.error.message}`);
}

const stationRows = results.stations.data;
const station = stationRows.length === 1 && stationRows[0].active && stationRows[0].mode === "timed" ? stationRows[0] : null;
const inventoryById = new Map(results.inventory.data.map((item) => [item.id, item]));
const optionById = new Map();
for (const item of results.inventory.data) {
  if (item.active && item.sell_base_item) optionById.set(item.id, { item, units: 1, optionId: item.id, optionName: item.name });
}
for (const variant of results.variants.data) {
  const item = inventoryById.get(variant.inventory_item_id);
  if (variant.active && item?.active) optionById.set(variant.id, {
    item,
    units: Number(variant.stock_units_per_sale),
    optionId: variant.id,
    optionName: variant.name
  });
}

function evaluateCombo(combo) {
  if (!station || combo.type !== "game" || Number(combo.price) <= 0) return null;
  if (!results.targets.data.some((target) => target.combo_id === combo.id && target.station_id === station.id)) return null;
  const selections = [];
  for (const fixed of results.fixedItems.data.filter((row) => row.combo_id === combo.id)) {
    const option = optionById.get(fixed.sellable_option_id);
    if (!option) return null;
    selections.push({ ...option, quantity: Number(fixed.quantity), source: `fixed:${fixed.id}` });
  }
  const choiceSelections = [];
  for (const group of results.choiceGroups.data.filter((row) => row.combo_id === combo.id).sort((a, b) => a.id.localeCompare(b.id))) {
    const options = results.choiceOptions.data
      .filter((row) => row.combo_id === combo.id && row.choice_group_id === group.id)
      .map((row) => optionById.get(row.option_id))
      .filter(Boolean)
      .sort((a, b) => a.optionId.localeCompare(b.optionId));
    if (options.length === 0) return null;
    for (let index = 0; index < Number(group.required_quantity); index += 1) {
      const option = options[index % options.length];
      choiceSelections.push({
        groupId: group.id,
        label: Number(group.required_quantity) > 1 ? `${group.label} ${index + 1}` : group.label,
        optionId: option.optionId,
        optionName: option.optionName
      });
      selections.push({ ...option, quantity: 1, source: `choice:${group.id}:${index}` });
    }
  }
  if (selections.length === 0 || !selections.some((selection) => !selection.item.is_reusable)) return null;
  const stockRequired = new Map();
  for (const selection of selections) {
    const existing = stockRequired.get(selection.item.id) ?? {
      item: selection.item,
      unitsPerApplication: 0
    };
    existing.unitsPerApplication += selection.quantity * selection.units;
    stockRequired.set(selection.item.id, existing);
  }
  const stockEvidence = [...stockRequired.entries()].map(([itemId, requirement]) => {
    const { item, unitsPerApplication } = requirement;
    return {
      itemId,
      name: item.name,
      stockQty: Number(item.stock_qty),
      isReusable: Boolean(item.is_reusable),
      unitsPerApplication,
      requiredRunCapacity: unitsPerApplication * (item.is_reusable ? 2 : 3)
    };
  });
  const sufficient = stockEvidence.every((entry) => entry.stockQty >= entry.requiredRunCapacity);
  return { combo, choiceSelections, stockEvidence, sufficient };
}

const evaluatedCandidates = results.combos.data
  .filter((combo) => !requestedComboId || combo.id === requestedComboId)
  .map(evaluateCombo)
  .filter(Boolean)
  .sort((left, right) => left.combo.id.localeCompare(right.combo.id));
const candidates = evaluatedCandidates.filter((candidate) => candidate.sufficient);
const selected = candidates[0] ?? null;
const requestedFixtureEvaluation = requestedComboId
  ? evaluatedCandidates.find((candidate) => candidate.combo.id === requestedComboId) ?? null
  : null;

const artifactRoot = path.join(root, "test-artifacts");
const artifactDirectory = path.join(artifactRoot, "preflight");
const artifactPath = path.join(artifactDirectory, `checkout-repeat-combo-race-preflight-${runId}.json`);
const artifactCollisions = [];
function findArtifactCollisions(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entryPath !== artifactPath && entry.name.includes(runId)) artifactCollisions.push(path.relative(root, entryPath));
    if (entry.isDirectory()) findArtifactCollisions(entryPath);
  }
}
findArtifactCollisions(artifactRoot);

if (discoveryOnly) {
  console.log(JSON.stringify({
    status: "discovery",
    projectRef: STAGING_PROJECT_REF,
    station,
    eligibleFixtures: candidates.map((candidate) => ({
      combo: candidate.combo,
      choiceSelections: candidate.choiceSelections,
      stockEvidence: candidate.stockEvidence
    })),
    rejectedFixtures: evaluatedCandidates.filter((candidate) => !candidate.sufficient).map((candidate) => ({
      combo: candidate.combo,
      choiceSelections: candidate.choiceSelections,
      stockEvidence: candidate.stockEvidence
    })),
    productionAllowed: false
  }, null, 2));
  process.exit(0);
}

const identityIsFresh = results.runSessions.data.length === 0 && results.runBills.data.length === 0 && artifactCollisions.length === 0;
const safeToRun =
  results.openSessions.data.length === 0 &&
  results.openTabs.data.length === 0 &&
  station !== null &&
  selected !== null &&
  identityIsFresh;
const evidence = {
  runId,
  checkedAt: new Date().toISOString(),
  baseUrl,
  projectRef: STAGING_PROJECT_REF,
  deployedArtifact,
  organizationId,
  actors: [origin.identity, observer.identity],
  openSessions: results.openSessions.data,
  openCustomerTabs: results.openTabs.data,
  fixture: selected ? {
    station,
    combo: selected.combo,
    choiceSelections: selected.choiceSelections,
    stockEvidence: selected.stockEvidence
  } : null,
  requestedFixtureEvaluation: requestedFixtureEvaluation ? {
    combo: requestedFixtureEvaluation.combo,
    choiceSelections: requestedFixtureEvaluation.choiceSelections,
    stockEvidence: requestedFixtureEvaluation.stockEvidence,
    sufficient: requestedFixtureEvaluation.sufficient
  } : null,
  identityCollisions: { sessions: results.runSessions.data, bills: results.runBills.data, artifacts: artifactCollisions },
  appState: {
    version: results.appState.data.version,
    hash: createHash("sha256").update(JSON.stringify(results.appState.data.data)).digest("hex")
  },
  safeToRun
};
fs.mkdirSync(artifactDirectory, { recursive: true });
const result = { status: safeToRun ? "passed" : "blocked", artifact: path.relative(root, artifactPath), evidence };
if (verificationOnly) {
  if (!fs.existsSync(artifactPath)) throw new Error("The reviewed exact combo-race preflight artifact is missing.");
  const reviewed = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const verified = safeToRun &&
    reviewed.safeToRun === true &&
    reviewed.runId === evidence.runId &&
    reviewed.projectRef === evidence.projectRef &&
    reviewed.deployedArtifact?.path === evidence.deployedArtifact.path &&
    reviewed.deployedArtifact?.sha256 === evidence.deployedArtifact.sha256 &&
    JSON.stringify(reviewed.actors) === JSON.stringify(evidence.actors) &&
    JSON.stringify(reviewed.fixture) === JSON.stringify(evidence.fixture) &&
    reviewed.appState?.version === evidence.appState.version &&
    reviewed.appState?.hash === evidence.appState.hash;
  if (!verified) {
    console.error(JSON.stringify({ status: "blocked", reason: "reviewed_preflight_drift", reviewed, current: evidence }, null, 2));
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify({ status: "verified", artifact: path.relative(root, artifactPath), evidence }, null, 2));
  }
} else if (!safeToRun) {
  fs.writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 2;
} else {
  fs.writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify(result, null, 2));
}
