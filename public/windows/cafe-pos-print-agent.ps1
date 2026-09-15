param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AllowedOrigin
)

# Cafe POS Windows Print Connector
# This file is downloaded and started by the one-click installer in Printer Settings.
# It intentionally uses only Windows PowerShell and built-in .NET APIs: no Node.js,
# npm, repository checkout, administrator account, or shared printer is required.

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$Port = 9123
$MaxHeaderBytes = 65536
$MaxBodyBytes = 16777216
$InstallDirectory = Join-Path $env:LOCALAPPDATA "CafePOS\PrintConnector"
$PidPath = Join-Path $InstallDirectory "agent.pid"
$LogPath = Join-Path $InstallDirectory "agent.log"

New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null

function Write-AgentLog {
    param([string]$Message)
    try {
        $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
        Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    } catch {
        # Printing must not fail merely because a log file is temporarily locked.
    }
}

try {
    $parsedOrigin = [Uri]$AllowedOrigin
    if (-not $parsedOrigin.IsAbsoluteUri -or ($parsedOrigin.Scheme -ne "https" -and $parsedOrigin.Scheme -ne "http")) {
        throw "The application origin is invalid."
    }
    $AllowedOrigin = $parsedOrigin.GetLeftPart([UriPartial]::Authority).TrimEnd("/")
} catch {
    Write-AgentLog "Invalid allowed origin."
    exit 2
}

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, "Local\CafePOSPrintConnector9123", [ref]$createdNew)
if (-not $createdNew) {
    Write-AgentLog "Another connector instance is already running."
    exit 0
}

$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class CafePosRawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private class DOC_INFO_1
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName = "Cafe POS";
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile = null;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype = "RAW";
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr printer);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int StartDocPrinter(IntPtr printer, int level, [In] DOC_INFO_1 info);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr printer, IntPtr bytes, int count, out int written);

    private static void ThrowLastError(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    public static void Send(string printerName, byte[] data)
    {
        if (String.IsNullOrWhiteSpace(printerName)) throw new ArgumentException("Printer name is required.");
        if (data == null || data.Length == 0) throw new ArgumentException("Print data is empty.");

        IntPtr printer = IntPtr.Zero;
        IntPtr unmanaged = IntPtr.Zero;
        bool documentStarted = false;
        bool pageStarted = false;

        try
        {
            if (!OpenPrinter(printerName, out printer, IntPtr.Zero)) ThrowLastError("OpenPrinter");
            if (StartDocPrinter(printer, 1, new DOC_INFO_1()) == 0) ThrowLastError("StartDocPrinter");
            documentStarted = true;
            if (!StartPagePrinter(printer)) ThrowLastError("StartPagePrinter");
            pageStarted = true;

            unmanaged = Marshal.AllocCoTaskMem(data.Length);
            Marshal.Copy(data, 0, unmanaged, data.Length);
            int offset = 0;
            while (offset < data.Length)
            {
                int written;
                IntPtr cursor = new IntPtr(unmanaged.ToInt64() + offset);
                if (!WritePrinter(printer, cursor, data.Length - offset, out written)) ThrowLastError("WritePrinter");
                if (written <= 0) throw new Win32Exception("WritePrinter wrote zero bytes.");
                offset += written;
            }
        }
        finally
        {
            if (unmanaged != IntPtr.Zero) Marshal.FreeCoTaskMem(unmanaged);
            if (pageStarted) EndPagePrinter(printer);
            if (documentStarted) EndDocPrinter(printer);
            if (printer != IntPtr.Zero) ClosePrinter(printer);
        }
    }
}
'@

try {
    Add-Type -TypeDefinition $nativeSource -Language CSharp
} catch {
    Write-AgentLog ("Could not load native Windows printer support: " + $_.Exception.Message)
    exit 3
}

function ConvertTo-JsonBytes {
    param($Value)
    $json = ConvertTo-Json -InputObject $Value -Depth 8 -Compress
    return [Text.Encoding]::UTF8.GetBytes($json)
}

function Get-ObjectValue {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Find-HeaderEnd {
    param([byte[]]$Bytes)
    for ($index = 0; $index -le $Bytes.Length - 4; $index++) {
        if ($Bytes[$index] -eq 13 -and $Bytes[$index + 1] -eq 10 -and $Bytes[$index + 2] -eq 13 -and $Bytes[$index + 3] -eq 10) {
            return $index
        }
    }
    return -1
}

function Read-HttpRequest {
    param([Net.Sockets.NetworkStream]$Stream)

    $buffer = New-Object byte[] 8192
    $memory = New-Object IO.MemoryStream
    $headerEnd = -1

    while ($headerEnd -lt 0) {
        $read = $Stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { throw "The client closed the connection before sending a request." }
        $memory.Write($buffer, 0, $read)
        if ($memory.Length -gt ($MaxHeaderBytes + $MaxBodyBytes)) { throw "The request is too large." }
        $headerEnd = Find-HeaderEnd -Bytes $memory.ToArray()
        if ($headerEnd -lt 0 -and $memory.Length -gt $MaxHeaderBytes) { throw "The request headers are too large." }
    }

    $allBytes = $memory.ToArray()
    $headerText = [Text.Encoding]::ASCII.GetString($allBytes, 0, $headerEnd)
    $lines = $headerText -split "`r`n"
    $requestParts = $lines[0] -split " "
    if ($requestParts.Length -lt 2) { throw "The HTTP request line is invalid." }

    $headers = @{}
    for ($index = 1; $index -lt $lines.Length; $index++) {
        $separator = $lines[$index].IndexOf(":")
        if ($separator -gt 0) {
            $name = $lines[$index].Substring(0, $separator).Trim().ToLowerInvariant()
            $headers[$name] = $lines[$index].Substring($separator + 1).Trim()
        }
    }

    $contentLength = 0
    if ($headers.ContainsKey("content-length")) {
        if (-not [int]::TryParse($headers["content-length"], [ref]$contentLength) -or $contentLength -lt 0 -or $contentLength -gt $MaxBodyBytes) {
            throw "The request body length is invalid."
        }
    }

    $bodyStart = $headerEnd + 4
    while (($allBytes.Length - $bodyStart) -lt $contentLength) {
        $read = $Stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { throw "The client closed the connection before sending the request body." }
        $memory.Write($buffer, 0, $read)
        $allBytes = $memory.ToArray()
        if (($allBytes.Length - $bodyStart) -gt $MaxBodyBytes) { throw "The request body is too large." }
    }

    $body = ""
    if ($contentLength -gt 0) {
        $body = [Text.Encoding]::UTF8.GetString($allBytes, $bodyStart, $contentLength)
    }

    return [PSCustomObject]@{
        Method = $requestParts[0].ToUpperInvariant()
        Path = $requestParts[1].Split("?")[0]
        Headers = $headers
        Body = $body
    }
}

function Write-HttpResponse {
    param(
        [Net.Sockets.NetworkStream]$Stream,
        [int]$Status,
        [byte[]]$Body,
        [string]$RequestOrigin = "",
        [string]$ContentType = "application/json; charset=utf-8"
    )

    if ($null -eq $Body) { $Body = New-Object byte[] 0 }
    $statusText = switch ($Status) {
        200 { "OK" }
        204 { "No Content" }
        400 { "Bad Request" }
        403 { "Forbidden" }
        404 { "Not Found" }
        409 { "Conflict" }
        413 { "Payload Too Large" }
        500 { "Internal Server Error" }
        502 { "Bad Gateway" }
        default { "Error" }
    }

    $header = "HTTP/1.1 $Status $statusText`r`n" +
              "Content-Type: $ContentType`r`n" +
              "Content-Length: $($Body.Length)`r`n" +
              "Cache-Control: no-store`r`n" +
              "Access-Control-Allow-Private-Network: true`r`n" +
              "Vary: Origin`r`n"
    if ($RequestOrigin -and $RequestOrigin -eq $AllowedOrigin) {
        $header += "Access-Control-Allow-Origin: $AllowedOrigin`r`n" +
                   "Access-Control-Allow-Methods: GET, POST, OPTIONS`r`n" +
                   "Access-Control-Allow-Headers: Content-Type`r`n"
    }
    $header += "Connection: close`r`n`r`n"

    $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}

function Write-JsonResponse {
    param(
        [Net.Sockets.NetworkStream]$Stream,
        [int]$Status,
        $Value,
        [string]$RequestOrigin = ""
    )
    Write-HttpResponse -Stream $Stream -Status $Status -Body (ConvertTo-JsonBytes $Value) -RequestOrigin $RequestOrigin
}

function Get-SystemPrinters {
    $items = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop)
    foreach ($printer in $items) {
        $name = [string]$printer.Name
        [PSCustomObject]@{
            name = $name
            driver = [string]$printer.DriverName
            port = [string]$printer.PortName
            isDefault = [bool]$printer.Default
            status = [string]$printer.PrinterStatus
            likelyThermal = [bool]($name -match "(?i)(thermal|receipt|pos|xp-|rp-|tm-|80mm|58mm)")
        }
    }
}

function Send-NetworkBytes {
    param([string]$Address, [int]$TargetPort, [byte[]]$Bytes)
    $client = New-Object Net.Sockets.TcpClient
    try {
        $connect = $client.ConnectAsync($Address, $TargetPort)
        if (-not $connect.Wait(5000) -or -not $client.Connected) { throw "Printer connection timed out." }
        $stream = $client.GetStream()
        try {
            $stream.WriteTimeout = 15000
            $stream.Write($Bytes, 0, $Bytes.Length)
            $stream.Flush()
        } finally {
            $stream.Dispose()
        }
    } finally {
        $client.Dispose()
    }
}

function Test-PrinterConnection {
    param($Connection)

    try {
        if ($null -eq $Connection) { throw "Printer connection settings are missing." }
        $transportValue = Get-ObjectValue -Object $Connection -Name "transport"
        $transport = if ($transportValue) { [string]$transportValue } else { "network" }
        if ($transport -eq "system") {
            $printerName = [string](Get-ObjectValue -Object $Connection -Name "systemName")
            if ([string]::IsNullOrWhiteSpace($printerName)) { throw "The Windows printer name is missing." }
            $found = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop | Where-Object { $_.Name -eq $printerName }).Count -gt 0
            $detail = if ($found) { $printerName } else { "printer_not_found" }
            return [PSCustomObject]@{ reachable = $found; detail = $detail }
        }
        if ($transport -eq "network") {
            $address = [string](Get-ObjectValue -Object $Connection -Name "ip")
            $configuredPort = Get-ObjectValue -Object $Connection -Name "port"
            $targetPort = if ($configuredPort) { [int]$configuredPort } else { 9100 }
            if ([string]::IsNullOrWhiteSpace($address)) { throw "The printer address is missing." }
            $client = New-Object Net.Sockets.TcpClient
            try {
                $connect = $client.ConnectAsync($address, $targetPort)
                $connected = $connect.Wait(5000) -and $client.Connected
                $detail = if ($connected) { "$address`:$targetPort" } else { "timeout" }
                return [PSCustomObject]@{ reachable = $connected; detail = $detail }
            } finally {
                $client.Dispose()
            }
        }
        return [PSCustomObject]@{ reachable = $false; detail = "unsupported_transport" }
    } catch {
        return [PSCustomObject]@{ reachable = $false; detail = $_.Exception.Message }
    }
}

function Submit-RawPrint {
    param($Payload)

    $encoded = Get-ObjectValue -Object $Payload -Name "dataBase64"
    if (-not $encoded) { throw "Rendered print data is missing." }
    try {
        [byte[]]$bytes = [Convert]::FromBase64String([string]$encoded)
    } catch {
        throw "Rendered print data is invalid."
    }
    if ($bytes.Length -eq 0) { throw "Rendered print data is empty." }

    $connection = Get-ObjectValue -Object $Payload -Name "connection"
    if ($null -eq $connection) { throw "Printer connection settings are missing." }
    $transportValue = Get-ObjectValue -Object $connection -Name "transport"
    $transport = if ($transportValue) { [string]$transportValue } else { "network" }

    if ($transport -eq "system") {
        $printerName = [string](Get-ObjectValue -Object $connection -Name "systemName")
        if ([string]::IsNullOrWhiteSpace($printerName)) { throw "The Windows printer name is missing." }
        [CafePosRawPrinter]::Send($printerName, $bytes)
        return
    }

    if ($transport -eq "network") {
        $address = [string](Get-ObjectValue -Object $connection -Name "ip")
        $configuredPort = Get-ObjectValue -Object $connection -Name "port"
        $targetPort = if ($configuredPort) { [int]$configuredPort } else { 9100 }
        if ([string]::IsNullOrWhiteSpace($address)) { throw "The printer address is missing." }
        Send-NetworkBytes -Address $address -TargetPort $targetPort -Bytes $bytes
        return
    }

    throw "This printer connection is not supported by the Windows connector."
}

function Handle-Request {
    param([Net.Sockets.NetworkStream]$Stream, $Request)

    $origin = if ($Request.Headers.ContainsKey("origin")) { [string]$Request.Headers["origin"] } else { "" }
    $originAllowed = $origin -eq $AllowedOrigin

    if ($Request.Method -eq "OPTIONS") {
        if (-not $originAllowed) {
            Write-JsonResponse -Stream $Stream -Status 403 -Value @{ ok = $false; error = "origin_forbidden" } -RequestOrigin $origin
        } else {
            Write-HttpResponse -Stream $Stream -Status 204 -Body (New-Object byte[] 0) -RequestOrigin $origin
        }
        return
    }

    # A no-Origin health request is useful to the installer itself. Every browser
    # operation, including browser health checks, is restricted to the exact POS origin.
    if ($Request.Path -eq "/health" -and $Request.Method -eq "GET" -and (-not $origin -or $originAllowed)) {
        Write-JsonResponse -Stream $Stream -Status 200 -Value @{
            ok = $true
            service = "cafe-pos-print-connector"
            version = 2
            lightweight = $true
            allowedOrigin = $AllowedOrigin
        } -RequestOrigin $origin
        return
    }

    if (-not $originAllowed) {
        Write-JsonResponse -Stream $Stream -Status 403 -Value @{ ok = $false; error = "origin_forbidden" } -RequestOrigin $origin
        return
    }

    if ($Request.Path -eq "/printers/system" -and $Request.Method -eq "GET") {
        $printers = @(Get-SystemPrinters)
        Write-JsonResponse -Stream $Stream -Status 200 -Value @{ ok = $true; printers = $printers } -RequestOrigin $origin
        return
    }

    if ($Request.Path -eq "/printers/scan" -and $Request.Method -eq "POST") {
        # Installed Windows queues are the reliable discovery source. Network
        # printers added in Windows appear there too, without a slow LAN sweep.
        Write-JsonResponse -Stream $Stream -Status 200 -Value @{ ok = $true; printers = @() } -RequestOrigin $origin
        return
    }

    if ($Request.Path -eq "/printers/probe" -and $Request.Method -eq "POST") {
        try {
            $payload = ConvertFrom-Json -InputObject $Request.Body
            $probe = Test-PrinterConnection -Connection $payload.connection
            Write-JsonResponse -Stream $Stream -Status 200 -Value @{ ok = $true; reachable = $probe.reachable; detail = $probe.detail } -RequestOrigin $origin
        } catch {
            Write-JsonResponse -Stream $Stream -Status 400 -Value @{ ok = $false; error = "invalid_connection" } -RequestOrigin $origin
        }
        return
    }

    if ($Request.Path -eq "/print/raw" -and $Request.Method -eq "POST") {
        try {
            $payload = ConvertFrom-Json -InputObject $Request.Body
            Submit-RawPrint -Payload $payload
            Write-JsonResponse -Stream $Stream -Status 200 -Value @{ ok = $true } -RequestOrigin $origin
        } catch {
            Write-AgentLog ("Print failed: " + $_.Exception.Message)
            Write-JsonResponse -Stream $Stream -Status 502 -Value @{ ok = $false; error = "printer_unreachable" } -RequestOrigin $origin
        }
        return
    }

    if (($Request.Path -like "/print/*" -or $Request.Path -eq "/drawer/kick") -and $Request.Method -eq "POST") {
        # Rich receipt/invoice generation stays canonical on the cloud server.
        # The browser renders there, then returns the exact ESC/POS bytes through
        # /print/raw for this connector to submit to the local Windows spooler.
        Write-JsonResponse -Stream $Stream -Status 409 -Value @{ ok = $false; error = "render_required" } -RequestOrigin $origin
        return
    }

    Write-JsonResponse -Stream $Stream -Status 404 -Value @{ ok = $false; error = "not_found" } -RequestOrigin $origin
}

$listener = $null
try {
    Set-Content -LiteralPath $PidPath -Value $PID -Encoding ASCII
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    Write-AgentLog "Connector started on 127.0.0.1:$Port for $AllowedOrigin."

    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 20000
            $client.SendTimeout = 20000
            $stream = $client.GetStream()
            try {
                $request = Read-HttpRequest -Stream $stream
                Handle-Request -Stream $stream -Request $request
            } catch {
                Write-AgentLog ("Request failed: " + $_.Exception.Message)
                try {
                    Write-JsonResponse -Stream $stream -Status 400 -Value @{ ok = $false; error = "invalid_request" }
                } catch {}
            } finally {
                $stream.Dispose()
            }
        } finally {
            $client.Dispose()
        }
    }
} catch {
    Write-AgentLog ("Connector stopped: " + $_.Exception.Message)
    exit 4
} finally {
    if ($null -ne $listener) { $listener.Stop() }
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    if ($null -ne $mutex) {
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
    }
}
