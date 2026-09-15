import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWindowsPrintConnectorInstaller } from "./windows-print-connector";

const connectorSource = readFileSync(
  join(process.cwd(), "public/windows/cafe-pos-print-agent.ps1"),
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

    expect(installer).toContain("https://branch.example.com:8443/windows/cafe-pos-print-agent.ps1");
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
});

describe("dependency-free Windows print connector", () => {
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
    expect(connectorSource).not.toContain("suggestedType");
    expect(connectorSource).toContain('DllImport("winspool.drv"');
    expect(connectorSource).toContain("OpenPrinter");
    expect(connectorSource).toContain("WritePrinter");
    expect(connectorSource).toContain('-Name "systemName"');
    expect(connectorSource).toContain('-Name "ip"');
    expect(connectorSource).not.toContain("systemPrinterName");
    expect(connectorSource).not.toContain("ipAddress");
    expect(connectorSource).not.toMatch(/npm\s+(?:ci|install)/i);
    expect(connectorSource).not.toContain("node.exe");
  });

  it("requests canonical server rendering before accepting rendered bytes", () => {
    expect(connectorSource).toContain('error = "render_required"');
    expect(connectorSource).toContain('$Request.Path -eq "/drawer/kick"');
    expect(connectorSource).toContain('$Request.Path -eq "/print/raw"');
    expect(connectorSource).toContain("FromBase64String");
  });
});
