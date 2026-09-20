/**
 * HTML → PNG rendering for thermal printing. Uses a real browser engine
 * (Chromium via playwright-core) rather than any text-mode ESC/POS codepage
 * because no printer we can target reliably shapes/reorders Persian text —
 * see src/lib/escpos.ts's header comment. The screenshot is later packed
 * into an ESC/POS raster image by raster.ts + src/lib/escpos.ts.
 *
 * Server-only: this runs inside the app server (the /api/printing/* routes),
 * which owns the rendering pipeline. It never talks to restaurant hardware —
 * the rendered bytes travel back to the browser and out through the local
 * Cafe POS connector. Paths resolve from `process.cwd()` (the repo root under
 * `next start`/the custom server; `__dirname` is unreliable once Next bundles
 * a route handler).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { chromium, type Browser } from "playwright-core";
import { chromiumLaunchArgs, findChromiumExecutable } from "../chromium-executable";

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

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      executablePath: findChromiumExecutable(),
      args: chromiumLaunchArgs(),
    });
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

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}
