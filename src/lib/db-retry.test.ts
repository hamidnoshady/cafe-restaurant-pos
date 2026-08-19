import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectAttempts,
  connectRetryDelayMs,
  connectionHost,
  describeConnectFailure,
  isRetryableConnectError,
  withConnectRetry,
} from "./db-retry";

function dnsError(code: string, hostname = "posdatabase-hpq-service"): Error {
  return Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), {
    errno: -3001,
    code,
    syscall: "getaddrinfo",
    hostname,
  });
}

describe("isRetryableConnectError", () => {
  it("retries the resolver failures a container network produces", () => {
    expect(isRetryableConnectError(dnsError("EAI_AGAIN"))).toBe(true);
    expect(isRetryableConnectError(dnsError("ENOTFOUND"))).toBe(true);
  });

  it("retries a refused, reset, or timed-out connection", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH"]) {
      expect(isRetryableConnectError(Object.assign(new Error(code), { code }))).toBe(true);
    }
  });

  it("retries a database that is still starting up", () => {
    expect(isRetryableConnectError(Object.assign(new Error("starting up"), { code: "57P03" }))).toBe(true);
  });

  it("does not retry a rejection the database actually answered with", () => {
    const authFailed = Object.assign(new Error("password authentication failed"), { code: "28P01" });
    expect(isRetryableConnectError(authFailed)).toBe(false);

    const noDatabase = Object.assign(new Error('database "pos" does not exist'), { code: "3D000" });
    expect(isRetryableConnectError(noDatabase)).toBe(false);
  });

  it("recognises pg's code-less checkout failures by message", () => {
    expect(isRetryableConnectError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isRetryableConnectError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isRetryableConnectError(new Error("syntax error at or near \"SELCT\""))).toBe(false);
  });

  it("is not confused by a non-error", () => {
    expect(isRetryableConnectError(null)).toBe(false);
    expect(isRetryableConnectError("EAI_AGAIN")).toBe(false);
  });
});

describe("connectAttempts", () => {
  const original = process.env.DB_CONNECT_ATTEMPTS;
  afterEach(() => {
    if (original === undefined) delete process.env.DB_CONNECT_ATTEMPTS;
    else process.env.DB_CONNECT_ATTEMPTS = original;
  });

  it("defaults to four attempts", () => {
    delete process.env.DB_CONNECT_ATTEMPTS;
    expect(connectAttempts()).toBe(4);
  });

  it("honours an override, clamped to a sane ceiling", () => {
    process.env.DB_CONNECT_ATTEMPTS = "2";
    expect(connectAttempts()).toBe(2);
    process.env.DB_CONNECT_ATTEMPTS = "99";
    expect(connectAttempts()).toBe(10);
  });

  it("ignores nonsense", () => {
    process.env.DB_CONNECT_ATTEMPTS = "0";
    expect(connectAttempts()).toBe(4);
    process.env.DB_CONNECT_ATTEMPTS = "soon";
    expect(connectAttempts()).toBe(4);
  });
});

describe("connectRetryDelayMs", () => {
  it("starts fast and caps at two seconds", () => {
    expect(connectRetryDelayMs(1)).toBe(100);
    expect(connectRetryDelayMs(2)).toBe(300);
    expect(connectRetryDelayMs(3)).toBe(900);
    expect(connectRetryDelayMs(4)).toBe(2_000);
    expect(connectRetryDelayMs(9)).toBe(2_000);
  });

  it("spends under two seconds on the default four attempts", () => {
    const total = [1, 2, 3].reduce((sum, attempt) => sum + connectRetryDelayMs(attempt), 0);
    expect(total).toBeLessThan(2_000);
  });
});

describe("withConnectRetry", () => {
  const sleep = vi.fn(async () => {});

  afterEach(() => sleep.mockClear());

  it("returns the connection when the first attempt works", async () => {
    const connect = vi.fn(async () => "client");
    await expect(withConnectRetry(connect, { sleep })).resolves.toBe("client");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rides out a DNS blip and succeeds on a later attempt", async () => {
    const connect = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(dnsError("EAI_AGAIN"))
      .mockRejectedValueOnce(dnsError("EAI_AGAIN"))
      .mockResolvedValue("client");

    await expect(withConnectRetry(connect, { sleep })).resolves.toBe("client");
    expect(connect).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [300]]);
  });

  it("gives up after the attempt budget and rethrows the original error", async () => {
    const err = dnsError("EAI_AGAIN");
    const connect = vi.fn<() => Promise<string>>().mockRejectedValue(err);

    await expect(withConnectRetry(connect, { attempts: 3, sleep })).rejects.toBe(err);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("fails immediately on an error retrying cannot fix", async () => {
    const err = Object.assign(new Error("password authentication failed"), { code: "28P01" });
    const connect = vi.fn<() => Promise<string>>().mockRejectedValue(err);

    await expect(withConnectRetry(connect, { sleep })).rejects.toBe(err);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reports each retry it makes", async () => {
    const onRetry = vi.fn();
    const connect = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(dnsError("EAI_AGAIN"))
      .mockResolvedValue("client");

    await withConnectRetry(connect, { sleep, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][1]).toBe(1);
    expect(onRetry.mock.calls[0][2]).toBe(100);
  });
});

describe("connectionHost", () => {
  it("reads the host out of a URL connection string", () => {
    expect(connectionHost("postgres://pos:secret@posdatabase-hpq-service:5432/pos")).toBe(
      "posdatabase-hpq-service",
    );
  });

  it("reads the host out of a libpq key=value string", () => {
    expect(connectionHost("host=db port=5432 user=pos password=secret")).toBe("db");
  });

  it("unwraps a bracketed IPv6 host", () => {
    expect(connectionHost("postgres://pos@[::1]:5432/pos")).toBe("::1");
  });

  it("never returns anything else from the string", () => {
    const host = connectionHost("postgres://pos:secret@db:5432/pos");
    expect(host).toBe("db");
    expect(host).not.toContain("secret");
  });

  it("answers null when there is nothing to read", () => {
    expect(connectionHost(undefined)).toBeNull();
    expect(connectionHost("")).toBeNull();
    expect(connectionHost("nonsense")).toBeNull();
  });
});

describe("describeConnectFailure", () => {
  it("turns a DNS failure into advice, naming the host", () => {
    const message = describeConnectFailure(
      dnsError("EAI_AGAIN"),
      "postgres://pos:secret@posdatabase-hpq-service:5432/pos",
    );
    expect(message).toContain("posdatabase-hpq-service");
    expect(message).toContain("EAI_AGAIN");
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain("secret");
  });

  it("distinguishes a refused connection from an unresolvable name", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(describeConnectFailure(refused, "postgres://pos@db:5432/pos")).toContain("refused");
  });

  it("falls back to the underlying message for anything else", () => {
    expect(describeConnectFailure(new Error("boom"), "postgres://pos@db:5432/pos")).toContain("boom");
  });
});
