/**
 * Phase 17 — order/inventory hot-path latency benchmark.
 *
 * Phase 9's own performance pass (docs/phases/Phase-9-Multi-Location-Rollup-Polish.md)
 * never measured order-creation or payment/inventory-consumption latency —
 * scripts/ws-load-test.ts measures WebSocket fan-out time, not the DB round
 * trip itself. That means Phase 17's exit criterion ("no regression against
 * the Phase 9 performance baseline on the order and inventory hot paths")
 * has nothing numeric to compare against on this specific path. This script
 * is the first one: it creates real takeaway orders and pays them through
 * the actual POS API (the same one scripts/ws-load-test.ts drives), timing
 * both the order-creation call and the payment call (which is also where
 * inventory consumption and the ledger postings happen — see
 * src/app/api/orders/[id]/pay/route.ts). Re-run it after any change to the
 * order/payment/inventory path or to the RLS policies those queries run
 * under, and compare against the numbers recorded in
 * docs/phases/Phase-17-Feature-Gating-Hardening.md.
 *
 * Prerequisites: a running server (`npm run dev` or `npm start`) against a
 * seeded DB (`npm run db:seed`). Creates ROUNDS real takeaway orders and
 * pays every one of them — run it against a dev DB, not production data.
 *
 * Usage:
 *   npx tsx scripts/order-perf-benchmark.ts
 * Env:
 *   BASE_URL  target server (default http://localhost:3000)
 *   ROUNDS    orders created and paid (default 200)
 *   LOAD_EMAIL / LOAD_PASSWORD  login (defaults: SEED_OWNER_* / owner@example.com)
 */
import "dotenv/config";

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const ROUNDS = Number(process.env.ROUNDS ?? 200);
const EMAIL = process.env.LOAD_EMAIL ?? process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.LOAD_PASSWORD ?? process.env.SEED_OWNER_PASSWORD ?? "owner1234";

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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function report(label: string, samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(
    `${label}: min ${percentile(sorted, 0).toFixed(1)}ms, p50 ${percentile(sorted, 50).toFixed(1)}ms, ` +
      `p95 ${percentile(sorted, 95).toFixed(1)}ms, max ${percentile(sorted, 100).toFixed(1)}ms`,
  );
  return sorted;
}

async function main() {
  console.log(`Order/inventory hot-path benchmark → ${BASE_URL} (${ROUNDS} rounds)`);

  const cookie = await login();
  const menuItemId = await firstMenuItemId(cookie);

  const createMs: number[] = [];
  const payMs: number[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    const t0 = performance.now();
    const createRes = await fetch(`${BASE_URL}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ type: "takeaway", items: [{ menuItemId, quantity: 1 }] }),
    });
    createMs.push(performance.now() - t0);
    if (!createRes.ok) throw new Error(`POST /api/orders failed: HTTP ${createRes.status} ${await createRes.text()}`);
    const order = (await createRes.json()) as { id?: string };
    const orderId = order.id;
    if (!orderId) throw new Error("order-creation response had no id");

    const t1 = performance.now();
    const payRes = await fetch(`${BASE_URL}/api/orders/${orderId}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ method: "cash" }),
    });
    payMs.push(performance.now() - t1);
    if (!payRes.ok) throw new Error(`POST /api/orders/${orderId}/pay failed: HTTP ${payRes.status} ${await payRes.text()}`);

    if ((round + 1) % 50 === 0) console.log(`  ${round + 1}/${ROUNDS} rounds complete`);
  }

  console.log("\n— results —");
  report("order creation (POST /api/orders)", createMs);
  report("payment + inventory consumption + ledger postings (POST /api/orders/:id/pay)", payMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
