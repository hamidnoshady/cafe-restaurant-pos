"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { listLanInterfaces } = require("./network-interfaces");

function proxyHeaders(request) {
  return {
    ...request.headers,
    "x-forwarded-proto": "https",
    "x-forwarded-for": request.socket.remoteAddress || "",
  };
}

class GatewayManager {
  constructor({ backend, certificateManager, logger }) {
    this.backend = backend;
    this.certificates = certificateManager;
    this.logger = logger;
    this.server = null;
    this.clients = new Map();
  }

  availableInterfaces() {
    return listLanInterfaces();
  }

  rememberClient(socket, kind) {
    const address = socket.remoteAddress || "unknown";
    this.clients.set(`${kind}:${address}`, { address, kind, lastSeenAt: new Date().toISOString() });
    if (this.clients.size > 100) this.clients.delete(this.clients.keys().next().value);
  }

  async start(address, port, forceCertificate = false) {
    if (this.server) await this.stop();
    const available = this.availableInterfaces();
    if (!available.some((item) => item.address === address)) {
      throw new Error(`The selected private IPv4 address is no longer active: ${address}`);
    }
    const certificate = forceCertificate
      ? this.certificates.regenerate(available.map((item) => item.address))
      : this.certificates.ensureLeaf(available.map((item) => item.address));
    const appPort = this.backend.config.appPort;
    this.server = https.createServer(this.certificates.tlsOptions(), (request, response) => {
      this.rememberClient(request.socket, "https");
      if (request.url === "/__business-suite/local-ca.crt") {
        response.writeHead(200, {
          "Content-Type": "application/x-x509-ca-cert",
          "Content-Disposition": 'attachment; filename="business-suite-local-ca.crt"',
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        fs.createReadStream(this.certificates.caCertPath).pipe(response);
        return;
      }
      const upstream = http.request({
        host: "127.0.0.1",
        port: appPort,
        method: request.method,
        path: request.url,
        headers: proxyHeaders(request),
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", (error) => {
        this.logger.warn("Gateway HTTP proxy error", error);
        if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end("Business Suite local server is temporarily unavailable.");
      });
      request.pipe(upstream);
    });

    this.server.on("upgrade", (request, socket, head) => {
      this.rememberClient(socket, "websocket");
      const upstreamRequest = http.request({
        host: "127.0.0.1",
        port: appPort,
        method: request.method,
        path: request.url,
        headers: proxyHeaders(request),
      });
      upstreamRequest.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
        const status = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n`;
        const headers = Object.entries(upstreamResponse.headers)
          .flatMap(([name, value]) => Array.isArray(value) ? value.map((item) => `${name}: ${item}\r\n`) : value !== undefined ? [`${name}: ${value}\r\n`] : [])
          .join("");
        socket.write(`${status}${headers}\r\n`);
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);
        socket.pipe(upstreamSocket).pipe(socket);
      });
      upstreamRequest.on("response", (upstreamResponse) => {
        socket.write(`HTTP/1.1 ${upstreamResponse.statusCode || 502} ${upstreamResponse.statusMessage || "Rejected"}\r\n\r\n`);
        socket.destroy();
      });
      upstreamRequest.on("error", (error) => {
        this.logger.warn("Gateway WebSocket proxy error", error);
        socket.destroy();
      });
      upstreamRequest.end();
    });
    this.server.on("tlsClientError", (error) => this.logger.warn("Gateway TLS client error", error.message));

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ host: address, port, exclusive: true }, resolve);
    });
    this.address = address;
    this.port = port;
    this.logger.info("Local HTTPS gateway started", { address, port });
    return { address, port, certificate };
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
      setTimeout(resolve, 5000).unref();
    });
    this.logger.info("Local HTTPS gateway stopped");
  }

  status() {
    const interfaces = this.availableInterfaces();
    const configured = this.backend.config?.gateway || { enabled: false, selectedAddress: null };
    const address = this.address || configured.selectedAddress;
    return {
      supported: process.platform === "win32" || !this.backend.app.isPackaged,
      enabled: Boolean(configured.enabled),
      running: Boolean(this.server?.listening),
      computerName: require("node:os").hostname(),
      interfaces,
      selectedAddress: address || null,
      port: this.backend.config?.gatewayPort || 8443,
      url: address ? `https://${address}:${this.backend.config?.gatewayPort || 8443}` : null,
      caDownloadUrl: address ? `https://${address}:${this.backend.config?.gatewayPort || 8443}/__business-suite/local-ca.crt` : null,
      certificate: this.certificates.describe(),
      clients: [...this.clients.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 20),
      addressActive: address ? interfaces.some((item) => item.address === address) : false,
    };
  }
}

module.exports = { GatewayManager, proxyHeaders };
