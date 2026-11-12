/**
 * Reusable Strategy Library Modal — single source of truth for strategy selection.
 * 
 * Used by:
 * - StrategyDiscoveryPanel (single-select, "Select Strategy →")
 * - ScannerPanel (multi-select, "Apply" with selected IDs)
 * 
 * Data: Scanner catalog (id, label, description, theses[], category) — preserves thesis tags.
 * UI: Discovery modal cards (search, category tabs, payoff diagrams, risk badges).
 * 
 * Issue #450: Unify strategy catalog.
 */

import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Modal, TextInput } from "../components/ui";
import {
  DIRECTION_TAGS,
  DIRECTION_TAG_LABELS,
  isDirectionTag,
} from "../../trading";
import "./strategyDiscovery.css";

export interface StrategyInfo {
  id: string;
  label: string;
  category: string;
  description: string;
  theses: string[];
  aliases: string[];
  /** Rich card fields (issue #450: Discovery content preserved) */
  subtitle?: string;
  riskType?: string;
  legsCount?: number;
  pnlSvgPath?: string;
}

interface StrategyLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  strategies: StrategyInfo[];
  // Single-select mode (Discovery)
  onSelect?: (strategyId: string) => void;
  // Multi-select mode (Scanner)
  multiSelect?: boolean;
  selectedIds?: string[];
  onApply?: (selectedIds: string[]) => void;
  // Discovery card actions (rendered only when provided)
  onAnalyzeRisk?: (strategyId: string) => void;
  onHover?: (strategyId: string | null) => void;
}

const CATEGORIES = ["All", "Bullish", "Bearish", "Neutral", "Volatility", "Synthetics & Spreads"] as const;

export function StrategyLibraryModal({
  isOpen,
  onClose,
  strategies,
  onSelect,
  multiSelect = false,
  selectedIds = [],
  onApply,
  onAnalyzeRisk,
  onHover,
}: StrategyLibraryModalProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("All");
  // Issue #275: filter strategies by direction tag (the catalog theses).
  const [directionFilter, setDirectionFilter] = useState<string>("All");
  const [localSelected, setLocalSelected] = useState<string[]>(selectedIds);

  // Re-sync the working selection each time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setLocalSelected(selectedIds);
      setDirectionFilter("All");
    }
  }, [isOpen]);

  const normalize = (t: string) => t.toLowerCase().replace(/_/g, " ");

  const filtered = useMemo(() => {
    return strategies.filter((s) => {
      const matchCat =
        categoryFilter === "All" ||
        s.theses.some((t) => normalize(t) === normalize(categoryFilter)) ||
        normalize(s.category) === normalize(categoryFilter);
      const matchDirection =
        directionFilter === "All" || s.theses.includes(directionFilter);
      const q = searchQuery.trim().toLowerCase();
      const matchSearch =
        q === "" ||
        s.label.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q);
      return matchCat && matchDirection && matchSearch;
    });
  }, [strategies, categoryFilter, directionFilter, searchQuery]);

  if (!isOpen) return null;

  const toggleSelect = (id: string) => {
    if (multiSelect) {
      setLocalSelected((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      );
    } else {
      onSelect?.(id);
    }
  };

  return (
        <Modal open={isOpen} onClose={onClose} size="none" panelClassName="strat-strategy-picker-modal" ariaLabel="Options strategy library">
        <div className="strat-modal-header">
          <div className="strat-modal-header-titles">
            <h3>Options Strategy Library ({strategies.length} Strategies)</h3>
            <span>
              {multiSelect
                ? `Select strategies for the scan (${localSelected.length} selected)`
                : "Choose a pre-made strategy to evaluate profit/loss characteristics"}
            </span>
          </div>
          <Button variant="ghost" type="button" className="strat-modal-close-btn" onClick={onClose}>
            ✕
          </Button>
        </div>

        <div className="strat-library-toolbar">
          <div className="strat-library-search">
            <TextInput
              type="text"
              placeholder="Search by strategy name or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />
          </div>
          <div className="strat-library-categories">
            {CATEGORIES.map((cat) => (
              <Button
                key={cat}
                type="button"
                className={`strat-cat-pill ${categoryFilter === cat ? "active" : ""}`}
                onClick={() => setCategoryFilter(cat)}
              >
                {cat}
              </Button>
            ))}
          </div>
          <div className="strat-library-directions" aria-label="Filter by direction">
            <Button
              type="button"
              className={`strat-cat-pill ${directionFilter === "All" ? "active" : ""}`}
              onClick={() => setDirectionFilter("All")}
            >
              All directions
            </Button>
            {DIRECTION_TAGS.map((tag) => (
              <Button
                key={tag}
                type="button"
                className={`strat-cat-pill dir-${tag} ${directionFilter === tag ? "active" : ""}`}
                onClick={() => setDirectionFilter(tag)}
              >
                {DIRECTION_TAG_LABELS[tag]}
              </Button>
            ))}
          </div>
        </div>

        <div className="strat-library-grid">
          {filtered.map((s) => {
            const isSelected = multiSelect && localSelected.includes(s.id);
            return (
              <div
                key={s.id}
                className={`strat-library-card ${isSelected ? "selected" : ""}`}
                onMouseEnter={() => onHover?.(s.id)}
                onMouseLeave={() => onHover?.(null)}
                onClick={() => toggleSelect(s.id)}
              >
                <div className="strat-lib-card-top">
                  <div className="strat-lib-card-name-group">
                    <span className="strat-lib-card-name">{s.label}</span>
                    {s.subtitle && <span className="strat-lib-card-sub">{s.subtitle}</span>}
                  </div>
                  {s.riskType && (
                    <span className={`strat-lib-risk-badge ${s.riskType.toLowerCase()}`}>
                      {s.riskType} Risk
                    </span>
                  )}
                  {multiSelect && (
                    <Checkbox
                      checked={isSelected}
                      onChange={() => toggleSelect(s.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                </div>

                {s.pnlSvgPath && (
                  <div className="strat-lib-svg-wrap">
                    <svg viewBox="0 0 100 50" className="strat-lib-thumbnail-svg">
                      <line x1="0" y1="25" x2="100" y2="25" stroke="var(--color-border-strong)" strokeWidth="1" strokeDasharray="2 2" />
                      <path d={s.pnlSvgPath} fill="none" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                )}

                <div className="strat-card-theses">
                  {s.theses.map((t) => (
                    <span
                      key={t}
                      className={`strat-thesis-tag${isDirectionTag(t) ? ` dir-${t}` : ""}`}
                    >
                      {t.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
                <p className="strat-lib-desc">{s.description}</p>

                <div className="strat-lib-footer">
                  {typeof s.legsCount === "number" && (
                    <span className="strat-lib-legs-tag">{s.legsCount} Leg{s.legsCount > 1 ? "s" : ""}</span>
                  )}
                  <div style={{ display: "flex", gap: "var(--space-1-5)" }}>
                    {onAnalyzeRisk && (
                      <Button variant="warning" tone="subtle" size="sm"
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAnalyzeRisk(s.id);
                        }}
                        title="Analyze Strategy Risk & Management Playbook"
                      >
                        Risk
                      </Button>
                    )}
                    {!multiSelect && (
                      <Button type="button" className="strat-lib-select-btn">
                        Select Strategy →
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {multiSelect && (
          <div className="strat-modal-footer">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="button"
              className="primary"
              onClick={() => {
                onApply?.(localSelected);
                onClose();
              }}
            >
              Apply ({localSelected.length} selected)
            </Button>
          </div>
        )}
          </Modal>
  );
}
