/**
 * Issue #2083 — wiring gates that would have caught the #2060 blank Docs tab.
 *
 * In #2060 the Docs render branch was deleted as collateral of an adjacent
 * edit while its route and nav entries survived, so the tab rendered nothing
 * and CI stayed green. #2077 added route-content completeness pins; these
 * gates close the remaining holes:
 * - every TAB_CONTENT entry body must contain real JSX (not bare null or an
 *   empty fragment), so an entry cannot exist yet render nothing;
 * - every component file under src/client must be wired by an import path
 *   somewhere in src, or be on the explicit known-orphans list below.
 * The known orphans are unreferenced on main as of this PR; they are NOT
 * deleted here because the Policy Gate forbids file deletions in a PR
 * (retire by deprecating in place). A new orphan fails this test.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const clientRoot = join(repoRoot, "src", "client");
const srcRoot = join(repoRoot, "src");

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTsx(full, out);
    } else if (full.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** All static and dynamic import specifiers found in src TS/TSX files.
 * Tests are deliberately NOT walked: a test import must not launder a
 * component that dropped out of the app (MemoryBrowser and the
 * OptionsResearchPanel shim below are referenced only by tests). */
function collectResolvedImportPaths(): Set<string> {
  const resolved = new Set<string>();
  const specRe =
    /(?:from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\))/g;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
        const text = readFileSync(full, "utf8");
        for (const m of text.matchAll(specRe)) {
          const spec = m[1] ?? m[2];
          if (!spec.startsWith(".")) continue;
          const abs = resolve(dirname(full), spec).replace(
            /\.tsx?$/,
            "",
          );
          resolved.add(abs);
        }
      }
    }
  };
  walk(srcRoot);
  return resolved;
}

/** Files under src/client that no import path resolves to. */
const KNOWN_ORPHANS = [
  // Not mounted in the app; rendered only by
  // tests/memory_browser_search_button.test.tsx.
  "src/client/MemoryBrowser.tsx",
  // The live SettingsMenu is exported from ETradeDynamicMenu.tsx; this
  // file is a legacy duplicate.
  "src/client/SettingsMenu.tsx",
  // Unreferenced on main as of #2083.
  "src/client/SetupCatalogPanel.tsx",
  "src/client/StrategyReviewPanel.tsx",
  // One-line re-export shims to the canonical copies under options/;
  // the LlmOptionsIdeasPanel shim is referenced nowhere, and the
  // OptionsResearchPanel shim only by tests/options_llm_ideas.test.ts.
  "src/client/LlmOptionsIdeasPanel.tsx",
  "src/client/OptionsResearchPanel.tsx",
  // Deprecated in place in #2723 (superseded by DataProvidersPanel);
  // preserved under the zero-deletions policy gate (§22).
  "src/client/ProviderConnectivityDashboard.tsx",
];

describe("tab content wiring gates (#2083)", () => {
  it("every TAB_CONTENT entry body contains real JSX", () => {
    const chatSrc = readFileSync(join(clientRoot, "Chat.tsx"), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    const start = chatSrc.indexOf("const TAB_CONTENT");
    expect(start).toBeGreaterThan(-1);
    const end = chatSrc.indexOf("\n  };", start);
    expect(end).toBeGreaterThan(start);
    const record = chatSrc.slice(start, end);
    const keyRe = /^    "?([a-z0-9-]+)"?: \(/gm;
    const matches = [...record.matchAll(keyRe)];
    expect(matches.length).toBeGreaterThan(0);
    for (let i = 0; i < matches.length; i++) {
      const key = matches[i][1];
      const bodyStart = matches[i].index + matches[i][0].length;
      const bodyEnd =
        i + 1 < matches.length ? matches[i + 1].index : record.length;
      const body = record.slice(bodyStart, bodyEnd);
      expect(
        /<[A-Za-z][\w.]*/.test(body),
        `TAB_CONTENT entry "${key}" contains no JSX element`,
      ).toBe(true);
      expect(
        /^\s*(null|<>\s*<\/>)\s*,?\s*$/.test(body),
        `TAB_CONTENT entry "${key}" renders nothing`,
      ).toBe(false);
    }
  });

  it("the main-region fallback fails loud instead of rendering null", () => {
    const chatSrc = readFileSync(join(clientRoot, "Chat.tsx"), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    // Without this, a missing entry renders {TAB_CONTENT[tab] ?? null}:
    // a silent blank viewport, which is how #2060 shipped unnoticed.
    expect(chatSrc).toContain("Missing tab content");
    expect(chatSrc).not.toContain("{TAB_CONTENT[tab] ?? null}");
  });

  it("every client component file is wired by an import, or allowlisted", () => {
    const imported = collectResolvedImportPaths();
    const unlisted: string[] = [];
    for (const file of walkTsx(clientRoot)) {
      const rel = file.slice(repoRoot.length + 1).split(sep).join("/");
      // The components/ui barrel library is consumed via its index, and
      // main.tsx is the app entry loaded by the HTML shell, not by import.
      if (rel.startsWith("src/client/components/ui/")) continue;
      if (rel === "src/client/main.tsx") continue;
      if (/\.test\.tsx$/.test(rel)) continue;
      const noExt = file.replace(/\.tsx$/, "");
      if (!imported.has(noExt) && !KNOWN_ORPHANS.includes(rel)) {
        unlisted.push(rel);
      }
    }
    expect(
      unlisted,
      `client component files wired by no import (add to KNOWN_ORPHANS only with a reason, or wire them): ${unlisted.join(", ")}`,
    ).toEqual([]);
  });

  it("the known-orphans list matches reality (no stale entries)", () => {
    const imported = collectResolvedImportPaths();
    for (const rel of KNOWN_ORPHANS) {
      const abs = join(repoRoot, rel).replace(/\.tsx$/, "");
      expect(
        imported.has(abs),
        `known orphan "${rel}" is now imported; remove it from KNOWN_ORPHANS`,
      ).toBe(false);
    }
  });
});
