/**
 * HTML → PNG rendering for the print agent. Uses a real browser engine
 * (Chromium via playwright-core) rather than any text-mode ESC/POS codepage
 * because no printer we can target reliably shapes/reorders Persian text —
 * see src/lib/escpos.ts's header comment. The screenshot is later packed
 * into an ESC/POS raster image by png.ts + src/lib/escpos.ts.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { chromium, type Browser } from "playwright-core";

const FONT_PATH = join(__dirname, "..", "src", "app", "fonts", "Vazirmatn-Variable.woff2");
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
    // No bundled browser download with playwright-core (deliberately lighter
    // than @playwright/test on a till PC) — point it at a Chromium install.
    // In this sandbox that's the pre-installed one; on a real till PC, set
    // PRINT_AGENT_CHROMIUM_PATH to wherever `npx playwright install
    // chromium` (or the system Chromium/Chrome binary) landed.
    const executablePath = process.env.PRINT_AGENT_CHROMIUM_PATH || "/opt/pw-browsers/chromium";
    browserPromise = chromium.launch({ executablePath, args: ["--no-sandbox"] });
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
