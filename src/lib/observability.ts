/**
 * OpenObserve integration — the console's window onto the machine.
 *
 * The `/platform/system` page answers "what does the DATABASE think?": pool,
 * migrations, RLS, backups. It cannot answer "what went wrong in the last
 * ten minutes, on which host?" — that is log-shaped knowledge, and today it
 * lives in whatever `console.error` printed into the process output. This
 * module moves that knowledge to an [OpenObserve](https://openobserve.ai)
 * instance when one is configured:
 *
 *   • `installObservability()` (called once from server.ts) taps `console.*` and ships each line to the
 *     configured log stream (the app's background ticks — backups, rollup
 *     sync, Holoo, WooCommerce, AI billing — all report failures through
 *     console.error today, so this one tap makes every tick observable, and
 *     every deployment observable from the central console).
 *   • `shipHttpEvent()` lets the custom server send a structured record for
 *     requests that errored (>= 400) or ran slow (>= 1s) — the only request
 *     records worth their ingestion cost at this fleet's size.
 *   • `zoSearch()` / `zoHealth()` / `zoStreams()` are the thin read client
 *     the `/api/platform/observability` route proxies to, so the console's
 *     «پایش» tab queries the same store the operator could open in the
 *     OpenObserve UI — the panel never holds a raw credential path to logs
 *     that bypasses the platform admin session.
 *
 * Everything is opt-in via environment (OPENOBSERVE_URL + credentials); with
 * none set, every entry point here is a no-op — same as a deployment with no
 * Sentry, nothing is required to boot. Shipping NEVER blocks or throws: an
 * unreachable collector must not take a POS with it. Batches are buffered and
 * dropped on persistent failure, with counters the panel surfaces.
 *
 * Wire format: OpenObserve's JSON ingest (POST /api/{org}/{stream}/_json, an
 * array of records, `_timestamp` in microseconds) and SQL search (POST
 * /api/{org}/_search with query.start_time/end_time in microseconds). See
 * docs/openobserve.md for deployment, alerting recipes, and retention.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ObservabilityConfig {
  /** Base URL of the OpenObserve node, e.g. http://openobserve:5080 (no trailing slash). */
  baseUrl: string;
  org: string;
  /** Log stream the app writes to. */
  stream: string;
  /** Value for the Authorization header (basic auth over email:password). */
  auth: string;
  /** Human-facing URL for "open the full UI" links; may differ from baseUrl (Traefik front). */
  publicUrl: string;
  /** Written as `service` on every record — distinguishes several deployments feeding one collector. */
  service: string;
  /** Written as `environment` (e.g. production / staging / a café site id). */
  environment: string;
  /** Seconds to keep an ingest batch waiting before flush. */
  flushIntervalMs: number;
  /** Records buffered before an immediate flush. */
  maxBatch: number;
}

const DEFAULTS = {
  org: "default",
  stream: "pos_app_logs",
  service: "pos-server",
  flushIntervalMs: 2000,
  maxBatch: 60,
};

/** Null when not configured — every caller must treat that as "feature off". */
export function observabilityConfig(): ObservabilityConfig | null {
  const baseUrl = (process.env.OPENOBSERVE_URL ?? "").trim().replace(/\/+$/, "");
  const user = (process.env.OPENOBSERVE_USER ?? "").trim();
  const pass = (process.env.OPENOBSERVE_PASSWORD ?? "").trim();
  if (!baseUrl || !user || !pass) return null;
  return {
    baseUrl,
    org: (process.env.OPENOBSERVE_ORG ?? DEFAULTS.org).trim() || DEFAULTS.org,
    stream:
      (process.env.OPENOBSERVE_LOG_STREAM ?? DEFAULTS.stream).trim() || DEFAULTS.stream,
    auth: "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64"),
    publicUrl: (process.env.OPENOBSERVE_PUBLIC_URL ?? "").trim().replace(/\/+$/, "") || baseUrl,
    service: (process.env.OPENOBSERVE_SERVICE ?? DEFAULTS.service).trim() || DEFAULTS.service,
    environment: (process.env.OPENOBSERVE_ENV ?? process.env.NODE_ENV ?? "development").trim(),
    flushIntervalMs: DEFAULTS.flushIntervalMs,
    maxBatch: DEFAULTS.maxBatch,
  };
}

// ---------------------------------------------------------------------------
// Shipper (fire-and-forget, buffered, self-statistic)
// ---------------------------------------------------------------------------

export interface ShipperStats {
  enqueued: number;
  sent: number;
  dropped: number;
  lastFlushAt: string | null;
  lastError: string | null;
}

/**
 * The stats object lives on a process-global, not on module scope: server.ts
 * and Next's route handlers load this file as two distinct module instances
 * of one process, and the پایش tab (a route handler) must report the counters
 * of the shipper (server.ts side) — a per-instance `const` would forever read
 * zeros and make the self-check a lie.
 */
const STATS_KEY = "__posObservabilityStats";
function sharedStats(): ShipperStats {
  const g = globalThis as Record<string, unknown>;
  if (!g[STATS_KEY]) {
    g[STATS_KEY] = { enqueued: 0, sent: 0, dropped: 0, lastFlushAt: null, lastError: null };
  }
  return g[STATS_KEY] as ShipperStats;
}

const stats: ShipperStats = sharedStats();
let buffer: Record<string, unknown>[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let installed = false;
let capturing = false; // re-entrancy guard: the flush path must not feed itself

export function shipperStats(): ShipperStats {
  return { ...stats };
}

function nowMicros(): number {
  return Math.floor(Date.now() * 1000);
}

/** Queue one structured record. Non-blocking; silently counts drops. */
export function shipEvent(fields: Record<string, unknown>): void {
  const cfg = observabilityConfig();
  if (!cfg) return;
  buffer.push({ _timestamp: nowMicros(), service: cfg.service, environment: cfg.environment, ...fields });
  stats.enqueued += 1;
  if (buffer.length >= cfg.maxBatch) void flush(cfg);
  else if (!timer) timer = setTimeout(() => void flush(), cfg.flushIntervalMs);
}

async function flush(cfg: ObservabilityConfig | null = observabilityConfig()): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!cfg || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  capturing = true; // never let the failure log below recurse into shipEvent
  try {
    const res = await fetch(`${cfg.baseUrl}/api/${cfg.org}/${cfg.stream}/_json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: cfg.auth },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      stats.sent += batch.length;
      stats.lastFlushAt = new Date().toISOString();
      stats.lastError = null;
    } else {
      stats.dropped += batch.length;
      stats.lastError = `ingest ${res.status}`;
    }
  } catch (err) {
    // Collector down / network partition: this batch is dropped, the app
    // goes on. The next tick retries — an offline café is a normal state.
    stats.dropped += batch.length;
    stats.lastError = String((err as Error)?.message ?? err);
  } finally {
    capturing = false;
  }
}

type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Tap console.* so every existing `console.error("… tick failed:", err)` in
 * server.ts (and anything else in the process) becomes an observable record
 * with zero call-site churn. Idempotent. Originals keep printing, so docker
 * logs and the terminal are unchanged.
 */
export function installObservability(): void {
  if (installed || !observabilityConfig()) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error", "debug"] as ConsoleLevel[]) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      if (capturing) return;
      const [head, ...rest] = args;
      shipEvent({
        level: level === "log" ? "info" : level,
        logger: "console",
        message: stringifyArg(head) + (rest.length ? " " + rest.map(stringifyArg).join(" ") : ""),
      });
    };
  }
  process.on("uncaughtException", (err) => {
    shipEvent({ level: "fatal", logger: "process", message: `uncaughtException: ${stringifyArg(err)}` });
    void flush().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    shipEvent({ level: "error", logger: "process", message: `unhandledRejection: ${stringifyArg(reason)}` });
  });
  // A beacon per boot makes "did the new deploy come up, from which host?"
  // answerable in the same place as everything else.
  shipEvent({
    level: "info",
    logger: "boot",
    message: `POS server started (pid ${process.pid}, ${process.env.NODE_ENV ?? "development"})`,
    pid: process.pid,
  });
}

/** One HTTP request record — called by server.ts for errors and slow responses only. */
export function shipHttpEvent(input: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  host?: string;
}): void {
  shipEvent({
    level: input.status >= 500 ? "error" : input.status >= 400 ? "warn" : "info",
    logger: "http",
    method: input.method,
    path: input.path,
    status: input.status,
    duration_ms: input.durationMs,
    host: input.host ?? "",
    message: `${input.method} ${input.path} → ${input.status} in ${input.durationMs}ms`,
  });
}

// ---------------------------------------------------------------------------
// Query client (used by /api/platform/observability)
// ---------------------------------------------------------------------------

export interface ZoSearchResult {
  rows: Record<string, unknown>[];
  tookMs: number;
}

/** Quote a string literal for the OpenObserve SQL dialect (single quotes, doubled). */
export function sqlLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/** Quote an identifier (stream name) — double quotes doubled. */
export function sqlIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export interface LogQueryOptions {
  stream: string;
  level?: string; // "error" | "warn" | "info" | …
  q?: string; // substring in message
  host?: string;
}

/** Rows: newest first; filtering mirrors the console UI's toolbar. */
export function buildLogQuery(opts: LogQueryOptions): string {
  const where: string[] = [];
  if (opts.level && opts.level !== "all") where.push(`level = ${sqlLiteral(opts.level)}`);
  if (opts.q) where.push(`str_match(message, ${sqlLiteral(opts.q)})`);
  if (opts.host) where.push(`host = ${sqlLiteral(opts.host)}`);
  const conditions = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  return `SELECT * FROM ${sqlIdent(opts.stream)}${conditions} ORDER BY _timestamp DESC`;
}

/** Same filters, counted by level — the little "خطا ۱۲ · هشدار ۴" chips. */
export function buildLevelCountQuery(opts: LogQueryOptions): string {
  const where: string[] = [];
  if (opts.q) where.push(`str_match(message, ${sqlLiteral(opts.q)})`);
  if (opts.host) where.push(`host = ${sqlLiteral(opts.host)}`);
  const conditions = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  return `SELECT level, COUNT(*) AS cnt FROM ${sqlIdent(opts.stream)}${conditions} GROUP BY level`;
}

/** A search window; never more than 31 days back, never in the future. */
export function clampWindow(startMs: number, endMs: number, nowMs: number): { startMs: number; endMs: number } {
  const maxStart = nowMs - 31 * 24 * 60 * 60 * 1000;
  const s = Number.isFinite(startMs) ? Math.min(Math.max(startMs, maxStart), nowMs) : nowMs - 6 * 60 * 60 * 1000;
  const e = Number.isFinite(endMs) ? Math.min(Math.max(endMs, s + 1000), nowMs + 60_000) : nowMs;
  return { startMs: s, endMs: e };
}

/** Search responses have moved between `results` and `hits` across versions — accept either. */
export function parseRows(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const data = payload as { results?: unknown; hits?: unknown };
  if (Array.isArray(data.results)) return data.results as Record<string, unknown>[];
  if (Array.isArray(data.hits)) return data.hits as Record<string, unknown>[];
  return [];
}

async function zoFetch(cfg: ObservabilityConfig, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: cfg.auth, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(9000),
  });
}

/** Run a search over the log stream. start/end in epoch milliseconds. */
export async function zoSearch(
  cfg: ObservabilityConfig,
  sql: string,
  startMs: number,
  endMs: number,
  size: number,
  from: number,
): Promise<ZoSearchResult> {
  const t0 = Date.now();
  const res = await zoFetch(cfg, `/api/${cfg.org}/_search?type=logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: {
        sql,
        start_time: Math.floor(startMs * 1000), // microseconds
        end_time: Math.floor(endMs * 1000),
        from,
        size,
      },
    }),
  });
  if (!res.ok) throw new Error(`search ${res.status}`);
  const rows = parseRows(await res.json());
  return { rows, tookMs: Date.now() - t0 };
}

export async function zoHealth(
  cfg: ObservabilityConfig,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    const res = await zoFetch(cfg, "/health/z");
    return { ok: res.ok, latencyMs: Date.now() - t0, error: res.ok ? undefined : `health ${res.status}` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: String((err as Error)?.message ?? err) };
  }
}

export async function zoStreams(cfg: ObservabilityConfig): Promise<string[]> {
  const res = await zoFetch(cfg, `/api/${cfg.org}/streams?type=logs`);
  if (!res.ok) throw new Error(`streams ${res.status}`);
  const data = (await res.json()) as { list?: { name?: string }[] } | { name?: string }[];
  const list = Array.isArray(data) ? data : (data.list ?? []);
  return list.map((s) => s.name ?? "").filter(Boolean);
}
