[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArtifactRoot,
  [string]$ManifestPath = "config/windows-signing-manifest.json",
  [ValidateSet("signed", "unsigned-development")][string]$Mode = "signed",
  [string]$ExpectedSigner = $env:WINDOWS_EXPECTED_SIGNER,
  [string]$OutputPath = "windows-signature-verification.json"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $ArtifactRoot).Path
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) { throw "Unsupported signing manifest schema: $($manifest.schemaVersion)" }
if ($Mode -eq "signed" -and [string]::IsNullOrWhiteSpace($ExpectedSigner)) {
  throw "ExpectedSigner/WINDOWS_EXPECTED_SIGNER is required in signed mode"
}

$results = @()
$failed = $false
foreach ($entry in $manifest.required) {
  $nativePattern = ([string]$entry.pattern).Replace("/", [IO.Path]::DirectorySeparatorChar)
  $matches = @(Get-ChildItem -Path (Join-Path $root $nativePattern) -File -ErrorAction SilentlyContinue)
  if ($matches.Count -ne [int]$entry.exactly) {
    Write-Host "::error title=Signing manifest mismatch::$($entry.id) expected $($entry.exactly), found $($matches.Count): $($entry.pattern)"
    $failed = $true
    continue
  }

  foreach ($file in $matches) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    $signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    $timestampSigner = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null }
    $valid = $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid
    $signerMatches = $signer -and $signer.IndexOf($ExpectedSigner, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $timestamped = -not [string]::IsNullOrWhiteSpace($timestampSigner)
    $accepted = if ($Mode -eq "signed") {
      $valid -and $signerMatches -and $timestamped
    } else {
      $signature.Status -eq [System.Management.Automation.SignatureStatus]::NotSigned
    }

    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $relative = $file.FullName.Substring($root.Length).TrimStart("\", "/").Replace("\", "/")
    $results += [ordered]@{
      id = [string]$entry.id
      path = $relative
      bytes = $file.Length
      sha256 = $hash
      status = [string]$signature.Status
      signer = $signer
      timestampSigner = $timestampSigner
      accepted = $accepted
    }
    if (-not $accepted) {
      $failed = $true
      Write-Host "::error file=$relative,title=Authenticode verification failed::mode=$Mode status=$($signature.Status) signer=$signer timestampSigner=$timestampSigner"
    } else {
      Write-Host "Verified $relative ($Mode, sha256:$hash)"
    }
  }
}

$report = [ordered]@{
  schemaVersion = 1
  mode = $Mode
  expectedSigner = if ($Mode -eq "signed") { $ExpectedSigner } else { $null }
  rfc3161TimestampRequired = $Mode -eq "signed"
  commit = $env:GITHUB_SHA
  generatedAt = [DateTime]::UtcNow.ToString("o")
  artifacts = $results
  passed = -not $failed
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
if ($failed) { throw "Windows signature verification failed; see $OutputPath" }
