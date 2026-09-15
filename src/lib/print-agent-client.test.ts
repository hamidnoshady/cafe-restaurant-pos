/**
 * print-agent-client.ts — the browser's print client and its routing table.
 * What must never regress:
 *
 *  - agent first, app server second: /api/print/* is called only when the
 *    loopback agent is UNREACHABLE, never when it answered with an error
 *    (the two backends may be different machines, and a real printer
 *    failure must surface rather than be retried elsewhere);
 *  - the `via` tag says which backend answered — the settings banner and
 *    discovery list wording depend on it;
 *  - a `webusb` printer bypasses both backends: /api/print/render for the
 *    bytes, then the WebUSB module for delivery, and its probe never
 *    leaves the browser;
 *  - a `browser` printer (or no printer) opens the browser dialog and
 *    touches no backend at all.
 *
 * fetch is mocked per-URL; webusb-print.ts is mocked wholesale (its own
 * behaviour is pinned in webusb-print.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as webusb from "./webusb-print";
import {
  allowPrintAgentRetry,
  checkAgent,
  kickDrawer,
  listSystemPrinters,
  printDocument,
  printKitchenTicket,
  printLabel,
  printReceipt,
  probePrinter,
  scanLanPrinters,
  testPrint,
} from "./print-agent-client";
import type { ReceiptData } from "./receipt-template";

vi.mock("./webusb-print", () => ({
  probeWebUsbPrinter: vi.fn(),
  sendBytesViaWebUsb: vi.fn(),
}));

const AGENT = "http://127.0.0.1:9123";

type Responder = (url: string, init?: RequestInit) => Promise<Response> | Response;

function respondJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function respondBytes(bytes: Uint8Array, status = 200): Response {
  return new Response(new Uint8Array(bytes).buffer as ArrayBuffer, {
    status,
    headers: { "Content-Type": "application/octet-stream" },
  });
}

/** Route fetch by URL prefix; anything unrouted rejects like a dead host. */
function mockFetch(routes: Record<string, Responder>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [prefix, responder] of Object.entries(routes)) {
      if (url.startsWith(prefix) || url === prefix) return responder(url, init);
    }
    throw new TypeError("fetch failed"); // unreachable host
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

const RECEIPT: ReceiptData = {
  business: { name: "کافه" },
  orderLabel: "#1",
  orderTypeLabel: "حضوری",
  issuedAt: new Date(),
  lines: [{ name: "چای", quantity: 1, lineTotal: 100 }],
  subtotal: 100,
  discount: 0,
  tax: 0,
  total: 100,
};

const NETWORK = { transport: "network" as const, ip: "10.0.0.5", port: 9100 };
const SYSTEM = { transport: "system" as const, systemName: "EPSON TM-T20III Receipt" };
const WEBUSB = { transport: "webusb" as const, usbVendorId: 0x04b8, usbProductId: 0x0e15 };

beforeEach(() => {
  vi.clearAllMocks();
  allowPrintAgentRetry();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent-first, server-fallback", () => {
  it("uses the agent's answer and never touches the server when the agent is up", async () => {
    const { calls } = mockFetch({
      [`${AGENT}/health`]: () => respondJson({ ok: true, platform: "win32", version: 2 }),
    });
    const result = await checkAgent();
    expect(result.ok).toBe(true);
    expect(result.via).toBe("agent");
    expect(result.data?.platform).toBe("win32");
    expect(calls.map((c) => c.url)).toEqual([`${AGENT}/health`]);
  });

  it("falls back to /api/print/health when the agent is unreachable, tagging via=server", async () => {
    const { calls } = mockFetch({
      "/api/print/health": () => respondJson({ ok: true, platform: "linux", version: 2, source: "server" }),
    });
    const result = await checkAgent();
    expect(result.ok).toBe(true);
    expect(result.via).toBe("server");
    expect(calls.map((c) => c.url)).toEqual([`${AGENT}/health`, "/api/print/health"]);
  });

  it("reports unreachable only when BOTH backends are down", async () => {
    mockFetch({});
    const result = await checkAgent();
    expect(result.ok).toBe(false);
    expect(result.unreachable).toBe(true);
  });

  it("does not repeatedly call a refused loopback port until an explicit retry", async () => {
    const { calls } = mockFetch({
      "/api/print/health": () => respondJson({ ok: true, source: "server" }),
      "/api/print/system-printers": () => respondJson({ ok: true, printers: [] }),
    });
    await checkAgent();
    await listSystemPrinters();
    expect(calls.map((call) => call.url)).toEqual([
      `${AGENT}/health`,
      "/api/print/health",
      "/api/print/system-printers",
    ]);

    allowPrintAgentRetry();
    await listSystemPrinters();
    expect(calls.map((call) => call.url).at(-2)).toBe(`${AGENT}/printers/system`);
  });

  it("a reachable agent's ERROR is final — never retried against the server", async () => {
    const { calls } = mockFetch({
      [`${AGENT}/print/receipt`]: () => respondJson({ ok: false, error: "printer_timeout" }, 502),
      "/api/print/job": () => respondJson({ ok: true }),
    });
    const result = await printReceipt(NETWORK, RECEIPT);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("printer_timeout");
    expect(result.via).toBe("agent");
    expect(calls.map((c) => c.url)).toEqual([`${AGENT}/print/receipt`]);
  });

  it("bridges server-rendered bytes to the dependency-free Windows connector", async () => {
    const bytes = Uint8Array.from([0x1b, 0x40, 0x1d, 0x56, 0x00]);
    let rawBody: Record<string, unknown> | null = null;
    const { calls } = mockFetch({
      [`${AGENT}/print/receipt`]: () => respondJson({ ok: false, error: "render_required" }, 409),
      "/api/print/render": () => respondBytes(bytes),
      [`${AGENT}/print/raw`]: (_url, init) => {
        rawBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return respondJson({ ok: true });
      },
    });

    const result = await printReceipt(SYSTEM, RECEIPT);

    expect(result).toEqual(expect.objectContaining({ ok: true, via: "agent" }));
    expect(calls.map((call) => call.url)).toEqual([
      `${AGENT}/print/receipt`,
      "/api/print/render",
      `${AGENT}/print/raw`,
    ]);
    expect(rawBody).toEqual({
      connection: SYSTEM,
      dataBase64: "G0AdVgA=",
    });
  });

  it("uses the render-to-raw bridge for every rich print operation", async () => {
    const renderOps: string[] = [];
    const rawPayloads: Array<Record<string, unknown>> = [];
    const renderRequired = () => respondJson({ ok: false, error: "render_required" }, 409);
    const { calls } = mockFetch({
      [`${AGENT}/print/document`]: renderRequired,
      [`${AGENT}/print/receipt`]: renderRequired,
      [`${AGENT}/print/kitchen-ticket`]: renderRequired,
      [`${AGENT}/print/label`]: renderRequired,
      [`${AGENT}/print/test`]: renderRequired,
      [`${AGENT}/drawer/kick`]: renderRequired,
      "/api/print/render": (_url, init) => {
        renderOps.push((JSON.parse(String(init?.body)) as { op: string }).op);
        return respondBytes(Uint8Array.from([renderOps.length]));
      },
      [`${AGENT}/print/raw`]: (_url, init) => {
        rawPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return respondJson({ ok: true });
      },
    });

    await printDocument(SYSTEM, "<html></html>", "thermal80");
    await printReceipt(SYSTEM, RECEIPT);
    await printKitchenTicket(SYSTEM, { label: "میز", orderTypeLabel: "حضوری", sentAt: new Date(), lines: [] });
    await printLabel(SYSTEM, { businessName: "ب", itemName: "آ", code: "1", fields: [] });
    await testPrint(SYSTEM, "kitchen");
    await kickDrawer(SYSTEM);

    expect(renderOps).toEqual(["document", "receipt", "kitchen-ticket", "label", "test", "drawer-kick"]);
    expect(rawPayloads).toHaveLength(6);
    expect(rawPayloads.map((payload) => payload.connection)).toEqual(Array(6).fill(SYSTEM));
    expect(rawPayloads.map((payload) => payload.dataBase64)).toEqual([
      "AQ==",
      "Ag==",
      "Aw==",
      "BA==",
      "BQ==",
      "Bg==",
    ]);
    expect(calls.map((call) => call.url)).not.toContain("/api/print/job");
  });

  it("never retries a claimed local queue on the cloud if final raw delivery fails", async () => {
    const { calls } = mockFetch({
      [`${AGENT}/print/receipt`]: () => respondJson({ ok: false, error: "render_required" }, 409),
      "/api/print/render": () => respondBytes(Uint8Array.from([1, 2, 3])),
      "/api/print/job": () => respondJson({ ok: true }),
    });

    const result = await printReceipt(SYSTEM, RECEIPT);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent_unreachable");
    expect(calls.map((call) => call.url)).not.toContain("/api/print/job");
  });

  it("system-printer discovery falls back to the server route", async () => {
    const printers = [{ name: "TM-T20", driver: null, port: null, isDefault: true, status: null, likelyThermal: true }];
    mockFetch({ "/api/print/system-printers": () => respondJson({ ok: true, printers }) });
    const result = await listSystemPrinters();
    expect(result.ok).toBe(true);
    expect(result.via).toBe("server");
    expect(result.data?.printers).toEqual(printers);
  });

  it("the LAN scan posts its body to whichever backend answers", async () => {
    const { calls } = mockFetch({
      "/api/print/scan": () => respondJson({ ok: true, printers: [{ ip: "10.0.0.7", port: 9100, latencyMs: 3 }] }),
    });
    const result = await scanLanPrinters({ subnets: ["10.0.0"] });
    expect(result.ok).toBe(true);
    const serverCall = calls.find((c) => c.url === "/api/print/scan")!;
    expect(JSON.parse(String(serverCall.init?.body))).toEqual({ subnets: ["10.0.0"] });
  });

  it("every print op falls back to /api/print/job with its own op discriminator", async () => {
    const ops: string[] = [];
    mockFetch({
      "/api/print/job": (_url, init) => {
        ops.push((JSON.parse(String(init?.body)) as { op: string }).op);
        return respondJson({ ok: true });
      },
    });
    await printReceipt(NETWORK, RECEIPT);
    await printKitchenTicket(NETWORK, { label: "میز", orderTypeLabel: "حضوری", sentAt: new Date(), lines: [] });
    await printLabel(NETWORK, { businessName: "ب", itemName: "آ", code: "1", fields: [] });
    await testPrint(NETWORK, "kitchen");
    await kickDrawer(NETWORK);
    expect(ops).toEqual(["receipt", "kitchen-ticket", "label", "test", "drawer-kick"]);
  });
});

describe("printDocument routing", () => {
  it("agent-first for a hardware printer", async () => {
    const { calls } = mockFetch({
      [`${AGENT}/print/document`]: () => respondJson({ ok: true }),
    });
    const result = await printDocument(NETWORK, "<html></html>", "thermal80");
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([`${AGENT}/print/document`]);
  });

  it("no printer at all → the browser dialog path, no backend calls (not in a DOM here → not_in_browser)", async () => {
    const { calls } = mockFetch({});
    const result = await printDocument(null, "<html></html>", "a4");
    // In node there is no `document`, which is exactly the guard's answer.
    expect(result).toEqual({ ok: false, error: "not_in_browser" });
    expect(calls).toHaveLength(0);
  });

  it("a browser-transport printer takes the same dialog path", async () => {
    const { calls } = mockFetch({});
    const result = await printDocument({ transport: "browser" }, "<html></html>", "a4");
    expect(result).toEqual({ ok: false, error: "not_in_browser" });
    expect(calls).toHaveLength(0);
  });
});

describe("the webusb transport — render on the server, deliver from this page", () => {
  it("fetches the bytes from /api/print/render and hands them to WebUSB", async () => {
    const bytes = Uint8Array.from([0x1b, 0x40, 1, 2, 3]);
    const { calls } = mockFetch({
      "/api/print/render": () => respondBytes(bytes),
    });
    vi.mocked(webusb.sendBytesViaWebUsb).mockResolvedValue({ ok: true });

    const result = await printReceipt(WEBUSB, RECEIPT);
    expect(result).toEqual({ ok: true, via: "server" });

    // Only the render route — never the agent, never /api/print/job.
    expect(calls.map((c) => c.url)).toEqual(["/api/print/render"]);
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body.op).toBe("receipt");
    expect(body.connection).toMatchObject({ transport: "webusb", usbVendorId: 0x04b8 });

    const [conn, sent] = vi.mocked(webusb.sendBytesViaWebUsb).mock.calls[0];
    expect(conn).toBe(WEBUSB);
    expect(sent).toEqual(bytes);
  });

  it("routes documents, tests and drawer kicks the same way", async () => {
    const ops: string[] = [];
    mockFetch({
      "/api/print/render": (_url, init) => {
        ops.push((JSON.parse(String(init?.body)) as { op: string }).op);
        return respondBytes(Uint8Array.from([1]));
      },
    });
    vi.mocked(webusb.sendBytesViaWebUsb).mockResolvedValue({ ok: true });

    await printDocument(WEBUSB, "<html></html>", "thermal80");
    await testPrint(WEBUSB, "receipt");
    await kickDrawer(WEBUSB);
    expect(ops).toEqual(["document", "test", "drawer-kick"]);
  });

  it("surfaces the render route's error without attempting delivery", async () => {
    mockFetch({
      "/api/print/render": () => respondJson({ ok: false, error: "sheet_printing_needs_a_system_printer" }, 502),
    });
    const result = await printDocument(WEBUSB, "<html></html>", "thermal80");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("sheet_printing_needs_a_system_printer");
    expect(webusb.sendBytesViaWebUsb).not.toHaveBeenCalled();
  });

  it("surfaces the USB delivery error verbatim — the UI explains usb_claim_failed", async () => {
    mockFetch({ "/api/print/render": () => respondBytes(Uint8Array.from([1])) });
    vi.mocked(webusb.sendBytesViaWebUsb).mockResolvedValue({ ok: false, error: "usb_claim_failed" });
    const result = await printReceipt(WEBUSB, RECEIPT);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("usb_claim_failed");
  });

  it("probes a webusb printer locally, asking no backend", async () => {
    const { calls } = mockFetch({});
    vi.mocked(webusb.probeWebUsbPrinter).mockResolvedValue({ reachable: true, detail: "TM-T20III" });
    const result = await probePrinter(WEBUSB);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ reachable: true, detail: "TM-T20III" });
    expect(calls).toHaveLength(0);
  });

  it("probes every other transport through the backends", async () => {
    mockFetch({ "/api/print/probe": () => respondJson({ ok: true, reachable: false, detail: "timeout" }) });
    const result = await probePrinter(NETWORK);
    expect(result.ok).toBe(true);
    expect(result.via).toBe("server");
    expect(webusb.probeWebUsbPrinter).not.toHaveBeenCalled();
  });
});
