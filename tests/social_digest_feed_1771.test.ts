/**
 * #1771 slice D: social digest feed — RED pins (written before
 * the implementation; the first run must fail on the missing
 * src/orchestrations/socialDigestFeed.ts module).
 *
 * Pins: scoped resolution run > session > user > global env >
 * built-in "brief-only"; invalid winning value fails closed to
 * "brief-only" (never to digest); empty outcomes mint no brief;
 * digest briefs are provenance-marked and carry only outcome
 * content; staging NEVER overwrites an existing brief; staging
 * is disabled unless the resolved source is screener-digest.
 */
import { describe, expect, it } from "vitest";
import {
  buildDigestBrief,
  resolveSocialFeedSource,
  stageDigestBrief,
} from "../src/orchestrations/socialDigestFeed";

function memStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    async getBrief(date: string) {
      return m.get(date) ?? null;
    },
    async putBrief(date: string, text: string) {
      m.set(date, text);
    },
    read(date: string) {
      return m.get(date);
    },
  };
}

describe("social digest feed (#1771 slice D)", () => {
  it("resolves run > session > user > global env > built-in brief-only", () => {
    expect(resolveSocialFeedSource({})).toEqual({ source: "brief-only", level: "built-in", invalid: false });
    expect(resolveSocialFeedSource({ globalEnv: "screener-digest" }).source).toBe("screener-digest");
    expect(
      resolveSocialFeedSource({ globalEnv: "screener-digest", user: "brief-only" }).source,
    ).toBe("brief-only");
    expect(
      resolveSocialFeedSource({ globalEnv: "screener-digest", run: "brief-only" }).level,
    ).toBe("run");
  });

  it("an invalid winning value fails closed to brief-only, not to digest", () => {
    const r = resolveSocialFeedSource({ globalEnv: "nonsense" });
    expect(r).toEqual({ source: "brief-only", level: "globalEnv", invalid: true });
  });

  it("empty outcomes mint no brief; real outcomes are provenance-marked", () => {
    expect(buildDigestBrief({ date: "2026-11-02", kind: "stock" })).toBeNull();
    const b = buildDigestBrief({
      date: "2026-11-02", kind: "stock",
      symbols: ["AAA", "BBB"], headline: "Momentum screen", reportUrl: "https://example.invalid/r",
    })!;
    expect(b).toMatch(/auto-generated from screener digest/);
    expect(b).toMatch(/AAA, BBB/);
    expect(b).toMatch(/Momentum screen/);
  });

  it("staging never overwrites an existing brief and honors the switch", async () => {
    const store = memStore({ "2026-11-02": "Human brief for today" });
    const outcome = { date: "2026-11-02", kind: "stock", symbols: ["AAA"] };
    expect(await stageDigestBrief(store, outcome, "screener-digest")).toEqual({
      staged: false, reason: "human-brief-present",
    });
    expect(store.read("2026-11-02")).toBe("Human brief for today");

    const empty = memStore();
    expect(await stageDigestBrief(empty, outcome, "brief-only")).toEqual({
      staged: false, reason: "digest-disabled",
    });
    expect(await stageDigestBrief(empty, outcome, "screener-digest")).toEqual({ staged: true });
    expect(empty.read("2026-11-02")).toMatch(/auto-generated/);
  });
});
