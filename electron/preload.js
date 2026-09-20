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
}));
