import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { verifyAclPostflight, validateAclEvidence } from "./lifecycle-acl-convergence.mjs";
import { assertLifecycleSqlBinding, LIFECYCLE_FUNCTION_SOURCES } from "./lifecycle-runner-guards.mjs";
import { sha256, FUNCTION_NAMES, expectedMetadata, metadataExpression, mutationTableGuard, packageIdentity } from "./lifecycle-install-contract.mjs";

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const unwrap = (value) => value.evidence ?? value?.[0]?.evidence ?? value;
const equal = (a, b, label) => { if (!isDeepStrictEqual(a, b)) throw new Error(`Database lineage mismatch: ${label}.`); };

export function loadLifecycleDatabaseLineage({ root, descriptorPath, descriptorSha256, installManifestPath, installManifestSha256, verificationPath, verificationSha256 }) {
  function read(record, label) {
    if (!record?.path || !/^[a-f0-9]{64}$/.test(record.sha256 ?? "")) throw new Error(`Missing bound ${label}.`);
    const absolutePath = path.resolve(root, record.path);
    const bytes = fs.readFileSync(absolutePath);
    equal(sha256(bytes), record.sha256, `${label} hash`);
    return { path: absolutePath, sha256: record.sha256, value: JSON.parse(bytes.toString("utf8")) };
  }
  const bound = read({ path: descriptorPath, sha256: descriptorSha256 }, "ACL supplement");
  const d = bound.value;
  equal(d.kind, "lifecycle-acl-supplement-v1", "supplement kind");
  equal(packageIdentity(root, d.codeIdentity?.commit), d.codeIdentity, "current clean candidate identity");
  const install = read(d.installManifest, "historical installation");
  const verification = read(d.installVerification, "historical installation verification");
  equal(install.path, path.resolve(root, installManifestPath), "selected installation path");
  equal(install.sha256, installManifestSha256, "selected installation hash");
  equal(verification.path, path.resolve(root, verificationPath), "selected verification path");
  equal(verification.sha256, verificationSha256, "selected verification hash");
  equal(install.value.target, { projectRef: "tkbdyzxwwbhkpztgjjxh", systemIdentifier: "7623125441096521075", organizationId: "org-primary" }, "historical target");
  if (!["staging-v2-function-reinstall", "staging-v2-install"].includes(install.value.operation)) throw new Error("Unknown historical installation operation.");
  equal(verification.value.manifestSha256, install.sha256, "installation receipt");
  equal(verification.value.runId, install.value.runId, "installation run");
  equal(verification.value.projectRef, "tkbdyzxwwbhkpztgjjxh", "verification project");
  equal(verification.value.organizationId, "org-primary", "verification organization");
  equal(verification.value.appStateUnchanged, true, "installation app_state");
  equal(verification.value.incompleteMutations, 0, "installation incomplete mutations");
  const installResult = read(d.installResult, "historical install result");
  if (!/^[a-f0-9]{40}$/.test(d.historicalSourceCommit ?? "")) throw new Error("Missing historical installation source commit.");
  for (const [key, value] of Object.entries({ run_id: install.value.runId, environment: "staging", project_ref: "tkbdyzxwwbhkpztgjjxh", candidate_commit: d.historicalSourceCommit, install_sha256: install.value.artifacts?.install?.sha256, execution_count: 1, status: "success", retry_performed: false })) equal(installResult.value[key], value, `historical result ${key}`);
  const sourceNames = ["supabase/operational-lifecycle-v2.sql", "supabase/operational-lifecycle-v2-staging-preflight-readonly.sql", "supabase/operational-lifecycle-v2-staging-postflight-readonly.sql"];
  const sourceEntries = Object.entries(install.value.sources ?? {}).map(([name, hash]) => [name.replaceAll("\\", "/"), hash]);
  equal(sourceEntries.map(([name]) => name).sort(), sourceNames.sort(), "historical source set");
  for (const [name, hash] of sourceEntries) {
    const blob = spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "show", `${d.historicalSourceCommit}:${name}`], { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (blob.status !== 0 || blob.error) throw new Error(`Historical source unavailable: ${name}.`);
    equal(sha256(blob.stdout), hash, `historical Git source ${name}`);
  }
  for (const [name, file] of Object.entries(LIFECYCLE_FUNCTION_SOURCES)) {
    const blob = spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "show", `${d.historicalSourceCommit}:${file}`], { cwd: root, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (blob.status !== 0 || blob.error) throw new Error(`Missing historical function source: ${name}.`);
    const body = blob.stdout.match(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)[\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`, "i"))?.[1];
    if (!body) throw new Error(`Missing historical source definition: ${name}.`);
    equal(sha256(body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim()), install.value.expectedFunctionBodies?.[name]?.sha256, `${name} historical source body`);
  }
  assertLifecycleSqlBinding(root, install.value);
  const preflight = read(install.value.preflight, "historical preflight");
  equal(verification.value.preflightSha256, preflight.sha256, "historical preflight receipt");
  for (const [name, artifact] of Object.entries(install.value.artifacts ?? {})) {
    const bytes = fs.readFileSync(path.resolve(root, artifact.path));
    equal(sha256(bytes), artifact.sha256, `historical ${name} artifact hash`);
    equal(bytes.length, artifact.bytes, `historical ${name} artifact size`);
  }
  if (!install.value.artifacts?.install || !install.value.artifacts?.rollback) throw new Error("Missing historical install/rollback artifacts.");
  const verifiedRollback = verification.value.verifiedRollback;
  if (!verifiedRollback?.path || !/^[a-f0-9]{64}$/.test(verifiedRollback.sha256 ?? "")) throw new Error("Missing historical verified rollback.");
  const rollbackBytes = fs.readFileSync(path.resolve(root, verifiedRollback.path));
  equal(sha256(rollbackBytes), verifiedRollback.sha256, "historical verified rollback hash");
  equal(rollbackBytes.length, verifiedRollback.bytes, "historical verified rollback size");
  const historicalPost = read(d.installPostflight, "historical raw postflight");
  equal(historicalPost.sha256, verification.value.postflightSha256, "historical raw postflight receipt");
  const aclManifest = read(d.aclManifest, "ACL manifest");
  const aclPost = read(d.aclPostflight, "ACL raw postflight");
  const aclVerification = read(d.aclVerification, "ACL verification");
  if (typeof d.historicalRoot !== "string" || !path.isAbsolute(d.historicalRoot)) throw new Error("Require the preserved clean historical ACL source checkout.");
  // The original clean checkout stays pinned. Never relabel a historical manifest
  // with the successor's commit or relax its source/artifact regeneration checks.
  const verified = verifyAclPostflight({ root: d.historicalRoot, manifestPath: aclManifest.path, evidencePath: aclPost.path, phase: "after" });
  equal(aclVerification.value, verified, "ACL verification receipt");
  const observed = validateAclEvidence(aclPost.value, root, "after");
  equal(install.value.environmentIdentity, observed.environment_identity, "historical/ACL environment");
  equal(unwrap(preflight.value).environment_identity, observed.environment_identity, "historical preflight environment");
  equal(verification.value.appState, observed.app_state, "historical/ACL app_state continuity");
  const oldPost = unwrap(historicalPost.value);
  equal(oldPost.expected_project_ref, "tkbdyzxwwbhkpztgjjxh", "historical raw project");
  equal(oldPost.system_identifier, "7623125441096521075", "historical raw physical identity");
  equal(oldPost.organization_id, "org-primary", "historical raw organization");
  equal(oldPost.environment_identity, observed.environment_identity, "historical raw environment");
  equal(oldPost.app_state, observed.app_state, "historical raw app_state continuity");
  const oldFunctions = new Map((oldPost.functions ?? []).map((entry) => [entry.name, entry]));
  equal([...oldFunctions.keys()].sort(), [...FUNCTION_NAMES].sort(), "historical postflight function set");
  if (oldPost.functions.length !== oldFunctions.size) throw new Error("Duplicate historical functions.");
  const oldPreFunctions = new Map((unwrap(preflight.value).functions ?? []).map((entry) => [entry.name, entry]));
  for (const entry of observed.functions) {
    const previous = FUNCTION_NAMES.includes(entry.name) ? oldFunctions.get(entry.name) : oldPreFunctions.get(entry.name);
    if (!previous) throw new Error(`Missing historical definition: ${entry.name}.`);
    if (typeof previous.definition !== "string") throw new Error(`Missing historical definition text: ${entry.name}.`);
    equal(createHash("md5").update(previous.definition).digest("hex"), previous.definition_md5, `${entry.name} historical raw hash`);
    equal(previous.definition_md5, entry.definition_md5, `${entry.name} definition continuity`);
    if (FUNCTION_NAMES.includes(entry.name)) equal(verification.value.installedFunctionDefinitionMd5?.[entry.name], entry.definition_md5, `${entry.name} historical receipt`);
  }
  const securityGuardSql = `do $lineage$\nbegin\n${observed.functions.map((entry) => {
    const expected = expectedMetadata(FUNCTION_NAMES.includes(entry.name) ? entry.name : "hop_session_v2");
    expected.acl_detail = [...entry.acl_detail].sort((a, b) => a.grantee < b.grantee ? -1 : 1);
    return `if (select ${metadataExpression()} from pg_proc p where p.oid=to_regprocedure('public.${entry.name}(jsonb)')) is distinct from ${literal(JSON.stringify(expected))}::jsonb
      or (select md5(pg_get_functiondef(p.oid)) from pg_proc p where p.oid=to_regprocedure('public.${entry.name}(jsonb)')) is distinct from ${literal(entry.definition_md5)}
      then raise exception 'ACL lineage security drift: ${entry.name}'; end if;`;
  }).join("\n")}\n${mutationTableGuard(observed.server_version_num)}\nend $lineage$;`;
  return { path: bound.path, sha256: bound.sha256, descriptor: d, postflight: observed, securityGuardSql };
}
