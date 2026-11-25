// @vitest-environment node
/**
 * Issue #6508 — broker-neutral names for generic code.
 *
 * The census is deliberately narrow and shrink-only:
 * - it scans generic source modules for lowercase-t `Etrade*` identifiers
 *   (the spelling that names the E*TRADE broker, not the platform's
 *   `ETrade*` service prefix);
 * - every survivor is listed below with its class and cannot grow;
 * - a symbol that disappears from the tree must be removed from the list,
 *   so the allowlist only shrinks.
 *
 * The first slice renamed `EtradeResearchDataProvider` to
 * `PlatformResearchDataProvider`; its allowlist row is gone.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(__dirname, "../src");

/** Paths (relative to src, normalized to "/") where an E*TRADE name is by design. */
const BROKER_SCOPED = [
  /^trading\/etrade\//,
  /^agents\/routes\/etrade[^/]*\.ts$/,
  /^mcps\/openaimp\/etrade[^/]*\.ts$/,
  /^config\/etradeModes\.ts$/,
  /^services\/etrade[^/]*\.ts$/,
  /^security\/etradeOAuth\.ts$/,
  /^data\/tokenPorts\.ts$/,
];

/**
 * Sanctioned survivors. `broker-specific` is the E*TRADE adapter surface.
 * Rows are removed as renames land — never added.
 */
const ALLOWLIST: Record<string, "broker-specific" | "generic-deferred"> = {
  EtradeBrokerRouteContext: "broker-specific",
  EtradeOptionsRouteContext: "broker-specific",
  EtradeScopedModes: "broker-specific",
  EtradeTokenCallOptions: "broker-specific",
  EtradeTokenPort: "broker-specific",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("broker-named identifier census (issue 6508)", () => {
  const observed = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const relative = path.relative(SRC, file).split(path.sep).join("/");
    if (BROKER_SCOPED.some((pattern) => pattern.test(relative))) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bEtrade[A-Z][A-Za-z0-9_]*/g)) {
      const symbol = match[0];
      const files = observed.get(symbol) ?? [];
      if (!files.includes(relative)) files.push(relative);
      observed.set(symbol, files);
    }
  }

  it("P01: no unlisted broker-named generic identifier", () => {
    const unlisted = [...observed.keys()].filter((symbol) => !(symbol in ALLOWLIST));
    expect(
      unlisted.map((symbol) => `${symbol} → ${observed.get(symbol)!.join(", ")}`),
    ).toEqual([]);
  });

  it("P02: the allowlist only shrinks", () => {
    const stale = Object.keys(ALLOWLIST).filter((symbol) => !observed.has(symbol));
    expect(stale).toEqual([]);
  });

  it("P03: the provider uses the broker-neutral name", () => {
    const provider = fs.readFileSync(path.join(SRC, "services/researchProviders.ts"), "utf8");
    expect(provider).toContain("export class PlatformResearchDataProvider");
    expect(provider).not.toContain("EtradeResearchDataProvider");
  });
});
