/**
 * Issue #2886 — Presets tab panel: My Presets + proposed
 * starter presets. Built only from src/client/components/ui/
 * primitives, token-only styling.
 *
 * My Presets reuses ScreenerPresetManager as-is (list, save,
 * load, delete; stocks only here). Starters are read-only
 * proposals: choosing one COPIES it to My Presets — starters
 * are never edited. Starters with null criteria cannot be
 * copied or applied until their criteria are finalized.
 * Presets are separate from patterns: nothing here reads
 * pattern definitions, and name overlap with patterns is
 * labeled as such.
 */

import { useState } from "react";
import { Badge, Button, Card, Notice, PageSection } from "./components/ui";
import { ScreenerPresetManager, createPreset } from "./ScreenerPresetManager";
import {
  listStarterPresets,
  type StarterPreset,
} from "../workflows/stockPresetCatalog";
import type { StockScreenerFilter } from "../types";
import type { StockCriteriaState } from "./StockCriteriaPanel";

export interface PresetsPanelProps {
  userLogin?: string;
  currentFilter: StockScreenerFilter;
  onApplyPreset: (criteria: StockCriteriaState) => void;
  onNavigateNewScreen: () => void;
}

function criteriaChips(criteria: StockScreenerFilter): string[] {
  const chips: string[] = [];
  if (criteria.momentum) chips.push(`Momentum: ${criteria.momentum}`);
  if (criteria.maxRsi !== undefined) chips.push(`Max RSI: ${criteria.maxRsi}`);
  if (criteria.minRsi !== undefined) chips.push(`Min RSI: ${criteria.minRsi}`);
  if (criteria.rsiFilter) chips.push(`RSI band: ${criteria.rsiFilter}`);
  if (criteria.gainersOnly) chips.push("Gainers only");
  if (criteria.requireSqueezeGate) chips.push("Squeeze gate required");
  return chips;
}

export function PresetsPanel({
  userLogin,
  currentFilter,
  onApplyPreset,
  onNavigateNewScreen,
}: PresetsPanelProps) {
  const starters = listStarterPresets();
  // Remounts My Presets after a copy so the new row appears.
  const [managerKey, setManagerKey] = useState(0);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const [copyError, setCopyError] = useState("");

  const copyStarter = async (starter: StarterPreset) => {
    if (!starter.criteria || copyingId) return;
    setCopyingId(starter.id);
    setCopyNotice("");
    setCopyError("");
    try {
      await createPreset(userLogin, {
        name: starter.name,
        assetClass: "stocks",
        criteria: starter.criteria,
      });
      setCopyNotice(`"${starter.name}" copied to My Presets.`);
      setManagerKey((k) => k + 1);
    } catch (cause) {
      setCopyError(cause instanceof Error ? cause.message : "Failed to copy starter preset.");
    } finally {
      setCopyingId(null);
    }
  };

  return (
    <div>
      <Notice tone="info" density="compact">
        Presets are user-saved screening configurations, separate from patterns: a preset never overwrites a pattern
        definition. Starter presets below are proposals — names and criteria not finalized — and choosing one copies it
        to My Presets; starters themselves are never edited. Trend Breakout and Pullback Reversion share names with
        patterns by proposal; same names, different surface.
      </Notice>

      <PageSection title="My Presets">
      <ScreenerPresetManager
        key={managerKey}
        assetClass="stocks"
        userLogin={userLogin}
        currentFilter={currentFilter}
        onApplyPreset={(criteria: StockCriteriaState) => {
          onApplyPreset(criteria);
          onNavigateNewScreen();
        }}
      />
      </PageSection>

      <PageSection title="Starter presets (proposed)">
      {copyNotice && (
        <Notice tone="success" density="compact">{copyNotice}</Notice>
      )}
      {copyError && (
        <Notice tone="danger" density="compact">{copyError}</Notice>
      )}
      <div className="ui-stack-lg">
        {starters.map((starter) => (
          <Card key={starter.id} padding="md">
            <div className="ui-row">
              <h4>{starter.name}</h4>
              <Badge tone="neutral">proposed</Badge>
              <Badge tone="neutral">read-only</Badge>
            </div>
            {starter.criteria ? (
              <>
                <div className="ui-row">
                  {criteriaChips(starter.criteria).map((chip) => (
                    <Badge key={chip} tone="neutral">{chip}</Badge>
                  ))}
                </div>
                <div className="ui-row">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void copyStarter(starter)}
                    loading={copyingId === starter.id}
                  >
                    Copy to My Presets
                  </Button>
                </div>
              </>
            ) : (
              <p className="ui-meta">
                {starter.reason} Copy and apply are disabled until then — no threshold is invented here.
              </p>
            )}
          </Card>
        ))}
      </div>
      </PageSection>
    </div>
  );
}
