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
      environment_identity: { environment: "staging", project_ref: "tkbdyzxwwbhkpztgjjxh", identity_nonce: "12345678-1234-4123-8123-123456789abc" },
      organization_id: "org-primary",
      organization_exists: true,
      open_sessions: 0,
      open_customer_tabs: 0,
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

    const second = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8" });
    expect(second.status).not.toBe(0);
  });
});
