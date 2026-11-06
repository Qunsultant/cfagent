/**
 * DEPRECATED (issue #2954): superseded by src/client/OptionsHub.tsx.
 * The host's Symbol research / Autonomous runs toggle is flattened
 * into the copy hub's single tab row (Options Runs tab + research
 * modes), so nothing renders this host anymore. Kept, not deleted,
 * per the repo's deprecate-don't-delete rule.
 *
 * S8 (consolidation, umbrella #958): the options research host —
 * the "Symbol research / Autonomous runs" toggle over
 * OptionsResearchPanel and ResearchRunsPanel (issue #319: one
 * research-run surface for manual + scheduled runs). Extracted
 * verbatim from ETradeTradingHub, where it wrapped the hub's
 * "options" subtab, so the one screening hub (ScreenersHub) hosts
 * the identical surface; the Trading Hub's options subtab is now a
 * redirect into the hub.
 */
import { useState } from "react";
import { Button } from "../components/ui";
import { OptionsResearchPanel } from "./OptionsResearchPanel";
import { ResearchRunsPanel } from "./ResearchRunsPanel";
import type { TradeOrderContext } from "../trading/tradeOrderContext";

export interface OptionsResearchHostProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
  onJobStateChange?: (state: "idle" | "running" | "ready") => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

export function OptionsResearchHost({
  activeEnv,
  userLogin,
  onPreviewTrade,
  onJobStateChange,
  onSendPrompt,
}: OptionsResearchHostProps) {
  const [researchRunsView, setResearchRunsView] = useState<"symbol" | "runs">("symbol");
  return (
    <>
      {/* Issue #319: one research-run surface for manual + scheduled runs. */}
      <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: 8 }}>
        <Button
          onClick={() => setResearchRunsView("symbol")}
          style={{ fontWeight: researchRunsView === "symbol" ? 700 : 400 }}
        >
          Symbol research
        </Button>
        <Button
          onClick={() => setResearchRunsView("runs")}
          style={{ fontWeight: researchRunsView === "runs" ? 700 : 400 }}
        >
          Autonomous runs
        </Button>
      </div>
      {researchRunsView === "runs" ? (
        <ResearchRunsPanel
          activeEnv={activeEnv}
          userLogin={userLogin}
          onSendPrompt={onSendPrompt}
        />
      ) : (
        <OptionsResearchPanel
          activeEnv={activeEnv}
          userLogin={userLogin}
          onPreviewTrade={onPreviewTrade}
          onJobStateChange={onJobStateChange}
          onSendPrompt={onSendPrompt}
        />
      )}
    </>
  );
}
