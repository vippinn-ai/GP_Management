import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EXPECTED_STAGING_PROJECT_REF = "tkbdyzxwwbhkpztgjjxh";
const EXPECTED_STAGING_SYSTEM_IDENTIFIER = "7623125441096521075";
const EXPECTED_ORGANIZATION_ID = "org-primary";
const PATCHED_FUNCTIONS = ["hop_session_v2", "reject_session_v2", "reject_customer_tab_v2"];
const VERIFIED_FUNCTIONS = [
  ...PATCHED_FUNCTIONS,
  "get_operational_performance_dataset_identity",
  "start_session",
  "open_customer_tab",
  "link_customer_tab_continuation"
];

function argument(name) {
  const marker = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
  if (!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readEvidence(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return parsed.evidence ?? parsed;
}

function normalizeBody(body) {
  return body.replaceAll("\r\n", "\n").trim();
}

function extractSourceDefinition(source, name) {
  const match = source.match(new RegExp(
    `create or replace function public\\.${name}\\(payload jsonb\\)[\\s\\S]*?\\n\\$\\$;`,
    "i"
  ));
  if (!match) throw new Error(`Unable to extract reviewed ${name} definition.`);
  return match[0].trim();
}

function extractSourceBody(definition, name) {
  const match = definition.match(/\bas\s+\$\$([\s\S]*?)\$\$;/i);
  if (!match) throw new Error(`Unable to extract reviewed body for ${name}.`);
  return normalizeBody(match[1]);
}

function extractPgDefinitionBody(definition, name) {
  const match = definition.match(/\bAS\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;?\s*$/i);
  if (!match) throw new Error(`Unable to extract deployed body for ${name}.`);
  return normalizeBody(match[2]);
}

function validateFunctionEvidence(entry, name) {
  if (!entry?.definition || !entry?.definition_md5 || !entry?.owner) throw new Error(`Preflight omitted deployed ${name}.`);
  if (typeof entry.security_definer !== "boolean" || typeof entry.volatility !== "string" || !(entry.config === null || Array.isArray(entry.config))) {
    throw new Error(`Preflight omitted deployed configuration for ${name}.`);
  }
  if (md5(entry.definition) !== entry.definition_md5) throw new Error(`Preflight definition hash mismatch for ${name}.`);
  if (!Array.isArray(entry.acl_detail) || entry.acl_detail.some((grant) => !grant.grantee || grant.privilege_type !== "EXECUTE")) {
    throw new Error(`Preflight ACL detail is incomplete for ${name}.`);
  }
  const ownerName = entry.owner.replaceAll('"', "");
  if (entry.acl_detail.some((grant) => grant.grantor !== ownerName)) {
    throw new Error(`Unsupported non-owner ACL grantor on ${name}; rollback would not be exact.`);
  }
  if (entry.public_execute !== false || entry.anon_execute !== false || entry.authenticated_execute !== true) {
    throw new Error(`Unsafe deployed execution privileges on ${name}.`);
  }
  if (entry.acl_detail.some((grant) => ![ownerName, "authenticated", "service_role"].includes(grant.grantee))) {
    throw new Error(`Unexpected deployed execution grantee on ${name}.`);
  }
}

function metadataGuard(name, expected, hashes, message) {
  const expectedAcl = JSON.stringify(expected.acl_detail);
  const expectedConfig = JSON.stringify(expected.config ?? null);
  const definitionCondition = hashes.definitionMd5
    ? `actual_definition_md5 is distinct from ${sqlLiteral(hashes.definitionMd5)} or `
    : "";
  const reviewedAttributeCondition = hashes.definitionMd5 ? "" : `
    or actual_strict is distinct from false
    or actual_parallel is distinct from 'u'
    or actual_leakproof is distinct from false
    or actual_cost is distinct from 100::real
    or actual_rows is distinct from 0::real
    or actual_returns_set is distinct from false
    or actual_result is distinct from 'jsonb'
    or actual_kind is distinct from 'f'
    or actual_support is distinct from 0::oid`;
  return `select md5(pg_get_functiondef(p.oid)), md5(btrim(p.prosrc)), quote_ident(pg_get_userbyid(p.proowner)), p.prosecdef, p.provolatile, to_jsonb(p.proconfig),
    p.proisstrict, p.proparallel, p.proleakproof, p.procost, p.prorows, p.proretset, pg_get_function_result(p.oid), p.prokind, p.prosupport,
    (select jsonb_agg(jsonb_build_object(
      'grantor',case when acl_items.grantor=0 then 'PUBLIC' else pg_get_userbyid(acl_items.grantor) end,
      'grantee',case when acl_items.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl_items.grantee) end,
      'privilege_type',acl_items.privilege_type,
      'is_grantable',acl_items.is_grantable
    ) order by acl_items.grantee,acl_items.privilege_type)
    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl_items)
  into actual_definition_md5, actual_body_md5, actual_owner, actual_security_definer, actual_volatility, actual_config,
    actual_strict, actual_parallel, actual_leakproof, actual_cost, actual_rows, actual_returns_set, actual_result, actual_kind, actual_support, actual_acl
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname=${sqlLiteral(name)} and pg_get_function_identity_arguments(p.oid)='payload jsonb';
  if ${definitionCondition}actual_body_md5 is distinct from ${sqlLiteral(hashes.bodyMd5)}
    or actual_owner is distinct from ${sqlLiteral(expected.owner)}
    or actual_security_definer is distinct from ${expected.security_definer === true ? "true" : "false"}
    or actual_volatility is distinct from ${sqlLiteral(expected.volatility)}
    or actual_config is distinct from ${sqlLiteral(expectedConfig)}::jsonb
    ${reviewedAttributeCondition}
    or actual_acl is distinct from ${sqlLiteral(expectedAcl)}::jsonb
  then raise exception ${sqlLiteral(message)}; end if;`;
}

function restoreExecutionAcl(name, entry) {
  const quoteRole = (role) => role === "PUBLIC" ? "public" : `"${String(role).replaceAll('"', '""')}"`;
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
  for (const grant of entry.acl_detail) {
    statements.push(`grant execute on function public.${name}(jsonb) to ${quoteRole(grant.grantee)}${grant.is_grantable ? " with grant option" : ""};`);
  }
  return statements;
}

const root = process.cwd();
const runId = argument("run-id");
if (!/^normops-\d{8}-\d{4}-[a-z0-9-]+$/i.test(runId)) throw new Error("Run id must match normops-YYYYMMDD-HHMM-<slug>.");
const preflightPath = path.resolve(root, argument("preflight"));
const preflightText = fs.readFileSync(preflightPath, "utf8");
const preflight = readEvidence(preflightPath);

if (preflight.expected_project_ref !== EXPECTED_STAGING_PROJECT_REF) throw new Error("Preflight project ref is not staging.");
if (preflight.system_identifier !== EXPECTED_STAGING_SYSTEM_IDENTIFIER) throw new Error("Preflight physical database is not staging.");
if (preflight.environment_identity?.environment !== "staging" || preflight.environment_identity?.project_ref !== EXPECTED_STAGING_PROJECT_REF || !/^[0-9a-f-]{36}$/i.test(preflight.environment_identity?.identity_nonce || "")) {
  throw new Error("Preflight lacks the database-derived staging identity anchor.");
}
if (preflight.organization_id !== EXPECTED_ORGANIZATION_ID || preflight.organization_exists !== true) throw new Error("Preflight organization identity is invalid.");
if (preflight.open_sessions !== 0 || preflight.open_customer_tabs !== 0) throw new Error("Staging operational floor is not clean.");
if (preflight.recoverable_hopped_sessions !== 0) throw new Error("Staging has an unconsumed recoverable hopped session.");
if (preflight.processing_financial_mutations !== 0 || preflight.processing_operational_mutations !== 0) throw new Error("Staging has an incomplete mutation.");
for (const field of ["version", "bytes"]) if (!Number.isInteger(preflight.app_state?.[field])) throw new Error(`Preflight app_state ${field} is missing.`);
for (const field of ["md5", "updated_at", "updated_by"]) if (!preflight.app_state?.[field]) throw new Error(`Preflight app_state ${field} is missing.`);

const deployedFunctions = new Map((preflight.functions ?? []).map((entry) => [entry.name, entry]));
for (const name of VERIFIED_FUNCTIONS) validateFunctionEvidence(deployedFunctions.get(name), name);

const lifecyclePath = path.join(root, "supabase", "operational-lifecycle-v2.sql");
const preflightSqlPath = path.join(root, "supabase", "operational-lifecycle-v2-staging-preflight-readonly.sql");
const postflightSqlPath = path.join(root, "supabase", "operational-lifecycle-v2-staging-postflight-readonly.sql");
const lifecycle = fs.readFileSync(lifecyclePath, "utf8");
const reviewedDefinitions = Object.fromEntries(PATCHED_FUNCTIONS.map((name) => [name, extractSourceDefinition(lifecycle, name)]));
const reviewedBodies = Object.fromEntries(PATCHED_FUNCTIONS.map((name) => [name, extractSourceBody(reviewedDefinitions[name], name)]));
for (const name of PATCHED_FUNCTIONS) {
  const definition = reviewedDefinitions[name];
  if (!/\bsecurity\s+definer\b/i.test(definition) || !/\bset\s+search_path\s*=\s*public\b/i.test(definition)) {
    throw new Error(`${name} is missing the required security-definer search path.`);
  }
  if (/\bapp_state\b/i.test(definition) || /patch_app_state/i.test(definition)) throw new Error(`${name} contains a forbidden compatibility-state reference.`);
}

const expectedFunctionBodies = Object.fromEntries(VERIFIED_FUNCTIONS.map((name) => {
  const body = PATCHED_FUNCTIONS.includes(name)
    ? reviewedBodies[name]
    : extractPgDefinitionBody(deployedFunctions.get(name).definition, name);
  return [name, { sha256: sha256(body) }];
}));

const oldGuards = VERIFIED_FUNCTIONS.map((name) => metadataGuard(
  name,
  deployedFunctions.get(name),
  {
    definitionMd5: deployedFunctions.get(name).definition_md5,
    bodyMd5: md5(extractPgDefinitionBody(deployedFunctions.get(name).definition, name))
  },
  `deployed definition, owner, configuration, or ACL drift for ${name}`
)).join("\n  ");
const installedExpectations = Object.fromEntries(VERIFIED_FUNCTIONS.map((name) => [name, PATCHED_FUNCTIONS.includes(name) ? {
  ...deployedFunctions.get(name), security_definer: true, volatility: "v", config: ["search_path=public"]
} : deployedFunctions.get(name)]));
const installedGuards = VERIFIED_FUNCTIONS.map((name) => metadataGuard(
  name,
  installedExpectations[name],
  {
    definitionMd5: PATCHED_FUNCTIONS.includes(name) ? null : deployedFunctions.get(name).definition_md5,
    bodyMd5: md5(PATCHED_FUNCTIONS.includes(name) ? reviewedBodies[name] : extractPgDefinitionBody(deployedFunctions.get(name).definition, name))
  },
  `installed definition, owner, configuration, or ACL mismatch for ${name}`
)).join("\n  ");

const baselineSql = `create temp table operational_v2_reinstall_baseline on commit drop as
select version, md5(data::text) as data_md5, octet_length(data::text) as data_bytes, updated_at, updated_by
from public.app_state where id='primary';`;
const environmentGuard = `if current_database()<>'postgres' or (select system_identifier::text from pg_control_system())<>${sqlLiteral(EXPECTED_STAGING_SYSTEM_IDENTIFIER)} then raise exception 'physical database is not the approved staging cluster'; end if;
  if not exists(select 1 from public.deployment_environment_identity where environment='staging' and project_ref=${sqlLiteral(EXPECTED_STAGING_PROJECT_REF)} and identity_nonce=${sqlLiteral(preflight.environment_identity.identity_nonce)}::uuid) then raise exception 'database-derived staging identity drift'; end if;
  if not exists(select 1 from public.organizations where id=${sqlLiteral(EXPECTED_ORGANIZATION_ID)}) then raise exception 'staging organization identity failed'; end if;`;
const appStateGuard = `if (select count(*) from public.app_state where id='primary') <> 1 or exists(
    select 1 from public.app_state a cross join operational_v2_reinstall_baseline b
    where a.id='primary' and (a.version,a.updated_at,a.updated_by,md5(a.data::text),octet_length(a.data::text))
      is distinct from (b.version,b.updated_at,b.updated_by,b.data_md5,b.data_bytes)
  ) then raise exception 'reinstall changed compatibility app_state'; end if;`;

const install = [
  `-- Immutable, preflight-bound staging-only v2 function reinstall for ${runId}.`,
  "begin;",
  baselineSql,
  `do $$
declare actual_definition_md5 text; actual_body_md5 text; actual_owner text; actual_security_definer boolean; actual_volatility "char"; actual_config jsonb; actual_strict boolean; actual_parallel "char"; actual_leakproof boolean; actual_cost real; actual_rows real; actual_returns_set boolean; actual_result text; actual_kind "char"; actual_support oid; actual_acl jsonb; incomplete_operational integer := 0;
begin
  ${environmentGuard}
  if (select count(*) from public.sessions where status<>'closed') <> 0 then raise exception 'staging has open sessions'; end if;
  if (select count(*) from public.customer_tabs where status='open') <> 0 then raise exception 'staging has open customer tabs'; end if;
  if exists(
    select 1 from public.sessions source
    where source.organization_id=${sqlLiteral(EXPECTED_ORGANIZATION_ID)} and source.status='closed' and source.close_disposition='hopped' and source.closed_bill_id is null
      and not exists(select 1 from public.sessions consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))
      and not exists(select 1 from public.customer_tabs consumer where consumer.organization_id=source.organization_id and consumer.continued_from_session_ids @> jsonb_build_array(source.id) and not (consumer.status='closed' and consumer.close_disposition='rejected' and consumer.closed_bill_id is null))
  ) then raise exception 'staging has a recoverable unconsumed hopped session'; end if;
  if (select count(*) from public.financial_mutations where status<>'committed') <> 0 then raise exception 'staging has incomplete financial mutations'; end if;
  if to_regclass('public.operational_mutations') is null then raise exception 'operational_mutations is missing'; end if;
  execute 'select count(*) from public.operational_mutations where status<>''committed''' into incomplete_operational;
  if incomplete_operational <> 0 then raise exception 'staging has incomplete operational mutations'; end if;
  if (select version from operational_v2_reinstall_baseline) is distinct from ${Number(preflight.app_state.version)}
    or (select data_md5 from operational_v2_reinstall_baseline) is distinct from ${sqlLiteral(preflight.app_state.md5)}
    or (select data_bytes from operational_v2_reinstall_baseline) is distinct from ${Number(preflight.app_state.bytes)}
    or (select updated_at from operational_v2_reinstall_baseline) is distinct from ${sqlLiteral(preflight.app_state.updated_at)}::timestamptz
    or (select updated_by from operational_v2_reinstall_baseline)::text is distinct from ${sqlLiteral(preflight.app_state.updated_by)} then raise exception 'app_state changed after approved preflight'; end if;
  ${oldGuards}
end $$;`,
  ...PATCHED_FUNCTIONS.map((name) => reviewedDefinitions[name]),
  `do $$
declare actual_definition_md5 text; actual_body_md5 text; actual_owner text; actual_security_definer boolean; actual_volatility "char"; actual_config jsonb; actual_strict boolean; actual_parallel "char"; actual_leakproof boolean; actual_cost real; actual_rows real; actual_returns_set boolean; actual_result text; actual_kind "char"; actual_support oid; actual_acl jsonb;
begin
  ${installedGuards}
  if has_function_privilege('anon','public.hop_session_v2(jsonb)','execute')
    or has_function_privilege('anon','public.reject_session_v2(jsonb)','execute')
    or has_function_privilege('anon','public.reject_customer_tab_v2(jsonb)','execute') then raise exception 'anonymous lifecycle v2 execution is forbidden'; end if;
  if not has_function_privilege('authenticated','public.hop_session_v2(jsonb)','execute')
    or not has_function_privilege('authenticated','public.reject_session_v2(jsonb)','execute')
    or not has_function_privilege('authenticated','public.reject_customer_tab_v2(jsonb)','execute') then raise exception 'authenticated lifecycle v2 execution is missing'; end if;
  ${appStateGuard}
end $$;`,
  "commit;",
  ""
].join("\n\n");

const rollback = [
  `-- Exact, data-preserving staging definition rollback for ${runId}; keep the frontend v2 flag disabled.`,
  "begin;",
  baselineSql,
  `do $$
declare actual_definition_md5 text; actual_body_md5 text; actual_owner text; actual_security_definer boolean; actual_volatility "char"; actual_config jsonb; actual_strict boolean; actual_parallel "char"; actual_leakproof boolean; actual_cost real; actual_rows real; actual_returns_set boolean; actual_result text; actual_kind "char"; actual_support oid; actual_acl jsonb;
begin
  ${environmentGuard}
  ${installedGuards}
end $$;`,
  ...PATCHED_FUNCTIONS.flatMap((name) => {
    const entry = deployedFunctions.get(name);
    return [
      entry.definition.trim() + ";",
      `alter function public.${name}(jsonb) owner to ${entry.owner};`,
      ...restoreExecutionAcl(name, entry)
    ];
  }),
  `do $$
declare actual_definition_md5 text; actual_body_md5 text; actual_owner text; actual_security_definer boolean; actual_volatility "char"; actual_config jsonb; actual_strict boolean; actual_parallel "char"; actual_leakproof boolean; actual_cost real; actual_rows real; actual_returns_set boolean; actual_result text; actual_kind "char"; actual_support oid; actual_acl jsonb;
begin
  ${oldGuards}
  ${appStateGuard}
end $$;`,
  "commit;",
  ""
].join("\n\n");

const outDir = path.join(root, "test-artifacts", "operational-lifecycle-v2", runId);
const installPath = path.join(outDir, "staging-reinstall.sql");
const rollbackPath = path.join(outDir, "staging-reinstall-rollback.sql");
const manifestPath = path.join(outDir, "manifest.json");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(installPath, install, { encoding: "utf8", flag: "wx" });
fs.writeFileSync(rollbackPath, rollback, { encoding: "utf8", flag: "wx" });
const manifest = {
  runId,
  operation: "staging-v2-function-reinstall",
  target: { projectRef: EXPECTED_STAGING_PROJECT_REF, systemIdentifier: EXPECTED_STAGING_SYSTEM_IDENTIFIER, organizationId: EXPECTED_ORGANIZATION_ID },
  preflight: { path: preflightPath, sha256: sha256(preflightText) },
  environmentIdentity: preflight.environment_identity,
  patchedFunctions: PATCHED_FUNCTIONS,
  preservedFunctions: VERIFIED_FUNCTIONS.filter((name) => !PATCHED_FUNCTIONS.includes(name)),
  sources: Object.fromEntries([lifecyclePath, preflightSqlPath, postflightSqlPath].map((file) => [path.relative(root, file), sha256(fs.readFileSync(file))])),
  expectedFunctionBodies,
  artifacts: {
    install: { path: installPath, bytes: Buffer.byteLength(install), sha256: sha256(install) },
    rollback: { path: rollbackPath, bytes: Buffer.byteLength(rollback), sha256: sha256(rollback) }
  }
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ manifestPath, ...manifest }, null, 2) + "\n");
