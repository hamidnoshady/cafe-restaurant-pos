/**
 * Guards the one dependency rule the Docker image depends on.
 *
 * The runner stage of the Dockerfile installs with `npm ci --omit=dev`
 * (prod-deps stage), so **anything in `devDependencies` does not exist in the
 * production image** — not even packages that happen to be pulled in
 * transitively by a production dependency, because those paths are incidental
 * and move without warning.
 *
 * Two things run in that image and are written in TypeScript:
 *
 *   - `docker-entrypoint.sh`, which calls `tsx scripts/migrate.ts` and
 *     `tsx scripts/derive-runtime-database-url.ts` on every boot, and
 *   - `npm start`, the container CMD, which is `tsx server.ts`.
 *
 * So `tsx` — and every package those scripts import — has to be a runtime
 * dependency. It is not enough for `tsx` to be present during development: it
 * used to arrive only as an *optional peer* of vitest, which made `npm ci`
 * locally install it and `npm ci --omit=dev` in the image drop it, producing a
 * boot failure whose only symptom was a shell error from the entrypoint
 * (`./node_modules/.bin/tsx: not found`) after "Applying database migrations".
 *
 * These assertions read the repository rather than start a process, so they run
 * in the normal `npm test` suite with no database.
 */
import { builtinModules } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface PackageManifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
}

function readJson(relativePath: string): PackageManifest {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, relativePath), "utf8"),
  ) as PackageManifest;
}

/**
 * Any string literal that follows `from`, `require(` or `import(` — i.e. every
 * module specifier form the codebase uses, including side-effect imports
 * (`import "dotenv/config"`) and dynamic ones.
 */
const SPECIFIER = /(?:from|require|import)\s*\(?\s*["']([^"']+)["']/g;

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.replace(/^_/, "")),
]);

/** `@scope/pkg` → `@scope/pkg`; `pkg/sub` → `pkg`. */
function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

/** Resolve a specifier to a repo file, or null when it names a package. */
function localFileFor(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith("node:")) return null;
  if (specifier.startsWith("@/")) {
    return resolveFile(join(REPO_ROOT, "src", specifier.slice(2)));
  }
  if (!specifier.startsWith(".")) return null;
  return resolveFile(join(dirname(fromFile), specifier));
}

function resolveFile(pathWithoutExtension: string): string | null {
  const candidates = [
    pathWithoutExtension,
    `${pathWithoutExtension}.ts`,
    `${pathWithoutExtension}.tsx`,
    `${pathWithoutExtension}.mjs`,
    `${pathWithoutExtension}.js`,
    join(pathWithoutExtension, "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Every npm package imported by `entrypoint` and, transitively, by the local
 * files it imports. Local imports are followed so that a script which reaches a
 * dev dependency through `./create-app-role` is caught too.
 */
function importedPackages(entrypoint: string): Set<string> {
  const found = new Set<string>();
  const queue = [join(REPO_ROOT, entrypoint)];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1];
      // `node:fs` and friends ship with the runtime, not with npm.
      if (specifier.startsWith("node:")) continue;
      const local = localFileFor(specifier, file);
      if (local) {
        queue.push(local);
        continue;
      }
      const name = packageNameOf(specifier);
      if (NODE_BUILTINS.has(name)) continue;
      found.add(name);
    }
  }

  return found;
}

const pkg = readJson("package.json");

describe("runtime dependencies survive `npm ci --omit=dev`", () => {
  /**
   * The scripts the container CMD and the entrypoint actually execute. Other
   * scripts (`test`, `build`, `dev`) legitimately use devDependencies and are
   * deliberately not covered here.
   */
  const CONTAINER_SCRIPTS = ["start", "db:migrate"];

  /**
   * TypeScript files the entrypoint runs on every boot, before the server starts.
   * Keep in step with docker-entrypoint.sh.
   */
  const BOOT_ENTRYPOINTS = [
    "scripts/migrate.ts",
    "scripts/derive-runtime-database-url.ts",
  ];

  it("runs tsx from the production tree, so tsx is a runtime dependency", () => {
    expect(Object.keys(pkg.dependencies)).toContain("tsx");
  });

  it.each(CONTAINER_SCRIPTS)(
    "resolves the command behind `npm run %s` from dependencies",
    (script) => {
      const command = pkg.scripts[script];
      expect(command, `package.json is missing a "${script}" script`).toBeTruthy();

      // Strip leading `VAR=value` assignments before taking the binary name.
      const binary = command
        .split(/\s+/)
        .filter((token) => token.length > 0 && !token.includes("="))[0];

      expect(
        Object.keys(pkg.dependencies),
        `"${script}" runs "${binary}", which must be in dependencies: the ` +
          `image is built with npm ci --omit=dev, so devDependencies are ` +
          `absent at runtime.`,
      ).toContain(binary);
    },
  );

  it("resolves every `./node_modules/.bin/*` call in the entrypoint from dependencies", () => {
    const entrypoint = readFileSync(
      join(REPO_ROOT, "docker-entrypoint.sh"),
      "utf8",
    );
    // Prose in comments quotes paths too (`…/.bin/tsx: not found`) — match code.
    const code = entrypoint
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    const binaries = [...code.matchAll(/\.bin\/([^\s"')]+)/g)].map(
      (match) => match[1],
    );

    expect(binaries.length).toBeGreaterThan(0);
    for (const binary of new Set(binaries)) {
      expect(Object.keys(pkg.dependencies)).toContain(binary);
    }
  });

  it.each(BOOT_ENTRYPOINTS)(
    "imports only runtime dependencies from %s (and the files it imports)",
    (entrypoint) => {
      const imported = [...importedPackages(entrypoint)].sort();
      expect(imported.length).toBeGreaterThan(0);

      const missing = imported.filter(
        (name) => !(name in pkg.dependencies),
      );
      expect(
        missing,
        `${entrypoint} (and its local imports) import ${missing.join(", ")}, ` +
          `which npm ci --omit=dev will not install into the image. Move ` +
          `them to "dependencies" in package.json.`,
      ).toEqual([]);
    },
  );
});
