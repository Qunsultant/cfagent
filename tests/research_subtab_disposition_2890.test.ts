import { describe, it, expect } from "vitest";
import {
  RESEARCH_SUBTABS,
  researchSubtabById,
  screeningResearchSubtabs,
} from "../src/workflows/researchSubtabDisposition";

describe("research subtab dispositions #2890", () => {
  it("covers all 7 subtabs, each with a data path and a note", () => {
    expect(RESEARCH_SUBTABS.map((s) => s.id)).toEqual([
      "screener",
      "report",
      "quoting",
      "fundamentals",
      "bars",
      "snapshot",
      "compare",
    ]);
    for (const subtab of RESEARCH_SUBTABS) {
      expect(subtab.dataPath).toBeTruthy();
      expect(subtab.note).toBeTruthy();
    }
  });

  it("exactly one subtab screens, and it runs the canonical route", () => {
    const screening = screeningResearchSubtabs();
    expect(screening.map((s) => s.id)).toEqual(["screener"]);
    expect(screening[0].dataPath).toBe("GET /api/market-data/screen");
    expect(screening[0].canonical).toContain("stockScreenRunSpec");
    expect(screening[0].canonical).toContain("screenRunFinalize");
  });

  it("report is replayable research, not a forced screen", () => {
    const report = researchSubtabById("report");
    expect(report?.disposition).toBe("replayable-research");
    expect(report?.dataPath).toMatch(/\/api\/reports\/replay/);
  });

  it("quoting, fundamentals, bars, snapshot, compare are live views with no canonical screen components", () => {
    for (const id of ["quoting", "fundamentals", "bars", "snapshot", "compare"]) {
      const subtab = researchSubtabById(id);
      expect(subtab?.disposition).toBe("live-research-view");
      expect(subtab?.canonical).toEqual([]);
    }
  });

  it("dispositions are a closed set — no parallel-pipeline disposition exists", () => {
    for (const subtab of RESEARCH_SUBTABS) {
      expect(["canonical-screen", "replayable-research", "live-research-view"]).toContain(
        subtab.disposition,
      );
    }
  });

  it("unknown ids resolve to undefined, never an invented disposition", () => {
    expect(researchSubtabById("no-such-subtab")).toBeUndefined();
  });
});
