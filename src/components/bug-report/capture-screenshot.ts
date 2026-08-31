"use client";

/**
 * Captures the current screen as a downscaled JPEG data URL.
 *
 * Uses `html2canvas-pro` (the oklch/color-mix-aware fork) so the Tailwind v4
 * palette — which the stock html2canvas cannot parse — renders faithfully. The
 * library is imported lazily so it is only downloaded when a report is actually
 * being filed.
 *
 * The caller is responsible for hiding any overlay UI (the report dialog, the
 * floating button) before calling this; here we capture the viewport the user
 * is looking at (`scrollX`/`scrollY` + `windowWidth`/`windowHeight`), then
 * downscale to a max width so the data URL stays a few hundred KB at most.
 */

const MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.72;

export async function captureScreenshot(): Promise<string | null> {
  try {
    const { default: html2canvas } = await import("html2canvas-pro");

    const canvas = await html2canvas(document.body, {
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      backgroundColor: "#fafaf9",
      scale: Math.min(1, window.devicePixelRatio || 1),
      logging: false,
    });

    // Downscale so a high-DPI phone doesn't produce a 10 MB image.
    const width = Math.min(MAX_WIDTH, canvas.width);
    const height = Math.round((canvas.height / canvas.width) * width);
    if (width !== canvas.width) {
      const scaled = document.createElement("canvas");
      scaled.width = width;
      scaled.height = height;
      const ctx = scaled.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0, width, height);
      return scaled.toDataURL("image/jpeg", JPEG_QUALITY);
    }

    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } catch (err) {
    console.error("bug-report: screenshot capture failed", err);
    return null;
  }
}
