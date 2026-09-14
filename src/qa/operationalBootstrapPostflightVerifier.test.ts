import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
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
  fs.mkdirSync(path.join(dir, "supabase"));
  fs.writeFileSync(path.join(dir, "supabase", "operational-bootstrap-v2.sql"), source);
  const reviewedPostflightSource = "begin isolation level repeatable read read only;\nselect 1;\nrollback;\n";
  fs.writeFileSync(path.join(dir, "supabase", "operational-bootstrap-v2-staging-postflight-readonly.sql"), reviewedPostflightSource);
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "bootstrap-verifier@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Bootstrap Verifier"], { cwd: dir });
  execFileSync("git", ["add", "supabase/operational-bootstrap-v2.sql", "supabase/operational-bootstrap-v2-staging-postflight-readonly.sql"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: dir, stdio: "pipe" });
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const reviewedSql = {
    path: "supabase/operational-bootstrap-v2.sql",
    blobSha256: sha256(Buffer.from(source)),
    sha256: sha256(source.trim()),
    bodyMd5: md5("begin return '{}'::jsonb; end;")
  };
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
    run_id: "normops-20260914-0840-bootstrap-verify",
    source_commit: sourceCommit,
    project_ref: "tkbdyzxwwbhkpztgjjxh",
    system_identifier: "7623125441096521075",
    payload: {
      bytes: 133_365,
      status: "active",
      actor_id: "145f79b4-b3a3-4e06-a3d6-b764d4a0bf00",
      organization_id: "org-primary",
      contract_version: 1,
      app_state_version: 44,
      collection_counts: {
        combos: 9,
        profiles: 31,
        sessions: 0,
        stations: 7,
        customer_tabs: 0,
        pricing_rules: 8,
        sale_variants: 56,
        inventory_items: 168,
        inventory_categories: 10
      }
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
    sourceCommit,
    preflight: { path: preflightPath, sha256: sha256(fs.readFileSync(preflightPath)) },
    reviewedSql,
    reviewedPostflightSql: {
      path: "supabase/operational-bootstrap-v2-staging-postflight-readonly.sql",
      blobSha256: sha256(Buffer.from(reviewedPostflightSource)),
      sha256: sha256(reviewedPostflightSource.trim())
    },
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
  ], { cwd: fixture.dir, encoding: "utf8" });
}

describe("atomic bootstrap staging postflight verifier", { timeout: 15_000 }, () => {
  it("creates a manifest-bound verification accepted by the performance runner contract", () => {
    const fixture = createFixture();
    const result = runVerifier(fixture);
    expect(result.status, result.stderr).toBe(0);
    const verification = JSON.parse(fs.readFileSync(path.join(fixture.dir, "bootstrap-postflight-verification.json"), "utf8"));
    expect(verification.runId).toBe("normops-20260914-0840-bootstrap-verify");
    expect(verification.appStateUnchanged).toBe(true);
    expect(verification.incompleteMutations).toBe(0);
    expect(verification.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(verification.payload.actorId).toBe("145f79b4-b3a3-4e06-a3d6-b764d4a0bf00");
    expect(verification.payload).toMatchObject({ bytes: 133_365, limitBytes: 160_992, marginBytes: 27_627 });
  });

  it.each([
    ["oversized payload", (fixture: ReturnType<typeof createFixture>) => { fixture.postflight.payload.bytes = 160_993; }],
    ["app state drift", (fixture: ReturnType<typeof createFixture>) => { fixture.postflight.app_state.md5 = "f".repeat(32); }],
    ["unexpected ACL", (fixture: ReturnType<typeof createFixture>) => { fixture.postflight.function.acl_detail.push({ grantor: "postgres", grantee: "service_role", privilege_type: "EXECUTE", is_grantable: false }); }],
    ["mismatched run", (fixture: ReturnType<typeof createFixture>) => { fixture.postflight.run_id = "normops-20260914-0841-stale-result"; }],
    ["mismatched source", (fixture: ReturnType<typeof createFixture>) => { fixture.postflight.source_commit = "f".repeat(40); }],
    ["unexpected payload field", (fixture: ReturnType<typeof createFixture>) => { Object.assign(fixture.postflight.payload, { ignored_extra: true }); }],
    ["invalid app state version type", (fixture: ReturnType<typeof createFixture>) => { Object.assign(fixture.postflight.payload, { app_state_version: "44" }); }],
    ["incomplete collection shape", (fixture: ReturnType<typeof createFixture>) => {
      delete (fixture.postflight.payload.collection_counts as Record<string, number>).sale_variants;
    }]
  ])("fails closed for %s", (_name, mutate) => {
    const fixture = createFixture();
    mutate(fixture);
    fs.writeFileSync(fixture.postflightPath, `${JSON.stringify(fixture.postflight)}\n`);
    const result = runVerifier(fixture);
    expect(result.status).not.toBe(0);
  });
});
