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
 *                reliably — so the bytes go through `lpr`/`print /D:` style
 *                raw submission, and on CUPS through `lp -o raw`.
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
      // The spooler's own RAW datatype: no driver rendering, byte-for-byte.
      const script = `Start-Process -FilePath "$env:SystemRoot\\System32\\cmd.exe" -ArgumentList '/c','copy','/b','"${path}"','"\\\\localhost\\${printerName.replace(/'/g, "''")}"' -Wait -WindowStyle Hidden`;
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        timeout: 30_000,
        windowsHide: true,
      });
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
