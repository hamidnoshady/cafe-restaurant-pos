import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

// token that is a light-mode-only colour usage
const LIGHT_TOKEN =
  /^(?:[a-z-]+:)*(?:!?(?:bg|text|border|ring|divide|outline|fill|stroke|caret|from|to|via|accent|decoration)-(?:stone|slate|gray|neutral|zinc|amber|emerald|sky|rose|red|teal|indigo|orange|green|blue|yellow|violet|purple|pink|lime|cyan)-(?:\d{2,3})(?:\/\d+)?)|(?:[a-z-]+:)*!?bg-white$/;

function hasDarkFor(tokens, lightTok) {
  // determine family/utility/shade of light token
  const m = lightTok.match(/(?:[a-z-]+:)*!?((?:bg|text|border|ring|divide|outline|fill|stroke|caret|from|to|via|accent|decoration)-)([a-z]+)-(\d{2,3})(?:\/(\d+))?/);
  if (!m) return true; // bg-white handled below
  const [, util, fam, shade] = m;
  for (const t of tokens) {
    if (!t.includes("dark:")) continue;
    const base = t.replace(/dark:/, "");
    // match same utility + family regardless of shade (shade is adjusted for dark)
    const utilName = util.replace(/[-:]/g, "");
    const utilRe = new RegExp(`(^|:)${utilName}-${fam}-`);
    if (utilRe.test(base)) return true;
  }
  return false;
}

const problems = new Map();
const files = walk("src");
for (const file of files) {
  if (file.includes("/platform/")) continue; // intentionally always-dark console
  const src = readFileSync(file, "utf8");
  // extract every className="..." / `...` run (including multiline via [^"`'])
  const re = /className=\{?["'`]([^"'`]*)["'`]|\bcn\(\s*[`"']([^`"']*)[`"']/g;
  let m;
  const hits = [];
  while ((m = re.exec(src))) {
    const run = m[1] ?? m[2] ?? "";
    const tokens = run.split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      if (!LIGHT_TOKEN.test(t)) continue;
      if (t.includes("dark:")) continue;
      // semantic-token stone conversions don't reach here; these are residual stone/slate/gray
      if (/(?:bg|text|border|ring|divide|outline|fill|stroke|caret|from|to|via|decoration)-stone-/.test(t)) {
        hits.push(t);
        continue;
      }
      if (/bg-white$/.test(t) && !tokens.some((x) => x.includes("dark:bg-"))) {
        hits.push(t);
        continue;
      }
      if (!hasDarkFor(tokens, t)) hits.push(t);
    }
  }
  if (hits.length) problems.set(file, hits);
}

let total = 0;
for (const [file, hits] of problems) {
  total += hits.length;
  console.log(file.replace("src/", ""), "->", hits.length);
  const uniq = [...new Set(hits)];
  for (const h of uniq.slice(0, 12)) console.log("   ", h);
}
console.log("\nTotal problem tokens:", total, "across", problems.size, "files");
