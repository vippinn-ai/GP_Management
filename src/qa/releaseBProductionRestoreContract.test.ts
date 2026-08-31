import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  join(process.cwd(), "scripts", "restore-verify-release-b-backup.ps1"),
  "utf8",
);

describe("Release B production restore drill contract", () => {
  it("refuses production and staging targets and requires an exact disposable confirmation", () => {
    expect(script).toContain('$ProductionProjectRef = "rrdwbxvuwrbxefarxnse"');
    expect(script).toContain('$StagingProjectRef = "tkbdyzxwwbhkpztgjjxh"');
    expect(script).toContain("$TargetProjectRef -in @($ProductionProjectRef, $StagingProjectRef)");
    expect(script).toContain("$ConfirmDisposableProjectRef -cne $TargetProjectRef");
    expect(script).toContain("pooler\\.supabase\\.com");
  });

  it("verifies every backup input and the pinned psql tool before reading the password", () => {
    expect(script).toContain("$Manifest.files");
    expect(script).toContain("Get-FileHash -LiteralPath $FilePath -Algorithm SHA256");
    expect(script).toContain("5bb3fad8a7ff555abff37921a24ee3d9e377c15408b5e7267aa9245596965ca0");
    expect(script.indexOf("The PostgreSQL restore toolchain does not match")).toBeLessThan(
      script.indexOf("Read-Host"),
    );
  });

  it("resets only the disposable target and restores normalized, auth, and storage data atomically", () => {
    expect(script).toContain("drop schema if exists public cascade");
    expect(script).toContain("schemaname in ('auth', 'storage')");
    expect(script).toContain("truncate table %I.%I cascade");
    expect(script).not.toContain("restart identity cascade");
    expect(script).toContain("auth\\.schema_migrations|storage\\.migrations");
    expect(script).toContain("$ActualSkippedCopyTables -cne $ExpectedSkippedCopyTables");
    expect(script).toContain("preservedPlatformMetadata");
    expect(script).toContain("if (-not $VerifyOnly)");
    expect(script).toContain("$MissingManagedRoles.Count -gt 0");
    expect(script).toContain("--single-transaction");
    expect(script).toContain("SET session_replication_role = replica;");
    expect(script).not.toMatch(/&\s+\$Psql[^\r\n]*--file=\$RolesPath/);
  });

  it("requires exact restored counts, totals, timestamps, roles, and app-state identity", () => {
    expect(script).toContain("publicCounts.PSObject.Properties");
    expect(script).toContain("financialTotals.PSObject.Properties");
    expect(script).toContain("managedSchemaCounts.PSObject.Properties");
    expect(script).toContain("latestTimestamps.PSObject.Properties");
    expect(script).toContain("app_state.data_hash");
    expect(script).toContain("app_state.bytes_nonzero");
    expect(script).toContain("appStateByteSizeExact");
    expect(script).toContain("managedRolesPassed = $true");
    expect(script).toContain('status = "passed"');
  });

  it("clears both password environment variables in finally", () => {
    expect(script).toContain("finally {");
    expect(script).toContain("Remove-Item Env:SUPABASE_DB_PASSWORD");
    expect(script).toContain("Remove-Item Env:PGPASSWORD");
  });
});
