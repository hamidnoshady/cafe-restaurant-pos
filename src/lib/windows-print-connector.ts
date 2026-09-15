/**
 * Builds the small, self-installing Windows command file offered from Printer
 * Settings. The payload is intentionally dependency-free: Windows PowerShell
 * downloads the connector into the current user's LocalAppData, creates an
 * auto-start shortcut, starts it immediately, and verifies its loopback health.
 *
 * The public origin is baked into the install so the connector can reject every
 * website except the tenant origin from which the authenticated operator
 * downloaded it. There are no credentials in this file.
 */

const PAYLOAD_MARKER = "# CAFE_POS_INSTALLER_PAYLOAD";

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildWindowsPrintConnectorInstaller(origin: string): string {
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("unsupported_installer_origin");
  }

  const normalizedOrigin = parsed.origin;
  const scriptUrl = new URL("/windows/cafe-pos-print-agent.ps1", normalizedOrigin).toString();
  const originLiteral = powerShellLiteral(normalizedOrigin);
  const scriptUrlLiteral = powerShellLiteral(scriptUrl);

  return `@echo off\r
setlocal\r
title Cafe POS Print Connector\r
set "CAFE_POS_INSTALLER=%~f0"\r
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$p=[IO.File]::ReadAllText([Environment]::GetEnvironmentVariable('CAFE_POS_INSTALLER'));$m='# CAFE_'+'POS_INSTALLER_PAYLOAD';Invoke-Expression ($p.Substring($p.IndexOf($m)+$m.Length))"\r
set "CAFE_POS_RESULT=%ERRORLEVEL%"\r
endlocal & exit /b %CAFE_POS_RESULT%\r
${PAYLOAD_MARKER}\r
$ErrorActionPreference = "Stop"

function Show-Result {
    param([string]$Message, [string]$Title, [int]$Icon)
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($Message, $Title, "OK", $Icon) | Out-Null
    } catch {
        Write-Host $Message
    }
}

try {
    $origin = ${originLiteral}
    $scriptUrl = ${scriptUrlLiteral}
    $installDirectory = Join-Path $env:LOCALAPPDATA "CafePOS\\PrintConnector"
    $agentPath = Join-Path $installDirectory "cafe-pos-print-agent.ps1"
    $temporaryPath = Join-Path $env:TEMP ("cafe-pos-print-agent-" + [Guid]::NewGuid().ToString("N") + ".ps1")
    $pidPath = Join-Path $installDirectory "agent.pid"

    New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $scriptUrl -OutFile $temporaryPath
    if ((Get-Item -LiteralPath $temporaryPath).Length -lt 1000) {
        throw "The downloaded connector file is incomplete."
    }

    if (Test-Path -LiteralPath $pidPath) {
        $runningPid = 0
        [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$runningPid) | Out-Null
        if ($runningPid -gt 0) {
            $running = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + $runningPid) -ErrorAction SilentlyContinue
            if ($null -ne $running -and [string]$running.CommandLine -like "*cafe-pos-print-agent.ps1*") {
                Stop-Process -Id $runningPid -Force -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 500
            }
        }
    }

    Move-Item -LiteralPath $temporaryPath -Destination $agentPath -Force

    $powershell = Join-Path $env:SystemRoot "System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $agentPath + '" -AllowedOrigin "' + $origin + '"'
    $shell = New-Object -ComObject WScript.Shell

    $startupDirectory = $shell.SpecialFolders.Item("Startup")
    $startupShortcut = $shell.CreateShortcut((Join-Path $startupDirectory "Cafe POS Print Connector.lnk"))
    $startupShortcut.TargetPath = $powershell
    $startupShortcut.Arguments = $arguments
    $startupShortcut.WorkingDirectory = $installDirectory
    $startupShortcut.Description = "Cafe POS Windows printer connector"
    $startupShortcut.Save()

    $programsDirectory = $shell.SpecialFolders.Item("Programs")
    if ($programsDirectory) {
        $menuShortcut = $shell.CreateShortcut((Join-Path $programsDirectory "Cafe POS Print Connector.lnk"))
        $menuShortcut.TargetPath = $powershell
        $menuShortcut.Arguments = $arguments
        $menuShortcut.WorkingDirectory = $installDirectory
        $menuShortcut.Description = "Start the Cafe POS Windows printer connector"
        $menuShortcut.Save()
    }

    Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden

    $healthy = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:9123/health" -TimeoutSec 2
            if ($health.ok -and $health.allowedOrigin -eq $origin) {
                $healthy = $true
                break
            }
        } catch {}
    }
    if (-not $healthy) {
        throw "The connector was installed but could not start on port 9123. Close any older print connector and run this installer again."
    }

    Show-Result -Title "Cafe POS" -Icon 64 -Message "The Windows printer connector is installed and running. Return to Cafe POS and click Check connection. It will start automatically whenever you sign in to Windows."
    exit 0
} catch {
    if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
    Show-Result -Title "Cafe POS - Installation failed" -Icon 16 -Message ("The printer connector could not be installed. Please try again or contact support.\r\n\r\n" + $_.Exception.Message)
    exit 1
}
`;
}
