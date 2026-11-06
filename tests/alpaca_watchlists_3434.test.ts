/**
 * Issue #3434 — Alpaca's own watchlists, through the neutral seam.
 *
 * What these tests defend:
 *   1. One Alpaca watchlist maps onto the neutral row without inventing a
 *      field: the id is the broker's, the symbols are upper-cased, and a row
 *      that cannot be read (no id, no symbols array) throws rather than
 *      becoming an empty list — "no symbols" and "no such list" differ.
 *   2. The capability declaration now matches reality: `watchlists` is true for
 *      Alpaca, so the panel renders data instead of a refusal.
 *   3. The neutral route exists and is gated by the same declaration as every
 *      other read.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapAlpacaWatchlist } from "../src/trading/alpaca/platform";
import { brokerSupports } from "../src/trading/brokerCatalog";
import { panelAvailability } from "../src/trading/brokerPanels";

const READS_SRC = readFileSync(join(__dirname, "../src/agents/routes/brokerReads.ts"), "utf8");

describe("mapAlpacaWatchlist (#3434)", () => {
  it("maps the broker's row onto the neutral shape", () => {
    const row = mapAlpacaWatchlist({
      id: "b6f2a1c4-0000-4000-8000-000000000001",
      name: "Momentum",
      symbols: ["nvda", " aapl ", "MSFT"],
      created_at: "2026-01-02T03:04:05Z",
      updated_at: "2026-02-03T04:05:06Z",
    });

    expect(row.watchlistId).toBe("b6f2a1c4-0000-4000-8000-000000000001");
    expect(row.name).toBe("Momentum");
    expect(row.symbols).toEqual(["NVDA", "AAPL", "MSFT"]);
    expect(row.source).toBe("alpaca_api");
    expect(row.createdTimestamp).toBe(Date.parse("2026-01-02T03:04:05Z"));
  });

  it("omits timestamps the broker did not send instead of writing a zero", () => {
    const row = mapAlpacaWatchlist({ id: "wl-1", name: "Empty", symbols: [] });
    expect(row.createdTimestamp).toBeUndefined();
    expect(row.updatedTimestamp).toBeUndefined();
  });

  it("falls back to the id as a name rather than rendering blank", () => {
    expect(mapAlpacaWatchlist({ id: "wl-2", symbols: ["SPY"] }).name).toBe("wl-2");
  });

  it("refuses a row it cannot read", () => {
    expect(() => mapAlpacaWatchlist({ name: "no id", symbols: [] })).toThrow(/without an id/);
    expect(() => mapAlpacaWatchlist({ id: "wl-3", name: "no symbols" })).toThrow(/symbols array/);
  });
});

describe("watchlists are declared for Alpaca (#3434)", () => {
  it("flips the capability the panel reads", () => {
    expect(brokerSupports("alpaca", "watchlists")).toBe(true);
    expect(panelAvailability("alpaca", "watchlists").available).toBe(true);
  });

  it("leaves alerts declared absent", () => {
    // Alpaca exposes no alerts API; the refusal stays and keeps naming the gap.
    expect(brokerSupports("alpaca", "alerts")).toBe(false);
    expect(panelAvailability("alpaca", "alerts").available).toBe(false);
  });
});

describe("the neutral read is wired (#3434)", () => {
  it("serves the path and gates it on the declared capability", () => {
    expect(READS_SRC).toContain('path.endsWith("/broker/watchlists")');
    expect(READS_SRC).toContain('brokerSupports(broker, "watchlists")');
    expect(READS_SRC).toContain("platform.getWatchlists()");
  });
});
