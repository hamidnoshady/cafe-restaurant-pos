import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(?:tsx|jsx)$/.test(entry) ? [path] : [];
  });
}

describe("numeric input architecture", () => {
  it("does not combine PersianNumberInput with native pattern validation", () => {
    const offenders = sourceFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return [...source.matchAll(/<PersianNumberInput\b[\s\S]*?\/>/g)]
        .filter((match) => /\bpattern\s*=/.test(match[0]))
        .map(() => relative(process.cwd(), path));
    });
    expect(offenders).toEqual([]);
  });

  it("keeps user-facing React number inputs on the localized design-system control", () => {
    const offenders = sourceFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return [...source.matchAll(/<input\b[\s\S]*?\btype\s*=\s*["']number["'][\s\S]*?>/g)]
        .map(() => relative(process.cwd(), path));
    });
    expect(offenders).toEqual([]);
  });
});
