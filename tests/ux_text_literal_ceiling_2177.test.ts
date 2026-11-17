/**
 * Issue #2177 (epic #2150 slice 4) — running-text trim ratchet.
 *
 * After the trim, every font-size/fontSize literal in the client is
 * either an exact token value, a var(--font-size-*) reference, or one
 * of the allowlisted neutrals (inherit, 0, the :root scale calc).
 * Off-scale literals (0.82rem, 0.85rem, 0.9rem, 11px, ...) fail this
 * test until they are collapsed to the token scale — the same
 * ratchet discipline as the bespoke ceiling, applied to sizes.
 *
 * Deliberately stricter than the bespoke ceiling: it covers
 * primitives.css and components/ui too, because the trim changes the
 * system itself (scope note, field labels, buttons), not just bespoke
 * files. tokens.css var definitions are exact values by construction;
 * its var() fallbacks are aligned to their var's own value.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, "..", "src", "client");

const EXACT_REM = new Set([
  0.65, 0.75, 0.8125, 0.875, 1, 1.125, 1.25, 1.5, 1.875,
]);
const EXACT_PX = new Set([10.4, 12, 13, 14, 16, 18, 20, 24, 30]);

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

function stripCssComments(text: string): string {
  return text.replace(/\/\*.*?\*\//gs, "");
}

function offScaleCss(text: string, file: string): string[] {
  const bad: string[] = [];
  const clean = stripCssComments(text);
  for (const m of clean.matchAll(/font-size:\s*([^;}{]+)/g)) {
    const v = m[1].trim();
    if (v.startsWith("var(") || v === "inherit" || v === "0") continue;
    if (v.startsWith("calc(") && v.includes("--app-font-scale")) continue;
    // A value passes when every rem/em/px literal inside it lives in a
    // var() reference — this admits clamp(var, 1vw, var) fluid sizes
    // while still catching bare literals anywhere in the value.
    const bare = v.replace(/var\([^)]*\)/g, "");
    if (!/[0-9]\s*(rem|em|px)/.test(bare)) continue;
    const num = /^([0-9]*\.?[0-9]+)\s*(rem|em|px)$/.exec(v);
    if (!num) {
      bad.push(`${file}: unrecognized font-size "${v}"`);
      continue;
    }
    const val = parseFloat(num[1]);
    const ok =
      (num[2] === "px" && EXACT_PX.has(val)) ||
      (num[2] !== "px" && EXACT_REM.has(val));
    if (!ok) bad.push(`${file}: off-scale font-size "${v}"`);
  }
  return bad;
}

function offScaleTsx(text: string, file: string): string[] {
  const bad: string[] = [];
  // Remove {/* */} blocks; a fontSize before any // on its line counts.
  const clean = text.replace(/\{\/\*.*?\*\/\}/gs, "");
  for (const line of clean.split("\n")) {
    const idx = line.indexOf("fontSize:");
    if (idx < 0) continue;
    if (line.slice(0, idx).includes("//")) continue;
    const rest = line.slice(idx);
    const str = /^fontSize:\s*"([0-9]*\.?[0-9]+)\s*(rem|em|px)"/.exec(rest);
    const num = !str && /^fontSize:\s*([0-9]*\.?[0-9]+)/.exec(rest);
    if (str) {
      const val = parseFloat(str[1]);
      const ok =
        (str[2] === "px" && EXACT_PX.has(val)) ||
        (str[2] !== "px" && EXACT_REM.has(val));
      if (!ok) bad.push(`${file}: off-scale fontSize "${str[1]}${str[2]}"`);
    } else if (num) {
      if (!EXACT_PX.has(parseFloat(num[1]))) {
        bad.push(`${file}: off-scale fontSize ${num[1]}`);
      }
    }
    // var() references, expressions, and template literals pass.
  }
  return bad;
}

describe("running-text trim — token-scale sizes only (#2177)", () => {
  it("has no off-scale font-size literals in client CSS", () => {
    const bad: string[] = [];
    for (const f of walk(clientDir, ".css")) {
      bad.push(...offScaleCss(readFileSync(f, "utf8"), f));
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });

  it("has no off-scale fontSize literals in client tsx", () => {
    const bad: string[] = [];
    for (const f of walk(clientDir, ".tsx")) {
      bad.push(...offScaleTsx(readFileSync(f, "utf8"), f));
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });

  it("sets the body base size to the body token", () => {
    const styles = readFileSync(join(clientDir, "styles.deprecated.css"), "utf8");
    const body = /body\s*\{[^}]*\}/.exec(stripCssComments(styles));
    expect(body?.[0]).toMatch(/font-size:\s*var\(--font-size-body\)/);
  });
});
