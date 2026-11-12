/**
 * Issue #17 (portfolio context, opt-in): buildPortfolioFlags +
 * applyPortfolioContextRanking.
 *
 * - Thresholds come from CONCENTRATION_POLICY (5% material, 40%
 *   dominant sector) — the tests pin the policy values, not copies.
 * - Share basis is portfolio market value, stated in flag messages.
 * - Empty / zero-total / non-positive snapshots flag nothing.
 * - The partition is stable (relative order preserved in both groups),
 *   never mutates its input, and demotes only flagged symbols.
 * - Boundary values (exactly 5%, exactly 40%) flag (>=, not >).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildPortfolioFlags,
  applyPortfolioContextRanking,
  applyPortfolioContextToOpportunities,
} from "../src/services/portfolioContextRanking";
import { CONCENTRATION_POLICY } from "../src/services/portfolioConcentration";

const src = (rel: string) =>
  readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");

const pos = (symbol: string, marketValue: number | null) => ({
  symbol,
  marketValue,
});

describe("Issue #17 — buildPortfolioFlags", () => {
  it("pins the policy thresholds it reuses", () => {
    expect(CONCENTRATION_POLICY.materialSharePct).toBe(5);
    expect(CONCENTRATION_POLICY.dominantSectorSharePct).toBe(40);
  });

  it("flags a held name at or above the material share, and nothing below it", () => {
    const flags = buildPortfolioFlags([
      pos("NVDA", 6),
      pos("FAKE1", 47),
      pos("FAKE2", 47),
    ]);
    const nvda = flags.get("NVDA") ?? [];
    expect(nvda.some((f) => f.kind === "held-concentration")).toBe(true);
    expect(nvda.every((f) => f.kind !== "sector-concentration")).toBe(true);
    expect(nvda[0].message).toContain("market value");
    // FAKE names sit in the Unknown bucket (94%): sector-flagged, and
    // held-flagged too (47% each) — the Unknown bucket is not a haven.
    expect(flags.get("FAKE1")?.some((f) => f.kind === "sector-concentration")).toBe(true);
  });

  it("flags every name in a dominant sector, and boundary values flag", () => {
    const flags = buildPortfolioFlags([pos("NVDA", 40), pos("XXXX", 60)]);
    expect(flags.get("NVDA")?.some((f) => f.kind === "sector-concentration")).toBe(true);
    expect(flags.get("NVDA")?.some((f) => f.kind === "held-concentration")).toBe(true);
    // Exactly 5% held: flagged (>=, not >).
    const edge = buildPortfolioFlags([pos("NVDA", 5), pos("XXXX", 95)]);
    expect(edge.get("NVDA")?.some((f) => f.kind === "held-concentration")).toBe(true);
  });

  it("aggregates duplicate symbols and matches case-insensitively", () => {
    const flags = buildPortfolioFlags([
      pos("nvda", 3),
      pos("NVDA", 3),
      pos("XXXX", 94),
    ]);
    expect(flags.get("NVDA")?.some((f) => f.kind === "held-concentration")).toBe(true);
  });

  it("empty, zero-total, and non-positive snapshots flag nothing", () => {
    expect(buildPortfolioFlags([]).size).toBe(0);
    expect(buildPortfolioFlags([pos("NVDA", 0), pos("AAPL", null)]).size).toBe(0);
    expect(buildPortfolioFlags([pos("NVDA", -10)]).size).toBe(0);
  });
});

describe("Issue #17 — applyPortfolioContextRanking", () => {
  it("stably partitions flagged below unflagged and reports demoted symbols", () => {
    const ranked = [
      { symbol: "NVDA", score: 90 },
      { symbol: "AMZN", score: 85 },
      { symbol: "AAPL", score: 80 },
    ];
    const flags = buildPortfolioFlags([
      pos("NVDA", 60),
      pos("AAPL", 30),
      pos("XXXX", 10),
    ]);
    const { ranked: out, demoted } = applyPortfolioContextRanking(ranked, flags);
    expect(out.map((r) => r.symbol)).toEqual(["AMZN", "NVDA", "AAPL"]);
    expect(demoted).toEqual(["NVDA", "AAPL"]);
    // Input untouched.
    expect(ranked.map((r) => r.symbol)).toEqual(["NVDA", "AMZN", "AAPL"]);
  });

  it("an unflagged list passes through unchanged", () => {
    const ranked = [{ symbol: "AMZN" }, { symbol: "TSLA" }];
    const { ranked: out, demoted } = applyPortfolioContextRanking(
      ranked,
      new Map()
    );
    expect(out).toEqual(ranked);
    expect(demoted).toEqual([]);
  });
});

describe("Issue #17 — applyPortfolioContextToOpportunities (run-hook seam)", () => {
  const ranked = [{ symbol: "NVDA" }, { symbol: "AMZN" }, { symbol: "AAPL" }];

  it("applies the partition and names demoted names + reasons in the marker", () => {
    const { ranked: out, marker } = applyPortfolioContextToOpportunities(
      ranked,
      {
        ok: true,
        accountId: "et_live_1",
        positions: [pos("NVDA", 60), pos("AAPL", 30), pos("XXXX", 10)],
      }
    );
    expect(out.map((r) => r.symbol)).toEqual(["AMZN", "NVDA", "AAPL"]);
    expect(marker.applied).toBe(true);
    expect(marker.demoted).toEqual(["NVDA", "AAPL"]);
    expect(marker.accountId).toBe("et_live_1");
    expect(marker.notes?.length).toBeGreaterThan(0);
    expect(marker.notes?.every((n) => n.includes("market value"))).toBe(true);
  });

  it("a connected book with no flagged opportunity still reports applied", () => {
    const { ranked: out, marker } = applyPortfolioContextToOpportunities(
      ranked,
      { ok: true, accountId: "et_live_1", positions: [pos("XXXX", 100)] }
    );
    expect(out).toEqual(ranked);
    expect(marker.applied).toBe(true);
    expect(marker.demoted).toEqual([]);
  });

  it("an unconnected account never ranks on session/paper positions", () => {
    const { ranked: out, marker } = applyPortfolioContextToOpportunities(
      ranked,
      { ok: true, accountId: "unconnected", positions: [pos("NVDA", 100)] }
    );
    expect(out).toEqual(ranked);
    expect(marker).toEqual({
      applied: false,
      reason: "account-unconnected",
      accountId: "unconnected",
    });
  });

  it("an empty book and a fetch failure degrade with distinct reasons", () => {
    const empty = applyPortfolioContextToOpportunities(ranked, {
      ok: true,
      accountId: "et_live_1",
      positions: [],
    });
    expect(empty.marker.reason).toBe("no-positions");
    expect(empty.ranked).toEqual(ranked);
    const failed = applyPortfolioContextToOpportunities(ranked, {
      ok: false,
      reason: "positions-unavailable",
    });
    expect(failed.marker.reason).toBe("positions-unavailable");
    expect(failed.ranked).toEqual(ranked);
  });
});

describe("Issue #17 — wiring pins (run hook + flag plumbing)", () => {
  it("the screen agent hooks the modifier behind the request flag", () => {
    const agent = src("agents/screener-agent.ts");
    expect(agent).toContain("req.portfolioContext === true");
    expect(agent).toContain("applyPortfolioContextToOpportunities(");
    expect(agent).toContain("fetchPortfolioRemote(");
    expect(agent).toContain("portfolioContext ? { portfolioContext } : {}");
  });

  it("the manual route reads the flag and passes it to both run paths", () => {
    const route = src("agents/routes/etradeBrokerScreen.ts");
    expect(route).toContain("isPortfolioContextEnabled(ctx.readSettingRaw)");
    // Issue #4278: both run paths (sync + sharded) now go through the
    // one engine seam call, which carries environment + portfolioContext.
    expect(route).toContain("environment: requestedEnv,\n      portfolioContext,");
  });

  it("the scheduled service reads the flag at run time and passes it to the monolithic run", () => {
    const svc = src("services/scheduledTasks.ts");
    expect(svc).toContain("isPortfolioContextEnabled(settingReadFromSql(");
    expect(svc).toContain("environment: options.environment,\n        portfolioContext,");
  });
});
