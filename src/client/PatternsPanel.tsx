/**
 * Issue #2884 — Patterns tab panel: read-only stock pattern
 * catalog with select/apply. Built only from
 * src/client/components/ui/ primitives, token-only styling.
 *
 * Read-only in v1: no add/update UI (later phase). Applying a
 * pattern hands its screenFilter to the hub, which sets the
 * New Screen criteria panel and navigates there. Nothing here
 * touches preset storage: patterns and presets stay separate.
 */

import { useState } from "react";
import { Badge, Button, Card, Notice, PageSection } from "./components/ui";
import {
  listStockPatterns,
  type StockPattern,
} from "../workflows/stockPatternCatalog";
import type { StockScreenerFilter } from "../types";

export interface PatternsPanelProps {
  onApplyPattern?: (filter: StockScreenerFilter, patternId: string) => void;
}

function filterChips(filter: StockScreenerFilter): string[] {
  const chips: string[] = [];
  if (filter.momentum) chips.push(`Momentum: ${filter.momentum}`);
  if (filter.maxRsi !== undefined) chips.push(`Max RSI: ${filter.maxRsi}`);
  if (filter.minRsi !== undefined) chips.push(`Min RSI: ${filter.minRsi}`);
  if (chips.length === 0) chips.push("No mappable filter — catalog only");
  return chips;
}

export function PatternsPanel({ onApplyPattern }: PatternsPanelProps) {
  const patterns = listStockPatterns();
  const [appliedId, setAppliedId] = useState<string | null>(null);

  const apply = (pattern: StockPattern) => {
    setAppliedId(pattern.id);
    onApplyPattern?.(pattern.screenFilter, pattern.id);
  };

  return (
    <PageSection title="Stock patterns">
      <Notice tone="info" density="compact">
        Stock patterns from the setup catalog, read-only in this version — adding or updating patterns comes later.
        Patterns are market setup signatures, not presets: applying one fills the New Screen criteria, it never
        overwrites preset storage.
      </Notice>
      {appliedId && (
        <Notice tone="success" density="compact">
          Pattern applied — the New Screen criteria now carry its filter. Run the screen there.
        </Notice>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
        {patterns.map((pattern) => (
          <Card key={pattern.id} padding="md">
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
              <h3 style={{ margin: 0 }}>{pattern.label}</h3>
              <Badge tone="neutral">stock</Badge>
              <Badge tone="neutral">read-only</Badge>
            </div>
            <p style={{ color: "var(--color-text-muted)" }}>{pattern.description}</p>
            <p>{pattern.signatureDescription}</p>
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
              {pattern.indicators.map((indicator) => (
                <Badge key={indicator} tone="neutral">{indicator}</Badge>
              ))}
            </div>
            {Object.keys(pattern.guardrails).length > 0 && (
              <p style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
                Guardrails: {Object.entries(pattern.guardrails).map(([k, v]) => `${k} = ${v}`).join(", ")}
                {pattern.unmappedGuardrails.length > 0 && (
                  <> — not mappable to a screen filter ({pattern.unmappedGuardrails.join(", ")}), shown here, never converted.</>
                )}
              </p>
            )}
            <p style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
              Pairs with: {pattern.pairedStrategies.join(", ")}
            </p>
            <ul style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
              {pattern.riskNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
              {filterChips(pattern.screenFilter).map((chip) => (
                <Badge key={chip} tone="neutral">{chip}</Badge>
              ))}
              <Button variant="secondary" size="sm" onClick={() => apply(pattern)}>
                Apply to New Screen
              </Button>
            </div>
          </Card>
        ))}
        {patterns.length === 0 && (
          <Notice tone="warning" density="compact">
            No stock patterns in the catalog.
          </Notice>
        )}
      </div>
    </PageSection>
  );
}
