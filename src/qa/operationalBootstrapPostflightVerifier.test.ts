import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const created: string[] = [];
const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const md5 = (value: string | Buffer) => crypto.createHash("md5").update(value).digest("hex");

afterEach(() => {
  for (const target of created.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-verifier-"));
  created.push(dir);
  const write = (name: string, value: string) => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, value);
    return { path: target, sha256: sha256(value) };
  };
  const source = "create or replace function public.load_operational_bootstrap_v2() returns jsonb language plpgsql as $$\nbegin return '{}'::jsonb; end;\n$$;\n";
  const reviewedSource = write("source.sql", source);
  const reviewedSql = { ...reviewedSource, sha256: sha256(source.trim()), bodyMd5: md5("begin return '{}'::jsonb; end;") };
  const install = write("install.sql", "begin; select 1; commit;\n");
  const postflightSql = write("postflight.sql", "begin read only; select 1; rollback;\n");
  const rollback = write("rollback.sql", "begin; select 1; commit;\n");
  const appState = {
    version: 44,
    bytes: 4_886_227,
    md5: "0123456789abcdef0123456789abcdef",
    updated_at: "2026-09-14T00:00:00+00:00",
    updated_by: "11111111-2222-4333-8444-555555555555"
  };
  const helper = {
    definition_md5: "11111111111111111111111111111111",
    body_md5: "22222222222222222222222222222222",
    owner_name: "postgres",
    security_definer: true,
    volatility: "v",
    config: ["search_path=public"],
    acl_detail: [
      { grantor: "postgres", grantee: "postgres", privilege_type: "EXECUTE", is_grantable: false },
      { grantor: "postgres", grantee: "authenticated", privilege_type: "EXECUTE", is_grantable: false }
    ]
  };
  const policies = [{ name: "normalized_org_access", permissive: "PERMISSIVE", roles: ["authenticated"], command: "ALL", using: "tenant", check: "tenant" }];
  const preflight = {
    expected_project_ref: "tkbdyzxwwbhkpztgjjxh",
    system_identifier: "7623125441096521075",
    environment_identity: { environment: "staging", project_ref: "tkbdyzxwwbhkpztgjjxh", identity_nonce: "11111111-2222-4333-8444-555555555555" },
    organization_id: "org-primary",
    installer_role: "postgres",
    target_function: { owner_name: "postgres" },
    open_sessions: 0,
    open_customer_tabs: 0,
    processing_financial_mutations: 0,
    processing_operational_mutations: 0,
    app_state: appState,
    realtime_security: { rls_enabled: true, published: true, policies, authenticated_role_memberships: ["authenticated"], access_helper: helper }
  };
  const preflightPath = path.join(dir, "preflight.json");
  fs.writeFileSync(preflightPath, `${JSON.stringify(preflight)}\n`);
  const postflight = {
    project_ref: "tkbdyzxwwbhkpztgjjxh",
    system_identifier: "7623125441096521075",
    payload: {
      bytes: 133_365,
      status: "active",
      organization_id: "org-primary",
      contract_version: 1,
      app_state_version: 44,
      collection_counts: { inventory_items: 168, sale_variants: 56 }
    },
    function: {
      body_md5: reviewedSql.bodyMd5,
      owner: "postgres",
      security_definer: true,
      volatility: "s",
      config: ["search_path=pg_catalog", "statement_timeout=5s"],
      authenticated_execute: true,
      anon_execute: false,
      public_execute: false,
      service_role_execute: false,
      acl_detail: [
        { grantor: "postgres", grantee: "postgres", privilege_type: "EXECUTE", is_grantable: false },
        { grantor: "postgres", grantee: "authenticated", privilege_type: "EXECUTE", is_grantable: false }
      ]
    },
    app_state: appState,
    realtime_security: { rls_enabled: true, published: true, policies, authenticated_role_memberships: ["authenticated"], access_helper: helper }
  };
  const postflightPath = path.join(dir, "postflight-result.json");
  fs.writeFileSync(postflightPath, `${JSON.stringify(postflight)}\n`);
  const manifest = {
    runId: "normops-20260914-0840-bootstrap-verify",
    environment: "staging",
    projectRef: "tkbdyzxwwbhkpztgjjxh",
    systemIdentifier: "7623125441096521075",
    sourceCommit: "a".repeat(40),
    preflight: { path: preflightPath, sha256: sha256(fs.readFileSync(preflightPath)) },
    reviewedSql,
    install,
    postflight: postflightSql,
    rollback
  };
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { dir, preflightPath, postflightPath, manifestPath, postflight };
}

function runVerifier(fixture: ReturnType<typeof createFixture>) {
  return spawnSync(process.execPath, [
    path.join(root, "scripts", "verify-operational-bootstrap-v2-staging-postflight.mjs"),
    `--preflight=${fixture.preflightPath}`,
    `--postflight=${fixture.postflightPath}`,
    `--manifest=${fixture.manifestPath}`
  ], { cwd: root, encoding: "utf8" });
}

describe("atomic bootstrap staging postflight verifier", () => {
  it("creates a manifest-bound verification accepted by the performance runner contract", () => {
    const fixture = createFixture();
    const result = runVerifier(fixture);
    expect(result.status, result.stderr).toBe(0);
    const verification = JSON.parse(fs.readFileSync(path.join(fixture.dir, "bootstrap-postflight-verification.json"), "utf8"));
    expect(verification.runId).toBe("normops-20260914-0840-bootstrap-verify");
    expect(verification.appStateUnchanged).toBe(true);
    expect(verification.incompleteMutations).toBe(0);
    expect(verification.payload).toMatchObject({ bytes: 133_365, limitBytes: 160_992, marginBytes: 27_627 });
  });

  it.each([
    ["oversized payload", (fixture: ReturnType<typeof createFixture>) => { fixture.postflight.payload.bytes = 160_993; }],
    ["app state drift", (fixture: ReturnType<typeof createFixture>) => { fixture.postflight.app_state.md5 = "f".repeat(32); }],
    ["unexpected ACL", (fixture: ReturnType<typeof createFixture>) => { fixture.postflight.function.acl_detail.push({ grantor: "postgres", grantee: "service_role", privilege_type: "EXECUTE", is_grantable: false }); }]
  ])("fails closed for %s", (_name, mutate) => {
    const fixture = createFixture();
    mutate(fixture);
    fs.writeFileSync(fixture.postflightPath, `${JSON.stringify(fixture.postflight)}\n`);
    const result = runVerifier(fixture);
    expect(result.status).not.toBe(0);
  });
});
