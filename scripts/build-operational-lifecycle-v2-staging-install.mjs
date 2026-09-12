import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EXPECTED_STAGING_PROJECT_REF = "tkbdyzxwwbhkpztgjjxh";
const EXPECTED_ORGANIZATION_ID = "org-primary";
const REPLACED_FUNCTIONS = ["start_session", "open_customer_tab", "link_customer_tab_continuation"];

function argument(name) {
  const marker = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
  if (!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readEvidence(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return parsed.evidence ?? parsed;
}

function restoreExecutionAcl(name, entry) {
  const quoteRole = (role) => role === "PUBLIC" ? "public" : `"${String(role).replaceAll('"', '""')}"`;
  const acl = entry.acl_detail ?? [];
  const statements = [`do $acl$
declare current_grantee text;
begin
  for current_grantee in
    select distinct case when acl_items.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl_items.grantee) end
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl_items
    where n.nspname='public' and p.proname=${sqlLiteral(name)} and pg_get_function_identity_arguments(p.oid)='payload jsonb'
  loop
    if current_grantee='PUBLIC' then
      execute 'revoke all privileges on function public.${name}(jsonb) from public';
    else
      execute format('revoke all privileges on function public.${name}(jsonb) from %I',current_grantee);
    end if;
  end loop;
end $acl$;`];
  for (const grant of acl) {
    if (grant.privilege_type !== "EXECUTE") throw new Error(`Unsupported privilege ${grant.privilege_type} on ${name}.`);
    statements.push(`grant execute on function public.${name}(jsonb) to ${quoteRole(grant.grantee)}${grant.is_grantable ? " with grant option" : ""};`);
  }
  return statements;
}

const root = process.cwd();
const runId = argument("run-id");
if (!/^normops-\d{8}-\d{4}-[a-z0-9-]+$/i.test(runId)) {
  throw new Error("Run id must match normops-YYYYMMDD-HHMM-<slug>.");
}
const preflightPath = path.resolve(root, argument("preflight"));
const preflightText = fs.readFileSync(preflightPath, "utf8");
const preflight = readEvidence(preflightPath);
if (preflight.expected_project_ref !== EXPECTED_STAGING_PROJECT_REF) throw new Error("Preflight project ref is not staging.");
if (typeof preflight.api_url_setting !== "string" || !preflight.api_url_setting.includes(EXPECTED_STAGING_PROJECT_REF)) {
  throw new Error("Preflight database API URL does not identify staging.");
}
if (preflight.environment_identity?.environment !== "staging" || preflight.environment_identity?.project_ref !== EXPECTED_STAGING_PROJECT_REF || !/^[0-9a-f-]{36}$/i.test(preflight.environment_identity?.identity_nonce || "")) {
  throw new Error("Preflight lacks the database-derived staging identity anchor.");
}
if (preflight.organization_id !== EXPECTED_ORGANIZATION_ID || preflight.organization_exists !== true) throw new Error("Preflight organization identity is invalid.");
if (preflight.open_sessions !== 0 || preflight.open_customer_tabs !== 0) throw new Error("Staging operational floor is not clean.");
if (preflight.recoverable_hopped_sessions !== 0) throw new Error("Staging has an unconsumed recoverable hopped session.");
if (preflight.processing_financial_mutations !== 0 || preflight.processing_operational_mutations !== 0) throw new Error("Staging has an incomplete mutation.");
if (!preflight.app_state?.md5 || !Number.isInteger(preflight.app_state?.version)) throw new Error("Preflight app_state baseline is incomplete.");

const deployedFunctions = new Map((preflight.functions ?? []).map((entry) => [entry.name, entry]));
for (const name of REPLACED_FUNCTIONS) {
  const entry = deployedFunctions.get(name);
  if (!entry?.definition || !entry?.definition_md5 || !entry?.owner) throw new Error(`Preflight omitted deployed ${name}.`);
  if (typeof entry.security_definer !== "boolean" || typeof entry.volatility !== "string" || !(entry.config === null || Array.isArray(entry.config))) {
    throw new Error(`Preflight omitted deployed configuration for ${name}.`);
  }
  if (crypto.createHash("md5").update(entry.definition).digest("hex") !== entry.definition_md5) {
    throw new Error(`Preflight definition hash mismatch for ${name}.`);
  }
  if (!Array.isArray(entry.acl_detail) || entry.acl_detail.some((grant) => !grant.grantee || grant.privilege_type !== "EXECUTE")) throw new Error(`Preflight ACL detail is incomplete for ${name}.`);
  const ownerName = entry.owner.replaceAll('"', "");
  if (entry.acl_detail.some((grant) => grant.grantor !== ownerName)) throw new Error(`Unsupported non-owner ACL grantor on ${name}; rollback would not be exact.`);
}

const lifecyclePath = path.join(root, "supabase", "operational-lifecycle-v2.sql");
const customerTabPath = path.join(root, "supabase", "phase4-customer-tab-rpcs.sql");
const startSessionPath = path.join(root, "supabase", "phase4-start-session-rpc.sql");
const linkContinuationPath = path.join(root, "supabase", "phase4-link-customer-tab-continuation-rpc.sql");
const identityPath = path.join(root, "supabase", "operational-v2-staging-environment-identity.sql");
const datasetIdentityPath = path.join(root, "supabase", "operational-performance-dataset-identity-staging.sql");
const outDir = path.join(root, "test-artifacts", "operational-lifecycle-v2", runId);
const installPath = path.join(outDir, "staging-install.sql");
const rollbackPath = path.join(outDir, "staging-rollback.sql");
const manifestPath = path.join(outDir, "manifest.json");

const lifecycle = fs.readFileSync(lifecyclePath, "utf8").trim();
const datasetIdentity = fs.readFileSync(datasetIdentityPath, "utf8").trim();
const customerTabs = fs.readFileSync(customerTabPath, "utf8");
const startSession = fs.readFileSync(startSessionPath, "utf8");
const linkContinuation = fs.readFileSync(linkContinuationPath, "utf8");
function extractFunction(source, name) {
  const match = source.match(new RegExp(
    `create or replace function public\\.${name}\\(payload jsonb\\)[\\s\\S]*?\\$\\$;\\s*[\\s\\S]*?grant execute on function public\\.${name}\\(jsonb\\) to authenticated;`,
    "i"
  ));
  if (!match) throw new Error(`Unable to extract reviewed ${name} function and grants.`);
  return match[0].trim();
}
function normalizeBody(body) {
  return body.replaceAll("\r\n", "\n").trim();
}
function extractFunctionBody(source, name) {
  const definition = extractFunction(source, name);
  const match = definition.match(/\bas\s+\$\$([\s\S]*?)\$\$;/i);
  if (!match) throw new Error(`Unable to extract reviewed body for ${name}.`);
  return normalizeBody(match[1]);
}
function extractPgDefinitionBody(definition, name) {
  const match = definition.match(/\bAS\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;?\s*$/i);
  if (!match) throw new Error(`Unable to extract deployed body for ${name}.`);
  return normalizeBody(match[2]);
}
const reviewedFunctions = {
  hop_session_v2: extractFunction(lifecycle, "hop_session_v2"),
  reject_session_v2: extractFunction(lifecycle, "reject_session_v2"),
  reject_customer_tab_v2: extractFunction(lifecycle, "reject_customer_tab_v2"),
  get_operational_performance_dataset_identity: extractFunction(datasetIdentity, "get_operational_performance_dataset_identity"),
  start_session: extractFunction(startSession, "start_session"),
  open_customer_tab: extractFunction(customerTabs, "open_customer_tab"),
  link_customer_tab_continuation: extractFunction(linkContinuation, "link_customer_tab_continuation")
};
const expectedFunctionBodies = Object.fromEntries(Object.entries(reviewedFunctions).map(([name, definition]) => [name, {
  sha256: sha256(extractFunctionBody(definition, name))
}]));
const rollbackDefinitionGuards = REPLACED_FUNCTIONS.map((name) => {
  const oldBodyMd5 = crypto.createHash("md5").update(extractPgDefinitionBody(deployedFunctions.get(name).definition, name)).digest("hex");
  const installedBodyMd5 = crypto.createHash("md5").update(extractFunctionBody(reviewedFunctions[name], name)).digest("hex");
  return `select md5(btrim(p.prosrc)) into actual_body_md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname=${sqlLiteral(name)} and pg_get_function_identity_arguments(p.oid)='payload jsonb';
  if actual_body_md5 not in (${sqlLiteral(oldBodyMd5)},${sqlLiteral(installedBodyMd5)}) then raise exception 'rollback refused unexpected definition drift for ${name}'; end if;`;
}).join("\n  ");

const oldDefinitionGuards = REPLACED_FUNCTIONS.map((name) => {
  const entry = deployedFunctions.get(name);
  const expectedAcl = JSON.stringify(entry.acl_detail);
  const expectedConfig = JSON.stringify(entry.config ?? null);
  return `select md5(pg_get_functiondef(p.oid)), quote_ident(pg_get_userbyid(p.proowner)), p.prosecdef, p.provolatile, to_jsonb(p.proconfig),
    (select jsonb_agg(jsonb_build_object(
      'grantor',case when acl_items.grantor=0 then 'PUBLIC' else pg_get_userbyid(acl_items.grantor) end,
      'grantee',case when acl_items.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl_items.grantee) end,
      'privilege_type',acl_items.privilege_type,
      'is_grantable',acl_items.is_grantable
    ) order by acl_items.grantee,acl_items.privilege_type)
    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl_items)
  into actual_hash, actual_owner, actual_security_definer, actual_volatility, actual_config, actual_acl
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname=${sqlLiteral(name)} and pg_get_function_identity_arguments(p.oid)='payload jsonb';
  if actual_hash is distinct from ${sqlLiteral(entry.definition_md5)}
    or actual_owner is distinct from ${sqlLiteral(entry.owner)}
    or actual_security_definer is distinct from ${entry.security_definer === true ? "true" : "false"}
    or actual_volatility is distinct from ${sqlLiteral(entry.volatility)}
    or actual_config is distinct from ${sqlLiteral(expectedConfig)}::jsonb
    or actual_acl is distinct from ${sqlLiteral(expectedAcl)}::jsonb
  then raise exception 'deployed definition drift for ${name}: definition, owner, configuration, or ACL changed'; end if;`;
}).join("\n  ");

const install = [
  `-- Immutable, preflight-bound staging install for ${runId}.`,
  "begin;",
  `create temp table operational_v2_install_baseline on commit drop as
select version, md5(data::text) as data_md5, octet_length(data::text) as data_bytes, updated_at, updated_by
from public.app_state where id='primary';`,
  `do $$
declare actual_hash text; actual_owner text; actual_security_definer boolean; actual_volatility "char"; actual_config jsonb; actual_acl jsonb;
begin
  if not exists(select 1 from public.deployment_environment_identity where environment='staging' and project_ref=${sqlLiteral(EXPECTED_STAGING_PROJECT_REF)} and identity_nonce=${sqlLiteral(preflight.environment_identity.identity_nonce)}::uuid) then raise exception 'database-derived staging identity drift'; end if;
  if current_setting('app.settings.api_url', true) is null or position(${sqlLiteral(EXPECTED_STAGING_PROJECT_REF)} in current_setting('app.settings.api_url', true)) = 0 then raise exception 'database API URL does not identify the approved staging project'; end if;
  if not exists(select 1 from public.organizations where id=${sqlLiteral(EXPECTED_ORGANIZATION_ID)}) then raise exception 'staging organization identity failed'; end if;
  if (select count(*) from public.sessions where status<>'closed') <> 0 then raise exception 'staging has open sessions'; end if;
  if (select count(*) from public.customer_tabs where status='open') <> 0 then raise exception 'staging has open customer tabs'; end if;
  if exists(
    select 1 from public.sessions source
    where source.organization_id=${sqlLiteral(EXPECTED_ORGANIZATION_ID)} and source.status='closed' and source.close_disposition='hopped' and source.closed_bill_id is null
      and not exists(select 1 from public.sessions consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))
      and not exists(select 1 from public.customer_tabs consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))
  ) then raise exception 'staging has a recoverable unconsumed hopped session'; end if;
  if (select count(*) from public.financial_mutations where status<>'committed') <> 0 then raise exception 'staging has incomplete financial mutations'; end if;
  if to_regclass('public.operational_mutations') is not null and (select count(*) from public.operational_mutations where status<>'committed') <> 0 then raise exception 'staging has incomplete operational mutations'; end if;
  if (select version from operational_v2_install_baseline) is distinct from ${Number(preflight.app_state.version)}
    or (select data_md5 from operational_v2_install_baseline) is distinct from ${sqlLiteral(preflight.app_state.md5)} then raise exception 'app_state changed after approved preflight'; end if;
  ${oldDefinitionGuards}
end $$;`,
  lifecycle,
  datasetIdentity,
  reviewedFunctions.start_session,
  reviewedFunctions.open_customer_tab,
  reviewedFunctions.link_customer_tab_continuation,
  `do $$
declare function_name text; function_body text;
begin
  foreach function_name in array array['hop_session_v2','reject_session_v2','reject_customer_tab_v2'] loop
    select pg_get_functiondef(p.oid) into function_body from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=function_name and pg_get_function_identity_arguments(p.oid)='payload jsonb';
    if function_body is null then raise exception 'missing installed function %', function_name; end if;
    if function_body ~* '\\mapp_state\\M' or function_body ~* 'patch_app_state' then raise exception 'forbidden app_state reference in %', function_name; end if;
  end loop;
  if has_function_privilege('anon','public.hop_session_v2(jsonb)','execute')
    or has_function_privilege('anon','public.reject_session_v2(jsonb)','execute')
    or has_function_privilege('anon','public.reject_customer_tab_v2(jsonb)','execute') then raise exception 'anonymous lifecycle v2 execution is forbidden'; end if;
  if (select count(*) from public.app_state where id='primary') <> 1 or exists(
    select 1 from public.app_state a cross join operational_v2_install_baseline b
    where a.id='primary' and (a.version,a.updated_at,a.updated_by,md5(a.data::text),octet_length(a.data::text))
      is distinct from (b.version,b.updated_at,b.updated_by,b.data_md5,b.data_bytes)
  ) then raise exception 'install changed compatibility app_state'; end if;
end $$;`,
  "commit;",
  ""
].join("\n\n");

const rollback = [
  `-- Data-preserving definition rollback for ${runId}; disable VITE_BACKEND_OPERATIONAL_RPC_V2 first.`,
  "begin;",
  `do $$
declare actual_body_md5 text;
begin
  if coalesce(current_setting('app.settings.api_url', true), '') not like '%${EXPECTED_STAGING_PROJECT_REF}%'
    then raise exception 'database-owned staging API URL identity drift'; end if;
  if not exists(
    select 1 from public.deployment_environment_identity
    where environment='staging'
      and project_ref=${sqlLiteral(EXPECTED_STAGING_PROJECT_REF)}
      and identity_nonce=${sqlLiteral(preflight.environment_identity.identity_nonce)}::uuid
  ) then raise exception 'database-derived staging identity drift'; end if;
  if not exists(select 1 from public.organizations where id=${sqlLiteral(EXPECTED_ORGANIZATION_ID)})
    then raise exception 'staging organization identity failed'; end if;
  ${rollbackDefinitionGuards}
end $$;`,
  ...REPLACED_FUNCTIONS.flatMap((name) => {
    const entry = deployedFunctions.get(name);
    return [
      entry.definition.trim() + ";",
      `alter function public.${name}(jsonb) owner to ${entry.owner};`,
      ...restoreExecutionAcl(name, entry)
    ];
  }),
  "commit;",
  ""
].join("\n\n");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(installPath, install, { encoding: "utf8", flag: "wx" });
fs.writeFileSync(rollbackPath, rollback, { encoding: "utf8", flag: "wx" });
const manifest = {
  runId,
  target: { projectRef: EXPECTED_STAGING_PROJECT_REF, organizationId: EXPECTED_ORGANIZATION_ID },
  preflight: { path: preflightPath, sha256: sha256(preflightText) },
  environmentIdentity: preflight.environment_identity,
  sources: Object.fromEntries([lifecyclePath, datasetIdentityPath, startSessionPath, customerTabPath, linkContinuationPath, identityPath].map((file) => [path.relative(root, file), sha256(fs.readFileSync(file))])),
  expectedFunctionBodies,
  artifacts: {
    install: { path: installPath, bytes: Buffer.byteLength(install), sha256: sha256(install) },
    rollback: { path: rollbackPath, bytes: Buffer.byteLength(rollback), sha256: sha256(rollback) }
  }
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ manifestPath, ...manifest }, null, 2) + "\n");
