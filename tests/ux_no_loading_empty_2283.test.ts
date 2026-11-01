/**
 * Interaction consistency (#2283, epic #2150 slice 5, stream 4):
 * loading is never presented as an empty state. While data is in
 * flight the panel shows a Spinner (or a Skeleton); EmptyState is
 * reserved for settled-but-empty. An EmptyState titled "Loading…"
 * lies twice: it claims emptiness before the data has answered, and
 * it keeps claiming loading after the fetch failed.
 *
 * The scan strips comments, then flags any EmptyState whose title
 * prop contains "Loading" (literal or ternary branch).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CLIENT_DIR = join(__dirname, "..", "src", "client");

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

/**
 * Index just past the closing `>` of the opening tag at `start`.
 * Tracks `{}` depth and quote state, so a `>` inside a JSX
 * expression container (e.g. icon={<Spinner ... />}) or a string
 * does not end the tag early — the naive `[^>]*` scan missed
 * exactly those tags (MarketDataResearchHub quote cards).
 */
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

describe("no loading EmptyState titles (#2283 stream 4)", () => {
  it("no EmptyState title contains Loading", () => {
    const offenders: string[] = [];
    for (const file of walk(CLIENT_DIR)) {
      const clean = stripComments(readFileSync(file, "utf8"));
      // Find each <EmptyState ...> opening tag and inspect its title prop.
      let idx = 0;
      while (true) {
        const open = clean.indexOf("<EmptyState", idx);
        if (open === -1) break;
        const after = clean[open + "<EmptyState".length];
        if (after && /[A-Za-z0-9_]/.test(after)) {
          idx = open + 1;
          continue;
        }
        const tagEnd = endOfOpenTag(clean, open);
        if (tagEnd === -1) break;
        const tag = clean.slice(open, tagEnd);
        const titleMatch = tag.match(/title=\{([^}]*)\}|title="([^"]*)"/);
        const title = titleMatch ? (titleMatch[1] ?? titleMatch[2] ?? "") : "";
        if (/loading/i.test(title)) {
          offenders.push(`${file}: ${tag.slice(0, 90)}`);
        }
        idx = tagEnd;
      }
    }
    expect(offenders).toEqual([]);
  });
});
