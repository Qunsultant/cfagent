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
    expect(src).toContain('className="screener-criteria-presets-deck"');
    const deckIndex = src.indexOf('className="screener-criteria-presets-deck"');
    const presetIndex = src.indexOf("<ScreenerPresetManager", deckIndex);
    const criteriaIndex = src.indexOf("<StockCriteriaPanel", deckIndex);
    expect(presetIndex).toBeGreaterThan(deckIndex);
    expect(criteriaIndex).toBeGreaterThan(presetIndex);
  });

  it("RawContractsScreener wraps preset manager and options criteria panel in full-width deck", () => {
    const src = readFileSync(path.join(repoRoot, "src/client/options/RawContractsScreener.tsx"), "utf-8");
    expect(src).toContain('className="screener-criteria-presets-deck"');
    const deckIndex = src.indexOf('className="screener-criteria-presets-deck"');
    const presetIndex = src.indexOf("<ScreenerPresetManager", deckIndex);
    const criteriaIndex = src.indexOf("<OptionsCriteriaPanel", deckIndex);
    expect(presetIndex).toBeGreaterThan(deckIndex);
    expect(criteriaIndex).toBeGreaterThan(presetIndex);
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
    expect(src).toContain('className="preset-list-container"');
    expect(src).toContain('className="preset-list-item"');
    expect(src).toContain('className="preset-save-bar"');
  });

  it("StockCriteriaPanel applies active styling and primary variant to enabled criteria", () => {
    const src = readFileSync(path.join(repoRoot, "src/client/StockCriteriaPanel.tsx"), "utf-8");
    expect(src).toContain('stock-criteria-row${field.enabled ? " is-enabled" : ""}');
    expect(src).toContain('variant={field.enabled ? "primary" : "secondary"}');
  });

  it("ScreenerResultsView surfaces RegeneratePdfButton and off-market hours notice", () => {
    const src = readFileSync(path.join(repoRoot, "src/client/ScreenerResultsView.tsx"), "utf-8");
    expect(src).toContain("<RegeneratePdfButton");
    expect(src).toContain("Off-market hours (live feed closed)");
  });
});
