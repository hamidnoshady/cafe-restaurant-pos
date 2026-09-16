import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWindowsPrintConnectorInstaller } from "./windows-print-connector";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const connector = source("public/windows/cafe-pos-print-agent.ps1");
const client = source("src/lib/print-agent-client.ts");
const printerSettings = source("src/app/(app)/settings/printing/printer-hardware.tsx");

describe("one-click Windows connector end-to-end contract", () => {
  it("keeps the browser and connector protocol endpoint names aligned", () => {
    for (const endpoint of [
      "/health",
      "/printers/system",
      "/printers/scan",
      "/printers/probe",
      "/drawer/kick",
      "/print/raw",
    ]) {
      expect(client, `browser client is missing ${endpoint}`).toContain(endpoint);
      expect(connector, `Windows connector is missing ${endpoint}`).toContain(endpoint);
    }
    for (const endpoint of [
      "/print/document",
      "/print/receipt",
      "/print/kitchen-ticket",
      "/print/label",
      "/print/test",
    ]) {
      expect(client, `browser client is missing ${endpoint}`).toContain(endpoint);
    }
    expect(connector).toContain('$Request.Path -like "/print/*"');
    expect(client).toContain('first.error !== "render_required"');
    expect(connector).toContain('error = "render_required"');
    expect(client).toContain("dataBase64: bytesToBase64(rendered.bytes)");
    expect(connector).toContain('Get-ObjectValue -Object $Payload -Name "dataBase64"');
  });

  it("returns exactly the installed-printer fields consumed by the settings screen", () => {
    const printerBlock = connector.slice(
      connector.indexOf("function Get-SystemPrinters"),
      connector.indexOf("function Send-NetworkBytes"),
    );

    for (const field of ["name", "driver", "port", "isDefault", "status", "likelyThermal"]) {
      expect(printerBlock, `queue response is missing ${field}`).toMatch(new RegExp(`\\b${field}\\s*=`));
    }
    expect(printerBlock).not.toMatch(/displayName|driverName|portName|suggestedType/);
    expect(client).toContain("export interface SystemPrinter");
    expect(printerSettings).toContain("printer.likelyThermal");
  });

  it("extracts a complete PowerShell setup payload from the downloaded command file", () => {
    const commandFile = buildWindowsPrintConnectorInstaller("https://shop.example.com");
    const marker = "# CAFE_POS_INSTALLER_PAYLOAD";
    const markerOffset = commandFile.indexOf(marker);

    expect(markerOffset).toBeGreaterThan(0);
    expect(commandFile.indexOf(marker, markerOffset + marker.length)).toBe(-1);
    const payload = commandFile.slice(markerOffset + marker.length);
    expect(payload).toContain('$origin = \'https://shop.example.com\'');
    expect(payload).toContain("Invoke-WebRequest");
    expect(payload).toContain('SpecialFolders.Item("Startup")');
    expect(payload).toContain("Start-Process");
    expect(payload).toContain("http://127.0.0.1:9123/health");
    expect(payload.trimEnd()).toMatch(/exit 1\s*}\s*$/);
  });

  it("offers the connector download unconditionally, not only while the agent is down", () => {
    // The card used to render behind `{!localAgentOnline ? … : null}`, which
    // hid the only download link whenever the health probe was answered by the
    // *app server* on a cloud deployment — precisely the deployment that needs
    // the connector — and left an already-installed till with no way to
    // reinstall or re-point it at a new tenant origin.
    expect(printerSettings).toContain("<WindowsConnectorCard localAgentOnline={localAgentOnline} />");
    expect(printerSettings).not.toMatch(/!localAgentOnline\s*\?[\s\S]{0,200}windows-agent-installer/);

    const card = printerSettings.slice(printerSettings.indexOf("function WindowsConnectorCard"));
    expect(card).toContain('href="/api/print/windows-agent-installer"');
    // The button text changes with the state, but a button is always rendered.
    expect(card).toContain("نصب دوبارهٔ رابط چاپ");
    expect(card).not.toMatch(/localAgentOnline\s*\?\s*null\s*:\s*<Button/);
  });

  it("exposes only the nontechnical install flow in printer settings", () => {
    expect(printerSettings).toContain('href="/api/print/windows-agent-installer"');
    expect(printerSettings).toContain("دانلود و نصب رابط چاپ ویندوز");
    expect(printerSettings).not.toContain("npm run print-agent");
    expect(printerSettings).not.toContain("Install-PrintAgent.ps1");
    expect(printerSettings).not.toContain("powershell -ExecutionPolicy");
  });
});
