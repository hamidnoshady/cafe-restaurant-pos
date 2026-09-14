/**
 * Finding printers the person setting up a till already has.
 *
 * Two lists, because a shop's printers arrive two ways:
 *
 *  1. The ones the operating system already knows about — the Windows print
 *     queues in "Printers & scanners" (USB receipt printers, a shared queue on
 *     another PC, the office laser), or CUPS on macOS/Linux. Nobody should
 *     have to find an IP for a printer Windows installed for them, so the
 *     agent enumerates them and the settings screen shows a list to pick from.
 *
 *  2. The ones on the LAN with no driver installed — an ESC/POS printer with
 *     an Ethernet/Wi-Fi module sitting on port 9100. Those are found by
 *     sweeping the local /24 for an open 9100, which takes a couple of seconds
 *     with a wide-enough parallel fan-out and saves a phone call to whoever
 *     configured it.
 *
 * Everything here is best-effort and never throws: a machine with no spooler,
 * a locked-down PowerShell, or a network that blocks the sweep just yields an
 * empty list, and the manual IP/queue-name fields stay available.
 */
import { execFile } from "child_process";
import { networkInterfaces } from "os";
import { Socket } from "net";
import { promisify } from "util";

const run = promisify(execFile);

export interface DiscoveredSystemPrinter {
  /** The queue name the spooler prints by — what goes into `connection.systemName`. */
  name: string;
  driver?: string | null;
  port?: string | null;
  isDefault: boolean;
  status?: string | null;
  /** Best guess from the name/driver: a thermal receipt printer vs a page printer. */
  likelyThermal: boolean;
}

const THERMAL_HINTS = /(pos|thermal|receipt|escpos|esc\/pos|tm-|tsp|rp\d|zj-|xp-|58|80mm|epson tm|star |bixolon|rongta|gprinter|oscar|sewoo)/i;

function classify(name: string, driver?: string | null): boolean {
  return THERMAL_HINTS.test(name) || THERMAL_HINTS.test(driver ?? "");
}

/** Windows: the spooler, read through PowerShell's Get-Printer (present since Win8). */
async function listWindowsPrinters(): Promise<DiscoveredSystemPrinter[]> {
  const script =
    "Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus,@{n='IsDefault';e={$_.Name -eq (Get-CimInstance Win32_Printer -Filter 'Default = $true').Name}} | ConvertTo-Json -Compress";
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 4_000_000,
  });
  const parsed = JSON.parse(stdout.trim() || "[]");
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter((p) => p && typeof p.Name === "string")
    .map((p) => ({
      name: String(p.Name),
      driver: p.DriverName ? String(p.DriverName) : null,
      port: p.PortName ? String(p.PortName) : null,
      isDefault: p.IsDefault === true,
      status: p.PrinterStatus != null ? String(p.PrinterStatus) : null,
      likelyThermal: classify(String(p.Name), p.DriverName ? String(p.DriverName) : null),
    }));
}

/** macOS/Linux: CUPS, read through `lpstat`. */
async function listCupsPrinters(): Promise<DiscoveredSystemPrinter[]> {
  const [{ stdout: printers }, defaultName] = await Promise.all([
    run("lpstat", ["-p"], { timeout: 10_000 }),
    run("lpstat", ["-d"], { timeout: 10_000 })
      .then(({ stdout }) => stdout.split(":")[1]?.trim() ?? "")
      .catch(() => ""),
  ]);
  return printers
    .split("\n")
    .map((line) => /^printer\s+(\S+)\s+(.*)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      name: match[1],
      driver: null,
      port: null,
      isDefault: match[1] === defaultName,
      status: match[2] ?? null,
      likelyThermal: classify(match[1]),
    }));
}

/** Every printer installed on the machine the agent runs on. Never throws. */
export async function listSystemPrinters(): Promise<DiscoveredSystemPrinter[]> {
  try {
    return process.platform === "win32" ? await listWindowsPrinters() : await listCupsPrinters();
  } catch {
    return [];
  }
}

/* ─────────────────────────── LAN sweep ─────────────────────────── */

export interface DiscoveredNetworkPrinter {
  ip: string;
  port: number;
  /** Milliseconds the TCP handshake took — a rough "is it right here" signal. */
  latencyMs: number;
}

/** The IPv4 /24 subnets this machine is on (skipping loopback and link-local). */
export function localSubnets(): string[] {
  const prefixes = new Set<string>();
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (address.address.startsWith("169.254.")) continue;
      prefixes.add(address.address.split(".").slice(0, 3).join("."));
    }
  }
  return [...prefixes];
}

function probe(ip: string, port: number, timeoutMs: number): Promise<DiscoveredNetworkPrinter | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new Socket();
    let settled = false;
    const finish = (result: DiscoveredNetworkPrinter | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => finish(null));
    socket.once("error", () => finish(null));
    socket.connect(port, ip, () => finish({ ip, port, latencyMs: Date.now() - started }));
  });
}

/**
 * Sweep `subnet` (a `192.168.1` style /24 prefix) for hosts answering on the
 * raw-print ports. Fans out in windows rather than opening 254 sockets at once
 * — a till PC's file-descriptor budget and a cheap router's ARP table both
 * dislike the alternative.
 */
export async function scanLanPrinters(opts: {
  subnets?: string[];
  ports?: number[];
  timeoutMs?: number;
  concurrency?: number;
} = {}): Promise<DiscoveredNetworkPrinter[]> {
  const subnets = opts.subnets?.length ? opts.subnets : localSubnets();
  const ports = opts.ports?.length ? opts.ports : [9100, 9101, 515];
  const timeoutMs = opts.timeoutMs ?? 350;
  const concurrency = opts.concurrency ?? 96;

  const targets: { ip: string; port: number }[] = [];
  for (const subnet of subnets) {
    for (let host = 1; host <= 254; host += 1) {
      for (const port of ports) targets.push({ ip: `${subnet}.${host}`, port });
    }
  }

  const found: DiscoveredNetworkPrinter[] = [];
  for (let i = 0; i < targets.length; i += concurrency) {
    const window = targets.slice(i, i + concurrency);
    const results = await Promise.all(window.map((t) => probe(t.ip, t.port, timeoutMs)));
    for (const result of results) if (result) found.push(result);
  }
  // One row per host: 9100 wins over the fallbacks when a printer answers on
  // several, because that is the port the transport will actually use.
  const byIp = new Map<string, DiscoveredNetworkPrinter>();
  for (const printer of found.sort((a, b) => a.port - b.port)) {
    if (!byIp.has(printer.ip)) byIp.set(printer.ip, printer);
  }
  return [...byIp.values()];
}
