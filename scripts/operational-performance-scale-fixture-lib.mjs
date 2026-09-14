import { createHash } from "node:crypto";

export const STAGING_PROJECT_REF = "tkbdyzxwwbhkpztgjjxh";
export const STAGING_SYSTEM_IDENTIFIER = "7623125441096521075";
export const STAGING_IDENTITY_NONCE = "f9bc0aed-b6c4-410f-ba2a-572522d03869";
export const ORGANIZATION_ID = "org-primary";
export const SCALE_RPC = "get_operational_performance_scale_identity";
export const SCALE_SCHEMA = "qa_performance_scale";
export const SCALE_KEY = "qaPerformanceScaleFixture";

export const SCALE_TABLES = [
  "audit_logs", "bill_discounts", "bill_line_discounts", "bill_lines", "bills",
  "combo_choice_groups", "combo_choice_options", "combo_fixed_items", "combo_station_targets", "combos",
  "customer_tab_combo_applications", "customer_tab_items", "customer_tabs", "customers",
  "expense_template_overrides", "expense_templates", "expenses", "inventory_categories", "inventory_items",
  "operational_events", "payments", "pricing_rules", "sale_variants", "session_combo_applications",
  "session_items", "session_pause_logs", "sessions", "stations", "stock_movements"
].sort();

export const AUXILIARY_IDENTITY_TABLES = [
  "activity_events", "analytics_dirty_dates", "inventory_report_dirty_dates"
].sort();

export const APP_STATE_COLLECTIONS = [
  "auditLogs", "bills", "combos", "customers", "customerTabs", "expenses",
  "expenseTemplateOverrides", "expenseTemplates", "inventoryCategories", "inventoryItems",
  "payments", "pricingRules", "sessionPauseLogs", "sessions", "stations", "stockMovements"
].sort();

export const SHAPE_COUNT_KEYS = [
  "active_inventory_items", "current_business_day_bills", "current_business_day_payments",
  "pending_bills", "recent_stock_movements"
].sort();

export const TEMPORAL_SHAPE_COUNT_KEYS = [
  "current_business_day_bills", "current_business_day_payments", "recent_stock_movements"
].sort();

const SUPPRESSED_TRIGGERS = [
  ["audit_logs", "audit_logs_append_activity"],
  ["operational_events", "operational_events_append_activity"],
  ["bills", "bills_analytics_dirty"],
  ["payments", "payments_analytics_dirty"],
  ["bill_lines", "bill_lines_analytics_dirty"],
  ["bill_discounts", "bill_discounts_analytics_dirty"],
  ["bill_line_discounts", "bill_line_discounts_analytics_dirty"],
  ["expenses", "expenses_analytics_dirty"],
  ["sessions", "sessions_analytics_dirty"],
  ["customer_tabs", "customer_tabs_analytics_dirty"],
  ["stock_movements", "stock_movements_inventory_report_dirty"]
];

const CHILD_ANCHORS = {
  sale_variants: "inventory_items",
  session_pause_logs: "sessions",
  session_items: "sessions",
  session_combo_applications: "sessions",
  customer_tab_items: "customer_tabs",
  customer_tab_combo_applications: "customer_tabs",
  bill_lines: "bills",
  bill_discounts: "bills",
  bill_line_discounts: "bills",
  payments: "bills",
  combo_station_targets: "combos",
  combo_fixed_items: "combos",
  combo_choice_groups: "combos",
  combo_choice_options: "combos",
  expense_template_overrides: "expense_templates"
};

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
const md5Hex = (value) => createHash("md5").update(value).digest("hex");

export function parseJsonBytes(bytes) {
  return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
}

export function extractAppStateCollectionCountsFromCopy(bytes) {
  const text=bytes.toString("utf8");
  const marker="COPY public.app_state (id, data, version, updated_at, updated_by) FROM stdin;";
  const markerIndex=text.indexOf(marker);
  if(markerIndex<0) throw new Error("Production backup lacks the app_state COPY section.");
  const rowStart=text.indexOf("\n",markerIndex)+1;
  const rowEnd=text.indexOf("\n",rowStart);
  if(rowStart<=0||rowEnd<rowStart) throw new Error("Production backup app_state row is incomplete.");
  const fields=text.slice(rowStart,rowEnd).replace(/\r$/,"").split("\t");
  if(fields[0]!=="primary"||fields.length<5) throw new Error("Production backup app_state row is not primary or is malformed.");
  const data=JSON.parse(fields[1]);
  return Object.fromEntries(APP_STATE_COLLECTIONS.map((key)=>{
    if(!Array.isArray(data[key])) throw new Error(`Production app_state collection ${key} is not an array.`);
    return [key,data[key].length];
  }));
}

function extractCopyRows(text, table) {
  const marker=`COPY public.${table} (`;
  const markerIndex=text.indexOf(marker);
  if(markerIndex<0) throw new Error(`Production backup lacks the ${table} COPY section.`);
  const headerEnd=text.indexOf("\n",markerIndex);
  const header=text.slice(markerIndex,headerEnd).replace(/\r$/,"");
  const columns=header.slice(marker.length,header.indexOf(") FROM stdin;")).split(", ");
  const rows=[]; let cursor=headerEnd+1;
  while(cursor>0&&cursor<text.length){
    const end=text.indexOf("\n",cursor);
    if(end<0) throw new Error(`Production backup ${table} COPY section is incomplete.`);
    const line=text.slice(cursor,end).replace(/\r$/,"");
    if(line==="\\.") break;
    rows.push(line.split("\t"));
    cursor=end+1;
  }
  return {columns,rows};
}

export function extractProductionShapeCountsFromCopy(bytes, capturedAt) {
  const text=bytes.toString("utf8");
  const captured=new Date(capturedAt);
  if(Number.isNaN(captured.getTime())) throw new Error("Production capture timestamp is invalid.");
  const businessDate=new Date(captured.getTime()-90*60*1000);
  const currentStart=Date.UTC(businessDate.getUTCFullYear(),businessDate.getUTCMonth(),businessDate.getUTCDate(),1,30);
  const recentStart=currentStart-29*24*60*60*1000;
  const nextStart=currentStart+24*60*60*1000;
  const value=(section,row,name)=>row[section.columns.indexOf(name)];
  const bills=extractCopyRows(text,"bills");
  const payments=extractCopyRows(text,"payments");
  const inventory=extractCopyRows(text,"inventory_items");
  const movements=extractCopyRows(text,"stock_movements");
  const inWindow=(raw,from,to)=>{ const timestamp=Date.parse(raw); return Number.isFinite(timestamp)&&timestamp>=from&&timestamp<to; };
  return {
    active_inventory_items:inventory.rows.filter((row)=>value(inventory,row,"active")==="t").length,
    current_business_day_bills:bills.rows.filter((row)=>inWindow(value(bills,row,"issued_at"),currentStart,nextStart)).length,
    current_business_day_payments:payments.rows.filter((row)=>inWindow(value(payments,row,"paid_at"),currentStart,nextStart)).length,
    pending_bills:bills.rows.filter((row)=>value(bills,row,"status")==="pending").length,
    recent_stock_movements:movements.rows.filter((row)=>inWindow(value(movements,row,"movement_at"),recentStart,nextStart)).length
  };
}

export function unwrapEvidence(value) {
  return value?.evidence ?? value?.[0]?.evidence ?? value;
}

const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;

export const sameCanonical = (left, right) => JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

function validateShapeCounts(shapeCounts) {
  if (
    JSON.stringify(Object.keys(shapeCounts ?? {}).sort()) !== JSON.stringify(SHAPE_COUNT_KEYS)
    || Object.values(shapeCounts ?? {}).some((value) => !Number.isInteger(value) || value < 0)
  ) throw new Error("Scale fixture workload-shape identity is invalid.");
  return shapeCounts;
}

export function stableScaleIdentity(identity) {
  const shapeCounts = validateShapeCounts(identity?.shape_counts);
  return {
    ...identity,
    shape_counts: Object.fromEntries(Object.entries(shapeCounts).filter(([key]) => !TEMPORAL_SHAPE_COUNT_KEYS.includes(key)))
  };
}

export function assertRolloverStableIdentity(current, expected, label = "Scale fixture") {
  if (!sameCanonical(stableScaleIdentity(current), stableScaleIdentity(expected))) {
    throw new Error(`${label} stored identity drift is not a clock-only workload-shape rollover.`);
  }
}

export function validateRunId(runId) {
  if (!/^normops-\d{8}-\d{4}-scale-[a-z0-9-]+$/i.test(runId)) {
    throw new Error("Use --run-id=normops-YYYYMMDD-HHMM-scale-<suffix>.");
  }
  return runId;
}

export function validatePreflight(snapshot) {
  const failures = [];
  if (snapshot.schema_version !== 1) failures.push("schema_version");
  if (snapshot.expected_project_ref !== STAGING_PROJECT_REF) failures.push("project_ref");
  if (snapshot.identity_nonce !== STAGING_IDENTITY_NONCE) failures.push("identity_nonce");
  if (snapshot.organization_id !== ORGANIZATION_ID) failures.push("organization_id");
  if (snapshot.transaction_read_only !== true) failures.push("transaction_read_only");
  for (const field of ["open_sessions", "open_customer_tabs", "recoverable_hopped_sessions", "processing_financial_mutations", "processing_operational_mutations"]) {
    if (snapshot[field] !== 0) failures.push(field);
  }
  if (snapshot.scale_fixture_absent !== true) failures.push("scale_fixture_absent");
  if (snapshot.scale_fixture_key_absent !== true) failures.push("scale_fixture_key_absent");
  if (snapshot.scale_fixture_rpc_absent !== true) failures.push("scale_fixture_rpc_absent");
  if (!Number.isInteger(snapshot.app_state?.version) || snapshot.app_state.version < 0) failures.push("app_state.version");
  if (!Number.isInteger(snapshot.app_state?.bytes) || snapshot.app_state.bytes <= 0) failures.push("app_state.bytes");
  if (!/^[0-9a-f]{32}$/.test(snapshot.app_state?.md5 ?? "")) failures.push("app_state.md5");
  const countKeys = Object.keys(snapshot.public_counts ?? {}).sort();
  const fingerprintKeys = Object.keys(snapshot.public_fingerprints ?? {}).sort();
  const auxiliaryCountKeys = Object.keys(snapshot.auxiliary_counts ?? {}).sort();
  const auxiliaryFingerprintKeys = Object.keys(snapshot.auxiliary_fingerprints ?? {}).sort();
  const appStateCollectionKeys = Object.keys(snapshot.app_state_collection_counts ?? {}).sort();
  const shapeCountKeys = Object.keys(snapshot.shape_counts ?? {}).sort();
  if (JSON.stringify(countKeys) !== JSON.stringify(SCALE_TABLES)) failures.push("public_counts.keys");
  if (JSON.stringify(fingerprintKeys) !== JSON.stringify(SCALE_TABLES)) failures.push("public_fingerprints.keys");
  if (JSON.stringify(auxiliaryCountKeys) !== JSON.stringify(AUXILIARY_IDENTITY_TABLES)) failures.push("auxiliary_counts.keys");
  if (JSON.stringify(auxiliaryFingerprintKeys) !== JSON.stringify(AUXILIARY_IDENTITY_TABLES)) failures.push("auxiliary_fingerprints.keys");
  if (JSON.stringify(appStateCollectionKeys) !== JSON.stringify(APP_STATE_COLLECTIONS)) failures.push("app_state_collection_counts.keys");
  if (JSON.stringify(shapeCountKeys) !== JSON.stringify(SHAPE_COUNT_KEYS)) failures.push("shape_counts.keys");
  if (Object.values(snapshot.public_counts ?? {}).some((value) => !Number.isInteger(value) || value < 0)) failures.push("public_counts.values");
  if (Object.values(snapshot.public_fingerprints ?? {}).some((value) => !/^[0-9a-f]{32}$/.test(value))) failures.push("public_fingerprints.values");
  if (Object.values(snapshot.auxiliary_counts ?? {}).some((value) => !Number.isInteger(value) || value < 0)) failures.push("auxiliary_counts.values");
  if (Object.values(snapshot.auxiliary_fingerprints ?? {}).some((value) => !/^[0-9a-f]{32}$/.test(value))) failures.push("auxiliary_fingerprints.values");
  if (Object.values(snapshot.app_state_collection_counts ?? {}).some((value) => !Number.isInteger(value) || value < 0)) failures.push("app_state_collection_counts.values");
  if (Object.values(snapshot.shape_counts ?? {}).some((value) => !Number.isInteger(value) || value < 0)) failures.push("shape_counts.values");
  if (failures.length) throw new Error(`Scale fixture preflight is invalid: ${failures.join(", ")}.`);
  return snapshot;
}

export function validateProductionBaseline(production) {
  if (production?.status !== "passed" || production?.projectRef !== "rrdwbxvuwrbxefarxnse" || production?.databaseBaseline?.transactionReadOnly !== true) {
    throw new Error("Production scale baseline is not accepted read-only evidence.");
  }
  const counts = production.databaseBaseline.publicCounts ?? {};
  for (const table of SCALE_TABLES) {
    if (!Number.isInteger(counts[table]) || counts[table] < 0) throw new Error(`Production baseline lacks ${table}.`);
  }
  if (!Number.isInteger(production.databaseBaseline.appState?.bytes) || production.databaseBaseline.appState.bytes <= 0 || production.databaseBaseline.appState.dataSelected !== false) {
    throw new Error("Production baseline lacks a safe app_state size identity.");
  }
  return production;
}

export function computeScalePlan(snapshotCounts, productionCounts) {
  const deficits = {};
  const insertCounts = {};
  const targetCounts = {};
  for (const table of SCALE_TABLES) {
    const current = snapshotCounts[table];
    const production = productionCounts[table];
    if (!Number.isInteger(current) || current < 0 || !Number.isInteger(production) || production < 0) throw new Error(`Invalid count for ${table}.`);
    deficits[table] = Math.max(0, production - current);
    insertCounts[table] = deficits[table];
  }
  let changed=true;
  while(changed){
    changed=false;
    for (const [child, parent] of Object.entries(CHILD_ANCHORS)) {
      if (insertCounts[child] > 0 && insertCounts[parent] === 0) {
        insertCounts[parent] = 1;
        changed=true;
      }
    }
  }
  if(insertCounts.combo_choice_options>0&&insertCounts.combo_choice_groups===0) insertCounts.combo_choice_groups=1;
  for (const table of SCALE_TABLES) targetCounts[table] = snapshotCounts[table] + insertCounts[table];
  return { deficits, insertCounts, targetCounts };
}

export function computeAppStateScalePlan(snapshotCounts, productionCounts) {
  const insertCounts={}; const targetCounts={}; const productionTargetCounts={};
  const representationFraction=0.25;
  for(const key of APP_STATE_COLLECTIONS){
    const current=snapshotCounts?.[key]; const production=productionCounts?.[key];
    if(!Number.isInteger(current)||current<0||!Number.isInteger(production)||production<0) throw new Error(`Invalid app_state collection count for ${key}.`);
    const deficit=Math.max(0,production-current);
    insertCounts[key]=deficit===0?0:Math.max(1,Math.ceil(deficit*representationFraction));
    targetCounts[key]=current+insertCounts[key];
    productionTargetCounts[key]=Math.max(current,production);
  }
  return {representationFraction,insertCounts,targetCounts,productionTargetCounts};
}

export function estimateRepresentativeAppStateUpperBoundBytes(snapshotBytes, plan) {
  if (!Number.isInteger(snapshotBytes) || snapshotBytes <= 0) throw new Error("Invalid app_state byte baseline.");
  const topLevelBytes = {
    stations: 400, pricingRules: 350, sessions: 650, sessionPauseLogs: 300, customers: 250,
    customerTabs: 550, inventoryItems: 650, combos: 500, stockMovements: 350, bills: 700,
    payments: 300, auditLogs: 350, expenses: 350, expenseTemplates: 400, expenseTemplateOverrides: 400,
    inventoryCategories: 100
  };
  const nestedBytes = {
    session_items: 350,
    customer_tab_items: 350,
    bill_lines: 350,
    bill_line_discounts: 400,
    sale_variants: 300
  };
  const represented = (count) => count === 0 ? 0 : Math.max(1, Math.ceil(count * plan.appState.representationFraction));
  const structuredAppendBytes = Object.entries(topLevelBytes).reduce(
    (total, [key, bytes]) => total + plan.appState.insertCounts[key] * bytes,
    0
  ) + Object.entries(nestedBytes).reduce(
    (total, [key, bytes]) => total + represented(plan.insertCounts[key]) * bytes,
    0
  );
  return { structuredAppendBytes, prePaddingUpperBoundBytes: snapshotBytes + structuredAppendBytes, paddingBatchUpperBoundBytes: 250 * 350 };
}

export function computeShapeScalePlan(snapshotCounts, productionCounts) {
  const insertCounts={}; const targetCounts={};
  for(const key of SHAPE_COUNT_KEYS){
    const current=snapshotCounts?.[key]; const production=productionCounts?.[key];
    if(!Number.isInteger(current)||current<0||!Number.isInteger(production)||production<0) throw new Error(`Invalid workload-shape count for ${key}.`);
    insertCounts[key]=Math.max(0,production-current);
    targetCounts[key]=current+insertCounts[key];
  }
  return {insertCounts,targetCounts};
}

export function assertSafeGeneratedSql(name, sql) {
  if ((sql.match(/\bbegin;/gi)??[]).length!==1) throw new Error(`${name} must contain exactly one transaction begin.`);
  if ((sql.match(/\b(commit|rollback);/gi)??[]).length!==1) throw new Error(`${name} must contain exactly one transaction terminator.`);
  if (sql.includes("drop schema qa_performance_scale cascade") || /delete[\s\S]*\blike\b/i.test(sql)) throw new Error(`${name} contains unsafe cleanup SQL.`);
  if (sql.includes("__")) throw new Error(`${name} contains an unresolved placeholder.`);
}

const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
const jsonb = (value) => `${q(JSON.stringify(value))}::jsonb`;
const countObjectSql = () => `jsonb_build_object(\n${SCALE_TABLES.map((table) => `    '${table}',(select count(*) from public.${table} where organization_id='${ORGANIZATION_ID}')`).join(",\n")}\n  )`;
const fingerprintObjectSql = () => `jsonb_build_object(\n${SCALE_TABLES.map((table) => `    '${table}',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.${table} t where organization_id='${ORGANIZATION_ID}')`).join(",\n")}\n  )`;
const auxiliaryCountObjectSql = () => `jsonb_build_object(\n${AUXILIARY_IDENTITY_TABLES.map((table) => `    '${table}',(select count(*) from public.${table} where organization_id='${ORGANIZATION_ID}')`).join(",\n")}\n  )`;
const auxiliaryFingerprintObjectSql = () => `jsonb_build_object(\n${AUXILIARY_IDENTITY_TABLES.map((table) => `    '${table}',(select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'empty')) from public.${table} t where organization_id='${ORGANIZATION_ID}')`).join(",\n")}\n  )`;
const shapeCountObjectSql = () => `jsonb_build_object(
  'active_inventory_items',(select count(*) from public.inventory_items where organization_id='${ORGANIZATION_ID}' and active),
  'current_business_day_bills',(select count(*) from public.bills where organization_id='${ORGANIZATION_ID}' and public.analytics_business_date(issued_at)=public.analytics_business_date(clock_timestamp())),
  'current_business_day_payments',(select count(*) from public.payments where organization_id='${ORGANIZATION_ID}' and public.analytics_business_date(paid_at)=public.analytics_business_date(clock_timestamp())),
  'pending_bills',(select count(*) from public.bills where organization_id='${ORGANIZATION_ID}' and status='pending'),
  'recent_stock_movements',(select count(*) from public.stock_movements where organization_id='${ORGANIZATION_ID}' and public.analytics_business_date(movement_at) between public.analytics_business_date(clock_timestamp())-29 and public.analytics_business_date(clock_timestamp()))
)`;
const appStateSql = () => `(select jsonb_build_object('version',version,'bytes',octet_length(data::text),'md5',md5(data::text),'updated_at',updated_at,'updated_by',updated_by) from public.app_state where id='primary')`;
const rpcIdentitySql = () => `(select case when to_regprocedure('public.${SCALE_RPC}(jsonb)') is null then null else jsonb_build_object(
  'owner',(select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=to_regprocedure('public.${SCALE_RPC}(jsonb)')),
  'security_definer',(select prosecdef from pg_proc where oid=to_regprocedure('public.${SCALE_RPC}(jsonb)')),
  'volatility',(select provolatile from pg_proc where oid=to_regprocedure('public.${SCALE_RPC}(jsonb)')),
  'search_path',(select proconfig from pg_proc where oid=to_regprocedure('public.${SCALE_RPC}(jsonb)')),
  'acl',(select coalesce(jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(acl.grantor),'grantee',case when acl.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,'privilege',acl.privilege_type,'grantable',acl.is_grantable) order by acl.grantee,acl.privilege_type,acl.is_grantable),'[]'::jsonb) from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where p.oid=to_regprocedure('public.${SCALE_RPC}(jsonb)')),
  'authenticated_execute',has_function_privilege('authenticated','public.${SCALE_RPC}(jsonb)','execute'),
  'anon_execute',has_function_privilege('anon','public.${SCALE_RPC}(jsonb)','execute'),
  'public_execute',(select exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE') from pg_proc p where p.oid=to_regprocedure('public.${SCALE_RPC}(jsonb)')),
  'body_md5',(select md5(replace(replace(prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10))) from pg_proc where oid=to_regprocedure('public.${SCALE_RPC}(jsonb)')),
  'definition_md5',(select md5(replace(replace(pg_get_functiondef(to_regprocedure('public.${SCALE_RPC}(jsonb)')),chr(13)||chr(10),chr(10)),chr(13),chr(10)))
)) end)`;
const identitySql = () => `jsonb_build_object('organization_id','${ORGANIZATION_ID}','app_state',${appStateSql()},'public_counts',${countObjectSql()},'public_fingerprints',${fingerprintObjectSql()},'auxiliary_counts',${auxiliaryCountObjectSql()},'auxiliary_fingerprints',${auxiliaryFingerprintObjectSql()},'shape_counts',${shapeCountObjectSql()},'scale_fixture_rpc',${rpcIdentitySql()})`;
const stableIdentityMismatchSql = (left, right) => {
  const withoutTemporalShape = (expression) => `((${expression}->'shape_counts')${TEMPORAL_SHAPE_COUNT_KEYS.map((key) => `-'${key}'`).join("")})`;
  return `((${left})-'shape_counts')<>((${right})-'shape_counts') or ${withoutTemporalShape(left)}<>${withoutTemporalShape(right)}`;
};
const scaleRpcBodySql = () => `declare v_org text:=nullif(payload->>'organization_id',''); v_actor uuid:=auth.uid();
begin
  if v_org is distinct from '${ORGANIZATION_ID}' or v_actor is null or not public.current_user_has_org_access('${ORGANIZATION_ID}') then perform public.raise_operational_rpc_error('organization_access_denied','You do not have access to this organization.',jsonb_build_object('organization_id',v_org)); end if;
  return ${identitySql()};
end`;
const id = (runId, kind, expression = "g") => `${q(`${runId}-${kind}-`)} || lpad(${expression}::text,6,'0')`;
const marker = (runId, expression = "g") => `jsonb_build_object('qaScaleRunId',${q(runId)},'synthetic',true,'ordinal',${expression})`;
const oldTime = (expression = "g") => `'2020-01-01T00:00:00Z'::timestamptz + (${expression} * interval '1 second')`;
const recentTime = (expression = "g") => `clock_timestamp() - ((${expression}) % 30) * interval '1 day'`;

export const scaleIdentityFromSnapshot = (snapshot) => ({
  organization_id: snapshot.organization_id,
  app_state: snapshot.app_state,
  public_counts: snapshot.public_counts,
  public_fingerprints: snapshot.public_fingerprints,
  auxiliary_counts: snapshot.auxiliary_counts,
  auxiliary_fingerprints: snapshot.auxiliary_fingerprints,
  shape_counts: snapshot.shape_counts,
  scale_fixture_rpc: snapshot.scale_fixture_rpc ?? null
});

const triggerStateGuardsSql = () => SUPPRESSED_TRIGGERS.map(([table, trigger]) =>
  `  if (select tgenabled from pg_trigger where tgrelid='public.${table}'::regclass and tgname='${trigger}')<>'O' then raise exception '${trigger} trigger drift'; end if;`
).join("\n");
const disableSuppressedTriggersSql = () => SUPPRESSED_TRIGGERS.map(([table, trigger]) =>
  `alter table public.${table} disable trigger ${trigger};`
).join("\n");
const enableSuppressedTriggersSql = () => [...SUPPRESSED_TRIGGERS].reverse().map(([table, trigger]) =>
  `alter table public.${table} enable trigger ${trigger};`
).join("\n");

function fixtureIdentifiers(runId, plan) {
  const c = plan.insertCounts;
  return [
    ["expense_template_overrides","id","expense-override",c.expense_template_overrides],
    ["bill_line_discounts","id","line-discount",c.bill_line_discounts],
    ["bill_discounts","id","bill-discount",c.bill_discounts],
    ["customer_tab_combo_applications","id","tab-combo",c.customer_tab_combo_applications],
    ["customer_tab_items","id","tab-item",c.customer_tab_items],
    ["session_combo_applications","id","session-combo",c.session_combo_applications],
    ["session_items","id","session-item",c.session_items],
    ["session_pause_logs","id","pause",c.session_pause_logs],
    ["combo_choice_options","option_id","combo-option",c.combo_choice_options],
    ["combo_choice_groups","id","combo-group",c.combo_choice_groups],
    ["combo_fixed_items","id","combo-fixed",c.combo_fixed_items],
    ["combo_station_targets","station_id","station-target",c.combo_station_targets],
    ["payments","id","payment",c.payments],
    ["bill_lines","id","bill-line",c.bill_lines],
    ["stock_movements","id","movement",c.stock_movements],
    ["audit_logs","id","audit",c.audit_logs],
    ["operational_events","id","event",c.operational_events],
    ["expenses","id","expense",c.expenses],
    ["expense_templates","id","expense-template",c.expense_templates],
    ["customer_tabs","id","tab",c.customer_tabs],
    ["sessions","id","session",c.sessions],
    ["bills","id","bill",c.bills],
    ["customers","id","customer",c.customers],
    ["sale_variants","id","variant",c.sale_variants],
    ["inventory_items","id","inventory",c.inventory_items],
    ["inventory_categories","id","category",c.inventory_categories],
    ["pricing_rules","id","pricing",c.pricing_rules],
    ["stations","id","station",c.stations],
    ["combos","id","combo",c.combos]
  ];
}

function floorGuardSql(runId, snapshot, plan) {
  const collisionChecks = fixtureIdentifiers(runId, plan).map(([table, column, kind, count]) =>
    `  if exists(select 1 from public.${table} where organization_id='${ORGANIZATION_ID}' and ${column} in (select ${id(runId,kind,"g")} from generate_series(1,${count}) g)) then raise exception 'fixture id collision in ${table}'; end if;`
  ).join("\n");
  return `do $$
declare v_identity jsonb;
begin
  if current_database()<>'postgres' or (select system_identifier::text from pg_control_system())<>'${STAGING_SYSTEM_IDENTIFIER}' then raise exception 'physical database is not the approved staging cluster'; end if;
  if not exists(select 1 from public.deployment_environment_identity where environment='staging' and project_ref='${STAGING_PROJECT_REF}' and identity_nonce='${STAGING_IDENTITY_NONCE}'::uuid) then raise exception 'staging identity nonce mismatch'; end if;
  if to_regnamespace('${SCALE_SCHEMA}') is not null then raise exception 'scale fixture schema already exists'; end if;
  if to_regprocedure('public.${SCALE_RPC}(jsonb)') is not null then raise exception 'scale fixture identity RPC already exists'; end if;
  if (select data ? '${SCALE_KEY}' from public.app_state where id='primary') then raise exception 'scale fixture app_state key already exists'; end if;
  if exists(select 1 from public.sessions where organization_id='${ORGANIZATION_ID}' and status<>'closed') then raise exception 'staging has open sessions'; end if;
  if exists(select 1 from public.customer_tabs where organization_id='${ORGANIZATION_ID}' and status='open') then raise exception 'staging has open customer tabs'; end if;
  if exists(select 1 from public.sessions source where source.organization_id='${ORGANIZATION_ID}' and source.status='closed' and source.close_disposition='hopped' and source.closed_bill_id is null
    and not exists(select 1 from public.sessions consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))
    and not exists(select 1 from public.customer_tabs consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))) then raise exception 'staging has recoverable hopped sessions'; end if;
  if exists(select 1 from public.financial_mutations where organization_id='${ORGANIZATION_ID}' and status<>'committed') then raise exception 'staging has incomplete financial mutations'; end if;
  if to_regclass('public.operational_mutations') is not null and exists(select 1 from public.operational_mutations where organization_id='${ORGANIZATION_ID}' and status<>'committed') then raise exception 'staging has incomplete operational mutations'; end if;
${triggerStateGuardsSql()}
  if (select tgenabled from pg_trigger where tgrelid='public.app_state'::regclass and tgname='app_state_set_updated_at')<>'O' then raise exception 'app_state trigger drift'; end if;
  v_identity := ${identitySql()};
  if v_identity<>${jsonb(scaleIdentityFromSnapshot(snapshot))} then raise exception 'scale fixture preflight identity drift'; end if;
${collisionChecks}
end $$;`;
}

function minimalEnvironmentGuardSql() {
  return `do $$
begin
  if current_database()<>'postgres' or (select system_identifier::text from pg_control_system())<>'${STAGING_SYSTEM_IDENTIFIER}' then raise exception 'physical database is not the approved staging cluster'; end if;
  if not exists(select 1 from public.deployment_environment_identity where environment='staging' and project_ref='${STAGING_PROJECT_REF}' and identity_nonce='${STAGING_IDENTITY_NONCE}'::uuid) then raise exception 'staging identity nonce mismatch'; end if;
end $$;`;
}

function lockSql() {
  return `select pg_advisory_xact_lock(hashtextextended('bp-operational-performance-scale',0));
lock table public.app_state in share row exclusive mode;
${[...SCALE_TABLES, ...AUXILIARY_IDENTITY_TABLES].sort().map((table) => `lock table public.${table} in share row exclusive mode;`).join("\n")}
select 1 from public.app_state where id='primary' for update;`;
}

function insertSql(runId, count, table, columns, selectValues) {
  return `insert into public.${table} (${columns.join(",")})
select ${selectValues.join(",")} from generate_series(1,${count}) g;`;
}

const APP_STATE_OBJECT_COLLECTIONS = [
  "stations", "pricingRules", "sessions", "sessionPauseLogs", "customers", "customerTabs",
  "inventoryItems", "combos", "stockMovements", "bills", "payments", "auditLogs",
  "expenses", "expenseTemplates", "expenseTemplateOverrides"
];

function appStateAppendSql(key, count, expression) {
  return `select coalesce(jsonb_agg(${expression} order by g),'[]'::jsonb) into v_append from generate_series(1,${count}) g;
  v_data:=jsonb_set(v_data,array['${key}'],coalesce(v_data->'${key}','[]'::jsonb)||v_append,true);`;
}

function shapedAppStateSql(runId, c, appC, pendingBills, targetBytes, updatedBy) {
  const marked = (entries) => `jsonb_build_object('qaScaleRunId',${q(runId)},${entries})`;
  const represented=(count)=>count===0?0:Math.max(1,Math.ceil(count*appC.representationFraction));
  const sessionItems = `coalesce((select jsonb_agg(${marked(`'id',${id(runId,"session-item","sg")},'inventoryItemId','qa-scale','name','QA Performance Item','quantity',1,'unitPrice',0,'addedAt',${recentTime("sg")}`)} order by sg) from generate_series(g,${represented(c.session_items)},greatest(1,${appC.sessions})) sg),'[]'::jsonb)`;
  const tabItems = `coalesce((select jsonb_agg(${marked(`'id',${id(runId,"tab-item","tg")},'inventoryItemId','qa-scale','name','QA Performance Item','quantity',1,'unitPrice',0,'addedAt',${recentTime("tg")}`)} order by tg) from generate_series(g,${represented(c.customer_tab_items)},greatest(1,${appC.customerTabs})) tg),'[]'::jsonb)`;
  const billLines = `coalesce((select jsonb_agg(${marked(`'id',${id(runId,"bill-line","lg")},'type','inventory_item','description','QA Performance Item','quantity',1,'unitPrice',case when lg<=${pendingBills} then 1 else 0 end,'subtotal',case when lg<=${pendingBills} then 1 else 0 end,'discountAmount',0,'total',case when lg<=${pendingBills} then 1 else 0 end`)} order by lg) from generate_series(g,${represented(c.bill_lines)},greatest(1,${appC.bills})) lg),'[]'::jsonb)`;
  const billLineDiscounts = `coalesce((select jsonb_agg(${marked(`'id',${id(runId,"line-discount","dg")},'scope','line','targetId','qa-scale','type','amount','value',0,'amount',0,'reason','QA performance scale fixture','appliedByUserId','','appliedAt',${recentTime("dg")}`)} order by dg) from generate_series(g,${represented(c.bill_line_discounts)},greatest(1,${appC.bills})) dg),'[]'::jsonb)`;
  const variants = `coalesce((select jsonb_agg(${marked(`'id',${id(runId,"variant","vg")},'name','QA Performance Variant','price',0,'stockUnitsPerSale',1,'active',true`)} order by vg) from generate_series(g,${represented(c.sale_variants)},greatest(1,${appC.inventoryItems})) vg),'[]'::jsonb)`;
  const statements = [
    appStateAppendSql("stations",appC.stations,marked(`'id',${id(runId,"station")},'name','QA Performance Station','mode','timed','active',false,'ltpEnabled',false,'notes','QA performance scale fixture'`)),
    appStateAppendSql("pricingRules",appC.pricingRules,marked(`'id',${id(runId,"pricing")},'stationId','','label','QA Performance Pricing','startMinute',0,'endMinute',0,'hourlyRate',0`)),
    appStateAppendSql("sessions",appC.sessions,marked(`'id',${id(runId,"session")},'stationId','','stationNameSnapshot','QA Performance Station','mode','timed','startedAt',${recentTime()},'endedAt',${recentTime()}+'30 minutes'::interval,'status','closed','customerName','QA Performance Customer','playMode','group','ltpEligible',false,'pricingSnapshot','[]'::jsonb,'items',${sessionItems},'pauseLogIds','[]'::jsonb,'closeDisposition','rejected','closeReason','QA performance scale fixture'`)),
    appStateAppendSql("sessionPauseLogs",appC.sessionPauseLogs,marked(`'id',${id(runId,"pause")},'sessionId',${id(runId,"session",`(((g-1)%${Math.max(1,appC.sessions)})+1)`)},'pausedAt',${recentTime()},'resumedAt',${recentTime()}+'5 minutes'::interval`)),
    appStateAppendSql("customers",appC.customers,marked(`'id',${id(runId,"customer")},'name','QA Performance Customer','createdAt',${recentTime()},'lastVisitAt',${recentTime()}`)),
    appStateAppendSql("customerTabs",appC.customerTabs,marked(`'id',${id(runId,"tab")},'customerName','QA Performance Customer','status','closed','createdAt',${recentTime()},'closedAt',${recentTime()}+'30 minutes'::interval,'items',${tabItems},'closeDisposition','rejected','closeReason','QA performance scale fixture'`)),
    appStateAppendSql("inventoryItems",appC.inventoryItems,marked(`'id',${id(runId,"inventory")},'name','QA Performance Item','category','QA Performance','price',0,'stockQty',0,'lowStockThreshold',0,'unit','piece','isReusable',false,'active',g<=${appC.activeInventory},'sellBaseItem',false,'saleVariants',${variants}`)),
    appStateAppendSql("combos",appC.combos,marked(`'id',${id(runId,"combo")},'name','QA Performance Combo','type','game','active',true,'stationIds','[]'::jsonb,'price',0,'includedMinutes',1,'fixedItems','[]'::jsonb,'choiceGroups','[]'::jsonb,'createdAt',${recentTime()},'updatedAt',${recentTime()}`)),
    appStateAppendSql("stockMovements",appC.stockMovements,marked(`'id',${id(runId,"movement")},'itemId',${id(runId,"inventory",`(((g-1)%${Math.max(1,appC.inventoryItems)})+1)`)},'type','adjustment','quantity',0,'reason','QA performance scale fixture','createdAt',case when g<=${appC.recentStockMovements} then clock_timestamp()-(g%30)*interval '1 day' else ${oldTime()} end,'userId',''`)),
    appStateAppendSql("bills",appC.bills,marked(`'id',${id(runId,"bill")},'billNumber','QA-PERF-'||${q(runId)}||'-'||lpad(g::text,6,'0'),'status',case when g<=${pendingBills} then 'pending' else 'issued' end,'createdAt',case when g<=${appC.currentBills} then clock_timestamp() else ${oldTime()} end,'issuedAt',case when g<=${appC.currentBills} then clock_timestamp() else ${oldTime()} end,'issuedByUserId','','customerName','QA Performance Customer','paymentMode',case when g<=${pendingBills} then 'deferred' else 'cash' end,'amountPaid',0,'amountDue',case when g<=${pendingBills} then 1 else 0 end,'subtotal',case when g<=${pendingBills} then 1 else 0 end,'totalDiscountAmount',0,'billDiscountAmount',0,'roundOffEnabled',false,'roundOffAmount',0,'total',case when g<=${pendingBills} then 1 else 0 end,'lineDiscounts',${billLineDiscounts},'lines',${billLines},'receiptType','digital'`)),
    appStateAppendSql("payments",appC.payments,marked(`'id',${id(runId,"payment")},'billId',${id(runId,"bill",`(((g-1)%${Math.max(1,appC.bills)})+1)`)},'mode','cash','amount',0,'createdAt',case when g<=${appC.currentPayments} then clock_timestamp() else ${oldTime()} end,'receivedByUserId',''`)),
    appStateAppendSql("auditLogs",appC.auditLogs,marked(`'id',${id(runId,"audit")},'action','qa_scale_fixture','entityType','qa_performance_fixture','entityId',${id(runId,"audit-entity")},'message','QA performance scale fixture','createdAt',${recentTime()},'userId',''`)),
    appStateAppendSql("expenses",appC.expenses,marked(`'id',${id(runId,"expense")},'title','QA Performance Expense','category','QA','amount',0,'paymentMode','cash','spentAt',${recentTime()},'notes','QA performance scale fixture','createdByUserId',''`)),
    appStateAppendSql("expenseTemplates",appC.expenseTemplates,marked(`'id',${id(runId,"expense-template")},'title','QA Performance Template','category','QA','amount',0,'frequency','monthly','startMonth','2020-01','active',false,'notes','QA performance scale fixture','createdByUserId',''`)),
    appStateAppendSql("expenseTemplateOverrides",appC.expenseTemplateOverrides,marked(`'id',${id(runId,"expense-override")},'templateId',${id(runId,"expense-template",`(((g-1)%${Math.max(1,appC.expenseTemplates)})+1)`)},'monthKey','2020-01','amount',0,'skipReason','QA performance scale fixture','notes','QA performance scale fixture','createdByUserId','','updatedAt',${recentTime()}`))
  ];
  return `do $$
declare v_data jsonb; v_append jsonb; v_padding_ordinal integer:=0;
begin
  select data into v_data from public.app_state where id='primary' for update;
  ${statements.join("\n  ")}
  select coalesce(jsonb_agg(to_jsonb('QA Performance Category '||g::text) order by g),'[]'::jsonb) into v_append from generate_series(1,${appC.inventoryCategories}) g;
  v_data:=jsonb_set(v_data,array['inventoryCategories'],coalesce(v_data->'inventoryCategories','[]'::jsonb)||v_append,true);
  v_data:=jsonb_set(v_data,array['${SCALE_KEY}'],jsonb_build_object('qaScaleRunId',${q(runId)},'synthetic',true,'shape','AppData'),true);
  while octet_length(v_data::text)<${targetBytes} loop
    select jsonb_agg(${marked(`'id',${q(`${runId}-appstate-padding-`)}||lpad((v_padding_ordinal+g)::text,8,'0'),'action','qa_scale_fixture_padding','entityType','qa_performance_fixture','entityId',${q(runId)},'message','QA performance scale fixture','createdAt',${recentTime("v_padding_ordinal+g")},'userId',''`)} order by g) into v_append from generate_series(1,250) g;
    v_data:=jsonb_set(v_data,array['auditLogs'],coalesce(v_data->'auditLogs','[]'::jsonb)||v_append,true);
    v_padding_ordinal:=v_padding_ordinal+250;
  end loop;
  if octet_length(v_data::text)>${Math.ceil(targetBytes*1.25)} then raise exception 'AppData-shaped scale target overhead exceeded'; end if;
  update public.app_state set data=v_data,version=version+1,updated_by=${updatedBy ? q(updatedBy)+"::uuid" : "null"} where id='primary';
end $$;`;
}

function cleanupShapedAppStateSql(runId, categoryCount) {
  const objectFilters = APP_STATE_OBJECT_COLLECTIONS.map((key) =>
    `v_data:=jsonb_set(v_data,array['${key}'],coalesce((select jsonb_agg(value order by ord) from jsonb_array_elements(coalesce(v_data->'${key}','[]'::jsonb)) with ordinality entries(value,ord) where value->>'qaScaleRunId' is distinct from ${q(runId)}),'[]'::jsonb),true);`
  ).join("\n  ");
  return `do $$ declare v_data jsonb;
begin
  select data into v_data from public.app_state where id='primary' for update;
  ${objectFilters}
  v_data:=jsonb_set(v_data,array['inventoryCategories'],coalesce((select jsonb_agg(value order by ord) from jsonb_array_elements(coalesce(v_data->'inventoryCategories','[]'::jsonb)) with ordinality entries(value,ord) where value not in (select to_jsonb('QA Performance Category '||g::text) from generate_series(1,${categoryCount}) g)),'[]'::jsonb),true);
  v_data:=v_data-'${SCALE_KEY}';
  update public.app_state a set data=v_data,version=(r.original_app_state_identity->>'version')::integer,updated_at=(r.original_app_state_identity->>'updated_at')::timestamptz,updated_by=nullif(r.original_app_state_identity->>'updated_by','')::uuid
  from ${SCALE_SCHEMA}.fixture_registry r where a.id='primary' and r.run_id=${q(runId)};
end $$;`;
}

function seedStatements(runId, snapshot, plan, production, packageBindingSha256) {
  const c = plan.insertCounts;
  const appC = plan.appState.insertCounts;
  const productionBytes = production.databaseBaseline.appState.bytes;
  const pendingBills = Math.min(c.bills, plan.shape.insertCounts.pending_bills);
  const pendingAppBills = Math.min(appC.bills, plan.shape.insertCounts.pending_bills);
  const currentBills = Math.min(c.bills, plan.shape.insertCounts.current_business_day_bills);
  const currentAppBills = Math.min(appC.bills, plan.shape.insertCounts.current_business_day_bills);
  const currentPayments = Math.min(c.payments, plan.shape.insertCounts.current_business_day_payments);
  const activeInventory = Math.min(c.inventory_items, plan.shape.insertCounts.active_inventory_items);
  const activeAppInventory = Math.min(appC.inventoryItems, plan.shape.insertCounts.active_inventory_items);
  const recentStockMovements = Math.min(c.stock_movements, plan.shape.insertCounts.recent_stock_movements);
  const billAnchor = `${q(`${runId}-bill-`)} || lpad((((g-1) % ${Math.max(1, c.bills)})+1)::text,6,'0')`;
  const sessionAnchor = `${q(`${runId}-session-`)} || lpad((((g-1) % ${Math.max(1, c.sessions)})+1)::text,6,'0')`;
  const tabAnchor = `${q(`${runId}-tab-`)} || lpad((((g-1) % ${Math.max(1, c.customer_tabs)})+1)::text,6,'0')`;
  const itemAnchor = `${q(`${runId}-inventory-`)} || lpad((((g-1) % ${Math.max(1, c.inventory_items)})+1)::text,6,'0')`;
  const comboAnchor = `${q(`${runId}-combo-`)} || lpad((((g-1) % ${Math.max(1, c.combos)})+1)::text,6,'0')`;
  const optionGroupOrdinal = `(((g-1)%${Math.max(1,c.combo_choice_groups)})+1)`;
  const optionComboAnchor = `${q(`${runId}-combo-`)} || lpad(((((${optionGroupOrdinal})-1)%${Math.max(1,c.combos)})+1)::text,6,'0')`;
  const templateAnchor = `${q(`${runId}-expense-template-`)} || lpad((((g-1) % ${Math.max(1, c.expense_templates)})+1)::text,6,'0')`;
  const inserts = [];
  inserts.push(insertSql(runId,c.inventory_categories,"inventory_categories",["organization_id","id","name","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"category"),`${q("QA Performance Category ")}||g`,oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.stations,"stations",["organization_id","id","name","mode","active","ltp_enabled","notes","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"station"),`${q("QA Performance Station ")}||g`,q("timed"),"false","false",q("QA performance scale fixture"),marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.inventory_items,"inventory_items",["organization_id","id","name","category","price","stock_qty","low_stock_threshold","unit","is_reusable","active","sell_base_item","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"inventory"),`${q("QA Performance Item ")}||g`,"null","0","0","0",q("piece"),"false",`g<=${activeInventory}`,"false",marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.sale_variants,"sale_variants",["organization_id","inventory_item_id","id","name","price","stock_units_per_sale","active","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),itemAnchor,id(runId,"variant"),`${q("QA Performance Variant ")}||g`,"0","1",`g<=${Math.min(c.sale_variants,activeInventory)}`,marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.pricing_rules,"pricing_rules",["organization_id","id","station_id","label","start_minute","end_minute","hourly_rate","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"pricing"),"null",`${q("QA Performance Pricing ")}||g`,"0","0","0",marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.combos,"combos",["organization_id","id","name","type","active","price","included_minutes","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"combo"),`${q("QA Performance Combo ")}||g`,q("game"),"true","0","1",marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.combo_station_targets,"combo_station_targets",["organization_id","combo_id","station_id","created_at"],[q(ORGANIZATION_ID),comboAnchor,id(runId,"station-target"),oldTime()]));
  inserts.push(insertSql(runId,c.combo_fixed_items,"combo_fixed_items",["organization_id","combo_id","id","sellable_option_id","quantity","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),comboAnchor,id(runId,"combo-fixed"),id(runId,"sellable-option"),"1",marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.combo_choice_groups,"combo_choice_groups",["organization_id","combo_id","id","label","required_quantity","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),comboAnchor,id(runId,"combo-group"),`${q("QA Performance Group ")}||g`,"1",marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.combo_choice_options,"combo_choice_options",["organization_id","combo_id","choice_group_id","option_id","created_at"],[q(ORGANIZATION_ID),optionComboAnchor,`${q(`${runId}-combo-group-`)}||lpad((${optionGroupOrdinal})::text,6,'0')`,id(runId,"combo-option"),oldTime()]));
  inserts.push(insertSql(runId,c.customers,"customers",["organization_id","id","name","phone","first_seen_at","last_visit_at","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"customer"),`${q("QA Performance Customer ")}||g`,"null",oldTime(),oldTime(),marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.sessions,"sessions",["organization_id","id","station_id","station_name_snapshot","mode","started_at","ended_at","status","customer_id","customer_name","customer_phone","play_mode","ltp_eligible","pricing_snapshot","pause_log_ids","closed_bill_id","close_disposition","close_reason","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"session"),"null",q("QA Performance Station"),q("timed"),oldTime(),`${oldTime()}+interval '30 minutes'`,q("closed"),"null",q("QA Performance Customer"),"null",q("group"),"false",q("[]")+"::jsonb",q("[]")+"::jsonb","null",q("rejected"),q("QA performance scale fixture"),marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.session_pause_logs,"session_pause_logs",["organization_id","id","session_id","paused_at","resumed_at","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"pause"),sessionAnchor,`${oldTime()}+interval '5 minutes'`,`${oldTime()}+interval '10 minutes'`,marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.session_items,"session_items",["organization_id","session_id","id","inventory_item_id","name","quantity","unit_price","added_at","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),sessionAnchor,id(runId,"session-item"),"null",q("QA Performance Item"),"1","0",oldTime(),marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.session_combo_applications,"session_combo_applications",["organization_id","session_id","id","combo_id","combo_name","price","included_minutes","applied_at","fixed_items","choices","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),sessionAnchor,id(runId,"session-combo"),"null",q("QA Performance Combo"),"0","1",oldTime(),q("[]")+"::jsonb",q("[]")+"::jsonb",marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.customer_tabs,"customer_tabs",["organization_id","id","customer_id","customer_name","customer_phone","status","opened_at","closed_at","closed_bill_id","close_disposition","close_reason","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"tab"),"null",q("QA Performance Customer"),"null",q("closed"),oldTime(),`${oldTime()}+interval '30 minutes'`,"null",q("rejected"),q("QA performance scale fixture"),marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.customer_tab_items,"customer_tab_items",["organization_id","customer_tab_id","id","inventory_item_id","name","quantity","unit_price","added_at","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),tabAnchor,id(runId,"tab-item"),"null",q("QA Performance Item"),"1","0",oldTime(),marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.customer_tab_combo_applications,"customer_tab_combo_applications",["organization_id","customer_tab_id","id","combo_id","combo_name","price","applied_at","fixed_items","choices","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),tabAnchor,id(runId,"tab-combo"),"null",q("QA Performance Combo"),"0",oldTime(),q("[]")+"::jsonb",q("[]")+"::jsonb",marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.bills,"bills",["organization_id","id","bill_number","status","created_at_source","issued_at","customer_name","customer_phone","payment_mode","amount_paid","amount_due","subtotal","total_discount_amount","bill_discount_amount","round_off_enabled","round_off_amount","total","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"bill"),`${q("QA-PERF-")}||${q(runId)}||'-'||lpad(g::text,6,'0')`,`case when g<=${pendingBills} then 'pending' else 'issued' end`,`case when g<=${currentBills} then clock_timestamp() else ${oldTime()} end`,`case when g<=${currentBills} then clock_timestamp() else ${oldTime()} end`,q("QA Performance Customer"),"null",`case when g<=${pendingBills} then 'deferred' else 'cash' end`,"0",`case when g<=${pendingBills} then 1 else 0 end`,`case when g<=${pendingBills} then 1 else 0 end`,"0","0","false","0",`case when g<=${pendingBills} then 1 else 0 end`,marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.bill_lines,"bill_lines",["organization_id","bill_id","id","type","description","quantity","unit_price","subtotal","discount_amount","total","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),billAnchor,id(runId,"bill-line"),q("inventory_item"),q("QA Performance Item"),"1",`case when g<=${pendingBills} then 1 else 0 end`,`case when g<=${pendingBills} then 1 else 0 end`,"0",`case when g<=${pendingBills} then 1 else 0 end`,marker(runId),recentTime(),recentTime()]));
  inserts.push(insertSql(runId,c.bill_discounts,"bill_discounts",["organization_id","bill_id","id","discount_type","value","amount","reason","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),billAnchor,id(runId,"bill-discount"),q("fixed"),"0","0",q("QA performance scale fixture"),marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.bill_line_discounts,"bill_line_discounts",["organization_id","bill_id","id","target_id","discount_type","value","amount","reason","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),billAnchor,id(runId,"line-discount"),"null",q("fixed"),"0","0",q("QA performance scale fixture"),marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.payments,"payments",["organization_id","id","bill_id","mode","amount","paid_at","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"payment"),billAnchor,q("cash"),"0",`case when g<=${currentPayments} then clock_timestamp() else ${oldTime()} end`,marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.stock_movements,"stock_movements",["organization_id","id","item_id","type","quantity","reason","movement_at","related_bill_id","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"movement"),itemAnchor,q("adjustment"),"0",q("QA performance scale fixture"),`case when g<=${recentStockMovements} then clock_timestamp()-(g%30)*interval '1 day' else ${oldTime()} end`,"null",marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.audit_logs,"audit_logs",["organization_id","id","action","entity_type","entity_id","message","audit_at","user_id","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"audit"),q("qa_scale_fixture"),q("qa_performance_fixture"),id(runId,"audit-entity"),q("QA performance scale fixture"),oldTime(),"null",marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.operational_events,"operational_events",["organization_id","id","event_type","entity_type","entity_id","entity_version","created_by","created_at","metadata"],[q(ORGANIZATION_ID),id(runId,"event"),q("qa_scale_fixture"),q("qa_performance_fixture"),id(runId,"event-entity"),"1","null",oldTime(),marker(runId)]));
  inserts.push(insertSql(runId,c.expenses,"expenses",["organization_id","id","title","category","amount","payment_mode","spent_at","notes","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"expense"),`${q("QA Performance Expense ")}||g`,q("QA"),"0",q("cash"),oldTime(),q("QA performance scale fixture"),marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.expense_templates,"expense_templates",["organization_id","id","title","category","amount","frequency","start_month","active","notes","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"expense-template"),`${q("QA Performance Template ")}||g`,q("QA"),"0",q("monthly"),q("2020-01"),"false",q("QA performance scale fixture"),marker(runId),oldTime(),oldTime()]));
  inserts.push(insertSql(runId,c.expense_template_overrides,"expense_template_overrides",["organization_id","id","template_id","month_key","amount","skip_reason","notes","raw_data","created_at","updated_at"],[q(ORGANIZATION_ID),id(runId,"expense-override"),templateAnchor,q("2020-01"),"0",q("QA performance scale fixture"),q("QA performance scale fixture"),marker(runId),oldTime(),oldTime()]));

  const targetBytes = Math.max(productionBytes, snapshot.app_state.bytes);
  return `create schema ${SCALE_SCHEMA} authorization postgres;
revoke all on schema ${SCALE_SCHEMA} from public, anon, authenticated;
create table ${SCALE_SCHEMA}.fixture_registry(
  run_id text primary key, organization_id text not null, package_binding_sha256 text not null,
  original_app_state_identity jsonb not null, original_identity jsonb not null, seeded_identity jsonb,
  plan jsonb not null, status text not null, created_at timestamptz not null default clock_timestamp()
);
alter table ${SCALE_SCHEMA}.fixture_registry enable row level security;
revoke all on ${SCALE_SCHEMA}.fixture_registry from public, anon, authenticated;
insert into ${SCALE_SCHEMA}.fixture_registry(run_id,organization_id,package_binding_sha256,original_app_state_identity,original_identity,plan,status)
select ${q(runId)},${q(ORGANIZATION_ID)},${q(packageBindingSha256)},${appStateSql()},${identitySql()},${jsonb(plan)},'applying'
from public.app_state a where id='primary';

${disableSuppressedTriggersSql()}
${inserts.join("\n")}
${enableSuppressedTriggersSql()}

${shapedAppStateSql(runId,c,{...appC,representationFraction:plan.appState.representationFraction,activeInventory:activeAppInventory,currentBills:currentAppBills,currentPayments:Math.min(appC.payments,plan.shape.insertCounts.current_business_day_payments),recentStockMovements:Math.min(appC.stockMovements,plan.shape.insertCounts.recent_stock_movements)},pendingAppBills,targetBytes,snapshot.app_state.updated_by)}

create function public.${SCALE_RPC}(payload jsonb) returns jsonb language plpgsql stable security definer set search_path=public as $body$${scaleRpcBodySql()}$body$;
revoke all on function public.${SCALE_RPC}(jsonb) from public;
revoke execute on function public.${SCALE_RPC}(jsonb) from anon;
revoke execute on function public.${SCALE_RPC}(jsonb) from service_role;
grant execute on function public.${SCALE_RPC}(jsonb) to authenticated;

do $$ declare v_proc pg_proc;
begin
  select * into strict v_proc from pg_proc where oid=to_regprocedure('public.${SCALE_RPC}(jsonb)');
  if pg_get_userbyid(v_proc.proowner)<>'postgres' or v_proc.prosecdef is not true or v_proc.provolatile<>'s' or v_proc.proconfig is distinct from array['search_path=public']::text[] or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>${q(md5Hex(scaleRpcBodySql()))} then raise exception 'fixture identity RPC definition metadata mismatch'; end if;
  if (select count(*) from aclexplode(coalesce(v_proc.proacl,acldefault('f',v_proc.proowner))))<>2
    or not exists(select 1 from aclexplode(coalesce(v_proc.proacl,acldefault('f',v_proc.proowner))) acl where acl.grantee=v_proc.proowner and acl.privilege_type='EXECUTE' and not acl.is_grantable)
    or not exists(select 1 from aclexplode(coalesce(v_proc.proacl,acldefault('f',v_proc.proowner))) acl where acl.grantee=(select oid from pg_roles where rolname='authenticated') and acl.privilege_type='EXECUTE' and not acl.is_grantable)
    or exists(select 1 from aclexplode(coalesce(v_proc.proacl,acldefault('f',v_proc.proowner))) acl where acl.privilege_type<>'EXECUTE' or acl.grantee not in (v_proc.proowner,(select oid from pg_roles where rolname='authenticated')) or acl.is_grantable) then raise exception 'fixture identity RPC has an unexpected ACL'; end if;
end $$;

do $$ declare v_seeded jsonb; v_original jsonb;
begin
${triggerStateGuardsSql()}
  if exists(select 1 from public.sessions where organization_id='${ORGANIZATION_ID}' and status<>'closed') or exists(select 1 from public.customer_tabs where organization_id='${ORGANIZATION_ID}' and status='open') then raise exception 'fixture created live entities'; end if;
  if exists(select 1 from public.sessions where organization_id='${ORGANIZATION_ID}' and raw_data->>'qaScaleRunId'=${q(runId)} and (close_disposition<>'rejected' or closed_bill_id is not null)) then raise exception 'fixture session is not inert'; end if;
  if exists(select 1 from public.customer_tabs where organization_id='${ORGANIZATION_ID}' and raw_data->>'qaScaleRunId'=${q(runId)} and (close_disposition<>'rejected' or closed_bill_id is not null)) then raise exception 'fixture tab is not inert'; end if;
  if exists(select 1 from public.combo_fixed_items where organization_id='${ORGANIZATION_ID}' and raw_data->>'qaScaleRunId'=${q(runId)} and (quantity<=0 or quantity<>trunc(quantity))) then raise exception 'fixture combo fixed-item quantity violates the bootstrap contract'; end if;
  if exists(select 1 from public.session_items where organization_id='${ORGANIZATION_ID}' and raw_data->>'qaScaleRunId'=${q(runId)} and quantity<=0) then raise exception 'fixture session-item quantity violates the bootstrap contract'; end if;
  if exists(select 1 from public.customer_tab_items where organization_id='${ORGANIZATION_ID}' and raw_data->>'qaScaleRunId'=${q(runId)} and quantity<=0) then raise exception 'fixture tab-item quantity violates the bootstrap contract'; end if;
  if exists(select 1 from public.bills where organization_id='${ORGANIZATION_ID}' and raw_data->>'qaScaleRunId'=${q(runId)} and (amount_paid<>0 or status not in ('issued','pending') or (status='issued' and (total<>0 or amount_due<>0)) or (status='pending' and (total<>1 or amount_due<>1)))) then raise exception 'fixture bill shape is unsafe'; end if;
  if (select count(*) from public.bills where organization_id='${ORGANIZATION_ID}' and raw_data->>'qaScaleRunId'=${q(runId)} and status='pending')<>${pendingBills} then raise exception 'fixture pending-bill shape mismatch'; end if;
  if exists(select 1 from public.payments where organization_id='${ORGANIZATION_ID}' and raw_data->>'qaScaleRunId'=${q(runId)} and amount<>0) then raise exception 'fixture payment is not zero value'; end if;
  if exists(select 1 from public.stock_movements where organization_id='${ORGANIZATION_ID}' and raw_data->>'qaScaleRunId'=${q(runId)} and quantity<>0) then raise exception 'fixture movement is not inert'; end if;
  v_seeded:=${identitySql()};
  if v_seeded->'scale_fixture_rpc' is null or v_seeded#>>'{scale_fixture_rpc,owner}'<>'postgres' or (v_seeded#>>'{scale_fixture_rpc,security_definer}')::boolean is not true or v_seeded#>>'{scale_fixture_rpc,volatility}'<>'s' or v_seeded#>'{scale_fixture_rpc,search_path}'<>jsonb_build_array('search_path=public') or v_seeded#>>'{scale_fixture_rpc,body_md5}'<>${q(md5Hex(scaleRpcBodySql()))} or (v_seeded#>>'{scale_fixture_rpc,authenticated_execute}')::boolean is not true or (v_seeded#>>'{scale_fixture_rpc,anon_execute}')::boolean is not false or (v_seeded#>>'{scale_fixture_rpc,public_execute}')::boolean is not false then raise exception 'fixture identity RPC security contract mismatch'; end if;
  if v_seeded->'public_counts'<>${jsonb(plan.targetCounts)} then raise exception 'fixture target counts mismatch'; end if;
  if v_seeded->'shape_counts'<>${jsonb(plan.shape.targetCounts)} then raise exception 'fixture workload-shape counts mismatch'; end if;
  select original_identity into v_original from ${SCALE_SCHEMA}.fixture_registry where run_id=${q(runId)};
  if v_seeded->'auxiliary_counts'<>v_original->'auxiliary_counts' or v_seeded->'auxiliary_fingerprints'<>v_original->'auxiliary_fingerprints' then raise exception 'fixture changed auxiliary reporting or activity state'; end if;
  update ${SCALE_SCHEMA}.fixture_registry set seeded_identity=v_seeded,status='active' where run_id=${q(runId)};
end $$;`;
}

function cleanupStatements(runId, snapshot, plan, packageBindingSha256, { rolloverSafe = false } = {}) {
  const deletes = fixtureIdentifiers(runId, plan).map(([table,column,kind,count]) => rolloverSafe
    ? `do $$ declare v_deleted integer;
begin
  delete from public.${table} where organization_id='${ORGANIZATION_ID}' and ${column} in (select ${id(runId,kind,"g")} from generate_series(1,${count}) g);
  get diagnostics v_deleted=row_count;
  if v_deleted<>${count} then raise exception 'fixture cleanup row count mismatch in ${table}'; end if;
end $$;`
    : `delete from public.${table} where organization_id='${ORGANIZATION_ID}' and ${column} in (select ${id(runId,kind,"g")} from generate_series(1,${count}) g);`
  ).join("\n");
  const seededDriftCondition = rolloverSafe ? stableIdentityMismatchSql("v_live", "v_expected") : "v_live<>v_expected";
  const originalIdentity = jsonb(scaleIdentityFromSnapshot(snapshot));
  const restoredDriftCondition = rolloverSafe ? stableIdentityMismatchSql("v_identity", originalIdentity) : `v_identity<>${originalIdentity}`;
  const restoredDriftMessage = rolloverSafe ? "scale fixture cleanup did not restore exact stored preflight identity" : "scale fixture cleanup did not restore exact preflight identity";
  return `do $$ declare v_expected jsonb; v_live jsonb;
begin
  if current_database()<>'postgres' or (select system_identifier::text from pg_control_system())<>'${STAGING_SYSTEM_IDENTIFIER}' then raise exception 'physical database is not the approved staging cluster'; end if;
  if not exists(select 1 from public.deployment_environment_identity where environment='staging' and project_ref='${STAGING_PROJECT_REF}' and identity_nonce='${STAGING_IDENTITY_NONCE}'::uuid) then raise exception 'staging identity nonce mismatch'; end if;
  if to_regnamespace('${SCALE_SCHEMA}') is null then raise exception 'scale fixture registry missing'; end if;
  select seeded_identity into v_expected from ${SCALE_SCHEMA}.fixture_registry where run_id=${q(runId)} and organization_id='${ORGANIZATION_ID}' and package_binding_sha256=${q(packageBindingSha256)} and status='active' for update;
  if v_expected is null then raise exception 'scale fixture registry identity mismatch'; end if;
  v_live:=${identitySql()};
  if ${seededDriftCondition} then raise exception 'scaled dataset drift prevents cleanup'; end if;
${triggerStateGuardsSql()}
  if (select tgenabled from pg_trigger where tgrelid='public.app_state'::regclass and tgname='app_state_set_updated_at')<>'O' then raise exception 'app_state trigger drift'; end if;
end $$;
drop function public.${SCALE_RPC}(jsonb);
${disableSuppressedTriggersSql()}
${deletes}
${enableSuppressedTriggersSql()}
alter table public.app_state disable trigger app_state_set_updated_at;
${cleanupShapedAppStateSql(runId,plan.appState.insertCounts.inventoryCategories)}
alter table public.app_state enable trigger app_state_set_updated_at;
do $$ declare v_identity jsonb;
begin
${triggerStateGuardsSql()}
  if (select tgenabled from pg_trigger where tgrelid='public.app_state'::regclass and tgname='app_state_set_updated_at')<>'O' then raise exception 'app_state trigger was not restored'; end if;
  v_identity:=${identitySql()};
  if ${restoredDriftCondition} then raise exception '${restoredDriftMessage}'; end if;
  if (select data ? '${SCALE_KEY}' from public.app_state where id='primary') then raise exception 'scale fixture app_state key remains'; end if;
end $$;
drop table ${SCALE_SCHEMA}.fixture_registry;
drop schema ${SCALE_SCHEMA};`;
}

export function buildFixturePackage({ runId, snapshot, production, productionAppStateCounts, productionShapeCounts, packageBindingSha256 }) {
  validateRunId(runId);
  validatePreflight(snapshot);
  validateProductionBaseline(production);
  const plan=computeScalePlan(snapshot.public_counts,production.databaseBaseline.publicCounts);
  plan.appState=computeAppStateScalePlan(snapshot.app_state_collection_counts,productionAppStateCounts);
  plan.shape=computeShapeScalePlan(snapshot.shape_counts,productionShapeCounts);
  const targetBytes=Math.max(production.databaseBaseline.appState.bytes,snapshot.app_state.bytes);
  const maximumBytes=Math.ceil(targetBytes*1.25);
  const estimate=estimateRepresentativeAppStateUpperBoundBytes(snapshot.app_state.bytes,plan);
  if(Math.max(targetBytes,estimate.prePaddingUpperBoundBytes)+estimate.paddingBatchUpperBoundBytes>maximumBytes) {
    throw new Error("Representative AppData plan cannot fit inside the guarded production-size envelope.");
  }
  Object.assign(plan.appState,{targetBytes,maximumBytes,...estimate,runtimeExactSizeGuard:true});
  const header=`-- Generated staging-only synthetic performance scale fixture.\n-- Run: ${runId}\n-- Package binding: ${packageBindingSha256}\n`;
  const settings=`set local lock_timeout='3s';\nset local statement_timeout='5min';\n`;
  const seedCore=`${minimalEnvironmentGuardSql()}\n${lockSql()}\n${floorGuardSql(runId,snapshot,plan)}\n${seedStatements(runId,snapshot,plan,production,packageBindingSha256)}`;
  const cleanupCore=`${minimalEnvironmentGuardSql()}\n${lockSql()}\n${cleanupStatements(runId,snapshot,plan,packageBindingSha256)}`;
  const seed=`${header}begin;\n${settings}${seedCore}\nselect jsonb_build_object('status','passed','run_id',${q(runId)},'package_binding_sha256',${q(packageBindingSha256)},'production_write_allowed',false,'rollback_required',true,'identity',${identitySql()}) as evidence;\ncommit;\n`;
  const cleanup=`${header}begin;\n${settings}${cleanupCore}\nselect jsonb_build_object('status','passed','run_id',${q(runId)},'package_binding_sha256',${q(packageBindingSha256)},'production_write_allowed',false,'cleanup_complete',true,'identity',${identitySql()}) as evidence;\ncommit;\n`;
  const proof=`${header}begin;\n${settings}${seedCore}\n${cleanupCore}\nselect jsonb_build_object('status','passed','run_id',${q(runId)},'package_binding_sha256',${q(packageBindingSha256)},'rollback_only',true,'production_write_allowed',false,'identity',${identitySql()}) as evidence;\nrollback;\n`;
  for (const [name,sql] of Object.entries({seed,cleanup,proof})) {
    assertSafeGeneratedSql(name,sql);
  }
  return { plan, seed, cleanup, proof };
}

export function buildRolloverCleanupPackage({ rolloverRunId, fixtureManifest, originalSnapshot, appliedSnapshot, currentSnapshot }) {
  validateRunId(rolloverRunId);
  if (
    fixtureManifest?.operation !== "staging-operational-performance-scale-fixture"
    || fixtureManifest?.target?.projectRef !== STAGING_PROJECT_REF
    || fixtureManifest?.target?.identityNonce !== STAGING_IDENTITY_NONCE
    || fixtureManifest?.target?.organizationId !== ORGANIZATION_ID
    || fixtureManifest?.productionAllowed !== false
    || fixtureManifest?.automaticRetryAllowed !== false
    || !/^[0-9a-f]{64}$/.test(fixtureManifest?.packageBindingSha256 ?? "")
  ) throw new Error("Rollover cleanup source manifest is not an approved staging fixture.");
  const currentIdentity = scaleIdentityFromSnapshot(currentSnapshot);
  const appliedIdentity = scaleIdentityFromSnapshot(appliedSnapshot);
  assertRolloverStableIdentity(currentIdentity, appliedIdentity, "Applied fixture");
  for (const field of ["open_sessions", "open_customer_tabs", "recoverable_hopped_sessions", "processing_financial_mutations", "processing_operational_mutations"]) {
    if (currentSnapshot?.[field] !== 0) throw new Error(`Rollover cleanup snapshot has a dirty ${field} floor.`);
  }
  if (currentSnapshot?.scale_fixture_absent !== false || currentSnapshot?.scale_fixture_key_absent !== false || currentSnapshot?.scale_fixture_rpc_absent !== false) {
    throw new Error("Rollover cleanup snapshot does not contain the applied fixture.");
  }
  const cleanupCore = `${minimalEnvironmentGuardSql()}\n${lockSql()}\n${cleanupStatements(fixtureManifest.runId, originalSnapshot, fixtureManifest.plan, fixtureManifest.packageBindingSha256, { rolloverSafe: true })}`;
  const header = `-- Generated staging-only rollover-safe cleanup for an aged performance fixture.\n-- Rollover run: ${rolloverRunId}\n-- Fixture run: ${fixtureManifest.runId}\n-- Fixture package binding: ${fixtureManifest.packageBindingSha256}\n`;
  const settings = `set local lock_timeout='3s';\nset local statement_timeout='5min';\n`;
  const evidence = (mode) => `select jsonb_build_object('status','passed','operation','staging-operational-performance-scale-rollover-cleanup','rollover_run_id',${q(rolloverRunId)},'fixture_run_id',${q(fixtureManifest.runId)},'fixture_package_binding_sha256',${q(fixtureManifest.packageBindingSha256)},'production_write_allowed',false,'cleanup_complete',${mode === "cleanup" ? "true" : "false"},'rollback_only',${mode === "proof" ? "true" : "false"},'identity',${identitySql()}) as evidence;`;
  const cleanup = `${header}begin;\n${settings}${cleanupCore}\n${evidence("cleanup")}\ncommit;\n`;
  const proof = `${header}begin;\n${settings}${cleanupCore}\n${evidence("proof")}\nrollback;\n`;
  for (const [name, sql] of Object.entries({ cleanup, proof })) assertSafeGeneratedSql(name, sql);
  return {
    cleanup,
    proof,
    temporalShapeBefore: Object.fromEntries(TEMPORAL_SHAPE_COUNT_KEYS.map((key) => [key, appliedSnapshot.shape_counts[key]])),
    temporalShapeNow: Object.fromEntries(TEMPORAL_SHAPE_COUNT_KEYS.map((key) => [key, currentSnapshot.shape_counts[key]]))
  };
}
