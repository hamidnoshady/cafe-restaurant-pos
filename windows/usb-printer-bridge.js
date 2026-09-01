#!/usr/bin/env node
// ponytail: TCP :9100 → Windows printer share, so the print agent — which only
// speaks raw TCP (print-agent/transport.ts) — can drive a USB receipt printer.
// Nothing in src/ or print-agent/ changes; the app just gets 127.0.0.1 as the IP.
//
//   1. Install the printer with the "Generic / Text Only" driver.
//   2. Printer properties → Sharing → share it, e.g. share name POS80.
//   3. node windows/usb-printer-bridge.js POS80
//   4. Register the printer in the app: IP 127.0.0.1, port 9100.
//
// Ceiling: the spool happens after the agent's socket closes, so a failed copy
// shows up here in the log, not in the app's «چاپ آزمایشی». Fine for one till;
// hold the socket open until copy returns if that ever matters.
const net = require("node:net");
const { execFile } = require("node:child_process");
const { writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const share = process.argv[2];
if (!share) {
  console.error("usage: node usb-printer-bridge.js <printer-share-name> [port]");
  process.exit(1);
}
const port = Number(process.argv[3]) || 9100;
let seq = 0;

net
  .createServer((socket) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (err) => console.error("socket:", err.message));
    socket.on("close", () => {
      const job = Buffer.concat(chunks);
      if (job.length === 0) return;
      const file = join(tmpdir(), `escpos-${process.pid}-${seq++}.bin`);
      writeFileSync(file, job);
      // The spooler passes RAW bytes through untouched with a Text Only driver,
      // which is what ESC/POS raster + cut + drawer-kick needs.
      execFile("cmd", ["/c", "copy", "/b", file, `\\\\localhost\\${share}`], (err, _out, stderr) => {
        rmSync(file, { force: true });
        console.log(err ? `job ${job.length}B failed: ${stderr.trim() || err.message}` : `job ${job.length}B → ${share}`);
      });
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`usb bridge: 127.0.0.1:${port} → \\\\localhost\\${share}`));
