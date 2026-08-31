[CmdletBinding()]
param(
  [string]$OutputRoot = "production-backups",
  [Parameter(Mandatory = $true)]
  [string]$BaselineEvidencePath,
  [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$ProjectRef = "rrdwbxvuwrbxefarxnse"
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
$WorkDirectory = Join-Path $BackupDirectory "supabase-cli-workdir"
$SupabaseDirectory = Join-Path $WorkDirectory "supabase"
New-Item -ItemType Directory -Path $SupabaseDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectRoot "supabase\config.toml") -Destination (Join-Path $SupabaseDirectory "config.toml")

$SecurePassword = Read-Host "Enter the production Supabase database password" -AsSecureString
$PasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
try {
  $env:SUPABASE_DB_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($PasswordPointer)
  if ([string]::IsNullOrWhiteSpace($env:SUPABASE_DB_PASSWORD)) {
    throw "The production database password is required."
  }

  & npx supabase link --project-ref $ProjectRef --workdir $WorkDirectory --yes
  if ($LASTEXITCODE -ne 0) { throw "Supabase production link failed." }

  & npx supabase db dump --linked --workdir $WorkDirectory --role-only --file (Join-Path $BackupDirectory "roles.sql")
  if ($LASTEXITCODE -ne 0) { throw "Supabase role backup failed." }

  & npx supabase db dump --linked --workdir $WorkDirectory --schema public --file (Join-Path $BackupDirectory "public-schema.sql")
  if ($LASTEXITCODE -ne 0) { throw "Supabase public schema backup failed." }

  & npx supabase db dump --linked --workdir $WorkDirectory --data-only --use-copy --schema public,auth,storage --exclude storage.buckets_vectors --exclude storage.vector_indexes --file (Join-Path $BackupDirectory "public-auth-storage-data.sql")
  if ($LASTEXITCODE -ne 0) { throw "Supabase public/auth/storage data backup failed." }
}
finally {
  Remove-Item Env:SUPABASE_DB_PASSWORD -ErrorAction SilentlyContinue
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
