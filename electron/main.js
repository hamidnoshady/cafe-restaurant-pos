// Business Suite Windows desktop shell.
// The application server remains loopback-only; explicitly enabled phones and
// tablets use the separate HTTPS gateway in gateway-manager.js.
"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const { BackendManager } = require("./backend-manager");
const { createCertificateManager } = require("./certificate-manager");
const { FirewallManager } = require("./firewall-manager");
const { GatewayManager } = require("./gateway-manager");
const { createLogger } = require("./logger");

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  let mainWindow = null;
  let backend = null;
  let gateway = null;
  let firewall = null;
  let logger = null;
  let quitting = false;
  let cleanupStarted = null;
  let ipcRegistered = false;

  function focusMainWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  app.on("second-instance", focusMainWindow);

  async function createWindow(appUrl) {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 620,
      title: "Business Suite",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(`${appUrl}/`) && url !== appUrl) event.preventDefault();
    });
    mainWindow.on("closed", () => { mainWindow = null; });
    await mainWindow.loadURL(appUrl);
  }

  async function gatewayStatus() {
    return { ...gateway.status(), firewall: await firewall.status(), logPath: logger.path };
  }

  function registerIpc() {
    if (ipcRegistered) return;
    ipcRegistered = true;
    ipcMain.handle("pick-folder", async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: "پوشهٔ پشتیبان‌گیری",
      });
      return canceled ? null : filePaths[0];
    });
    ipcMain.handle("desktop:gateway-status", gatewayStatus);
    ipcMain.handle("desktop:gateway-enable", async (_event, payload) => {
      const address = typeof payload?.address === "string" ? payload.address : "";
      const available = gateway.availableInterfaces();
      if (!available.some((item) => item.address === address)) throw new Error("invalid_lan_address");
      const port = backend.config.gatewayPort;
      const started = await gateway.start(address, port);
      backend.updateConfig((config) => {
        config.gateway = { enabled: true, selectedAddress: address };
      });
      return { ...(await gatewayStatus()), started };
    });
    ipcMain.handle("desktop:gateway-disable", async () => {
      await gateway.stop();
      backend.updateConfig((config) => {
        config.gateway = { enabled: false, selectedAddress: config.gateway?.selectedAddress || null };
      });
      return gatewayStatus();
    });
    ipcMain.handle("desktop:firewall-install", async () => {
      const result = await firewall.install(backend.config.gatewayPort);
      return { ...(await gatewayStatus()), firewall: result };
    });
    ipcMain.handle("desktop:firewall-remove", async () => {
      const result = await firewall.remove();
      return { ...(await gatewayStatus()), firewall: result };
    });
    ipcMain.handle("desktop:gateway-regenerate-certificate", async () => {
      const address = backend.config.gateway?.selectedAddress;
      if (!address) throw new Error("no_lan_address");
      await gateway.start(address, backend.config.gatewayPort, true);
      return gatewayStatus();
    });
    ipcMain.handle("desktop:show-ca-certificate", async () => {
      const certPath = gateway.certificates.caCertPath;
      if (!require("node:fs").existsSync(certPath)) gateway.certificates.ensureLeaf(gateway.availableInterfaces().map((item) => item.address));
      shell.showItemInFolder(certPath);
      return certPath;
    });
    ipcMain.handle("desktop:open-logs", async () => {
      shell.showItemInFolder(logger.path);
      return logger.path;
    });
  }

  async function runSmokeProbe(appUrl) {
    const firstStateResponse = await fetch(`${appUrl}/api/setup/state`, { cache: "no-store" });
    if (!firstStateResponse.ok) throw new Error(`setup state returned HTTP ${firstStateResponse.status}`);
    let state = await firstStateResponse.json();
    let authenticated = false;
    if (process.env.DESKTOP_SMOKE_BOOTSTRAP === "1" && state.needsBootstrap) {
      const bootstrap = await fetch(`${appUrl}/api/setup/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName: "Packaged Runtime Test",
          locationName: "Windows Test Site",
          ownerName: "Test Owner",
          email: "packaged-runtime@example.invalid",
          password: "Packaged-Test-Password-2026",
          industry: "food_service",
          deploymentMode: "local",
        }),
      });
      if (!bootstrap.ok) throw new Error(`bootstrap returned HTTP ${bootstrap.status}: ${await bootstrap.text()}`);
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] || "";
      const me = await fetch(`${appUrl}/api/auth/me`, { headers: { cookie } });
      authenticated = me.ok;
      state = await (await fetch(`${appUrl}/api/setup/state`, { headers: { cookie }, cache: "no-store" })).json();
    }
    const marker = process.env.DESKTOP_SMOKE_MARKER;
    if (!marker) throw new Error("DESKTOP_SMOKE_MARKER is required in smoke mode");
    require("node:fs").writeFileSync(marker, JSON.stringify({
      ok: true,
      needsBootstrap: Boolean(state.needsBootstrap),
      authenticated,
      instanceId: backend.config.instanceId,
      pgdata: require("node:fs").existsSync(path.join(app.getPath("userData"), "pgdata", "PG_VERSION")),
    }, null, 2));
  }

  async function initialiseBackend() {
    backend = new BackendManager({ app, logger });
    const state = await backend.start();
    const certificates = createCertificateManager(state.userDataDir, logger);
    firewall = new FirewallManager(logger);
    gateway = new GatewayManager({ backend, certificateManager: certificates, logger });
    if (state.config.gateway?.enabled && state.config.gateway.selectedAddress) {
      try {
        await gateway.start(state.config.gateway.selectedAddress, state.config.gatewayPort);
      } catch (error) {
        // A changed Wi-Fi address must never prevent the desktop itself from
        // opening. The Local devices panel reports addressActive=false.
        logger.warn("Saved local HTTPS gateway could not be restarted", error);
      }
    }
    return state;
  }

  async function cleanup() {
    if (cleanupStarted) return cleanupStarted;
    cleanupStarted = (async () => {
      if (gateway) await gateway.stop().catch((error) => logger?.error("Gateway shutdown failed", error));
      if (backend) await backend.stop().catch((error) => logger?.error("Backend shutdown failed", error));
    })();
    return cleanupStarted;
  }

  async function showStartupFailure(error) {
    const stage = error?.stage || "startup";
    logger.error(`Fatal desktop startup failure at ${stage}`, error);
    const result = await dialog.showMessageBox({
      type: "error",
      title: "Business Suite could not start",
      message: `Startup failed at: ${stage}`,
      detail: `${error?.message || "Unknown startup error"}\n\nYour business data was not deleted. Diagnostic log:\n${logger.path}`,
      buttons: ["Retry", "Open logs", "Exit"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (result.response === 1) {
      shell.showItemInFolder(logger.path);
      return "logs";
    }
    return result.response === 0 ? "retry" : "exit";
  }

  async function bootWithRecovery() {
    for (;;) {
      try {
        cleanupStarted = null;
        const state = await initialiseBackend();
        if (process.env.DESKTOP_SMOKE_MARKER) {
          await runSmokeProbe(state.appUrl);
          await cleanup();
          quitting = true;
          app.exit(0);
          return;
        }
        registerIpc();
        await createWindow(state.appUrl);
        return;
      } catch (error) {
        await cleanup();
        // CI has nobody to dismiss a recovery dialog. Exit immediately so the
        // packaged smoke test reports the real startup stage and log output
        // instead of hiding the failure behind its outer three-minute timeout.
        if (process.env.DESKTOP_SMOKE_MARKER) {
          logger.error(`Packaged smoke startup failed at ${error?.stage || "startup"}`, error);
          quitting = true;
          app.exit(1);
          return;
        }
        const choice = await showStartupFailure(error);
        if (choice === "exit") {
          quitting = true;
          app.exit(1);
          return;
        }
        if (choice === "logs") continue;
      }
    }
  }

  app.whenReady().then(async () => {
    logger = createLogger(app.getPath("userData"));
    logger.info("Desktop process starting", { version: app.getVersion(), packaged: app.isPackaged });
    process.on("uncaughtException", (error) => logger.error("Uncaught desktop exception", error));
    process.on("unhandledRejection", (error) => logger.error("Unhandled desktop rejection", error));
    await bootWithRecovery();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && backend?.config) void createWindow(`http://127.0.0.1:${backend.config.appPort}`);
      else focusMainWindow();
    });
  }).catch(async (error) => {
    logger?.error("Desktop ready handler failed", error);
    await cleanup();
    app.exit(1);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void cleanup().finally(() => app.exit(0));
  });
}
