/**
 * Query-param router contract (#1804 S1, issue #1808; param scoping #3238):
 * the tab lives in `?tab=<id>`, unknown ids fall back to autopilot, and a
 * URL carries only its own page's params — when the tab changes, params
 * the destination does not own are dropped. Pure functions only — no
 * window needed.
 */
import { describe, it, expect } from "vitest";
import { parseTabFromSearch, buildSearchWithTab } from "../src/client/router";

describe("router query params", () => {
  it("reads the tab from ?tab=", () => {
    expect(parseTabFromSearch("?tab=social")).toBe("social");
    expect(parseTabFromSearch("?tab=scanner")).toBe("scanner");
    expect(parseTabFromSearch("?tab=orders")).toBe("orders");
  });

  it("falls back to autopilot for unknown or missing tabs", () => {
    expect(parseTabFromSearch("?tab=bogus")).toBe("autopilot");
    expect(parseTabFromSearch("")).toBe("autopilot");
    expect(parseTabFromSearch("?screenerTab=scanner")).toBe("autopilot");
  });

  it("sets ?tab= while keeping only the destination's own params (#3238)", () => {
    expect(buildSearchWithTab("", "social")).toBe("?tab=social");
    expect(buildSearchWithTab("?screenerTab=scanner", "screeners")).toBe("?screenerTab=scanner&tab=screeners");
    // The old #1804 preserve-everything behavior was the leak: a
    // screener param followed the user to an unrelated page.
    expect(buildSearchWithTab("?tab=autopilot&screenerTab=scanner", "social")).toBe(
      "?tab=social",
    );
  });
});
