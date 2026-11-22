// @vitest-environment node
/**
 * Issue #6036 — one venue resolver for every OODA research dispatch.
 *
 * Pins the rule rather than a list: every catalogued broker × mode is
 * resolved from the catalogue's own `paperMode` flag, and every refusal
 * is coded and names the requested pair. The matrix is derived from
 * `ROUTED_BROKER_IDS`, so adding a broker cannot silently escape it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { brokerHasPaperMode, ROUTED_BROKER_IDS } from "../src/trading/brokerCatalog";
import { DEFAULT_TENANT_PROVIDERS } from "../src/data/commercialPorts";
import {
  isResearchVenueRefusal,
  normalizeResearchVenueMode,
  RESEARCH_VENUE_MODES,
  resolveResearchVenue,
  ResearchVenueRefusal,
} from "../src/services/researchVenue";

describe("#6036 venue resolution: mode is an enum, the pair is catalogued", () => {
  it("an unset selection inherits the tenant binding and says so", () => {
    const venue = resolveResearchVenue({});
    expect(venue.brokerId).toBe(DEFAULT_TENANT_PROVIDERS.brokerId);
    expect(venue.mode).toBe("paper");
    expect(venue.modeSource).toBe("inherited");
  });

  it("the mode is normalised (trim + lower-case) before it is accepted", () => {
    expect(normalizeResearchVenueMode(" Live ")).toBe("live");
    expect(normalizeResearchVenueMode("PAPER")).toBe("paper");
    expect(normalizeResearchVenueMode("prod")).toBeUndefined();
    expect(resolveResearchVenue({ mode: "LIVE" }).mode).toBe("live");
    expect(resolveResearchVenue({ mode: "LIVE" }).modeSource).toBe("explicit");
  });

  it("the accepted set is one exported constant", () => {
    expect([...RESEARCH_VENUE_MODES]).toEqual(["paper", "live"]);
  });

  it("a misspelt mode refuses by name, listing the accepted values", () => {
    for (const requested of ["prod", "Live!", "pa per"]) {
      try {
        resolveResearchVenue({ mode: requested });
        throw new Error(`expected a refusal for ${requested}`);
      } catch (error) {
        expect(isResearchVenueRefusal(error)).toBe(true);
        const refusal = error as ResearchVenueRefusal;
        expect(refusal.code).toBe("research_venue_mode_invalid");
        expect(refusal.message).toContain("paper, live");
        expect(refusal.requested.mode).toBe(requested);
      }
    }
  });

  it("the broker × mode matrix follows the catalogue's paperMode flag", () => {
    for (const brokerId of ROUTED_BROKER_IDS) {
      for (const requested of ["paper", "live", "Live", "prod"] as const) {
        const normalized = normalizeResearchVenueMode(requested);
        if (normalized === undefined) {
          expect(() => resolveResearchVenue({ brokerId, mode: requested })).toThrow(
            /research_venue_mode_invalid/,
          );
          continue;
        }
        if (normalized === "paper" && !brokerHasPaperMode(brokerId)) {
          expect(() => resolveResearchVenue({ brokerId, mode: requested })).toThrow(
            /research_venue_pair_unsupported/,
          );
          continue;
        }
        const venue = resolveResearchVenue({ brokerId, mode: requested });
        expect(venue.brokerId).toBe(brokerId);
        expect(venue.mode).toBe(normalized);
      }
    }
  });

  it("public + paper refuses naming paperMode: false", () => {
    try {
      resolveResearchVenue({ brokerId: "public", mode: "paper" });
      throw new Error("expected a pair refusal");
    } catch (error) {
      expect(isResearchVenueRefusal(error)).toBe(true);
      const refusal = error as ResearchVenueRefusal;
      expect(refusal.code).toBe("research_venue_pair_unsupported");
      expect(refusal.message).toContain("paperMode: false");
      expect(refusal.requested).toEqual({ brokerId: "public", mode: "paper" });
    }
    // The same broker accepts live — the refusal is about the pair, not the broker.
    expect(resolveResearchVenue({ brokerId: "public", mode: "live" })).toMatchObject({
      brokerId: "public",
      mode: "live",
    });
  });

  it("an unregistered broker refuses instead of falling back (#3460 preserved)", () => {
    expect(() => resolveResearchVenue({ brokerId: "not-a-broker" })).toThrow(
      /research_venue_broker_unknown/,
    );
  });
});

describe("#6036 every path goes through the resolver", () => {
  it("the provider executes the resolved venue — no inline paper default", () => {
    const source = readFileSync("src/services/researchProviders.ts", "utf8");
    expect(source).not.toContain('?? "paper"');
    expect(source).not.toContain('this.selection?.mode === "live"');
    expect(source).not.toContain('mode: this.selection?.mode ?? "paper"');
    expect(source).toContain("resolveResearchVenue(");
    expect(source).toContain("this.venue.mode");
  });

  it("the run route refuses before dispatch, with the coded 400", () => {
    const source = readFileSync("src/agents/routes/screenerResearch.ts", "utf8");
    const refusal = source.indexOf("isResearchVenueRefusal(error)");
    const dispatch = source.indexOf("dispatchResearchEngineRun({");
    expect(refusal).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(-1);
    // The refusal sits in the /research/run handler, before its dispatch.
    expect(refusal).toBeLessThan(dispatch);
    expect(source).toContain('status: 400');
    expect(source).toContain("resolveResearchVenue(");
  });
});
