[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupDirectory,
  [Parameter(Mandatory = $true)]
  [string]$TargetProjectRef,
  [Parameter(Mandatory = $true)]
  [string]$ConfirmDisposableProjectRef,
  [Parameter(Mandatory = $true)]
  [string]$TargetHost,
  [string]$TargetPort = "5432",
  [switch]$VerifyOnly,
  [switch]$UsePasswordFromEnvironment
)

$ErrorActionPreference = "Stop"
$ProductionProjectRef = "rrdwbxvuwrbxefarxnse"
$StagingProjectRef = "tkbdyzxwwbhkpztgjjxh"
$ExpectedSourceProjectRef = $ProductionProjectRef
$ExpectedPsqlVersion = "psql (PostgreSQL) 17.11"
$ExpectedPsqlSha256 = "5bb3fad8a7ff555abff37921a24ee3d9e377c15408b5e7267aa9245596965ca0"
$ExpectedArchiveSha256 = "6eabdf00d2893713b75db4336a23c3fdf505f056e217ec6e2e95d901750cfea3"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$AllowedBackupRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "production-backups"))
$AllowedBackupPrefix = $AllowedBackupRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$ResolvedBackupDirectory = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $BackupDirectory))

if (-not $ResolvedBackupDirectory.StartsWith($AllowedBackupPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Restore input must remain under the ignored production-backups directory."
}
if (-not (Test-Path -LiteralPath $ResolvedBackupDirectory -PathType Container)) {
  throw "The production backup directory does not exist."
}
if ($TargetProjectRef -notmatch '^[a-z]{20}$') {
  throw "The disposable target project reference is invalid."
}
if ($TargetProjectRef -in @($ProductionProjectRef, $StagingProjectRef)) {
  throw "The restore drill refuses production and staging project references."
}
if ($ConfirmDisposableProjectRef -cne $TargetProjectRef) {
  throw "The disposable target confirmation does not match the target project reference."
}
if ($TargetHost -notmatch '^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$') {
  throw "The restore target must use an explicit Supabase session-pooler host."
}
if ($TargetPort -ne "5432") {
  throw "The restore drill requires the IPv4 session-pooler port 5432."
}

$ManifestPath = Join-Path $ResolvedBackupDirectory "manifest.json"
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  throw "The backup manifest is missing."
}
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if (
  $Manifest.schemaVersion -ne 1 -or
  $Manifest.projectRef -ne $ExpectedSourceProjectRef -or
  $Manifest.validation.allFilesPresent -ne $true -or
  $Manifest.validation.allFilesNonEmpty -ne $true -or
  $Manifest.validation.hashesRecorded -ne $true
) {
  throw "The backup manifest is not an accepted Release B production backup."
}
$ManifestSha256 = (Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$ExpectedFiles = @("public-auth-storage-data.sql", "public-schema.sql", "roles.sql")
$ManifestFileNames = @($Manifest.files | ForEach-Object { [string]$_.name } | Sort-Object)
if (($ManifestFileNames -join '|') -ne (($ExpectedFiles | Sort-Object) -join '|')) {
  throw "The backup manifest file set is incomplete or unexpected."
}
foreach ($ManifestFile in $Manifest.files) {
  $FilePath = Join-Path $ResolvedBackupDirectory ([string]$ManifestFile.name)
  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    throw "A manifest-listed backup file is missing."
  }
  $File = Get-Item -LiteralPath $FilePath
  $FileHash = (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($File.Length -le 0 -or $File.Length -ne [int64]$ManifestFile.bytes -or $FileHash -ne [string]$ManifestFile.sha256) {
    throw "A backup file failed its size or SHA-256 verification."
  }
}

$BaselinePath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot ([string]$Manifest.baselineEvidence.path)))
if (-not (Test-Path -LiteralPath $BaselinePath -PathType Leaf)) {
  throw "The manifest-bound baseline evidence is missing."
}
if ((Get-FileHash -LiteralPath $BaselinePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$Manifest.baselineEvidence.sha256) {
  throw "The manifest-bound baseline evidence hash does not match."
}
$Baseline = Get-Content -LiteralPath $BaselinePath -Raw | ConvertFrom-Json
if ($Baseline.status -ne "passed" -or $Baseline.projectRef -ne $ExpectedSourceProjectRef) {
  throw "The baseline evidence is not a passed production baseline."
}

$PortableArchive = Join-Path $ProjectRoot "test-artifacts\tools\postgresql-17.11-1-windows-x64-binaries.zip"
$Psql = Join-Path $ProjectRoot "test-artifacts\tools\postgresql-17.11\pgsql\bin\psql.exe"
if (-not (Test-Path -LiteralPath $PortableArchive -PathType Leaf) -or -not (Test-Path -LiteralPath $Psql -PathType Leaf)) {
  throw "The pinned official PostgreSQL 17.11 archive and psql binary are required."
}
if (
  (Get-FileHash -LiteralPath $PortableArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedArchiveSha256 -or
  (Get-FileHash -LiteralPath $Psql -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedPsqlSha256 -or
  (& $Psql --version).Trim() -ne $ExpectedPsqlVersion
) {
  throw "The PostgreSQL restore toolchain does not match the pinned official 17.11 release."
}

$RolesPath = Join-Path $ResolvedBackupDirectory "roles.sql"
$SchemaPath = Join-Path $ResolvedBackupDirectory "public-schema.sql"
$DataPath = Join-Path $ResolvedBackupDirectory "public-auth-storage-data.sql"
$BaselineSqlPath = Join-Path $ProjectRoot "supabase\release-b-production-baseline-readonly.sql"
$RestoreTempRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "test-artifacts\restore-drill-temp"))
$RestoreTempPrefix = $RestoreTempRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$RestoreDataPath = $null
$ExpectedManagedRoles = @(
  "anon", "authenticated", "authenticator", "dashboard_user", "pgbouncer", "postgres",
  "service_role", "supabase_admin", "supabase_auth_admin", "supabase_etl_admin",
  "supabase_privileged_role", "supabase_read_only_user", "supabase_realtime_admin",
  "supabase_replication_admin", "supabase_storage_admin"
)
$DumpedRoles = @(
  Get-Content -LiteralPath $RolesPath |
    ForEach-Object { if ($_ -match '^CREATE ROLE ([a-z0-9_]+);$') { $Matches[1] } } |
    Sort-Object
)
if (($DumpedRoles -join '|') -ne (($ExpectedManagedRoles | Sort-Object) -join '|')) {
  throw "The roles dump contains a nonstandard or incomplete Supabase managed-role set."
}

New-Item -ItemType Directory -Path $RestoreTempRoot -Force | Out-Null
$RestoreDataPath = Join-Path $RestoreTempRoot "release-b-restore-data-$TargetProjectRef-$([guid]::NewGuid().ToString('N')).sql"
$SkipCopyTables = @("auth.schema_migrations", "storage.migrations")
$SkippedCopyTables = [System.Collections.Generic.List[string]]::new()
$Reader = [System.IO.StreamReader]::new($DataPath, [System.Text.Encoding]::UTF8, $true)
$Writer = [System.IO.StreamWriter]::new($RestoreDataPath, $false, [System.Text.UTF8Encoding]::new($false))
try {
  $SkippingCopy = $false
  while (($Line = $Reader.ReadLine()) -ne $null) {
    if (-not $SkippingCopy -and $Line -match '^COPY (auth\.schema_migrations|storage\.migrations) ') {
      $SkippingCopy = $true
      $SkippedCopyTables.Add($Matches[1])
      continue
    }
    if ($SkippingCopy) {
      if ($Line -eq '\.') { $SkippingCopy = $false }
      continue
    }
    $Writer.WriteLine($Line)
  }
}
finally {
  $Reader.Dispose()
  $Writer.Dispose()
}
$ActualSkippedCopyTables = (($SkippedCopyTables | Sort-Object) -join '|')
$ExpectedSkippedCopyTables = (($SkipCopyTables | Sort-Object) -join '|')
if ($SkippingCopy -or $ActualSkippedCopyTables -cne $ExpectedSkippedCopyTables) {
  if (Test-Path -LiteralPath $RestoreDataPath -PathType Leaf) {
    Remove-Item -LiteralPath $RestoreDataPath -Force
  }
  $RestoreDataPath = $null
  throw "The platform-metadata COPY filter did not remove exactly the reviewed table set."
}
$FilteredDataSha256 = (Get-FileHash -LiteralPath $RestoreDataPath -Algorithm SHA256).Hash.ToLowerInvariant()

$TargetUser = "postgres.$TargetProjectRef"
$DatabaseName = "postgres"
$PasswordPointer = [IntPtr]::Zero
try {
  if ($UsePasswordFromEnvironment) {
    if ([string]::IsNullOrWhiteSpace($env:SUPABASE_DB_PASSWORD)) {
      throw "SUPABASE_DB_PASSWORD must already be set in the current process."
    }
    $env:PGPASSWORD = $env:SUPABASE_DB_PASSWORD
  }
  else {
    $SecurePassword = Read-Host "Enter the disposable Supabase database password" -AsSecureString
    $PasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
    $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($PasswordPointer)
  }
  if ([string]::IsNullOrWhiteSpace($env:PGPASSWORD)) {
    throw "The disposable database password is required."
  }

  $ConnectionArgs = @(
    "--host=$TargetHost", "--port=$TargetPort", "--username=$TargetUser", "--dbname=$DatabaseName",
    "--set=ON_ERROR_STOP=1"
  )
  $IdentitySql = "select jsonb_build_object('database', current_database(), 'current_user', current_user, 'server_version', current_setting('server_version'))::text;"
  $IdentityOutput = & $Psql @ConnectionArgs --quiet --tuples-only --no-align "--command=$IdentitySql"
  if ($LASTEXITCODE -ne 0) { throw "Disposable target identity connection failed." }
  $Identity = (($IdentityOutput | Where-Object { $_ -match '^\{' }) | Select-Object -Last 1) | ConvertFrom-Json
  if ($Identity.database -ne "postgres" -or [string]$Identity.current_user -notin @("postgres", $TargetUser)) {
    throw "The connected database identity is not the guarded disposable target."
  }

  if (-not $VerifyOnly) {
    $ResetSql = @'
begin;
set local statement_timeout = '10min';
set local lock_timeout = '15s';
set local client_min_messages = warning;
drop schema if exists public cascade;
do $release_b_restore_reset$
declare
  target_table record;
begin
  for target_table in
    select schemaname, tablename
    from pg_catalog.pg_tables
    where schemaname in ('auth', 'storage')
      and not (schemaname = 'auth' and tablename = 'schema_migrations')
      and not (schemaname = 'storage' and tablename = 'migrations')
      and has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRUNCATE')
    order by schemaname, tablename
  loop
    execute format('truncate table %I.%I cascade', target_table.schemaname, target_table.tablename);
  end loop;
end
$release_b_restore_reset$;
commit;
'@
    & $Psql @ConnectionArgs "--command=$ResetSql"
    if ($LASTEXITCODE -ne 0) { throw "Disposable target reset failed." }

    & $Psql @ConnectionArgs --file=$SchemaPath
    if ($LASTEXITCODE -ne 0) { throw "Public schema restore failed." }

    & $Psql @ConnectionArgs --single-transaction "--command=SET session_replication_role = replica;" --file=$RestoreDataPath
    if ($LASTEXITCODE -ne 0) { throw "Public/auth/storage data restore failed." }
  }

  $RoleListSql = ($ExpectedManagedRoles | ForEach-Object { "'$_'" }) -join ', '
  $RoleSql = "select jsonb_agg(rolname order by rolname)::text from pg_catalog.pg_roles where rolname in ($RoleListSql);"
  $RoleOutput = & $Psql @ConnectionArgs --quiet --tuples-only --no-align "--command=$RoleSql"
  if ($LASTEXITCODE -ne 0) { throw "Managed-role verification failed." }
  $RestoredRoles = @(
    (($RoleOutput | Where-Object { $_ -match '^\[' } | Select-Object -Last 1) | ConvertFrom-Json) |
      ForEach-Object { [string]$_ }
  )
  $MissingManagedRoles = @($ExpectedManagedRoles | Where-Object { $_ -notin $RestoredRoles })
  if ($MissingManagedRoles.Count -gt 0) {
    throw "The disposable Supabase target does not provide the managed roles captured by the backup."
  }

  $VerificationOutput = & $Psql @ConnectionArgs --quiet --tuples-only --no-align --file=$BaselineSqlPath
  if ($LASTEXITCODE -ne 0) { throw "Restored database verification query failed." }
  $VerificationJson = $VerificationOutput | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
  if ([string]::IsNullOrWhiteSpace($VerificationJson)) {
    throw "Restored database verification returned no JSON baseline."
  }
  $Restored = $VerificationJson | ConvertFrom-Json

  $Failures = [System.Collections.Generic.List[string]]::new()
  if ($Restored.open_active_sessions -ne $Baseline.databaseDiscovery.openActiveSessions) { $Failures.Add("open_active_sessions") }
  if ($Restored.open_customer_tabs -ne $Baseline.databaseDiscovery.openCustomerTabs) { $Failures.Add("open_customer_tabs") }
  if ($Restored.app_state.version -ne $Baseline.databaseBaseline.appState.version) { $Failures.Add("app_state.version") }
  if ([int64]$Restored.app_state.bytes -le 0) { $Failures.Add("app_state.bytes_nonzero") }
  if ($Restored.app_state.data_hash -ne $Baseline.databaseBaseline.appState.dataHashSha256) { $Failures.Add("app_state.data_hash") }
  foreach ($Property in $Baseline.databaseBaseline.publicCounts.PSObject.Properties) {
    if ([int64]$Restored.public_counts.($Property.Name) -ne [int64]$Property.Value) { $Failures.Add("public_counts.$($Property.Name)") }
  }
  foreach ($Property in $Baseline.databaseBaseline.financialTotals.PSObject.Properties) {
    if ([decimal]$Restored.financial_totals.($Property.Name) -ne [decimal]$Property.Value) { $Failures.Add("financial_totals.$($Property.Name)") }
  }
  foreach ($Property in $Baseline.databaseBaseline.managedSchemaCounts.PSObject.Properties) {
    if ([int64]$Restored.managed_schema_counts.($Property.Name) -ne [int64]$Property.Value) { $Failures.Add("managed_schema_counts.$($Property.Name)") }
  }
  foreach ($Property in $Baseline.databaseBaseline.latestTimestamps.PSObject.Properties) {
    $ExpectedTimestamp = if ($null -eq $Property.Value) { $null } else { [DateTimeOffset]::Parse([string]$Property.Value) }
    $ActualValue = $Restored.latest_timestamps.($Property.Name)
    $ActualTimestamp = if ($null -eq $ActualValue) { $null } else { [DateTimeOffset]::Parse([string]$ActualValue) }
    if ($ExpectedTimestamp -ne $ActualTimestamp) { $Failures.Add("latest_timestamps.$($Property.Name)") }
  }
  if ($Failures.Count -gt 0) {
    throw "Restored database parity failed: $($Failures -join ', ')."
  }

  $Report = [ordered]@{
    schemaVersion = 1
    status = "passed"
    sourceProjectRef = $ExpectedSourceProjectRef
    targetProjectRef = $TargetProjectRef
    targetHost = $TargetHost
    completedAt = [DateTimeOffset]::UtcNow.ToString("o")
    sourceManifest = [ordered]@{
      path = (Resolve-Path -LiteralPath $ManifestPath -Relative).Replace('\', '/')
      sha256 = $ManifestSha256
      gitCommit = [string]$Manifest.gitCommit
      baselineSha256 = [string]$Manifest.baselineEvidence.sha256
    }
    restoreMode = [ordered]@{
      roles = "verified against Supabase-managed target roles; raw role DDL intentionally not replayed"
      publicSchema = "dropped and restored from public-schema.sql"
      managedData = "auth and storage tables truncated before one-transaction COPY restore"
      preservedPlatformMetadata = @("auth.schema_migrations", "storage.migrations")
      filteredRestoreDataSha256 = $FilteredDataSha256
      verificationOnlyResume = [bool]$VerifyOnly
      triggers = "session_replication_role=replica during data restore"
    }
    toolchain = [ordered]@{
      psqlVersion = $ExpectedPsqlVersion
      psqlSha256 = $ExpectedPsqlSha256
      archiveSha256 = $ExpectedArchiveSha256
    }
    checks = [ordered]@{
      targetGuardPassed = $true
      backupHashesPassed = $true
      managedRolesPassed = $true
      publicCountsPassed = $true
      financialTotalsPassed = $true
      managedSchemaCountsPassed = $true
      timestampsPassed = $true
      appStateIdentityPassed = $true
      appStateBytesNonZero = $true
      appStateByteSizeExact = ([int64]$Restored.app_state.bytes -eq [int64]$Baseline.databaseBaseline.appState.bytes)
      emptyFloorPassed = $true
    }
    restoredBaseline = $Restored
  }
  $ReportPath = Join-Path $ResolvedBackupDirectory "restore-drill-$TargetProjectRef.json"
  $Report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $ReportPath -Encoding utf8
  [ordered]@{
    status = "passed"
    targetProjectRef = $TargetProjectRef
    reportPath = $ReportPath
    reportSha256 = (Get-FileHash -LiteralPath $ReportPath -Algorithm SHA256).Hash.ToLowerInvariant()
    sourceManifestSha256 = $ManifestSha256
  } | ConvertTo-Json
}
finally {
  Remove-Item Env:SUPABASE_DB_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  if ($PasswordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($PasswordPointer)
  }
  if ($null -ne $RestoreDataPath) {
    $ResolvedRestoreDataPath = [System.IO.Path]::GetFullPath($RestoreDataPath)
    if ($ResolvedRestoreDataPath.StartsWith($RestoreTempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $ResolvedRestoreDataPath -PathType Leaf)) {
      Remove-Item -LiteralPath $ResolvedRestoreDataPath -Force
    }
  }
}
