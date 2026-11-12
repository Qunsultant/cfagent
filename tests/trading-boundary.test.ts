/**
 * Assessment P2 item 9 / issue #290: in-repo trading boundary enforcement.
 *
 * Owner verdict (2026-10-18): do NOT extract trading to a worker; enforce the
 * boundary in-repo instead. src/trading/index.ts is the SOLE public import
 * surface of src/trading/. This test fails the suite if any module outside
 * src/trading/ imports a trading-internal path directly (static `from`,
 * `export ... from`, or dynamic `import()`). Issue #4270: the scan covers
 * `.tsx` files as well as `.ts` — a `.tsx` file importing a trading-internal
 * path is the same violation, and the pin must see it.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(__dirname, "../src");
const TRADING_DIR = path.join(SRC, "trading");
const INDEX_FILE = path.join(TRADING_DIR, "index.ts");

const SPECIFIER_RE =
  /(?:from\s*|import\s*\(\s*|export\s+(?:\*|\{[^}]*\}|type\s*\{[^}]*\})\s*from\s*)["']([^"']+)["']/g;

function isTradingInternal(spec: string, importerFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  const resolved = path.normalize(path.join(path.dirname(importerFile), spec));
  if (!resolved.startsWith(TRADING_DIR + path.sep)) return null;
  // The boundary itself is allowed: ../trading -> src/trading/index.ts
  if (resolved === INDEX_FILE || resolved === TRADING_DIR) return null;
  return path.relative(SRC, resolved);
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* sourceFiles(full);
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".d.ts")
    ) {
      yield full;
    }
  }
}

describe("trading boundary (issue #290)", () => {
  it("no module outside src/trading imports a trading-internal path", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.startsWith(TRADING_DIR + path.sep)) continue; // trading-internal files may use relative paths
      const text = fs.readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      SPECIFIER_RE.lastIndex = 0;
      while ((m = SPECIFIER_RE.exec(text)) !== null) {
        const internal = isTradingInternal(m[1], file);
        if (internal) {
          violations.push(`${path.relative(SRC, file)} -> ${internal}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  // The index pulls the whole trading tree; allow a generous load budget so
  // this stays green on loaded CI runners instead of flaking on timeout.
  it("the boundary index re-exports the capabilities external code used", { timeout: 120_000 }, async () => {
    // Spot-check representative surface: if a binding below is missing from
    // the index, the import-path rewrite that used it was wrong.
    const index = (await import("../src/trading/index")) as Record<string, unknown>;
    for (const name of [
      "ETradeRestClient",
      "DynamicMarketScreener",
      "DynamicOptionsScreener",
      "runPanelPipelineRetired4068",
      "UnifiedOptionsService",
      "SqlScanRunStore",
      "SqlIvHistoryStore",
      "SqlStrategyProfileStore",
      "ETradeEmailTradingService",
      "ETradeSlackTradingService",
      "ETradeVoiceTradingService",
      "handleCloudflareEmailMessage",
      "handleVoiceWebSocketConnection",
      "verifySlackSignature",
      "fetchPlatformTechnicalsBatch",
      "resolveUniverse",
      "UNIVERSES",
      "DEFAULT_SCREENER_CONFIG",
      "defaultRegistry",
      "buildTypeRollup",
      "generateScreenerPdf",
      "screenerPdfFileName",
    ]) {
      expect(index[name], `index should export ${name}`).toBeDefined();
    }
  });

  it("MAX_SCAN_SYMBOLS is pinned to the options binding, not the screener one", { timeout: 120_000 }, async () => {
    const index = (await import("../src/trading/index")) as Record<string, unknown>;
    const optionsMod = (await import("../src/trading/options/opportunityScanner")) as Record<
      string,
      unknown
    >;
    expect(index["MAX_SCAN_SYMBOLS"]).toBe(optionsMod["MAX_SCAN_SYMBOLS"]);
  });
});
