import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CANDIDATE_FUNCTIONS = [
  "hop_session_v2", "reject_session_v2", "reject_customer_tab_v2",
  "start_session", "open_customer_tab", "link_customer_tab_continuation",
  "get_operational_performance_dataset_identity"
] as const;
const LEGACY_FUNCTIONS = ["hop_session", "reject_session", "reject_customer_tab"] as const;
const TABLE_PRIVILEGES = ["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"] as const;
const SOURCE_DIRS = ["scripts", "src", "supabase", "tests"] as const;
const ROOT_SOURCE_PATTERN = /^(?:package(?:-lock)?\.json|(?:playwright|vite|vitest|eslint|tsconfig)[^/]*\.(?:ts|js|mjs|json)|index\.html)$/;
const cleanupPaths: string[] = [];

const sha256 = (value: crypto.BinaryLike) => crypto.createHash("sha256").update(value).digest("hex");
const md5 = (value: crypto.BinaryLike) => crypto.createHash("md5").update(value).digest("hex");

const FUNCTION_SOURCES: Record<string, string> = {
  hop_session_v2: "supabase/operational-lifecycle-v2.sql",
  reject_session_v2: "supabase/operational-lifecycle-v2.sql",
  reject_customer_tab_v2: "supabase/operational-lifecycle-v2.sql",
  start_session: "supabase/phase4-start-session-rpc.sql",
  open_customer_tab: "supabase/phase4-customer-tab-rpcs.sql",
  link_customer_tab_continuation: "supabase/phase4-link-customer-tab-continuation-rpc.sql",
  get_operational_performance_dataset_identity: "supabase/operational-performance-dataset-identity-staging.sql",
  hop_session: "supabase/phase4-hop-session-rpc.sql",
  reject_session: "supabase/phase4-reject-rpcs.sql",
  reject_customer_tab: "supabase/phase4-reject-rpcs.sql"
};

function sourceDefinition(root: string, name: string) {
  const source = fs.readFileSync(path.join(root, FUNCTION_SOURCES[name]), "utf8");
  const definition = source.match(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)[\\s\\S]*?\\bas\\s+\\$\\$[\\s\\S]*?\\$\\$;`, "i"))?.[0];
  if (!definition) throw new Error(`Missing synthetic fixture source definition for ${name}.`);
  return definition;
}

function functionAcl() {
  return ["authenticated", "postgres", "service_role"].map((grantee) => ({
    grantor: "postgres", grantee, privilege_type: "EXECUTE", is_grantable: false
  }));
}

function syntheticBefore(root: string) {
  const functions = [...LEGACY_FUNCTIONS, ...CANDIDATE_FUNCTIONS].map((name) => {
    const definition = sourceDefinition(root, name);
    return {
      name,
      definition,
      definition_md5: md5(definition),
      owner: "postgres",
      security_definer: true,
      volatility: name === "get_operational_performance_dataset_identity" ? "s" : "v",
      config: ["search_path=public"],
      language: "plpgsql",
      strict: false,
      parallel: "u",
      leakproof: false,
      cost: 100,
      rows: 0,
      returns_set: false,
      result: "jsonb",
      kind: "f",
      support: 0,
      acl_detail: functionAcl(),
      public_execute: false,
      anon_execute: false,
      authenticated_execute: true,
      service_role_execute: true
    };
  });
  const tableAcl = ["postgres", "service_role"].flatMap((grantee) => TABLE_PRIVILEGES.map((privilege_type) => ({
    grantor: "postgres", grantee, privilege_type, is_grantable: false
  })));
  return {
    captured_at_utc: "2026-09-26T15:12:15.000000+00:00",
    expected_project_ref: "tkbdyzxwwbhkpztgjjxh",
    system_identifier: "7623125441096521075",
    database: "postgres",
    server_version_num: 170006,
    environment_identity: { environment: "staging", project_ref: "tkbdyzxwwbhkpztgjjxh", identity_nonce: "12345678-1234-4123-8123-123456789abc" },
    organization_id: "org-primary",
    organization_exists: true,
    open_sessions: 0,
    open_customer_tabs: 0,
    recoverable_hopped_sessions: 0,
    processing_financial_mutations: 0,
    processing_operational_mutations: 0,
    operational_mutations_table_exists: true,
    operational_mutations_rls: true,
    operational_mutations_force_rls: false,
    operational_mutations_owner: "postgres",
    operational_mutations_policies: [],
    operational_mutations_acl: tableAcl,
    app_state: {
      version: 735,
      bytes: 1045421,
      md5: "c2f8145558f9f85a6513caa71c19b54e",
      updated_at: "2026-09-13T01:00:00.000000+00:00",
      updated_by: "12345678-1234-4123-8123-123456789abc"
    },
    functions
  };
}

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }
  });
  if (result.status !== 0) throw new Error(`Git fixture command failed: ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function committedFixture() {
  const sourceRoot = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "normops-acl-convergence-git-"));
  cleanupPaths.push(root);
  for (const dir of SOURCE_DIRS) fs.cpSync(path.join(sourceRoot, dir), path.join(root, dir), { recursive: true });
  for (const name of fs.readdirSync(sourceRoot)) {
    if (ROOT_SOURCE_PATTERN.test(name) || [".gitignore", ".gitattributes"].includes(name)) {
      const source = path.join(sourceRoot, name);
      if (fs.existsSync(source) && fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(root, name));
    }
  }
  git(root, "init");
  git(root, "config", "user.name", "Lifecycle ACL convergence QA");
  git(root, "config", "user.email", "qa@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  git(root, "add", "--all");
  git(root, "commit", "-m", "Committed ACL convergence fixture");
  const commit = git(root, "rev-parse", "HEAD");
  expect(commit).toMatch(/^[a-f0-9]{40}$/);
  expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
  return { root, commit };
}

function runNode(root: string, script: string, args: string[]) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], { cwd: root, encoding: "utf8", windowsHide: true });
}

function callApi(root: string, expression: string) {
  const moduleUrl = pathToFileURL(path.join(root, "scripts", "lifecycle-acl-convergence.mjs")).href;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import fs from "node:fs";
    import { validateAclEvidence, verifyAclPostflight } from ${JSON.stringify(moduleUrl)};
    ${expression}
  `], { cwd: root, encoding: "utf8", windowsHide: true });
}

function afterEvidence(before: Record<string, unknown>, packageIdentity?: Record<string, unknown>) {
  const result = structuredClone(before) as Record<string, unknown> & {
    functions: Array<Record<string, unknown>>;
    operational_mutations_acl: Array<Record<string, unknown>>;
  };
  result.operational_mutations_acl = result.operational_mutations_acl.filter((grant) => grant.grantee === "postgres");
  result.functions = result.functions.map((entry) => CANDIDATE_FUNCTIONS.includes(entry.name as typeof CANDIDATE_FUNCTIONS[number]) ? {
    ...entry,
    acl_detail: (entry.acl_detail as Array<Record<string, unknown>>).filter((grant) => grant.grantee !== "service_role"),
    service_role_execute: false
  } : entry);
  if (packageIdentity) result.package_identity = packageIdentity;
  return result;
}

function writeJson(directory: string, name: string, value: unknown) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

afterEach(() => {
  const tempRoot = path.resolve(os.tmpdir());
  for (const entry of cleanupPaths.reverse()) {
    const resolved = path.resolve(entry);
    if (!resolved.startsWith(`${tempRoot}${path.sep}`) || !path.basename(resolved).startsWith("normops-acl-convergence-")) {
      throw new Error(`Refusing unsafe ACL convergence cleanup target: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  cleanupPaths.length = 0;
});

describe("lifecycle ACL convergence contract", () => {
  it("accepts only the explicit synthetic predecessor and exact converged state", () => {
    const root = process.cwd();
    // This committed regression fixture contains no private/live capture bytes.
    const before = syntheticBefore(root) as Record<string, unknown>;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "normops-acl-convergence-evidence-"));
    cleanupPaths.push(directory);
    const beforePath = writeJson(directory, "before.json", before);
    const after = afterEvidence(before);
    const afterPath = writeJson(directory, "after.json", after);

    const beforeAccepted = callApi(root, `validateAclEvidence(JSON.parse(fs.readFileSync(${JSON.stringify(beforePath)},"utf8")), ${JSON.stringify(root)}, "before");`);
    expect(beforeAccepted.status, beforeAccepted.stderr).toBe(0);
    const afterAccepted = callApi(root, `validateAclEvidence(JSON.parse(fs.readFileSync(${JSON.stringify(afterPath)},"utf8")), ${JSON.stringify(root)}, "after");`);
    expect(afterAccepted.status, afterAccepted.stderr).toBe(0);

    const candidate = CANDIDATE_FUNCTIONS[0];
    const legacy = LEGACY_FUNCTIONS[0];
    const variants: Array<[string, Record<string, unknown>, "before" | "after"]> = [
      ["unknown-table-acl", { ...before, operational_mutations_acl: [...before.operational_mutations_acl as object[], { grantor: "postgres", grantee: "custom_role", privilege_type: "SELECT", is_grantable: false }] }, "before"],
      ["missing-table-privilege", { ...before, operational_mutations_acl: (before.operational_mutations_acl as Array<Record<string, unknown>>).filter((grant) => !(grant.grantee === "service_role" && grant.privilege_type === "MAINTAIN")) }, "before"],
      ["grantable-table-privilege", { ...before, operational_mutations_acl: (before.operational_mutations_acl as Array<Record<string, unknown>>).map((grant) => grant.grantee === "service_role" && grant.privilege_type === "SELECT" ? { ...grant, is_grantable: true } : grant) }, "before"],
      ["forced-rls", { ...before, operational_mutations_force_rls: true }, "before"],
      ["policy", { ...before, operational_mutations_policies: ["unexpected_policy"] }, "before"],
      ["dirty-floor", { ...before, open_sessions: 1 }, "before"],
      ["candidate-before-missing-service", { ...before, functions: (before.functions as Array<Record<string, unknown>>).map((entry) => entry.name === candidate ? { ...entry, acl_detail: (entry.acl_detail as Array<Record<string, unknown>>).filter((grant) => grant.grantee !== "service_role"), service_role_execute: false } : entry) }, "before"],
      ["candidate-after-still-service", { ...after, functions: (after.functions as Array<Record<string, unknown>>).map((entry) => entry.name === candidate ? (before.functions as Array<Record<string, unknown>>).find((item) => item.name === candidate)! : entry) }, "after"],
      ["legacy-after-changed", { ...after, functions: (after.functions as Array<Record<string, unknown>>).map((entry) => entry.name === legacy ? { ...entry, service_role_execute: false } : entry) }, "after"],
      ["duplicate", { ...before, functions: [...before.functions as object[], (before.functions as object[])[0]] }, "before"],
      ["unknown-function", { ...before, functions: [...(before.functions as object[]).slice(0, -1), { ...(before.functions as object[]).at(-1)!, name: "unknown_function" }] }, "before"]
    ];
    const fixedIdentityDrift: Array<[string, string, unknown]> = [
      ["project-ref", "expected_project_ref", "production-project"],
      ["system-identifier", "system_identifier", "1"],
      ["database", "database", "other_database"],
      ["server-version", "server_version_num", 180000],
      ["organization", "organization_id", "other-org"],
      ["organization-missing", "organization_exists", false],
      ["table-missing", "operational_mutations_table_exists", false],
      ["table-rls-disabled", "operational_mutations_rls", false],
      ["table-owner", "operational_mutations_owner", "other_role"]
    ];
    for (const [slug, field, value] of fixedIdentityDrift) variants.push([slug, { ...before, [field]: value }, "before"]);
    const anchor = before.environment_identity as Record<string, unknown>;
    for (const [slug, field, value] of [
      ["anchor-environment", "environment", "production"],
      ["anchor-project", "project_ref", "production-project"],
      ["anchor-nonce", "identity_nonce", "not-a-uuid"]
    ] as const) variants.push([slug, { ...before, environment_identity: { ...anchor, [field]: value } }, "before"]);
    for (const field of [
      "open_sessions", "open_customer_tabs", "recoverable_hopped_sessions",
      "processing_financial_mutations", "processing_operational_mutations"
    ]) variants.push([`dirty-${field}`, { ...before, [field]: 1 }, "before"]);
    const appState = before.app_state as Record<string, unknown>;
    for (const field of ["version", "bytes", "md5", "updated_at", "updated_by"]) {
      const incomplete = { ...appState };
      delete incomplete[field];
      variants.push([`app-state-missing-${field}`, { ...before, app_state: incomplete }, "before"]);
    }
    const candidateEntry = (before.functions as Array<Record<string, unknown>>).find((entry) => entry.name === candidate)!;
    const metadataDrift: Array<[string, string, unknown]> = [
      ["owner", "owner", "other_role"], ["security", "security_definer", false], ["volatility", "volatility", "s"],
      ["config", "config", ["search_path=public", "statement_timeout=5s"]], ["language", "language", "sql"],
      ["strict", "strict", true], ["parallel", "parallel", "s"], ["leakproof", "leakproof", true],
      ["cost", "cost", 99], ["rows", "rows", 1], ["returns-set", "returns_set", true],
      ["result", "result", "text"], ["kind", "kind", "p"], ["support", "support", 1]
    ];
    for (const [slug, field, value] of metadataDrift) {
      variants.push([`metadata-${slug}`, {
        ...before,
        functions: (before.functions as Array<Record<string, unknown>>).map((entry) => entry.name === candidate ? { ...entry, [field]: value } : entry)
      }, "before"]);
    }
    variants.push(["candidate-grant-option", {
      ...before,
      functions: (before.functions as Array<Record<string, unknown>>).map((entry) => entry.name === candidate ? {
        ...entry,
        acl_detail: (entry.acl_detail as Array<Record<string, unknown>>).map((grant) => grant.grantee === "service_role" ? { ...grant, is_grantable: true } : grant)
      } : entry)
    }, "before"]);
    const driftedDefinition = String(candidateEntry.definition).replace(/\bbegin\b/i, "begin\n  perform 1;");
    expect(driftedDefinition).not.toBe(candidateEntry.definition);
    variants.push(["source-body", {
      ...before,
      functions: (before.functions as Array<Record<string, unknown>>).map((entry) => entry.name === candidate ? { ...entry, definition: driftedDefinition, definition_md5: md5(driftedDefinition) } : entry)
    }, "before"]);
    variants.push(["raw-definition-hash", {
      ...before,
      functions: (before.functions as Array<Record<string, unknown>>).map((entry) => entry.name === candidate ? { ...entry, definition_md5: "0".repeat(32) } : entry)
    }, "before"]);
    for (const [name, evidence, phase] of variants) {
      const file = writeJson(directory, `${name}.json`, evidence);
      const rejected = callApi(root, `validateAclEvidence(JSON.parse(fs.readFileSync(${JSON.stringify(file)},"utf8")), ${JSON.stringify(root)}, ${JSON.stringify(phase)});`);
      expect(rejected.status, `${name} unexpectedly passed`).not.toBe(0);
    }
  }, 30_000);

  it("builds immutable ACL-only forward/rollback artifacts and verifies exact evidence", () => {
    const { root, commit } = committedFixture();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "normops-acl-convergence-package-"));
    cleanupPaths.push(directory);
    const capturedText = JSON.stringify(syntheticBefore(root));
    const preflightPath = path.join(directory, "preflight.json");
    fs.writeFileSync(preflightPath, capturedText);
    const runId = `normops-20260926-1545-acl-${crypto.randomBytes(4).toString("hex")}`;
    const command = [`--run-id=${runId}`, `--expected-commit=${commit}`, `--preflight=${preflightPath}`];
    const built = runNode(root, "scripts/build-operational-lifecycle-v2-staging-acl-convergence.mjs", command);
    expect(built.status, built.stderr).toBe(0);
    const packageDirectory = path.join(root, "test-artifacts", "operational-lifecycle-v2", runId);
    const manifestPath = path.join(packageDirectory, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.operation).toBe("staging-acl-convergence");
    expect(manifest.codeIdentity.commit).toBe(commit);
    expect(manifest.preflight.sha256).toBe(sha256(capturedText));

    const forwardPath = manifest.artifacts.forward.path as string;
    const rollbackPath = manifest.artifacts.rollback.path as string;
    const postflightPath = manifest.artifacts.postflight.path as string;
    const forward = fs.readFileSync(forwardPath, "utf8");
    const rollback = fs.readFileSync(rollbackPath, "utf8");
    const postflight = fs.readFileSync(postflightPath, "utf8");
    for (const [name, text] of [["forward", forward], ["rollback", rollback], ["postflight", postflight]] as const) {
      expect(manifest.artifacts[name].bytes).toBe(Buffer.byteLength(text));
      expect(manifest.artifacts[name].sha256).toBe(sha256(text));
    }
    for (const name of CANDIDATE_FUNCTIONS) {
      expect(forward.match(new RegExp(`^revoke execute on function public\\.${name}\\(jsonb\\) from service_role;$`, "gim"))).toHaveLength(1);
      expect(rollback.match(new RegExp(`^grant execute on function public\\.${name}\\(jsonb\\) to service_role;$`, "gim"))).toHaveLength(1);
    }
    for (const name of LEGACY_FUNCTIONS) {
      expect(forward).not.toMatch(new RegExp(`^(?:grant|revoke).+public\\.${name}\\(jsonb\\)`, "gim"));
      expect(rollback).not.toMatch(new RegExp(`^(?:grant|revoke).+public\\.${name}\\(jsonb\\)`, "gim"));
    }
    for (const privilege of TABLE_PRIVILEGES) {
      expect(forward).toMatch(new RegExp(`^revoke ${privilege.toLowerCase()} on table public\\.operational_mutations from service_role;$`, "mi"));
      expect(rollback).toMatch(new RegExp(`^grant ${privilege.toLowerCase()} on table public\\.operational_mutations to service_role;$`, "mi"));
    }
    for (const text of [forward, rollback]) {
      expect(text.match(/ACL convergence state drift; stop without retry/g)).toHaveLength(2);
      expect(text.match(/^begin isolation level read committed;$/gim)).toHaveLength(1);
      expect(text.match(/^commit;$/gim)).toHaveLength(1);
      expect(text).not.toMatch(/^\s*(?:create|alter|drop|insert|update|delete|truncate|merge|call)\b/gim);
      expect(text).not.toMatch(/create\s+or\s+replace\s+function/i);
      const environmentGuard = text.indexOf(
        "ACL convergence requires the approved staging database and role",
      );
      const advisoryLock = text.indexOf("pg_advisory_xact_lock");
      const tableLock = text.indexOf("lock table public.deployment_environment_identity");
      expect(environmentGuard).toBeGreaterThan(-1);
      expect(advisoryLock).toBeGreaterThan(environmentGuard);
      expect(tableLock).toBeGreaterThan(advisoryLock);
    }
    expect(postflight).toMatch(/^begin isolation level repeatable read read only;$/mi);
    expect(postflight.match(/^rollback;$/gim)).toHaveLength(1);
    expect(postflight).not.toMatch(/^commit;$/gim);

    const packageIdentity = { runId, ...manifest.codeIdentity, preflightSha256: manifest.preflight.sha256 };
    const before = JSON.parse(capturedText) as Record<string, unknown>;
    const afterPath = writeJson(directory, "postflight-after.json", afterEvidence(before, packageIdentity));
    const beforePath = writeJson(directory, "postflight-before.json", { ...before, package_identity: packageIdentity });
    const verifyAfter = callApi(root, `const result=verifyAclPostflight({root:${JSON.stringify(root)},manifestPath:${JSON.stringify(manifestPath)},evidencePath:${JSON.stringify(afterPath)},phase:"after"}); process.stdout.write(JSON.stringify(result));`);
    expect(verifyAfter.status, verifyAfter.stderr).toBe(0);
    expect(JSON.parse(verifyAfter.stdout)).toMatchObject({ status: "passed", phase: "after", runId });
    const verifyBefore = callApi(root, `const result=verifyAclPostflight({root:${JSON.stringify(root)},manifestPath:${JSON.stringify(manifestPath)},evidencePath:${JSON.stringify(beforePath)},phase:"before"}); process.stdout.write(JSON.stringify(result));`);
    expect(verifyBefore.status, verifyBefore.stderr).toBe(0);
    expect(JSON.parse(verifyBefore.stdout)).toMatchObject({ status: "passed", phase: "before", runId });
    const verifier = "scripts/verify-operational-lifecycle-v2-staging-acl-convergence.mjs";
    const cliAfter = runNode(root, verifier, [`--manifest=${manifestPath}`, `--evidence=${afterPath}`, "--phase=after"]);
    expect(cliAfter.status, cliAfter.stderr).toBe(0);
    expect(JSON.parse(cliAfter.stdout)).toMatchObject({ status: "passed", phase: "after", runId });
    const cliInvalidPhase = runNode(root, verifier, [`--manifest=${manifestPath}`, `--evidence=${afterPath}`, "--phase=invalid"]);
    expect(cliInvalidPhase.status).not.toBe(0);
    const cliMissingArgument = runNode(root, verifier, [`--manifest=${manifestPath}`, `--evidence=${afterPath}`]);
    expect(cliMissingArgument.status).not.toBe(0);

    const immutable = runNode(root, "scripts/build-operational-lifecycle-v2-staging-acl-convergence.mjs", command);
    expect(immutable.status).not.toBe(0);
    const wrongCommit = runNode(root, "scripts/build-operational-lifecycle-v2-staging-acl-convergence.mjs", [
      `--run-id=normops-20260926-1546-acl-${crypto.randomBytes(3).toString("hex")}`,
      `--expected-commit=${"0".repeat(40)}`,
      `--preflight=${preflightPath}`
    ]);
    expect(wrongCommit.status).not.toBe(0);

    for (const artifactPath of [forwardPath, rollbackPath, postflightPath]) {
      const artifactBytes = fs.readFileSync(artifactPath);
      fs.appendFileSync(artifactPath, "\n-- tamper");
      expect(callApi(root, `verifyAclPostflight({root:${JSON.stringify(root)},manifestPath:${JSON.stringify(manifestPath)},evidencePath:${JSON.stringify(afterPath)},phase:"after"});`).status).not.toBe(0);
      fs.writeFileSync(artifactPath, artifactBytes);
    }
    const preflightBytes = fs.readFileSync(preflightPath);
    fs.appendFileSync(preflightPath, " ");
    expect(callApi(root, `verifyAclPostflight({root:${JSON.stringify(root)},manifestPath:${JSON.stringify(manifestPath)},evidencePath:${JSON.stringify(afterPath)},phase:"after"});`).status).not.toBe(0);
    fs.writeFileSync(preflightPath, preflightBytes);
    const manifestBytes = fs.readFileSync(manifestPath);
    const tamperedManifest = JSON.parse(manifestBytes.toString("utf8"));
    tamperedManifest.codeIdentity.sourceSha256 = "0".repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(tamperedManifest));
    expect(callApi(root, `verifyAclPostflight({root:${JSON.stringify(root)},manifestPath:${JSON.stringify(manifestPath)},evidencePath:${JSON.stringify(afterPath)},phase:"after"});`).status).not.toBe(0);
    fs.writeFileSync(manifestPath, manifestBytes);
    const wrongPackagePath = writeJson(directory, "wrong-package.json", { ...afterEvidence(before, packageIdentity), package_identity: { ...packageIdentity, runId: `${runId}-wrong` } });
    expect(callApi(root, `verifyAclPostflight({root:${JSON.stringify(root)},manifestPath:${JSON.stringify(manifestPath)},evidencePath:${JSON.stringify(wrongPackagePath)},phase:"after"});`).status).not.toBe(0);
    const appStateDriftPath = writeJson(directory, "app-state-drift.json", {
      ...afterEvidence(before, packageIdentity),
      app_state: { ...(before.app_state as object), bytes: (before.app_state as { bytes: number }).bytes + 1 }
    });
    expect(callApi(root, `verifyAclPostflight({root:${JSON.stringify(root)},manifestPath:${JSON.stringify(manifestPath)},evidencePath:${JSON.stringify(appStateDriftPath)},phase:"after"});`).status).not.toBe(0);

    const trackedPath = path.join(root, "package.json");
    const trackedBytes = fs.readFileSync(trackedPath);
    fs.appendFileSync(trackedPath, " ");
    expect(callApi(root, `verifyAclPostflight({root:${JSON.stringify(root)},manifestPath:${JSON.stringify(manifestPath)},evidencePath:${JSON.stringify(afterPath)},phase:"after"});`).status).not.toBe(0);
    fs.writeFileSync(trackedPath, trackedBytes);
    const untrackedPath = path.join(root, "src", "qa", "acl-convergence-untracked.ts");
    fs.writeFileSync(untrackedPath, "export {};\n");
    const dirtyBuild = runNode(root, "scripts/build-operational-lifecycle-v2-staging-acl-convergence.mjs", [
      `--run-id=normops-20260926-1547-acl-${crypto.randomBytes(3).toString("hex")}`,
      `--expected-commit=${commit}`,
      `--preflight=${preflightPath}`
    ]);
    expect(dirtyBuild.status).not.toBe(0);
    fs.rmSync(untrackedPath);
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
    const finalVerification = runNode(root, verifier, [`--manifest=${manifestPath}`, `--evidence=${afterPath}`, "--phase=after"]);
    expect(finalVerification.status, finalVerification.stderr).toBe(0);
  }, 60_000);
});
