### Added

- **Options Screener product programme, slice 1 (UX only, #2596):** a top-level "Options Screener" sidebar item (route `options-screener`, navOrder 26) with its own sub-menu and its own aggregate page (`src/client/OptionsScreenerPage.tsx`) linking to every related existing surface — contract screen, strategy panel, best-trade, compare, LLM ideas, LLM evaluate, discovery, scheduled runs, flows, IV history, reports/Docs, Workflow Runs, schedules, and settings (settings sections themselves are later slices; the page shell and navigation are slice 1). No existing nav item was removed and no panel was duplicated.
- **Collapsed sidebar flyout (#2596):** collapsed means icons-only, with sub-menus reachable via flyout on hover/focus/tap, keyboard accessible, `aria-expanded`/`aria-controls` correct, Esc closes; collapsed state remains persisted via the existing `cf_nav_collapsed` pattern. Sub-menu entries for a disabled product are hidden, never dead links.
- **Per-product feature flags (#2596):** parent `options_screener` plus one flag per options sub-product (`options_contract_screen`, `options_strategy_panel`, `options_best_trade`, `options_compare`, `options_llm_ideas`, `options_llm_evaluate`, `options_discovery`, `options_scheduled`, `options_flows`, `options_iv_history`), registered in `featureFlagPorts.ts`, `TAB_TO_FEATURE_MAP`, `matchFeatureForRoute`, and the `window.__FEATURES__` injection. Rule: an explicitly OFF flag always wins; an absent flag inherits its parent (`options_screener`, itself inheriting `options_research`), so existing products are not silently disabled. A disabled sub-product is hidden or shows `FeatureDisabledNotice`, and its server route returns 404 `FEATURE_DISABLED`, never a silent fall-through. Stock screener products need no new flag: the stock screener and strategy scanner are already gated by `screener`.

## Agent #cfo-qunso

Closes #2596

Process documentation impact: programme plan at ~/workspace/options-product-programme/programme.md (outside the repo; no repo docs file changed by this slice).
