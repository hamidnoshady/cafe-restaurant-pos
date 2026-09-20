"use strict";

const os = require("node:os");

const VIRTUAL_ADAPTER_RE = /(docker|wsl|hyper-v|vethernet|vmware|virtualbox|loopback|teredo|isatap|bluetooth)/i;

function isPrivateIpv4(address) {
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function listLanInterfaces(source = os.networkInterfaces()) {
  const interfaces = [];
  for (const [name, addresses] of Object.entries(source)) {
    if (VIRTUAL_ADAPTER_RE.test(name)) continue;
    for (const item of addresses || []) {
      const family = typeof item.family === "string" ? item.family : item.family === 4 ? "IPv4" : "IPv6";
      if (family !== "IPv4" || item.internal || !isPrivateIpv4(item.address)) continue;
      interfaces.push({ name, address: item.address, netmask: item.netmask, mac: item.mac });
    }
  }
  return interfaces.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}

module.exports = { isPrivateIpv4, listLanInterfaces, VIRTUAL_ADAPTER_RE };
