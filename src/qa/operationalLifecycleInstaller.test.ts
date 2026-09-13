import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cleanupPaths: string[] = [];

afterEach(() => {
  cleanupPaths.reverse().forEach((entry) => fs.rmSync(entry, { recursive: true, force: true }));
  cleanupPaths.length = 0;
});

describe("operational lifecycle staging installer", () => {
  it("requires bound preflight evidence and refuses to overwrite an immutable run", () => {
    const root = process.cwd();
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "normops-preflight-"));
    cleanupPaths.push(fixtureDir);
    const runId = `normops-20260912-2028-installer-${crypto.randomBytes(4).toString("hex")}`;
    const outputDir = path.join(root, "test-artifacts", "operational-lifecycle-v2", runId);
    cleanupPaths.push(outputDir);
    const functions = ["start_session", "open_customer_tab", "link_customer_tab_continuation"].map((name) => {
      const definition = `CREATE OR REPLACE FUNCTION public.${name}(payload jsonb) RETURNS jsonb LANGUAGE plpgsql AS $function$ BEGIN RETURN '{}'::jsonb; END $function$`;
      return {
        name,
        definition,
        definition_md5: crypto.createHash("md5").update(definition).digest("hex"),
        owner: "postgres",
        security_definer: false,
        volatility: "v",
        config: null,
        acl: ["postgres=X/postgres", "authenticated=X/postgres"],
        acl_detail: [
          { grantor: "postgres", grantee: "postgres", privilege_type: "EXECUTE", is_grantable: true },
          { grantor: "postgres", grantee: "authenticated", privilege_type: "EXECUTE", is_grantable: false }
        ],
        public_execute: false,
        anon_execute: false,
        authenticated_execute: true,
        service_role_execute: false
      };
    });
    const preflightPath = path.join(fixtureDir, "preflight.json");
    fs.writeFileSync(preflightPath, JSON.stringify({
      expected_project_ref: "tkbdyzxwwbhkpztgjjxh",
      system_identifier: "7623125441096521075",
      environment_identity: { environment: "staging", project_ref: "tkbdyzxwwbhkpztgjjxh", identity_nonce: "12345678-1234-4123-8123-123456789abc" },
      organization_id: "org-primary",
      organization_exists: true,
      open_sessions: 0,
      open_customer_tabs: 0,
      recoverable_hopped_sessions: 0,
      processing_financial_mutations: 0,
      processing_operational_mutations: 0,
      app_state: { version: 10, md5: "0123456789abcdef0123456789abcdef" },
      functions
    }));

    const command = [
      path.join(root, "scripts", "build-operational-lifecycle-v2-staging-install.mjs"),
      `--run-id=${runId}`,
      `--preflight=${preflightPath}`
    ];
    const first = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8" });
    expect(first.status, first.stderr).toBe(0);
    expect(fs.existsSync(path.join(outputDir, "staging-install.sql"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "staging-rollback.sql"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "manifest.json"))).toBe(true);
    const install = fs.readFileSync(path.join(outputDir, "staging-install.sql"), "utf8");
    expect(install).toContain("if to_regclass('public.operational_mutations') is not null then");
    expect(install).toContain("execute 'select count(*) from public.operational_mutations where status<>''committed''' into incomplete_operational");
    expect(install).not.toMatch(/to_regclass\('public\.operational_mutations'\) is not null and \(select count\(\*\) from public\.operational_mutations/i);
    const rollback = fs.readFileSync(path.join(outputDir, "staging-rollback.sql"), "utf8");
    expect(rollback).toContain("physical database identity drift");
    expect(rollback).toContain("database-derived staging identity drift");
    expect(rollback).toContain("rollback refused unexpected definition drift");
    expect(rollback).toContain("aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))");
    expect(rollback).toContain("revoke all privileges on function public.start_session(jsonb)");

    const second = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8" });
    expect(second.status).not.toBe(0);
  });

  it("builds an immutable narrow reinstall with exact v2 metadata guards and rollback", () => {
    const root = process.cwd();
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "normops-reinstall-"));
    cleanupPaths.push(fixtureDir);
    const runId = `normops-20260913-0700-reinstall-${crypto.randomBytes(4).toString("hex")}`;
    const outputDir = path.join(root, "test-artifacts", "operational-lifecycle-v2", runId);
    cleanupPaths.push(outputDir);
    const names = [
      "hop_session_v2", "reject_session_v2", "reject_customer_tab_v2",
      "get_operational_performance_dataset_identity", "start_session", "open_customer_tab", "link_customer_tab_continuation"
    ];
    const functions = names.map((name) => {
      const definition = `CREATE OR REPLACE FUNCTION public.${name}(payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$ BEGIN RETURN jsonb_build_object('old','${name}'); END $function$`;
      return {
        name,
        definition,
        definition_md5: crypto.createHash("md5").update(definition).digest("hex"),
        owner: "postgres",
        security_definer: true,
        volatility: "v",
        config: ["search_path=public"],
        acl_detail: [
          { grantor: "postgres", grantee: "postgres", privilege_type: "EXECUTE", is_grantable: true },
          { grantor: "postgres", grantee: "authenticated", privilege_type: "EXECUTE", is_grantable: false }
        ],
        public_execute: false,
        anon_execute: false,
        authenticated_execute: true
      };
    });
    const preflightPath = path.join(fixtureDir, "preflight.json");
    fs.writeFileSync(preflightPath, JSON.stringify({
      expected_project_ref: "tkbdyzxwwbhkpztgjjxh",
      system_identifier: "7623125441096521075",
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
    }));

    const command = [
      path.join(root, "scripts", "build-operational-lifecycle-v2-staging-reinstall.mjs"),
      `--run-id=${runId}`,
      `--preflight=${preflightPath}`
    ];
    const first = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8" });
    expect(first.status, first.stderr).toBe(0);
    const install = fs.readFileSync(path.join(outputDir, "staging-reinstall.sql"), "utf8");
    const rollback = fs.readFileSync(path.join(outputDir, "staging-reinstall-rollback.sql"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8"));
    for (const name of names.slice(0, 3)) {
      expect((install.match(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)`, "gi")) ?? [])).toHaveLength(1);
      expect(install).toContain(`deployed definition, owner, configuration, or ACL drift for ${name}`);
      expect(install).toContain(`installed definition, owner, configuration, or ACL mismatch for ${name}`);
      expect(rollback).toContain(`RETURN jsonb_build_object('old','${name}')`);
      expect(rollback).toContain(`alter function public.${name}(jsonb) owner to postgres`);
      expect(rollback).toContain(`revoke all privileges on function public.${name}(jsonb)`);
      expect(rollback).toContain(`grant execute on function public.${name}(jsonb) to "postgres" with grant option;`);
      expect(rollback).toContain(`grant execute on function public.${name}(jsonb) to "authenticated";`);
    }
    for (const name of names.slice(3)) {
      expect(install).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)`, "i"));
      expect(rollback).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)`, "i"));
      expect(rollback).not.toContain(`alter function public.${name}(jsonb)`);
      expect(rollback).not.toContain(`revoke all privileges on function public.${name}(jsonb)`);
      expect(install).toContain(`deployed definition, owner, configuration, or ACL drift for ${name}`);
      expect(install).toContain(`installed definition, owner, configuration, or ACL mismatch for ${name}`);
      expect(rollback).toContain(`deployed definition, owner, configuration, or ACL drift for ${name}`);
    }
    expect(install).toContain("md5(pg_get_functiondef(p.oid))");
    expect(rollback).toContain("md5(pg_get_functiondef(p.oid))");
    expect(install).toContain("actual_parallel is distinct from 'u'");
    expect(install).toContain("actual_support is distinct from 0::oid");
    expect(install).toContain(functions.find((entry) => entry.name === "start_session")!.definition_md5);
    expect(rollback).toContain(functions.find((entry) => entry.name === "start_session")!.definition_md5);
    expect(rollback).toContain("SET search_path TO 'public'");
    expect(install.match(/^begin;$/gim)).toHaveLength(1);
    expect(install.match(/^commit;$/gim)).toHaveLength(1);
    expect(rollback.match(/^begin;$/gim)).toHaveLength(1);
    expect(rollback.match(/^commit;$/gim)).toHaveLength(1);
    expect(install).toContain("app_state changed after approved preflight");
    expect(install).toContain("reinstall changed compatibility app_state");
    expect(install).toContain("staging has a recoverable unconsumed hopped session");
    expect(manifest.operation).toBe("staging-v2-function-reinstall");
    expect(manifest.patchedFunctions).toEqual(names.slice(0, 3));
    expect(Object.keys(manifest.expectedFunctionBodies).sort()).toEqual([...names].sort());
    expect(manifest.artifacts.install.sha256).toBe(crypto.createHash("sha256").update(install).digest("hex"));
    expect(manifest.artifacts.rollback.sha256).toBe(crypto.createHash("sha256").update(rollback).digest("hex"));

    const postflightFunctions = functions.map((entry) => {
      if (!names.slice(0, 3).includes(entry.name)) return { ...entry, anon_execute: false, authenticated_execute: true };
      const definition = install.match(new RegExp(
        `create or replace function public\\.${entry.name}\\(payload jsonb\\)[\\s\\S]*?\\n\\$\\$;`,
        "i"
      ))?.[0];
      expect(definition).toBeTruthy();
      return {
        ...entry,
        definition,
        definition_md5: crypto.createHash("md5").update(definition!).digest("hex"),
        security_definer: true,
        volatility: "v",
        config: ["search_path=public"],
        anon_execute: false,
        authenticated_execute: true
      };
    });
    const postflightPath = path.join(fixtureDir, "postflight.json");
    fs.writeFileSync(postflightPath, JSON.stringify({
      expected_project_ref: "tkbdyzxwwbhkpztgjjxh",
      system_identifier: "7623125441096521075",
      environment_identity: { environment: "staging", project_ref: "tkbdyzxwwbhkpztgjjxh", identity_nonce: "12345678-1234-4123-8123-123456789abc" },
      organization_id: "org-primary",
      app_state: {
        version: 10,
        bytes: 12345,
        md5: "0123456789abcdef0123456789abcdef",
        updated_at: "2026-09-13T01:00:00.000000+00:00",
        updated_by: "12345678-1234-4123-8123-123456789abc"
      },
      processing_financial_mutations: 0,
      processing_operational_mutations: 0,
      operational_mutations_rls: true,
      functions: postflightFunctions
    }));
    const verification = spawnSync(process.execPath, [
      path.join(root, "scripts", "verify-operational-lifecycle-v2-staging-postflight.mjs"),
      `--preflight=${preflightPath}`,
      `--postflight=${postflightPath}`,
      `--manifest=${path.join(outputDir, "manifest.json")}`
    ], { cwd: root, encoding: "utf8" });
    expect(verification.status, verification.stderr).toBe(0);
    expect(fs.existsSync(path.join(outputDir, "postflight-verification.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "staging-rollback-verified.sql"))).toBe(true);

    const second = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8" });
    expect(second.status).not.toBe(0);
  });

  it("refuses incomplete or inconsistent deployed v2 reinstall evidence", () => {
    const root = process.cwd();
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "normops-reinstall-refuse-"));
    cleanupPaths.push(fixtureDir);
    const names = [
      "hop_session_v2", "reject_session_v2", "reject_customer_tab_v2",
      "get_operational_performance_dataset_identity", "start_session", "open_customer_tab", "link_customer_tab_continuation"
    ];
    const baseFunctions = names.map((name) => {
      const definition = `CREATE OR REPLACE FUNCTION public.${name}(payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$ BEGIN RETURN '{}'::jsonb; END $function$`;
      return {
        name,
        definition,
        definition_md5: crypto.createHash("md5").update(definition).digest("hex"),
        owner: "postgres",
        security_definer: true,
        volatility: "v",
        config: ["search_path=public"],
        acl_detail: [{ grantor: "postgres", grantee: "authenticated", privilege_type: "EXECUTE", is_grantable: false }],
        public_execute: false,
        anon_execute: false,
        authenticated_execute: true
      };
    });
    const baseEvidence = {
      expected_project_ref: "tkbdyzxwwbhkpztgjjxh",
      system_identifier: "7623125441096521075",
      environment_identity: { environment: "staging", project_ref: "tkbdyzxwwbhkpztgjjxh", identity_nonce: "12345678-1234-4123-8123-123456789abc" },
      organization_id: "org-primary",
      organization_exists: true,
      open_sessions: 0,
      open_customer_tabs: 0,
      recoverable_hopped_sessions: 0,
      processing_financial_mutations: 0,
      processing_operational_mutations: 0,
      app_state: { version: 10, bytes: 12345, md5: "0123456789abcdef0123456789abcdef", updated_at: "2026-09-13T01:00:00+00:00", updated_by: "12345678-1234-4123-8123-123456789abc" }
    };
    const cases = [
      { slug: "missing", functions: baseFunctions.filter((entry) => entry.name !== "reject_session_v2"), evidence: {}, error: "Preflight omitted deployed reject_session_v2" },
      { slug: "hash", functions: baseFunctions.map((entry) => entry.name === "hop_session_v2" ? { ...entry, definition_md5: "bad" } : entry), evidence: {}, error: "Preflight definition hash mismatch for hop_session_v2" },
      { slug: "acl", functions: baseFunctions.map((entry) => entry.name === "reject_customer_tab_v2" ? { ...entry, acl_detail: [{ ...entry.acl_detail[0], grantor: "other_role" }] } : entry), evidence: {}, error: "Unsupported non-owner ACL grantor on reject_customer_tab_v2" },
      { slug: "public", functions: baseFunctions.map((entry) => entry.name === "hop_session_v2" ? { ...entry, public_execute: true } : entry), evidence: {}, error: "Unsafe deployed execution privileges on hop_session_v2" },
      { slug: "grantee", functions: baseFunctions.map((entry) => entry.name === "reject_session_v2" ? { ...entry, acl_detail: [{ ...entry.acl_detail[0], grantee: "unexpected_role" }] } : entry), evidence: {}, error: "Unexpected deployed execution grantee on reject_session_v2" },
      { slug: "sessions", functions: baseFunctions, evidence: { open_sessions: 1 }, error: "Staging operational floor is not clean" },
      { slug: "tabs", functions: baseFunctions, evidence: { open_customer_tabs: 1 }, error: "Staging operational floor is not clean" },
      { slug: "hopped", functions: baseFunctions, evidence: { recoverable_hopped_sessions: 1 }, error: "Staging has an unconsumed recoverable hopped session" },
      { slug: "financial", functions: baseFunctions, evidence: { processing_financial_mutations: 1 }, error: "Staging has an incomplete mutation" },
      { slug: "dirty", functions: baseFunctions, evidence: { processing_operational_mutations: 1 }, error: "Staging has an incomplete mutation" },
      { slug: "appstate-version", functions: baseFunctions, evidence: { app_state: { ...baseEvidence.app_state, version: undefined } }, error: "Preflight app_state version is missing" },
      { slug: "appstate-bytes", functions: baseFunctions, evidence: { app_state: { ...baseEvidence.app_state, bytes: undefined } }, error: "Preflight app_state bytes is missing" },
      { slug: "appstate-md5", functions: baseFunctions, evidence: { app_state: { ...baseEvidence.app_state, md5: undefined } }, error: "Preflight app_state md5 is missing" },
      { slug: "appstate-updated-at", functions: baseFunctions, evidence: { app_state: { ...baseEvidence.app_state, updated_at: undefined } }, error: "Preflight app_state updated_at is missing" },
      { slug: "appstate-updated-by", functions: baseFunctions, evidence: { app_state: { ...baseEvidence.app_state, updated_by: undefined } }, error: "Preflight app_state updated_by is missing" }
    ];
    for (const testCase of cases) {
      const runId = `normops-20260913-0701-reinstall-${testCase.slug}-${crypto.randomBytes(3).toString("hex")}`;
      const outputDir = path.join(root, "test-artifacts", "operational-lifecycle-v2", runId);
      cleanupPaths.push(outputDir);
      const preflightPath = path.join(fixtureDir, `${testCase.slug}.json`);
      fs.writeFileSync(preflightPath, JSON.stringify({ ...baseEvidence, ...testCase.evidence, functions: testCase.functions }));
      const result = spawnSync(process.execPath, [
        path.join(root, "scripts", "build-operational-lifecycle-v2-staging-reinstall.mjs"),
        `--run-id=${runId}`,
        `--preflight=${preflightPath}`
      ], { cwd: root, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(testCase.error);
      expect(fs.existsSync(outputDir)).toBe(false);
    }
  }, 20_000);

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
