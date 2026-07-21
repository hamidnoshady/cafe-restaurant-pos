/**
 * HTML → PDF rendering for report export. Same reasoning and technique as
 * print-agent/render.ts (a real browser engine via playwright-core, since
 * Persian/RTL text needs real shaping — see src/lib/escpos.ts), but running
 * inside this app's own server process instead of the till-PC print agent,
 * so paths are resolved from `process.cwd()` (the project root under
 * `next start`/the custom server), not `__dirname` (unreliable once Next
 * bundles this route handler for production).
 */
import { readFileSync } from "fs";
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

function withEmbeddedFont(html: string): string {
  const style = `<style>@font-face{font-family:"Vazirmatn";src:url(${getFontDataUri()}) format("woff2");font-weight:100 900;font-style:normal;}</style>`;
  return html.replace("<head>", `<head>${style}`);
}

let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // No bundled browser download with playwright-core — point it at a
    // Chromium install. In this sandbox that's the pre-installed one; a
    // real deploy sets PDF_CHROMIUM_PATH to wherever
    // `npx playwright install chromium` (or a system Chromium/Chrome) landed.
    const executablePath = process.env.PDF_CHROMIUM_PATH || "/opt/pw-browsers/chromium";
    browserPromise = chromium.launch({ executablePath, args: ["--no-sandbox"] });
  }
  return browserPromise;
}

/** Renders `html` (an A4-oriented report page) to a PDF buffer. */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(withEmbeddedFont(html), { waitUntil: "networkidle" });
    const buffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
    });
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
