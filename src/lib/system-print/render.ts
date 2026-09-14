/**
 * HTML → PNG rendering for hardware printing. Uses a real browser engine
 * (Chromium via playwright-core) rather than any text-mode ESC/POS codepage
 * because no printer we can target reliably shapes/reorders Persian text —
 * see src/lib/escpos.ts's header comment. The screenshot is later packed
 * into an ESC/POS raster image by png.ts + src/lib/escpos.ts.
 *
 * Shared by the standalone print agent (print-agent/server.ts) and the app
 * server's /api/print/* routes, so paths resolve from `process.cwd()` — the
 * repo root under both `npm run print-agent` and `next start`/the custom
 * server (`__dirname` is unreliable once Next bundles a route handler).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { chromium, type Browser } from "playwright-core";

const FONT_PATH = join(process.cwd(), "src", "app", "fonts", "Vazirmatn-Variable.woff2");
let fontDataUri: string | null = null;

function getFontDataUri(): string {
  if (!fontDataUri) {
    const buf = readFileSync(FONT_PATH);
    fontDataUri = `data:font/woff2;base64,${buf.toString("base64")}`;
  }
  return fontDataUri;
}

/** The templates (src/lib/*-template.ts) set `font-family: "Vazirmatn"` but don't embed the font — done here so the pure templates stay dependency-free. */
function withEmbeddedFont(html: string): string {
  const style = `<style>@font-face{font-family:"Vazirmatn";src:url(${getFontDataUri()}) format("woff2");font-weight:100 900;font-style:normal;}</style>`;
  return html.replace("<head>", `<head>${style}`);
}

let browserPromise: Promise<Browser> | null = null;

/**
 * Find a Chromium/Chrome/Edge to render with. No bundled browser download
 * with playwright-core (deliberately lighter than @playwright/test on a till
 * PC), so the search order is: the explicit env override, then the browsers
 * a till PC realistically already has — the very Chrome/Edge the dashboard is
 * open in on Windows, the system Chromium on Linux/macOS — then the sandbox
 * default. `PRINT_AGENT_CHROMIUM_PATH` still wins for anyone who set it.
 */
function findChromium(): string {
  const fromEnv = process.env.PRINT_AGENT_CHROMIUM_PATH || process.env.PDF_CHROMIUM_PATH;
  if (fromEnv) return fromEnv;

  const candidates =
    process.platform === "win32"
      ? [
          join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env["LocalAppData"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
          join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : [
            "/opt/pw-browsers/chromium",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/microsoft-edge",
          ];
  for (const path of candidates) {
    try {
      if (path && existsSync(path)) return path;
    } catch {
      // inaccessible path — keep looking
    }
  }
  // Nothing found: fall back to the sandbox default so the launch error
  // names a concrete path rather than an empty string.
  return "/opt/pw-browsers/chromium";
}

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
    // A failed launch must not poison every later print with the same
    // rejected promise — reset so the next job retries the launch.
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

/** Renders `html` at a fixed pixel width (from the paper preset) and returns a full-height PNG screenshot. */
export async function renderHtmlToPng(html: string, widthPx: number): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: widthPx, height: 200 }, deviceScaleFactor: 1 });
  try {
    await page.setContent(withEmbeddedFont(html), { waitUntil: "networkidle" });
    // fullPage: the receipt/ticket's real height varies with line count; the
    // 200px viewport height above is just a starting canvas.
    const buffer = await page.screenshot({ type: "png", fullPage: true });
    return buffer;
  } finally {
    await page.close();
  }
}

/**
 * Renders `html` as a real PDF page — the A4/A5 path. A sheet printer's driver
 * wants a page, not a bitmap: a screenshot scaled to A4 prints soft text and
 * loses selectable content, and the template already declares its own `@page`
 * size and margins, so `preferCSSPageSize` reproduces exactly what the
 * designer's preview showed.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(withEmbeddedFont(html), { waitUntil: "networkidle" });
    return await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await page.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}
