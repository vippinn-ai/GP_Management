import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const executableSqlWithoutCommentsOrStrings = (sql: string) =>
  sql
    .replace(/^\s*--.*$/gm, "")
    .replace(/'(?:''|[^'])*'/g, "''");

describe("Release B production preparation contract", () => {
  it("keeps environment preparation exact, local, and secret-safe", () => {
    const source = read("scripts/prepare-release-b-production.mjs");

    expect(source).toContain('const productionProjectRef = "rrdwbxvuwrbxefarxnse"');
    expect(source).toContain('const stagingProjectRef = "tkbdyzxwwbhkpztgjjxh"');
    expect(source).toContain('"VITE_BACKEND_FINANCIAL_RPC_V2"');
    expect(source).toContain('"VITE_BACKEND_NORMALIZED_BOOTSTRAP"');
    expect(source).toContain('"VITE_BACKEND_NORMALIZED_REPORT_READS"');
    expect(source).toContain('productionAccessed: false');
    expect(source).toContain('productionWritePerformed: false');
    expect(source).toContain('secretValuesPrinted: false');
    expect(source).toContain("compatibilityRollbackBuildPassed");
    expect(source).toContain("productionInstallBuildPassed");
    expect(source).toContain("compatibilityRollbackBoundToReleaseCommit");
    expect(source).not.toContain("VITE_SUPABASE_ANON_KEY=");
  });

  it("binds the four independently accepted staging evidence hashes", () => {
    const source = read("scripts/prepare-release-b-production.mjs");

    for (const hash of [
      "39ad4a4439fbbfcc3e7f4c62537200d0b76050b0e1ff46896978f840e1f07800",
      "43e8ffab19d95f812716914349890ff3bb63ee774d43ecee2f42d808beb84336",
      "fd973cc6243b613a5d5cb8a4edfcf51ac8a583f3d0ede52afb7f67a15f9cc7b7",
      "cdbd15aa163cc583500f0f8080f7fa699391cc1c711c1c57901d063fdd6b2de6"
    ]) {
      expect(source).toContain(hash);
    }
  });

  it("keeps the production SQL probe read-only", () => {
    const sql = read("supabase/release-b-production-preflight-readonly.sql");
    const executableSql = executableSqlWithoutCommentsOrStrings(sql);

    expect(executableSql).toMatch(/begin transaction isolation level repeatable read read only/i);
    expect(sql).toContain("'open_active_sessions'");
    expect(sql).toContain("'open_customer_tabs'");
    expect(sql).toContain("'processing_financial_mutations'");
    expect(sql).toContain("'financial_v2_functions_with_app_state_reference'");
    expect(sql).toContain("'operational_maintenance_function_count'");
    expect(sql).toContain("'operational_maintenance_authenticated_grants'");
    expect(sql).toContain("'installed_function_fingerprint_match_count'");
    expect(sql).toContain("'installed_function_security_definer_count'");
    expect(sql).toContain("'financial_mutations_exact_policy_count'");
    expect(sql).toContain("'financial_mutations_direct_role_privilege_count'");
    expect(sql).toContain("'financial_mutations_public_acl_privilege_count'");
    for (const hash of [
      "5db21abc1719f94627bc24b1845e201e58c3478ac5e3d776ded2d0d631f841b6",
      "5497baeeb5669fe2d7dbc7cc0d2a687d95b8e8df387e6763df49282fbdeb3867",
      "2ca126f39bb8cf581b1fa3fa1d9bb71e7ffbfdb5dbbff4458694daf12a9b8ebd",
      "f78d9a8b43737a3653248f848f46391bc11e3818509c495ef5a53c144709f15f",
      "cb7cf6e5c360cbc139bf146d9e07375fc42845565cc8d635ff865a30f108fbe3",
      "20f9e030b41c6debb458b713bc97e94bc9f707172ae9dafc01d9caeb78f63144"
    ]) expect(sql).toContain(hash);
    expect(executableSql).toMatch(/commit;\s*$/i);
    expect(executableSql).not.toMatch(/\b(insert|update|delete|merge|create|alter|drop|truncate|call)\b/i);
  });

  it("keeps pre-install discovery and backup baseline read-only", () => {
    for (const path of [
      "supabase/release-b-production-discovery-readonly.sql",
      "supabase/release-b-production-baseline-readonly.sql"
    ]) {
      const sql = read(path);
      const executableSql = executableSqlWithoutCommentsOrStrings(sql);
      expect(executableSql).toMatch(/begin transaction isolation level repeatable read read only/i);
      expect(sql).toContain("'production_write_allowed', false");
      expect(executableSql).toMatch(/commit;\s*$/i);
      expect(executableSql).not.toMatch(/\b(insert|update|delete|merge|create|alter|drop|truncate|call)\b/i);
    }
    const discovery = read("supabase/release-b-production-discovery-readonly.sql");
    expect(discovery).toContain("to_regclass('public.financial_mutations') is not null");
    expect(discovery).not.toMatch(/from\s+public\.financial_mutations/i);
    expect(discovery).toContain("'required_existing_function_count'");
    expect(discovery).toContain("'public.record_session_audit(jsonb)'");
    const baseline = read("supabase/release-b-production-baseline-readonly.sql");
    expect(baseline).toContain("'auth_users'");
    expect(baseline).toContain("'storage_objects'");
    expect(baseline).toContain("'data_hash'");
  });

  it("requires explicit approval, backup, and data-safe compatibility rollback", () => {
    const runbook = read("openspec/changes/financial-checkout-app-state-decoupling/release-b-production-runbook.md");

    expect(runbook).toContain("explicit approval immediately before changing production SQL");
    expect(runbook).toContain("open_active_sessions");
    expect(runbook).toContain("`processing_financial_mutations` = `0`");
    expect(runbook).toContain("scripts/backup-release-b-production.ps1");
    expect(runbook).toContain("npx wrangler versions upload --config wrangler.rollback.jsonc");
    expect(runbook).toContain("npx wrangler versions deploy <compatibility-version-id>@100%");
    expect(runbook).toContain("only if the v2 frontend never received traffic and no v2 financial mutation committed");
    expect(runbook).toContain("Do not roll normalized financial data back into stale `app_state`");
  });

  it("builds the rollback from production config without exposing secrets", () => {
    const source = read("scripts/build-release-b-production-rollback.mjs");
    expect(source).toContain('VITE_BACKEND_FINANCIAL_RPC_V2: "false"');
    expect(source).toContain("normalizedAndV1FallbackFlagsReady");
    expect(source).toContain("financialV2BuildFlagFalse");
    expect(source).toContain("legacyAppStateReadRollbackAllowed: false");
    expect(source).toContain("secretValuesPrinted: false");
    expect(source).not.toContain("VITE_SUPABASE_ANON_KEY=");
    const wrangler = read("wrangler.rollback.jsonc");
    expect(wrangler).toContain('"name": "management"');
    expect(wrangler).toContain('"directory": "./dist-production-rollback"');
  });

  it("keeps database credentials out of backup files and command arguments", () => {
    const source = read("scripts/backup-release-b-production.ps1");
    expect(source).toContain('Read-Host "Enter the production Supabase database password" -AsSecureString');
    expect(source).toContain("$env:SUPABASE_DB_PASSWORD");
    expect(source).toContain("Remove-Item Env:SUPABASE_DB_PASSWORD");
    expect(source).not.toMatch(/--password\s+\$env:SUPABASE_DB_PASSWORD/i);
    expect(source).not.toMatch(/--password\s+\$SecurePassword/i);
    expect(source).toContain("public-auth-storage-data.sql");
    expect(source).toContain("restoreDrillCompleted = $false");
    expect(source).toContain("[Parameter(Mandatory = $true)]");
    expect(source).toContain("Production baseline evidence must be captured within 15 minutes");
    expect(source).toContain('$Baseline.projectRef -ne $ProjectRef');
    expect(source).toContain("$BaselineSha256");
    expect(source).toContain("$ResolvedOutputRoot.Equals($AllowedOutputRoot");
    expect(source).toContain("$AllowedOutputPrefix");
    expect(source).toContain("supabase-sql-editor-copy-as-json");
    expect(source).toContain("$Baseline.provenance.rawExport.sha256");
    expect(source).toContain("$ExpectedBaselineSqlSha256");
    expect(source).toContain("[switch]$ValidateOnly");
    expect(source).toContain("[switch]$UsePasswordFromEnvironment");
    expect(source).toContain("aws-1-ap-southeast-2.pooler.supabase.com");
    expect(source).toContain("pg_dump.exe");
    expect(source).toContain("pg_dumpall.exe");
    expect(source).toContain("--no-role-passwords");
    expect(source).toContain("Remove-Item Env:PGPASSWORD");
    expect(source).toContain("6eabdf00d2893713b75db4336a23c3fdf505f056e217ec6e2e95d901750cfea3");
    expect(source).toContain("ff766351cc88b0ea2bc7b6e365777cb51f792b16000688a378f64124810ffa88");
    expect(source).toContain("25ac39cfdac4eb7a24eb384eed52521820ec38515517042c7ddea1a05bb48a0d");
    expect(source).toContain('"pg_dump (PostgreSQL) 17.11"');
    expect(source).toContain('"pg_dumpall (PostgreSQL) 17.11"');
    expect(source).not.toContain("[string]$PgBin");
    expect(source).toContain("release-b-production-baseline-verifier.mjs");
    expect(source).toContain("rawLineageReverified");
  });

  it("mechanically binds the raw Supabase baseline export to its query and project identity", () => {
    const source = read("scripts/normalize-release-b-production-baseline.mjs");
    expect(source).toContain('expectedProjectRef = "rrdwbxvuwrbxefarxnse"');
    expect(source).toContain('expectedDashboardTitleFragment = "breakperfect-production"');
    expect(source).toContain('expectedBaselineSqlSha256 = "650d67292814417f168dcc33f61c6d930d5493d3c6096f80341be940a22ef2c8"');
    expect(source).toContain('raw.replace(/\\r\\n/g, "\\n")');
    expect(source).toContain('rowKeys[0] !== "release_b_production_baseline"');
    expect(source).toContain('captureMethod: "supabase-sql-editor-copy-as-json"');
    expect(source).toContain("rawExportSha256");
    expect(source).toContain('flag: "wx"');

    const verifier = read("scripts/release-b-production-baseline-verifier.mjs");
    expect(verifier).toContain("resolveEvidenceChild");
    expect(verifier).toContain("readFile(rawExportPath");
    expect(verifier).toContain("rawFileHashMatches");
    expect(verifier).toContain("rawCanonicalHashMatches");
    expect(verifier).toContain("capturedAtMatches");
    expect(verifier).toContain("collectionsMatch");
    expect(verifier).toContain("isDeepStrictEqual");
    expect(verifier).toContain('raw.replace(/\\r\\n/g, "\\n")');
  });

  it("reopens and rejects a raw baseline export changed after normalization", () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const evidenceDirectory = resolve(root, "test-artifacts/evidence");
    const rawRelative = `test-artifacts/evidence/release-b-lineage-fixture-raw-${suffix}.json`;
    const normalizedRelative = `test-artifacts/evidence/release-b-lineage-fixture-normalized-${suffix}.json`;
    const rawPath = resolve(root, rawRelative);
    const normalizedPath = resolve(root, normalizedRelative);
    const capturedAt = new Date().toISOString();
    const rawResult = [{
      release_b_production_baseline: {
        schema_version: 1,
        expected_project_ref: "rrdwbxvuwrbxefarxnse",
        organization_id: "org-primary",
        captured_at: capturedAt,
        transaction_read_only: "on",
        production_write_allowed: false,
        open_active_sessions: 0,
        open_customer_tabs: 0,
        public_counts: { bills: 1 },
        financial_totals: { bill_total: 1 },
        latest_timestamps: { bill_issued_at: capturedAt },
        managed_schema_counts: { auth_users: 1 },
        app_state: {
          version: 1,
          bytes: 100,
          data_hash: "a".repeat(64),
          data_selected: false
        }
      }
    }];

    mkdirSync(evidenceDirectory, { recursive: true });
    try {
      writeFileSync(rawPath, `${JSON.stringify(rawResult, null, 2)}\n`, "utf8");
      const normalize = spawnSync(process.execPath, [
        "scripts/normalize-release-b-production-baseline.mjs",
        `--raw-export=${rawRelative}`,
        `--output=${normalizedRelative}`,
        "--dashboard-url=https://supabase.com/dashboard/project/rrdwbxvuwrbxefarxnse/sql/test-capture",
        "--dashboard-title=SQL Editor | breakperfect-production | Supabase"
      ], { cwd: root, encoding: "utf8" });
      expect(normalize.status, normalize.stderr).toBe(0);

      const verify = () => spawnSync(process.execPath, [
        "scripts/release-b-production-baseline-verifier.mjs",
        `--baseline-evidence=${normalizedRelative}`
      ], { cwd: root, encoding: "utf8" });
      expect(verify().status).toBe(0);

      rawResult[0].release_b_production_baseline.open_active_sessions = 1;
      writeFileSync(rawPath, `${JSON.stringify(rawResult, null, 2)}\n`, "utf8");
      const tampered = verify();
      expect(tampered.status).not.toBe(0);
      expect(`${tampered.stdout}\n${tampered.stderr}`).toMatch(/lineage verification failed|rawFileHashMatches/i);
    } finally {
      rmSync(rawPath, { force: true });
      rmSync(normalizedPath, { force: true });
    }
  });

  it("builds one SHA-bound, fail-closed additive SQL transaction", () => {
    const source = read("scripts/build-release-b-production-install.mjs");
    expect(source).toContain("bf056dd0a05f9388fae52c1e666ef35aa4a7a226a67694c0f4337120bb8aa752");
    expect(source).toContain("9e54f1afeeb47a45ded330536ab4237486407aba86a84a24dde3c3fc7f41a780");
    expect(source).toContain("sourcesDoNotAccessAppState");
    expect(source).toContain("sourcesHaveNoTransactionControl");
    expect(source).toContain('"begin;"');
    expect(source).toContain('"commit;\\n"');
    expect(source).toContain("set local statement_timeout = '120s';");
    expect(source).toContain("set local lock_timeout = '5s';");
    expect(source).toContain("productionWritePerformed: false");
    expect(source).toContain("productionBaselineGuardPresent");
    expect(source).toContain("A fresh --baseline-evidence path is required");
    expect(source).toContain("normalizedCaptureContract");
    expect(source).toContain("dashboardCaptureIdentity");
    expect(source).toContain("rawExportBound");
    expect(source).toContain("verifyReleaseBProductionBaseline");
    expect(source).toContain("downstreamRawLineageReverified");
  });

  it("verifies a production-only bundle with all v2 endpoints", () => {
    const verifier = read("scripts/verify-release-b-production-build.mjs");

    expect(verifier).toContain('searchable.includes("commit_checkout_bill_v2")');
    expect(verifier).toContain('searchable.includes("commit_financial_adjustment_v2")');
    expect(verifier).toContain('searchable.includes("get_financial_mutation_result")');
    expect(verifier).toContain("stagingProjectAbsent");
    expect(verifier).toContain("secretValuesPrinted: false");
  });
});
