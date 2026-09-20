#!/usr/bin/env node
/**
 * Builds the positively selected runtime consumed by the Electron installer.
 *
 * The old installer copied the repository's entire root node_modules, raw src,
 * TypeScript scripts and build cache. This builder starts from Next's traced
 * standalone server and adds only the custom WebSocket/background server,
 * compiled provisioning helpers, migrations and public assets.
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = path.join(root, ".next");
const standaloneDir = path.join(nextDir, "standalone");
const outDir = path.join(root, ".desktop-runtime");

function required(relativePath, explanation) {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) {
    throw new Error(`${relativePath} is missing (${explanation})`);
  }
  return absolute;
}

async function directoryBytes(directory) {
  let total = 0;
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

async function compile(entryPoint, outfile) {
  return build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: false,
    legalComments: "none",
    // Imported CLI modules contain direct-execution guards. In CJS output an
    // unbound import.meta.url becomes undefined and fileURLToPath throws before
    // our compiled entry can call main(). A stable non-entry URL keeps every
    // imported guard false without retaining a TypeScript loader.
    // Generate a syntactically valid file URL for the build host. A root-only
    // `file:///__...` URL works on POSIX but is not an absolute Windows file
    // URL (which requires a drive), and made packaged helpers fail before main.
    define: {
      "import.meta.url": JSON.stringify(pathToFileURL(path.join(root, "__desktop_bundle_dependency__.ts")).href),
    },
    metafile: true,
    external: ["next", "next/*", "pg-native", "bufferutil", "utf-8-validate"],
    logLevel: "warning",
    logOverride: { "empty-import-meta": "silent" },
  });
}

async function main() {
  required(".next/BUILD_ID", "run npm run build first");
  required(".next/standalone", "next.config.ts must keep output: standalone");
  required(".next/static", "production client assets were not built");
  required("public/windows/cafe-pos-print-connector.ps1", "the Windows print connector is a shipped capability");
  required("public/favicon.ico", "the canonical Windows installer icon is generated from public/icon.svg");

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Next's node-file-traced server dependency graph. This contains only the
  // runtime node_modules files reached by production routes, not root deps.
  await cp(standaloneDir, outDir, { recursive: true });
  await mkdir(path.join(outDir, ".next"), { recursive: true });
  await cp(path.join(nextDir, "static"), path.join(outDir, ".next", "static"), { recursive: true });
  await cp(path.join(root, "public"), path.join(outDir, "public"), { recursive: true });
  await cp(path.join(root, "migrations"), path.join(outDir, "migrations"), { recursive: true });

  // Next's conservative package-level trace reaches its optional TypeScript
  // config loader even though this staged runtime has no TS config or source.
  // Remove only top-level development packages; never use recursive globs that
  // could strip next/dist/lib/typescript or another nested production file.
  for (const packagePath of [
    "node_modules/typescript",
    "node_modules/tsx",
    "node_modules/vitest",
    "node_modules/@vitest",
    "node_modules/@types",
    "node_modules/tailwindcss",
    "node_modules/@tailwindcss",
  ]) {
    await rm(path.join(outDir, packagePath), { recursive: true, force: true });
  }

  // Never inherit a cache from standalone output if Next starts tracing one in
  // a future release. Static/server output is retained; only rebuildable cache
  // is forbidden.
  await rm(path.join(outDir, ".next", "cache"), { recursive: true, force: true });

  const binDir = path.join(outDir, "bin");
  await mkdir(binDir, { recursive: true });
  const [serverBuild, migrateBuild, deriveBuild] = await Promise.all([
    compile("server.ts", path.join(binDir, "server.cjs")),
    compile("scripts/desktop/migrate-entry.ts", path.join(binDir, "migrate.cjs")),
    compile(
      "scripts/desktop/derive-runtime-database-url-entry.ts",
      path.join(binDir, "derive-runtime-database-url.cjs"),
    ),
  ]);

  const sourcePackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const manifest = {
    name: "business-suite-desktop-runtime",
    private: true,
    version: sourcePackage.version,
    engines: { node: ">=20" },
    desktopRuntime: {
      format: 1,
      server: "bin/server.cjs",
      migrate: "bin/migrate.cjs",
      deriveDatabaseUrl: "bin/derive-runtime-database-url.cjs",
      nextBuildId: (await readFile(path.join(nextDir, "BUILD_ID"), "utf8")).trim(),
    },
  };
  await writeFile(path.join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const forbidden = [
    "scripts",
    "tsconfig.json",
    "next.config.ts",
    ".next/cache",
    "coverage",
    "test-results",
    "playwright-report",
    ".git",
  ];
  for (const relative of forbidden) {
    if (existsSync(path.join(outDir, relative))) {
      throw new Error(`forbidden desktop runtime path was staged: ${relative}`);
    }
  }

  if (existsSync(path.join(outDir, "src"))) {
    const { readdir } = await import("node:fs/promises");
    const sourceFiles = [];
    async function collectSource(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) await collectSource(absolute);
        else sourceFiles.push(path.relative(outDir, absolute).replace(/\\/g, "/"));
      }
    }
    await collectSource(path.join(outDir, "src"));
    const unexpected = sourceFiles.filter((file) => !file.startsWith("src/app/fonts/") || !/\.(woff2?|ttf|otf)$/i.test(file));
    if (unexpected.length) throw new Error(`unexpected raw source was traced: ${unexpected.join(", ")}`);
  }

  for (const packageName of ["typescript", "tsx", "vitest", "tailwindcss", "@vitest", "@types"]) {
    if (existsSync(path.join(outDir, "node_modules", packageName))) {
      throw new Error(`development-only package leaked into desktop runtime: ${packageName}`);
    }
  }

  const runtimeBytes = await directoryBytes(outDir);
  const report = {
    generatedAt: new Date().toISOString(),
    bytes: runtimeBytes,
    mebibytes: Number((runtimeBytes / 1024 / 1024).toFixed(1)),
    inputs: {
      serverBundleFiles: Object.keys(serverBuild.metafile.inputs).length,
      migrateBundleFiles: Object.keys(migrateBuild.metafile.inputs).length,
      deriveBundleFiles: Object.keys(deriveBuild.metafile.inputs).length,
    },
  };
  await writeFile(path.join(outDir, "runtime-build.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Desktop runtime staged at ${path.relative(root, outDir)} (${report.mebibytes} MiB)`);
}

main().catch((error) => {
  console.error(`desktop runtime build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
