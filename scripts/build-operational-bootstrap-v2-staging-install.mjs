import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXPECTED_PROJECT_REF = "tkbdyzxwwbhkpztgjjxh";
const EXPECTED_SYSTEM_IDENTIFIER = "7623125441096521075";
const FUNCTION = "load_operational_bootstrap_v2";
const ACCESS_HELPER_BODY_MD5 = "1582c0fa10f3c451fee64540e43de6f7";

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
const normalizeBody = (body) => body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
const normalizedBodySql = (expression) => `md5(replace(replace(btrim(${expression}, E' \\t\\n\\r'), E'\\r\\n', E'\\n'), E'\\r', E'\\n'))`;

function applicableSelectPolicy(policy, authenticatedRoles) {
  const command = String(policy.command ?? "").toUpperCase();
  const roles = Array.isArray(policy.roles) ? policy.roles.map((role) => String(role).toLowerCase()) : [];
  return (command === "SELECT" || command === "ALL")
    && roles.some((role) => role === "public" || authenticatedRoles.has(role));
}

function tenantScopedAuthenticatedPolicy(policy) {
  const roles = Array.isArray(policy.roles) ? policy.roles.map((role) => String(role).toLowerCase()).sort() : [];
  const normalizedUsing = String(policy.using ?? "")
    .toLowerCase()
    .replaceAll(/\s+/g, "")
    .replace(/^\((.*)\)$/, "$1");
  return roles.length === 1
    && roles[0] === "authenticated"
    && String(policy.permissive ?? "").toUpperCase() === "PERMISSIVE"
    && normalizedUsing === "current_user_has_org_access(organization_id)";
}

function gitOutput(root, args) {
  return execFileSync("git", ["-c", `safe.directory=${root}`, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

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
const sourceCommit = argument("source-commit");
if (!/^normops-\d{8}-\d{4}-[a-z0-9-]+$/i.test(runId)) throw new Error("Run id must match normops-YYYYMMDD-HHMM-<slug>.");
if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) throw new Error("Source commit must be an exact 40-character Git SHA.");
const actualHead = gitOutput(root, ["rev-parse", "HEAD"]);
if (actualHead !== sourceCommit) throw new Error(`Source commit ${sourceCommit} does not match HEAD ${actualHead}.`);
if (gitOutput(root, ["status", "--porcelain"]) !== "") throw new Error("Source worktree must be clean before staging artifacts are built.");
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
if (!preflight.installer_role || typeof preflight.installer_role !== "string") throw new Error("Preflight installer role is missing.");
if (preflight.realtime_security?.rls_enabled !== true || !Array.isArray(preflight.realtime_security?.policies)) throw new Error("Preflight realtime RLS evidence is incomplete.");
if (preflight.realtime_security.published !== true) throw new Error("Operational events is not published to staging realtime.");
const authenticatedRoleMemberships = preflight.realtime_security?.authenticated_role_memberships;
if (!Array.isArray(authenticatedRoleMemberships)
  || authenticatedRoleMemberships.length === 0
  || authenticatedRoleMemberships.some((role) => typeof role !== "string" || !role.trim())
  || !authenticatedRoleMemberships.some((role) => role.toLowerCase() === "authenticated")) {
  throw new Error("Preflight authenticated role-membership evidence is incomplete.");
}
const authenticatedRoles = new Set(authenticatedRoleMemberships.map((role) => role.toLowerCase()));
const applicablePolicies = preflight.realtime_security.policies.filter((policy) => applicableSelectPolicy(policy, authenticatedRoles));
if (applicablePolicies.length !== 1 || !tenantScopedAuthenticatedPolicy(applicablePolicies[0])) {
  throw new Error("Operational events SELECT policies do not prove exactly one permissive tenant-scoped authenticated-only policy.");
}
const accessHelper = preflight.realtime_security?.access_helper;
if (!/^[0-9a-f]{32}$/i.test(accessHelper?.definition_md5 ?? "")
  || md5(accessHelper?.definition ?? "") !== accessHelper.definition_md5
  || accessHelper?.body_md5 !== ACCESS_HELPER_BODY_MD5
  || md5(extractDeployedBody(accessHelper?.definition ?? "")) !== accessHelper.body_md5
  || typeof accessHelper?.owner_name !== "string" || !accessHelper.owner_name
  || typeof accessHelper?.security_definer !== "boolean"
  || typeof accessHelper?.volatility !== "string" || accessHelper.volatility.length !== 1
  || !(accessHelper?.config === null || Array.isArray(accessHelper?.config))
  || !Array.isArray(accessHelper?.acl_detail)) {
  throw new Error("Realtime organization access helper evidence is incomplete or inconsistent.");
}
if (accessHelper.owner_name !== preflight.installer_role
  || accessHelper.security_definer !== true
  || accessHelper.volatility !== "v"
  || JSON.stringify(accessHelper.config) !== JSON.stringify(["search_path=public"])) {
  throw new Error("Realtime organization access helper owner, security mode, volatility, or configuration is not canonical.");
}
const accessHelperAcl = accessHelper.acl_detail;
const allowedAccessHelperGrantees = new Set([accessHelper.owner_name, "authenticated", "PUBLIC"]);
if (accessHelperAcl.some((grant) => grant.grantor !== accessHelper.owner_name
    || !allowedAccessHelperGrantees.has(grant.grantee)
    || grant.privilege_type !== "EXECUTE"
    || grant.is_grantable !== false)
  || !accessHelperAcl.some((grant) => grant.grantee === accessHelper.owner_name)
  || !accessHelperAcl.some((grant) => grant.grantee === "authenticated")) {
  throw new Error("Realtime organization access helper ACL is not canonical.");
}
if (!/organization_members[\s\S]*organization_members\.active = true/i.test(accessHelper.definition)) {
  throw new Error("Realtime organization access helper does not prove active membership.");
}

const previous = preflight.target_function ?? null;
if (previous) {
  if (!previous.definition || md5(previous.definition) !== previous.definition_md5 || !previous.owner || !previous.owner_name
    || !Array.isArray(previous.acl_detail) || md5(extractDeployedBody(previous.definition)) !== previous.body_md5) {
    throw new Error("Preflight target function evidence is incomplete or inconsistent.");
  }
  const ownerName = previous.owner_name;
  if (previous.acl_detail.some((grant) => grant.grantor !== ownerName || grant.privilege_type !== "EXECUTE")) {
    throw new Error("Preflight target function has an unsupported ACL grantor or privilege.");
  }
}

const reviewedPath = path.join(root, "supabase", "operational-bootstrap-v2.sql");
const reviewed = fs.readFileSync(reviewedPath, "utf8").trim();
const reviewedBodyMd5 = md5(extractReviewedBody(reviewed));
const expectedInstalledOwner = previous?.owner_name ?? preflight.installer_role;
const expectedInstalledConfig = ["search_path=pg_catalog", "statement_timeout=5s"];
const outDir = path.join(root, "test-artifacts", "operational-bootstrap-v2", runId);
const installPath = path.join(outDir, "staging-install.sql");
const postflightPath = path.join(outDir, "staging-postflight.sql");
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
    then raise exception 'staging database identity drift'; end if;
  if ${normalizedBodySql("E' \\talpha\\r\\nbeta\\rgamma\\n '")}
    is distinct from md5(E'alpha\\nbeta\\ngamma')
    then raise exception 'canonical function-body newline normalization failed'; end if;`;

const capturedRealtimeSecurity = {
  rls_enabled: preflight.realtime_security.rls_enabled,
  published: preflight.realtime_security.published,
  policies: preflight.realtime_security.policies,
  authenticated_role_memberships: preflight.realtime_security.authenticated_role_memberships,
  access_helper: preflight.realtime_security.access_helper
};
const realtimeSecurityGuard = `select jsonb_build_object(
    'rls_enabled', c.relrowsecurity,
    'published', exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'operational_events'
    ),
    'policies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', policyname, 'permissive', permissive, 'roles', roles,
        'command', cmd, 'using', qual, 'check', with_check
      ) order by policyname)
      from pg_policies
      where schemaname = 'public' and tablename = 'operational_events'
    ), '[]'::jsonb),
    'authenticated_role_memberships', (
      with recursive inherited_roles(role_oid, role_name) as (
        select role.oid, role.rolname from pg_roles role where role.rolname = 'authenticated'
        union
        select granted_role.oid, granted_role.rolname
        from inherited_roles inherited_role
        join pg_auth_members membership on membership.member = inherited_role.role_oid
        join pg_roles granted_role on granted_role.oid = membership.roleid
      )
      select jsonb_agg(role_name order by role_name) from inherited_roles
    ),
    'access_helper', (
      select jsonb_build_object(
        'definition', pg_get_functiondef(helper.oid),
        'definition_md5', md5(pg_get_functiondef(helper.oid)),
        'body_md5', ${normalizedBodySql("helper.prosrc")},
        'owner_name', pg_get_userbyid(helper.proowner),
        'security_definer', helper.prosecdef,
        'volatility', helper.provolatile,
        'config', to_jsonb(helper.proconfig),
        'acl_detail', (
          select jsonb_agg(jsonb_build_object(
            'grantor', case when acl.grantor = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantor) end,
            'grantee', case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
            'privilege_type', acl.privilege_type, 'is_grantable', acl.is_grantable
          ) order by acl.grantee, acl.privilege_type)
          from aclexplode(coalesce(helper.proacl, acldefault('f', helper.proowner))) acl
        )
      )
      from pg_proc helper
      where helper.oid = 'public.current_user_has_org_access(text)'::regprocedure
    )
  ) into actual_realtime_security
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'operational_events';
  if actual_realtime_security is distinct from ${sqlLiteral(JSON.stringify(capturedRealtimeSecurity))}::jsonb
    then raise exception 'realtime publication, RLS policy, or access helper changed after preflight'; end if;`;

const reviewedPostflightPath = path.join(root, "supabase", "operational-bootstrap-v2-staging-postflight-readonly.sql");
const reviewedPostflight = fs.readFileSync(reviewedPostflightPath, "utf8");
const postflightBinding = `do $$
declare actual_realtime_security jsonb;
begin
  ${commonIdentityGuard}
  ${realtimeSecurityGuard}
end $$;`;
const transactionMarker = "begin isolation level repeatable read read only;";
if (!reviewedPostflight.includes(transactionMarker)) throw new Error("Reviewed postflight transaction marker is missing.");
const postflight = reviewedPostflight.replace(transactionMarker, `${transactionMarker}\n\n${postflightBinding}`);

function installedStateGuard(message) {
  return `select ${normalizedBodySql("p.prosrc")}, pg_get_userbyid(p.proowner), p.prosecdef,
    p.provolatile, to_jsonb(p.proconfig)
  into body_md5, actual_owner_name, actual_security_definer, actual_volatility, actual_config
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = '${FUNCTION}' and pg_get_function_identity_arguments(p.oid) = '';
  if body_md5 is distinct from ${sqlLiteral(reviewedBodyMd5)}
    or actual_owner_name is distinct from ${sqlLiteral(expectedInstalledOwner)}
    or actual_security_definer is distinct from true
    or actual_volatility is distinct from 's'
    or actual_config is distinct from ${sqlLiteral(JSON.stringify(expectedInstalledConfig))}::jsonb
    or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where n.nspname = 'public' and p.proname = '${FUNCTION}' and pg_get_function_identity_arguments(p.oid) = '') <> 2
    or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where n.nspname = 'public' and p.proname = '${FUNCTION}' and pg_get_function_identity_arguments(p.oid) = ''
        and (case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end
          not in (actual_owner_name, 'authenticated')
          or acl.privilege_type <> 'EXECUTE' or acl.is_grantable))
    or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where n.nspname = 'public' and p.proname = '${FUNCTION}' and pg_get_function_identity_arguments(p.oid) = ''
        and pg_get_userbyid(acl.grantee) = actual_owner_name and acl.privilege_type = 'EXECUTE' and not acl.is_grantable)
    or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where n.nspname = 'public' and p.proname = '${FUNCTION}' and pg_get_function_identity_arguments(p.oid) = ''
        and pg_get_userbyid(acl.grantee) = 'authenticated' and acl.privilege_type = 'EXECUTE' and not acl.is_grantable)
  then raise exception '${message}'; end if;`;
}

const install = [`-- Preflight-bound atomic bootstrap staging install: ${runId}`,
  "begin;",
  `create temp table bootstrap_install_app_state on commit drop as
select version, md5(data::text) data_md5, octet_length(data::text) data_bytes, updated_at, updated_by
from public.app_state where id = 'primary';`,
  `do $$
declare actual_definition_md5 text; actual_owner text; actual_security_definer boolean;
  actual_volatility "char"; actual_config jsonb; actual_acl jsonb; actual_realtime_security jsonb;
begin
  ${commonIdentityGuard}
  if (select version from bootstrap_install_app_state) is distinct from ${preflight.app_state.version}
    or (select data_md5 from bootstrap_install_app_state) is distinct from ${sqlLiteral(preflight.app_state.md5)}
    then raise exception 'app_state changed after preflight'; end if;
  ${realtimeSecurityGuard}
  ${priorGuard}
end $$;`,
  reviewed,
  `do $$
declare body_md5 text; actual_owner_name text; actual_security_definer boolean;
  actual_volatility "char"; actual_config jsonb; actual_realtime_security jsonb;
begin
  ${realtimeSecurityGuard}
  ${installedStateGuard("installed bootstrap definition, owner, configuration, or exact ACL mismatch")}
  if exists (select 1 from public.app_state a cross join bootstrap_install_app_state b where a.id = 'primary'
    and (a.version, md5(a.data::text), octet_length(a.data::text), a.updated_at, a.updated_by)
      is distinct from (b.version, b.data_md5, b.data_bytes, b.updated_at, b.updated_by))
    then raise exception 'bootstrap install changed app_state'; end if;
end $$;`,
  "commit;", ""].join("\n\n");

const restore = previous
  ? [
      previous.definition.trim() + ";",
      `alter function public.${FUNCTION}() owner to ${previous.owner};`,
      `set local role ${previous.owner};`,
      ...restoreAcl(previous),
      "reset role;"
    ]
  : [`drop function public.${FUNCTION}();`];
const restoredStateGuard = previous
  ? `do $$ declare definition_md5 text; body_md5 text; actual_owner text; actual_security_definer boolean;
      actual_volatility "char"; actual_config jsonb; actual_acl jsonb;
    begin
      select md5(pg_get_functiondef(p.oid)), ${normalizedBodySql("p.prosrc")}, quote_ident(pg_get_userbyid(p.proowner)), p.prosecdef,
        p.provolatile, to_jsonb(p.proconfig), (
          select jsonb_agg(jsonb_build_object(
            'grantor', case when acl.grantor = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantor) end,
            'grantee', case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
            'privilege_type', acl.privilege_type, 'is_grantable', acl.is_grantable
          ) order by acl.grantee, acl.privilege_type)
          from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        )
      into strict definition_md5, body_md5, actual_owner, actual_security_definer, actual_volatility, actual_config, actual_acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = '${FUNCTION}' and pg_get_function_identity_arguments(p.oid) = '';
      if definition_md5 is distinct from ${sqlLiteral(previous.definition_md5)}
        or body_md5 is distinct from ${sqlLiteral(previous.body_md5)}
        or actual_owner is distinct from ${sqlLiteral(previous.owner)}
        or actual_security_definer is distinct from ${previous.security_definer === true ? "true" : "false"}
        or actual_volatility is distinct from ${sqlLiteral(previous.volatility)}
        or actual_config is distinct from ${sqlLiteral(JSON.stringify(previous.config ?? null))}::jsonb
        or actual_acl is distinct from ${sqlLiteral(JSON.stringify(previous.acl_detail))}::jsonb
      then raise exception 'rollback failed to restore the exact prior bootstrap function'; end if;
    end $$;`
  : `do $$ begin
      if to_regprocedure('public.${FUNCTION}()') is not null
        then raise exception 'rollback failed to remove the bootstrap function'; end if;
    end $$;`;
const rollback = [`-- Exact definition rollback for ${runId}; disable VITE_BACKEND_ATOMIC_BOOTSTRAP first.`,
  "begin;",
  `do $$ declare body_md5 text; actual_owner_name text; actual_security_definer boolean;
    actual_volatility "char"; actual_config jsonb; actual_realtime_security jsonb;
  begin ${commonIdentityGuard} ${realtimeSecurityGuard} ${installedStateGuard("rollback refused unexpected bootstrap definition, owner, configuration, ACL, or security drift")} end $$;`,
  ...restore,
  restoredStateGuard,
  "commit;", ""].join("\n\n");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(installPath, install, { encoding: "utf8", flag: "wx" });
fs.writeFileSync(postflightPath, postflight, { encoding: "utf8", flag: "wx" });
fs.writeFileSync(rollbackPath, rollback, { encoding: "utf8", flag: "wx" });
const manifest = {
  runId,
  environment: "staging",
  projectRef: EXPECTED_PROJECT_REF,
  systemIdentifier: EXPECTED_SYSTEM_IDENTIFIER,
  sourceCommit,
  preflight: { path: path.relative(root, preflightPath), sha256: sha256(preflightText) },
  reviewedSql: { path: path.relative(root, reviewedPath), sha256: sha256(reviewed), bodyMd5: reviewedBodyMd5 },
  previousFunctionExisted: Boolean(previous),
  install: { path: path.relative(root, installPath), sha256: sha256(install) },
  postflight: { path: path.relative(root, postflightPath), sha256: sha256(postflight) },
  rollback: { path: path.relative(root, rollbackPath), sha256: sha256(rollback) }
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
