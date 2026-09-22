"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", Object.freeze({
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
}));

contextBridge.exposeInMainWorld("businessSuiteDesktop", Object.freeze({
  isDesktop: true,
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  localGateway: Object.freeze({
    status: () => ipcRenderer.invoke("desktop:gateway-status"),
    enable: (address) => ipcRenderer.invoke("desktop:gateway-enable", { address }),
    disable: () => ipcRenderer.invoke("desktop:gateway-disable"),
    installFirewallRule: () => ipcRenderer.invoke("desktop:firewall-install"),
    removeFirewallRule: () => ipcRenderer.invoke("desktop:firewall-remove"),
    regenerateCertificate: () => ipcRenderer.invoke("desktop:gateway-regenerate-certificate"),
    showCaCertificate: () => ipcRenderer.invoke("desktop:show-ca-certificate"),
    openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
  }),
  /**
   * Native printing (Section 7 of the desktop audit): the same
   * `{type:"windows", systemName}` / `{type:"network", ip, port}` target
   * shape `src/lib/printing/types.ts` already models, delivered straight
   * from this desktop process — no separate "print connector" install. The
   * printing settings UI (`src/lib/printing/client.ts`) prefers this bridge
   * over the loopback connector whenever `window.businessSuiteDesktop` is
   * present; the connector remains the path for the browser/cloud product.
   */
  printing: Object.freeze({
    listWindowsPrinters: () => ipcRenderer.invoke("desktop:print-list-windows-printers"),
    discoverNetworkPrinters: () => ipcRenderer.invoke("desktop:print-discover-network"),
    probe: (target) => ipcRenderer.invoke("desktop:print-probe", { target }),
    sendRaw: (target, dataBase64) => ipcRenderer.invoke("desktop:print-send-raw", { target, dataBase64 }),
  }),
}));

