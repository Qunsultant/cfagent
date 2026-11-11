import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

describe("Issue #1793 — Screener Presets Layout and Report Persistence", () => {
  it("persistRun generates the full document set via the one generation module before writing to DO storage (keys preserved)", () => {
    const src = readFileSync(path.join(repoRoot, "src/agents/screener-agent.ts"), "utf-8");
    const start = src.indexOf("private async persistRun");
    expect(start).toBeGreaterThan(-1);
    const persistRun = src.slice(start, start + 3000);

    // Issue #2911 (G4): PDF still flows through generateRunPdf (shared
    // with regeneration) and the tabular legs through the one
    // generation module — both MUST occur before saving to DO storage.
    const pdfIndex = persistRun.indexOf("this.generateRunPdf");
    const moduleIndex = persistRun.indexOf("generateStockReportArtifacts");
    const storagePutLatest = persistRun.indexOf("this.ctx.storage.put(LATEST_KEY");
    const storagePutHistory = persistRun.indexOf("HISTORY_KEY", storagePutLatest);

    expect(pdfIndex).toBeGreaterThan(-1);
    expect(moduleIndex).toBeGreaterThan(-1);
    expect(storagePutLatest).toBeGreaterThan(-1);
    expect(storagePutHistory).toBeGreaterThan(-1);

    expect(pdfIndex).toBeLessThan(storagePutLatest);
    expect(moduleIndex).toBeLessThan(storagePutLatest);
    expect(storagePutLatest).toBeLessThan(storagePutHistory);
  });

  it("StockHub wraps preset manager and criteria panel in full-width responsive deck (#2896)", () => {
    const src = readFileSync(path.join(repoRoot, "src/client/StockHub.tsx"), "utf-8");
    // The bespoke `screener-criteria-presets-deck` div is a responsive
    // Grid after the #3051 primitives migration (autofit-lg is
    // minmax(360px, 1fr), the old deck's grid); the preset manager and
    // criteria panel still sit inside one deck, preset first.
    const presetIndex = src.indexOf("<ScreenerPresetManager");
    expect(presetIndex).toBeGreaterThan(-1);
    const deckIndex = src.lastIndexOf('<Grid autoFit minColumnWidth="lg" gap="2">', presetIndex);
    expect(deckIndex).toBeGreaterThan(-1);
    expect(deckIndex).toBeLessThan(presetIndex);
    const criteriaIndex = src.indexOf("<StockCriteriaPanel", presetIndex);
    expect(criteriaIndex).toBeGreaterThan(presetIndex);
    const deckClose = src.indexOf("</Grid>", criteriaIndex);
    expect(deckClose).toBeGreaterThan(criteriaIndex);
  });

  it("RawContractsScreener wraps preset manager and options criteria panel in full-width deck", () => {
    const src = readFileSync(path.join(repoRoot, "src/client/options/RawContractsScreener.tsx"), "utf-8");
    // Same responsive-Grid deck as StockHub after #3051 (a bare <div>
    // here would stack the panels; the deck keeps them side-by-side).
    const presetIndex = src.indexOf("<ScreenerPresetManager");
    expect(presetIndex).toBeGreaterThan(-1);
    const deckIndex = src.lastIndexOf('<Grid autoFit minColumnWidth="lg" gap="2">', presetIndex);
    expect(deckIndex).toBeGreaterThan(-1);
    expect(deckIndex).toBeLessThan(presetIndex);
    const criteriaIndex = src.indexOf("<OptionsCriteriaPanel", presetIndex);
    expect(criteriaIndex).toBeGreaterThan(presetIndex);
    const deckClose = src.indexOf("</Grid>", criteriaIndex);
    expect(deckClose).toBeGreaterThan(criteriaIndex);
  });

  it("StockHub manualResult retains full report and quote trace metadata (#2896)", () => {
    const src = readFileSync(path.join(repoRoot, "src/client/StockHub.tsx"), "utf-8");
    expect(src).toContain("pdfStatus: (data as any).pdfStatus");
    expect(src).toContain("pdfError: (data as any).pdfError");
    expect(src).toContain("xlsxKey: (data as any).xlsxKey");
    expect(src).toContain("xlsxUrl: (data as any).xlsxUrl");
    expect(src).toContain("quoteTrace: (data as any).quoteTrace");
    expect(src).toContain("void loadAuto()");
  });

  it("ScreenerPresetManager renders modern preset list and inline save bar", () => {
    const src = readFileSync(path.join(repoRoot, "src/client/ScreenerPresetManager.tsx"), "utf-8");
    // The bespoke `preset-list-container` / `preset-list-item` /
    // `preset-save-bar` classes are gone after the #3051 primitives
    // migration: the list is a Stack of per-preset Cards, the save bar
    // a Flex with the name input and Save preset button.
    const listIndex = src.indexOf('<Stack gap="2">');
    expect(listIndex).toBeGreaterThan(-1);
    expect(src.indexOf("visible.map((preset) => (", listIndex)).toBeGreaterThan(listIndex);
    expect(src.indexOf('<Card key={preset.id} padding="sm">', listIndex)).toBeGreaterThan(listIndex);
    const saveIndex = src.indexOf('<Flex gap="2" align="end">', listIndex);
    expect(saveIndex).toBeGreaterThan(listIndex);
    expect(src.indexOf('id="preset-manager-name"', saveIndex)).toBeGreaterThan(saveIndex);
    expect(src.indexOf("Save preset", saveIndex)).toBeGreaterThan(saveIndex);
  });

  it("StockCriteriaPanel applies active styling and primary variant to enabled criteria", () => {
    const src = readFileSync(path.join(repoRoot, "src/client/StockCriteriaPanel.tsx"), "utf-8");
    // The bespoke `stock-criteria-row … is-enabled` class is gone after
    // the #3051 primitives migration; rows are Flex rows whose toggle
    // Button carries the enabled treatment — primary variant and
    // aria-pressed — so enabled criteria still read as active.
    expect(src).toContain('<Flex gap="2" align="center" key={key}>');
    expect(src).toContain('variant={field.enabled ? "primary" : "secondary"}');
    expect(src).toContain("aria-pressed={field.enabled}");
  });

  it("ScreenerResultsView surfaces RegeneratePdfButton and off-market hours notice", () => {
    const src = readFileSync(path.join(repoRoot, "src/client/ScreenerResultsView.tsx"), "utf-8");
    expect(src).toContain("<RegeneratePdfButton");
    expect(src).toContain("Off-market hours (live feed closed)");
  });
});
