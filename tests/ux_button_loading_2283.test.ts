/**
 * Interaction consistency (#2283, epic #2150 slice 5, stream 4):
 * async buttons use the Button `loading` prop, never a label swap.
 * A label swap ("Save" → "Saving…") renames the action mid-flight,
 * shifts layout as the text width changes, and drops the spinner
 * affordance; `loading` keeps the label, shows the spinner, disables
 * the button, and sets aria-busy.
 *
 * The scan strips comments, then walks each <Button>…</Button> block
 * (buttons do not nest in this codebase — a nested <Button> fails the
 * scan loudly rather than being silently skipped) and flags a ternary
 * whose branch is an ellipsis string: `busy ? "Saving…" : "Save"` or
 * the inverted shape. Static ellipses are NOT flagged: "Select
 * strategies…" (opens a picker), truncated content ("NLQ: …"), and
 * bare "…" affordances are content, not progress labels — they live
 * in ALLOWLIST with the reason, so a new swap cannot hide behind it.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CLIENT_DIR = join(__dirname, "..", "src", "client");

// [file suffix, literal substring, reason] — content ellipses, not swaps.
const ALLOWLIST: Array<[string, string, string]> = [
  ["ScannerPanel.tsx", "Select strategies…", "opens the strategy picker; not a progress label"],
  ["OptionsResearchPanel.tsx", "NLQ:", "query truncation in a content label, not a progress label"],
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.tsx?$/.test(entry)) yield path;
  }
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Index just past the closing `>` of the opening tag at `start`. */
function endOfOpenTag(text: string, start: number): number {
  let i = start;
  let depth = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
    } else if (ch === ">" && depth === 0) {
      return i + 1;
    }
    i++;
  }
  return -1;
}

/** Ellipsis strings appearing as a ternary branch in `children`. */
function swapBranches(children: string): string[] {
  const found: string[] = [];
  const branchRe = /[?:]\s*["`]([^"'`]*…[^"'`]*)["`]/g;
  let m: RegExpExecArray | null;
  while ((m = branchRe.exec(children)) !== null) {
    found.push(m[1].slice(0, 50));
  }
  return found;
}

describe("buttons use loading, never label swaps (#2283 stream 4)", () => {
  it("no Button child ternary swaps to an ellipsis label", () => {
    const offenders: string[] = [];
    for (const file of walk(CLIENT_DIR)) {
      const clean = stripComments(readFileSync(file, "utf8"));
      let idx = 0;
      while (true) {
        const open = clean.indexOf("<Button", idx);
        if (open === -1) break;
        // Word boundary: <Button, not <ButtonGroup etc.
        const after = clean[open + "<Button".length];
        if (after && /[A-Za-z0-9_]/.test(after)) {
          idx = open + 1;
          continue;
        }
        const childrenStart = endOfOpenTag(clean, open);
        if (childrenStart === -1) break;
        // Self-closing button: no children to check.
        if (clean[childrenStart - 2] === "/") {
          idx = childrenStart;
          continue;
        }
        const close = clean.indexOf("</Button>", childrenStart);
        if (close === -1) break;
        const children = clean.slice(childrenStart, close);
        if (children.includes("<Button")) {
          offenders.push(`${file}: nested <Button> — scanner cannot verify`);
        } else {
          for (const lit of swapBranches(children)) {
            const allowed = ALLOWLIST.some(
              ([suffix, sub]) => file.endsWith(suffix) && lit.includes(sub)
            );
            if (!allowed) offenders.push(`${file}: "${lit}"`);
          }
        }
        idx = close + "</Button>".length;
      }
    }
    expect(offenders).toEqual([]);
  });
});
