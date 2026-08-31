#!/usr/bin/env node
/**
 * Dark-mode codemod.
 *
 * The dashboard sections were built with a hardcoded light palette:
 *   - stone-* neutrals for surfaces/text/borders  -> semantic theme tokens
 *     (bg-card, text-foreground, border-border, ... the exact tokens that
 *      already flip to dark via the CSS variables in globals.css).
 *   - bg-white solid surfaces                      -> bg-card.
 *   - amber-* accent (brand) and emerald/sky/rose/red status colours keep
 *     their hue but get a light-on-dark shade via a paired `dark:` utility.
 *
 * Tokens that already ship a `dark:` variant are left untouched, so manual
 * dark-mode work is never clobbered.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
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

// ---- stone neutrals -> semantic tokens -------------------------------------
const STONE_MAP = {
  bg: {
    50: "bg-muted", 100: "bg-muted", 200: "bg-muted", 300: "bg-input",
    400: "bg-muted-foreground/30", 500: "bg-muted-foreground/40",
    600: "bg-primary", 700: "bg-primary", 800: "bg-primary",
    900: "bg-primary", 950: "bg-primary",
  },
  text: {
    50: "text-primary-foreground", 100: "text-primary-foreground/90",
    300: "text-muted-foreground", 400: "text-muted-foreground",
    500: "text-muted-foreground", 600: "text-muted-foreground",
    700: "text-foreground/80", 800: "text-foreground",
    900: "text-foreground", 950: "text-foreground",
  },
  border: {
    100: "border-border", 200: "border-border", 300: "border-border",
    400: "border-input", 500: "border-muted-foreground/40",
    600: "border-muted-foreground/50", 700: "border-border", 800: "border-border",
  },
  ring: {
    200: "ring-border", 300: "ring-border", 400: "ring-input",
    500: "ring-muted-foreground/40", 700: "ring-border",
  },
  divide: { 100: "divide-border", 200: "divide-border", 300: "divide-border" },
  outline: { 300: "outline-border", 400: "outline-input", 500: "outline-muted-foreground/40" },
  fill: { 400: "fill-muted-foreground", 500: "fill-muted-foreground", 600: "fill-foreground" },
  stroke: { 100: "stroke-border", 200: "stroke-border", 300: "stroke-border" },
  placeholder: { 400: "placeholder:text-muted-foreground", 500: "placeholder:text-muted-foreground" },
  caret: { 500: "caret-muted-foreground", 700: "caret-foreground" },
  decoration: { 300: "decoration-muted-foreground/50", 400: "decoration-muted-foreground", 500: "decoration-muted-foreground" },
  // gradient stops (light -> foreground ramp); handled with dark pair below
};

// gradient / accent stone -> foreground tokens, need explicit dark pair
const STONE_DARK_PAIR = {
  from: { 900: "from-foreground", 800: "from-foreground", 950: "from-foreground", 600: "from-foreground/70", 50: "from-muted", 100: "from-muted" },
  to: { 900: "to-foreground", 800: "to-foreground", 950: "to-foreground", 600: "to-foreground/70", 50: "to-muted", 100: "to-muted" },
  via: { 900: "via-foreground", 50: "via-muted", 100: "via-muted" },
};

// ---- amber accent: explicit dark shade per (utility, shade) -----------------
const AMBER_DARK_SHADE = {
  bg: { 50: "500/15", 100: "500/20", 200: "500/25", 300: "500/35", 400: "400", 500: "400", 600: "400", 700: "400" },
  text: { 300: "400", 400: "300", 500: "400", 600: "400", 700: "300", 800: "300", 900: "200", 950: "200" },
  border: { 100: "500/25", 200: "500/30", 300: "500/40", 400: "500/50", 500: "500/60", 600: "500/70", 700: "400" },
  ring: { 200: "400/30", 300: "400/30", 400: "400/40", 500: "400/45", 600: "400/50", 700: "300/40" },
};

const STATUS_FAMILIES = new Set(["emerald", "sky", "rose", "red", "teal", "indigo"]);
const STATUS_BG_DARK = { 50: "500/15", 100: "500/20", 200: "500/25" };

const invert = (n) => String(1000 - n);

const TOKEN_RE =
  /^(?<bang>!)?(?<variants>(?:[a-z-]+:)*)(?<util>bg|text|border|ring|divide|outline|fill|stroke|placeholder|caret|from|to|via|accent|decoration|shadow)-(?<family>stone|amber|emerald|sky|rose|red|teal|indigo|white|black)(?:-(?<shade>\d{2,3}))?(?:\/(?<op>\d+))?$/;

function transformToken(tok, run = "") {
  const m = tok.match(TOKEN_RE);
  if (!m) return [tok];
  let { bang, variants, util, family, shade, op } = m.groups;
  bang = bang || "";
  if (variants.includes("dark:")) return [tok]; // hand-managed
  // Tailwind convention: dark: comes before state/pseudo variants.
  const darkPrefix = `dark:${variants}${bang}`;
  const lightPrefix = `${variants}${bang}`;
  const opSuffix = op ? `/${op}` : "";
  const pair = (darkToken) => {
    // if a dark counterpart is already present anywhere in the run, skip adding
    const allTokens = run.split(/\s+/);
    const darkBase = darkToken.replace(/^dark:/, "");
    const exists = allTokens.some(
      (t) => t.includes("dark:") && t.replace(/dark:/, "") === darkBase
    );
    return exists ? [tok] : [tok, darkToken];
  };

  // ---- solid white / black surfaces ----
  if (family === "white" || family === "black") {
    if (util === "bg" && shade === undefined) {
      if (op === undefined) {
        return pair(`${darkPrefix}bg-card`);
      }
      const n = Number(op);
      if (n >= 80) {
        return pair(`${darkPrefix}bg-zinc-800/${op}`);
      }
      return [tok]; // subtle translucent highlight — fine on dark
    }
    return [tok]; // text-white on accent buttons, black scrims, etc.
  }

  // ---- stone neutrals -> semantic tokens (already flip via CSS vars) ----
  if (family === "stone") {
    const shadeNum = Number(shade);
    if (util === "from" || util === "to" || util === "via") {
      const light = STONE_DARK_PAIR[util]?.[shadeNum];
      if (!light) return [tok];
      return [`${lightPrefix}${light}${op ? `/${op}` : ""}`];
    }
    const map = STONE_MAP[util]?.[shade];
    if (!map) return [tok];
    // opacity only valid on colour utilities we mapped to a colour token
    const withOp = /placeholder/.test(map) ? map : (op ? `${map}/${op}` : map);
    return [`${lightPrefix}${withOp}`];
  }

  // ---- accent (native control) amber/status: light + dark pair ----
  if (util === "accent") {
    const shadeNum = Number(shade);
    const dark = family === "amber" ? "amber-400" : `${family}-${invert(shadeNum)}`;
    return pair(`${darkPrefix}accent-${dark}`);
  }

  // ---- amber accent: light + dark pair ----
  if (family === "amber") {
    const shadeNum = Number(shade);
    const d = AMBER_DARK_SHADE[util]?.[shadeNum];
    const darkShade = d || invert(shadeNum);
    return [
      `${lightPrefix}${util}-amber-${shade}${opSuffix}`,
      `${darkPrefix}${util}-amber-${darkShade}`,
    ];
  }

  // ---- status families: keep hue, flip shade ----
  if (STATUS_FAMILIES.has(family)) {
    const shadeNum = Number(shade);
    if (util === "bg" && STATUS_BG_DARK[shadeNum]) {
      return [
        `${lightPrefix}bg-${family}-${shade}${opSuffix}`,
        `${darkPrefix}bg-${family}-${STATUS_BG_DARK[shadeNum]}`,
      ];
    }
    return [
      `${lightPrefix}${util}-${family}-${shade}${opSuffix}`,
      `${darkPrefix}${util}-${family}-${invert(shadeNum)}${opSuffix}`,
    ];
  }

  return [tok];
}

// Deduplicate identical classes within a class run, preserving order & spaces.
function dedupeTokens(text) {
  const seen = new Set();
  return text.split(/(\s+)/).map((part) => {
    if (/^\s+$/.test(part) || part === "") return part;
    if (seen.has(part)) return "";
    seen.add(part);
    return part;
  }).join("");
}

// Does the class run already contain a dark: counterpart for a light token?
// `dark:foo` or `dark:<variants>foo` both count.
function hasDarkCounterpart(run, lightToken, darkToken) {
  const darkBase = darkToken.replace(/^dark:/, "").replace(/^[a-z-]+:dark:/, "");
  // collect dark tokens present
  return run.split(/\s+/).some((t) => {
    if (!t.includes("dark:")) return false;
    const base = t.replace(/dark:/, "");
    return base === darkBase;
  });
}

// Transform a run of class text; preserve original whitespace exactly.
function processClassText(text) {
  // Per-token dark counterpart detection needs the full run for cross-references.
  const tokens = text.split(/(\s+)/);
  const fullRun = text;
  const out = tokens.map((part) => {
    if (/^\s+$/.test(part) || part === "") return part;
    const res = transformToken(part, fullRun);
    return res.join(" ");
  }).join("");
  return dedupeTokens(out);
}

// Only touch string literals that actually contain one of our colour tokens.
const TARGET_RE = /(?:bg|text|border|ring|divide|outline|fill|stroke|placeholder|caret)-(?:stone|amber|emerald|sky|rose|red|teal|indigo)-(?:\d{2,3})/;
const WHITE_RE = /(?:[a-z-]+:)*!?(?:bg)-white(?![\w/-])/;

function hasTarget(body) {
  return TARGET_RE.test(body) || /\bbg-white(?![\w/-])/.test(body);
}

function transformTemplateBody(body) {
  // transform static runs, leave ${...} interpolations untouched
  return body.replace(/(\$\{[\s\S]*?\})|([^$]+|\$(?!\{))/g, (seg, interp, text) => {
    if (interp) return interp;
    if (!hasTarget(text)) return text;
    return processClassText(text);
  });
}

// Proper JS/TS scanner: walk the source, track comments, regex literals and
// strings so quote characters inside them never desync string detection.
function processSource(src) {
  let changed = false;
  let out = "";
  let i = 0;
  const n = src.length;

  const isRegexContext = (before) => {
    // A "/" starts a regex when the previous significant token is not a value.
    const t = before.replace(/\s+$/, "");
    if (t === "") return true;
    const last = t[t.length - 1];
    // JSX: `</tag` (closing) or `<Tag ... /` (self-closing) — the slash is JSX,
    // never a regex. Detect a "<" after the previous statement boundary.
    // If the trimmed-before ends right after a `<` it's a closing tag open.
    if (last === "<") return false;
    // self-closing: look back past the immediate tag to ensure we're in JSX.
    // e.g. "...rounded-full " then "/" — hard to distinguish, but a "/" that
    // begins a regex would not be immediately preceded by an identifier inside
    // what is already JSX markup; rely on: if before contains a "<" and we are
    // inside a tag (no ">" since the "<"), treat as JSX.
    return !/[A-Za-z0-9_$)\]}]/.test(last);
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // line comment
    if (ch === "/" && next === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      out += src.slice(i, j);
      i = j;
      continue;
    }
    // block comment
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      out += src.slice(i, j);
      i = j;
      continue;
    }
    // JSX self-closing slash `/>` or closing-tag `</` — never a regex.
    if (ch === "/" && next === ">") {
      out += ch;
      i++;
      continue;
    }
    // regex literal (best-effort) — skip, quotes inside must not be treated as strings
    if (ch === "/" && isRegexContext(out)) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n) {
        const c = src[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) { ok = true; j++; break; }
        j++;
      }
      if (ok) {
        // consume flags
        while (j < n && /[a-z]/i.test(src[j])) j++;
        out += src.slice(i, j);
        i = j;
        continue;
      }
    }

    // string literals
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      let body = "";
      while (j < n) {
        const c = src[j];
        if (c === "\\") {
          body += src.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (c === quote) break;
        // template literal ${ ... } : recurse into the interpolation so the
        // class strings inside ternaries (`cond ? "bg-x" : "bg-y"`) are fixed.
        if (quote === "`" && c === "$" && src[j + 1] === "{") {
          let depth = 1;
          let k = j + 2;
          const start = k;
          while (k < n && depth > 0) {
            const ck = src[k];
            if (ck === "{") depth++;
            else if (ck === "}") { depth--; if (depth === 0) break; }
            k++;
          }
          const inner = src.slice(start, k);
          const { src: newInner, changed: innerChanged } = processSource(inner);
          body += "${" + (innerChanged ? newInner : inner) + "}";
          j = k + 1;
          continue;
        }
        body += c;
        j++;
      }
      const close = j < n ? quote : "";
      if (quote === "`") {
        const nb = transformTemplateBody(body);
        if (nb !== body) { changed = true; body = nb; }
      } else if (hasTarget(body)) {
        const nb = processClassText(body);
        if (nb !== body) { changed = true; body = nb; }
      }
      out += quote + body + close;
      i = j + 1;
      continue;
    }

    out += ch;
    i++;
  }

  return { src: out, changed };
}

const root = process.argv[2] || "src";
const files = walk(root);
let touched = 0;
for (const file of files) {
  // The platform admin console is intentionally always-dark (hardcoded slate/
  // white-on-dark chrome) and must not be inverted. Skip it.
  if (file.includes(`${"/"}platform${"/"}`)) continue;
  const orig = readFileSync(file, "utf8");
  const { src, changed } = processSource(orig);
  if (changed) {
    writeFileSync(file, src);
    touched++;
    console.log("touched", file);
  }
}
console.log(`\nDone. ${touched} files modified.`);
