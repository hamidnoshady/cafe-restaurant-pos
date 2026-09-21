[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$AcceptanceCode,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$')][string]$ReleaseVersion,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$CandidateCommit,
  [string]$OutputPath = "physical-printer-delivery.json"
)

$ErrorActionPreference = "Stop"
$printer = Get-Printer -Name $PrinterName -ErrorAction Stop
$driver = Get-PrinterDriver -Name $printer.DriverName -ErrorAction SilentlyContinue
$port = Get-PrinterPort -Name $printer.PortName -ErrorAction SilentlyContinue
$virtualPattern = 'PDF|XPS|OneNote|Fax|Microsoft Print|Adobe PDF|CutePDF|doPDF|FILE:'
if (($printer.Name + " " + $printer.DriverName + " " + $printer.PortName) -match $virtualPattern) {
  throw "Virtual/file printer is not physical acceptance: $($printer.Name), $($printer.DriverName), $($printer.PortName)"
}
if ($printer.PrinterStatus -in @('Offline', 'Error')) { throw "Printer is $($printer.PrinterStatus)" }

$origin = "https://physical-printer.acceptance.invalid"
$connector = (Resolve-Path "public/windows/cafe-pos-print-connector.ps1").Path
$connectorSha256 = (Get-FileHash -LiteralPath $connector -Algorithm SHA256).Hash.ToLowerInvariant()
$existingListeners = @(Get-NetTCPConnection -LocalPort 9123 -State Listen -ErrorAction SilentlyContinue)
if ($existingListeners.Count -gt 0) {
  throw "Port 9123 already has a listener (PID(s): $($existingListeners.OwningProcess -join ', ')). Stop the installed connector so acceptance cannot accidentally test stale code."
}
$process = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $connector, '-AllowedOrigin', $origin) -PassThru -WindowStyle Hidden
try {
  $healthy = $false
  foreach ($attempt in 1..30) {
    if ($process.HasExited) { throw "Candidate print connector exited before becoming healthy (exit $($process.ExitCode))" }
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:9123/health' -TimeoutSec 2
      if ($health.ok -and $health.version -eq 3) { $healthy = $true; break }
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $healthy) { throw "Loopback print connector did not become healthy" }

  $listeners = @(Get-NetTCPConnection -LocalPort 9123 -State Listen -ErrorAction Stop)
  $nonLoopback = @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
  if ($nonLoopback) { throw "Print connector escaped loopback: $($nonLoopback.LocalAddress -join ', ')" }
  $foreignListeners = @($listeners | Where-Object { $_.OwningProcess -ne $process.Id })
  if ($foreignListeners) { throw "Port 9123 is not owned by the candidate connector process $($process.Id)" }

  try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:9123/printers/windows' -Headers @{ Origin = 'https://evil.invalid' } -TimeoutSec 5 | Out-Null
    throw "Cross-origin printer enumeration was accepted"
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 403) { throw }
  }

  $enumerated = Invoke-RestMethod -Uri 'http://127.0.0.1:9123/printers/windows' -Headers @{ Origin = $origin } -TimeoutSec 10
  if (-not ($enumerated.printers | Where-Object systemName -eq $PrinterName)) { throw "Connector did not enumerate the selected printer" }

  $text = "`e@BUSINESS SUITE`nPHYSICAL PRINTER ACCEPTANCE`nCODE: $AcceptanceCode`n`n`n`n";
  [byte[]]$bytes = [Text.Encoding]::ASCII.GetBytes($text) + [byte[]](0x1D, 0x56, 0x00)
  $payload = @{
    target = @{ type = 'windows'; systemName = $PrinterName }
    dataBase64 = [Convert]::ToBase64String($bytes)
  } | ConvertTo-Json -Depth 5
  $response = Invoke-RestMethod -Uri 'http://127.0.0.1:9123/print/raw' -Method Post -Headers @{ Origin = $origin } -ContentType 'application/json' -Body $payload -TimeoutSec 30
  if (-not $response.ok) { throw "Connector did not accept the physical print" }

  $logPath = Join-Path $env:LOCALAPPDATA 'CafePOS\PrintConnector\connector.log'
  $logTail = if (Test-Path $logPath) { @(Get-Content $logPath -Tail 30) } else { @() }
  $report = [ordered]@{
    schemaVersion = 1
    checkId = 'physical-printer'
    status = 'MANUAL ACCEPTANCE REQUIRED'
    version = $ReleaseVersion
    commit = $CandidateCommit
    connectorDelivery = 'PASS'
    physicalOutput = 'MANUAL ACCEPTANCE REQUIRED'
    acceptanceCode = $AcceptanceCode
    executedAt = [DateTime]::UtcNow.ToString('o')
    printer = [ordered]@{
      name = $printer.Name
      driver = $printer.DriverName
      driverVersion = if ($driver) { [string]$driver.Version } else { $null }
      port = $printer.PortName
      portDescription = if ($port) { [string]$port.Description } else { $null }
      status = [string]$printer.PrinterStatus
      type = [string]$printer.Type
    }
    gateway = [ordered]@{
      connectorVersion = 3
      connectorSourceSha256 = $connectorSha256
      connectorProcessId = $process.Id
      binding = @($listeners | ForEach-Object LocalAddress)
      originRestriction = 'PASS'
      rawSpoolSubmission = 'PASS'
    }
    diagnosticLogTail = $logTail
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
  Write-Host "Connector delivery passed. Confirm the physical receipt contains code $AcceptanceCode; automation alone is not physical-output evidence."
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}
