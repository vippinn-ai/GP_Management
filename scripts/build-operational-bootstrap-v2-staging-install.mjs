import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const EXPECTED_PROJECT_REF = "tkbdyzxwwbhkpztgjjxh";
const EXPECTED_SYSTEM_IDENTIFIER = "7623125441096521075";
const FUNCTION = "load_operational_bootstrap_v2";

function argument(name) {
  const marker = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
  if (!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return value;
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const md5 = (value) => crypto.createHash("md5").update(value).digest("hex");
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const quoteRole = (role) => role === "PUBLIC" ? "public" : `"${String(role).replaceAll('"', '""')}"`;
const normalizeBody = (body) => body.replaceAll("\r\n", "\n").trim();

function readEvidence(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return parsed.evidence ?? parsed;
}

function extractReviewedBody(source) {
  const match = source.match(/\bas\s+\$\$([\s\S]*?)\$\$;/i);
  if (!match) throw new Error("Unable to extract the reviewed bootstrap function body.");
  return normalizeBody(match[1]);
}

function extractDeployedBody(definition) {
  const match = definition.match(/\bAS\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;?\s*$/i);
  if (!match) throw new Error("Unable to extract the preflight bootstrap function body.");
  return normalizeBody(match[2]);
}

function restoreAcl(entry) {
  const statements = [`do $acl$
declare grantee_name text;
begin
  for grantee_name in
    select distinct case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where n.nspname = 'public' and p.proname = '${FUNCTION}' and pg_get_function_identity_arguments(p.oid) = ''
  loop
    if grantee_name = 'PUBLIC' then
      execute 'revoke all privileges on function public.${FUNCTION}() from public';
    else
      execute format('revoke all privileges on function public.${FUNCTION}() from %I', grantee_name);
    end if;
  end loop;
end $acl$;`];
  for (const grant of entry.acl_detail ?? []) {
    if (grant.privilege_type !== "EXECUTE") throw new Error(`Unsupported privilege ${grant.privilege_type}.`);
    statements.push(`grant execute on function public.${FUNCTION}() to ${quoteRole(grant.grantee)}${grant.is_grantable ? " with grant option" : ""};`);
  }
  return statements;
}

const root = process.cwd();
const runId = argument("run-id");
if (!/^normops-\d{8}-\d{4}-[a-z0-9-]+$/i.test(runId)) throw new Error("Run id must match normops-YYYYMMDD-HHMM-<slug>.");
const preflightPath = path.resolve(root, argument("preflight"));
const preflightText = fs.readFileSync(preflightPath, "utf8");
const preflight = readEvidence(preflightPath);
if (preflight.expected_project_ref !== EXPECTED_PROJECT_REF) throw new Error("Preflight project ref is not staging.");
if (preflight.system_identifier !== EXPECTED_SYSTEM_IDENTIFIER) throw new Error("Preflight physical database is not staging.");
if (preflight.environment_identity?.environment !== "staging" || preflight.environment_identity?.project_ref !== EXPECTED_PROJECT_REF) {
  throw new Error("Preflight lacks the staging database identity anchor.");
}
if (!/^[0-9a-f-]{36}$/i.test(preflight.environment_identity?.identity_nonce ?? "")) throw new Error("Preflight identity nonce is invalid.");
if (preflight.organization_id !== "org-primary") throw new Error("Preflight organization is invalid.");
if (preflight.open_sessions !== 0 || preflight.open_customer_tabs !== 0) throw new Error("Staging operational floor is not clean.");
if (preflight.processing_financial_mutations !== 0 || preflight.processing_operational_mutations !== 0) throw new Error("Staging has an incomplete mutation.");
if (!Number.isInteger(preflight.app_state?.version) || !/^[0-9a-f]{32}$/i.test(preflight.app_state?.md5 ?? "")) throw new Error("Preflight app_state evidence is incomplete.");
if (preflight.realtime_security?.rls_enabled !== true || !Array.isArray(preflight.realtime_security?.policies)) throw new Error("Preflight realtime RLS evidence is incomplete.");
if (preflight.realtime_security.published !== true) throw new Error("Operational events is not published to staging realtime.");
if (!preflight.realtime_security.policies.some((policy) =>
  String(policy.command).toUpperCase() === "SELECT"
  && Array.isArray(policy.roles)
  && policy.roles.includes("authenticated")
  && /current_user_has_org_access\s*\(\s*organization_id\s*\)/i.test(policy.using ?? "")
)) throw new Error("Operational events RLS does not prove tenant-scoped authenticated reads.");
if (!/organization_members[\s\S]*membership\.active = true/i.test(preflight.realtime_security?.access_helper_definition ?? "")) {
  throw new Error("Realtime organization access helper does not prove active membership.");
}

const previous = preflight.target_function ?? null;
if (previous) {
  if (!previous.definition || md5(previous.definition) !== previous.definition_md5 || !previous.owner || !Array.isArray(previous.acl_detail)) {
    throw new Error("Preflight target function evidence is incomplete or inconsistent.");
  }
  const ownerName = previous.owner.replaceAll('"', "");
  if (previous.acl_detail.some((grant) => grant.grantor !== ownerName || grant.privilege_type !== "EXECUTE")) {
    throw new Error("Preflight target function has an unsupported ACL grantor or privilege.");
  }
}

const reviewedPath = path.join(root, "supabase", "operational-bootstrap-v2.sql");
const reviewed = fs.readFileSync(reviewedPath, "utf8").trim();
const reviewedBodyMd5 = md5(extractReviewedBody(reviewed));
const outDir = path.join(root, "test-artifacts", "operational-bootstrap-v2", runId);
const installPath = path.join(outDir, "staging-install.sql");
const rollbackPath = path.join(outDir, "staging-rollback.sql");
const manifestPath = path.join(outDir, "manifest.json");

const priorGuard = previous
  ? `select md5(pg_get_functiondef(p.oid)), quote_ident(pg_get_userbyid(p.proowner)), p.prosecdef,
    p.provolatile, to_jsonb(p.proconfig), (
      select jsonb_agg(jsonb_build_object(
        'grantor', case when acl.grantor = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantor) end,
        'grantee', case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
        'privilege_type', acl.privilege_type, 'is_grantable', acl.is_grantable
      ) order by acl.grantee, acl.privilege_type)
      from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    )
  into actual_definition_md5, actual_owner, actual_security_definer, actual_volatility, actual_config, actual_acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = '${FUNCTION}' and pg_get_function_identity_arguments(p.oid) = '';
  if actual_definition_md5 is distinct from ${sqlLiteral(previous.definition_md5)}
    or actual_owner is distinct from ${sqlLiteral(previous.owner)}
    or actual_security_definer is distinct from ${previous.security_definer === true ? "true" : "false"}
    or actual_volatility is distinct from ${sqlLiteral(previous.volatility)}
    or actual_config is distinct from ${sqlLiteral(JSON.stringify(previous.config ?? null))}::jsonb
    or actual_acl is distinct from ${sqlLiteral(JSON.stringify(previous.acl_detail))}::jsonb
  then raise exception 'bootstrap function definition, owner, configuration, or ACL changed after preflight'; end if;`
  : `if to_regprocedure('public.${FUNCTION}()') is not null then raise exception 'unexpected bootstrap function appeared after preflight'; end if;`;

const commonIdentityGuard = `if current_database() <> 'postgres' or (select system_identifier::text from pg_control_system()) <> '${EXPECTED_SYSTEM_IDENTIFIER}'
    then raise exception 'physical database is not approved staging'; end if;
  if not exists (select 1 from public.deployment_environment_identity
    where environment = 'staging' and project_ref = '${EXPECTED_PROJECT_REF}'
      and identity_nonce = ${sqlLiteral(preflight.environment_identity.identity_nonce)}::uuid)
    then raise exception 'staging database identity drift'; end if;`;

const install = [`-- Preflight-bound atomic bootstrap staging install: ${runId}`,
  "begin;",
  `create temp table bootstrap_install_app_state on commit drop as
select version, md5(data::text) data_md5, octet_length(data::text) data_bytes, updated_at, updated_by
from public.app_state where id = 'primary';`,
  `do $$
declare actual_definition_md5 text; actual_owner text; actual_security_definer boolean;
  actual_volatility "char"; actual_config jsonb; actual_acl jsonb;
begin
  ${commonIdentityGuard}
  if (select version from bootstrap_install_app_state) is distinct from ${preflight.app_state.version}
    or (select data_md5 from bootstrap_install_app_state) is distinct from ${sqlLiteral(preflight.app_state.md5)}
    then raise exception 'app_state changed after preflight'; end if;
  ${priorGuard}
end $$;`,
  reviewed,
  `do $$
declare body_md5 text;
begin
  select md5(btrim(p.prosrc)) into body_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = '${FUNCTION}' and pg_get_function_identity_arguments(p.oid) = '';
  if body_md5 is distinct from ${sqlLiteral(reviewedBodyMd5)} then raise exception 'installed bootstrap body mismatch'; end if;
  if has_function_privilege('public', 'public.${FUNCTION}()', 'execute')
    or has_function_privilege('anon', 'public.${FUNCTION}()', 'execute')
    or not has_function_privilege('authenticated', 'public.${FUNCTION}()', 'execute')
    then raise exception 'installed bootstrap ACL mismatch'; end if;
  if exists (select 1 from public.app_state a cross join bootstrap_install_app_state b where a.id = 'primary'
    and (a.version, md5(a.data::text), octet_length(a.data::text), a.updated_at, a.updated_by)
      is distinct from (b.version, b.data_md5, b.data_bytes, b.updated_at, b.updated_by))
    then raise exception 'bootstrap install changed app_state'; end if;
end $$;`,
  "commit;", ""].join("\n\n");

const rollbackGuard = `select md5(btrim(p.prosrc)) into body_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = '${FUNCTION}' and pg_get_function_identity_arguments(p.oid) = '';
  if body_md5 is distinct from ${sqlLiteral(reviewedBodyMd5)} then raise exception 'rollback refused unexpected bootstrap definition drift'; end if;`;
const restore = previous
  ? [previous.definition.trim() + ";", `alter function public.${FUNCTION}() owner to ${previous.owner};`, ...restoreAcl(previous)]
  : [`drop function public.${FUNCTION}();`];
const rollback = [`-- Exact definition rollback for ${runId}; disable VITE_BACKEND_ATOMIC_BOOTSTRAP first.`,
  "begin;",
  `do $$ declare body_md5 text; begin ${commonIdentityGuard} ${rollbackGuard} end $$;`,
  ...restore,
  "commit;", ""].join("\n\n");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(installPath, install, { encoding: "utf8", flag: "wx" });
fs.writeFileSync(rollbackPath, rollback, { encoding: "utf8", flag: "wx" });
const manifest = {
  runId,
  environment: "staging",
  projectRef: EXPECTED_PROJECT_REF,
  systemIdentifier: EXPECTED_SYSTEM_IDENTIFIER,
  sourceCommit: process.env.SOURCE_COMMIT ?? null,
  preflight: { path: path.relative(root, preflightPath), sha256: sha256(preflightText) },
  reviewedSql: { path: path.relative(root, reviewedPath), sha256: sha256(reviewed), bodyMd5: reviewedBodyMd5 },
  previousFunctionExisted: Boolean(previous),
  install: { path: path.relative(root, installPath), sha256: sha256(install) },
  rollback: { path: path.relative(root, rollbackPath), sha256: sha256(rollback) }
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
