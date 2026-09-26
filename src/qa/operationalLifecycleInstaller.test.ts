import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cleanupPaths: string[] = [];

const SOURCE_DIRS = ["scripts", "src", "supabase", "tests"] as const;
const ROOT_SOURCE_PATTERN = /^(?:package(?:-lock)?\.json|(?:playwright|vite|vitest|eslint|tsconfig)[^/]*\.(?:ts|js|mjs|json)|index\.html)$/;
const FUNCTION_NAMES = [
  "hop_session_v2", "reject_session_v2", "reject_customer_tab_v2",
  "get_operational_performance_dataset_identity", "start_session", "open_customer_tab", "link_customer_tab_continuation"
] as const;
const LEGACY_NAMES = ["hop_session", "reject_session", "reject_customer_tab"] as const;
const FUNCTION_ACL = ["authenticated", "postgres"].map((grantee) => ({
  grantor: "postgres", grantee, privilege_type: "EXECUTE", is_grantable: false
}));
function expectedTableAcl(serverVersionNum: number) {
  const privileges = ["DELETE", "INSERT", ...(serverVersionNum >= 170000 ? ["MAINTAIN"] : []), "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"];
  return privileges.map((privilege_type) => ({ grantor: "postgres", grantee: "postgres", privilege_type, is_grantable: false }));
}
const TABLE_ACL = expectedTableAcl(170000);

function sha256(value: crypto.BinaryLike) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function expectedMetadata(name: string) {
  return {
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
    acl_detail: FUNCTION_ACL
  };
}

function lifecycleSourceIdentity(root: string) {
  const sourcePaths: string[] = [];
  const visit = (relative: string) => {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected test-fixture source link: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    } else {
      sourcePaths.push(relative);
    }
  };
  for (const dir of SOURCE_DIRS) visit(dir);
  for (const name of fs.readdirSync(root).sort()) if (ROOT_SOURCE_PATTERN.test(name)) sourcePaths.push(name);
  const files = sourcePaths.sort().map((file) => ({ path: file, sha256: sha256(fs.readFileSync(path.join(root, file))) }));
  return { schemaVersion: 1, sha256: sha256(JSON.stringify(files)), files };
}

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }
  });
  if (result.status !== 0) throw new Error(`Git fixture command failed: git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function createCommittedFixture() {
  const sourceRoot = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "normops-installer-git-"));
  cleanupPaths.push(root);
  for (const dir of SOURCE_DIRS) fs.cpSync(path.join(sourceRoot, dir), path.join(root, dir), { recursive: true });
  for (const name of fs.readdirSync(sourceRoot)) {
    if (ROOT_SOURCE_PATTERN.test(name) || [".gitignore", ".gitattributes"].includes(name)) {
      const source = path.join(sourceRoot, name);
      if (fs.existsSync(source) && fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(root, name));
    }
  }
  git(root, "init");
  git(root, "config", "user.name", "Operational lifecycle installer QA");
  git(root, "config", "user.email", "qa@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  git(root, "add", "--all");
  git(root, "commit", "-m", "Committed installer QA fixture");
  const commit = git(root, "rev-parse", "HEAD");
  expect(commit).toMatch(/^[a-f0-9]{40}$/);
  expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
  return { root, commit, sourceIdentity: lifecycleSourceIdentity(root) };
}

function readFunctionSource(root: string, name: string) {
  const files: Record<string, string> = {
    hop_session_v2: "supabase/operational-lifecycle-v2.sql",
    reject_session_v2: "supabase/operational-lifecycle-v2.sql",
    reject_customer_tab_v2: "supabase/operational-lifecycle-v2.sql",
    get_operational_performance_dataset_identity: "supabase/operational-performance-dataset-identity-staging.sql",
    start_session: "supabase/phase4-start-session-rpc.sql",
    open_customer_tab: "supabase/phase4-customer-tab-rpcs.sql",
    link_customer_tab_continuation: "supabase/phase4-link-customer-tab-continuation-rpc.sql"
  };
  const source = fs.readFileSync(path.join(root, files[name]), "utf8");
  const body = source.match(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)[\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`, "i"))?.[1];
  if (!body) throw new Error(`Unable to extract fixture body for ${name}.`);
  return body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

function functionEvidence(root: string, name: string, lineEnding: "lf" | "crlf" | "cr" = "lf", old = false) {
  const canonicalBody = old
    ? `BEGIN\n  RETURN jsonb_build_object('old','${name}');\nEND`
    : readFunctionSource(root, name);
  const body = lineEnding === "crlf" ? canonicalBody.replaceAll("\n", "\r\n") : lineEnding === "cr" ? canonicalBody.replaceAll("\n", "\r") : canonicalBody;
  const stability = name === "get_operational_performance_dataset_identity" ? " STABLE" : "";
  const definition = `CREATE OR REPLACE FUNCTION public.${name}(payload jsonb) RETURNS jsonb LANGUAGE plpgsql${stability} SECURITY DEFINER SET search_path TO 'public' AS $function$${lineEnding === "lf" ? "\n" : lineEnding === "crlf" ? "\r\n" : "\r"}${body}${lineEnding === "lf" ? "\n" : lineEnding === "crlf" ? "\r\n" : "\r"}$function$`;
  return {
    name,
    definition,
    definition_md5: crypto.createHash("md5").update(definition).digest("hex"),
    ...expectedMetadata(name),
    public_execute: false,
    anon_execute: false,
    authenticated_execute: true,
    service_role_execute: false
  };
}

function legacyFunctionEvidence(name: string) {
  const definition = `CREATE OR REPLACE FUNCTION public.${name}(payload jsonb) RETURNS jsonb LANGUAGE plpgsql AS $function$ BEGIN RETURN '{}'::jsonb; END $function$`;
  return { name, definition, definition_md5: crypto.createHash("md5").update(definition).digest("hex") };
}

function baseEvidence(functions: object[]) {
  return {
    expected_project_ref: "tkbdyzxwwbhkpztgjjxh",
    system_identifier: "7623125441096521075",
    server_version_num: 170000,
    environment_identity: { environment: "staging", project_ref: "tkbdyzxwwbhkpztgjjxh", identity_nonce: "12345678-1234-4123-8123-123456789abc" },
    organization_id: "org-primary",
    organization_exists: true,
    open_sessions: 0,
    open_customer_tabs: 0,
    recoverable_hopped_sessions: 0,
    processing_financial_mutations: 0,
    processing_operational_mutations: 0,
    app_state: {
      version: 10,
      bytes: 12345,
      md5: "0123456789abcdef0123456789abcdef",
      updated_at: "2026-09-13T01:00:00.000000+00:00",
      updated_by: "12345678-1234-4123-8123-123456789abc"
    },
    functions
  };
}

function runNode(root: string, script: string, args: string[]) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], { cwd: root, encoding: "utf8", windowsHide: true });
}

afterEach(() => {
  const tempRoot = path.resolve(os.tmpdir());
  const artifactRoot = path.resolve(process.cwd(), "test-artifacts");
  cleanupPaths.reverse().forEach((entry) => {
    const resolved = path.resolve(entry);
    const insideTempFixture = resolved.startsWith(`${tempRoot}${path.sep}`) && path.basename(resolved).startsWith("normops-");
    const insideCandidateArtifacts = resolved.startsWith(`${artifactRoot}${path.sep}`);
    if ((!insideTempFixture && !insideCandidateArtifacts) || [tempRoot, artifactRoot, path.resolve(process.cwd())].includes(resolved)) {
      throw new Error(`Refusing unsafe installer-test cleanup target: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  cleanupPaths.length = 0;
});

describe("operational lifecycle staging installer", () => {
  it("derives the exact owner table ACL for supported PostgreSQL major versions", () => {
    const root = process.cwd();
    const script = `import { expectedTableAcl, assertMutationTable } from ${JSON.stringify(pathToFileURL(path.join(root, "scripts", "lifecycle-install-contract.mjs")).href)};
      const values=[150000,160000,170000,179999].map((version)=>[version,expectedTableAcl(version)]);
      let rejected=0; for (const version of [140000,180000]) { try { expectedTableAcl(version); } catch { rejected++; } }
      const entry=(version,acl)=>({server_version_num:version,operational_mutations_owner:'postgres',operational_mutations_force_rls:false,operational_mutations_acl:acl});
      assertMutationTable(entry(160000,expectedTableAcl(160000)));
      assertMutationTable(entry(170000,expectedTableAcl(170000)));
      for (const candidate of [
        entry(170000,expectedTableAcl(170000).filter((grant)=>grant.privilege_type!=='MAINTAIN')),
        entry(160000,[...expectedTableAcl(160000),...expectedTableAcl(170000).filter((grant)=>grant.privilege_type==='MAINTAIN')]),
        entry(undefined,expectedTableAcl(170000))
      ]) { try { assertMutationTable(candidate); } catch { rejected++; } }
      process.stdout.write(JSON.stringify({values,rejected}));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { cwd: root, encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.values[0][1]).toEqual(expectedTableAcl(150000));
    expect(observed.values[1][1]).toEqual(expectedTableAcl(160000));
    expect(observed.values[2][1]).toEqual(expectedTableAcl(170000));
    expect(observed.values[3][1]).toEqual(expectedTableAcl(179999));
    expect(observed.values[0][1].some((entry: { privilege_type: string }) => entry.privilege_type === "MAINTAIN")).toBe(false);
    expect(observed.values[2][1].some((entry: { privilege_type: string }) => entry.privilege_type === "MAINTAIN")).toBe(true);
    expect(observed.rejected).toBe(5);
  });

  it("binds an initial install to a clean committed source identity and strict absent schema", () => {
    const { root, commit, sourceIdentity } = createCommittedFixture();
    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "normops-preflight-"));
    cleanupPaths.push(evidenceDir);
    const functions = [
      ...LEGACY_NAMES.map(legacyFunctionEvidence),
      functionEvidence(root, "start_session", "crlf", true),
      functionEvidence(root, "open_customer_tab", "cr", true),
      functionEvidence(root, "link_customer_tab_continuation", "lf", true)
    ];
    const cleanEvidence = { ...baseEvidence(functions), operational_mutations_table_exists: false };
    const preflightPath = path.join(evidenceDir, "preflight.json");
    fs.writeFileSync(preflightPath, JSON.stringify(cleanEvidence));
    const script = "scripts/build-operational-lifecycle-v2-staging-install.mjs";

    for (const [slug, args] of [
      ["missing-commit", []],
      ["malformed-commit", ["--expected-commit=not-a-commit"]],
      ["wrong-commit", [`--expected-commit=${"0".repeat(40)}`]]
    ] as const) {
      const rejected = runNode(root, script, [
        `--run-id=normops-20260912-2028-${slug}-${crypto.randomBytes(3).toString("hex")}`,
        `--preflight=${preflightPath}`,
        ...args
      ]);
      expect(rejected.status).not.toBe(0);
    }

    for (const field of ["version", "bytes", "md5", "updated_at", "updated_by"] as const) {
      const bad = structuredClone(cleanEvidence);
      delete (bad.app_state as Record<string, unknown>)[field];
      const badPath = path.join(evidenceDir, `missing-${field}.json`);
      fs.writeFileSync(badPath, JSON.stringify(bad));
      const rejected = runNode(root, script, [
        `--run-id=normops-20260912-2028-missing-${field.replaceAll("_", "-")}-${crypto.randomBytes(3).toString("hex")}`,
        `--preflight=${badPath}`,
        `--expected-commit=${commit}`
      ]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(`Preflight app_state ${field} is missing`);
    }

    const datasetPresentPath = path.join(evidenceDir, "dataset-present.json");
    fs.writeFileSync(datasetPresentPath, JSON.stringify({
      ...cleanEvidence,
      functions: [...functions, functionEvidence(root, "get_operational_performance_dataset_identity")]
    }));
    const datasetPresent = runNode(root, script, [
      `--run-id=normops-20260912-2028-dataset-present-${crypto.randomBytes(3).toString("hex")}`,
      `--preflight=${datasetPresentPath}`,
      `--expected-commit=${commit}`
    ]);
    expect(datasetPresent.status).not.toBe(0);
    expect(datasetPresent.stderr).toContain("Preflight function set is incomplete, duplicated or unexpected for initial mode");
    for (const [slug, unexpectedFunctions] of [
      ["duplicate", [...functions, functions[0]]],
      ["unknown", [...functions.slice(0, -1), { ...functions.at(-1)!, name: "unknown_function" }]]
    ] as const) {
      const invalidPath = path.join(evidenceDir, `${slug}.json`);
      fs.writeFileSync(invalidPath, JSON.stringify({ ...cleanEvidence, functions: unexpectedFunctions }));
      const rejected = runNode(root, script, [
        `--run-id=normops-20260912-2028-${slug}-${crypto.randomBytes(3).toString("hex")}`,
        `--preflight=${invalidPath}`,
        `--expected-commit=${commit}`
      ]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("Preflight function set is incomplete, duplicated or unexpected for initial mode");
    }

    const runId = `normops-20260912-2028-installer-${crypto.randomBytes(4).toString("hex")}`;
    const outputDir = path.join(root, "test-artifacts", "operational-lifecycle-v2", runId);
    const command = [`--run-id=${runId}`, `--preflight=${preflightPath}`, `--expected-commit=${commit}`];
    const first = runNode(root, script, command);
    expect(first.status, first.stderr).toBe(0);
    const installPath = path.join(outputDir, "staging-install.sql");
    const rollbackPath = path.join(outputDir, "staging-rollback.sql");
    const postflightPath = path.join(outputDir, "staging-postflight-readonly.sql");
    const manifestPath = path.join(outputDir, "manifest.json");
    const install = fs.readFileSync(installPath, "utf8");
    const rollback = fs.readFileSync(rollbackPath, "utf8");
    const postflight = fs.readFileSync(postflightPath, "utf8");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    expect(manifest.codeIdentity).toEqual({ commit, sourceSha256: sourceIdentity.sha256 });
    expect(manifest.serverVersionNum).toBe(170000);
    expect(manifest.expectedTableAcl).toEqual(TABLE_ACL);
    expect(manifest.expectedFunctionMetadata).toEqual(Object.fromEntries(FUNCTION_NAMES.map((name) => [name, expectedMetadata(name)])));
    expect(manifest.artifacts.install.sha256).toBe(sha256(install));
    expect(manifest.artifacts.rollback.sha256).toBe(sha256(rollback));
    expect(manifest.artifacts.postflight.sha256).toBe(sha256(postflight));
    expect(postflight).toContain(runId);
    expect(postflight).toContain(commit);
    expect(postflight).toContain(sourceIdentity.sha256);
    expect(postflight).not.toMatch(/__(?:PACKAGE_RUN_ID|SOURCE_COMMIT|SOURCE_SHA256)__/);

    expect(install).toMatch(/create table public\.operational_mutations/i);
    expect(install).not.toMatch(/create table if not exists public\.operational_mutations/i);
    for (const name of ["hop_session_v2", "reject_session_v2", "reject_customer_tab_v2", "get_operational_performance_dataset_identity"]) {
      expect(install).toMatch(new RegExp(`create function public\\.${name}\\(payload jsonb\\)`, "i"));
      expect(install).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)`, "i"));
    }
    for (const field of ["version", "data_md5", "data_bytes", "updated_at", "updated_by"]) expect(install).toContain(field);
    expect(install).toContain("initial install requires absent v2 table/functions and dataset helper");
    expect(install.match(/^begin;$/gim)).toHaveLength(1);
    expect(install.match(/^commit;$/gim)).toHaveLength(1);
    expect(rollback.match(/^begin;$/gim)).toHaveLength(1);
    expect(rollback.match(/^commit;$/gim)).toHaveLength(1);
    expect(rollback).toContain("installed body or metadata drift for hop_session_v2");
    expect(rollback.match(/operational mutation table security drift/g)?.length).toBeGreaterThanOrEqual(2);
    const guardIndex = rollback.indexOf("installed body or metadata drift for hop_session_v2");
    const tableGuardIndex = rollback.indexOf("operational mutation table security drift");
    const restoreIndex = rollback.search(/CREATE OR REPLACE FUNCTION public\.start_session\(payload jsonb\)/i);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(tableGuardIndex).toBeGreaterThan(-1);
    expect(restoreIndex).toBeGreaterThan(guardIndex);
    expect(restoreIndex).toBeGreaterThan(tableGuardIndex);
    expect(rollback).not.toMatch(/select\s+count\(\*\)\s+from\s+public\.operational_mutations/i);
    expect(rollback).not.toMatch(/\bdrop\s+(?:table|function)\b|\btruncate\s+(?:table\s+)?public\.operational_mutations|\bdelete\s+from\s+public\.operational_mutations/i);
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");

    const second = runNode(root, script, command);
    expect(second.status).not.toBe(0);

    const driftPath = path.join(root, "package.json");
    const cleanPackage = fs.readFileSync(driftPath);
    fs.appendFileSync(driftPath, " ");
    const drifted = runNode(root, script, [
      `--run-id=normops-20260912-2028-source-drift-${crypto.randomBytes(3).toString("hex")}`,
      `--preflight=${preflightPath}`,
      `--expected-commit=${commit}`
    ]);
    expect(drifted.status).not.toBe(0);
    expect(drifted.stderr).toContain("Candidate worktree must be clean");
    fs.writeFileSync(driftPath, cleanPackage);
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
  }, 60_000);

  it("builds and verifies a source-bound reinstall with exact metadata and rollback guards", () => {
    const { root, commit, sourceIdentity } = createCommittedFixture();
    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "normops-reinstall-"));
    cleanupPaths.push(evidenceDir);
    const functions = [
      ...LEGACY_NAMES.map(legacyFunctionEvidence),
      ...FUNCTION_NAMES.map((name, index) => functionEvidence(
        root,
        name,
        index === 0 || index === 4 ? "crlf" : index === 1 || index === 5 ? "cr" : "lf",
        index < 3
      ))
    ];
    const preflight = {
      ...baseEvidence(functions),
      operational_mutations_table_exists: true,
      operational_mutations_owner: "postgres",
      operational_mutations_acl: TABLE_ACL
    };
    const preflightPath = path.join(evidenceDir, "preflight.json");
    fs.writeFileSync(preflightPath, JSON.stringify(preflight));
    const runId = `normops-20260913-0700-reinstall-${crypto.randomBytes(4).toString("hex")}`;
    const outputDir = path.join(root, "test-artifacts", "operational-lifecycle-v2", runId);
    const script = "scripts/build-operational-lifecycle-v2-staging-reinstall.mjs";
    const command = [`--run-id=${runId}`, `--preflight=${preflightPath}`, `--expected-commit=${commit}`];
    const first = runNode(root, script, command);
    expect(first.status, first.stderr).toBe(0);

    const install = fs.readFileSync(path.join(outputDir, "staging-reinstall.sql"), "utf8");
    const rollback = fs.readFileSync(path.join(outputDir, "staging-reinstall-rollback.sql"), "utf8");
    const generatedPostflight = fs.readFileSync(path.join(outputDir, "staging-postflight-readonly.sql"), "utf8");
    const manifestPath = path.join(outputDir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.codeIdentity).toEqual({ commit, sourceSha256: sourceIdentity.sha256 });
    expect(manifest.serverVersionNum).toBe(170000);
    expect(manifest.expectedTableAcl).toEqual(TABLE_ACL);
    expect(manifest.expectedFunctionMetadata).toEqual(Object.fromEntries(FUNCTION_NAMES.map((name) => [name, expectedMetadata(name)])));
    expect(manifest.artifacts.postflight.sha256).toBe(sha256(generatedPostflight));
    expect(generatedPostflight).toContain(runId);
    expect(generatedPostflight).toContain(commit);
    expect(generatedPostflight).toContain(sourceIdentity.sha256);

    for (const name of FUNCTION_NAMES.slice(0, 3)) {
      expect((install.match(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)`, "gi")) ?? [])).toHaveLength(1);
      expect(rollback).toContain(`RETURN jsonb_build_object('old','${name}')`);
      expect(rollback).toContain(`alter function public.${name}(jsonb) owner to postgres`);
    }
    for (const name of FUNCTION_NAMES.slice(3)) {
      expect(install).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)`, "i"));
      expect(rollback).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)`, "i"));
    }
    expect(install).toContain("md5(btrim(replace(replace(p.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)), E' \\t\\n\\r'))");
    expect(rollback).toContain("md5(btrim(replace(replace(p.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)), E' \\t\\n\\r'))");
    for (const entry of functions.filter((candidate) => FUNCTION_NAMES.includes(candidate.name as typeof FUNCTION_NAMES[number]) && /\r/.test(candidate.definition))) {
      const rawBody = entry.definition.match(/AS \$function\$([\s\S]*?)\$function\$/i)![1];
      const canonical = crypto.createHash("md5").update(rawBody.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim()).digest("hex");
      expect(install).toContain(canonical);
      expect(rollback).toContain(canonical);
    }
    expect(install.match(/^begin;$/gim)).toHaveLength(1);
    expect(install.match(/^commit;$/gim)).toHaveLength(1);
    expect(rollback.match(/^begin;$/gim)).toHaveLength(1);
    expect(rollback.match(/^commit;$/gim)).toHaveLength(1);
    expect(rollback).not.toMatch(/\bdrop\s+(?:table|function)\b|\btruncate\s+(?:table\s+)?public\.operational_mutations|\bdelete\s+from\s+public\.operational_mutations/i);
    expect(rollback.match(/operational mutation table security drift/g)?.length).toBeGreaterThanOrEqual(2);
    const installedGuard = rollback.indexOf("installed definition, owner, configuration, or ACL mismatch for hop_session_v2");
    const tableGuard = rollback.indexOf("operational mutation table security drift");
    const restoration = rollback.search(/CREATE OR REPLACE FUNCTION public\.hop_session_v2\(payload jsonb\)/i);
    expect(installedGuard).toBeGreaterThan(-1);
    expect(tableGuard).toBeGreaterThan(-1);
    expect(restoration).toBeGreaterThan(installedGuard);
    expect(restoration).toBeGreaterThan(tableGuard);
    expect(rollback).not.toMatch(/select\s+count\(\*\)\s+from\s+public\.operational_mutations/i);

    const postflightFunctions = FUNCTION_NAMES.map((name, index) => functionEvidence(root, name, index === 4 ? "crlf" : index === 5 ? "cr" : "lf"));
    const postflight = {
      ...baseEvidence(postflightFunctions),
      package_run_id: runId,
      source_commit: commit,
      source_sha256: sourceIdentity.sha256,
      operational_mutations_owner: "postgres",
      operational_mutations_acl: TABLE_ACL,
      operational_mutations_rls: true,
      operational_mutations_force_rls: false,
      operational_mutations_forbidden_privileges: [],
      operational_mutations_policies: [],
      public_execute: false,
      service_role_execute: false
    };
    const postflightPath = path.join(evidenceDir, "postflight.json");
    fs.writeFileSync(postflightPath, JSON.stringify(postflight));
    const verifier = "scripts/verify-operational-lifecycle-v2-staging-postflight.mjs";
    const verifierArgs = [
      `--preflight=${preflightPath}`,
      `--postflight=${postflightPath}`,
      `--manifest=${manifestPath}`,
      `--expected-commit=${commit}`
    ];
    const missingCommit = runNode(root, verifier, verifierArgs.slice(0, -1));
    expect(missingCommit.status).not.toBe(0);
    const wrongCommit = runNode(root, verifier, [...verifierArgs.slice(0, -1), `--expected-commit=${"0".repeat(40)}`]);
    expect(wrongCommit.status).not.toBe(0);
    const verification = runNode(root, verifier, verifierArgs);
    expect(verification.status, verification.stderr).toBe(0);
    expect(fs.existsSync(path.join(outputDir, "postflight-verification.json"))).toBe(true);
    const verifiedRollback = fs.readFileSync(path.join(outputDir, "staging-rollback-verified.sql"), "utf8");
    expect(verifiedRollback).toContain("installed body or metadata drift for hop_session_v2");
    expect(verifiedRollback).not.toMatch(/\bdrop\s+(?:table|function)\b|\bdelete\s+from\s+public\.operational_mutations/i);
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
  }, 60_000);

  it("refuses every incomplete or drifted reinstall preflight contract", () => {
    const { root, commit } = createCommittedFixture();
    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "normops-reinstall-refuse-"));
    cleanupPaths.push(evidenceDir);
    const cleanFunctions = [
      ...LEGACY_NAMES.map(legacyFunctionEvidence),
      ...FUNCTION_NAMES.map((name, index) => functionEvidence(root, name, "lf", index < 3))
    ];
    const cleanEvidence = {
      ...baseEvidence(cleanFunctions),
      operational_mutations_table_exists: true,
      operational_mutations_owner: "postgres",
      operational_mutations_acl: TABLE_ACL
    };
    const mutate = (name: string, patch: Record<string, unknown>) => cleanFunctions.map((entry) => entry.name === name ? { ...entry, ...patch } : entry);
    const metadataCases: Array<[string, string, unknown]> = [
      ["owner", "owner", "other_role"],
      ["security-definer", "security_definer", false],
      ["volatility", "volatility", "s"],
      ["config", "config", ["search_path=public", "statement_timeout=5s"]],
      ["language", "language", "sql"],
      ["strict", "strict", true],
      ["parallel", "parallel", "s"],
      ["leakproof", "leakproof", true],
      ["cost", "cost", 99],
      ["rows", "rows", 1],
      ["returns-set", "returns_set", true],
      ["result", "result", "text"],
      ["kind", "kind", "p"],
      ["support", "support", 1]
    ];
    const cases: Array<{ slug: string; evidence?: Record<string, unknown>; functions?: object[] }> = [
      { slug: "missing-function", functions: cleanFunctions.filter((entry) => entry.name !== "reject_session_v2") },
      { slug: "duplicate-function", functions: [...cleanFunctions, cleanFunctions[0]] },
      { slug: "unknown-function", functions: [...cleanFunctions.slice(0, -1), { ...cleanFunctions.at(-1)!, name: "unknown_function" }] },
      { slug: "definition-hash", functions: mutate("hop_session_v2", { definition_md5: "bad" }) },
      { slug: "public-execute", functions: mutate("hop_session_v2", { public_execute: true }) },
      { slug: "anon-execute", functions: mutate("hop_session_v2", { anon_execute: true }) },
      { slug: "missing-authenticated", functions: mutate("hop_session_v2", { authenticated_execute: false }) },
      { slug: "grantable", functions: mutate("reject_session_v2", { acl_detail: FUNCTION_ACL.map((grant, index) => index ? grant : { ...grant, is_grantable: true }) }) },
      { slug: "extra-service", functions: mutate("reject_customer_tab_v2", { acl_detail: [...FUNCTION_ACL, { grantor: "postgres", grantee: "service_role", privilege_type: "EXECUTE", is_grantable: false }] }) },
      { slug: "sessions", evidence: { open_sessions: 1 } },
      { slug: "tabs", evidence: { open_customer_tabs: 1 } },
      { slug: "hopped", evidence: { recoverable_hopped_sessions: 1 } },
      { slug: "financial", evidence: { processing_financial_mutations: 1 } },
      { slug: "operational", evidence: { processing_operational_mutations: 1 } },
      { slug: "missing-server-version", evidence: { server_version_num: undefined } },
      { slug: "unsupported-server-version", evidence: { server_version_num: 140000 } },
      ...metadataCases.map(([slug, field, value]) => ({ slug: `metadata-${slug}`, functions: mutate("hop_session_v2", { [field]: value }) }))
    ];
    for (const field of ["version", "bytes", "md5", "updated_at", "updated_by"] as const) {
      const appState = { ...cleanEvidence.app_state } as Record<string, unknown>;
      delete appState[field];
      cases.push({ slug: `appstate-${field.replaceAll("_", "-")}`, evidence: { app_state: appState } });
    }
    for (const testCase of cases) {
      const runId = `normops-20260913-0701-${testCase.slug}-${crypto.randomBytes(3).toString("hex")}`;
      const preflightPath = path.join(evidenceDir, `${testCase.slug}.json`);
      fs.writeFileSync(preflightPath, JSON.stringify({
        ...cleanEvidence,
        ...testCase.evidence,
        functions: testCase.functions ?? cleanFunctions
      }));
      const result = runNode(root, "scripts/build-operational-lifecycle-v2-staging-reinstall.mjs", [
        `--run-id=${runId}`,
        `--preflight=${preflightPath}`,
        `--expected-commit=${commit}`
      ]);
      expect(result.status, `${testCase.slug} unexpectedly succeeded`).not.toBe(0);
      expect(fs.existsSync(path.join(root, "test-artifacts", "operational-lifecycle-v2", runId))).toBe(false);
    }
    const cleanPath = path.join(evidenceDir, "clean.json");
    fs.writeFileSync(cleanPath, JSON.stringify(cleanEvidence));
    const cleanRunId = `normops-20260913-0701-clean-${crypto.randomBytes(3).toString("hex")}`;
    const accepted = runNode(root, "scripts/build-operational-lifecycle-v2-staging-reinstall.mjs", [
      `--run-id=${cleanRunId}`,
      `--preflight=${cleanPath}`,
      `--expected-commit=${commit}`
    ]);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, "test-artifacts", "operational-lifecycle-v2", cleanRunId, "manifest.json"))).toBe(true);
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
  }, 90_000);

  it("fails postflight closed on identity, floor, function, table, artifact, or source drift", () => {
    const { root, commit, sourceIdentity } = createCommittedFixture();
    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "normops-postflight-refuse-"));
    cleanupPaths.push(evidenceDir);
    const preflightFunctions = [
      ...LEGACY_NAMES.map(legacyFunctionEvidence),
      ...FUNCTION_NAMES.map((name, index) => functionEvidence(root, name, "lf", index < 3))
    ];
    const preflight = {
      ...baseEvidence(preflightFunctions),
      operational_mutations_table_exists: true,
      operational_mutations_owner: "postgres",
      operational_mutations_acl: TABLE_ACL
    };
    const preflightPath = path.join(evidenceDir, "preflight.json");
    fs.writeFileSync(preflightPath, JSON.stringify(preflight));
    const runId = `normops-20260913-0710-postflight-${crypto.randomBytes(4).toString("hex")}`;
    const outputDir = path.join(root, "test-artifacts", "operational-lifecycle-v2", runId);
    const built = runNode(root, "scripts/build-operational-lifecycle-v2-staging-reinstall.mjs", [
      `--run-id=${runId}`,
      `--preflight=${preflightPath}`,
      `--expected-commit=${commit}`
    ]);
    expect(built.status, built.stderr).toBe(0);
    const manifestPath = path.join(outputDir, "manifest.json");
    const functions = FUNCTION_NAMES.map((name) => functionEvidence(root, name));
    const clean = {
      ...baseEvidence(functions),
      package_run_id: runId,
      source_commit: commit,
      source_sha256: sourceIdentity.sha256,
      operational_mutations_owner: "postgres",
      operational_mutations_acl: TABLE_ACL,
      operational_mutations_rls: true,
      operational_mutations_force_rls: false,
      operational_mutations_forbidden_privileges: [],
      operational_mutations_policies: []
    };
    const postflightPath = path.join(evidenceDir, "postflight.json");
    const verify = () => runNode(root, "scripts/verify-operational-lifecycle-v2-staging-postflight.mjs", [
      `--preflight=${preflightPath}`,
      `--postflight=${postflightPath}`,
      `--manifest=${manifestPath}`,
      `--expected-commit=${commit}`
    ]);
    const replaceFunction = (patch: Record<string, unknown>) => functions.map((entry, index) => index === 0 ? { ...entry, ...patch } : entry);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["run-id", { package_run_id: `${runId}-wrong` }],
      ["source-commit", { source_commit: "0".repeat(40) }],
      ["source-sha", { source_sha256: "0".repeat(64) }],
      ["server-version", { server_version_num: 160000 }],
      ["sessions", { open_sessions: 1 }],
      ["tabs", { open_customer_tabs: 1 }],
      ["hopped", { recoverable_hopped_sessions: 1 }],
      ["financial", { processing_financial_mutations: 1 }],
      ["operational", { processing_operational_mutations: 1 }],
      ["table-owner", { operational_mutations_owner: "other_role" }],
      ["table-acl-missing", { operational_mutations_acl: TABLE_ACL.slice(1) }],
      ["table-acl-missing-maintain", { operational_mutations_acl: TABLE_ACL.filter((grant) => grant.privilege_type !== "MAINTAIN") }],
      ["table-acl-grantable", { operational_mutations_acl: TABLE_ACL.map((grant, index) => index ? grant : { ...grant, is_grantable: true }) }],
      ["rls", { operational_mutations_rls: false }],
      ["force-rls", { operational_mutations_force_rls: true }],
      ["missing-force-rls", { operational_mutations_force_rls: undefined }],
      ["policy", { operational_mutations_policies: ["unexpected_policy"] }],
      ["privilege", { operational_mutations_forbidden_privileges: [{ role: "authenticated", privilege: "INSERT" }] }],
      ["owner", { functions: replaceFunction({ owner: "other_role" }) }],
      ["security-definer", { functions: replaceFunction({ security_definer: false }) }],
      ["volatility", { functions: replaceFunction({ volatility: "s" }) }],
      ["config", { functions: replaceFunction({ config: ["search_path=public", "statement_timeout=5s"] }) }],
      ["language", { functions: replaceFunction({ language: "sql" }) }],
      ["strict", { functions: replaceFunction({ strict: true }) }],
      ["parallel", { functions: replaceFunction({ parallel: "s" }) }],
      ["leakproof", { functions: replaceFunction({ leakproof: true }) }],
      ["cost", { functions: replaceFunction({ cost: 99 }) }],
      ["rows", { functions: replaceFunction({ rows: 1 }) }],
      ["returns-set", { functions: replaceFunction({ returns_set: true }) }],
      ["result", { functions: replaceFunction({ result: "text" }) }],
      ["kind", { functions: replaceFunction({ kind: "p" }) }],
      ["support", { functions: replaceFunction({ support: 1 }) }],
      ["missing-grant", { functions: replaceFunction({ acl_detail: FUNCTION_ACL.slice(1) }) }],
      ["public-grant", { functions: replaceFunction({ acl_detail: [...FUNCTION_ACL, { grantor: "postgres", grantee: "PUBLIC", privilege_type: "EXECUTE", is_grantable: false }] }) }],
      ["service-grant", { functions: replaceFunction({ acl_detail: [...FUNCTION_ACL, { grantor: "postgres", grantee: "service_role", privilege_type: "EXECUTE", is_grantable: false }] }) }],
      ["wrong-privilege", { functions: replaceFunction({ acl_detail: FUNCTION_ACL.map((grant, index) => index ? grant : { ...grant, privilege_type: "SELECT" }) }) }],
      ["grant-option", { functions: replaceFunction({ acl_detail: FUNCTION_ACL.map((grant, index) => index ? grant : { ...grant, is_grantable: true }) }) }],
      ["public-flag", { functions: replaceFunction({ public_execute: true }) }],
      ["anon-flag", { functions: replaceFunction({ anon_execute: true }) }],
      ["service-flag", { functions: replaceFunction({ service_role_execute: true }) }],
      ["missing-authenticated-flag", { functions: replaceFunction({ authenticated_execute: false }) }]
    ];
    for (const [slug, patch] of cases) {
      fs.writeFileSync(postflightPath, JSON.stringify({ ...clean, ...patch }));
      const result = verify();
      expect(result.status, `${slug} unexpectedly passed`).not.toBe(0);
      expect(fs.existsSync(path.join(outputDir, "postflight-verification.json"))).toBe(false);
    }

    const inconsistent = { ...functions[0], definition_md5: "0".repeat(32) };
    fs.writeFileSync(postflightPath, JSON.stringify({ ...clean, functions: [inconsistent, ...functions.slice(1)] }));
    expect(verify().status).not.toBe(0);
    const changedDefinition = functions[0].definition.replace(/\$function\$$/, "\n-- body drift\n$function$");
    expect(changedDefinition).not.toBe(functions[0].definition);
    fs.writeFileSync(postflightPath, JSON.stringify({
      ...clean,
      functions: [{ ...functions[0], definition: changedDefinition, definition_md5: crypto.createHash("md5").update(changedDefinition).digest("hex") }, ...functions.slice(1)]
    }));
    expect(verify().status).not.toBe(0);

    fs.writeFileSync(postflightPath, JSON.stringify(clean));
    for (const artifact of ["staging-reinstall.sql", "staging-reinstall-rollback.sql", "staging-postflight-readonly.sql"]) {
      const artifactPath = path.join(outputDir, artifact);
      const bytes = fs.readFileSync(artifactPath);
      fs.appendFileSync(artifactPath, "\n-- tamper");
      expect(verify().status, `${artifact} tamper unexpectedly passed`).not.toBe(0);
      fs.writeFileSync(artifactPath, bytes);
    }
    const trackedPath = path.join(root, "package.json");
    const trackedBytes = fs.readFileSync(trackedPath);
    fs.appendFileSync(trackedPath, " ");
    expect(verify().status).not.toBe(0);
    fs.writeFileSync(trackedPath, trackedBytes);
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
    fs.writeFileSync(postflightPath, JSON.stringify(clean));
    const accepted = verify();
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(fs.existsSync(path.join(outputDir, "postflight-verification.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "staging-rollback-verified.sql"))).toBe(true);
  }, 90_000);

  it("binds a rollback-only transactional proof to the verified installed function definitions", () => {
    const root = process.cwd();
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "normops-proof-"));
    cleanupPaths.push(fixtureDir);
    const preflightFunctions = ["hop_session", "reject_session", "reject_customer_tab"].map((name) => {
      const definition = `CREATE OR REPLACE FUNCTION public.${name}(payload jsonb) RETURNS jsonb LANGUAGE plpgsql AS $function$ BEGIN RETURN '{}'::jsonb; END $function$`;
      return { name, definition, definition_md5: crypto.createHash("md5").update(definition).digest("hex") };
    });
    const preflightPath = path.join(fixtureDir, "preflight.json");
    const identityNonce = "12345678-1234-4123-8123-123456789abc";
    const preflightText = JSON.stringify({
      environment_identity: { environment: "staging", project_ref: "tkbdyzxwwbhkpztgjjxh", identity_nonce: identityNonce },
      functions: preflightFunctions
    });
    fs.writeFileSync(preflightPath, preflightText);
    const preflightSha = crypto.createHash("sha256").update(preflightText).digest("hex");
    const dbManifestPath = path.join(fixtureDir, "manifest.json");
    const dbManifest = {
      runId: "normops-20260912-2200-install-fixture",
      target: { projectRef: "tkbdyzxwwbhkpztgjjxh", systemIdentifier: "7623125441096521075", organizationId: "org-primary" },
      environmentIdentity: { environment: "staging", project_ref: "tkbdyzxwwbhkpztgjjxh", identity_nonce: identityNonce },
      preflight: { path: preflightPath, sha256: preflightSha }
    };
    const dbManifestText = JSON.stringify(dbManifest);
    fs.writeFileSync(dbManifestPath, dbManifestText);
    const dbManifestSha = crypto.createHash("sha256").update(dbManifestText).digest("hex");
    const definitionHashes = Object.fromEntries(
      ["hop_session_v2", "reject_session_v2", "reject_customer_tab_v2", "get_operational_performance_dataset_identity", "start_session", "open_customer_tab", "link_customer_tab_continuation"]
        .map((name) => [name, crypto.createHash("md5").update(name).digest("hex")])
    );
    const verificationPath = path.join(fixtureDir, "verification.json");
    const verification = {
      runId: dbManifest.runId,
      projectRef: "tkbdyzxwwbhkpztgjjxh",
      manifestSha256: dbManifestSha,
      appStateUnchanged: true,
      incompleteMutations: 0,
      installedFunctionDefinitionMd5: definitionHashes
    };
    const verificationText = JSON.stringify(verification);
    fs.writeFileSync(verificationPath, verificationText);
    const verificationSha = crypto.createHash("sha256").update(verificationText).digest("hex");
    const proofRunId = `normops-20260912-2201-db-proof-${crypto.randomBytes(4).toString("hex")}`;
    const proofPath = path.join(root, "test-artifacts", "sql", `${proofRunId}-operational-v2-transactional-proof.sql`);
    const proofManifestPath = path.join(root, "test-artifacts", "sql", `${proofRunId}-operational-v2-transactional-proof-manifest.json`);
    cleanupPaths.push(proofPath, proofManifestPath);

    const result = spawnSync(process.execPath, [
      path.join(root, "scripts", "build-operational-v2-transactional-proof.mjs"),
      `--run-id=${proofRunId}`,
      `--db-manifest=${dbManifestPath}`,
      `--db-manifest-sha256=${dbManifestSha}`,
      `--postflight-verification=${verificationPath}`,
      `--postflight-verification-sha256=${verificationSha}`
    ], { cwd: root, encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    const proof = fs.readFileSync(proofPath, "utf8");
    expect(proof).toContain("installed function drift");
    expect(proof).toContain("do $$\ndeclare function_name");
    expect(proof).toContain("end $$;");
    expect(proof).not.toContain("do $\ndeclare function_name");
    expect(proof).not.toContain("end $;");
    expect(proof).toContain(`identity_nonce = '${identityNonce}'::uuid`);
    for (const entry of preflightFunctions) expect(proof).toContain(entry.definition_md5);
    expect(proof).not.toContain("__INSTALLED_FUNCTION_GUARDS__");
    expect(proof).not.toContain("__IDENTITY_NONCE__");
    expect(proof.trimEnd().endsWith("rollback;")).toBe(true);
    expect(proof).toContain(`'audit_log_id', '${proofRunId}-audit-hop')));`);
    const proofManifest = JSON.parse(fs.readFileSync(proofManifestPath, "utf8"));
    expect(proofManifest.target.identityNonce).toBe(identityNonce);
  });

  it("binds generated proof post-rollback SQL to the exact staging identity nonce", () => {
    const root = process.cwd();
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "normops-proof-postrollback-"));
    cleanupPaths.push(fixtureDir);
    const identityNonce = "12345678-1234-4123-8123-123456789abc";
    const proofRunId = `normops-20260912-2202-db-proof-${crypto.randomBytes(4).toString("hex")}`;
    const installLineagePath = path.join(fixtureDir, "install-manifest.json");
    const verificationLineagePath = path.join(fixtureDir, "postflight-verification.json");
    const installLineageText = JSON.stringify({ runId: "install-fixture" });
    const verificationLineageText = JSON.stringify({ runId: "verification-fixture" });
    fs.writeFileSync(installLineagePath, installLineageText);
    fs.writeFileSync(verificationLineagePath, verificationLineageText);
    const proofManifestPath = path.join(fixtureDir, "proof-manifest.json");
    const proofManifestText = JSON.stringify({
      runId: proofRunId,
      target: { environment: "staging", projectRef: "tkbdyzxwwbhkpztgjjxh", organizationId: "org-primary", identityNonce },
      rollbackOnly: true,
      installManifest: {
        path: installLineagePath,
        sha256: crypto.createHash("sha256").update(installLineageText).digest("hex")
      },
      postflightVerification: {
        path: verificationLineagePath,
        sha256: crypto.createHash("sha256").update(verificationLineageText).digest("hex")
      }
    });
    fs.writeFileSync(proofManifestPath, proofManifestText);
    const proofManifestSha = crypto.createHash("sha256").update(proofManifestText).digest("hex");

    const result = spawnSync(process.execPath, [
      path.join(root, "scripts", "build-operational-v2-proof-postrollback.mjs"),
      `--proof-manifest=${proofManifestPath}`,
      `--proof-manifest-sha256=${proofManifestSha}`
    ], { cwd: root, encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    const generatedSql = fs.readFileSync(path.join(fixtureDir, "proof-postrollback-readonly.sql"), "utf8");
    expect(generatedSql).toContain(`identity_nonce='${identityNonce}'::uuid`);
    expect(generatedSql).toContain(`'identity_nonce','${identityNonce}'`);
    expect(generatedSql).not.toContain("__IDENTITY_NONCE__");
    const generatedManifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, "proof-postrollback-manifest.json"), "utf8"));
    expect(generatedManifest.target.identityNonce).toBe(identityNonce);
  });
});
