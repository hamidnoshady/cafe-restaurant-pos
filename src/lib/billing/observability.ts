/**
 * Structured billing logs. Financial operations carry a reference id.
 * Secrets, signatures and tokens are dropped before the line is written.
 */

const SECRET = /secret|authorization|password|token|signature|api[_-]?key/i;

export function billingLog(event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET.test(key)) continue;
    safe[key] = value;
  }
  console.info(
    JSON.stringify({
      domain: "billing",
      event,
      at: new Date().toISOString(),
      ...safe,
    }),
  );
}
