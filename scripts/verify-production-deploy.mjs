#!/usr/bin/env node
import { pathToFileURL } from "node:url";

/**
 * Verify the thing a deployment system actually put in front of users.
 *
 * A successful image push or a successful "restart" API call is not rollout
 * evidence: an orchestrator can retain an old tag, fail its pull, or restart a
 * different service. APP_IMAGE_SHA is baked into the image and exposed by the
 * database-free health endpoint specifically so this check can distinguish an
 * old-but-healthy container from the image that was just published.
 *
 * No credentials are needed. The protected page checks deliberately run signed
 * out: each must receive the normal 307 login bounce with its *canonical* URL
 * in `next`, never a 404 or an old /dashboard/* rewrite.
 *
 * Usage:
 *   npm run deploy:verify -- \
 *     --health-url https://pos.example.com/api/health \
 *     --expected-sha 2fe770d \
 *     --attempts 60 --delay-ms 10000
 *
 * Environment equivalents are useful for CI:
 *   PRODUCTION_HEALTH_URL, EXPECTED_SHA,
 *   DEPLOY_VERIFY_ATTEMPTS, DEPLOY_VERIFY_DELAY_MS
 */

/** URLs promised by the top-level-app and settings cutover. */
export const PROTECTED_PATHS = Object.freeze([
  "/dashboard",
  "/projects",
  "/settings",
  "/settings/billing",
  "/settings/team",
  "/accounting/overview",
  "/accounting/expenses",
  "/accounting/settings",
  "/crm/overview",
  "/crm/persons",
  "/growth/overview",
  "/websites/overview",
]);

const USAGE = `Usage: npm run deploy:verify -- --health-url <https://host/api/health> --expected-sha <7+ hex SHA> [--attempts <positive integer>] [--delay-ms <non-negative integer>]

Environment equivalents: PRODUCTION_HEALTH_URL, EXPECTED_SHA, DEPLOY_VERIFY_ATTEMPTS, DEPLOY_VERIFY_DELAY_MS.`;

export class DeploymentVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeploymentVerificationError";
  }
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new DeploymentVerificationError(`${name} requires a value.\n\n${USAGE}`);
  }
  return value;
}

function rejectUnknownOptions(argv) {
  const allowed = new Set(["--health-url", "--expected-sha", "--attempts", "--delay-ms"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    if (!allowed.has(arg)) {
      throw new DeploymentVerificationError(`Unknown option: ${arg}.\n\n${USAGE}`);
    }
    index += 1;
  }
}

function nonNegativeInteger(value, name) {
  if (!/^\d+$/.test(value ?? "")) {
    throw new DeploymentVerificationError(`${name} must be a non-negative integer.\n\n${USAGE}`);
  }
  return Number(value);
}

function positiveInteger(value, name) {
  const parsed = nonNegativeInteger(value, name);
  if (parsed < 1) {
    throw new DeploymentVerificationError(`${name} must be at least 1.\n\n${USAGE}`);
  }
  return parsed;
}

/**
 * Turn either a service origin or its explicit /api/health URL into the two
 * URLs the verifier uses. The app does not support a URL path prefix, so
 * accepting another pathname here would create a misleading successful probe.
 */
export function deploymentUrls(value) {
  let supplied;
  try {
    supplied = new URL(value);
  } catch {
    throw new DeploymentVerificationError(`Invalid production URL: ${value}`);
  }

  if (supplied.protocol !== "https:" && supplied.protocol !== "http:") {
    throw new DeploymentVerificationError("The production URL must use http or https.");
  }
  if (supplied.username || supplied.password || supplied.search || supplied.hash) {
    throw new DeploymentVerificationError("The production URL must be a bare origin or /api/health URL (no credentials, query, or fragment).");
  }
  if (supplied.pathname !== "/" && supplied.pathname !== "/api/health") {
    throw new DeploymentVerificationError("The production URL must be a bare origin or end exactly in /api/health.");
  }

  const baseUrl = new URL(supplied.origin);
  return {
    baseUrl,
    healthUrl: new URL("/api/health", baseUrl),
  };
}

export function parseOptions(argv = process.argv.slice(2), env = process.env) {
  rejectUnknownOptions(argv);

  const healthUrl = optionValue(argv, "--health-url") ?? env.PRODUCTION_HEALTH_URL ?? env.HEALTH_URL;
  const expectedSha = optionValue(argv, "--expected-sha") ?? env.EXPECTED_SHA;
  const attemptsValue = optionValue(argv, "--attempts") ?? env.DEPLOY_VERIFY_ATTEMPTS ?? "1";
  const delayValue = optionValue(argv, "--delay-ms") ?? env.DEPLOY_VERIFY_DELAY_MS ?? "10000";

  if (!healthUrl || !expectedSha) {
    throw new DeploymentVerificationError(`Both --health-url and --expected-sha are required.\n\n${USAGE}`);
  }
  if (!/^[0-9a-f]{7,64}$/i.test(expectedSha)) {
    throw new DeploymentVerificationError("--expected-sha must be a Git SHA (7 to 64 hexadecimal characters), without a sha- tag prefix.");
  }

  const urls = deploymentUrls(healthUrl);
  return {
    ...urls,
    expectedSha: expectedSha.toLowerCase(),
    attempts: positiveInteger(attemptsValue, "--attempts"),
    delayMs: nonNegativeInteger(delayValue, "--delay-ms"),
  };
}

function responseSummary(response, body) {
  const text = body.trim().replace(/\s+/g, " ");
  return `HTTP ${response.status}${text ? ` (${text.slice(0, 220)})` : ""}`;
}

async function responseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** Read and validate the health document without allowing cache reuse or redirects. */
export async function readHealth(healthUrl, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(healthUrl, {
      redirect: "manual",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new DeploymentVerificationError(`Health request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const body = await responseText(response);
  if (!response.ok) {
    throw new DeploymentVerificationError(`Health request returned ${responseSummary(response, body)}.`);
  }

  let document;
  try {
    document = JSON.parse(body);
  } catch {
    throw new DeploymentVerificationError(`Health request did not return JSON: ${responseSummary(response, body)}.`);
  }
  if (!document || typeof document.version !== "string" || !document.version.trim()) {
    throw new DeploymentVerificationError("Health response has no APP_IMAGE_SHA version field.");
  }

  return { status: response.status, version: document.version.trim() };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until the reported image SHA is the exact image this rollout published. */
export async function waitForExpectedImage(options, { fetchImpl = fetch, sleep = wait, log = console.log } = {}) {
  let lastProblem = "the health endpoint did not answer";

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const health = await readHealth(options.healthUrl, fetchImpl);
      if (health.version === options.expectedSha) {
        log(`Verified live image ${health.version} on health-check attempt ${attempt}.`);
        return health;
      }
      lastProblem = `the server reports APP_IMAGE_SHA=${health.version}, expected ${options.expectedSha}`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }

    if (attempt < options.attempts) {
      log(`Rollout is not live yet (attempt ${attempt}/${options.attempts}): ${lastProblem}. Retrying in ${options.delayMs}ms.`);
      await sleep(options.delayMs);
    }
  }

  throw new DeploymentVerificationError(
    `Production rollout was not verified after ${options.attempts} attempt(s): ${lastProblem}. ` +
      "Do not treat an image push or restart acknowledgement as a successful deploy; make the orchestrator pull the expected immutable sha-* image and redeploy.",
  );
}

function expectedLoginLocation(baseUrl, pathname) {
  const expected = new URL("/login", baseUrl);
  expected.searchParams.set("next", pathname);
  return expected;
}

/**
 * Assert the signed-out boundary for every newly-public route. This is enough
 * to catch both a literal 404 and the old middleware rewrite: its redirect
 * carries /dashboard/... in `next`, whereas a current image preserves the
 * canonical top-level URL.
 */
export async function verifySignedOutRoutes(baseUrl, { fetchImpl = fetch, log = console.log } = {}) {
  const verified = [];

  for (const pathname of PROTECTED_PATHS) {
    const url = new URL(pathname, baseUrl);
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        headers: {
          Accept: "text/html",
          "Cache-Control": "no-cache",
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new DeploymentVerificationError(
        `${pathname}: request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const locationHeader = response.headers.get("location");
    if (response.status !== 307 || !locationHeader) {
      const body = await responseText(response);
      throw new DeploymentVerificationError(
        `${pathname}: expected a 307 login redirect for a signed-out visitor, got ${responseSummary(response, body)}.`,
      );
    }

    let location;
    try {
      location = new URL(locationHeader, url);
    } catch {
      throw new DeploymentVerificationError(`${pathname}: login redirect has an invalid Location header: ${locationHeader}`);
    }

    const expected = expectedLoginLocation(baseUrl, pathname);
    if (
      location.origin !== expected.origin ||
      location.pathname !== expected.pathname ||
      location.searchParams.get("next") !== pathname
    ) {
      throw new DeploymentVerificationError(
        `${pathname}: expected Location ${expected.href}, got ${location.href}. ` +
          "This usually means an old route rewrite is still running.",
      );
    }

    verified.push(pathname);
    log(`Verified signed-out route: ${pathname} -> /login?next=${pathname}`);
  }

  return verified;
}

export async function verifyDeployment(options, dependencies = {}) {
  const health = await waitForExpectedImage(options, dependencies);
  const routes = await verifySignedOutRoutes(options.baseUrl, dependencies);
  return { health, routes };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv, env);
  const result = await verifyDeployment(options);
  console.log(
    `Deployment verification passed: ${result.health.version}; ${result.routes.length} protected canonical routes redirect correctly for a signed-out visitor.`,
  );
}

const executedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
