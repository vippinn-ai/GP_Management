[CmdletBinding()]
param(
  [string]$OutputRoot = "production-backups",
  [Parameter(Mandatory = $true)]
  [string]$BaselineEvidencePath,
  [switch]$ValidateOnly,
  [switch]$UsePasswordFromEnvironment
)

$ErrorActionPreference = "Stop"
$ProjectRef = "rrdwbxvuwrbxefarxnse"
$DatabaseHost = "aws-1-ap-southeast-2.pooler.supabase.com"
$DatabasePort = "5432"
$DatabaseName = "postgres"
$DatabaseUser = "postgres.$ProjectRef"
$PortableArchiveRelativePath = "test-artifacts\tools\postgresql-17.11-1-windows-x64-binaries.zip"
$PortableArchiveSha256 = "6eabdf00d2893713b75db4336a23c3fdf505f056e217ec6e2e95d901750cfea3"
$PgDumpSha256 = "ff766351cc88b0ea2bc7b6e365777cb51f792b16000688a378f64124810ffa88"
$PgDumpAllSha256 = "25ac39cfdac4eb7a24eb384eed52521820ec38515517042c7ddea1a05bb48a0d"
$ExpectedPgDumpVersion = "pg_dump (PostgreSQL) 17.11"
$ExpectedPgDumpAllVersion = "pg_dumpall (PostgreSQL) 17.11"
$ExpectedBaselineSqlSha256 = "650d67292814417f168dcc33f61C6D930D5493D3C6096F80341BE940A22EF2C8".ToLowerInvariant()
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ResolvedOutputRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $OutputRoot))
$AllowedOutputRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "production-backups"))
$AllowedOutputPrefix = $AllowedOutputRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (
  -not $ResolvedOutputRoot.Equals($AllowedOutputRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
  -not $ResolvedOutputRoot.StartsWith($AllowedOutputPrefix, [System.StringComparison]::OrdinalIgnoreCase)
) {
  throw "Production backup output must remain under the ignored production-backups directory."
}

$BackupStartedAt = [DateTimeOffset]::UtcNow
$Timestamp = $BackupStartedAt.ToString("yyyyMMddTHHmmssZ")
$BaselineFullPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $BaselineEvidencePath))
$AllowedEvidenceRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "test-artifacts\evidence"))
$AllowedEvidencePrefix = $AllowedEvidenceRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $BaselineFullPath.StartsWith($AllowedEvidencePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Baseline evidence must remain under test-artifacts/evidence."
}
if (-not (Test-Path -LiteralPath $BaselineFullPath -PathType Leaf)) {
  throw "Fresh production baseline evidence is required before backup."
}
$VerifierPath = Join-Path $ProjectRoot "scripts\release-b-production-baseline-verifier.mjs"
$VerifierOutput = & node $VerifierPath "--baseline-evidence=$BaselineFullPath"
if ($LASTEXITCODE -ne 0) {
  throw "Production baseline raw-export lineage verification failed."
}
$Verifier = ($VerifierOutput | Out-String) | ConvertFrom-Json
if ($Verifier.status -ne "passed") {
  throw "Production baseline raw-export lineage verification did not pass."
}
$Baseline = Get-Content -LiteralPath $BaselineFullPath -Raw | ConvertFrom-Json
$BaselineCapturedAt = [DateTimeOffset]::Parse([string]$Baseline.capturedAt)
$BaselineAge = $BackupStartedAt - $BaselineCapturedAt
if ($BaselineAge.TotalMinutes -lt -2 -or $BaselineAge.TotalMinutes -gt 15) {
  throw "Production baseline evidence must be captured within 15 minutes before backup starts."
}
if (
  $Baseline.schemaVersion -ne 2 -or
  $Baseline.status -ne "passed" -or
  $Baseline.provenance.captureMethod -ne "supabase-sql-editor-copy-as-json" -or
  $Baseline.provenance.baselineSql.path -ne "supabase/release-b-production-baseline-readonly.sql" -or
  $Baseline.provenance.baselineSql.sha256 -ne $ExpectedBaselineSqlSha256 -or
  [string]$Baseline.provenance.rawExport.path -eq "" -or
  [string]$Baseline.provenance.rawExport.sha256 -notmatch '^[0-9a-f]{64}$' -or
  [string]$Baseline.provenance.rawExport.fileSha256 -notmatch '^[0-9a-f]{64}$' -or
  [string]$Baseline.provenance.dashboardUrl -notlike "*/dashboard/project/$ProjectRef/sql*" -or
  [string]$Baseline.provenance.dashboardTitle -notlike "*breakperfect-production*" -or
  $Baseline.environment -ne "production" -or
  $Baseline.projectRef -ne $ProjectRef -or
  $Baseline.productionWritePerformed -ne $false -or
  $Baseline.databaseBaseline.transactionReadOnly -ne $true -or
  $Baseline.databaseDiscovery.openActiveSessions -ne 0 -or
  $Baseline.databaseDiscovery.openCustomerTabs -ne 0 -or
  [string]$Baseline.databaseBaseline.appState.dataHashSha256 -notmatch '^[0-9a-f]{64}$'
) {
  throw "Baseline evidence does not prove the exact read-only, empty-floor production state."
}
$BaselineSha256 = (Get-FileHash -LiteralPath $BaselineFullPath -Algorithm SHA256).Hash.ToLowerInvariant()

if ($ValidateOnly) {
  [ordered]@{
    status = "passed"
    productionAccessed = $false
    productionWritePerformed = $false
    baselineEvidenceSha256 = $BaselineSha256
    baselineSqlSha256 = [string]$Baseline.provenance.baselineSql.sha256
    rawExportSha256 = [string]$Baseline.provenance.rawExport.sha256
    rawExportFileSha256 = [string]$Baseline.provenance.rawExport.fileSha256
    rawLineageReverified = $true
    capturedAt = $BaselineCapturedAt.ToString("o")
  } | ConvertTo-Json
  return
}

$BackupDirectory = Join-Path $ResolvedOutputRoot "release-b-$Timestamp"
$PortableArchive = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $PortableArchiveRelativePath))
$ResolvedPgBin = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "test-artifacts\tools\postgresql-17.11\pgsql\bin"))
$PgDump = Join-Path $ResolvedPgBin "pg_dump.exe"
$PgDumpAll = Join-Path $ResolvedPgBin "pg_dumpall.exe"
$ToolFiles = @($PortableArchive, $PgDump, $PgDumpAll)
if ($ToolFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }) {
  throw "The pinned official PostgreSQL 17.11 archive and client binaries are required for backup."
}
$ActualPortableArchiveSha256 = (Get-FileHash -LiteralPath $PortableArchive -Algorithm SHA256).Hash.ToLowerInvariant()
$ActualPgDumpSha256 = (Get-FileHash -LiteralPath $PgDump -Algorithm SHA256).Hash.ToLowerInvariant()
$ActualPgDumpAllSha256 = (Get-FileHash -LiteralPath $PgDumpAll -Algorithm SHA256).Hash.ToLowerInvariant()
$ActualPgDumpVersion = (& $PgDump --version).Trim()
$ActualPgDumpAllVersion = (& $PgDumpAll --version).Trim()
if (
  $ActualPortableArchiveSha256 -ne $PortableArchiveSha256 -or
  $ActualPgDumpSha256 -ne $PgDumpSha256 -or
  $ActualPgDumpAllSha256 -ne $PgDumpAllSha256 -or
  $ActualPgDumpVersion -ne $ExpectedPgDumpVersion -or
  $ActualPgDumpAllVersion -ne $ExpectedPgDumpAllVersion
) {
  throw "The PostgreSQL backup toolchain does not match the pinned official 17.11 release."
}
New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
$RolesPath = Join-Path $BackupDirectory "roles.sql"
$SchemaPath = Join-Path $BackupDirectory "public-schema.sql"
$DataPath = Join-Path $BackupDirectory "public-auth-storage-data.sql"

$PasswordPointer = [IntPtr]::Zero
try {
  if ($UsePasswordFromEnvironment) {
    if ([string]::IsNullOrWhiteSpace($env:SUPABASE_DB_PASSWORD)) {
      throw "SUPABASE_DB_PASSWORD must already be set in the current process."
    }
    $env:PGPASSWORD = $env:SUPABASE_DB_PASSWORD
  }
  else {
    $SecurePassword = Read-Host "Enter the production Supabase database password" -AsSecureString
    $PasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
    $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($PasswordPointer)
  }
  if ([string]::IsNullOrWhiteSpace($env:PGPASSWORD)) {
    throw "The production database password is required."
  }

  & $PgDumpAll --host=$DatabaseHost --port=$DatabasePort --username=$DatabaseUser --database=$DatabaseName --roles-only --no-role-passwords --file=$RolesPath
  if ($LASTEXITCODE -ne 0) { throw "Supabase role backup failed." }

  & $PgDump --host=$DatabaseHost --port=$DatabasePort --username=$DatabaseUser --dbname=$DatabaseName --schema-only --no-owner --no-privileges --schema=public --file=$SchemaPath
  if ($LASTEXITCODE -ne 0) { throw "Supabase public schema backup failed." }

  & $PgDump --host=$DatabaseHost --port=$DatabasePort --username=$DatabaseUser --dbname=$DatabaseName --data-only --no-owner --no-privileges --schema=public --schema=auth --schema=storage --exclude-table=storage.buckets_vectors --exclude-table=storage.vector_indexes --file=$DataPath
  if ($LASTEXITCODE -ne 0) { throw "Supabase public/auth/storage data backup failed." }
}
finally {
  Remove-Item Env:SUPABASE_DB_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  if ($PasswordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($PasswordPointer)
  }
}

$BackupFiles = Get-ChildItem -LiteralPath $BackupDirectory -File | Sort-Object Name
if ($BackupFiles.Count -ne 3 -or ($BackupFiles | Where-Object Length -le 0)) {
  throw "Backup is incomplete or contains an empty dump file."
}

$GitCommit = (& git -c "safe.directory=$($ProjectRoot.Replace('\','/'))" rev-parse HEAD).Trim()
$Manifest = [ordered]@{
  schemaVersion = 1
  projectRef = $ProjectRef
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  gitCommit = $GitCommit
  sourceConnection = [ordered]@{
    host = $DatabaseHost
    port = $DatabasePort
    database = $DatabaseName
    user = $DatabaseUser
  }
  postgresClient = [ordered]@{
    archivePath = $PortableArchiveRelativePath.Replace('\','/')
    archiveSha256 = $ActualPortableArchiveSha256
    pgDumpVersion = $ActualPgDumpVersion
    pgDumpSha256 = $ActualPgDumpSha256
    pgDumpAllVersion = $ActualPgDumpAllVersion
    pgDumpAllSha256 = $ActualPgDumpAllSha256
  }
  includes = @("public schema", "public data", "auth data", "storage metadata", "roles")
  excludes = @("Supabase-managed migration history", "Storage object binaries")
  baselineEvidence = [ordered]@{
    path = $BaselineEvidencePath.Replace('\','/')
    sha256 = $BaselineSha256
    capturedAt = $BaselineCapturedAt.ToString("o")
    ageMinutesAtBackupStart = [Math]::Round($BaselineAge.TotalMinutes, 3)
    projectRef = [string]$Baseline.projectRef
    appStateVersion = [int64]$Baseline.databaseBaseline.appState.version
    appStateDataHashSha256 = [string]$Baseline.databaseBaseline.appState.dataHashSha256
    baselineSqlSha256 = [string]$Baseline.provenance.baselineSql.sha256
    rawExportPath = [string]$Baseline.provenance.rawExport.path
    rawExportSha256 = [string]$Baseline.provenance.rawExport.sha256
    rawExportFileSha256 = [string]$Baseline.provenance.rawExport.fileSha256
    rawLineageReverified = $true
    dashboardUrl = [string]$Baseline.provenance.dashboardUrl
  }
  files = @($BackupFiles | ForEach-Object {
    [ordered]@{
      name = $_.Name
      bytes = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  })
  validation = [ordered]@{
    allFilesPresent = $true
    allFilesNonEmpty = $true
    hashesRecorded = $true
    restoreDrillCompleted = $false
  }
}
$ManifestPath = Join-Path $BackupDirectory "manifest.json"
$Manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ManifestPath -Encoding utf8
Write-Output "Production backup captured at $BackupDirectory"
Write-Output "Manifest: $ManifestPath"
Write-Output "Restore drill remains a separate required verification before claiming disaster-recovery readiness."
