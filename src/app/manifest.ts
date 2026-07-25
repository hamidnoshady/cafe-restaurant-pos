import type { MetadataRoute } from "next";

/**
 * PWA manifest (Phase 12) — served at /manifest.webmanifest by Next 15.
 *
 * Makes the POS installable as a standalone desktop app on the café laptop
 * (and on tablets/phones). Once installed, Chrome/Edge give it its own window
 * with no browser chrome, a Start-menu entry, and an icon — so it launches and
 * behaves like native software. The Windows launcher (Start-CafePOS) opens
 * this installed app directly.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "سیستم فروش کافه و رستوران",
    short_name: "Café POS",
    description: "Cafe/Restaurant POS — point of sale, kitchen, and management",
    // Standalone = its own window, no browser tabs/address bar (looks native).
    display: "standalone",
    // Where the app opens. Relative so it works on localhost, LAN IP, or domain.
    start_url: "/",
    scope: "/",
    dir: "rtl",
    lang: "fa",
    orientation: "any",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    icons: [
      {
        // A single SVG covers all sizes; Chrome/Edge accept sizes:"any" for install.
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
