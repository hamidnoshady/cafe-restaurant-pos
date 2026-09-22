import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The GitHub Actions runner rewrites every `powershell`/`pwsh` step body as:
 *
 *   $ErrorActionPreference = 'stop'
 *   <the step's run: block>
 *   if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }
 *
 * (actions/runner, ScriptHandlerHelpers.FixUpScriptContents.)
 *
 * So a step's verdict is NOT the last `if` it wrote — it is whatever
 * $LASTEXITCODE happens to hold when the body ends. Any step that probes with a
 * native command whose *non-zero* exit is the healthy answer must therefore end
 * with an explicit `exit`, or it fails precisely when it should pass.
 *
 * That is the bug that broke build-plugin-zip #101: "Refuse to shadow a shipped
 * version" probed with `git rev-parse -q --verify refs/tags/vX.Y.Z`, which exits
 * 1 when the tag is free. The tag was free — zero tags existed in the repo — the
 * guard's `if` correctly did not fire, and the leftover 1 failed the build
 * before it bumped, zipped or tagged anything.
 */

const workflowDirectory = ".github/workflows";

function workflowFiles(): string[] {
  return readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

/** The `run:` block bodies of a workflow, with their surrounding step name. */
function runBlocks(source: string): { name: string; body: string }[] {
  const lines = source.split("\n");
  const blocks: { name: string; body: string }[] = [];
  let currentName = "(unnamed step)";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const nameMatch = /^\s*-?\s*name:\s*(.+?)\s*$/.exec(line);
    if (nameMatch) {
      currentName = nameMatch[1].replace(/^["']|["']$/g, "");
      continue;
    }

    const runMatch = /^(\s*)run:\s*\|\s*$/.exec(line);
    if (!runMatch) continue;

    const indent = runMatch[1].length;
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (candidate.trim() === "") {
        body.push("");
        continue;
      }
      const candidateIndent = candidate.length - candidate.trimStart().length;
      if (candidateIndent <= indent) break;
      body.push(candidate);
    }
    blocks.push({ name: currentName, body: body.join("\n") });
  }

  return blocks;
}

/** Body lines that are neither blank nor a comment. */
function statements(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("PowerShell workflow steps and the runner's exit-code epilogue", () => {
  it("never lets a probe whose failure means 'all clear' decide the step", () => {
    const offenders: string[] = [];

    for (const file of workflowFiles()) {
      const source = readFileSync(path.join(workflowDirectory, file), "utf8");
      // Every workflow in this repo that runs PowerShell declares it once, at
      // the top, via `defaults.run.shell`.
      if (!/shell:\s*(powershell|pwsh)/.test(source)) continue;

      for (const block of runBlocks(source)) {
        if (!block.body.includes("$LASTEXITCODE")) continue;

        // "non-zero is the passing answer" reads as `-eq 0` meaning "bad news".
        const treatsZeroAsFailure = /\$LASTEXITCODE\s+-eq\s+0/.test(block.body);
        if (!treatsZeroAsFailure) continue;

        const lines = statements(block.body);
        const endsExplicitly = /^exit\b/.test(lines[lines.length - 1] ?? "");
        if (!endsExplicitly) {
          offenders.push(`${file} → ${block.name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the plugin release guard passing when the version is still free", () => {
    const guard = runBlocks(readFileSync(path.join(workflowDirectory, "build-plugin-zip.yml"), "utf8")).find(
      (block) => block.name === "Refuse to shadow a shipped version",
    );

    expect(guard).toBeDefined();
    // Only the code matters here; the step's comments quote the old probe on
    // purpose, to explain why it must not come back.
    const lines = statements(guard!.body);
    const code = lines.join("\n");

    // Asks with a command that answers in its output, not its exit code:
    // `git tag --list` exits 0 whether or not the tag exists.
    expect(code).toContain("git tag --list");
    // `git rev-parse --verify` exits 1 for the healthy "tag is free" case, so it
    // must never be what this step ends on again.
    expect(code).not.toContain("rev-parse -q --verify");

    // Still refuses to rebuild a shipped version.
    expect(code).toContain("already exists");

    // And ends on a verdict of its own rather than a leftover exit code.
    expect(lines[lines.length - 1]).toBe("exit 0");
  });
});
