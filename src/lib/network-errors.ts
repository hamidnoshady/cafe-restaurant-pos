/**
 * "The client went away" is not a crash.
 *
 * A browser that navigates mid-response, a phone that leaves the café's wifi,
 * or an edge proxy that recycles an idle keep-alive connection all make Node
 * emit an error on the request/socket — most often `ECONNRESET`, or the
 * synthetic `Error: aborted` that `http`'s incoming-message machinery raises
 * when the peer disappears before the body finished.
 *
 * Those errors have no listener on the raw socket, so they reach
 * `process.on("uncaughtException")`. Production logs showed exactly that:
 *
 *   [Error: aborted] { code: 'ECONNRESET' }
 *    ⨯ uncaughtException:  [Error: aborted] { code: 'ECONNRESET' }
 *
 * and the observability handler (src/lib/observability.ts) responded by
 * flushing and calling process.exit(1) — so one abandoned request took the
 * whole POS down and the platform restarted the container. Every one of these
 * is benign: the response had nowhere left to go. Classify them here, once, so
 * the server and the observability tap agree on what deserves to be fatal.
 */

/** Socket-level codes that only ever mean "the other end is gone". */
const BENIGN_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_DESTROYED",
  "ERR_HTTP_REQUEST_TIMEOUT",
  "ERR_HTTP2_STREAM_CANCEL",
  "HPE_INVALID_EOF_STATE",
]);

/**
 * True when `error` is a dropped/aborted client connection rather than a bug
 * in the app. Deliberately narrow: anything unrecognised stays fatal, because
 * swallowing a real uncaught exception is far worse than restarting.
 */
export function isBenignNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const { code, message, name } = error as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
  };

  if (typeof code === "string" && BENIGN_CODES.has(code)) return true;

  // `http`'s abort error carries `message === "aborted"` and, on some Node
  // versions, no code at all. AbortError is the fetch/undici equivalent.
  if (typeof message === "string" && message.toLowerCase() === "aborted") return true;
  if (name === "AbortError") return true;

  // Aggregate/wrapped errors: benign only if every member is benign.
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.every(isBenignNetworkError);
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) return isBenignNetworkError(cause);

  return false;
}

/** One-line description for the (rate-limited) log of dropped connections. */
export function describeNetworkError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code ? `${String(message ?? "error")} (${String(code)})` : String(message ?? error);
}
