[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArtifactRoot,
  [int]$RequiredNodeMajor = 24,
  [int]$MinimumElectronMajor = 44,
  [string]$OutputPath = "packaged-electron-runtime.json"
)

$ErrorActionPreference = "Stop"
function Stop-RuntimeVerification([string]$Message) {
  Write-Host "::error title=Packaged Electron runtime verification::$Message"
  throw $Message
}

$root = (Resolve-Path -LiteralPath $ArtifactRoot).Path
$executables = @(Get-ChildItem -LiteralPath $root -File -Filter "*.exe" | Where-Object { $_.Name -ne "Uninstall Business Suite.exe" })
if ($executables.Count -ne 1) {
  Stop-RuntimeVerification "Expected exactly one packaged application executable in $root, found $($executables.Count): $($executables.Name -join ', ')"
}
$executablePath = $executables[0].FullName
$probePath = Join-Path ([IO.Path]::GetTempPath()) "business-suite-electron-runtime-$([Guid]::NewGuid().ToString('N')).cjs"
$probeSource = 'process.stdout.write(JSON.stringify({node:process.versions.node,electron:process.versions.electron,chrome:process.versions.chrome}))'
[IO.File]::WriteAllText($probePath, $probeSource, (New-Object System.Text.UTF8Encoding($false)))

$prior = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE = "1"
  $raw = ((& $executablePath $probePath) | Out-String).Trim()
  $probeExit = $LASTEXITCODE
} finally {
  if ($null -eq $prior) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  } else {
    $env:ELECTRON_RUN_AS_NODE = $prior
  }
  Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
}
if ($probeExit -ne 0) {
  Stop-RuntimeVerification "Packaged Electron runtime probe failed with exit code $probeExit"
}

try {
  $versions = $raw | ConvertFrom-Json
} catch {
  Stop-RuntimeVerification "Packaged Electron runtime returned invalid version JSON: $raw"
}

$nodeMajor = if ($versions.node -match '^(\d+)\.') { [int]$Matches[1] } else { -1 }
$electronMajor = if ($versions.electron -match '^(\d+)\.') { [int]$Matches[1] } else { -1 }
if ($nodeMajor -ne $RequiredNodeMajor) {
  Stop-RuntimeVerification "Packaged Electron must carry Node.js $RequiredNodeMajor.x, found $($versions.node)"
}
if ($electronMajor -lt $MinimumElectronMajor) {
  Stop-RuntimeVerification "Packaged Electron must be $MinimumElectronMajor.x or newer, found $($versions.electron)"
}

$report = [ordered]@{
  schemaVersion = 1
  status = "PASS"
  executable = $executables[0].Name
  node = $versions.node
  electron = $versions.electron
  chromium = $versions.chrome
  requiredNodeMajor = $RequiredNodeMajor
  minimumElectronMajor = $MinimumElectronMajor
  verifiedAt = [DateTime]::UtcNow.ToString("o")
}
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Host "Packaged runtime: Electron $($versions.electron), Node.js $($versions.node), Chromium $($versions.chrome)"
