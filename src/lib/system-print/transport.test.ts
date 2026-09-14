/**
 * transport.ts — the raw TCP send. Tested against a real loopback server:
 * the bytes must arrive intact and in order (an ESC/POS job is
 * position-sensitive), the socket must close after the job (a held-open
 * connection wedges single-connection printer firmwares), and an unreachable
 * or silent printer must reject rather than hang the checkout flow.
 */
import { createServer, type Server, type Socket } from "net";
import { afterEach, describe, expect, it } from "vitest";
import { sendToPrinter } from "./transport";

let server: Server | null = null;
let sockets: Socket[] = [];

function listen(onSocket: (socket: Socket) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    server = createServer((socket) => {
      sockets.push(socket);
      onSocket(socket);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server!.address() as { port: number }).port);
    });
  });
}

afterEach(async () => {
  // Destroy leftover connections first: close() alone waits forever for the
  // deliberately-stalled socket the timeout test leaves behind.
  for (const socket of sockets) socket.destroy();
  sockets = [];
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
    server = null;
  }
});

describe("sendToPrinter", () => {
  it("delivers the exact byte stream and closes the connection", async () => {
    const received: Buffer[] = [];
    let ended = false;
    const port = await listen((socket) => {
      socket.on("data", (chunk) => received.push(chunk));
      socket.on("end", () => {
        ended = true;
      });
    });

    // A binary payload with the full byte range — ESC/POS is not text.
    const job = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
    await sendToPrinter("127.0.0.1", port, job);

    // The server sees the FIN a beat after write resolves on the client.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(Buffer.concat(received)).toEqual(job);
    expect(ended).toBe(true);
  });

  it("rejects when nothing is listening", async () => {
    // Bind-then-close: the port existed a moment ago, so nothing else has it.
    const port = await listen(() => {});
    await new Promise((resolve) => server!.close(resolve));
    server = null;
    await expect(sendToPrinter("127.0.0.1", port, Buffer.from("x"))).rejects.toThrow();
  });

  it("times out on a printer that accepts but never drains", async () => {
    const port = await listen((socket) => {
      // Accept and go silent — pause() stops reads so the client's write
      // can never complete once the kernel buffers fill.
      socket.pause();
    });
    // A payload large enough to overflow the socket buffers so write blocks.
    const job = Buffer.alloc(8_000_000, 0xaa);
    await expect(sendToPrinter("127.0.0.1", port, job, 300)).rejects.toThrow("printer_timeout");
  }, 10_000);
});
