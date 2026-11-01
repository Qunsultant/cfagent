import React, { useState } from "react";
import { Button, Checkbox, FieldShell, Select, TextInput, Modal } from "../../components/ui";
import {
  FlowFilterConfig,
  SavedFilterPreset,
  FlowSentiment,
  FlowOrderType,
  FlowSide,
  AssetClassCategory,
  MarketCapCategory,
  FlowOptionType,
} from "../../../trading/options/flows/types";

interface FlowFiltersSidebarProps {
  currentTab: "summary" | "live" | "historical" | "news" | "congress" | "insider";
  filterConfig: FlowFilterConfig;
  activePreset: SavedFilterPreset | null;
  savedPresets: SavedFilterPreset[];
  totalFlowCount: number;
  filteredFlowCount: number;
  onFilterChange: (next: FlowFilterConfig) => void;
  onSelectPreset: (preset: SavedFilterPreset) => void;
  onClearPreset: () => void;
  onSaveFilter: (name: string) => void;
  onResetFilter: () => void;
  onClose?: () => void;
}

export function FlowFiltersSidebar({
  currentTab,
  filterConfig,
  activePreset,
  savedPresets,
  totalFlowCount,
  filteredFlowCount,
  onFilterChange,
  onSelectPreset,
  onClearPreset,
  onSaveFilter,
  onResetFilter,
  onClose,
}: FlowFiltersSidebarProps) {
  const [sidebarTab, setSidebarTab] = useState<"current" | "your">("current");
  const [tickerInput, setTickerInput] = useState("");
  const [insiderInput, setInsiderInput] = useState("");
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [filterNameInput, setFilterNameInput] = useState("");

  const flowPercentage = totalFlowCount > 0
    ? Math.max(1, Math.round((filteredFlowCount / totalFlowCount) * 100))
    : 100;

  const handleAddTicker = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = tickerInput.trim().toUpperCase().replace(/,/g, "");
      if (val && !filterConfig.tickers.includes(val)) {
        onFilterChange({
          ...filterConfig,
          tickers: [...filterConfig.tickers, val],
        });
      }
      setTickerInput("");
    }
  };

  const handleRemoveTicker = (sym: string) => {
    onFilterChange({
      ...filterConfig,
      tickers: filterConfig.tickers.filter((t) => t !== sym),
    });
  };

  const handleAddInsider = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = insiderInput.trim();
      if (val && !filterConfig.insiderNames.includes(val)) {
        onFilterChange({
          ...filterConfig,
          insiderNames: [...filterConfig.insiderNames, val],
        });
      }
      setInsiderInput("");
    }
  };

  const handleRemoveInsider = (name: string) => {
    onFilterChange({
      ...filterConfig,
      insiderNames: filterConfig.insiderNames.filter((n) => n !== name),
    });
  };

  const toggleSide = (side: FlowSide) => {
    const current = filterConfig.sides;
    const exists = current.includes(side);
    const updated = exists ? current.filter((s) => s !== side) : [...current, side];
    onFilterChange({ ...filterConfig, sides: updated.length ? updated : [side] });
  };

  const toggleOrderType = (type: FlowOrderType) => {
    const current = filterConfig.orderTypes;
    const exists = current.includes(type);
    const updated = exists ? current.filter((t) => t !== type) : [...current, type];
    onFilterChange({ ...filterConfig, orderTypes: updated.length ? updated : [type] });
  };

  const toggleAssetType = (asset: AssetClassCategory) => {
    const current = filterConfig.assetTypes;
    const exists = current.includes(asset);
    const updated = exists ? current.filter((a) => a !== asset) : [...current, asset];
    onFilterChange({ ...filterConfig, assetTypes: updated.length ? updated : [asset] });
  };

  const toggleMarketCap = (cap: MarketCapCategory) => {
    const current = filterConfig.marketCaps;
    const exists = current.includes(cap);
    const updated = exists ? current.filter((c) => c !== cap) : [...current, cap];
    onFilterChange({ ...filterConfig, marketCaps: updated.length ? updated : [cap] });
  };

  const toggleContractType = (type: FlowOptionType) => {
    const current = filterConfig.contractTypes;
    const exists = current.includes(type);
    const updated = exists ? current.filter((t) => t !== type) : [...current, type];
    onFilterChange({ ...filterConfig, contractTypes: updated.length ? updated : [type] });
  };

  const toggleSentiment = (sent: FlowSentiment) => {
    const current = filterConfig.sentiments;
    const exists = current.includes(sent);
    const updated = exists ? current.filter((s) => s !== sent) : [...current, sent];
    onFilterChange({ ...filterConfig, sentiments: updated.length ? updated : [sent] });
  };

  return (
    <aside className="flow-filters-sidebar">
      <div className="flow-sidebar-header">
        <div className="flow-sidebar-tabs">
          <Button
            type="button"
            className={`flow-sidebar-tab-btn ${sidebarTab === "current" ? "active" : ""}`}
            onClick={() => setSidebarTab("current")}
          >
            Current Filter
          </Button>
          <Button
            type="button"
            className={`flow-sidebar-tab-btn ${sidebarTab === "your" ? "active" : ""}`}
            onClick={() => setSidebarTab("your")}
          >
            Your Filters
          </Button>
        </div>
        {onClose && (
          <Button
            type="button"
            className="flow-sidebar-close-btn"
            onClick={onClose}
            title="Collapse filter panel"
            aria-label="Collapse filters"
          >
            ✕
          </Button>
        )}
      </div>

      {sidebarTab === "your" ? (
        <div className="flow-your-filters-panel">
          <div className="flow-preset-cards-list">
            {savedPresets.map((preset) => {
              const isSelected = activePreset?.id === preset.id;
              return (
                <div
                  key={preset.id}
                  className={`flow-preset-card ${preset.color} ${isSelected ? "selected" : ""}`}
                  onClick={() => {
                    onSelectPreset(preset);
                    setSidebarTab("current");
                  }}
                >
                  <div className={`flow-preset-header ${preset.color}`}>
                    <span className="flow-preset-title">{preset.name}</span>
                    <Button
                      type="button"
                      className="flow-preset-edit-btn"
                      title="Edit Filter Preset"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectPreset(preset);
                        setSidebarTab("current");
                      }}
                    >
                      Edit ✎
                    </Button>
                  </div>
                  <div className="flow-preset-tagline">{preset.tagline}</div>
                  <div className="flow-preset-tags">
                    {preset.tags.join(" | ")}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flow-current-filter-form">
          {/* Active Preset Tag if applied */}
          {activePreset && (
            <div className={`flow-active-preset-chip ${activePreset.color}`}>
              <span>Filter: {activePreset.name}</span>
              <Button
                type="button"
                className="flow-active-preset-remove"
                onClick={onClearPreset}
                title="Clear Filter"
              >
                ✕
              </Button>
            </div>
          )}

          {/* Tickers Input */}
          <div className="flow-form-group">
            <FieldShell id="flow-tickers" label="Tickers:">
              <div className="flow-ticker-input-wrap">
                <TextInput id="flow-tickers"
                  type="text"
                  placeholder="Add or exclude a ticker"
                  value={tickerInput}
                  onChange={(e) => setTickerInput(e.target.value)}
                  onKeyDown={handleAddTicker}
                />
              </div>
            </FieldShell>
            {filterConfig.tickers.length > 0 && (
              <div className="flow-tickers-chip-row">
                {filterConfig.tickers.map((t) => (
                  <span key={t} className="flow-ticker-tag-chip">
                    {t} <Button type="button" onClick={() => handleRemoveTicker(t)}>✕</Button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Insiders Input (Only for Insider Flow) */}
          {currentTab === "insider" && (
            <div className="flow-form-group">
              <FieldShell id="flow-insiders" label="Insiders:">
                <div className="flow-ticker-input-wrap">
                  <TextInput id="flow-insiders"
                    type="text"
                    placeholder="Add or exclude an insider"
                    value={insiderInput}
                    onChange={(e) => setInsiderInput(e.target.value)}
                    onKeyDown={handleAddInsider}
                  />
                </div>
              </FieldShell>
              {filterConfig.insiderNames.length > 0 && (
                <div className="flow-tickers-chip-row">
                  {filterConfig.insiderNames.map((n) => (
                    <span key={n} className="flow-ticker-tag-chip">
                      {n} <Button type="button" onClick={() => handleRemoveInsider(n)}>✕</Button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Minimum Premium Slider */}
          <div className="flow-form-group">
            <FieldShell id="flow-min-premium" label="Minimum premium:">
              <span className="flow-slider-val-tag">
                {filterConfig.minPremium === 0
                  ? "All premiums"
                  : filterConfig.minPremium >= 1000000
                  ? `$${(filterConfig.minPremium / 1000000).toFixed(2)}m`
                  : `$${Math.round(filterConfig.minPremium / 1000)}k`}
              </span>
              <TextInput id="flow-min-premium"
                type="range"
                className="flow-range-slider"
                min={0}
                max={1500000}
                step={25000}
                value={filterConfig.minPremium}
                onChange={(e) =>
                  onFilterChange({ ...filterConfig, minPremium: Number(e.target.value) })
                }
              />
            </FieldShell>
          </div>

          {/* Expiration DTE Slider (Live & Historical) */}
          {(currentTab === "live" || currentTab === "historical" || currentTab === "summary") && (
            <div className="flow-form-group">
              <FieldShell id="flow-expiration" label="Expiration:">
                <span className="flow-slider-val-tag">
                  {filterConfig.maxDte >= 9999
                    ? "All expirations"
                    : `Less than ${filterConfig.maxDte} days`}
                </span>
                <TextInput id="flow-expiration"
                  type="range"
                  className="flow-range-slider"
                  min={1}
                  max={60}
                  value={filterConfig.maxDte > 60 ? 60 : filterConfig.maxDte}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    onFilterChange({ ...filterConfig, maxDte: val >= 60 ? 9999 : val });
                  }}
                />
              </FieldShell>
            </div>
          )}

          {/* Direction / Sentiment 6-Arrow Row */}
          {(currentTab === "live" || currentTab === "historical") && (
            <div className="flow-form-group">
              <FieldShell id="flow-direction-bias" label="Direction Bias:">
                <div className="flow-direction-icons-row">
                  <Button
                    type="button"
                    className={`flow-dir-btn deep-bearish ${filterConfig.sentiments.includes("bearish") ? "active" : ""}`}
                    title="Very Bearish (Puts / Short Call)"
                    onClick={() => toggleSentiment("bearish")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                    </svg>
                  </Button>
                  <Button
                    type="button"
                    className={`flow-dir-btn med-bearish ${filterConfig.sentiments.includes("bearish") ? "active" : ""}`}
                    title="Bearish"
                    onClick={() => toggleSentiment("bearish")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M17 17l-5-5m0 0l-5 5m5-5v12" />
                    </svg>
                  </Button>
                  <Button
                    type="button"
                    className={`flow-dir-btn neutral ${filterConfig.sentiments.includes("neutral") ? "active" : ""}`}
                    title="Neutral / Straddles"
                    onClick={() => toggleSentiment("neutral")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </Button>
                  <Button
                    type="button"
                    className={`flow-dir-btn split ${filterConfig.sentiments.includes("neutral") ? "active" : ""}`}
                    title="Multi-Leg Spreads / Volatility"
                    onClick={() => toggleSentiment("neutral")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
                    </svg>
                  </Button>
                  <Button
                    type="button"
                    className={`flow-dir-btn med-bullish ${filterConfig.sentiments.includes("bullish") ? "active" : ""}`}
                    title="Bullish"
                    onClick={() => toggleSentiment("bullish")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M7 7l5 5m0 0l5-5m-5 5V-7" />
                    </svg>
                  </Button>
                  <Button
                    type="button"
                    className={`flow-dir-btn deep-bullish ${filterConfig.sentiments.includes("bullish") ? "active" : ""}`}
                    title="Very Bullish (Call Sweeps)"
                    onClick={() => toggleSentiment("bullish")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M5 10l7-7m0 0l7 7m-7-7v18" />
                    </svg>
                  </Button>
                </div>
              </FieldShell>
            </div>
          )}

          {/* Side Selector (Buy Side / Sell Side) */}
          {(currentTab === "live" || currentTab === "historical") && (
            <div className="flow-form-group">
              <div className="flow-btn-group-2">
                <Button
                  type="button"
                  className={`flow-toggle-btn buy ${filterConfig.sides.includes("BUY") ? "active" : ""}`}
                  onClick={() => toggleSide("BUY")}
                >
                  {filterConfig.sides.includes("BUY") ? "✓" : "○"} Buy Side
                </Button>
                <Button
                  type="button"
                  className={`flow-toggle-btn sell ${filterConfig.sides.includes("SELL") ? "active" : ""}`}
                  onClick={() => toggleSide("SELL")}
                >
                  {filterConfig.sides.includes("SELL") ? "✓" : "✕"} Sell Side
                </Button>
              </div>
            </div>
          )}

          {/* Order Type Toggle Group (Single, Split, Sweep, Block) */}
          {(currentTab === "live" || currentTab === "historical") && (
            <div className="flow-form-group">
              <div className="flow-btn-group-4">
                {(["SINGLE", "SPLIT", "SWEEP", "BLOCK"] as FlowOrderType[]).map((type) => {
                  const active = filterConfig.orderTypes.includes(type);
                  return (
                    <Button
                      key={type}
                      type="button"
                      className={`flow-pill-btn ${active ? "active" : ""}`}
                      onClick={() => toggleOrderType(type)}
                    >
                      {active ? "✓" : "○"} {type}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Asset Type (Stocks / ETFs) */}
          <div className="flow-form-group">
            <div className="flow-btn-group-2">
              <Button
                type="button"
                className={`flow-toggle-btn ${filterConfig.assetTypes.includes("stock") ? "active" : ""}`}
                onClick={() => toggleAssetType("stock")}
              >
                {filterConfig.assetTypes.includes("stock") ? "✓" : "○"} Stocks
              </Button>
              <Button
                type="button"
                className={`flow-toggle-btn ${filterConfig.assetTypes.includes("etf") ? "active" : ""}`}
                onClick={() => toggleAssetType("etf")}
              >
                {filterConfig.assetTypes.includes("etf") ? "✓" : "○"} ETFs
              </Button>
            </div>
          </div>

          {/* Market Cap (Small, Mid, Large) */}
          <div className="flow-form-group">
            <div className="flow-btn-group-3">
              {(["small", "mid", "large"] as MarketCapCategory[]).map((cap) => {
                const active = filterConfig.marketCaps.includes(cap);
                const label = cap === "small" ? "Small Cap" : cap === "mid" ? "Mid Cap" : "Large Cap";
                return (
                  <Button
                    key={cap}
                    type="button"
                    className={`flow-pill-btn ${active ? "active" : ""}`}
                    onClick={() => toggleMarketCap(cap)}
                  >
                    {active ? "✓" : "○"} {label}
                  </Button>
                );
              })}
            </div>
          </div>

          {/* Contract Types (Calls, Puts, Spreads) */}
          {(currentTab === "live" || currentTab === "historical") && (
            <div className="flow-form-group">
              <div className="flow-btn-group-3">
                {(["calls", "puts", "spreads"] as FlowOptionType[]).map((cType) => {
                  const active = filterConfig.contractTypes.includes(cType);
                  const label = cType === "calls" ? "Calls" : cType === "puts" ? "Puts" : "Spreads";
                  return (
                    <Button
                      key={cType}
                      type="button"
                      className={`flow-pill-btn ${active ? "active" : ""}`}
                      onClick={() => toggleContractType(cType)}
                    >
                      {active ? "✓" : "○"} {label}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Checkboxes Group */}
          {(currentTab === "live" || currentTab === "historical") && (
            <div className="flow-checkboxes-block">
              <Checkbox
                label="Out of the money"
                checked={filterConfig.isOtmOnly}
                onChange={(e) =>
                  onFilterChange({ ...filterConfig, isOtmOnly: e.target.checked })
                }
              />
              <Checkbox
                label="Volume > OI"
                checked={filterConfig.volOverOiOnly}
                onChange={(e) =>
                  onFilterChange({ ...filterConfig, volOverOiOnly: e.target.checked })
                }
              />
              <Checkbox
                label="Upcoming earnings"
                checked={filterConfig.upcomingEarningsOnly}
                onChange={(e) =>
                  onFilterChange({ ...filterConfig, upcomingEarningsOnly: e.target.checked })
                }
              />
              <Checkbox
                label="Above ask or below bid"
                checked={filterConfig.aboveAskBelowBidOnly}
                onChange={(e) =>
                  onFilterChange({ ...filterConfig, aboveAskBelowBidOnly: e.target.checked })
                }
              />
            </div>
          )}

          {/* Price was & Chance was Numeric Comparison */}
          {(currentTab === "live" || currentTab === "historical") && (
            <div className="flow-numeric-comparison-block">
              <div className="flow-comparison-row">
                <span className="flow-comp-label">Price was</span>
                <Select
                  className="flow-comp-select"
                  value={filterConfig.priceOperator}
                  onChange={(e) =>
                    onFilterChange({
                      ...filterConfig,
                      priceOperator: e.target.value as any,
                    })
                  }
                >
                  <option value="less_than">Less than</option>
                  <option value="greater_than">Greater than</option>
                </Select>
                <div className="flow-comp-input-wrap">
                  <span className="flow-comp-unit">$</span>
                  <TextInput
                    type="number"
                    className="flow-comp-input"
                    placeholder="All"
                    value={filterConfig.priceValue ?? ""}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      onFilterChange({
                        ...filterConfig,
                        priceValue: v === "" ? null : Number(v),
                      });
                    }}
                  />
                </div>
              </div>

              <div className="flow-comparison-row">
                <span className="flow-comp-label">Chance was</span>
                <Select
                  className="flow-comp-select"
                  value={filterConfig.chanceOperator}
                  onChange={(e) =>
                    onFilterChange({
                      ...filterConfig,
                      chanceOperator: e.target.value as any,
                    })
                  }
                >
                  <option value="less_than">Less than</option>
                  <option value="greater_than">Greater than</option>
                </Select>
                <div className="flow-comp-input-wrap">
                  <TextInput
                    type="number"
                    className="flow-comp-input"
                    placeholder="All"
                    value={filterConfig.chanceValue ?? ""}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      onFilterChange({
                        ...filterConfig,
                        chanceValue: v === "" ? null : Number(v),
                      });
                    }}
                  />
                  <span className="flow-comp-unit">%</span>
                </div>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flow-action-btns-row">
            <Button
              type="button"
              className="flow-save-filter-btn"
              onClick={() => setShowSaveModal(true)}
            >
              Save Filter
            </Button>
            <Button
              type="button"
              className="flow-reset-filter-btn"
              onClick={onResetFilter}
            >
              Reset Filter
            </Button>
          </div>

          {/* Footer percentage stat */}
          <div className="flow-sidebar-bottom-stat">
            <span className="flow-stat-pct-text">Showing {flowPercentage}% of total flow</span>
          </div>
        </div>
      )}

      {/* Save Filter Modal */}
      {showSaveModal && (
                <Modal open={showSaveModal} onClose={() => setShowSaveModal(false)} size="none" panelClassName="flow-modal-dialog" ariaLabel="Save flow filter preset">
            <h3>💾 Save Flow Filter Preset</h3>
            <p>Save current configuration to "Your Filters" for instant recall and alerting.</p>
            <TextInput
              type="text"
              placeholder="e.g. 0DTE Tech Sweeps"
              value={filterNameInput}
              onChange={(e) => setFilterNameInput(e.target.value)}
              autoFocus
            />
            <div className="flow-modal-btns">
              <Button
                type="button"
                className="flow-modal-cancel"
                onClick={() => setShowSaveModal(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="flow-modal-confirm"
                disabled={!filterNameInput.trim()}
                onClick={() => {
                  onSaveFilter(filterNameInput.trim());
                  setShowSaveModal(false);
                  setFilterNameInput("");
                }}
              >
                Save Filter
              </Button>
            </div>
                  </Modal>
      )}
    </aside>
  );
}
