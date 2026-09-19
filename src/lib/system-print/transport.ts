/** Sends a raw ESC/POS byte stream to a network printer over a plain TCP socket (port 9100 is the de-facto standard raw-print port). */
import { Socket } from "net";

export function sendToPrinter(ip: string, port: number, data: Buffer, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    // One hard deadline for the whole job, on top of the socket's idle timer.
    // `setTimeout()` alone is not enough: it only fires when the socket has been
    // *idle*, and a printer that accepts the connection and then stops draining
    // keeps the socket "busy" with buffered bytes, so the idle timer never
    // fires and the checkout flow hangs.
    const deadline = setTimeout(() => finish(new Error("printer_timeout")), timeoutMs);
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => finish(new Error("printer_timeout")));
    socket.once("error", (err) => finish(err));
    // Resolve only once the connection is fully closed after our FIN. A
    // `write()` callback means the *kernel* took the bytes, not that the printer
    // read them — on a socket whose peer never drains, the OS send buffer (which
    // Windows autotunes into the megabytes) swallows a whole job and the write
    // callback fires for data the printer never saw. Waiting for "close" means
    // the far end has acknowledged and torn the connection down, which is the
    // only signal at the TCP level that the job actually left the machine.
    socket.once("close", (hadError) => finish(hadError ? new Error("printer_connection_reset") : undefined));
    socket.connect(port, ip, () => {
      socket.write(data, (err) => {
        if (err) return finish(err);
        socket.end();
      });
    });
  });
}
