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
    // The presets tabpanel is the last tabpanel after the #3051
    // migration (the `options-assumptions` section that used to follow
    // it is gone), so the region runs to the end of the file. Anchor
    // on the onApplyPreset handler body: apply through
    // handleCriteriaChange, then navigate to new-screen.
    const region = src.slice(start);
    expect(region).toContain("<PresetsPanel");
    const handlerStart = region.indexOf("onApplyPreset={(criteria) => {");
    expect(handlerStart).toBeGreaterThan(-1);
    const applyIndex = region.indexOf("handleCriteriaChange(criteria);", handlerStart);
    const navigateIndex = region.indexOf('handleTabChange("new-screen");', applyIndex);
    expect(applyIndex).toBeGreaterThan(handlerStart);
    expect(navigateIndex).toBeGreaterThan(applyIndex);
  });
});
