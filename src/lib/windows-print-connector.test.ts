import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWindowsPrintConnectorInstaller } from "./windows-print-connector";

const connectorSource = readFileSync(
  join(process.cwd(), "public/windows/cafe-pos-print-connector.ps1"),
  "utf8",
);

describe("Windows print connector installer", () => {
  it("installs per-user, starts immediately, and registers Windows-login startup", () => {
    const installer = buildWindowsPrintConnectorInstaller("https://cafe.example.com");

    expect(installer).toContain("Invoke-WebRequest");
    expect(installer).toContain("$env:LOCALAPPDATA");
    expect(installer).toContain('SpecialFolders.Item("Startup")');
    expect(installer).toContain("Start-Process");
    expect(installer).toContain("http://127.0.0.1:9123/health");
    expect(installer.match(/# CAFE_POS_INSTALLER_PAYLOAD/g)).toHaveLength(1);
  });

  it("pins both the download and connector CORS policy to the current origin", () => {
    const installer = buildWindowsPrintConnectorInstaller("https://branch.example.com:8443/path");

    expect(installer).toContain("https://branch.example.com:8443/windows/cafe-pos-print-connector.ps1");
    expect(installer).toContain("$origin = 'https://branch.example.com:8443'");
  });

  it("escapes an origin before embedding it in PowerShell", () => {
    const installer = buildWindowsPrintConnectorInstaller("https://example.com/?ignored='value'");

    expect(installer).not.toContain("ignored");
    expect(installer).toContain("$origin = 'https://example.com'");
  });

  it("rejects non-HTTP origins", () => {
    expect(() => buildWindowsPrintConnectorInstaller("file:///tmp/app")).toThrow(
      "unsupported_installer_origin",
    );
  });

  it("reinstalling is the upgrade path: it stops the current connector and the older print agent", () => {
    const installer = buildWindowsPrintConnectorInstaller("https://cafe.example.com");
    expect(installer).toContain("Stop-RunningConnector");
    expect(installer).toContain('"connector.pid"');
    expect(installer).toContain('"agent.pid"');
    expect(installer).toContain('"cafe-pos-print-connector.ps1"');
    expect(installer).toContain('"cafe-pos-print-agent.ps1"');
    expect(installer).toContain("cafe-pos-print-agent.ps1\") -Force");
    // The install only declares success for a current (v3+) connector.
    expect(installer).toContain("[int]$health.version -ge 3");
  });
});

describe("the dependency-free Windows print connector", () => {
  it("binds only to loopback and restricts browser requests to the installed origin", () => {
    expect(connectorSource).toContain("[Net.IPAddress]::Loopback");
    expect(connectorSource).toContain('$origin -eq $AllowedOrigin');
    expect(connectorSource).toContain("Access-Control-Allow-Origin: $AllowedOrigin");
    expect(connectorSource).not.toContain("IPAddress]::Any");
  });

  it("enumerates Windows queues and writes RAW data through the native spooler", () => {
    expect(connectorSource).toContain("Win32_Printer");
    expect(connectorSource).toContain("driver = [string]$printer.DriverName");
    expect(connectorSource).toContain("port = [string]$printer.PortName");
    expect(connectorSource).toContain("likelyThermal = [bool]");
    expect(connectorSource).toContain('DllImport("winspool.drv"');
    expect(connectorSource).toContain("OpenPrinter");
    expect(connectorSource).toContain("WritePrinter");
    expect(connectorSource).not.toMatch(/npm\s+(?:ci|install)/i);
    expect(connectorSource).not.toContain("node.exe");
  });

  it("addresses printers only through the canonical target shape", () => {
    expect(connectorSource).toContain('-Name "target"');
    expect(connectorSource).toContain('-Name "type"');
    expect(connectorSource).toContain('-Name "systemName"');
    expect(connectorSource).toContain('-Name "ip"');
    expect(connectorSource).not.toContain('-Name "connection"');
    expect(connectorSource).not.toContain("systemPrinterName");
  });

  it("speaks the one coherent protocol: health, windows list, network discovery, probe, raw", () => {
    expect(connectorSource).toContain('"/health"');
    expect(connectorSource).toContain('"/printers/windows"');
    expect(connectorSource).toContain('"/printers/network/discover"');
    expect(connectorSource).toContain('"/printers/probe"');
    expect(connectorSource).toContain('"/print/raw"');
    expect(connectorSource).not.toContain('"/printers/system"');
    expect(connectorSource).not.toContain('"/printers/scan"');
    expect(connectorSource).not.toContain("render_required");
    expect(connectorSource).not.toContain('/print/" -like');
  });

  it("discovers network printers locally: local subnets, bounded windows, port 9100", () => {
    expect(connectorSource).toContain("function Get-LocalSubnets");
    expect(connectorSource).toContain("NetworkInterfaceType]::Loopback");
    expect(connectorSource).toContain('169.254.*');
    expect(connectorSource).toContain("function Find-NetworkPrinters");
    expect(connectorSource).toContain("ConnectAsync");
    expect(connectorSource).toContain("$Concurrency");
    expect(connectorSource).toContain("latencyMs");
    // Only the raw-print port is swept; fallback ports stay out of the scan.
    expect(connectorSource).toMatch(/\$TargetPort = 9100/);
    expect(connectorSource).not.toContain("9101");
    expect(connectorSource).not.toContain("515");
  });

  it("returns canonical error codes, not raw exceptions", () => {
    expect(connectorSource).toContain('"printer_not_found"');
    expect(connectorSource).toContain('"network_unreachable"');
    expect(connectorSource).toContain('"invalid_target"');
    expect(connectorSource).toContain('"print_failed"');
  });

  it("logs startup, print attempts and failures without receipt content", () => {
    expect(connectorSource).toContain("Connector v3 started");
    expect(connectorSource).toContain("Write-ConnectorLog (\"Printed \" + $bytes.Length + \" bytes to \"");
    expect(connectorSource).toContain('"Print failed for "');
    // Log lines carry targets and byte counts, never the request body.
    expect(connectorSource).not.toContain("Write-ConnectorLog $Request.Body");
    expect(connectorSource).not.toContain("Write-ConnectorLog $Payload");
  });
});
