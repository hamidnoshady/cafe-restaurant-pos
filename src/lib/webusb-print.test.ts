/**
 * webusb-print.ts — the browser as delivery middleman. `navigator.usb` is
 * mocked with scriptable fake devices, which is the only honest way to unit
 * test WebUSB (no hardware, no permission chooser in a test runner), and it
 * pins exactly the behaviours a till depends on:
 *
 *  - pairing falls back to an unfiltered chooser before reporting a cancel
 *    (vendor-specific printers don't always declare the printer class);
 *  - a paired device is re-found by vendor/product and disambiguated by
 *    serial when two identical printers are plugged in;
 *  - the ESC/POS bytes arrive intact, in order, on the printer-class
 *    bulk-OUT endpoint, chunked at 16KB;
 *  - every failure mode maps to the exact error string the settings screen
 *    explains (usb_claim_failed being the Windows-driver one);
 *  - the device is released and closed after every job, success or failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findPairedDevice,
  probeWebUsbPrinter,
  requestWebUsbPrinter,
  sendBytesViaWebUsb,
  webUsbSupported,
} from "./webusb-print";

/* ─────────────────────────── fake device rig ─────────────────────────── */

interface FakeDeviceOptions {
  vendorId?: number;
  productId?: number;
  serialNumber?: string | null;
  productName?: string | null;
  /** Interface class for the alternate carrying the bulk-OUT endpoint. */
  interfaceClass?: number;
  /** Leave out the bulk-OUT endpoint entirely. */
  noOutEndpoint?: boolean;
  failOpen?: boolean;
  failClaim?: boolean;
  failTransfer?: boolean;
}

function fakeDevice(opts: FakeDeviceOptions = {}) {
  const endpoints = opts.noOutEndpoint
    ? [{ endpointNumber: 1, direction: "in", type: "bulk" }]
    : [
        { endpointNumber: 1, direction: "in", type: "bulk" },
        { endpointNumber: 2, direction: "out", type: "bulk" },
      ];
  const device = {
    vendorId: opts.vendorId ?? 0x04b8,
    productId: opts.productId ?? 0x0e15,
    serialNumber: opts.serialNumber ?? null,
    productName: opts.productName ?? "TM-T20III",
    manufacturerName: "EPSON",
    opened: false,
    configuration: null as unknown,
    configurations: [
      {
        configurationValue: 1,
        interfaces: [
          {
            interfaceNumber: 0,
            claimed: false,
            alternates: [{ alternateSetting: 0, interfaceClass: opts.interfaceClass ?? 7, endpoints }],
          },
        ],
      },
    ],
    writes: [] as Uint8Array[],
    open: vi.fn(async () => {
      if (opts.failOpen) throw new Error("open failed");
      device.opened = true;
    }),
    close: vi.fn(async () => {
      device.opened = false;
    }),
    selectConfiguration: vi.fn(async (value: number) => {
      device.configuration = device.configurations.find((c) => c.configurationValue === value) ?? null;
    }),
    claimInterface: vi.fn(async () => {
      if (opts.failClaim) throw new Error("claim failed"); // Windows usbprint.sys owns it
    }),
    releaseInterface: vi.fn(async () => {}),
    transferOut: vi.fn(async (_endpoint: number, data: BufferSource) => {
      if (opts.failTransfer) return { status: "stall", bytesWritten: 0 };
      device.writes.push(new Uint8Array(data as ArrayBufferView as Uint8Array));
      return { status: "ok", bytesWritten: (data as ArrayBufferView).byteLength };
    }),
  };
  return device;
}

type FakeDevice = ReturnType<typeof fakeDevice>;

function installUsb(devices: FakeDevice[], requestResult?: FakeDevice | Error[] | Error) {
  const requestDevice = vi.fn(async () => {
    if (requestResult instanceof Error) throw requestResult;
    if (Array.isArray(requestResult)) {
      const next = requestResult.shift();
      if (next) throw next;
    }
    if (requestResult && !(requestResult instanceof Error) && !Array.isArray(requestResult)) return requestResult;
    throw new Error("NotFoundError");
  });
  vi.stubGlobal("navigator", {
    usb: {
      getDevices: vi.fn(async () => devices),
      requestDevice,
    },
  });
  return { requestDevice };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ─────────────────────────────── tests ─────────────────────────────── */

describe("webUsbSupported", () => {
  it("is true only when navigator.usb exists", () => {
    installUsb([]);
    expect(webUsbSupported()).toBe(true);
    vi.stubGlobal("navigator", {});
    expect(webUsbSupported()).toBe(false);
  });
});

describe("requestWebUsbPrinter", () => {
  it("returns the chosen device's pairing identifiers", async () => {
    const device = fakeDevice({ serialNumber: "SN9", productName: "TM-T20III" });
    installUsb([], device);
    const result = await requestWebUsbPrinter();
    expect(result).toEqual({
      ok: true,
      printer: { usbVendorId: 0x04b8, usbProductId: 0x0e15, usbSerial: "SN9", usbProductName: "TM-T20III" },
    });
  });

  it("strips NUL padding from the device's serial and product name at pairing time", async () => {
    // Plenty of printer firmwares report fixed-size EEPROM string descriptors
    // verbatim, NUL padding included. Those bytes must never reach the server:
    // PostgreSQL rejects \u0000 in jsonb (22P05) and the save 500s.
    const device = fakeDevice({ serialNumber: "VNBV9BJGLG\u0000\u0000\u0000", productName: "USB Printer\u0000P" });
    installUsb([], device);
    const result = await requestWebUsbPrinter();
    expect(result).toEqual({
      ok: true,
      printer: { usbVendorId: 0x04b8, usbProductId: 0x0e15, usbSerial: "VNBV9BJGLG", usbProductName: "USB PrinterP" },
    });
  });

  it("retries unfiltered when the printer-class filter matches nothing", async () => {
    const device = fakeDevice();
    // First call (classCode 7 filter) throws; the fallback unfiltered call succeeds.
    const requestDevice = vi
      .fn()
      .mockRejectedValueOnce(new Error("NotFoundError"))
      .mockResolvedValueOnce(device);
    vi.stubGlobal("navigator", { usb: { getDevices: vi.fn(async () => []), requestDevice } });

    const result = await requestWebUsbPrinter();
    expect(result.ok).toBe(true);
    expect(requestDevice).toHaveBeenCalledTimes(2);
    expect(requestDevice.mock.calls[0][0]).toEqual({ filters: [{ classCode: 7 }] });
    expect(requestDevice.mock.calls[1][0]).toEqual({ filters: [] });
  });

  it("reports cancelled after both attempts fail, and unsupported without navigator.usb", async () => {
    installUsb([], [new Error("cancel"), new Error("cancel")]);
    expect(await requestWebUsbPrinter()).toEqual({ ok: false, error: "cancelled" });

    vi.stubGlobal("navigator", {});
    expect(await requestWebUsbPrinter()).toEqual({ ok: false, error: "unsupported" });
  });
});

describe("findPairedDevice", () => {
  it("matches by vendor and product id", async () => {
    const target = fakeDevice({ vendorId: 0x04b8, productId: 0x0e15 });
    const other = fakeDevice({ vendorId: 0x0519, productId: 0x0001 });
    installUsb([other, target]);
    expect(await findPairedDevice({ usbVendorId: 0x04b8, usbProductId: 0x0e15 })).toBe(target);
  });

  it("disambiguates two identical printers by serial number", async () => {
    const first = fakeDevice({ serialNumber: "AAA" });
    const second = fakeDevice({ serialNumber: "BBB" });
    installUsb([first, second]);
    expect(await findPairedDevice({ usbVendorId: 0x04b8, usbProductId: 0x0e15, usbSerial: "BBB" })).toBe(second);
    // An unknown serial still yields a device rather than nothing — the
    // firmware may have stopped reporting it after a driver update.
    expect(await findPairedDevice({ usbVendorId: 0x04b8, usbProductId: 0x0e15, usbSerial: "ZZZ" })).toBe(first);
  });

  it("matches a stored cleaned serial against a live NUL-padded one", async () => {
    // The stored serial was cleaned at pairing time; the live device still
    // reports its padded form — a strict equality would silently miss it.
    const first = fakeDevice({ serialNumber: "AAA\u0000\u0000" });
    const second = fakeDevice({ serialNumber: "BBB\u0000\u0000" });
    installUsb([first, second]);
    expect(await findPairedDevice({ usbVendorId: 0x04b8, usbProductId: 0x0e15, usbSerial: "BBB" })).toBe(second);
  });

  it("matches on vendor alone when no product id was stored", async () => {
    const device = fakeDevice();
    installUsb([device]);
    expect(await findPairedDevice({ usbVendorId: 0x04b8 })).toBe(device);
  });

  it("returns null when the device is unplugged or was never paired", async () => {
    installUsb([]);
    expect(await findPairedDevice({ usbVendorId: 0x04b8 })).toBeNull();
  });
});

describe("probeWebUsbPrinter", () => {
  it("is reachable exactly when the paired device is visible", async () => {
    installUsb([fakeDevice({ productName: "TM-T20III" })]);
    expect(await probeWebUsbPrinter({ usbVendorId: 0x04b8 })).toEqual({ reachable: true, detail: "TM-T20III" });

    installUsb([]);
    expect(await probeWebUsbPrinter({ usbVendorId: 0x04b8 })).toEqual({
      reachable: false,
      detail: "not_paired_or_unplugged",
    });

    vi.stubGlobal("navigator", {});
    expect(await probeWebUsbPrinter({ usbVendorId: 0x04b8 })).toEqual({
      reachable: false,
      detail: "webusb_unsupported",
    });
  });
});

describe("sendBytesViaWebUsb", () => {
  const CONNECTION = { usbVendorId: 0x04b8, usbProductId: 0x0e15 };

  it("delivers the bytes intact and in order to the bulk-OUT endpoint, then releases and closes", async () => {
    const device = fakeDevice();
    installUsb([device]);
    const bytes = Uint8Array.from(Array.from({ length: 300 }, (_, i) => i % 256));

    const result = await sendBytesViaWebUsb(CONNECTION, bytes);
    expect(result).toEqual({ ok: true });
    expect(device.open).toHaveBeenCalled();
    expect(device.selectConfiguration).toHaveBeenCalledWith(1);
    expect(device.claimInterface).toHaveBeenCalledWith(0);
    // Endpoint 2 is the bulk-OUT one in the fake's alternate.
    expect(device.transferOut.mock.calls.every(([endpoint]) => endpoint === 2)).toBe(true);

    const sent = new Uint8Array(device.writes.reduce((n, w) => n + w.length, 0));
    let offset = 0;
    for (const write of device.writes) {
      sent.set(write, offset);
      offset += write.length;
    }
    expect(sent).toEqual(bytes);

    expect(device.releaseInterface).toHaveBeenCalledWith(0);
    expect(device.close).toHaveBeenCalled();
  });

  it("chunks a large job at 16KB — some firmwares choke on one giant transfer", async () => {
    const device = fakeDevice();
    installUsb([device]);
    const bytes = new Uint8Array(40 * 1024).fill(0xaa);

    await sendBytesViaWebUsb(CONNECTION, bytes);
    expect(device.writes.map((w) => w.length)).toEqual([16 * 1024, 16 * 1024, 8 * 1024]);
  });

  it("maps each failure mode to the error string the UI explains", async () => {
    vi.stubGlobal("navigator", {});
    expect(await sendBytesViaWebUsb(CONNECTION, new Uint8Array(1))).toEqual({ ok: false, error: "unsupported" });

    installUsb([]);
    expect(await sendBytesViaWebUsb(CONNECTION, new Uint8Array(1))).toEqual({ ok: false, error: "not_paired" });

    installUsb([fakeDevice({ failOpen: true })]);
    expect(await sendBytesViaWebUsb(CONNECTION, new Uint8Array(1))).toEqual({ ok: false, error: "usb_open_failed" });

    // The Windows case: usbprint.sys / a vendor driver already owns the interface.
    installUsb([fakeDevice({ failClaim: true })]);
    expect(await sendBytesViaWebUsb(CONNECTION, new Uint8Array(1))).toEqual({ ok: false, error: "usb_claim_failed" });

    installUsb([fakeDevice({ noOutEndpoint: true })]);
    expect(await sendBytesViaWebUsb(CONNECTION, new Uint8Array(1))).toEqual({ ok: false, error: "no_out_endpoint" });

    installUsb([fakeDevice({ failTransfer: true })]);
    expect(await sendBytesViaWebUsb(CONNECTION, new Uint8Array(1))).toEqual({ ok: false, error: "usb_write_failed" });
  });

  it("still closes the device when the transfer fails mid-job", async () => {
    const device = fakeDevice({ failTransfer: true });
    installUsb([device]);
    await sendBytesViaWebUsb(CONNECTION, new Uint8Array(1));
    expect(device.releaseInterface).toHaveBeenCalled();
    expect(device.close).toHaveBeenCalled();
  });

  it("falls back to a non-printer-class bulk-OUT endpoint when the device does not declare class 7", async () => {
    const device = fakeDevice({ interfaceClass: 0xff }); // vendor-specific
    installUsb([device]);
    const result = await sendBytesViaWebUsb(CONNECTION, Uint8Array.from([1, 2, 3]));
    expect(result).toEqual({ ok: true });
    expect(device.writes).toHaveLength(1);
  });
});
