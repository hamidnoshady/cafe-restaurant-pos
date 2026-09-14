/** Sends a raw ESC/POS byte stream to a network printer over a plain TCP socket (port 9100 is the de-facto standard raw-print port). */
import { Socket } from "net";

export function sendToPrinter(ip: string, port: number, data: Buffer, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => finish(new Error("printer_timeout")));
    socket.once("error", (err) => finish(err));
    socket.connect(port, ip, () => {
      socket.write(data, (err) => {
        if (err) return finish(err);
        socket.end();
        finish();
      });
    });
  });
}
