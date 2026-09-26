import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { assertCleanCandidate, lifecycleSourceIdentity, LIFECYCLE_FUNCTION_SOURCES } from "./lifecycle-runner-guards.mjs";

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
export const FUNCTION_NAMES = Object.keys(LIFECYCLE_FUNCTION_SOURCES);
const LEGACY_NAMES = ["hop_session", "reject_session", "reject_customer_tab"];

export function preflightFunctions(entries, mode) {
  const expected = mode === "initial"
    ? [...LEGACY_NAMES, "start_session", "open_customer_tab", "link_customer_tab_continuation"]
    : [...LEGACY_NAMES, ...FUNCTION_NAMES];
  if (!Array.isArray(entries) || entries.length !== expected.length
    || new Set(entries.map((entry) => entry.name)).size !== entries.length
    || entries.some((entry) => !expected.includes(entry.name))) {
    throw new Error(`Preflight function set is incomplete, duplicated or unexpected for ${mode} mode.`);
  }
  return new Map(entries.map((entry) => [entry.name, entry]));
}

export function packageIdentity(root, commit) {
  assertCleanCandidate(root, commit);
  return { commit, sourceSha256: lifecycleSourceIdentity(root).sha256 };
}

export function assertPackageIdentity(root, commit, expected) {
  if (JSON.stringify(packageIdentity(root, commit)) !== JSON.stringify(expected)) {
    throw new Error("Package clean commit/source identity changed.");
  }
}

export const FUNCTION_ACL = ["authenticated", "postgres"].map((grantee) => ({
  grantor: "postgres", grantee, privilege_type: "EXECUTE", is_grantable: false
}));

export function expectedMetadata(name) {
  if (!FUNCTION_NAMES.includes(name)) throw new Error(`Unknown candidate function ${name}.`);
  return {
    owner: "postgres", security_definer: true,
    volatility: name === "get_operational_performance_dataset_identity" ? "s" : "v",
    config: ["search_path=public"], language: "plpgsql", strict: false, parallel: "u",
    leakproof: false, cost: 100, rows: 0, returns_set: false, result: "jsonb", kind: "f", support: 0,
    acl_detail: FUNCTION_ACL
  };
}

export function assertMetadata(entry, name) {
  const expected = expectedMetadata(name);
  for (const [key, value] of Object.entries(expected)) {
    const observed = key === "acl_detail" && Array.isArray(entry?.[key])
      ? entry[key].map(({ grantor, grantee, privilege_type, is_grantable }) => ({ grantor, grantee, privilege_type, is_grantable }))
        .sort((a, b) => a.grantee < b.grantee ? -1 : a.grantee > b.grantee ? 1 : 0)
      : entry?.[key];
    if (JSON.stringify(observed) !== JSON.stringify(value)) throw new Error(`${name} candidate metadata mismatch: ${key}.`);
  }
}

// One catalog expression is shared by the pre-postflight rollback and install guards.
// No observed postflight value is used to define what is acceptable.
export function metadataExpression(alias = "p") {
  return `jsonb_build_object(
    'owner',quote_ident(pg_get_userbyid(${alias}.proowner)), 'security_definer',${alias}.prosecdef,
    'volatility',${alias}.provolatile, 'config',${alias}.proconfig,
    'language',(select lanname from pg_language where oid=${alias}.prolang),
    'strict',${alias}.proisstrict, 'parallel',${alias}.proparallel, 'leakproof',${alias}.proleakproof,
    'cost',${alias}.procost, 'rows',${alias}.prorows, 'returns_set',${alias}.proretset,
    'result',pg_get_function_result(${alias}.oid), 'kind',${alias}.prokind, 'support',${alias}.prosupport::oid::bigint,
    'acl_detail',(select jsonb_agg(jsonb_build_object(
      'grantor',case when a.grantor=0 then 'PUBLIC' else pg_get_userbyid(a.grantor) end,
      'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'privilege_type',a.privilege_type,'is_grantable',a.is_grantable)
      order by (case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) collate "C",a.privilege_type)
      from aclexplode(coalesce(${alias}.proacl,acldefault('f',${alias}.proowner))) a))`;
}

export function installedGuard(name, body) {
  const bodyMd5 = crypto.createHash("md5").update(body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim()).digest("hex");
  return `if (select ${metadataExpression()} from pg_proc p where p.oid=to_regprocedure('public.${name}(jsonb)'))
      is distinct from ${literal(JSON.stringify(expectedMetadata(name)))}::jsonb
    or (select md5(btrim(replace(replace(prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)), E' \\t\\n\\r'))
      from pg_proc where oid=to_regprocedure('public.${name}(jsonb)')) is distinct from '${bodyMd5}'
  then raise exception 'installed body or metadata drift for ${name}'; end if;`;
}

export function normalizeExecutionAcl(name) {
  return `do $acl$
declare grantee_name text;
begin
  for grantee_name in select distinct case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
    from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid='public.${name}(jsonb)'::regprocedure
  loop
    if grantee_name='PUBLIC' then execute 'revoke all privileges on function public.${name}(jsonb) from public';
    else execute format('revoke all privileges on function public.${name}(jsonb) from %I',grantee_name); end if;
  end loop;
end $acl$;
revoke all privileges on function public.${name}(jsonb) from public, anon, service_role;
grant execute on function public.${name}(jsonb) to postgres, authenticated;`;
}

export function generatedPostflight(root, runId, identity) {
  return fs.readFileSync(path.join(root, "supabase/operational-lifecycle-v2-staging-postflight-readonly.sql"), "utf8")
    .replaceAll("__PACKAGE_RUN_ID__", runId)
    .replaceAll("__SOURCE_COMMIT__", identity.commit)
    .replaceAll("__SOURCE_SHA256__", identity.sourceSha256);
}

export const TABLE_ACL = ["DELETE", "INSERT", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"].map((privilege_type) => ({
  grantor: "postgres", grantee: "postgres", privilege_type, is_grantable: false
}));

// PostgreSQL 17 adds MAINTAIN to the owner's default table privileges.
// Bind a reviewed server version instead of silently accepting an arbitrary ACL.
export function expectedTableAcl(serverVersionNum) {
  if (!Number.isInteger(serverVersionNum) || serverVersionNum < 150000 || serverVersionNum >= 180000) {
    throw new Error("Unsupported or missing PostgreSQL server_version_num; review required.");
  }
  return (serverVersionNum >= 170000
    ? [...TABLE_ACL, { grantor: "postgres", grantee: "postgres", privilege_type: "MAINTAIN", is_grantable: false }]
    : [...TABLE_ACL]).sort((a, b) => a.privilege_type < b.privilege_type ? -1 : a.privilege_type > b.privilege_type ? 1 : 0);
}

export function assertMutationTable(entry) {
  const acl = entry.operational_mutations_acl;
  if (entry.operational_mutations_owner !== "postgres" || entry.operational_mutations_force_rls !== false || !Array.isArray(acl)
    || JSON.stringify([...acl].map(({ grantor, grantee, privilege_type, is_grantable }) => ({ grantor, grantee, privilege_type, is_grantable }))
      .sort((a, b) => a.privilege_type < b.privilege_type ? -1 : a.privilege_type > b.privilege_type ? 1 : 0)) !== JSON.stringify(expectedTableAcl(entry.server_version_num))) {
    throw new Error("Operational mutation table owner/ACL mismatch.");
  }
}

export function mutationTableGuard(serverVersionNum) {
  const acl = expectedTableAcl(serverVersionNum);
  return `if current_setting('server_version_num')::integer <> ${serverVersionNum} then raise exception 'database server version drift'; end if;
  if (select jsonb_build_object('owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
    'policies',(select coalesce(jsonb_agg(polname order by polname),'[]'::jsonb) from pg_policy where polrelid=c.oid),
    'acl',(select jsonb_agg(jsonb_build_object(
      'grantor',case when a.grantor=0 then 'PUBLIC' else pg_get_userbyid(a.grantor) end,
      'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'privilege_type',a.privilege_type,'is_grantable',a.is_grantable) order by a.privilege_type collate "C")
      from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
    from pg_class c where c.oid=to_regclass('public.operational_mutations'))
    is distinct from ${literal(JSON.stringify({ owner: "postgres", rls: true, force_rls: false, policies: [], acl }))}::jsonb
  then raise exception 'operational mutation table security drift'; end if;`;
}
