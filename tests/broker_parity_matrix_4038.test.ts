/**
 * Issue #4038 / #4039 — the broker parity matrix is enforced, not aspirational.
 *
 * The table in docs/architecture/broker-parity-matrix.md is the single answer
 * to "does broker X support capability Y, and if not why not". This pin reads
 * it and compares it to the platform prototypes:
 *
 *  - every broker in BROKER_IDS has a column;
 *  - a `parity` cell must be a real method on that broker's platform;
 *  - an `impossible` cell must be ABSENT (a stub returning empty data is a lie);
 *  - an `impossible` cell must name its reason in parentheses;
 *  - data-plane rows are marked `—` and are not method-checked.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BROKER_IDS } from "../src/services/tenantProviders";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { PublicTradingPlatform } from "../src/trading/public/platform";

const DOC = join(__dirname, "..", "docs", "architecture", "broker-parity-matrix.md");

/** Capability row label -> platform method (absent for data-plane rows). */
const METHOD_BY_ROW: Record<string, string | null> = {
  "quotes": "getQuote",
  "options chains + expiries": "getOptionChains",
  "accounts": "getAccounts",
  "positions": "getPositions",
  "position lots": "getPositionLots",
  "order preview": "previewOrder",
  "order placement": "placeOrderRemote",
  "order cancel": "cancelOrderRemote",
  "order history / activity": "getOrderHistory",
  "watchlists": "getWatchlists",
  "session orders (pre/post/exto)": "supportsSessionOrders",
  "historical bars": null,
  "fundamentals": null,
};

const PLATFORMS: Record<string, unknown> = {
  etrade: ETradeTradingPlatform.prototype,
  alpaca: AlpacaTradingPlatform.prototype,
  public: PublicTradingPlatform.prototype,
};

function readMatrix(): { header: string[]; rows: Array<{ label: string; cells: string[] }> } {
  const lines = readFileSync(DOC, "utf8").split(/\r?\n/);
  const tableStart = lines.findIndex((line) => line.trim().startsWith("| Capability"));
  expect(tableStart).toBeGreaterThanOrEqual(0);
  const header = lines[tableStart]
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const rows: Array<{ label: string; cells: string[] }> = [];
  for (const line of lines.slice(tableStart + 2)) {
    if (!line.trim().startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    rows.push({ label: cells[0].toLowerCase(), cells: cells.slice(1) });
  }
  return { header, rows };
}

describe("Issue #4038 — broker parity matrix", () => {
  it("has a column for every broker, and a row for every mapped capability", () => {
    const { header, rows } = readMatrix();
    const columns = header.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
    for (const broker of BROKER_IDS) {
      expect(columns.some((column) => column.includes(broker)), broker).toBe(true);
    }
    for (const row of rows) {
      expect(row.cells.length, row.label).toBe(BROKER_IDS.length);
    }
    for (const label of Object.keys(METHOD_BY_ROW)) {
      expect(rows.some((row) => row.label === label), label).toBe(true);
    }
  });

  it("never claims parity for a method the platform does not implement", () => {
    const { rows } = readMatrix();
    const brokers = ["etrade", "alpaca", "public"];
    for (const row of rows) {
      const method = METHOD_BY_ROW[row.label];
      if (method === null || method === undefined) continue;
      row.cells.forEach((cell, index) => {
        const broker = brokers[index];
        const proto = PLATFORMS[broker] as Record<string, unknown>;
        const implemented = typeof proto[method] === "function";
        if (cell.startsWith("parity") || cell.startsWith("live-only")) {
          expect(implemented, `${broker}.${method} claimed ${cell}`).toBe(true);
        }
        if (cell.startsWith("impossible")) {
          expect(implemented, `${broker}.${method} claimed impossible but exists`).toBe(false);
        }
      });
    }
  });

  it("makes every impossible cell name its reason", () => {
    const { rows } = readMatrix();
    for (const row of rows) {
      for (const cell of row.cells) {
        if (!cell.startsWith("impossible")) continue;
        expect(cell, `${row.label}: ${cell}`).toMatch(/^impossible \(.+\)$/);
      }
    }
  });
});
