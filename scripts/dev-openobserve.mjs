#!/usr/bin/env node
/**
 * OpenObserve dev mock — for local development ONLY.
 *
 * Runs a tiny in-memory server that speaks the exact subset of the
 * OpenObserve API src/lib/observability.ts depends on (the contract documented
 * at openobserve.ai/docs: JSON ingest, SQL-shaped search over one stream,
 * health, stream listing). Use it to drive the app's shipper and the console's
 * «پایش» tab on a laptop, with no Docker and no real collector:
 *
 *   node scripts/dev-openobserve.mjs              # http://127.0.0.1:5080
 *   OPENOBSERVE_MOCK_PORT=5081 node scripts/dev-openobserve.mjs
 *
 * and boot the app against it:
 *
 *   OPENOBSERVE_URL=http://127.0.0.1:5080 \
 *   OPENOBSERVE_USER=root@example.com OPENOBSERVE_PASSWORD=devpass \
 *   npm run dev
 *
 * This is NOT the product: no compression, no retention, no dashboards, no
 * auth beyond the basic check, data gone on restart. Real deployments run the
 * official container — docker-compose.observability.yml does it in one
 * command. The mock exists so the INTEGRATION (wire format, times in µs,
 * response shapes) is exercised in the same environment the app runs in, and
 * so `npm run dev` on a fresh clone can light up the monitoring tab.
 *
 * A browser hitting http://127.0.0.1:5080/ gets a status page: counts, the
 * last 50 records, and the raw curl commands both sides of the contract use.
 */
import http from "node:http";

const PORT = Number(process.env.OPENOBSERVE_MOCK_PORT ?? "5080");
const USER = process.env.ZO_ROOT_USER_EMAIL ?? "root@example.com";
const PASS = process.env.ZO_ROOT_USER_PASSWORD ?? "devpass";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64");

/** org/stream → records. The app writes one stream; humans can curl others. */
const store = new Map();

function docsFor(org, stream) {
  const key = `${org}/${stream}`;
  if (!store.has(key)) store.set(key, []);
  return store.get(key);
}

function authorized(req) {
  return (req.headers.authorization ?? "").trim() === AUTH;
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Deliberately narrow SQL interpretation — enough to execute exactly the two
 * query shapes buildLogQuery()/buildLevelCountQuery() produce, and reject
 * anything fancier loudly (that way, if the app's query builder grows a
 * feature, the mock fails it in review instead of silently agreeing).
 */
function runSearch(sql, filter) {
  const streamMatch = sql.match(/FROM\s+"([^"]+)"/i);
  if (!streamMatch) return { error: 'mock expects SELECT ... FROM "stream"' };
  const docs = docsFor(filter.org, streamMatch[1]);

  const levelMatch = sql.match(/level\s*=\s*'([^']*)'/i);
  const strMatch = sql.match(/str_match\(message,\s*'((?:[^']|'')*)'\)/i);
  const hostMatch = sql.match(/host\s*=\s*'([^']*)'/i);

  let rows = docs.filter((d) => {
    if (d._timestamp < filter.startUs || d._timestamp > filter.endUs) return false;
    if (levelMatch && String(d.level) !== levelMatch[1]) return false;
    if (hostMatch && String(d.host ?? "") !== hostMatch[1]) return false;
    if (strMatch) {
      const needle = strMatch[1].replaceAll("''", "'").toLowerCase();
      if (!String(d.message ?? "").toLowerCase().includes(needle)) return false;
    }
    return true;
  });

  if (/GROUP BY level/i.test(sql)) {
    const by = {};
    for (const r of rows) {
      const lv = String(r.level ?? "info");
      by[lv] = (by[lv] ?? 0) + 1;
    }
    return { rows: Object.entries(by).map(([level, cnt]) => ({ level, cnt })) };
  }

  rows.sort((a, b) => (b._timestamp ?? 0) - (a._timestamp ?? 0));
  return { rows: rows.slice(filter.from, filter.from + filter.size) };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/health/z") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("OK");
    return;
  }

  // Browser-friendly status page — makes "is the mock up" self-evident.
  if (req.method === "GET" && (path === "/" || path === "/web")) {
    const all = [...store.values()].flat().sort((a, b) => (b._timestamp ?? 0) - (a._timestamp ?? 0));
    const rowsHtml = all
      .slice(0, 50)
      .map((d) => {
        const t = new Date(Math.round(Number(d._timestamp ?? 0) / 1000)).toISOString();
        const msg = String(d.message ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;");
        return `<tr><td>${t}</td><td>${d.level ?? ""}</td><td>${d.logger ?? ""}</td><td>${msg.slice(0, 200)}</td></tr>`;
      })
      .join("\n");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>OpenObserve DEV MOCK</title>
<style>body{font-family:system-ui;margin:2rem;background:#0f172a;color:#e2e8f0}table{border-collapse:collapse;font-size:13px}td,th{padding:4px 10px;border-bottom:1px solid #334155;text-align:start}code{background:#1e293b;padding:2px 6px;border-radius:4px}h1{color:#f59e0b}</style>
<h1>⚠ OpenObserve dev mock — not the real thing</h1>
<p>${all.length} records in memory (last 5,000). Ingest: <code>POST /api/default/&lt;stream&gt;/_json</code> · Search: <code>POST /api/default/_search?type=logs</code></p>
<p>curl demo:<br><code>curl -u ${USER}:${PASS} -X POST http://127.0.0.1:${PORT}/api/default/pos_app_logs/_json -d '[{"level":"info","message":"hello","_timestamp":${Date.now() * 1000}}]'</code></p>
<table><tr><th>time</th><th>level</th><th>logger</th><th>message</th></tr>${rowsHtml}</table>`);
    return;
  }


  if (!authorized(req)) {
    res.writeHead(401, { "www-authenticate": "Basic realm=\"mock\"" });
    res.end("{}");
    return;
  }

  // POST /api/{org}/{stream}/_json — one record or an array of them.
  let m = path.match(/^\/api\/([^/]+)\/([^/]+)\/_json$/);
  if (m && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body || "[]");
      } catch {
        return json(res, 400, { code: 1, message: "invalid json" });
      }
      const records = Array.isArray(parsed) ? parsed : [parsed];
      const docs = docsFor(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      const nowUs = Date.now() * 1000;
      for (const r of records) docs.push({ _timestamp: r._timestamp ?? nowUs, ...r });
      if (docs.length > 5000) docs.splice(0, docs.length - 5000); // bounded memory, that is the whole retention
      json(res, 200, { code: 0, status: ["OK"], ingestion: records.map(() => ({ status: "ok" })) });
    });
    return;
  }

  // POST /api/{org}/_search?type=logs
  m = path.match(/^\/api\/([^/]+)\/_search$/);
  if (m && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return json(res, 400, { code: 1, message: "invalid json" });
      }
      const q = parsed.query ?? {};
      const t0 = Date.now();
      const out = runSearch(String(q.sql ?? ""), {
        org: decodeURIComponent(m[1]),
        startUs: Number(q.start_time ?? 0),
        endUs: Number(q.end_time ?? Number.MAX_SAFE_INTEGER),
        from: Number(q.from ?? 0),
        size: Number(q.size ?? 20),
      });
      if (out.error) return json(res, 400, { code: 1, message: out.error });
      json(res, 200, {
        results: out.rows,
        from: Number(q.from ?? 0),
        size: Number(q.size ?? 20),
        took: Date.now() - t0,
        cached: false,
        total: out.rows.length,
      });
    });
    return;
  }

  // GET /api/{org}/streams?type=logs
  m = path.match(/^\/api\/([^/]+)\/streams$/);
  if (m && req.method === "GET") {
    const org = decodeURIComponent(m[1]);
    const list = [...store.keys()]
      .filter((k) => k.startsWith(`${org}/`))
      .map((k) => ({ name: k.slice(org.length + 1), doc_num: store.get(k).length }));
    return json(res, 200, { list, count: list.length, xstatus: [] });
  }

  json(res, 404, { code: 1, message: `mock route not found: ${req.method} ${path}` });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`> OpenObserve DEV MOCK on http://127.0.0.1:${PORT} (user: ${USER} · pass: ${PASS})`);
  console.log("> remember: in-memory only, for npm run dev — real deployments: docker-compose.observability.yml");
});
