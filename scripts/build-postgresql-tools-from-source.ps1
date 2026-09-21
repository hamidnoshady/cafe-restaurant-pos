[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceArchive,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$SourceSha256,
  [string]$PostgresVersion = "16.15",
  [string]$OutputDirectory = "controlled-input",
  [string]$Organization = ""
)

$ErrorActionPreference = "Stop"
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
  throw "The controlled PostgreSQL tools build requires Windows x64"
}
if ($PostgresVersion -notmatch '^16\.\d+$') { throw "Only an exact PostgreSQL 16 patch release is allowed" }

$sourcePath = (Resolve-Path -LiteralPath $SourceArchive).Path
$actualSourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSourceHash -cne $SourceSha256) {
  throw "Pinned PostgreSQL source SHA-256 mismatch: expected $SourceSha256, got $actualSourceHash"
}

$output = [IO.Path]::GetFullPath($OutputDirectory)
$temp = Join-Path ([IO.Path]::GetTempPath()) "business-suite-pg-source-$([Guid]::NewGuid().ToString('N'))"
$extract = Join-Path $temp "source"
$payload = Join-Path $temp "payload"
New-Item -ItemType Directory -Path $extract, (Join-Path $payload "bin") -Force | Out-Null

try {
  $listing = @(& tar -tf $sourcePath)
  if ($LASTEXITCODE -ne 0) { throw "Could not list the pinned PostgreSQL source archive" }
  foreach ($entry in $listing) {
    $normalized = $entry.Replace("\", "/")
    if ($normalized.StartsWith("/") -or $normalized -eq ".." -or $normalized.StartsWith("../") -or $normalized.Contains("/../")) {
      throw "Unsafe path in PostgreSQL source archive: $entry"
    }
  }
  & tar -xf $sourcePath -C $extract
  if ($LASTEXITCODE -ne 0) { throw "Could not extract the pinned PostgreSQL source archive" }

  $sourceRoot = Join-Path $extract "postgresql-$PostgresVersion"
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot "src/tools/msvc/build.pl"))) {
    throw "Pinned archive does not contain the expected PostgreSQL $PostgresVersion source tree"
  }

  # Keep the client payload minimal and self-contained for loopback desktop
  # backups. Optional OpenSSL/zlib/NLS/etc. inputs remain disabled by upstream's
  # default configuration; LDAP is explicitly disabled to avoid an unused DLL
  # dependency. Custom-format backup itself does not require compression.
  @'
$config->{ldap} = 0;
1;
'@ | Set-Content -LiteralPath (Join-Path $sourceRoot "src/tools/msvc/config.pl") -Encoding ASCII

  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswhere)) { throw "Visual Studio locator is unavailable" }
  $buildCmd = Join-Path $temp "build-postgresql-client.cmd"
  $buildText = @"
@echo off
setlocal
for /f "usebackq tokens=*" %%I in (`"$vswhere" -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%I"
if not defined VSINSTALL exit /b 21
call "%VSINSTALL%\Common7\Tools\VsDevCmd.bat" -no_logo -arch=x64 -host_arch=x64
if errorlevel 1 exit /b 22
where perl >nul 2>nul
if errorlevel 1 exit /b 23
cd /d "$sourceRoot"
set "MSBFLAGS=/m"
perl src\tools\msvc\build.pl Release pg_dump
if errorlevel 1 exit /b 24
perl src\tools\msvc\build.pl Release pg_restore
if errorlevel 1 exit /b 25
exit /b 0
"@
  [IO.File]::WriteAllText($buildCmd, $buildText, (New-Object System.Text.UTF8Encoding($false)))
  & $env:ComSpec /d /c "`"$buildCmd`""
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL MSVC client build failed with exit code $LASTEXITCODE" }

  $releaseRoot = Join-Path $sourceRoot "Release"
  $executables = foreach ($name in @("pg_dump.exe", "pg_restore.exe")) {
    $matches = @(Get-ChildItem -LiteralPath $releaseRoot -Recurse -File -Filter $name)
    if ($matches.Count -ne 1) { throw "Expected one built $name, found $($matches.Count)" }
    $matches[0]
  }
  $libraries = @(Get-ChildItem -LiteralPath $releaseRoot -Recurse -File -Filter "*.dll")
  if (-not ($libraries.Name -contains "libpq.dll")) { throw "The controlled build did not produce libpq.dll" }

  $selected = @($executables) + @($libraries)
  $duplicateNames = @($selected | Group-Object Name | Where-Object Count -gt 1)
  if ($duplicateNames.Count) { throw "Controlled build produced ambiguous DLL names: $($duplicateNames.Name -join ', ')" }
  foreach ($file in $selected) {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $payload "bin/$($file.Name)")
  }

  foreach ($tool in @("pg_dump.exe", "pg_restore.exe")) {
    $reported = & (Join-Path $payload "bin/$tool") --version
    if ($LASTEXITCODE -ne 0 -or $reported -notmatch [regex]::Escape("$PostgresVersion")) {
      throw "$tool did not execute as the pinned PostgreSQL $PostgresVersion build: $reported"
    }
  }

  if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
  New-Item -ItemType Directory -Path $output | Out-Null
  $archivePath = Join-Path $output "postgresql-16-windows-x64-client-tools.zip"
  Compress-Archive -Path (Join-Path $payload "*") -DestinationPath $archivePath -CompressionLevel Optimal
  $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()

  $files = foreach ($file in Get-ChildItem -LiteralPath (Join-Path $payload "bin") -File | Sort-Object Name) {
    [ordered]@{
      source = "bin/$($file.Name)"
      path = "bin/$($file.Name)"
      sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      bytes = $file.Length
    }
  }
  $owner = if ([string]::IsNullOrWhiteSpace($Organization)) {
    if ([string]::IsNullOrWhiteSpace($env:GITHUB_REPOSITORY_OWNER)) { "controlled-source-build" } else { $env:GITHUB_REPOSITORY_OWNER }
  } else { $Organization }
  $sourceBuild = "PostgreSQL $PostgresVersion official source postgresql-$PostgresVersion.tar.gz sha256:$SourceSha256; MSVC x64 Release"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $provenance = [ordered]@{
    schemaVersion = 1
    postgresVersion = $PostgresVersion
    postgresMajor = 16
    artifact = [ordered]@{
      organization = $owner
      name = "postgresql-16-windows-x64-client-tools"
      sha256 = $archiveHash
      sourceBuild = $sourceBuild
    }
    files = $files
  } | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText((Join-Path $output "provenance.json"), "$provenance`n", $utf8NoBom)
  $buildResult = [ordered]@{
    schemaVersion = 1
    status = "PASS"
    postgresVersion = $PostgresVersion
    sourceUrl = "https://ftp.postgresql.org/pub/source/v$PostgresVersion/postgresql-$PostgresVersion.tar.gz"
    sourceSha256 = $SourceSha256
    artifactSha256 = $archiveHash
    files = @($files | ForEach-Object path)
    generatedAt = [DateTime]::UtcNow.ToString("o")
  } | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText((Join-Path $output "source-build.json"), "$buildResult`n", $utf8NoBom)

  Write-Host "Controlled PostgreSQL tools build passed: $PostgresVersion; $($files.Count) files; archive sha256:$archiveHash"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
