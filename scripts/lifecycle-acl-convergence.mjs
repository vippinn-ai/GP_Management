import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { FUNCTION_NAMES, expectedMetadata, expectedTableAcl, preflightFunctions, sha256, packageIdentity } from "./lifecycle-install-contract.mjs";
import { lifecycleSqlBodies } from "./lifecycle-runner-guards.mjs";

const LEGACY = { hop_session: "supabase/phase4-hop-session-rpc.sql", reject_session: "supabase/phase4-reject-rpcs.sql", reject_customer_tab: "supabase/phase4-reject-rpcs.sql" };
const PRIVILEGES = ["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"];
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const normalize = (value) => value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
const md5 = (value) => crypto.createHash("md5").update(value).digest("hex");
const sortAcl = (acl) => [...acl].sort((a, b) => JSON.stringify([a.grantee, a.privilege_type, a.grantor, a.is_grantable]).localeCompare(JSON.stringify([b.grantee, b.privilege_type, b.grantor, b.is_grantable]), "en"));
const equal = (actual, expected, label) => { if (!isDeepStrictEqual(actual, expected)) throw new Error(`ACL convergence mismatch: ${label}.`); };
const grant = (grantee, privilege_type) => ({ grantor: "postgres", grantee, privilege_type, is_grantable: false });

function sourceBodies(root) {
  const bodies = lifecycleSqlBodies(root);
  for (const [name, file] of Object.entries(LEGACY)) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const match = source.match(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)[\\s\\S]*?\\bas\\s+\\$\\$([\\s\\S]*?)\\$\\$;`, "i"));
    if (!match) throw new Error(`Missing source body: ${name}.`);
    bodies[name] = normalize(match[1]);
  }
  return bodies;
}

export function validateAclEvidence(evidence, root, phase = "before") {
  if (!["before", "after"].includes(phase)) throw new Error("Unknown ACL phase.");
  for (const [key, value] of Object.entries({ expected_project_ref: "tkbdyzxwwbhkpztgjjxh", system_identifier: "7623125441096521075", database: "postgres", server_version_num: 170006, organization_id: "org-primary", organization_exists: true, open_sessions: 0, open_customer_tabs: 0, recoverable_hopped_sessions: 0, processing_financial_mutations: 0, processing_operational_mutations: 0, operational_mutations_table_exists: true, operational_mutations_rls: true, operational_mutations_force_rls: false, operational_mutations_owner: "postgres", operational_mutations_policies: [] })) equal(evidence[key], value, key);
  const anchor = evidence.environment_identity;
  if (anchor?.environment !== "staging" || anchor?.project_ref !== "tkbdyzxwwbhkpztgjjxh" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(anchor?.identity_nonce ?? "")) throw new Error("Invalid staging anchor.");
  if (!Number.isInteger(evidence.app_state?.version) || evidence.app_state.version < 0 || !Number.isInteger(evidence.app_state?.bytes) || evidence.app_state.bytes < 0 || !/^[a-f0-9]{32}$/.test(evidence.app_state?.md5 ?? "") || !Number.isFinite(Date.parse(evidence.app_state?.updated_at)) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(evidence.app_state?.updated_by ?? "")) throw new Error("Incomplete app_state identity.");
  const ownerAcl = expectedTableAcl(170006);
  equal(sortAcl(evidence.operational_mutations_acl ?? []), sortAcl(phase === "before" ? [...ownerAcl, ...PRIVILEGES.map((p) => grant("service_role", p))] : ownerAcl), "table ACL");
  const functions = preflightFunctions(evidence.functions, "reinstall");
  const bodies = sourceBodies(root);
  for (const [name, entry] of functions) {
    const candidate = FUNCTION_NAMES.includes(name);
    const expected = expectedMetadata(candidate ? name : "hop_session_v2");
    const service = phase === "before" || !candidate;
    expected.acl_detail = [...expected.acl_detail, ...(service ? [grant("service_role", "EXECUTE")] : [])];
    for (const [key, value] of Object.entries(expected)) equal(key === "acl_detail" ? sortAcl(entry[key] ?? []) : entry[key], key === "acl_detail" ? sortAcl(value) : value, `${name}.${key}`);
    for (const [key, value] of Object.entries({ public_execute: false, anon_execute: false, authenticated_execute: true, service_role_execute: service })) equal(entry[key], value, `${name}.${key}`);
    if (typeof entry.definition !== "string" || md5(entry.definition) !== entry.definition_md5) throw new Error(`Raw definition hash mismatch: ${name}.`);
    const body = entry.definition.match(/\bAS\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;?\s*$/i);
    if (!body || normalize(body[2]) !== bodies[name]) throw new Error(`Source body mismatch: ${name}.`);
  }
  return evidence;
}

function state(evidence) {
  const result = globalThis.structuredClone(evidence);
  delete result.captured_at_utc;
  delete result.package_identity;
  result.functions = result.functions.map((entry) => {
    delete entry.definition;
    delete entry.acl;
    entry.acl_detail = sortAcl(entry.acl_detail);
    return entry;
  }).sort((a, b) => a.name < b.name ? -1 : 1);
  result.operational_mutations_acl = sortAcl(result.operational_mutations_acl);
  return result;
}

function targetEvidence(preflight) {
  const result = globalThis.structuredClone(preflight);
  result.operational_mutations_acl = expectedTableAcl(170006);
  for (const entry of result.functions) if (FUNCTION_NAMES.includes(entry.name)) {
    entry.acl_detail = expectedMetadata(entry.name).acl_detail;
    entry.service_role_execute = false;
  }
  return result;
}

export function renderAclPackage({ root, preflightText, runId, codeIdentity }) {
  if (!/^normops-\d{8}-\d{4}-[a-z0-9-]+$/.test(runId) || !/^[a-f0-9]{40}$/.test(codeIdentity?.commit ?? "") || !/^[a-f0-9]{64}$/.test(codeIdentity?.sourceSha256 ?? "")) throw new Error("Invalid package identity.");
  const before = validateAclEvidence(JSON.parse(preflightText), root);
  const after = targetEvidence(before);
  const binding = { runId, ...codeIdentity, preflightSha256: sha256(preflightText) };
  const collector = fs.readFileSync(path.join(root, "supabase/operational-lifecycle-v2-staging-preflight-readonly.sql"), "utf8");
  const match = collector.match(/with target_functions as \([\s\S]*?\) as evidence;/i);
  if (!match) throw new Error("Read-only collector shape changed.");
  // Reuse the reviewed collector; do not depend on a session GUC for mutation counts.
  const query = match[0].replace(/;$/, "").replace("current_setting('normops.processing_operational_mutations')::integer", "(select count(*) from public.operational_mutations where status<>'committed')").replace("order by acl_items.grantee,acl_items.privilege_type", "order by (case when acl_items.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl_items.grantee) end) collate \"C\",acl_items.privilege_type");
  const comparison = `(observed - 'captured_at_utc' - 'functions') || jsonb_build_object('functions',(select jsonb_agg(value - 'definition' - 'acl' order by value->>'name') from jsonb_array_elements(observed->'functions')))`;
  const guard = (expected) => `do $convergence$\ndeclare observed jsonb;\nbegin\n  if current_user <> 'postgres' then raise exception 'ACL convergence requires postgres'; end if;\n  select evidence into strict observed from (${query}) capture;\n  if (${comparison}) is distinct from ${literal(JSON.stringify(state(expected)))}::jsonb then raise exception 'ACL convergence state drift; stop without retry'; end if;\nend $convergence$;`;
  const changes = (restore) => [
    ...FUNCTION_NAMES.map((name) => `${restore ? "grant" : "revoke"} execute on function public.${name}(jsonb) ${restore ? "to" : "from"} service_role;`),
    ...PRIVILEGES.map((p) => `${restore ? "grant" : "revoke"} ${p.toLowerCase()} on table public.operational_mutations ${restore ? "to" : "from"} service_role;`)
  ].join("\n");
  const environmentGuard = `do $environment$\nbegin
  if current_user <> 'postgres' or current_database() <> 'postgres'
    or (select system_identifier::text from pg_control_system()) is distinct from '7623125441096521075'
    or current_setting('server_version_num')::integer <> 170006
    then raise exception 'ACL convergence requires the approved staging database and role'; end if;
  if (select jsonb_build_object('environment',environment,'project_ref',project_ref,'identity_nonce',identity_nonce)
      from public.deployment_environment_identity where environment='staging')
      is distinct from ${literal(JSON.stringify(before.environment_identity))}::jsonb
    then raise exception 'ACL convergence staging anchor mismatch'; end if;
end $environment$;`;
  const transaction = (restore) => [
    `-- Staging ACL convergence ${JSON.stringify(binding)}. No business data changes.`,
    "begin isolation level read committed;",
    "set local lock_timeout='3s';", "set local statement_timeout='20s';",
    environmentGuard,
    "select pg_advisory_xact_lock(173441, 2);",
    "lock table public.deployment_environment_identity, public.organizations, public.app_state, public.sessions, public.customer_tabs, public.financial_mutations, public.operational_mutations in share mode;",
    guard(restore ? after : before), changes(restore), guard(restore ? before : after), "commit;", ""
  ].join("\n\n");
  const postflight = `-- Read-only package-bound ACL evidence.\nbegin isolation level repeatable read read only;\nselect evidence || jsonb_build_object('package_identity',${literal(JSON.stringify(binding))}::jsonb) as evidence from (${query}) capture;\nrollback;\n`;
  return { forward: transaction(false), rollback: transaction(true), postflight, binding, before, after };
}

export function verifyAclPostflight({ root, manifestPath, evidencePath, phase = "after" }) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  equal(manifest.operation, "staging-acl-convergence", "operation");
  const identity = packageIdentity(root, manifest.codeIdentity.commit);
  equal(identity, manifest.codeIdentity, "clean source identity");
  const preflightText = fs.readFileSync(manifest.preflight.path, "utf8");
  equal(sha256(preflightText), manifest.preflight.sha256, "raw preflight hash");
  const rendered = renderAclPackage({ root, preflightText, runId: manifest.runId, codeIdentity: identity });
  for (const name of ["forward", "rollback", "postflight"]) {
    const artifact = manifest.artifacts[name];
    const bytes = fs.readFileSync(artifact.path);
    equal(bytes.toString("utf8"), rendered[name], `${name} source binding`);
    equal(bytes.length, artifact.bytes, `${name} length`);
    equal(sha256(bytes), artifact.sha256, `${name} hash`);
  }
  const raw = fs.readFileSync(evidencePath, "utf8");
  const evidence = validateAclEvidence(JSON.parse(raw), root, phase);
  equal(evidence.package_identity, rendered.binding, "postflight package identity");
  equal(state(evidence), state(phase === "after" ? rendered.after : rendered.before), "postflight exact state");
  return { status: "passed", phase, runId: manifest.runId, evidenceSha256: sha256(raw), manifestSha256: sha256(fs.readFileSync(manifestPath)) };
}
