/**
 * discovery.ts — finding printers. The LAN sweep is tested for real against
 * loopback listeners (127.0.0.x is a /24 like any other, and a listening
 * socket is indistinguishable from a printer's port 9100), which pins the
 * three behaviours that matter: an open port is found, a closed subnet
 * yields an empty list rather than an error, and one host answering on two
 * ports collapses to a single row keeping the port the transport will use.
 *
 * listSystemPrinters is asserted on its contract — best-effort, never throws
 * — because its real output is whatever spooler this machine has.
 */
import { createServer, type Server } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listSystemPrinters, localSubnets, scanLanPrinters } from "./discovery";

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// High, unassigned-looking ports so a parallel test run or a real service on
// this machine can't collide with the sweep's expectations.
const PORT_A = 42_611;
const PORT_B = 42_612;

let servers: Server[] = [];

beforeAll(async () => {
  servers = [await listen(PORT_A), await listen(PORT_B)];
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
});

describe("scanLanPrinters", () => {
  it("finds a listening port on the swept subnet and reports its latency", async () => {
    const found = await scanLanPrinters({ subnets: ["127.0.0"], ports: [PORT_A], timeoutMs: 250 });
    const hit = found.find((p) => p.ip === "127.0.0.1");
    expect(hit).toBeDefined();
    expect(hit!.port).toBe(PORT_A);
    expect(hit!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("collapses one host answering on several ports to a single row, keeping the lowest port", async () => {
    const found = await scanLanPrinters({ subnets: ["127.0.0"], ports: [PORT_B, PORT_A], timeoutMs: 250 });
    const hits = found.filter((p) => p.ip === "127.0.0.1");
    expect(hits).toHaveLength(1);
    expect(hits[0].port).toBe(PORT_A);
  });

  it("yields an empty list, not an error, when nothing answers", async () => {
    // A loopback subnet with nothing bound: every connect gets an immediate
    // RST from the kernel. (A reserved external subnet would be nicer prose,
    // but an egress proxy that accepts all outbound TCP — as in CI sandboxes
    // — would turn it into 254 false positives.)
    const found = await scanLanPrinters({ subnets: ["127.0.9"], ports: [PORT_A], timeoutMs: 250, concurrency: 254 });
    expect(found).toEqual([]);
  }, 20_000);
});

describe("localSubnets", () => {
  it("returns /24 prefixes, excluding loopback and link-local", () => {
    const subnets = localSubnets();
    expect(Array.isArray(subnets)).toBe(true);
    for (const subnet of subnets) {
      expect(subnet).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/);
      expect(subnet).not.toBe("127.0.0");
      expect(subnet.startsWith("169.254")).toBe(false);
    }
  });
});

describe("listSystemPrinters", () => {
  it("is best-effort: resolves to an array on any machine, spooler or not", async () => {
    const printers = await listSystemPrinters();
    expect(Array.isArray(printers)).toBe(true);
    for (const printer of printers) {
      expect(typeof printer.name).toBe("string");
      expect(typeof printer.isDefault).toBe("boolean");
      expect(typeof printer.likelyThermal).toBe("boolean");
    }
  });
});
