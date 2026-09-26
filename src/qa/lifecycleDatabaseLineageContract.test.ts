import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CANDIDATE = [
  "hop_session_v2", "reject_session_v2", "reject_customer_tab_v2", "start_session",
  "open_customer_tab", "link_customer_tab_continuation", "get_operational_performance_dataset_identity"
] as const;
const LEGACY = ["hop_session", "reject_session", "reject_customer_tab"] as const;
const SOURCES: Record<string, string> = {
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
const INSTALL_SOURCES = [
  "supabase/operational-lifecycle-v2.sql",
  "supabase/operational-lifecycle-v2-staging-preflight-readonly.sql",
  "supabase/operational-lifecycle-v2-staging-postflight-readonly.sql"
] as const;
const SOURCE_DIRS = ["scripts", "src", "supabase", "tests"] as const;
const ROOT_SOURCE = /^(?:package(?:-lock)?\.json|(?:playwright|vite|vitest|eslint|tsconfig)[^/]*\.(?:ts|js|mjs|json)|index\.html)$/;
const cleanup: string[] = [];

const sha256 = (value: crypto.BinaryLike) => crypto.createHash("sha256").update(value).digest("hex");
const md5 = (value: crypto.BinaryLike) => crypto.createHash("md5").update(value).digest("hex");

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }
  });
  if (result.status !== 0) throw new Error(`Git failed: ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function gitBlob(root: string, commit: string, file: string) {
  const result = spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "show", `${commit}:${file}`], {
    cwd: root, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }
  });
  if (result.status !== 0 || result.error) throw new Error(`Git blob failed: ${file}`);
  return result.stdout;
}

function runNode(root: string, script: string, args: string[]) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root, encoding: "utf8", windowsHide: true
  });
}

function callModule(root: string, expression: string) {
  const moduleUrl = pathToFileURL(path.join(root, "scripts", "lifecycle-database-lineage.mjs")).href;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import fs from "node:fs";
    import { loadLifecycleDatabaseLineage } from ${JSON.stringify(moduleUrl)};
    ${expression}
  `], { cwd: root, encoding: "utf8", windowsHide: true });
}

function writeText(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { path: file, sha256: sha256(text) };
}

function writeJson(file: string, value: unknown) {
  return writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sourceDefinition(root: string, name: string) {
  const source = fs.readFileSync(path.join(root, SOURCES[name]), "utf8");
  const definition = source.match(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)[\\s\\S]*?\\bas\\s+\\$\\$[\\s\\S]*?\\$\\$;`, "i"))?.[0];
  if (!definition) throw new Error(`Missing definition: ${name}`);
  return definition;
}

function sourceBody(root: string, name: string) {
  const definition = sourceDefinition(root, name);
  const body = definition.match(/\bas\s+\$\$([\s\S]*?)\$\$;/i)?.[1];
  if (!body) throw new Error(`Missing body: ${name}`);
  return body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

function functionAcl(serviceRole: boolean) {
  return ["authenticated", "postgres", ...(serviceRole ? ["service_role"] : [])].map((grantee) => ({
    grantor: "postgres", grantee, privilege_type: "EXECUTE", is_grantable: false
  }));
}

function functionEvidence(root: string, name: string, serviceRole: boolean) {
  const definition = sourceDefinition(root, name);
  return {
    name, definition, definition_md5: md5(definition), owner: "postgres", security_definer: true,
    volatility: name === "get_operational_performance_dataset_identity" ? "s" : "v",
    config: ["search_path=public"], language: "plpgsql", strict: false, parallel: "u", leakproof: false,
    cost: 100, rows: 0, returns_set: false, result: "jsonb", kind: "f", support: 0,
    acl_detail: functionAcl(serviceRole), public_execute: false, anon_execute: false,
    authenticated_execute: true, service_role_execute: serviceRole
  };
}

function aclEvidence(root: string, after = false) {
  const privileges = ["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"];
  const tableAcl = ["postgres", ...(after ? [] : ["service_role"])].flatMap((grantee) => privileges.map((privilege_type) => ({
    grantor: "postgres", grantee, privilege_type, is_grantable: false
  })));
  const appState = {
    version: 735, bytes: 1045421, md5: "c2f8145558f9f85a6513caa71c19b54e",
    updated_at: "2026-09-12T22:20:24.748007+00:00", updated_by: "61cc2f83-69d1-46ab-9d89-9df7f7b1e497"
  };
  return {
    captured_at_utc: "2026-09-27T00:00:00.000000+00:00", expected_project_ref: "tkbdyzxwwbhkpztgjjxh",
    system_identifier: "7623125441096521075", database: "postgres", server_version_num: 170006,
    environment_identity: { environment: "staging", project_ref: "tkbdyzxwwbhkpztgjjxh", identity_nonce: "f9bc0aed-b6c4-410f-ba2a-572522d03869" },
    organization_id: "org-primary", organization_exists: true, open_sessions: 0, open_customer_tabs: 0,
    recoverable_hopped_sessions: 0, processing_financial_mutations: 0, processing_operational_mutations: 0,
    operational_mutations_table_exists: true, operational_mutations_rls: true, operational_mutations_force_rls: false,
    operational_mutations_owner: "postgres", operational_mutations_policies: [], operational_mutations_acl: tableAcl,
    app_state: appState,
    functions: [...LEGACY.map((name) => functionEvidence(root, name, true)),
      ...CANDIDATE.map((name) => functionEvidence(root, name, !after))]
  };
}

function createGitRoots() {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), "normops-lifecycle-lineage-"));
  cleanup.push(container);
  const sourceRoot = process.cwd();
  const root = path.join(container, "current");
  fs.mkdirSync(root);
  for (const dir of SOURCE_DIRS) fs.cpSync(path.join(sourceRoot, dir), path.join(root, dir), { recursive: true });
  for (const name of fs.readdirSync(sourceRoot)) {
    if (ROOT_SOURCE.test(name) || [".gitignore", ".gitattributes"].includes(name)) {
      const source = path.join(sourceRoot, name);
      if (fs.existsSync(source) && fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(root, name));
    }
  }
  git(root, "init");
  git(root, "config", "user.name", "Lifecycle lineage QA");
  git(root, "config", "user.email", "qa@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  fs.appendFileSync(path.join(root, ".git", "info", "exclude"), "\n/test-artifacts/\n");
  git(root, "add", "--all");
  git(root, "commit", "-m", "Historical installation source");
  const installCommit = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "scripts", "lineage-acl-marker.txt"), "acl source identity\n");
  git(root, "add", "scripts/lineage-acl-marker.txt");
  git(root, "commit", "-m", "ACL source identity");
  const aclCommit = git(root, "rev-parse", "HEAD");
  const historicalRoot = path.join(container, "historical-acl");
  const clone = spawnSync("git", ["clone", "--no-hardlinks", root, historicalRoot], { encoding: "utf8", windowsHide: true });
  if (clone.status !== 0) throw new Error(clone.stderr);
  git(historicalRoot, "checkout", aclCommit);
  fs.appendFileSync(path.join(historicalRoot, ".git", "info", "exclude"), "\n/test-artifacts/\n");
  fs.writeFileSync(path.join(root, "scripts", "lineage-current-marker.txt"), "current candidate identity\n");
  git(root, "add", "scripts/lineage-current-marker.txt");
  git(root, "commit", "-m", "Current candidate identity");
  const currentCommit = git(root, "rev-parse", "HEAD");
  expect(new Set([installCommit, aclCommit, currentCommit]).size).toBe(3);
  return { container, root, historicalRoot, installCommit, aclCommit, currentCommit };
}

function packageIdentity(root: string, commit: string) {
  const moduleUrl = pathToFileURL(path.join(root, "scripts", "lifecycle-install-contract.mjs")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `import { packageIdentity } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(packageIdentity(${JSON.stringify(root)},${JSON.stringify(commit)})));`], {
    cwd: root, encoding: "utf8", windowsHide: true
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { commit: string; sourceSha256: string };
}

function createFixture() {
  const roots = createGitRoots();
  const { root, historicalRoot, installCommit, aclCommit, currentCommit } = roots;
  const artifacts = path.join(root, "test-artifacts", "lineage-fixture");
  const installDirectory = path.join(artifacts, "install");
  const aclDirectory = path.join(historicalRoot, "test-artifacts", "operational-lifecycle-v2", "normops-20260927-0100-acl-fixture");
  fs.mkdirSync(installDirectory, { recursive: true });

  const before = aclEvidence(root, false);
  const after = aclEvidence(root, true);
  const preflight = writeJson(path.join(installDirectory, "preflight.json"), { evidence: before });
  const installArtifact = writeText(path.join(installDirectory, "install.sql"), "begin;\n-- synthetic guarded install\ncommit;\n");
  const rollbackArtifact = writeText(path.join(installDirectory, "rollback.sql"), "begin;\n-- synthetic guarded rollback\ncommit;\n");
  const runId = "normops-20260913-1229-reinstall-fixture";
  const expectedFunctionBodies = Object.fromEntries(CANDIDATE.map((name) => [name, { sha256: sha256(sourceBody(root, name)) }]));
  const sources = Object.fromEntries(INSTALL_SOURCES.map((name) => [name, sha256(gitBlob(root, installCommit, name))]));
  const installManifestValue = {
    runId, operation: "staging-v2-function-reinstall",
    target: { projectRef: "tkbdyzxwwbhkpztgjjxh", systemIdentifier: "7623125441096521075", organizationId: "org-primary" },
    environmentIdentity: before.environment_identity, preflight,
    sources, expectedFunctionBodies,
    artifacts: {
      install: { path: installArtifact.path, sha256: installArtifact.sha256, bytes: Buffer.byteLength(fs.readFileSync(installArtifact.path)) },
      rollback: { path: rollbackArtifact.path, sha256: rollbackArtifact.sha256, bytes: Buffer.byteLength(fs.readFileSync(rollbackArtifact.path)) }
    }
  };
  const installManifest = writeJson(path.join(installDirectory, "manifest.json"), installManifestValue);
  const oldPostValue = {
    expected_project_ref: "tkbdyzxwwbhkpztgjjxh", system_identifier: "7623125441096521075",
    organization_id: "org-primary", environment_identity: before.environment_identity,
    app_state: before.app_state,
    functions: after.functions.filter((entry) => CANDIDATE.includes(entry.name as typeof CANDIDATE[number]))
  };
  const installPostflight = writeJson(path.join(installDirectory, "postflight.json"), { evidence: oldPostValue });
  const installVerification = writeJson(path.join(installDirectory, "postflight-verification.json"), {
    runId, projectRef: "tkbdyzxwwbhkpztgjjxh", organizationId: "org-primary", manifestSha256: installManifest.sha256,
    preflightSha256: preflight.sha256, postflightSha256: installPostflight.sha256, appStateUnchanged: true,
    appState: before.app_state, incompleteMutations: 0,
    installedFunctionDefinitionMd5: Object.fromEntries(oldPostValue.functions.map((entry) => [entry.name, entry.definition_md5])),
    verifiedRollback: { path: rollbackArtifact.path, sha256: rollbackArtifact.sha256,
      bytes: Buffer.byteLength(fs.readFileSync(rollbackArtifact.path)) }
  });
  const installResult = writeJson(path.join(installDirectory, "install-result.json"), {
    run_id: runId, environment: "staging", project_ref: "tkbdyzxwwbhkpztgjjxh", candidate_commit: installCommit,
    install_sha256: installArtifact.sha256, execution_count: 1, status: "success", retry_performed: false
  });

  const aclPreflight = writeJson(path.join(historicalRoot, "test-artifacts", "acl-preflight.json"), before);
  const buildAcl = runNode(historicalRoot, "scripts/build-operational-lifecycle-v2-staging-acl-convergence.mjs", [
    "--run-id=normops-20260927-0100-acl-fixture", `--expected-commit=${aclCommit}`,
    `--preflight=${path.relative(historicalRoot, aclPreflight.path)}`
  ]);
  expect(buildAcl.status, buildAcl.stderr).toBe(0);
  const aclManifestPath = path.join(aclDirectory, "manifest.json");
  const aclManifestValue = JSON.parse(fs.readFileSync(aclManifestPath, "utf8"));
  const aclPostValue = { ...after, package_identity: {
    runId: aclManifestValue.runId, ...aclManifestValue.codeIdentity, preflightSha256: aclManifestValue.preflight.sha256
  } };
  const aclPostflight = writeJson(path.join(aclDirectory, "postflight-result.json"), aclPostValue);
  const verifyAcl = runNode(historicalRoot, "scripts/verify-operational-lifecycle-v2-staging-acl-convergence.mjs", [
    `--manifest=${aclManifestPath}`, `--evidence=${aclPostflight.path}`, "--phase=after"
  ]);
  expect(verifyAcl.status, verifyAcl.stderr).toBe(0);
  const aclVerification = writeJson(path.join(aclDirectory, "verification-after.json"), JSON.parse(verifyAcl.stdout));
  const aclManifest = { path: aclManifestPath, sha256: sha256(fs.readFileSync(aclManifestPath)) };

  const descriptorValue = {
    kind: "lifecycle-acl-supplement-v1", codeIdentity: packageIdentity(root, currentCommit),
    historicalSourceCommit: installCommit, historicalRoot,
    installManifest, installVerification, installPostflight, installResult,
    aclManifest, aclPostflight, aclVerification
  };
  const descriptor = writeJson(path.join(artifacts, "database-lineage.json"), descriptorValue);
  expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
  expect(git(historicalRoot, "status", "--porcelain", "--untracked-files=all")).toBe("");
  return { ...roots, artifacts, installDirectory, aclDirectory, descriptor, descriptorValue,
    installManifest, installVerification, installPostflight, installResult, aclManifest, aclPostflight, aclVerification };
}

function loadExpression(
  fixture: ReturnType<typeof createFixture>,
  descriptor = fixture.descriptor,
  selectedManifest = fixture.installManifest,
  selectedVerification = fixture.installVerification
) {
  return `const value=loadLifecycleDatabaseLineage({root:${JSON.stringify(fixture.root)},descriptorPath:${JSON.stringify(descriptor.path)},descriptorSha256:${JSON.stringify(descriptor.sha256)},installManifestPath:${JSON.stringify(selectedManifest.path)},installManifestSha256:${JSON.stringify(selectedManifest.sha256)},verificationPath:${JSON.stringify(selectedVerification.path)},verificationSha256:${JSON.stringify(selectedVerification.sha256)}}); console.log(JSON.stringify({path:value.path,sha256:value.sha256,guard:value.securityGuardSql,postflight:value.postflight}));`;
}

afterEach(() => {
  const temp = path.resolve(os.tmpdir());
  for (const entry of cleanup.reverse()) {
    const resolved = path.resolve(entry);
    if (!resolved.startsWith(`${temp}${path.sep}`) || !path.basename(resolved).startsWith("normops-lifecycle-lineage-")) {
      throw new Error(`Refusing unsafe lineage cleanup: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  cleanup.length = 0;
});

describe("lifecycle database supplemental lineage", () => {
  it("binds distinct install, ACL and current identities with an exact security guard", () => {
    const fixture = createFixture();
    const loaded = callModule(fixture.root, loadExpression(fixture));
    expect(loaded.status, loaded.stderr).toBe(0);
    const result = JSON.parse(loaded.stdout) as { path: string; sha256: string; guard: string; postflight: Record<string, unknown> };
    expect(result.path).toBe(fixture.descriptor.path);
    expect(result.sha256).toBe(fixture.descriptor.sha256);
    expect(result.postflight.app_state).toEqual((aclEvidence(fixture.root, true) as Record<string, unknown>).app_state);
    for (const name of [...LEGACY, ...CANDIDATE]) {
      expect(result.guard).toContain(`public.${name}(jsonb)`);
      expect(result.guard).toContain(`ACL lineage security drift: ${name}`);
    }
    expect((result.guard.match(/ACL lineage security drift:/g) ?? [])).toHaveLength(10);
    expect(result.guard).toContain("operational mutation table security drift");
    expect(result.guard).toContain("server version drift");
    expect(fixture.installCommit).not.toBe(fixture.aclCommit);
    expect(fixture.aclCommit).not.toBe(fixture.currentCommit);
  }, 60_000);

  it("fails closed on artifact, receipt, source, continuity and Git identity drift", () => {
    const fixture = createFixture();
    const baseline = callModule(fixture.root, loadExpression(fixture));
    expect(baseline.status, baseline.stderr).toBe(0);

    const variants: Array<[string, (value: Record<string, unknown>) => void]> = [
      ["kind", (value) => { value.kind = "unknown"; }],
      ["current-source", (value) => { (value.codeIdentity as Record<string, unknown>).sourceSha256 = "0".repeat(64); }],
      ["historical-commit", (value) => { value.historicalSourceCommit = "0".repeat(40); }],
      ["install-hash", (value) => { (value.installManifest as Record<string, unknown>).sha256 = "0".repeat(64); }],
      ["verification-hash", (value) => { (value.installVerification as Record<string, unknown>).sha256 = "0".repeat(64); }],
      ["postflight-hash", (value) => { (value.installPostflight as Record<string, unknown>).sha256 = "0".repeat(64); }],
      ["result-hash", (value) => { (value.installResult as Record<string, unknown>).sha256 = "0".repeat(64); }],
      ["acl-manifest-hash", (value) => { (value.aclManifest as Record<string, unknown>).sha256 = "0".repeat(64); }],
      ["acl-postflight-hash", (value) => { (value.aclPostflight as Record<string, unknown>).sha256 = "0".repeat(64); }],
      ["acl-verification-hash", (value) => { (value.aclVerification as Record<string, unknown>).sha256 = "0".repeat(64); }]
    ];
    for (const [name, mutate] of variants) {
      const value = structuredClone(fixture.descriptorValue) as Record<string, unknown>;
      mutate(value);
      const descriptor = writeJson(path.join(fixture.artifacts, `invalid-${name}.json`), value);
      const rejected = callModule(fixture.root, loadExpression(fixture, descriptor));
      expect(rejected.status, `${name} unexpectedly passed`).not.toBe(0);
    }

    const wrongResultValue = JSON.parse(fs.readFileSync(fixture.installResult.path, "utf8"));
    wrongResultValue.retry_performed = true;
    const wrongResult = writeJson(path.join(fixture.artifacts, "wrong-install-result.json"), wrongResultValue);
    const wrongResultDescriptorValue = structuredClone(fixture.descriptorValue) as Record<string, unknown>;
    wrongResultDescriptorValue.installResult = wrongResult;
    const wrongResultDescriptor = writeJson(path.join(fixture.artifacts, "wrong-install-result-descriptor.json"), wrongResultDescriptorValue);
    expect(callModule(fixture.root, loadExpression(fixture, wrongResultDescriptor)).status).not.toBe(0);

    const wrongReceiptValue = JSON.parse(fs.readFileSync(fixture.installVerification.path, "utf8"));
    wrongReceiptValue.appStateUnchanged = false;
    const wrongReceipt = writeJson(path.join(fixture.artifacts, "wrong-install-verification.json"), wrongReceiptValue);
    const wrongReceiptDescriptorValue = structuredClone(fixture.descriptorValue) as Record<string, unknown>;
    wrongReceiptDescriptorValue.installVerification = wrongReceipt;
    const wrongReceiptDescriptor = writeJson(path.join(fixture.artifacts, "wrong-install-verification-descriptor.json"), wrongReceiptDescriptorValue);
    expect(callModule(fixture.root, loadExpression(fixture, wrongReceiptDescriptor, fixture.installManifest, wrongReceipt)).status).not.toBe(0);

    const candidatePostValue = JSON.parse(fs.readFileSync(fixture.installPostflight.path, "utf8"));
    const candidateEntry = candidatePostValue.evidence.functions.find((entry: Record<string, unknown>) => entry.name === "hop_session_v2");
    candidateEntry.definition = `${candidateEntry.definition}\n-- content-valid historical drift`;
    candidateEntry.definition_md5 = md5(candidateEntry.definition);
    const candidatePost = writeJson(path.join(fixture.artifacts, "wrong-candidate-postflight.json"), candidatePostValue);
    const candidateReceiptValue = JSON.parse(fs.readFileSync(fixture.installVerification.path, "utf8"));
    candidateReceiptValue.postflightSha256 = candidatePost.sha256;
    candidateReceiptValue.installedFunctionDefinitionMd5.hop_session_v2 = candidateEntry.definition_md5;
    const candidateReceipt = writeJson(path.join(fixture.artifacts, "wrong-candidate-verification.json"), candidateReceiptValue);
    const candidateDescriptorValue = structuredClone(fixture.descriptorValue) as Record<string, unknown>;
    candidateDescriptorValue.installPostflight = candidatePost;
    candidateDescriptorValue.installVerification = candidateReceipt;
    const candidateDescriptor = writeJson(path.join(fixture.artifacts, "wrong-candidate-descriptor.json"), candidateDescriptorValue);
    expect(callModule(fixture.root, loadExpression(fixture, candidateDescriptor, fixture.installManifest, candidateReceipt)).status).not.toBe(0);

    const legacyPreflightValue = JSON.parse(fs.readFileSync(
      (JSON.parse(fs.readFileSync(fixture.installManifest.path, "utf8"))).preflight.path, "utf8"
    ));
    const legacyEntry = legacyPreflightValue.evidence.functions.find((entry: Record<string, unknown>) => entry.name === "hop_session");
    legacyEntry.definition = `${legacyEntry.definition}\n-- content-valid legacy drift`;
    legacyEntry.definition_md5 = md5(legacyEntry.definition);
    const legacyPreflight = writeJson(path.join(fixture.artifacts, "wrong-legacy-preflight.json"), legacyPreflightValue);
    const legacyManifestValue = JSON.parse(fs.readFileSync(fixture.installManifest.path, "utf8"));
    legacyManifestValue.preflight = legacyPreflight;
    const legacyManifest = writeJson(path.join(fixture.artifacts, "wrong-legacy-manifest.json"), legacyManifestValue);
    const legacyReceiptValue = JSON.parse(fs.readFileSync(fixture.installVerification.path, "utf8"));
    legacyReceiptValue.preflightSha256 = legacyPreflight.sha256;
    legacyReceiptValue.manifestSha256 = legacyManifest.sha256;
    const legacyReceipt = writeJson(path.join(fixture.artifacts, "wrong-legacy-verification.json"), legacyReceiptValue);
    const legacyDescriptorValue = structuredClone(fixture.descriptorValue) as Record<string, unknown>;
    legacyDescriptorValue.installManifest = legacyManifest;
    legacyDescriptorValue.installVerification = legacyReceipt;
    const legacyDescriptor = writeJson(path.join(fixture.artifacts, "wrong-legacy-descriptor.json"), legacyDescriptorValue);
    expect(callModule(fixture.root, loadExpression(fixture, legacyDescriptor, legacyManifest, legacyReceipt)).status).not.toBe(0);

    const originalManifest = fs.readFileSync(fixture.installManifest.path, "utf8");
    const manifestValue = JSON.parse(originalManifest) as Record<string, unknown>;
    ((manifestValue.expectedFunctionBodies as Record<string, Record<string, unknown>>).hop_session_v2).sha256 = "0".repeat(64);
    fs.writeFileSync(fixture.installManifest.path, `${JSON.stringify(manifestValue, null, 2)}\n`);
    const installHash = sha256(fs.readFileSync(fixture.installManifest.path));
    const verificationValue = JSON.parse(fs.readFileSync(fixture.installVerification.path, "utf8"));
    verificationValue.manifestSha256 = installHash;
    fs.writeFileSync(fixture.installVerification.path, `${JSON.stringify(verificationValue, null, 2)}\n`);
    const value = structuredClone(fixture.descriptorValue) as Record<string, unknown>;
    (value.installManifest as Record<string, unknown>).sha256 = installHash;
    (value.installVerification as Record<string, unknown>).sha256 = sha256(fs.readFileSync(fixture.installVerification.path));
    const drift = writeJson(path.join(fixture.artifacts, "invalid-current-body.json"), value);
    expect(callModule(fixture.root, loadExpression(fixture, drift)).status).not.toBe(0);
    fs.writeFileSync(fixture.installManifest.path, originalManifest);

    fs.writeFileSync(path.join(fixture.root, "scripts", "uncommitted-lineage-drift.txt"), "dirty\n");
    expect(callModule(fixture.root, loadExpression(fixture)).status).not.toBe(0);
    fs.rmSync(path.join(fixture.root, "scripts", "uncommitted-lineage-drift.txt"));
    fs.writeFileSync(path.join(fixture.historicalRoot, "scripts", "uncommitted-acl-drift.txt"), "dirty\n");
    expect(callModule(fixture.root, loadExpression(fixture)).status).not.toBe(0);
  }, 90_000);

  it("builds one immutable descriptor and verification receipt through the CLI", () => {
    const fixture = createFixture();
    const output = path.join(fixture.artifacts, "cli-lineage.json");
    const args = [
      `--expected-commit=${fixture.currentCommit}`, `--historical-source-commit=${fixture.installCommit}`,
      `--historical-root=${fixture.historicalRoot}`, `--install-directory=${fixture.installDirectory}`,
      `--acl-directory=${fixture.aclDirectory}`, `--out=${output}`,
      `--install-manifest-sha256=${fixture.installManifest.sha256}`,
      `--install-verification-sha256=${fixture.installVerification.sha256}`,
      `--install-postflight-sha256=${fixture.installPostflight.sha256}`,
      `--install-result-sha256=${fixture.installResult.sha256}`,
      `--acl-manifest-sha256=${fixture.aclManifest.sha256}`,
      `--acl-postflight-sha256=${fixture.aclPostflight.sha256}`,
      `--acl-verification-sha256=${fixture.aclVerification.sha256}`
    ];
    const built = runNode(fixture.root, "scripts/build-lifecycle-database-lineage.mjs", args);
    expect(built.status, built.stderr).toBe(0);
    const receipt = JSON.parse(built.stdout);
    expect(receipt.status).toBe("passed");
    expect(receipt.codeIdentity.commit).toBe(fixture.currentCommit);
    expect(receipt.historicalSourceCommit).toBe(fixture.installCommit);
    expect(fs.existsSync(output)).toBe(true);
    expect(fs.existsSync(`${output}.verification.json`)).toBe(true);
    const repeated = runNode(fixture.root, "scripts/build-lifecycle-database-lineage.mjs", args);
    expect(repeated.status).not.toBe(0);
    expect(git(fixture.root, "status", "--porcelain", "--untracked-files=all")).toBe("");
  }, 60_000);
});
