/**
 * The one shape `window.businessSuiteDesktop` has — exposed by
 * `electron/preload.js`, present only inside the packaged Windows desktop
 * app. Every browser surface that reaches into it (Local Devices, the
 * printing client) imports this type instead of re-declaring its own partial
 * `declare global` for the same global, which is what used to make two
 * files disagree about the shape of one bridge.
 */
import type { PrinterTarget } from "./printing/types";

export interface DesktopLanInterface {
  name: string;
  address: string;
  netmask: string;
  mac: string;
}

export interface DesktopGatewayStatus {
  supported: boolean;
  enabled: boolean;
  running: boolean;
  computerName: string;
  interfaces: DesktopLanInterface[];
  selectedAddress: string | null;
  port: number;
  url: string | null;
  caDownloadUrl: string | null;
  onboardingPort: number;
  onboardingScope: "ca-certificate-only";
  onboardingDownloads: number;
  lastOnboardingDownloadAt: string | null;
  tlsDiagnostics: { count: number; last: { code: string; message: string; at: string } | null };
  addressActive: boolean;
  certificate: {
    exists: boolean;
    fingerprint?: string;
    caFingerprint?: string;
    expiresAt?: string;
  };
  firewall: { supported: boolean; installed: boolean; error?: string };
  clients: Array<{ address: string; kind: string; lastSeenAt: string }>;
  logPath: string;
}

export interface DesktopWindowsPrinter {
  name: string;
  driver?: string | null;
  isDefault: boolean;
  likelyThermal: boolean;
}

export interface DesktopDiscoveredPrinter {
  ip: string;
  port: number;
  latencyMs: number;
}

/**
 * Direct native printing — Section 7 of the desktop audit: the desktop app
 * talks to `winspool.drv` and raw TCP sockets from its own process
 * (`electron/native-printing.js`), so it never needs the browser/cloud
 * product's separate loopback "print connector".
 */
export interface DesktopPrintingBridge {
  listWindowsPrinters(): Promise<{ ok: boolean; printers?: DesktopWindowsPrinter[]; error?: string; detail?: string }>;
  discoverNetworkPrinters(): Promise<{ ok: boolean; printers?: DesktopDiscoveredPrinter[]; error?: string; detail?: string }>;
  probe(target: PrinterTarget): Promise<{ ok: boolean; reachable?: boolean; detail?: string; error?: string }>;
  sendRaw(target: PrinterTarget, dataBase64: string): Promise<{ ok: boolean; error?: string; detail?: string }>;
}

export interface DesktopBridge {
  isDesktop: true;
  localGateway: {
    status(): Promise<DesktopGatewayStatus>;
    enable(address: string): Promise<DesktopGatewayStatus>;
    disable(): Promise<DesktopGatewayStatus>;
    installFirewallRule(): Promise<DesktopGatewayStatus>;
    removeFirewallRule(): Promise<DesktopGatewayStatus>;
    regenerateCertificate(): Promise<DesktopGatewayStatus>;
    showCaCertificate(): Promise<string>;
    openLogs(): Promise<string>;
  };
  /** Present since the native-printing bridge shipped; optional so older builds still type-check. */
  printing?: DesktopPrintingBridge;
}

declare global {
  interface Window {
    businessSuiteDesktop?: DesktopBridge;
  }
}
