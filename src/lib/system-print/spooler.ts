/**
 * Sending a job to a printer the operating system owns.
 *
 * `transport.ts` handles the network case (a raw TCP socket to port 9100).
 * This handles the two OS-mediated ones, and the split matters because they
 * are genuinely different jobs:
 *
 *   `raster`   — the ESC/POS byte stream produced for a thermal printer, sent
 *                to the queue verbatim so the printer's own firmware sees it.
 *                On Windows that means a raw job (no driver rendering), which
 *                is what `Out-Printer`/the copy-to-port trick cannot do
 *                reliably — so the bytes go through the native `WritePrinter`
 *                API, and on CUPS through `lp -o raw`.
 *   `document` — a PDF page for a laser/inkjet queue (A4/A5 invoices). The
 *                page is already a PDF by the time it gets here (the agent
 *                renders HTML → PDF with the same browser it screenshots
 *                with), so the OS just spools it.
 *
 * Everything is temp-file based: every spooler on every platform takes a path,
 * and none of them takes a stream portably.
 */
import { execFile } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const run = promisify(execFile);

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Submit a byte-for-byte RAW job to any installed Windows queue by its real
 * queue name. `copy /b file \\localhost\name` only works when the printer was
 * explicitly shared and its share name happens to equal its display name — a
 * normal USB printer added through "Printers & scanners" satisfies neither.
 * WritePrinter is the spooler's native API and does not require sharing.
 *
 * Exported only to make the generated boundary script inspectable in a
 * platform-independent unit test; it contains no user-controlled executable
 * text (both arguments are PowerShell single-quoted).
 */
export function windowsRawSpoolScript(printerName: string, path: string): string {
  return `
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class CafePosRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct DOC_INFO_1 {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
  }

  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);
  [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true)]
  private static extern bool ClosePrinter(IntPtr printer);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern int StartDocPrinter(IntPtr printer, int level, [In] ref DOC_INFO_1 docInfo);
  [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
  private static extern bool EndDocPrinter(IntPtr printer);
  [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
  private static extern bool StartPagePrinter(IntPtr printer);
  [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
  private static extern bool EndPagePrinter(IntPtr printer);
  [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true)]
  private static extern bool WritePrinter(IntPtr printer, IntPtr bytes, int count, out int written);

  private static Win32Exception LastError() {
    return new Win32Exception(Marshal.GetLastWin32Error());
  }

  public static void Send(string printerName, string filePath) {
    IntPtr printer;
    if (!OpenPrinter(printerName, out printer, IntPtr.Zero)) throw LastError();
    bool documentStarted = false;
    bool pageStarted = false;
    IntPtr unmanaged = IntPtr.Zero;
    try {
      var doc = new DOC_INFO_1 { pDocName = "Cafe POS", pOutputFile = null, pDatatype = "RAW" };
      if (StartDocPrinter(printer, 1, ref doc) == 0) throw LastError();
      documentStarted = true;
      if (!StartPagePrinter(printer)) throw LastError();
      pageStarted = true;

      byte[] data = File.ReadAllBytes(filePath);
      unmanaged = Marshal.AllocCoTaskMem(data.Length);
      Marshal.Copy(data, 0, unmanaged, data.Length);
      int offset = 0;
      while (offset < data.Length) {
        int written;
        if (!WritePrinter(printer, IntPtr.Add(unmanaged, offset), data.Length - offset, out written)) throw LastError();
        if (written <= 0) throw new IOException("short_write: " + offset + "/" + data.Length);
        offset += written;
      }
    } finally {
      if (unmanaged != IntPtr.Zero) Marshal.FreeCoTaskMem(unmanaged);
      if (pageStarted) EndPagePrinter(printer);
      if (documentStarted) EndDocPrinter(printer);
      ClosePrinter(printer);
    }
  }
}
'@
[CafePosRawPrinter]::Send(${psQuote(printerName)}, ${psQuote(path)})
`;
}

async function withTempFile<T>(
  name: string,
  data: Buffer,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cafe-pos-print-"));
  const path = join(dir, name);
  await writeFile(path, data);
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Raw bytes (an ESC/POS job) straight to an installed queue. */
export async function sendRawToSystemPrinter(printerName: string, data: Buffer): Promise<void> {
  await withTempFile("job.bin", data, async (path) => {
    if (process.platform === "win32") {
      // The spooler's own RAW datatype: no driver rendering, byte-for-byte,
      // and (unlike a copy to \\localhost\share) no printer sharing required.
      await run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", windowsRawSpoolScript(printerName, path)],
        { timeout: 30_000, windowsHide: true, maxBuffer: 1_000_000 },
      );
      return;
    }
    await run("lp", ["-d", printerName, "-o", "raw", path], { timeout: 30_000 });
  });
}

/** A rendered PDF page to an installed queue (the A4/A5 invoice path). */
export async function sendDocumentToSystemPrinter(
  printerName: string,
  pdf: Buffer,
  opts: { copies?: number } = {},
): Promise<void> {
  const copies = Math.max(1, Math.min(9, opts.copies ?? 1));
  await withTempFile("job.pdf", pdf, async (path) => {
    if (process.platform === "win32") {
      // Windows has no built-in PDF spooler CLI; the shell's registered "print"
      // verb hands the file to whatever the machine uses to open PDFs (Edge,
      // Acrobat), which then prints it to the named queue.
      const script = `Start-Process -FilePath "${path}" -Verb PrintTo -ArgumentList '"${printerName.replace(/'/g, "''")}"' -WindowStyle Hidden`;
      for (let i = 0; i < copies; i += 1) {
        await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
          timeout: 60_000,
          windowsHide: true,
        });
      }
      return;
    }
    await run("lp", ["-d", printerName, "-n", String(copies), path], { timeout: 60_000 });
  });
}

/** Raw bytes to a USB/serial device path (`USB001`, `/dev/usb/lp0`). */
export async function sendRawToDevice(devicePath: string, data: Buffer): Promise<void> {
  await withTempFile("job.bin", data, async (path) => {
    if (process.platform === "win32") {
      await run("cmd.exe", ["/c", "copy", "/b", path, devicePath], { timeout: 30_000, windowsHide: true });
      return;
    }
    await run("sh", ["-c", `cat ${JSON.stringify(path)} > ${JSON.stringify(devicePath)}`], { timeout: 30_000 });
  });
}
