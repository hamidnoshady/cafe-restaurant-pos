"use client";

/**
 * WebUSB delivery for the `webusb` printer transport — the browser as the
 * middleman between a server installation and a local USB receipt printer.
 *
 * The shape of the problem: on a server installation the app runs somewhere
 * the printers are not (a container, another building), so neither the local
 * print agent (not installed) nor the server's own /api/print routes (wrong
 * machine) can reach the till's USB printer. But the *browser* is physically
 * at the counter, and Chromium's WebUSB API gives a secure-context page a
 * direct pipe to a USB device the user has explicitly paired. So the job is
 * split by who has what: the server renders the ESC/POS bytes (it owns the
 * Chromium raster pipeline that shapes Persian text — see escpos.ts), and
 * this module pushes those bytes down the cable. No print dialog anywhere.
 *
 * Pairing is a one-time browser chooser (`requestWebUsbPrinter`); the granted
 * permission persists per-origin, so every later job re-finds the device
 * silently by vendor/product/serial (`findPairedDevice`) and just writes.
 *
 * Caveats stated where the user can see them (printer-hardware.tsx):
 *  - Chromium-only (Chrome/Edge/Opera), and only on HTTPS or localhost.
 *  - On Windows, a device already claimed by a vendor driver's usbprint.sys
 *    may refuse `claimInterface`; printers installed as plain USB devices
 *    (or with the driver removed) work. The error surfaces as `usb_claim_failed`.
 */

/* Minimal WebUSB typings — TypeScript's dom lib does not ship them. */
interface UsbEndpoint {
  endpointNumber: number;
  direction: "in" | "out";
  type: "bulk" | "interrupt" | "isochronous";
}
interface UsbAlternateInterface {
  alternateSetting: number;
  interfaceClass: number;
  endpoints: UsbEndpoint[];
}
interface UsbInterface {
  interfaceNumber: number;
  alternates: UsbAlternateInterface[];
  claimed: boolean;
}
interface UsbConfiguration {
  configurationValue: number;
  interfaces: UsbInterface[];
}
interface UsbDevice {
  vendorId: number;
  productId: number;
  serialNumber?: string | null;
  productName?: string | null;
  manufacturerName?: string | null;
  opened: boolean;
  configuration: UsbConfiguration | null;
  configurations: UsbConfiguration[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<{ status: string; bytesWritten: number }>;
}
interface Usb {
  getDevices(): Promise<UsbDevice[]>;
  requestDevice(options: { filters: { classCode?: number; vendorId?: number; productId?: number }[] }): Promise<UsbDevice>;
}

function usb(): Usb | null {
  if (typeof navigator === "undefined") return null;
  return ((navigator as unknown as { usb?: Usb }).usb) ?? null;
}

/** Does this browser expose WebUSB at all (Chromium on a secure context)? */
export function webUsbSupported(): boolean {
  return usb() !== null;
}

export interface WebUsbPrinterId {
  usbVendorId: number;
  usbProductId: number;
  usbSerial: string | null;
  usbProductName: string | null;
}

export interface WebUsbConnectionLike {
  usbVendorId?: number | null;
  usbProductId?: number | null;
  usbSerial?: string | null;
}

/**
 * Open the browser's device chooser and let the user pick their printer —
 * the one-time pairing step. Filters on the USB printer class (7) first;
 * a second unfiltered attempt covers vendor-specific printers that don't
 * declare it at the device level.
 */
export async function requestWebUsbPrinter(): Promise<
  { ok: true; printer: WebUsbPrinterId } | { ok: false; error: "unsupported" | "cancelled" }
> {
  const bus = usb();
  if (!bus) return { ok: false, error: "unsupported" };
  let device: UsbDevice;
  try {
    device = await bus.requestDevice({ filters: [{ classCode: 7 }] });
  } catch {
    // Either nothing matched the printer-class filter or the user cancelled.
    // Retry unfiltered once so a vendor-specific printer is still choosable;
    // a second cancel is a real cancel.
    try {
      device = await bus.requestDevice({ filters: [] });
    } catch {
      return { ok: false, error: "cancelled" };
    }
  }
  return {
    ok: true,
    printer: {
      usbVendorId: device.vendorId,
      usbProductId: device.productId,
      usbSerial: device.serialNumber ?? null,
      usbProductName: device.productName ?? null,
    },
  };
}

/** Re-find an already-paired device without prompting — permission persists per-origin. */
export async function findPairedDevice(connection: WebUsbConnectionLike): Promise<UsbDevice | null> {
  const bus = usb();
  if (!bus) return null;
  const devices = await bus.getDevices();
  const matches = devices.filter(
    (d) =>
      d.vendorId === connection.usbVendorId &&
      (connection.usbProductId == null || d.productId === connection.usbProductId),
  );
  if (matches.length > 1 && connection.usbSerial) {
    const bySerial = matches.find((d) => d.serialNumber === connection.usbSerial);
    if (bySerial) return bySerial;
  }
  return matches[0] ?? null;
}

/** Is the paired printer plugged in and visible to this browser right now? */
export async function probeWebUsbPrinter(connection: WebUsbConnectionLike): Promise<{ reachable: boolean; detail?: string }> {
  if (!webUsbSupported()) return { reachable: false, detail: "webusb_unsupported" };
  const device = await findPairedDevice(connection);
  return device ? { reachable: true, detail: device.productName ?? undefined } : { reachable: false, detail: "not_paired_or_unplugged" };
}

/** The printer-class interface's bulk-OUT endpoint, else any bulk-OUT — where ESC/POS bytes go. */
function findOutEndpoint(device: UsbDevice): { interfaceNumber: number; endpointNumber: number } | null {
  const config = device.configuration ?? device.configurations[0];
  if (!config) return null;
  let fallback: { interfaceNumber: number; endpointNumber: number } | null = null;
  for (const iface of config.interfaces) {
    for (const alt of iface.alternates) {
      const out = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
      if (!out) continue;
      const found = { interfaceNumber: iface.interfaceNumber, endpointNumber: out.endpointNumber };
      if (alt.interfaceClass === 7) return found;
      fallback = fallback ?? found;
    }
  }
  return fallback;
}

export type WebUsbSendError =
  | "unsupported"
  | "not_paired"
  | "usb_open_failed"
  | "usb_claim_failed"
  | "no_out_endpoint"
  | "usb_write_failed";

/**
 * Push a rendered ESC/POS job down the cable. Opens, claims, writes in 16KB
 * chunks (a full-page raster is a few hundred KB and some printer firmwares
 * choke on one giant transfer), releases, closes — every job self-contained,
 * so an unplugged/replugged printer needs no state reset here.
 */
export async function sendBytesViaWebUsb(
  connection: WebUsbConnectionLike,
  bytes: Uint8Array,
): Promise<{ ok: true } | { ok: false; error: WebUsbSendError }> {
  if (!webUsbSupported()) return { ok: false, error: "unsupported" };
  const device = await findPairedDevice(connection);
  if (!device) return { ok: false, error: "not_paired" };

  try {
    if (!device.opened) await device.open();
  } catch {
    return { ok: false, error: "usb_open_failed" };
  }

  let claimed = -1;
  try {
    if (!device.configuration) {
      await device.selectConfiguration(device.configurations[0]?.configurationValue ?? 1);
    }
    const target = findOutEndpoint(device);
    if (!target) return { ok: false, error: "no_out_endpoint" };

    try {
      await device.claimInterface(target.interfaceNumber);
      claimed = target.interfaceNumber;
    } catch {
      // Windows: a kernel driver (usbprint.sys / vendor driver) already owns
      // the interface. The hardware hint in the settings screen explains this.
      return { ok: false, error: "usb_claim_failed" };
    }

    const CHUNK = 16 * 1024;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const slice = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
      const result = await device.transferOut(target.endpointNumber, slice as BufferSource);
      if (result.status !== "ok") return { ok: false, error: "usb_write_failed" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "usb_write_failed" };
  } finally {
    if (claimed >= 0) await device.releaseInterface(claimed).catch(() => {});
    await device.close().catch(() => {});
  }
}
