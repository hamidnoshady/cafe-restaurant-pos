/**
 * Phase 9 — WebSocket load test for the realtime layer (src/lib/realtime.ts).
 *
 * Answers Phase 4's deferred Q5 ("device count / connection load"): opens N
 * concurrent authenticated sockets — simulating waiter phones, KDS screens,
 * and cashier tills all connected at once — then creates takeaway orders
 * through the real POS API and measures how long the `order.created`
 * broadcast takes to reach every socket.
 *
 * Prerequisites: a running server (`npm run dev` or `npm start`) against a
 * seeded DB (`npm run db:seed`, which provides the owner login + menu).
 * Creates ROUNDS real takeaway orders — run it against a dev DB, not
 * production data.
 *
 * Usage:
 *   npx tsx scripts/ws-load-test.ts
 * Env:
 *   BASE_URL     target server (default http://localhost:3000)
 *   CONNECTIONS  concurrent sockets (default 50 — “a few dozen” per Phase 4 Q5,
 *                with headroom; Phase 9 plans ~5 locations × ~10 devices)
 *   ROUNDS       orders created / broadcasts measured (default 10)
 *   LOAD_EMAIL / LOAD_PASSWORD  login (defaults: SEED_OWNER_* / owner@example.com)
 */
import "dotenv/config";
import WebSocket from "ws";

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const WS_URL = `${BASE_URL.replace(/^http/, "ws")}/ws`;
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50);
const ROUNDS = Number(process.env.ROUNDS ?? 10);
const EMAIL = process.env.LOAD_EMAIL ?? process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.LOAD_PASSWORD ?? process.env.SEED_OWNER_PASSWORD ?? "owner1234";
const ROUND_TIMEOUT_MS = 5_000;

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status} (is the server running and the DB seeded?)`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /pos_session=([^;]+)/.exec(setCookie);
  if (!match) throw new Error("login response had no pos_session cookie");
  return `pos_session=${match[1]}`;
}

async function firstMenuItemId(cookie: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/menu`, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`GET /api/menu failed: HTTP ${res.status}`);
  const data = (await res.json()) as { items?: { id: string; is_active: boolean }[] };
  const item = data.items?.find((i) => i.is_active) ?? data.items?.[0];
  if (!item) throw new Error("no menu items — run `npm run db:seed` first");
  return item.id;
}

function openSocket(cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Cookie: cookie } });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main() {
  console.log(`WS load test → ${BASE_URL} (${CONNECTIONS} sockets, ${ROUNDS} rounds)`);

  const cookie = await login();
  const menuItemId = await firstMenuItemId(cookie);

  const connectStart = performance.now();
  const sockets = await Promise.all(Array.from({ length: CONNECTIONS }, () => openSocket(cookie)));
  console.log(`connected ${sockets.length} sockets in ${Math.round(performance.now() - connectStart)}ms`);

  const allLatencies: number[] = [];
  const roundCompletions: number[] = [];
  let missedDeliveries = 0;

  for (let round = 0; round < ROUNDS; round++) {
    // Arm every socket for the next order.created BEFORE creating the order
    // (the server broadcasts before it responds to the POST).
    let t0 = 0;
    const deliveries = sockets.map(
      (ws) =>
        new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => {
            ws.off("message", onMessage);
            resolve(null);
          }, ROUND_TIMEOUT_MS);
          function onMessage(raw: WebSocket.RawData) {
            try {
              const event = JSON.parse(String(raw)) as { type?: string };
              if (event.type !== "order.created") return;
            } catch {
              return;
            }
            clearTimeout(timer);
            ws.off("message", onMessage);
            resolve(performance.now() - t0);
          }
          ws.on("message", onMessage);
        }),
    );

    t0 = performance.now();
    const res = await fetch(`${BASE_URL}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ type: "takeaway", items: [{ menuItemId, quantity: 1 }] }),
    });
    const postMs = performance.now() - t0;
    if (!res.ok) throw new Error(`POST /api/orders failed: HTTP ${res.status} ${await res.text()}`);

    const results = await Promise.all(deliveries);
    const received = results.filter((r): r is number => r !== null);
    missedDeliveries += results.length - received.length;
    const slowest = received.length ? Math.max(...received) : NaN;
    roundCompletions.push(slowest);
    allLatencies.push(...received);
    console.log(
      `round ${round + 1}/${ROUNDS}: POST ${postMs.toFixed(0)}ms, ` +
        `broadcast → all ${received.length}/${results.length} sockets in ${slowest.toFixed(0)}ms`,
    );
  }

  for (const ws of sockets) ws.close();

  allLatencies.sort((a, b) => a - b);
  roundCompletions.sort((a, b) => a - b);
  console.log("\n— results —");
  console.log(`deliveries: ${allLatencies.length} (missed: ${missedDeliveries})`);
  console.log(
    `per-socket latency ms (POST start → event received): ` +
      `min ${percentile(allLatencies, 0).toFixed(0)}, p50 ${percentile(allLatencies, 50).toFixed(0)}, ` +
      `p95 ${percentile(allLatencies, 95).toFixed(0)}, max ${percentile(allLatencies, 100).toFixed(0)}`,
  );
  console.log(
    `full fan-out per round ms (slowest socket): ` +
      `p50 ${percentile(roundCompletions, 50).toFixed(0)}, max ${percentile(roundCompletions, 100).toFixed(0)}`,
  );
  const pass = missedDeliveries === 0 && percentile(roundCompletions, 100) < 1_000;
  console.log(pass ? "\nPASS: every socket saw every event well under 1s." : "\nFAIL: missed events or >1s fan-out.");
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
