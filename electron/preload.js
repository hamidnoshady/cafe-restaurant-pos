// Bridge between the Electron shell and the web app.
//
// Deliberately minimal and explicitly enumerated: contextIsolation stays on,
// and the renderer gets exactly the native capabilities it needs and nothing
// more. Today that is one thing — a real folder picker for the backup
// destination, which a browser cannot provide.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  /** Opens the OS folder dialog. Resolves to the chosen absolute path, or null if cancelled. */
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
});
