import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("Universal Modal System & Diagnostics Token Architecture", () => {
  const tokensCss = fs.readFileSync(path.resolve("src/client/tokens.css"), "utf8");
  const stylesCss = fs.readFileSync(path.resolve("src/client/styles.css"), "utf8");
  const tradingHub = fs.readFileSync(path.resolve("src/client/ETradeTradingHub.tsx"), "utf8");

  describe("Universal Modal System in tokens.css", () => {
    it("defines universal modal card containers using design tokens", () => {
      expect(tokensCss).toContain(".modal-dialog");
      expect(tokensCss).toContain(".etrade-pin-modal");
      expect(tokensCss).toContain(".diagnostics-modal");
      expect(tokensCss).toContain(".quote-modal-content");
      expect(tokensCss).toContain("var(--color-surface-raised");
      expect(tokensCss).toContain("var(--color-border-medium)");
      expect(tokensCss).toContain("var(--color-text-primary)");
    });

    it("eliminates brittle modal light theme overrides in favor of semantic token resolution", () => {
      expect(tokensCss).not.toContain('[data-theme="light"] .etrade-pin-modal');
      expect(tokensCss).not.toContain('[data-theme="light"] .diagnostics-modal');
      expect(tokensCss).not.toContain('[data-theme="light"] .quote-modal-content');
    });

    it("tokenizes modal headers and close/cancel buttons using semantic tokens", () => {
      expect(tokensCss).toContain(".modal-header");
      expect(tokensCss).toContain(".btn-close-modal");
      expect(tokensCss).toContain(".btn-cancel-modal");
      expect(tokensCss).toContain("var(--color-surface-sunken)");
      expect(tokensCss).toContain("var(--color-surface-hover)");
    });

    it("tokenizes E*TRADE OAuth PIN modal instructions with semantic tokens", () => {
      expect(tokensCss).toContain(".etrade-pin-modal .step-instruction");
      expect(tokensCss).toContain("var(--color-text-secondary)");
    });
  });

  describe("E*TRADE Live REST Diagnostics Modal Token Alignment", () => {
    it("defines semantic tokens for diagnostic credentials cards", () => {
      expect(tokensCss).toContain(".diagnostics-modal .diag-card");
      expect(tokensCss).toContain(".diagnostics-modal .diag-label");
      expect(tokensCss).toContain(".diagnostics-modal .diag-val");
      expect(tokensCss).toContain("var(--color-surface-sunken)");
      expect(tokensCss).toContain("var(--color-text-muted)");
      expect(tokensCss).toContain("var(--color-text-primary)");
    });

    it("styles diagnostic error banners and technical drawer with semantic tokens", () => {
      expect(tokensCss).toContain(".diagnostics-modal .diag-error-box");
      expect(tokensCss).toContain(".diagnostics-modal .diagnostics-drawer");
      expect(tokensCss).toContain(".diagnostics-modal details.diag-raw-box");
      expect(tokensCss).toContain("var(--color-danger-subtle)");
      expect(tokensCss).toContain("var(--color-border-subtle)");
    });

    it("provides semantic tokens for status pills and action buttons", () => {
      expect(tokensCss).toContain(".diagnostics-modal .status-pill");
      expect(tokensCss).toContain(".diagnostics-modal .status-healthy");
      expect(tokensCss).toContain(".diagnostics-modal .status-error");
      expect(tokensCss).toContain(".diagnostics-modal .diag-modal-actions");
      expect(tokensCss).toContain("var(--color-success-subtle)");
      expect(tokensCss).toContain("var(--color-danger-subtle)");
    });
  });

  describe("styles.css Deference to Design Tokens", () => {
    it("does not hardcode dark background on .etrade-pin-modal", () => {
      const pinModalMatch = stylesCss.match(/\.etrade-pin-modal\s*\{([^}]+)\}/);
      expect(pinModalMatch).not.toBeNull();
      const pinModalBody = pinModalMatch![1];
      expect(pinModalBody).not.toContain("background: #0f172a;");
      expect(pinModalBody).toContain("var(--color-surface-raised");
    });

    it("does not apply hardcoded white card override to .diagnostics-drawer inside styles.css", () => {
      const drawerOverride = stylesCss.match(/\[data-theme="light"\]\s*\.diagnostics-drawer/);
      expect(drawerOverride).toBeNull();
    });
  });

  describe("ETradeTradingHub.tsx JSX Token Architecture", () => {
    it("uses semantic diagnostic classes rather than ad-hoc inline styles", () => {
      // S-U2 (#3051): the diagnostics modal no longer renders bespoke
      // diag-* source classes — it renders via the token-styled
      // primitives (Flex/Grid/Card/Badge/Notice). The intent is
      // unchanged: diagnostics use semantic tokens/classes, not
      // ad-hoc inline styles — so assert that against the new
      // primitives rendering, scoped to the modal's source section.
      const diagStart = tradingHub.indexOf("Live REST Diagnostics Modal");
      expect(diagStart).toBeGreaterThan(-1);
      const diagEnd = tradingHub.indexOf("Alpaca Broker Connection", diagStart);
      expect(diagEnd).toBeGreaterThan(diagStart);
      const diagModal = tradingHub.slice(diagStart, diagEnd);
      // Status pill is a semantic Badge whose tone derives from the
      // diagnostic status (success / warning / danger).
      expect(diagModal).toContain("<Badge tone={diagnostics.status");
      // Credential fields render as token-styled Cards in a Grid.
      expect(diagModal).toContain("<Grid autoFit");
      expect(diagModal).toContain('<Card padding="sm">');
      // The upstream-error banner is a semantic danger Notice.
      expect(diagModal).toContain('<Notice tone="danger">');
      // The raw-payload and technical drawers are native <details>.
      expect(diagModal.match(/<details>/g)?.length).toBe(2);
      // The modal's actions lay out via Flex.
      expect(diagModal).toContain('<Flex gap="2" align="center">');
      // And no ad-hoc styling survives in the modal: no inline
      // style props and no bespoke diag-* classes.
      expect(diagModal).not.toContain("style={{");
      expect(diagModal).not.toContain('className="diag-');
    });
  });

  describe("Strategy Discovery & Payoff Analyzer Top Buttons Token Architecture", () => {
    const stratCss = fs.readFileSync(path.resolve("src/client/options/strategyDiscovery.css"), "utf8");

    it("standardizes top button heights, typography, and border radius across both rows", () => {
      expect(tokensCss).toContain(".strat-view-tab-btn");
      expect(tokensCss).toContain(".strat-action-chip");
      expect(tokensCss).toContain(".strat-btn-action");
      expect(tokensCss).toContain(".options-download-main-btn");
      expect(tokensCss).toContain("height: 32px");
      expect(tokensCss).toContain("min-height: 32px");
      expect(tokensCss).toContain("border-radius: var(--radius-sm, 6px)");
    });

    it("ensures the trade button has high-contrast prominence", () => {
      expect(tokensCss).toContain(".strat-action-chip.trade-fast");
      expect(tokensCss).toContain("linear-gradient(135deg, #ea580c 0%, #c2410c 100%)");
    });

    it("eliminates brittle overrides in strategyDiscovery.css in favor of native tokens", () => {
      expect(stratCss).not.toContain('[data-theme="light"] .strat-view-tabs');
      expect(stratCss).not.toContain('[data-theme="light"] .strat-action-chip.highlight');
      expect(stratCss).not.toContain('[data-theme="light"] .strat-btn-action.eval-llm');
    });

    it("structures Optimization Bias on top and percentages below it adjacent to sentiment icons", () => {
      const panelTsx = fs.readFileSync(path.resolve("src/client/options/StrategyDiscoveryPanel.tsx"), "utf8");
      expect(panelTsx).toContain('className="strat-discovery-controls-row"');
      expect(panelTsx).toContain('className="strat-opt-deck-top"');
      expect(panelTsx).toContain('className="strat-opt-deck-bottom strat-opt-adjacent-factors"');
      expect(stratCss).toContain(".strat-opt-adjacent-deck");
      expect(stratCss).toContain("flex-direction: column");
      expect(stratCss).toContain(".strat-opt-deck-top");
      expect(stratCss).toContain(".strat-opt-deck-bottom");
    });
  });
});
