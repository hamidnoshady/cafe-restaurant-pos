import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { PwaRegister } from "@/components/pwa-register";

const vazirmatn = localFont({
  src: "./fonts/Vazirmatn-Variable.woff2",
  variable: "--font-vazirmatn",
  display: "swap",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "سیستم فروش کافه و رستوران",
  description: "Cafe/Restaurant POS",
  // Next 15 auto-links /manifest.webmanifest from manifest.ts; these add the
  // icon + iOS/standalone hints so the installed app looks and launches native.
  applicationName: "Café POS",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Café POS",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
  // Prevent pinch-zoom flicker in the standalone POS window while still
  // allowing the layout to fit tablets and the café laptop screen.
  width: "device-width",
  initialScale: 1,
};


export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fa" dir="rtl" className={vazirmatn.variable} suppressHydrationWarning>
      <body className="font-sans">
        <ThemeProvider>
          {children}
          <Toaster position="bottom-center" dir="rtl" />
          <PwaRegister />
        </ThemeProvider>

      </body>
    </html>
  );
}
