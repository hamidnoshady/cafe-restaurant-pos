[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceArchive,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$SourceSha256,
  [Parameter(Mandatory = $true)][string]$ZlibSourceArchive,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ZlibSourceSha256,
  [string]$PostgresVersion = "16.15",
  [string]$ZlibVersion = "1.3.2",
  [string]$OutputDirectory = "controlled-input",
  [string]$Organization = ""
)

$ErrorActionPreference = "Stop"
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
  throw "The controlled PostgreSQL tools build requires Windows x64"
}
if ($PostgresVersion -notmatch '^16\.\d+$') { throw "Only an exact PostgreSQL 16 patch release is allowed" }
if ($ZlibVersion -notmatch '^1\.\d+\.\d+$') { throw "An exact zlib 1.x patch release is required" }

$sourcePath = (Resolve-Path -LiteralPath $SourceArchive).Path
$actualSourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSourceHash -cne $SourceSha256) {
  throw "Pinned PostgreSQL source SHA-256 mismatch: expected $SourceSha256, got $actualSourceHash"
}
$zlibSourcePath = (Resolve-Path -LiteralPath $ZlibSourceArchive).Path
$actualZlibSourceHash = (Get-FileHash -LiteralPath $zlibSourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualZlibSourceHash -cne $ZlibSourceSha256) {
  throw "Pinned zlib source SHA-256 mismatch: expected $ZlibSourceSha256, got $actualZlibSourceHash"
}

$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
New-Item -ItemType Directory -Path $output | Out-Null
$buildLog = Join-Path $output "source-build.log"
function Write-BuildTrace([string]$Message) {
  "[$([DateTime]::UtcNow.ToString('o'))] $Message" | Out-File -LiteralPath $buildLog -Encoding utf8 -Append
}
Write-BuildTrace "Pinned PostgreSQL and zlib source hashes verified; preparing PostgreSQL $PostgresVersion x64 Release build"
$temp = Join-Path ([IO.Path]::GetTempPath()) "business-suite-pg-source-$([Guid]::NewGuid().ToString('N'))"
$extract = Join-Path $temp "postgresql-source"
$zlibExtract = Join-Path $temp "zlib-source"
$zlibPrefix = Join-Path $temp "zlib-dependency"
$payload = Join-Path $temp "payload"
New-Item -ItemType Directory -Path $extract, $zlibExtract, (Join-Path $zlibPrefix "include"), (Join-Path $zlibPrefix "lib"), (Join-Path $payload "bin") -Force | Out-Null

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
  Write-BuildTrace "Pinned source archive extracted"

  $sourceRoot = Join-Path $extract "postgresql-$PostgresVersion"
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot "src/tools/msvc/build.pl"))) {
    throw "Pinned archive does not contain the expected PostgreSQL $PostgresVersion source tree"
  }

  $zlibListing = @(& tar -tf $zlibSourcePath)
  if ($LASTEXITCODE -ne 0) { throw "Could not list the pinned zlib source archive" }
  foreach ($entry in $zlibListing) {
    $normalized = $entry.Replace("\", "/")
    if ($normalized.StartsWith("/") -or $normalized -eq ".." -or $normalized.StartsWith("../") -or $normalized.Contains("/../")) {
      throw "Unsafe path in zlib source archive: $entry"
    }
  }
  & tar -xf $zlibSourcePath -C $zlibExtract
  if ($LASTEXITCODE -ne 0) { throw "Could not extract the pinned zlib source archive" }
  $zlibRoot = Join-Path $zlibExtract "zlib-$ZlibVersion"
  if (-not (Test-Path -LiteralPath (Join-Path $zlibRoot "win32/Makefile.msc"))) {
    throw "Pinned archive does not contain the expected zlib $ZlibVersion source tree"
  }
  Write-BuildTrace "Pinned zlib source archive extracted"

  # Keep the client payload minimal and self-contained for loopback desktop
  # backups. Include pinned zlib so custom-format backups preserve PostgreSQL's
  # normal gzip compression; leave unrelated OpenSSL/NLS/etc. inputs disabled.
  # LDAP is explicitly disabled because the desktop database is loopback-only.
  $perlZlibPrefix = $zlibPrefix.Replace("\", "/")
  @"
`$config->{ldap} = 0;
`$config->{zlib} = '$perlZlibPrefix';
1;
"@ | Set-Content -LiteralPath (Join-Path $sourceRoot "src/tools/msvc/config.pl") -Encoding ASCII

  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswhere)) { throw "Visual Studio locator is unavailable" }
  $vsInstall = (& $vswhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1).Trim()
  if ([string]::IsNullOrWhiteSpace($vsInstall) -or -not (Test-Path -LiteralPath (Join-Path $vsInstall "Common7/Tools/VsDevCmd.bat"))) {
    throw "Visual Studio with the x64 C++ build tools is unavailable"
  }
  Write-BuildTrace "Visual Studio locator found; invoking PostgreSQL MSVC build"
  $buildCmd = Join-Path $temp "build-postgresql-client.cmd"
  $buildText = @"
@echo off
setlocal
call "$vsInstall\Common7\Tools\VsDevCmd.bat" -no_logo -arch=x64 -host_arch=x64
if errorlevel 1 exit /b 22
where perl >nul 2>nul
if errorlevel 1 exit /b 23
cd /d "$zlibRoot"
nmake /nologo /f win32\Makefile.msc zlib1.dll
if errorlevel 1 exit /b 24
copy /y zlib.h "$zlibPrefix\include\zlib.h" >nul
if errorlevel 1 exit /b 25
copy /y zconf.h "$zlibPrefix\include\zconf.h" >nul
if errorlevel 1 exit /b 25
copy /y zdll.lib "$zlibPrefix\lib\zdll.lib" >nul
if errorlevel 1 exit /b 25
cd /d "$sourceRoot"
set "MSBFLAGS=/m /p:Platform=x64"
perl src\tools\msvc\build.pl Release pg_dump
if errorlevel 1 exit /b 26
perl src\tools\msvc\build.pl Release pg_restore
if errorlevel 1 exit /b 27
exit /b 0
"@
  [IO.File]::WriteAllText($buildCmd, $buildText, (New-Object System.Text.UTF8Encoding($false)))
  & $env:ComSpec /d /c "`"$buildCmd`"" 2>&1 | Tee-Object -FilePath $buildLog
  $buildExit = $LASTEXITCODE
  if ($buildExit -ne 0) {
    $tail = @(Get-Content -LiteralPath $buildLog -Tail 80 -ErrorAction SilentlyContinue) -join "`n"
    throw "PostgreSQL MSVC client build failed with exit code $buildExit`n$tail"
  }

  $releaseRoot = Join-Path $sourceRoot "Release"
  $executables = foreach ($name in @("pg_dump.exe", "pg_restore.exe")) {
    $matches = @(Get-ChildItem -LiteralPath $releaseRoot -Recurse -File -Filter $name)
    if ($matches.Count -ne 1) { throw "Expected one built $name, found $($matches.Count)" }
    $matches[0]
  }
  $libraries = @(Get-ChildItem -LiteralPath $releaseRoot -Recurse -File -Filter "*.dll")
  if (-not ($libraries.Name -contains "libpq.dll")) { throw "The controlled build did not produce libpq.dll" }
  $zlibRuntime = Get-Item -LiteralPath (Join-Path $zlibRoot "zlib1.dll")

  $selected = @($executables) + @($libraries) + @($zlibRuntime)
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
  $sourceBuild = "PostgreSQL $PostgresVersion official source sha256:$SourceSha256; zlib $ZlibVersion official source sha256:$ZlibSourceSha256; MSVC x64 Release"
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
    zlibVersion = $ZlibVersion
    zlibSourceUrl = "https://github.com/madler/zlib/releases/download/v$ZlibVersion/zlib-$ZlibVersion.tar.gz"
    zlibSourceSha256 = $ZlibSourceSha256
    compression = "gzip"
    artifactSha256 = $archiveHash
    files = @($files | ForEach-Object path)
    generatedAt = [DateTime]::UtcNow.ToString("o")
  } | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText((Join-Path $output "source-build.json"), "$buildResult`n", $utf8NoBom)

  Write-Host "Controlled PostgreSQL tools build passed: $PostgresVersion; $($files.Count) files; archive sha256:$archiveHash"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
