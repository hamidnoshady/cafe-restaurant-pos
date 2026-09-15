import { describe, expect, it } from "vitest";
import { windowsRawSpoolScript } from "./spooler";

describe("Windows RAW spool submission", () => {
  it("uses the native spooler queue API, not a printer share", () => {
    const script = windowsRawSpoolScript("EPSON TM-T20III", "C:\\Temp\\job.bin");
    expect(script).toContain('DllImport("winspool.drv"');
    expect(script).toContain("OpenPrinterW");
    expect(script).toContain("StartDocPrinterW");
    expect(script).toContain("WritePrinter");
    expect(script).toContain('pDatatype = "RAW"');
    expect(script).not.toContain("\\\\localhost\\");
    expect(script).toContain("[CafePosRawPrinter]::Send('EPSON TM-T20III', 'C:\\Temp\\job.bin')");
  });

  it("PowerShell-quotes queue names and paths rather than interpolating commands", () => {
    const script = windowsRawSpoolScript("Cafe's POS", "C:\\A's\\job.bin");
    expect(script).toContain("[CafePosRawPrinter]::Send('Cafe''s POS', 'C:\\A''s\\job.bin')");
  });
});
