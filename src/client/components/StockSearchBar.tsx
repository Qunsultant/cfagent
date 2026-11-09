import React, { useState, useEffect, useRef, useMemo } from "react";
import { useMarketQuotes } from "../quotes/useMarketQuotes";
import { SEARCH_SYMBOLS, type NamedQuoteSymbol } from "../quotes/symbolSets";
import type { NavTabId } from "./NavigationMenu";
import { Badge, Button, Modal, PillGroup, TextInput, type BadgeTone, type PillOption } from "./ui";
import { BRAND } from "../branding";
import { useTenantProviders, BROKER_OPTIONS } from "../tenantProviders";

export type StockTickerItem = NamedQuoteSymbol & {
  bid?: string;
  ask?: string;
  rawPrice?: number;
  flashState?: "up" | "down" | null;
};

export interface StockSearchBarProps {
  onSelectTab?: (tab: NavTabId) => void;
  onAskAgent?: (query: string) => void;
  className?: string;
}

interface NavShortcut {
  id: NavTabId;
  label: string;
  category: string;
  icon: string;
}

const NAV_SHORTCUTS: NavShortcut[] = [
  { id: "autopilot", label: "Autopilot Control Center", category: "Execution", icon: "⚡" },
  { id: "order", label: "Fast Order Ticket & Preview", category: "Execution", icon: "⚡" },
  { id: "portfolio", label: "Portfolio & Holdings", category: "Execution", icon: "💼" },
  { id: "ledger", label: "Order History Ledger", category: "Execution", icon: "📜" },
  { id: "options-flows", label: "Options Scanner & Unusual Flow", category: "Execution", icon: "📊" },
  { id: "options", label: "Auto Options Research", category: "Execution", icon: "🤖" },
  { id: "screeners", label: "Multi-Asset Screeners", category: "Intelligence", icon: "🔎" },
  { id: "search", label: "Search Hub", category: "Intelligence", icon: "🔎" },
  { id: "scanner", label: "Equity Universe Scan", category: "Intelligence", icon: "📈" },
  { id: "research", label: "Market Data Equity & Crypto Research", category: "Intelligence", icon: "🔬" },
  { id: "chat", label: "Copilot Ideas & Agent Chat", category: "Intelligence", icon: "💬" },
  { id: "voice", label: "Voice Trading Desk", category: "Intelligence", icon: "🎙️" },
  { id: "omnichannel", label: "Email & Slack Agents", category: "Intelligence", icon: "✉️" },
  { id: "workflows", label: "Workflows Hub (Playbooks A1..E6)", category: "Playbooks", icon: "🔄" },
  { id: "endpoints", label: "MCP Agent Endpoints & Tools", category: "Playbooks", icon: "🔌" },
  { id: "nlq", label: "Records NLQ", category: "Playbooks", icon: "🗄️" },
  { id: "audit", label: "Audit Trail & Attestation Logs", category: "Platform", icon: "🛡️" },
  { id: "payments", label: "x402 Agent Payments & Balances", category: "Platform", icon: "💳" },
  { id: "referrals", label: "Referrals & Rewards", category: "Platform", icon: "🎁" },
  { id: "ads", label: "Sponsored Marketplace Deals", category: "Platform", icon: "📢" },
  { id: "revenue", label: "Platform Revenue Analytics", category: "Platform", icon: "📈" },
];

const TICKER_TYPE_TONES: Record<string, BadgeTone> = { stock: "info", crypto: "warning", etf: "purple" };

const FILTER_PILLS: PillOption<"all" | "tickers" | "navigation" | "actions">[] = [
  { id: "all", label: "All Results" },
  { id: "tickers", label: "📈 Stocks & Crypto" },
  { id: "navigation", label: "🧭 Platform Navigation" },
  { id: "actions", label: "⚡ Agent Actions" },
];

/** Option id for the palette listbox (WAI-ARIA listbox pattern, #1695). */
export function paletteOptionId(index: number): string {
  return `palette-option-${index}`;
}

/**
 * Label of the selected palette row, or null when nothing is selectable.
 * Pure (unit-tested): tickers first, then navigation, then actions — the
 * same order the keyboard navigation walks.
 */
export function getPaletteSelectedLabel(
  tickers: StockTickerItem[],
  nav: Array<{ label: string }>,
  actions: Array<{ label: string }>,
  selectedIndex: number,
): string | null {
  if (selectedIndex < 0) return null;
  if (selectedIndex < tickers.length) {
    const ticker = tickers[selectedIndex];
    return `${ticker.symbol}, ${ticker.name}`;
  }
  const afterTickers = selectedIndex - tickers.length;
  if (afterTickers < nav.length) return nav[afterTickers].label;
  const afterNav = afterTickers - nav.length;
  if (afterNav < actions.length) return actions[afterNav].label;
  return null;
}

/** Polite live-region announcement for result count + selection (#1695). Pure (unit-tested). */
export function buildPaletteAnnouncement(total: number, selectedLabel: string | null): string {
  if (total === 0) return "No matching stocks or commands";
  const count = `${total} ${total === 1 ? "result" : "results"}`;
  return selectedLabel ? `${count}. Selected: ${selectedLabel}.` : `${count}.`;
}

export function StockSearchBar({ onSelectTab, onAskAgent, className = "" }: StockSearchBarProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filterType, setFilterType] = useState<"all" | "tickers" | "navigation" | "actions">("all");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Issue #3089: the broker indicator — orders placed from anywhere in
  // the app route through the selected broker, so the search control
  // shows which broker that is, live from the tenant providers state.
  const [tenantProviders] = useTenantProviders();
  const brokerLabel = BROKER_OPTIONS.find((o) => o.id === tenantProviders.brokerId)?.label ?? tenantProviders.brokerId;
  const listRef = useRef<HTMLDivElement>(null);

  // Issue #2100: the feed lifecycle (socket, fallback, flash) lives in
  // the quotes service; the palette only renders what the hook returns.
  // Subscribed only while the modal is open, as before.
  const {
    quotes: liveQuotes,
    flash: flashStates,
    isLive: isLiveStreaming,
  } = useMarketQuotes(
    SEARCH_SYMBOLS.map((t) => t.symbol),
    isOpen,
  );

  // Global keyboard shortcut: Ctrl+K or Cmd+K toggles the palette.
  // Escape is owned by the Modal primitive (#1695) — no duplicate
  // handler here.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Reset on open. Initial focus is owned by the Modal primitive, which
  // focuses the first focusable element (the search input) (#1695).
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Filtered results
  const filteredTickers: StockTickerItem[] = useMemo(() => {
    if (filterType === "navigation" || filterType === "actions") return [];
    const q = query.trim().toUpperCase();
    if (!q) return SEARCH_SYMBOLS;
    return SEARCH_SYMBOLS.filter(
      (t) => t.symbol.toUpperCase().includes(q) || t.name.toUpperCase().includes(q)
    );
  }, [query, filterType]);

  const filteredNav = useMemo(() => {
    if (filterType === "tickers" || filterType === "actions") return [];
    const q = query.trim().toLowerCase();
    if (!q) return NAV_SHORTCUTS;
    return NAV_SHORTCUTS.filter(
      (n) => n.label.toLowerCase().includes(q) || n.category.toLowerCase().includes(q)
    );
  }, [query, filterType]);

  const filteredActions = useMemo(() => {
    if (filterType === "tickers" || filterType === "navigation") return [];
    const q = query.trim();
    const symbolTarget = q ? q.toUpperCase() : "NVDA";
    return [
      { id: "action-options", label: `Screen ${symbolTarget} 0DTE Options Flow`, query: `screen 0dte options for ${symbolTarget}`, icon: "🎯" },
      { id: "action-research", label: `Generate Market Data Valuation Report for ${symbolTarget}`, query: `research ${symbolTarget}`, icon: "📑" },
      { id: "action-compare", label: `Compare ${symbolTarget} Valuation vs Industry Peers`, query: `compare ${symbolTarget} with industry peers`, icon: "⚖️" },
      { id: "action-hours", label: "Check Market Hours & Exchange Status", query: "market status", icon: "🕒" },
    ];
  }, [query, filterType]);

  // Combined item list for keyboard navigation
  const allItemsCount = filteredTickers.length + filteredNav.length + filteredActions.length;

  // Listbox wiring (#1695): stable listbox id, the active option for
  // aria-activedescendant (undefined when nothing is selectable, so the
  // attribute never points at a missing option), and the polite live
  // announcement for count + selection.
  const listboxId = `palette-listbox-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const selectedLabel = getPaletteSelectedLabel(filteredTickers, filteredNav, filteredActions, selectedIndex);
  const activeOptionId =
    allItemsCount > 0 && selectedIndex >= 0 && selectedIndex < allItemsCount
      ? paletteOptionId(selectedIndex)
      : undefined;
  const announcement = buildPaletteAnnouncement(allItemsCount, selectedLabel);

  // Reset selected index when query or results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, filterType]);

  const handleKeyDownInInput = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (allItemsCount > 0 ? (prev + 1) % allItemsCount : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (allItemsCount > 0 ? (prev - 1 + allItemsCount) % allItemsCount : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      executeSelectedItem();
    }
  };

  const executeSelectedItem = () => {
    let currentIdx = 0;

    // Check tickers
    if (selectedIndex < filteredTickers.length) {
      const ticker = filteredTickers[selectedIndex];
      handleSelectTicker(ticker);
      return;
    }
    currentIdx += filteredTickers.length;

    // Check nav shortcuts
    if (selectedIndex < currentIdx + filteredNav.length) {
      const navItem = filteredNav[selectedIndex - currentIdx];
      handleSelectNav(navItem.id);
      return;
    }
    currentIdx += filteredNav.length;

    // Check actions
    if (selectedIndex < currentIdx + filteredActions.length) {
      const action = filteredActions[selectedIndex - currentIdx];
      handleSelectAction(action.query);
      return;
    }
  };

  const handleSelectTicker = (ticker: StockTickerItem) => {
    setIsOpen(false);
    if (onSelectTab) {
      onSelectTab("research");
    }
    if (onAskAgent) {
      onAskAgent(`research ${ticker.symbol}`);
    }
  };

  const handleSelectNav = (tabId: NavTabId) => {
    setIsOpen(false);
    if (onSelectTab) {
      onSelectTab(tabId);
    }
  };

  const handleSelectAction = (actionQuery: string) => {
    setIsOpen(false);
    if (onAskAgent) {
      onAskAgent(actionQuery);
    }
  };

  const isMac = typeof navigator !== "undefined" && navigator.userAgent.toUpperCase().indexOf("MAC") >= 0;
  const shortcutHint = isMac ? "⌘K" : "Ctrl K";

  return (
    <>
      {/* Search Bar Inline Trigger */}
      <div className={`stock-search-trigger-container ${className}`}>
        <Button
          className="stock-search-trigger-btn top-nav-control"
          onClick={() => setIsOpen(true)}
          title={`Search stocks, options, workflows (${shortcutHint})`}
          aria-label="Search stocks and platform commands"
        >
          <span className="stock-search-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <span className="stock-search-placeholder">Search stocks...</span>
          <kbd className="stock-search-kbd">{shortcutHint}</kbd>
        </Button>
      </div>

      {/* Global Command Palette / Stock Search Modal (Modal primitive, #1695) */}
      <Modal
        open={isOpen}
        onClose={() => setIsOpen(false)}
        ariaLabel="Stock and command search"
        size="none"
        panelClassName="stock-search-modal-dialog"
      >
        <div aria-live="polite" className="ui-visually-hidden">
          {announcement}
        </div>
            {/* Modal Input Bar */}
            <div className="stock-search-modal-header">
              <span className="modal-search-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <TextInput
                ref={inputRef}
                className="stock-search-modal-input"
                placeholder="Search stocks (NVDA, AAPL, BTC), workflows, or agent commands..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDownInInput}
                role="combobox"
                aria-label="Search stocks and commands"
                aria-expanded={isOpen}
                aria-controls={listboxId}
                aria-activedescendant={activeOptionId}
              />
              {query && (
                <Button
                  className="modal-clear-btn"
                  onClick={() => setQuery("")}
                  title="Clear search"
                >
                  ✕
                </Button>
              )}
              <Button
                className="modal-esc-badge"
                onClick={() => setIsOpen(false)}
                title="Close modal"
              >
                ESC
              </Button>
            </div>

            {/* Filter Type Pills */}
            <PillGroup
              options={FILTER_PILLS}
              value={filterType}
              onChange={setFilterType}
              ariaLabel="Search result filters"
              className="stock-search-filter-pills"
            />

            {/* Results Body */}
            <div className="stock-search-results-list" ref={listRef} role="listbox" id={listboxId} aria-label="Search results">
              {allItemsCount === 0 && (
                <div className="no-search-results">
                  <div className="no-results-icon">🔍</div>
                  <div className="no-results-title">No matching stocks or commands</div>
                  <div className="no-results-hint">
                    Try searching for <strong>NVDA</strong>, <strong>AAPL</strong>, <strong>options</strong>, or <strong>research</strong>
                  </div>
                </div>
              )}

              {/* Stocks Section */}
              {filteredTickers.length > 0 && (
                <div className="search-results-group">
                  <div className="group-header">
                    <div className="group-title-with-badge">
                      <span>STOCKS & CRYPTOCURRENCIES</span>
                      {isLiveStreaming && (
                        <span className="live-stream-badge" title="Real-time WebSocket quote streaming active">
                          <span className="live-stream-pulse" />
                          LIVE
                        </span>
                      )}
                    </div>
                    <span className="group-count">{filteredTickers.length}</span>
                  </div>
                  <div className="group-items">
                    {filteredTickers.map((ticker, idx) => {
                      const isSelected = selectedIndex === idx;
                      const live = liveQuotes[ticker.symbol];
                      const currentPrice = live?.formattedPrice || ticker.price;
                      const currentChange = live?.formattedChange || ticker.change;
                      const currentIsPositive =
                        live?.isPositive !== undefined ? live.isPositive : ticker.isPositive;
                      const currentBid = live?.formattedBid || ticker.bid;
                      const currentAsk = live?.formattedAsk || ticker.ask;
                      const currentVolume = live?.volume || ticker.volume;
                      const flash = flashStates[ticker.symbol];

                      return (
                        <div
                          key={ticker.symbol}
                          className={`search-result-row ticker-row ${isSelected ? "selected" : ""}`}
                          onClick={() => handleSelectTicker(ticker)}
                          onMouseEnter={() => setSelectedIndex(idx)}
                          role="option"
                          id={paletteOptionId(idx)}
                          aria-selected={isSelected}
                        >
                          <div className="ticker-badge-col">
                            <Badge size="xs" uppercase tone={TICKER_TYPE_TONES[ticker.type] ?? "neutral"}>
                              {ticker.type.toUpperCase()}
                            </Badge>
                            <span className="ticker-symbol-text">{ticker.symbol}</span>
                          </div>
                          <div className="ticker-name-col">
                            <span className="ticker-company-name">{ticker.name}</span>
                            {currentVolume && <span className="ticker-meta">Vol: {currentVolume}</span>}
                            {ticker.pe && <span className="ticker-meta">P/E: {ticker.pe}</span>}
                          </div>
                          <div className="ticker-price-col">
                            <span
                              className={`ticker-price-val ${flash ? `flash-${flash}` : ""}`}
                              data-flash={flash || undefined}
                            >
                              {currentPrice}
                            </span>
                            <span className={`ticker-change-pill ${currentIsPositive ? "positive" : "negative"}`}>
                              {currentChange}
                            </span>
                            {currentBid && currentAsk && (
                              <span className="ticker-spread-text" title="Level 1 NBBO Bid / Ask Spread">
                                B:{currentBid} · A:{currentAsk}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Navigation Section */}
              {filteredNav.length > 0 && (
                <div className="search-results-group">
                  <div className="group-header">
                    <span>NAVIGATION</span>
                    <span className="group-count">{filteredNav.length}</span>
                  </div>
                  <div className="group-items">
                    {filteredNav.map((nav, idx) => {
                      const overallIdx = filteredTickers.length + idx;
                      const isSelected = selectedIndex === overallIdx;
                      return (
                        <div
                          key={nav.id}
                          className={`search-result-row nav-row ${isSelected ? "selected" : ""}`}
                          onClick={() => handleSelectNav(nav.id)}
                          onMouseEnter={() => setSelectedIndex(overallIdx)}
                          role="option"
                          id={paletteOptionId(overallIdx)}
                          aria-selected={isSelected}
                        >
                          <span className="nav-row-icon">{nav.icon}</span>
                          <div className="nav-row-info">
                            <span className="nav-row-title">{nav.label}</span>
                            <span className="nav-row-category">{nav.category}</span>
                          </div>
                          <span className="nav-row-enter">Jump to view ↵</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Agent Actions Section */}
              {filteredActions.length > 0 && (
                <div className="search-results-group">
                  <div className="group-header">
                    <span>AGENT ACTIONS</span>
                    <span className="group-count">{filteredActions.length}</span>
                  </div>
                  <div className="group-items">
                    {filteredActions.map((action, idx) => {
                      const overallIdx = filteredTickers.length + filteredNav.length + idx;
                      const isSelected = selectedIndex === overallIdx;
                      return (
                        <div
                          key={action.id}
                          className={`search-result-row action-row ${isSelected ? "selected" : ""}`}
                          onClick={() => handleSelectAction(action.query)}
                          onMouseEnter={() => setSelectedIndex(overallIdx)}
                          role="option"
                          id={paletteOptionId(overallIdx)}
                          aria-selected={isSelected}
                        >
                          <span className="action-row-icon">{action.icon}</span>
                          <div className="action-row-info">
                            <span className="action-row-title">{action.label}</span>
                            <span className="action-row-query">Prompt: "{action.query}"</span>
                          </div>
                          <span className="action-row-enter">Ask Agent ↵</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer Controls & Key Help */}
            <div className="stock-search-modal-footer">
              <div className="footer-keyboard-hints">
                <span className="key-hint">
                  <kbd>↑</kbd> <kbd>↓</kbd> to navigate
                </span>
                <span className="key-hint">
                  <kbd>↵</kbd> to select
                </span>
                <span className="key-hint">
                  <kbd>esc</kbd> to close
                </span>
              </div>
              <div className="footer-branding">{BRAND.searchName}</div>
            </div>
      </Modal>
    </>
  );
}
