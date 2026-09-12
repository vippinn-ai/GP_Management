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
