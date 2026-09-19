/**
 * The super-admin console's HTTP client — one place that turns a `/api/platform`
 * call into a typed success/error result the whole console can rely on.
 *
 * Before this, every page reimplemented `fetch` + `res.json()` + ad-hoc error
 * handling; the result was inconsistent handling of 401/403/validation/network
 * failures. This client normalises all of them into a discriminated union so a
 * caller never has to guess whether `data` is a payload or an error, and the
 * accompanying React hooks (`usePlatformQuery`, `usePlatformMutation`) remove
 * the repeated `useState/useEffect/loading/error/reload` boilerplate.
 *
 * Pure transport — no React — so it can be unit-tested and reused server-side.
 */

/** The stable error envelope every `/api/platform` route returns on failure. */
export interface PlatformApiErrorBody {
  error: string;
  /** Optional per-field validation messages, keyed by field name. */
  fields?: Record<string, string>;
  /** Optional free-form detail for logging (never shown raw to operators). */
  detail?: string;
}

export type PlatformResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      /** A stable machine code — feed to `platformErrorText` for operator text. */
      code: string;
      /** Field-level validation errors when the server supplied them. */
      fields?: Record<string, string>;
      /** True when the failure was a client-side abort, not a server response. */
      cancelled?: boolean;
    };

export interface PlatformRequestOptions extends Omit<RequestInit, "body"> {
  /** JSON body — serialised automatically; omit for GET. */
  body?: unknown;
  /** Query-string params appended to the URL; nullish values are dropped. */
  params?: Record<string, string | number | boolean | null | undefined>;
  /** An AbortSignal to cancel the request (used for stale-search cancellation). */
  signal?: AbortSignal;
}

/** Build a URL with a query string from a params record, dropping nullish. */
export function withParams(
  url: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string {
  if (!params) return url;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `${url}${url.includes("?") ? "&" : "?"}${query}` : url;
}

/** Map an HTTP status with no explicit body code to a stable code. */
function codeForStatus(status: number): string {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 422:
      return "validation_error";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "server_error" : "bad_request";
  }
}

/**
 * Perform a `/api/platform` request and normalise the outcome. Never throws for
 * an HTTP error or a network failure — the failure lands in the returned union
 * so callers handle it uniformly. Only a caller-driven abort surfaces as
 * `cancelled: true` (still `ok: false`, code `request_cancelled`).
 */
export async function platformFetch<T = unknown>(
  url: string,
  options: PlatformRequestOptions = {},
): Promise<PlatformResult<T>> {
  const { body, params, headers, signal, ...rest } = options;
  const finalUrl = withParams(url, params);

  let res: Response;
  try {
    res = await fetch(finalUrl, {
      ...rest,
      signal,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, status: 0, code: "request_cancelled", cancelled: true };
    }
    return { ok: false, status: 0, code: "network_error" };
  }

  // 204 / empty body — success with no data.
  if (res.status === 204) {
    return { ok: true, status: res.status, data: undefined as T };
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (res.ok) {
        return { ok: false, status: res.status, code: "parse_error" };
      }
      // A non-OK non-JSON body (e.g. an HTML error page) — use the status.
      return { ok: false, status: res.status, code: codeForStatus(res.status) };
    }
  }

  if (res.ok) {
    return { ok: true, status: res.status, data: (parsed ?? {}) as T };
  }

  const errBody = (parsed ?? {}) as Partial<PlatformApiErrorBody>;
  return {
    ok: false,
    status: res.status,
    code: typeof errBody.error === "string" && errBody.error ? errBody.error : codeForStatus(res.status),
    fields: errBody.fields,
  };
}
