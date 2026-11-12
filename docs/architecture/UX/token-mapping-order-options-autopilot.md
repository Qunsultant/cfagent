# Token mapping — order / options / autopilot legacy classes

Part of #2150 (template program), slice #3135 — token-tier discipline for template surfaces (Phase 1).

## What this is

Every legacy class the order / options / autopilot layouts use, mapped to its token or to a deletion candidate with a successor. **Deletion candidates are NOT deleted in this slice** (the no-deletion gate, gitops §22): deprecate with a successor, never silently — removal is owned by the S-U7 deprecation process. Nothing in this table changes any rendered page.

## Method

- **Scope:** `OrderTicketPanel.tsx`, `ETradeTradingHub.tsx`, `components/AutopilotControlCenter.tsx`, all `Options*.tsx`, all of `src/client/options/**`, and `chat/OptionsStrategyCard.tsx` — 29 files.
- **Extraction:** `className` attributes (quoted strings and `{...}` expressions); `${...}` interpolations stripped from literal parts; lowercase string literals harvested as state classes (`"active"`, `"selected"`) — except comparison operands (`"x" ===`, `=== "x"`, `.includes("x")`), which are data values, not classes.
- **Verification:** each used class was checked against the class selectors defined in the 9 stylesheets these layouts load (`styles.css`, `primitives.css`, `strategyDiscovery.css`, `riskAnalysis.css`, `optionsFlows.css`, `optionsResearch.css`, `optionsCard.css`, `scheduledOptions.css`, `optionsResearch.css`). 607 of 647 have a rule; 40 are referenced but defined nowhere (dead classes, listed with their own successor).
- **Coverage pin:** `tests/template_token_tiers_3135.test.ts` re-extracts the used set and asserts every class appears in this document and the total is 647. Add a class to a layout and the pin fails until this table gains its row.

## Correction to the brief

The #3135 discussion brief said "the three layouts reference hundreds of literal class tokens". Measured: the three layout files themselves reference almost none — OrderTicketPanel 2, ETradeTradingHub 5, AutopilotControlCenter 6 distinct tokens. They build from primitives; the hundreds of legacy classes live in the options subtree they render (StrategyDiscoveryPanel alone: 327). This table covers the layouts **and their rendered subtree**, which is where the classes actually are.

## Summary

- **647** legacy classes used by the layouts in scope.
- **109 Token** — map to a primitive that already exists (7 of them are `ui-*` classes, already tokens).
- **538 Deletion candidate** — no token equivalent yet; successor is "none yet" (S-U7) except 40 dead classes whose successor is deletion itself (no rule exists, so removing the reference changes nothing).
- **0 deletions in this slice.**

Disposition rules, in order: `ui-*` → itself; `*-card-header` → CardHeader; `*-btn` / `*-button` → Button; `*-badge` / `*-pill` → Badge; `*-modal` → Modal; `*-tabs` / `*-tab` → Tabs; `*-input` / `*-select` → TextInput / Select; `*-notice` / `*-banner` / `*-alert` → Notice; `*-table` → Table; `*-card` → Card family (WorkCard / DetailCard); bare state words (`active`, `selected`, …) → primitive prop/state on migration; everything else → deletion candidate, successor none yet.

## Tables

One table per class family (first `-`-segment). `Used by` names the files that reference the class.

### `strat` — 278 classes (54 Token, 224 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `strat-action-chip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-add-leg-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-add-leg-btns` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-btn-action` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-builder-action-btns` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-builder-exp-bar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-builder-exp-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-builder-header-bar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-builder-title-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-builder-view` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-card` | Token | Card family — WorkCard / DetailCard (#3133) | StrategyDiscoveryPanel.tsx |
| `strat-card-actions-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-card-header-left` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-card-icon-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-card-name` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-card-stat-left` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-card-stat-right` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-card-stats-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-card-subtitle` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-card-theses` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-card-title-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-cards-grid` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-cat-pill` | Token | Badge primitive | StrategyLibraryModal.tsx |
| `strat-change-pill` | Token | Badge primitive | StrategyDiscoveryPanel.tsx |
| `strat-change-strat-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-chart-unified-footer-bar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-chip-day` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-chip-month` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-closed-tag` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-compare-actions` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-compare-banner` | Token | Notice primitive | StrategyDiscoveryPanel.tsx |
| `strat-compare-hint` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-compare-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-compare-revert-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-compare-toggle-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-cost-display-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-cost-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-cost-reset-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-cost-save-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-currency-prefix` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-custom-cost-badge` | Token | Badge primitive | StrategyDiscoveryPanel.tsx |
| `strat-date-range-slider` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-delayed-tag` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-discovery-card` | Token | Card family — WorkCard / DetailCard (#3133) | StrategyDiscoveryPanel.tsx |
| `strat-discovery-container` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-discovery-controls-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-discovery-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-discovery-message` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-discovery-top-bar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-discovery-view` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-drawer-close` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-drawer-content` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-drawer-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-drawer-section` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-dropdown-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-dropdown-item` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-dropdown-list` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-dropdown-name` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-dropdown-pill` | Token | Badge primitive | StrategyDiscoveryPanel.tsx |
| `strat-dropdown-price` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-dropdown-price-col` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-dropdown-search-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-dropdown-sym` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-dropdown-sym-col` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-exp-chip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-exp-chips-scroll` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-exp-chips-scroll-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-factor-chip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-flow-alert-banner` | Token | Notice primitive | StrategyDiscoveryPanel.tsx |
| `strat-flow-alert-close` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-flow-alert-content` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-flow-alert-subtitle` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-flow-alert-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-flow-back-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-footer-date-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-footer-iv-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-footer-mode-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-footer-slider-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-footer-sub-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-footer-tools-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-full-graph-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-greek-chip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-greek-sub` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-history-note` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-history-stats-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-hstat-cell` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-icon` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-icon-tooltip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-implied-move-info` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-implied-pct` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-implied-val` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-info-icon` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-inline-edit-cost` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-input-pill` | Token | Badge primitive | StrategyDiscoveryPanel.tsx |
| `strat-iv-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-iv-presets` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-act-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-leg-actions-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-body-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-btn-pair` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-card` | Token | Card family — WorkCard / DetailCard (#3133) | StrategyDiscoveryPanel.tsx |
| `strat-leg-cost-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-greeks-strip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-header-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-qty` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-side-qty` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-slider-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-strike-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-strike-range` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-strike-sliders-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-strike-sliders-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-leg-warnings-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-legs-grid` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-legs-hint` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-legs-title-text` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-lib-card-name` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-lib-card-name-group` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyLibraryModal.tsx |
| `strat-lib-card-sub` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-lib-card-top` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-lib-desc` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-lib-footer` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-lib-legs-tag` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-lib-risk-badge` | Token | Badge primitive | StrategyLibraryModal.tsx |
| `strat-lib-select-btn` | Token | Button primitive | StrategyLibraryModal.tsx |
| `strat-lib-svg-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-lib-thumbnail-svg` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-library-card` | Token | Card family — WorkCard / DetailCard (#3133) | StrategyLibraryModal.tsx |
| `strat-library-categories` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-library-directions` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-library-grid` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-library-search` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-library-toolbar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-matrix-legend` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-matrix-scroll-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-matrix-table` | Token | Table primitive | StrategyDiscoveryPanel.tsx |
| `strat-matrix-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-matrix-toolbar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-metric-cell` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-metric-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-metric-val` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-metrics-strip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-mini-refresh-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-modal-close-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx, StrategyLibraryModal.tsx |
| `strat-modal-footer` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-modal-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx, StrategyLibraryModal.tsx |
| `strat-modal-header-titles` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-modal-sub` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-no-saved-trades` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-opt-adjacent-deck` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-opt-adjacent-factors` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-opt-adjacent-meta` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-opt-adjacent-slider-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-opt-bound` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-opt-deck-bottom` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-opt-deck-top` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-opt-regime-badge` | Token | Badge primitive | StrategyDiscoveryPanel.tsx |
| `strat-opt-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-payoff-sentiments` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-pct-tag` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-pill-caption` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-pill-icon` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-pos-item` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-positions-drawer` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-price-badge` | Token | Badge primitive | StrategyDiscoveryPanel.tsx |
| `strat-price-num` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-price-unavailable` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-qty-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-quote-change` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-quote-name` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-quote-price` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-quote-search-inline` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-quote-unavailable` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-remove-leg-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-roll-body` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-roll-exp-chip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-roll-exp-chips` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-roll-field` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-roll-strike-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-roll-strikes-grid` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-roll-subtitle` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-rr-pill` | Token | Badge primitive | StrategyDiscoveryPanel.tsx |
| `strat-rr-select` | Token | TextInput / Select primitive | StrategyDiscoveryPanel.tsx |
| `strat-ruler-badge` | Token | Badge primitive | StrategyDiscoveryPanel.tsx |
| `strat-ruler-call-zone` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-ruler-center-zone` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-ruler-legend` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-ruler-nav-arrow` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-ruler-price-txt` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-ruler-put-zone` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-ruler-quick-tools` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-ruler-range-hint` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-ruler-shift-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-ruler-tick` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-ruler-tick-bar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-ruler-ticks` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-ruler-title-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-save-actions` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-save-cancel-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-save-form` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-save-submit-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-saved-card-btns` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-saved-del-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-saved-leg-chip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-saved-legs-chips` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-saved-load-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-saved-meta` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-saved-name` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-saved-notes` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-saved-trade-card` | Token | Card family — WorkCard / DetailCard (#3133) | StrategyDiscoveryPanel.tsx |
| `strat-saved-trade-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-saved-trades-list` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-schedule-capture` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-schedule-capture-hint` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-schedule-confirm` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-schedule-confirm-actions` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-schedule-confirm-controls` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-schedule-confirm-summary` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-scroll-arrow` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-search-icon` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-sentiment-btn-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-sentiment-card` | Token | Card family — WorkCard / DetailCard (#3133) | StrategyDiscoveryPanel.tsx |
| `strat-sentiment-circle` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-sentiment-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-sentiment-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-sentiment-selector` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-server-candidate` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-server-candidate-meta` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-server-candidate-risk` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-server-candidate-title` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-server-candidates` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-server-candidates-empty` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-server-candidates-error` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-server-candidates-header` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-server-candidates-list` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-server-source` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `strat-side-pill` | Token | Badge primitive | StrategyDiscoveryPanel.tsx |
| `strat-spin` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-spread-txt` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-stat-chance` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-stat-profit` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-stat-return` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-stat-risk` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-stat-rr-badge` | Token | Badge primitive | StrategyDiscoveryPanel.tsx |
| `strat-stats-card-container` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-stats-header-tabs` | Token | Tabs primitive | StrategyDiscoveryPanel.tsx |
| `strat-stats-panel-col` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-stats-side-by-side-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-stats-tab` | Token | Tabs primitive | StrategyDiscoveryPanel.tsx |
| `strat-strategy-name-badge-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-strike-ruler` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-strike-ruler-container` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-strike-ruler-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-strike-ruler-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-strike-ruler-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-strike-step-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-sym-quick-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-symbol-bar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-symbol-dropdown` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-symbol-dropdown-backdrop` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-symbol-input-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-symbol-pill` | Token | Badge primitive | StrategyDiscoveryPanel.tsx |
| `strat-symbol-quote-bar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-table-view-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-target-bar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-th-content` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-th-dte` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-thesis-tag` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |
| `strat-timeline-chip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-timeline-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-top-controls-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-type-pill` | Token | Badge primitive | StrategyDiscoveryPanel.tsx |
| `strat-view-tab-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-view-tab-buttons` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-view-tabs` | Token | Tabs primitive | StrategyDiscoveryPanel.tsx |
| `strat-vol-bar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `strat-warn-badge` | Token | Badge primitive | StrategyDiscoveryPanel.tsx |
| `strat-zoom-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `strat-zoom-btn-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `flow` — 95 classes (25 Token, 70 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `flow-aa-badge` | Token | Badge primitive | OptionsFlowsHub.tsx |
| `flow-action-btns-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-active-preset-chip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-active-preset-remove` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-bar-amount` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `flow-bar-content` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `flow-bar-count` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `flow-bar-fill` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `flow-bar-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `flow-bar-symbol` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `flow-btn-group-2` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-btn-group-3` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-btn-group-4` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-btn-open-builder` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-checkboxes-block` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-col-title-bearish` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `flow-col-title-bullish` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `flow-comp-input` | Token | TextInput / Select primitive | FlowFiltersSidebar.tsx |
| `flow-comp-input-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-comp-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-comp-select` | Token | TextInput / Select primitive | FlowFiltersSidebar.tsx |
| `flow-comp-unit` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-comparison-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-current-filter-form` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-dir-btn` | Token | Button primitive | FlowFiltersSidebar.tsx |
| `flow-direction-icons-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-drilldown-actions` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |
| `flow-drilldown-back-btn` | Token | Button primitive | OptionsFlowsHub.tsx |
| `flow-drilldown-badge` | Token | Badge primitive | OptionsFlowsHub.tsx |
| `flow-drilldown-banner` | Token | Notice primitive | OptionsFlowsHub.tsx |
| `flow-drilldown-clear-btn` | Token | Button primitive | OptionsFlowsHub.tsx |
| `flow-drilldown-info` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |
| `flow-drilldown-text` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |
| `flow-dual-leaderboard-container` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `flow-filters-sidebar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-form-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-leaderboard-col` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `flow-leaderboard-col-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `flow-leaderboard-rows-list` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `flow-metric-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-metric-sub` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-metric-value` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-modal-action-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-modal-btns` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-modal-calc-text` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-modal-cancel` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-modal-close-btn` | Token | Button primitive | FlowTradeDetailModal.tsx |
| `flow-modal-confirm` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-modal-delayed-note` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-modal-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-modal-header-right` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-modal-legs-section` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-modal-legs-table` | Token | Table primitive | FlowTradeDetailModal.tsx |
| `flow-modal-legs-total` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-modal-metric-card` | Token | Card family — WorkCard / DetailCard (#3133) | FlowTradeDetailModal.tsx |
| `flow-modal-metrics-grid` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-modal-section-card` | Token | Card family — WorkCard / DetailCard (#3133) | FlowTradeDetailModal.tsx |
| `flow-modal-section-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-modal-subtitle` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-modal-time` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-modal-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-modal-title-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-numeric-comparison-block` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-perf-item` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-perf-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-perf-val` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-performance-metrics-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |
| `flow-pill-btn` | Token | Button primitive | FlowFiltersSidebar.tsx |
| `flow-preset-card` | Token | Card family — WorkCard / DetailCard (#3133) | FlowFiltersSidebar.tsx |
| `flow-preset-cards-list` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-preset-edit-btn` | Token | Button primitive | FlowFiltersSidebar.tsx |
| `flow-preset-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-preset-tagline` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-preset-tags` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-preset-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-prov-badge` | Token | Badge primitive | OptionsFlowsHub.tsx |
| `flow-range-slider` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-reset-filter-btn` | Token | Button primitive | FlowFiltersSidebar.tsx |
| `flow-save-filter-btn` | Token | Button primitive | FlowFiltersSidebar.tsx |
| `flow-sidebar-bottom-stat` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-sidebar-close-btn` | Token | Button primitive | FlowFiltersSidebar.tsx |
| `flow-sidebar-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-sidebar-tab-btn` | Token | Button primitive | FlowFiltersSidebar.tsx |
| `flow-sidebar-tabs` | Token | Tabs primitive | FlowFiltersSidebar.tsx |
| `flow-slider-val-tag` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-stat-pct-text` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-strategy-desc` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |
| `flow-table` | Token | Table primitive | OptionsFlowsHub.tsx |
| `flow-ticker-input-wrap` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | FlowFiltersSidebar.tsx |
| `flow-ticker-tag-chip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-tickers-chip-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `flow-toggle-btn` | Token | Button primitive | FlowFiltersSidebar.tsx |
| `flow-toggle-filters-btn` | Token | Button primitive | OptionsFlowsHub.tsx |
| `flow-type-badge` | Token | Badge primitive | OptionsFlowsHub.tsx |
| `flow-your-filters-panel` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |

### `risk` — 63 classes (10 Token, 53 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `risk` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `risk-adj-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-adj-name` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-adj-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-adj-value` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-adjustment-card` | Token | Card family — WorkCard / DetailCard (#3133) | RiskAnalysisModal.tsx |
| `risk-adjustments-list` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-ai-actions` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-ai-card` | Token | Card family — WorkCard / DetailCard (#3133) | RiskAnalysisModal.tsx |
| `risk-ai-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-ai-prompt-box` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-ai-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-be-buffer` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-be-price` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-breakeven-pill` | Token | Badge primitive | RiskAnalysisModal.tsx |
| `risk-breakevens-list` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-btn` | Token | Button primitive | StrategyDiscoveryPanel.tsx |
| `risk-btn-ask-ai` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-btn-copy-prompt` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-chips-carousel` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-greek-interpretation` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-greek-item` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-greek-name` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-greek-top` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-greek-val` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-greeks-grid` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-level-badge` | Token | Badge primitive | RiskAnalysisModal.tsx |
| `risk-modal-body` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-modal-close-btn` | Token | Button primitive | RiskAnalysisModal.tsx |
| `risk-modal-h2` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-modal-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-modal-header-actions` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-modal-icon-shield` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-modal-subtitle` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-modal-title-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-modal-titles` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-playbook-cards` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-prompt-chip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-rule-action` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-rule-card` | Token | Card family — WorkCard / DetailCard (#3133) | RiskAnalysisModal.tsx |
| `risk-rule-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-rule-rationale` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-rule-tag` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-rule-trigger` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-scenario-table` | Token | Table primitive | RiskAnalysisModal.tsx |
| `risk-section-box` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-section-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-section-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-sizing-calculator` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-sizing-contracts-val` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-sizing-input-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-sizing-input-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-sizing-result` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-stat-card` | Token | Card family — WorkCard / DetailCard (#3133) | RiskAnalysisModal.tsx |
| `risk-stat-cards-grid` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-stat-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-stat-sub` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-stat-value` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-symbol-badge` | Token | Badge primitive | RiskAnalysisModal.tsx |
| `risk-tail-box` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-warning-callout` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-warning-list` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |
| `risk-warning-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |

### `options` — 36 classes (4 Token, 32 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `options-card-actions` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-card-badge-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-card-header` | Token | CardHeader primitive (#3133) | OptionsStrategyCard.tsx |
| `options-card-icon` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-card-title-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-comparison-note` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | ScheduledOptionsRunForm.tsx, ThreeWayComparison.tsx |
| `options-criteria-row` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsCriteriaPanel.tsx |
| `options-download-dropdown-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsDataDownloadDropdown.tsx |
| `options-download-main-btn` | Token | Button primitive | OptionsDataDownloadDropdown.tsx |
| `options-download-menu` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsDataDownloadDropdown.tsx |
| `options-download-menu-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsDataDownloadDropdown.tsx |
| `options-download-menu-item` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsDataDownloadDropdown.tsx |
| `options-download-status` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsDataDownloadDropdown.tsx |
| `options-error` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx, ThreeWayComparison.tsx |
| `options-flows-builder-view` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |
| `options-flows-container` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |
| `options-greek-item` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-greeks-strip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-legs-section` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-legs-table` | Token | Table primitive | OptionsStrategyCard.tsx |
| `options-legs-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-metric-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-metric-tile` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-metric-value` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-metrics-grid` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-payoff-container` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-payoff-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-payoff-svg` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-request-form` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | ScheduledOptionsRunForm.tsx |
| `options-side-buy` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-side-sell` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-strategy-name` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-strategy-structured-card` | Token | Card family — WorkCard / DetailCard (#3133) | OptionsStrategyCard.tsx |
| `options-three-way-comparison` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | ThreeWayComparison.tsx |
| `options-underlying-price` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |
| `options-underlying-symbol` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |

### `llm` — 30 classes (7 Token, 23 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `llm-contract-chip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-action-bar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-answer-text` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-badge` | Token | Badge primitive | LlmStrategyEvalModal.tsx |
| `llm-eval-close-btn` | Token | Button primitive | LlmStrategyEvalModal.tsx |
| `llm-eval-export-buttons` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-export-strip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-export-title` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-form` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-group-answer` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-group-card` | Token | Card family — WorkCard / DetailCard (#3133) | LlmStrategyEvalModal.tsx |
| `llm-eval-group-contracts` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-group-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-groups-grid` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-legs-subtitle` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-meta-bar` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-modal-body` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-modal-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-order-btn` | Token | Button primitive | LlmStrategyEvalModal.tsx |
| `llm-eval-rank-body` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-rank-num` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-ranking-item` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-rankings-list` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-results-container` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-strategy-strip` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-eval-submit-btn` | Token | Button primitive | LlmStrategyEvalModal.tsx |
| `llm-eval-synthesis-card` | Token | Card family — WorkCard / DetailCard (#3133) | LlmStrategyEvalModal.tsx |
| `llm-eval-title-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |
| `llm-export-btn` | Token | Button primitive | LlmStrategyEvalModal.tsx |

### `autonomous` — 13 classes (0 Token, 13 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `autonomous-run` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | AutonomousOptionsRuns.tsx |
| `autonomous-run-head` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | AutonomousOptionsRuns.tsx |
| `autonomous-run-meta` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | AutonomousOptionsRuns.tsx |
| `autonomous-run-opp` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | AutonomousOptionsRuns.tsx |
| `autonomous-run-opps` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | AutonomousOptionsRuns.tsx |
| `autonomous-run-summary` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | AutonomousOptionsRuns.tsx |
| `autonomous-run-thesis` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | AutonomousOptionsRuns.tsx |
| `autonomous-run-time` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | AutonomousOptionsRuns.tsx |
| `autonomous-runs` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | AutonomousOptionsRuns.tsx |
| `autonomous-runs-error` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | AutonomousOptionsRuns.tsx |
| `autonomous-runs-head` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | AutonomousOptionsRuns.tsx |
| `autonomous-runs-list` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | AutonomousOptionsRuns.tsx |
| `autonomous-runs-loading` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | AutonomousOptionsRuns.tsx |

### `flows` — 9 classes (1 Token, 8 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `flows-capability-nav` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | OptionsFlowsHub.tsx |
| `flows-delay-banner` | Token | Notice primitive | OptionsFlowsHub.tsx |
| `flows-delay-banner-right` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |
| `flows-filter-active-pill-header` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |
| `flows-gauge-badge-wrap` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |
| `flows-gauge-svg` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |
| `flows-gauge-text` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |
| `flows-main-layout` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |
| `flows-table-area` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |

### `ui-* (already tokens)` — 7 classes (7 Token, 0 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `ui-danger` | Token | Itself — already a primitive/text-utility class (`src/client/components/ui/`, `primitives.css`) | AutopilotControlCenter.tsx, ETradeTradingHub.tsx, OptionsResearchPanel.tsx |
| `ui-footer-bar` | Token | Itself — already a primitive/text-utility class (`src/client/components/ui/`, `primitives.css`) | AutopilotControlCenter.tsx |
| `ui-footnote` | Token | Itself — already a primitive/text-utility class (`src/client/components/ui/`, `primitives.css`) | DiscoveryRunsPanel.tsx, LlmOptionsIdeasPanel.tsx, OptionsResearchPanel.tsx, OrderTicketPanel.tsx |
| `ui-meta` | Token | Itself — already a primitive/text-utility class (`src/client/components/ui/`, `primitives.css`) | AutopilotControlCenter.tsx, DiscoveryRunsPanel.tsx, ETradeTradingHub.tsx, LlmOptionsIdeasPanel.tsx, OptionsResearchPanel.tsx, OrderTicketPanel.tsx |
| `ui-meta-sm` | Token | Itself — already a primitive/text-utility class (`src/client/components/ui/`, `primitives.css`) | AutopilotControlCenter.tsx, DiscoveryRunsPanel.tsx, ETradeTradingHub.tsx, OptionsResearchPanel.tsx |
| `ui-success` | Token | Itself — already a primitive/text-utility class (`src/client/components/ui/`, `primitives.css`) | AutopilotControlCenter.tsx, ETradeTradingHub.tsx, OptionsResearchPanel.tsx |
| `ui-warning` | Token | Itself — already a primitive/text-utility class (`src/client/components/ui/`, `primitives.css`) | AutopilotControlCenter.tsx, ETradeTradingHub.tsx |

### `bearish` — 6 classes (0 Token, 6 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `bearish-amount` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `bearish-col` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | FlowSummaryDualBars.tsx |
| `bearish-content` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `bearish-count` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `bearish-fill` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `bearish-row` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | FlowSummaryDualBars.tsx |

### `bullish` — 6 classes (0 Token, 6 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `bullish-amount` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `bullish-col` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | FlowSummaryDualBars.tsx |
| `bullish-content` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `bullish-count` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `bullish-fill` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowSummaryDualBars.tsx |
| `bullish-row` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | FlowSummaryDualBars.tsx |

### `congress` — 2 classes (0 Token, 2 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `congress-meta-tag` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |
| `congress-politician` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |

### `deep` — 2 classes (0 Token, 2 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `deep-bearish` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `deep-bullish` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |

### `empty` — 2 classes (0 Token, 2 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `empty` | Deletion candidate | State modifier on a bespoke parent — primitive prop/state (e.g. Button `disabled`, Tabs `selected`) when the parent migrates | StrategyDiscoveryPanel.tsx |
| `empty-txt` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `etapi` — 2 classes (0 Token, 2 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `etapi-config-embedded` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | EtapiConfigModal.tsx |
| `etapi-config-embedded-body` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | EtapiConfigModal.tsx |

### `eval` — 2 classes (0 Token, 2 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `eval` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `eval-llm` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `med` — 2 classes (0 Token, 2 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `med-bearish` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |
| `med-bullish` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |

### `menu` — 2 classes (0 Token, 2 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `menu-item-icon` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsDataDownloadDropdown.tsx |
| `menu-item-text` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsDataDownloadDropdown.tsx |

### `reset` — 2 classes (0 Token, 2 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `reset` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |
| `reset-both` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `text` — 2 classes (0 Token, 2 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `text-muted` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | EtapiConfigModal.tsx |
| `text-xl` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | EtapiConfigModal.tsx |

### `trade` — 2 classes (0 Token, 2 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `trade` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |
| `trade-fast` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `active` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `active` | Deletion candidate | State modifier on a bespoke parent — primitive prop/state (e.g. Button `disabled`, Tabs `selected`) when the parent migrates | FlowFiltersSidebar.tsx, OptionsFlowsHub.tsx, StrategyDiscoveryPanel.tsx, StrategyLibraryModal.tsx |

### `breakeven` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `breakeven` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |

### `builder` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `builder` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `buy` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `buy` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |

### `call` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `call` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `capital` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `capital` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `center` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `center-atm` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `chance` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `chance` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `charm` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `charm` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `close` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `close` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `closed` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `closed` | Deletion candidate | State modifier on a bespoke parent — primitive prop/state (e.g. Button `disabled`, Tabs `selected`) when the parent migrates | StrategyDiscoveryPanel.tsx |

### `cohort` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `cohort-error` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | LlmStrategyEvalModal.tsx |

### `compact` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `compact` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `credit` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `credit` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |

### `crush` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `crush` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `current` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `current` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `custom` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `custom` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `danger` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `danger` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |

### `delta` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `delta` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `dem` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `dem` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |

### `disabled` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `disabled` | Deletion candidate | State modifier on a bespoke parent — primitive prop/state (e.g. Button `disabled`, Tabs `selected`) when the parent migrates | StrategyDiscoveryPanel.tsx |

### `dot` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `dot` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `down` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `down` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |

### `dual` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `dual` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `error` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `error` | Deletion candidate | State modifier on a bespoke parent — primitive prop/state (e.g. Button `disabled`, Tabs `selected`) when the parent migrates | OptionsDataDownloadDropdown.tsx, StrategyDiscoveryPanel.tsx |

### `exclude` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `exclude` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `excluded` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `excluded` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `font` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `font-bold` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | EtapiConfigModal.tsx |

### `full` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `full` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `gain` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `gain` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `gamma` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `gamma` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |

### `greeks` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `greeks` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `highlight` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `highlight` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsDataDownloadDropdown.tsx, RiskAnalysisModal.tsx, StrategyDiscoveryPanel.tsx |

### `insider` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `insider-title-sub` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |

### `iv` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `iv` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `key` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `key-stats` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `label` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `label` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `left` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `left` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |

### `long` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `long` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `loss` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `loss` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx, StrategyDiscoveryPanel.tsx |

### `m` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `m-0` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | EtapiConfigModal.tsx |

### `mb` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `mb-4` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | EtapiConfigModal.tsx |

### `metric` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `metric-tag` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |

### `mini` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `mini` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `net` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `net-greeks` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `neutral` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `neutral` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |

### `news` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `news-symbols-prefix` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |

### `normalized` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `normalized` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |

### `open` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `open` | Deletion candidate | State modifier on a bespoke parent — primitive prop/state (e.g. Button `disabled`, Tabs `selected`) when the parent migrates | StrategyDiscoveryPanel.tsx |

### `primary` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `primary` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyLibraryModal.tsx |

### `profit` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `profit` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx, RiskAnalysisModal.tsx |

### `put` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `put` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `raw` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `raw` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |

### `remove` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `remove` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `rep` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `rep` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsFlowsHub.tsx |

### `report` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `report` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | LlmStrategyEvalModal.tsx |

### `rho` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `rho` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `right` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `right` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |

### `roll` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `roll` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |

### `safety` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `safety` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `save` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `save` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `sched` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `sched-form-group` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | ScheduledOptionsRunForm.tsx |

### `selected` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `selected` | Deletion candidate | State modifier on a bespoke parent — primitive prop/state (e.g. Button `disabled`, Tabs `selected`) when the parent migrates | FlowFiltersSidebar.tsx, StrategyLibraryModal.tsx |

### `sell` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `sell` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |

### `short` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `short` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `side` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `side-by-side` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `single` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `single` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `split` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `split` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowFiltersSidebar.tsx |

### `spot` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `spot-tag` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `stop` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `stop` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | RiskAnalysisModal.tsx |

### `subnav` — 1 classes (1 Token, 0 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `subnav-btn` | Token | Button primitive | EtapiConfigModal.tsx, LlmStrategyEvalModal.tsx, OptionsFlowsHub.tsx |

### `success` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `success` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsDataDownloadDropdown.tsx |

### `surge` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `surge` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `theta` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `theta` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |

### `toggle` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `toggle-arrow` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |

### `tool` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `tool-card-body` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | OptionsStrategyCard.tsx |

### `uncapped` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `uncapped` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `up` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `up` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | FlowTradeDetailModal.tsx |

### `val` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `val` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `vanna` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `vanna` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `vega` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `vega` | Deletion candidate | Delete — no rule defines this class anywhere in `src/client`; removing the reference changes nothing visually | StrategyDiscoveryPanel.tsx |

### `vol` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `vol` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `vomma` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `vomma` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

### `wings` — 1 classes (0 Token, 1 deletion candidate)

| Legacy class | Disposition | Successor | Used by |
|---|---|---|---|
| `wings` | Deletion candidate | None yet — bespoke layout class; S-U7 deprecation owns removal | StrategyDiscoveryPanel.tsx |

## Dead classes (referenced, defined nowhere)

The 40 classes below are used in a `className` but no rule in any `src/client` stylesheet defines them — they currently style nothing. Their successor is deletion itself. They are also listed in the family tables above (same disposition); this section exists so the dead set is visible at a glance.

| Legacy class | Used by |
|---|---|
| `bearish-col` | FlowSummaryDualBars.tsx |
| `bearish-row` | FlowSummaryDualBars.tsx |
| `breakeven` | StrategyDiscoveryPanel.tsx |
| `bullish-col` | FlowSummaryDualBars.tsx |
| `bullish-row` | FlowSummaryDualBars.tsx |
| `cohort-error` | LlmStrategyEvalModal.tsx |
| `etapi-config-embedded` | EtapiConfigModal.tsx |
| `etapi-config-embedded-body` | EtapiConfigModal.tsx |
| `flow-ticker-input-wrap` | FlowFiltersSidebar.tsx |
| `flows-capability-nav` | OptionsFlowsHub.tsx |
| `font-bold` | EtapiConfigModal.tsx |
| `gamma` | StrategyDiscoveryPanel.tsx |
| `left` | StrategyDiscoveryPanel.tsx |
| `m-0` | EtapiConfigModal.tsx |
| `mb-4` | EtapiConfigModal.tsx |
| `options-three-way-comparison` | ThreeWayComparison.tsx |
| `reset` | StrategyDiscoveryPanel.tsx |
| `right` | StrategyDiscoveryPanel.tsx |
| `roll` | StrategyDiscoveryPanel.tsx |
| `strat-info-icon` | StrategyDiscoveryPanel.tsx |
| `strat-lib-card-name-group` | StrategyLibraryModal.tsx |
| `strat-payoff-sentiments` | StrategyDiscoveryPanel.tsx |
| `strat-price-badge` | StrategyDiscoveryPanel.tsx |
| `strat-price-unavailable` | StrategyDiscoveryPanel.tsx |
| `strat-quote-unavailable` | StrategyDiscoveryPanel.tsx |
| `strat-rr-pill` | StrategyDiscoveryPanel.tsx |
| `strat-server-candidate` | StrategyDiscoveryPanel.tsx |
| `strat-server-candidate-meta` | StrategyDiscoveryPanel.tsx |
| `strat-server-candidate-risk` | StrategyDiscoveryPanel.tsx |
| `strat-server-candidate-title` | StrategyDiscoveryPanel.tsx |
| `strat-server-candidates` | StrategyDiscoveryPanel.tsx |
| `strat-server-candidates-empty` | StrategyDiscoveryPanel.tsx |
| `strat-server-candidates-error` | StrategyDiscoveryPanel.tsx |
| `strat-server-candidates-header` | StrategyDiscoveryPanel.tsx |
| `strat-server-candidates-list` | StrategyDiscoveryPanel.tsx |
| `strat-server-source` | StrategyDiscoveryPanel.tsx |
| `text-muted` | EtapiConfigModal.tsx |
| `text-xl` | EtapiConfigModal.tsx |
| `theta` | StrategyDiscoveryPanel.tsx |
| `vega` | StrategyDiscoveryPanel.tsx |

## Out of scope

- Classes defined in the 9 stylesheets but not used by these 29 files are not listed here — they belong to other layouts and get their own mapping when those layouts are triaged.
- The 1,908 rules of `styles.css` as a whole are not triaged here — only the classes these layouts actually use.
- No class is deleted by this slice; no stylesheet loses a rule.

Traceability: issue #3135 (Part of #2150) · pin test `tests/template_token_tiers_3135.test.ts` · #cpo-dhmp
