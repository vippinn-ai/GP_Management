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
  const statements = [
    `revoke all on function public.${name}(jsonb) from public;`,
    `revoke execute on function public.${name}(jsonb) from anon;`,
    `revoke execute on function public.${name}(jsonb) from authenticated;`,
    `revoke execute on function public.${name}(jsonb) from service_role;`
  ];
  for (const [role, enabled] of [
    ["public", entry.public_execute],
    ["anon", entry.anon_execute],
    ["authenticated", entry.authenticated_execute],
    ["service_role", entry.service_role_execute]
  ]) {
    if (enabled === true) statements.push(`grant execute on function public.${name}(jsonb) to ${role};`);
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
if (preflight.organization_id !== EXPECTED_ORGANIZATION_ID || preflight.organization_exists !== true) throw new Error("Preflight organization identity is invalid.");
if (preflight.open_sessions !== 0 || preflight.open_customer_tabs !== 0) throw new Error("Staging operational floor is not clean.");
if (preflight.processing_financial_mutations !== 0 || preflight.processing_operational_mutations !== 0) throw new Error("Staging has an incomplete mutation.");
if (!preflight.app_state?.md5 || !Number.isInteger(preflight.app_state?.version)) throw new Error("Preflight app_state baseline is incomplete.");

const deployedFunctions = new Map((preflight.functions ?? []).map((entry) => [entry.name, entry]));
for (const name of REPLACED_FUNCTIONS) {
  const entry = deployedFunctions.get(name);
  if (!entry?.definition || !entry?.definition_md5 || !entry?.owner) throw new Error(`Preflight omitted deployed ${name}.`);
  if (crypto.createHash("md5").update(entry.definition).digest("hex") !== entry.definition_md5) {
    throw new Error(`Preflight definition hash mismatch for ${name}.`);
  }
  const supportedAclRoles = new Set(["", "PUBLIC", "public", "anon", "authenticated", "service_role", entry.owner.replaceAll('"', "")]);
  for (const aclEntry of entry.acl ?? []) {
    const role = String(aclEntry).split("=")[0].replaceAll('"', "");
    if (!supportedAclRoles.has(role)) throw new Error(`Unsupported deployed ACL role ${role} on ${name}; rollback would not be exact.`);
  }
}

const lifecyclePath = path.join(root, "supabase", "operational-lifecycle-v2.sql");
const customerTabPath = path.join(root, "supabase", "phase4-customer-tab-rpcs.sql");
const startSessionPath = path.join(root, "supabase", "phase4-start-session-rpc.sql");
const linkContinuationPath = path.join(root, "supabase", "phase4-link-customer-tab-continuation-rpc.sql");
const outDir = path.join(root, "test-artifacts", "operational-lifecycle-v2", runId);
const installPath = path.join(outDir, "staging-install.sql");
const rollbackPath = path.join(outDir, "staging-rollback.sql");
const manifestPath = path.join(outDir, "manifest.json");

const lifecycle = fs.readFileSync(lifecyclePath, "utf8").trim();
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

const oldDefinitionGuards = REPLACED_FUNCTIONS.map((name) => {
  const expected = deployedFunctions.get(name).definition_md5;
  return `select md5(pg_get_functiondef(p.oid)) into actual_hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=${sqlLiteral(name)} and pg_get_function_identity_arguments(p.oid)='payload jsonb';\n  if actual_hash is distinct from ${sqlLiteral(expected)} then raise exception 'deployed definition drift for ${name}'; end if;`;
}).join("\n  ");

const install = [
  `-- Immutable, preflight-bound staging install for ${runId}.`,
  "begin;",
  `create temp table operational_v2_install_baseline on commit drop as
select version, md5(data::text) as data_md5, octet_length(data::text) as data_bytes, updated_at, updated_by
from public.app_state where id='primary';`,
  `do $$
declare actual_hash text;
begin
  if not exists(select 1 from public.organizations where id=${sqlLiteral(EXPECTED_ORGANIZATION_ID)}) then raise exception 'staging organization identity failed'; end if;
  if (select count(*) from public.sessions where status<>'closed') <> 0 then raise exception 'staging has open sessions'; end if;
  if (select count(*) from public.customer_tabs where status='open') <> 0 then raise exception 'staging has open customer tabs'; end if;
  if (select count(*) from public.financial_mutations where status<>'committed') <> 0 then raise exception 'staging has incomplete financial mutations'; end if;
  if (select version from operational_v2_install_baseline) is distinct from ${Number(preflight.app_state.version)}
    or (select data_md5 from operational_v2_install_baseline) is distinct from ${sqlLiteral(preflight.app_state.md5)} then raise exception 'app_state changed after approved preflight'; end if;
  ${oldDefinitionGuards}
end $$;`,
  lifecycle,
  extractFunction(startSession, "start_session"),
  extractFunction(customerTabs, "open_customer_tab"),
  extractFunction(linkContinuation, "link_customer_tab_continuation"),
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
  if exists(
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
  sources: Object.fromEntries([lifecyclePath, startSessionPath, customerTabPath, linkContinuationPath].map((file) => [path.relative(root, file), sha256(fs.readFileSync(file))])),
  artifacts: {
    install: { path: installPath, bytes: Buffer.byteLength(install), sha256: sha256(install) },
    rollback: { path: rollbackPath, bytes: Buffer.byteLength(rollback), sha256: sha256(rollback) }
  }
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ manifestPath, ...manifest }, null, 2) + "\n");
