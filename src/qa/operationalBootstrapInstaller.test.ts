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
  const accessHelperBody = `select coalesce(
    (
      select organization_members.active
      from public.organization_members
      where organization_members.organization_id = target_organization_id
        and organization_members.user_id = (select auth.uid())
        and organization_members.active = true
      limit 1
    ),
    false
  );`;
  const accessHelperDefinition = `CREATE OR REPLACE FUNCTION public.current_user_has_org_access(target_organization_id text)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  ${accessHelperBody}
$function$`;
  return {
    evidence: {
      expected_project_ref: "tkbdyzxwwbhkpztgjjxh",
      system_identifier: "7623125441096521075",
      environment_identity: {
        environment: "staging",
        project_ref: "tkbdyzxwwbhkpztgjjxh",
        identity_nonce: "11111111-2222-4333-8444-555555555555"
      },
      installer_role: "postgres",
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
        authenticated_role_memberships: ["authenticated"],
        policies: [{
          name: "operational_events_select",
          permissive: "PERMISSIVE",
          roles: ["authenticated"],
          command: "SELECT",
          using: "current_user_has_org_access(organization_id)",
          check: null
        }],
        access_helper: {
          definition: accessHelperDefinition,
          definition_md5: md5(accessHelperDefinition),
          body_md5: md5(accessHelperBody),
          owner_name: "postgres",
          security_definer: true,
          volatility: "v",
          config: ["search_path=public"],
          acl_detail: [
            {
              grantor: "postgres",
              grantee: "postgres",
              privilege_type: "EXECUTE",
              is_grantable: false
            },
            {
              grantor: "postgres",
              grantee: "authenticated",
              privilege_type: "EXECUTE",
              is_grantable: false
            }
          ]
        }
      }
    }
  };
}

type PreflightEvidence = ReturnType<typeof fixture>["evidence"];

const helperDriftCases: Array<[string, (evidence: PreflightEvidence) => void]> = [
  ["owner", (evidence) => { evidence.installer_role = "migration_role"; }],
  ["body hash", (evidence) => { evidence.realtime_security.access_helper.body_md5 = "0".repeat(32); }],
  ["definition hash", (evidence) => { evidence.realtime_security.access_helper.definition_md5 = "0".repeat(32); }],
  ["definition/body inconsistency", (evidence) => {
    const helper = evidence.realtime_security.access_helper;
    helper.definition = helper.definition.replace("false\n  );", "true\n  );");
    helper.definition_md5 = md5(helper.definition);
  }],
  ["security definer", (evidence) => { evidence.realtime_security.access_helper.security_definer = false; }],
  ["volatility", (evidence) => { evidence.realtime_security.access_helper.volatility = "s"; }],
  ["config", (evidence) => { evidence.realtime_security.access_helper.config.push("statement_timeout=5s"); }],
  ["missing owner grant", (evidence) => {
    evidence.realtime_security.access_helper.acl_detail = evidence.realtime_security.access_helper.acl_detail
      .filter((grant) => grant.grantee !== "postgres");
  }],
  ["missing authenticated grant", (evidence) => {
    evidence.realtime_security.access_helper.acl_detail = evidence.realtime_security.access_helper.acl_detail
      .filter((grant) => grant.grantee !== "authenticated");
  }],
  ...["anon", "service_role", "staff_reader"].map<[string, (evidence: PreflightEvidence) => void]>((grantee) => [
    `unauthorized ${grantee} grantee`,
    (evidence) => { evidence.realtime_security.access_helper.acl_detail.push({
      grantor: "postgres", grantee, privilege_type: "EXECUTE", is_grantable: false
    }); }
  ]),
  ["wrong privilege", (evidence) => {
    evidence.realtime_security.access_helper.acl_detail[1].privilege_type = "UPDATE";
  }],
  ["owner grant option", (evidence) => {
    evidence.realtime_security.access_helper.acl_detail[0].is_grantable = true;
  }],
  ["authenticated grant option", (evidence) => {
    evidence.realtime_security.access_helper.acl_detail[1].is_grantable = true;
  }]
];

function createCleanSourceRepo(sourceText = fs.readFileSync(path.join(root, "supabase", "operational-bootstrap-v2.sql"), "utf8")) {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-source-"));
  fs.mkdirSync(path.join(sourceRoot, "supabase"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "supabase", "operational-bootstrap-v2.sql"), sourceText);
  fs.writeFileSync(
    path.join(sourceRoot, "supabase", "operational-bootstrap-v2-staging-postflight-readonly.sql"),
    fs.readFileSync(path.join(root, "supabase", "operational-bootstrap-v2-staging-postflight-readonly.sql"), "utf8")
  );
  fs.writeFileSync(path.join(sourceRoot, ".gitignore"), "test-artifacts/\n");
  execFileSync("git", ["init"], { cwd: sourceRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "bootstrap-test@example.invalid"], { cwd: sourceRoot });
  execFileSync("git", ["config", "user.name", "Bootstrap Test"], { cwd: sourceRoot });
  execFileSync("git", ["add", "."], { cwd: sourceRoot });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: sourceRoot, stdio: "pipe" });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
  createdPaths.push(sourceRoot);
  return { sourceRoot, commit };
}

function runBuilder(sourceRoot: string, commit: string, runId: string, preflightPath: string) {
  return execFileSync(process.execPath, [
    path.join(root, "scripts", "build-operational-bootstrap-v2-staging-install.mjs"),
    `--run-id=${runId}`,
    `--preflight=${preflightPath}`,
    `--source-commit=${commit}`
  ], { cwd: sourceRoot, stdio: "pipe" });
}

describe("atomic bootstrap staging installer builder", { timeout: 30_000 }, () => {
  it("generates immutable install and exact absent-function rollback artifacts", () => {
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-bootstrap-test`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    fs.writeFileSync(preflightPath, JSON.stringify(fixture()));
    createdPaths.push(fixtureDir);
    const { sourceRoot, commit } = createCleanSourceRepo();
    const outputDir = path.join(sourceRoot, "test-artifacts", "operational-bootstrap-v2", runId);

    runBuilder(sourceRoot, commit, runId, preflightPath);

    const install = fs.readFileSync(path.join(outputDir, "staging-install.sql"), "utf8");
    const postflight = fs.readFileSync(path.join(outputDir, "staging-postflight.sql"), "utf8");
    const rollback = fs.readFileSync(path.join(outputDir, "staging-rollback.sql"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8"));
    expect(install).toContain("unexpected bootstrap function appeared after preflight");
    expect(install).toContain("create or replace function public.load_operational_bootstrap_v2()");
    expect(install).toContain("bootstrap install changed app_state");
    expect(rollback).toContain("drop function public.load_operational_bootstrap_v2();");
    expect(rollback).toContain("rollback refused unexpected bootstrap definition, owner, configuration, ACL, or security drift");
    expect(manifest.previousFunctionExisted).toBe(false);
    expect(manifest.sourceCommit).toBe(commit);
    expect(manifest.reviewedSql.blobSha256).toBe(
      sha256(execFileSync("git", ["show", `${commit}:supabase/operational-bootstrap-v2.sql`], { cwd: sourceRoot }))
    );
    expect(manifest.reviewedPostflightSql.blobSha256).toBe(
      sha256(execFileSync("git", ["show", `${commit}:supabase/operational-bootstrap-v2-staging-postflight-readonly.sql`], { cwd: sourceRoot }))
    );
    expect(manifest.reviewedPostflightSql.sha256).toBe(
      sha256(fs.readFileSync(path.join(sourceRoot, "supabase", "operational-bootstrap-v2-staging-postflight-readonly.sql"), "utf8").trim())
    );
    expect(install).toContain("realtime publication, RLS policy, or access helper changed after preflight");
    expect(postflight).toContain("realtime publication, RLS policy, or access helper changed after preflight");
    expect(postflight).toContain("11111111-2222-4333-8444-555555555555");
    expect(postflight).toContain("1582c0fa10f3c451fee64540e43de6f7");
    expect(postflight).toContain("actual_realtime_security is distinct from");
    expect(postflight).toContain("normops.bootstrap_evidence_run_id");
    expect(postflight).toContain(runId);
    expect(postflight).toContain("normops.bootstrap_evidence_source_commit");
    expect(postflight).toContain(commit);
    expect(postflight).toContain("'run_id', current_setting('normops.bootstrap_evidence_run_id', true)");
    expect(postflight).toContain("'source_commit', current_setting('normops.bootstrap_evidence_source_commit', true)");
    expect(postflight).toMatch(/begin isolation level repeatable read read only;\r?\n\r?\ndo \$\$/i);
    expect(postflight).not.toMatch(/\bdo \$\r?\n/);
    expect(postflight).not.toMatch(/\bend \$;\r?\n/);
    expect(postflight.match(/\bdo \$\$/g)?.length).toBe(postflight.match(/\bend \$\$;/g)?.length);
    expect(install).toContain("exact ACL mismatch");
    expect(install).toContain("replace(replace(btrim(p.prosrc, E' \\t\\n\\r')");
    expect(install).toContain("canonical function-body newline normalization failed");
    expect(rollback).toContain("owner, configuration, ACL, or security drift");
    expect(manifest.install.sha256).toBe(sha256(install));
    expect(manifest.postflight.sha256).toBe(sha256(postflight));
    expect(manifest.rollback.sha256).toBe(sha256(rollback));
  });

  it.each(helperDriftCases)("fails closed on access-helper %s drift", (_label, mutate) => {
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-helper-drift`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-helper-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    const value = fixture();
    mutate(value.evidence);
    fs.writeFileSync(preflightPath, JSON.stringify(value));
    createdPaths.push(fixtureDir);
    const { sourceRoot, commit } = createCleanSourceRepo();

    expect(() => runBuilder(sourceRoot, commit, runId, preflightPath)).toThrow();
  });

  it("accepts the canonical optional PUBLIC execute grant and binds it into generated postflight", () => {
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-helper-public`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-helper-public-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    const value = fixture();
    value.evidence.realtime_security.access_helper.acl_detail.unshift({
      grantor: "postgres", grantee: "PUBLIC", privilege_type: "EXECUTE", is_grantable: false
    });
    fs.writeFileSync(preflightPath, JSON.stringify(value));
    createdPaths.push(fixtureDir);
    const { sourceRoot, commit } = createCleanSourceRepo();
    const outputDir = path.join(sourceRoot, "test-artifacts", "operational-bootstrap-v2", runId);

    expect(() => runBuilder(sourceRoot, commit, runId, preflightPath)).not.toThrow();
    expect(fs.readFileSync(path.join(outputDir, "staging-postflight.sql"), "utf8")).toContain('"grantee":"PUBLIC"');
  });

  it("accepts the exact catalog-rendered staging policy and redundant grants covered by PUBLIC", () => {
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-catalog-policy`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-catalog-policy-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    const value = fixture();
    value.evidence.realtime_security.policies[0].command = "ALL";
    value.evidence.realtime_security.policies[0].using =
      "( SELECT current_user_has_org_access(operational_events.organization_id) AS current_user_has_org_access)";
    value.evidence.realtime_security.access_helper.acl_detail.unshift({
      grantor: "postgres", grantee: "PUBLIC", privilege_type: "EXECUTE", is_grantable: false
    });
    value.evidence.realtime_security.access_helper.acl_detail.push(
      { grantor: "postgres", grantee: "anon", privilege_type: "EXECUTE", is_grantable: false },
      { grantor: "postgres", grantee: "service_role", privilege_type: "EXECUTE", is_grantable: false }
    );
    fs.writeFileSync(preflightPath, JSON.stringify(value));
    createdPaths.push(fixtureDir);
    const { sourceRoot, commit } = createCleanSourceRepo();

    expect(() => runBuilder(sourceRoot, commit, runId, preflightPath)).not.toThrow();
  });

  it("rejects a catalog-shaped tenant predicate with an additional permissive clause", () => {
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-catalog-policy-drift`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-catalog-policy-drift-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    const value = fixture();
    value.evidence.realtime_security.policies[0].using =
      "( SELECT current_user_has_org_access(operational_events.organization_id) OR true)";
    fs.writeFileSync(preflightPath, JSON.stringify(value));
    createdPaths.push(fixtureDir);
    const { sourceRoot, commit } = createCleanSourceRepo();

    expect(() => runBuilder(sourceRoot, commit, runId, preflightPath)).toThrow();
  });

  it("fails closed when the preflight does not prove realtime tenant isolation", () => {
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-bootstrap-bad`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-bad-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    const invalid = fixture() as { evidence: { realtime_security: { access_helper: { definition: string } } } };
    invalid.evidence.realtime_security.access_helper.definition = "select true";
    fs.writeFileSync(preflightPath, JSON.stringify(invalid));
    createdPaths.push(fixtureDir);
    const { sourceRoot, commit } = createCleanSourceRepo();

    expect(() => runBuilder(sourceRoot, commit, runId, preflightPath)).toThrow();
  });

  it("fails closed when an additional permissive SELECT policy can apply", () => {
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-bootstrap-policy`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-policy-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    const invalid = fixture() as { evidence: { realtime_security: { policies: unknown[] } } };
    invalid.evidence.realtime_security.policies.push({
      name: "permissive_public_select",
      permissive: "PERMISSIVE",
      roles: ["PUBLIC"],
      command: "SELECT",
      using: "true"
    });
    fs.writeFileSync(preflightPath, JSON.stringify(invalid));
    createdPaths.push(fixtureDir);
    const { sourceRoot, commit } = createCleanSourceRepo();

    expect(() => runBuilder(sourceRoot, commit, runId, preflightPath)).toThrow();
  });

  it("fails closed when a SELECT policy applies through an inherited authenticated role", () => {
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-bootstrap-inherited-policy`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-inherited-policy-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    const invalid = fixture() as {
      evidence: {
        realtime_security: {
          authenticated_role_memberships: string[];
          policies: unknown[];
        };
      };
    };
    invalid.evidence.realtime_security.authenticated_role_memberships.push("staff_reader");
    invalid.evidence.realtime_security.policies.push({
      name: "inherited_staff_select",
      permissive: "PERMISSIVE",
      roles: ["staff_reader"],
      command: "SELECT",
      using: "true"
    });
    fs.writeFileSync(preflightPath, JSON.stringify(invalid));
    createdPaths.push(fixtureDir);
    const { sourceRoot, commit } = createCleanSourceRepo();

    expect(() => runBuilder(sourceRoot, commit, runId, preflightPath)).toThrow();
  });

  it("fails closed when the only matching policy is restrictive", () => {
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-bootstrap-restrictive`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-restrictive-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    const invalid = fixture() as { evidence: { realtime_security: { policies: Array<{ permissive: string }> } } };
    invalid.evidence.realtime_security.policies[0].permissive = "RESTRICTIVE";
    fs.writeFileSync(preflightPath, JSON.stringify(invalid));
    createdPaths.push(fixtureDir);
    const { sourceRoot, commit } = createCleanSourceRepo();

    expect(() => runBuilder(sourceRoot, commit, runId, preflightPath)).toThrow();
  });

  it("requires an exact clean source commit", () => {
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-bootstrap-dirty`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-dirty-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    fs.writeFileSync(preflightPath, JSON.stringify(fixture()));
    createdPaths.push(fixtureDir);
    const { sourceRoot, commit } = createCleanSourceRepo();
    fs.appendFileSync(path.join(sourceRoot, "supabase", "operational-bootstrap-v2.sql"), "\n-- dirty\n");

    expect(() => runBuilder(sourceRoot, commit, runId, preflightPath)).toThrow();
  });

  it("produces one canonical reviewed body hash for LF, CRLF, and lone-CR transport", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-newlines-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    fs.writeFileSync(preflightPath, JSON.stringify(fixture()));
    createdPaths.push(fixtureDir);
    const source = fs.readFileSync(path.join(root, "supabase", "operational-bootstrap-v2.sql"), "utf8")
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n");

    const hashes = [source, source.replaceAll("\n", "\r\n"), source.replaceAll("\n", "\r")].map((variant, index) => {
      const { sourceRoot, commit } = createCleanSourceRepo(variant);
      const runId = `normops-20260914-${String(Date.now()).slice(-4)}-newline-${index}`;
      runBuilder(sourceRoot, commit, runId, preflightPath);
      return JSON.parse(fs.readFileSync(
        path.join(sourceRoot, "test-artifacts", "operational-bootstrap-v2", runId, "manifest.json"),
        "utf8"
      )).reviewedSql.bodyMd5;
    });

    expect(new Set(hashes).size).toBe(1);
  });

  it("preserves an exact prior definition, owner, and ACL in the rollback artifact", () => {
    const definition = `CREATE OR REPLACE FUNCTION public.load_operational_bootstrap_v2()\n RETURNS jsonb\n LANGUAGE plpgsql\nAS $function$\nbegin return '{}'::jsonb; end;\n$function$`;
    const prior = {
      definition,
      definition_md5: md5(definition),
      body_md5: md5("begin return '{}'::jsonb; end;"),
      owner: "\"postgres\"",
      owner_name: "postgres",
      security_definer: false,
      volatility: "v",
      config: null,
      acl_detail: [
        { grantor: "postgres", grantee: "PUBLIC", privilege_type: "EXECUTE", is_grantable: false },
        { grantor: "postgres", grantee: "postgres", privilege_type: "EXECUTE", is_grantable: false },
        { grantor: "postgres", grantee: "authenticated", privilege_type: "EXECUTE", is_grantable: true }
      ]
    };
    const runId = `normops-20260914-${String(Date.now()).slice(-4)}-bootstrap-existing`;
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bootstrap-preflight-existing-"));
    const preflightPath = path.join(fixtureDir, "preflight.json");
    fs.writeFileSync(preflightPath, JSON.stringify(fixture(prior)));
    createdPaths.push(fixtureDir);
    const { sourceRoot, commit } = createCleanSourceRepo();
    const outputDir = path.join(sourceRoot, "test-artifacts", "operational-bootstrap-v2", runId);

    runBuilder(sourceRoot, commit, runId, preflightPath);

    const rollback = fs.readFileSync(path.join(outputDir, "staging-rollback.sql"), "utf8");
    expect(rollback).toContain(definition);
    expect(rollback).toContain('alter function public.load_operational_bootstrap_v2() owner to "postgres";');
    expect(rollback).toContain('set local role "postgres";');
    expect(rollback).toContain("reset role;");
    expect(rollback).toContain("grant execute on function public.load_operational_bootstrap_v2() to \"postgres\";");
    expect(rollback).toContain("grant execute on function public.load_operational_bootstrap_v2() to public;");
    expect(rollback).toContain("grant execute on function public.load_operational_bootstrap_v2() to \"authenticated\" with grant option;");
    expect(rollback).toContain("rollback failed to restore the exact prior bootstrap function");
    expect(rollback).toContain(`definition_md5 is distinct from '${md5(definition)}'`);
    expect(rollback).toContain(`actual_acl is distinct from '${JSON.stringify(prior.acl_detail)}'::jsonb`);
    expect(rollback).not.toContain("drop function public.load_operational_bootstrap_v2();");
  });
});
