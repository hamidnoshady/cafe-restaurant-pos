import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { isPrivateIpv4, listLanInterfaces } = require("../../electron/network-interfaces.js") as {
  isPrivateIpv4: (address: string) => boolean;
  listLanInterfaces: (source: Record<string, unknown[]>) => Array<{ name: string; address: string }>;
};

describe("desktop LAN interface selection", () => {
  it("accepts RFC1918 addresses and rejects public/link-local/loopback addresses", () => {
    expect(isPrivateIpv4("10.2.3.4")).toBe(true);
    expect(isPrivateIpv4("172.16.4.2")).toBe(true);
    expect(isPrivateIpv4("192.168.1.20")).toBe(true);
    expect(isPrivateIpv4("172.32.0.1")).toBe(false);
    expect(isPrivateIpv4("169.254.2.3")).toBe(false);
    expect(isPrivateIpv4("127.0.0.1")).toBe(false);
  });

  it("excludes virtual, loopback, IPv6 and inactive-looking adapters", () => {
    const result = listLanInterfaces({
      "Wi-Fi": [{ family: "IPv4", address: "192.168.1.20", internal: false, netmask: "255.255.255.0", mac: "a" }],
      "vEthernet (WSL)": [{ family: "IPv4", address: "172.20.0.1", internal: false, netmask: "255.255.0.0", mac: "b" }],
      Loopback: [{ family: "IPv4", address: "127.0.0.1", internal: true, netmask: "255.0.0.0", mac: "c" }],
      Ethernet: [{ family: "IPv6", address: "fd00::1", internal: false, netmask: "ffff::", mac: "d" }],
    });
    expect(result).toEqual([{ name: "Wi-Fi", address: "192.168.1.20", netmask: "255.255.255.0", mac: "a" }]);
  });
});
