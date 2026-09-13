import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const createdPaths: string[] = [];
const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const md5 = (value: string | Buffer) => crypto.createHash("md5").update(value).digest("hex");

afterEach(() => {
  for (const target of createdPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

function fixture(targetFunction: unknown = null) {
  return {
    evidence: {
      expected_project_ref: "tkbdyzxwwbhkpztgjjxh",
      system_identifier: "7623125441096521075",
      environment_identity: {
        environment: "staging",
        project_ref: "tkbdyzxwwbhkpztgjjxh",
        identity_nonce: "11111111-2222-4333-8444-555555555555"
      },
      organization_id: "org-primary",
      open_sessions: 0,
      open_customer_tabs: 0,
      processing_financial_mutations: 0,
      processing_operational_mutations: 0,
      app_state: { version: 44, md5: "0123456789abcdef0123456789abcdef" },
      target_function: targetFunction,
      realtime_security: {
        rls_enabled: true,
        published: true,
        policies: [{
          name: "operational_events_select",
          roles: ["authenticated"],
          command: "SELECT",
          using: "current_user_has_org_access(organization_id)"
        }],
        access_helper_definition: "select 1 from public.organization_members membership where membership.active = true"
      }
    }
  };
}

describe("atomic bootstrap staging installer builder", () => {
  it("generates immutable install and exact absent-function rollback artifacts", () => {
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-bootstrap-test`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    fs.writeFileSync(preflightPath, JSON.stringify(fixture()));
    createdPaths.push(fixtureDir);
    const outputDir = path.join(root, "test-artifacts", "operational-bootstrap-v2", runId);
    createdPaths.push(outputDir);

    execFileSync(process.execPath, [
      path.join(root, "scripts", "build-operational-bootstrap-v2-staging-install.mjs"),
      `--run-id=${runId}`,
      `--preflight=${preflightPath}`
    ], { cwd: root, env: { ...process.env, SOURCE_COMMIT: "test-sha" } });

    const install = fs.readFileSync(path.join(outputDir, "staging-install.sql"), "utf8");
    const rollback = fs.readFileSync(path.join(outputDir, "staging-rollback.sql"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8"));
    expect(install).toContain("unexpected bootstrap function appeared after preflight");
    expect(install).toContain("create or replace function public.load_operational_bootstrap_v2()");
    expect(install).toContain("bootstrap install changed app_state");
    expect(rollback).toContain("drop function public.load_operational_bootstrap_v2();");
    expect(rollback).toContain("rollback refused unexpected bootstrap definition drift");
    expect(manifest.previousFunctionExisted).toBe(false);
    expect(manifest.sourceCommit).toBe("test-sha");
    expect(manifest.install.sha256).toBe(sha256(install));
    expect(manifest.rollback.sha256).toBe(sha256(rollback));
  });

  it("fails closed when the preflight does not prove realtime tenant isolation", () => {
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-bootstrap-bad`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-bad-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    const invalid = fixture() as { evidence: { realtime_security: { access_helper_definition: string } } };
    invalid.evidence.realtime_security.access_helper_definition = "select true";
    fs.writeFileSync(preflightPath, JSON.stringify(invalid));
    createdPaths.push(fixtureDir);

    expect(() => execFileSync(process.execPath, [
      path.join(root, "scripts", "build-operational-bootstrap-v2-staging-install.mjs"),
      `--run-id=${runId}`,
      `--preflight=${preflightPath}`
    ], { cwd: root, stdio: "pipe" })).toThrow();
  });

  it("preserves an exact prior definition, owner, and ACL in the rollback artifact", () => {
    const definition = `CREATE OR REPLACE FUNCTION public.load_operational_bootstrap_v2()\n RETURNS jsonb\n LANGUAGE plpgsql\nAS $function$\nbegin return '{}'::jsonb; end;\n$function$`;
    const prior = {
      definition,
      definition_md5: md5(definition),
      body_md5: md5("begin return '{}'::jsonb; end;"),
      owner: "\"postgres\"",
      security_definer: false,
      volatility: "v",
      config: null,
      acl_detail: [{ grantor: "postgres", grantee: "authenticated", privilege_type: "EXECUTE", is_grantable: false }]
    };
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-bootstrap-existing`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-existing-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    fs.writeFileSync(preflightPath, JSON.stringify(fixture(prior)));
    createdPaths.push(fixtureDir);
    const outputDir = path.join(root, "test-artifacts", "operational-bootstrap-v2", runId);
    createdPaths.push(outputDir);

    execFileSync(process.execPath, [
      path.join(root, "scripts", "build-operational-bootstrap-v2-staging-install.mjs"),
      `--run-id=${runId}`,
      `--preflight=${preflightPath}`
    ], { cwd: root });

    const rollback = fs.readFileSync(path.join(outputDir, "staging-rollback.sql"), "utf8");
    expect(rollback).toContain(definition);
    expect(rollback).toContain('alter function public.load_operational_bootstrap_v2() owner to "postgres";');
    expect(rollback).toContain("grant execute on function public.load_operational_bootstrap_v2() to \"authenticated\";");
    expect(rollback).not.toContain("drop function public.load_operational_bootstrap_v2();");
  });
});
