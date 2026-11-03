/**
 * Issue #2860 (audit F3) — the presets tab Apply was
 * navigate-only.
 *
 * The audit found the presets tab Apply navigate-only:
 * StockHub wired the presets tab's onApplyPreset to a
 * bare tab change, dropping the criteria the panel
 * passes up — Apply landed on New Screen with whatever
 * draft criteria were there, the same shape as the old
 * patterns bug (audit F1, fixed by G2 #2909). The
 * new-screen deck (line ~933) already applied via
 * handleCriteriaChange, and scheduled runs already
 * resolve presets at run time (resolvePresetFilter in
 * scheduledTasks) — only the presets tab boundary
 * dropped the criteria.
 *
 * Pins (same source-pin style as the #2896 pin in
 * screener_preset_manager.test.tsx):
 *  - no navigate-only onApplyPreset remains anywhere in
 *    StockHub;
 *  - the presets tabpanel region applies through
 *    handleCriteriaChange (which sets the criteria and
 *    clears any applied pattern, so a preset-applied run
 *    is never misreported as a pattern run) before
 *    navigating to new-screen.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("presets tab Apply (#2860 F3)", () => {
  it("StockHub has no navigate-only onApplyPreset", () => {
    const src = readFileSync("src/client/StockHub.tsx", "utf8");
    expect(src).not.toContain('onApplyPreset={() => handleTabChange("new-screen")}');
  });

  it("the presets tabpanel applies criteria through handleCriteriaChange, then navigates", () => {
    const src = readFileSync("src/client/StockHub.tsx", "utf8");
    const start = src.indexOf("screener-tabpanel-presets");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("options-assumptions", start);
    expect(end).toBeGreaterThan(start);
    const region = src.slice(start, end);
    expect(region).toContain("PresetsPanel");
    expect(region).toContain("handleCriteriaChange");
    expect(region).toContain('handleTabChange("new-screen")');
  });
});
