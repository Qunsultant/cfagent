import { describe, it, expect } from "vitest";
import {
  listStarterPresets,
  starterPresetById,
} from "../src/workflows/stockPresetCatalog";

describe("starter preset proposals #2886", () => {
  it("lists exactly the eight proposed starter names", () => {
    expect(listStarterPresets().map((s) => s.name)).toEqual([
      "Trend Breakout",
      "Pullback Reversion",
      "Momentum Leaders",
      "Oversold Bounce",
      "Volume Surge",
      "52-Week Strength",
      "Value Zone",
      "Squeeze Watch",
    ]);
  });

  it("every starter is labeled proposed — never finalized", () => {
    for (const starter of listStarterPresets()) {
      expect(starter.status).toBe("proposed");
    }
  });

  it("copyable starters carry real filter criteria", () => {
    expect(starterPresetById("starter-trend-breakout")?.criteria).toEqual({
      momentum: "bullish_breakout",
    });
    expect(starterPresetById("starter-pullback-reversion")?.criteria).toEqual({ maxRsi: 30 });
    expect(starterPresetById("starter-momentum-leaders")?.criteria).toEqual({
      momentum: "high_relative_volume",
      gainersOnly: true,
    });
    expect(starterPresetById("starter-oversold-bounce")?.criteria).toEqual({ rsiFilter: "oversold" });
    expect(starterPresetById("starter-volume-surge")?.criteria).toEqual({
      momentum: "high_relative_volume",
    });
    expect(starterPresetById("starter-squeeze-watch")?.criteria).toEqual({ requireSqueezeGate: true });
  });

  it("52-Week Strength and Value Zone honestly carry null criteria with a reason — no invented threshold", () => {
    for (const id of ["starter-52-week-strength", "starter-value-zone"]) {
      const starter = starterPresetById(id);
      expect(starter?.criteria).toBeNull();
      expect(starter?.reason).toBeTruthy();
    }
  });

  it("unknown ids resolve to undefined, never an invented starter", () => {
    expect(starterPresetById("no-such-starter")).toBeUndefined();
  });
});
