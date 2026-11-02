import React, { useMemo, useState, useEffect } from "react";
import { useUrlSyncedTabs } from "../useUrlSyncedTabs";
import {
  computeRiskProfile,
  type RiskSubject,
  type ComprehensiveRiskProfile,
} from "./riskManagementEngine";
import "./riskAnalysis.css";
import { Button, Modal, Table, Tabs, TabPanel, TextInput, type TableColumn } from "../components/ui";

export interface RiskAnalysisModalProps {
  isOpen: boolean;
  onClose: () => void;
  subject: RiskSubject | null;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

export function RiskAnalysisModal({
  isOpen,
  onClose,
  subject,
  onSendPrompt,
}: RiskAnalysisModalProps) {
  // Deep links (#2776): the modal tabs live in `?riskTab=` via the shared
  // hook (aliased to the old activeTab/setActiveTab names, so the panels
  // below are untouched). The modal is host-dependent — the tab param is
  // read whenever the modal opens and written on every tab change — so a
  // link shared while the modal is open restores that tab on return.
  // Cold-load modal opening still needs host subject state (the subject
  // is an in-memory RiskSubject, not URL-addressable by id); the link
  // opens the host page, and the modal opens from there.
  const { activeTab, handleTabChange: setActiveTab } = useUrlSyncedTabs<
    "anatomy" | "playbook" | "scenarios" | "ai"
  >({
    param: "riskTab",
    isValid: (v): v is "anatomy" | "playbook" | "scenarios" | "ai" =>
      v === "anatomy" || v === "playbook" || v === "scenarios" || v === "ai",
    defaultTab: "anatomy",
  });
  const [accountNav, setAccountNav] = useState<number>(25000);
  const [copiedPrompt, setCopiedPrompt] = useState(false);


  const profile: ComprehensiveRiskProfile | null = useMemo(() => {
    if (!subject) return null;
    return computeRiskProfile(subject);
  }, [subject]);

  if (!isOpen || !subject || !profile) return null;

  const { anatomy, playbook, scenarioMatrix } = profile;
  type ScenarioRow = (typeof scenarioMatrix)[number];
  const scenarioColumns: TableColumn<ScenarioRow>[] = [
    { key: "scenario", header: "Shock Scenario",
      render: (p) => (
        <span style={{ fontWeight: 600 }}>
          {p.spotChangePct > 0 ? `+${p.spotChangePct}%` : `${p.spotChangePct}%`}
          {p.spotChangePct === 0 ? " (Current Spot)" : ""}
        </span>
      ) },
    { key: "price", header: "Underlying Price", render: (p) => `$${p.spotPrice.toFixed(2)}` },
    { key: "pnl", header: "Est. P&L",
      render: (p) => (
        <span
          style={{
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            fontSize: "var(--font-size-body)",
            color: p.estimatedPnL > 0 ? "var(--color-success)" : p.estimatedPnL < 0 ? "var(--color-danger)" : "var(--color-text-muted)",
          }}
        >
          {p.estimatedPnL > 0 ? "+" : ""}${p.estimatedPnL.toFixed(2)}
        </span>
      ) },
    { key: "status", header: "Status", render: (p) => p.outcomeLabel },
  ];
  const spot = subject.underlyingPrice ?? 100;
  const recommendedContracts = playbook.recommendedMaxContracts(accountNav);

  const handleCopyPrompt = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(playbook.aiPrompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2500);
    }
  };

  const handleSendToAiChat = (customPrompt?: string) => {
    const promptToSend = customPrompt || playbook.aiPrompt;
    if (onSendPrompt) {
      onSendPrompt(promptToSend, "options-risk");
      onClose();
    } else {
      handleCopyPrompt();
    }
  };

  return (
        <Modal open={isOpen} onClose={onClose} size="none" panelClassName="risk-modal-container" ariaLabel="Risk analysis">
        {/* Header */}
        <div className="risk-modal-header">
          <div className="risk-modal-title-group">
            <span className="risk-modal-icon-shield">🛡️</span>
            <div className="risk-modal-titles">
              <h2 className="risk-modal-h2">
                <span className="risk-symbol-badge">{subject.underlyingSymbol}</span>
                {subject.title || subject.strategyType || "Risk Management & Analysis"}
              </h2>
              <span className="risk-modal-subtitle">
                Spot: ${spot.toFixed(2)} • {subject.dte ? `${subject.dte.toFixed(0)} DTE` : "Active Trade"} • {subject.sentiment ? subject.sentiment.toUpperCase() : "Directional"}
              </span>
            </div>
          </div>

          <div className="risk-modal-header-actions">
            <span
              className="risk-level-badge"
              style={{
                background: `${anatomy.riskLevelColor}22`,
                color: anatomy.riskLevelColor,
                border: `1px solid ${anatomy.riskLevelColor}55`,
              }}
            >
              Risk Score: {anatomy.riskScore}/100 • {anatomy.riskLevel}
            </span>
            <Button
              variant="ghost"
              type="button"
              className="risk-modal-close-btn"
              onClick={onClose}
              title="Close Risk Analysis (Esc)"
              aria-label="Close"
            >
              ✕
            </Button>
          </div>
        </div>

        {/* Tab Navigation */}
        <Tabs
          idBase="risk-analysis"
          ariaLabel="Risk analysis views"
          tabs={[
            { id: "anatomy", icon: "📊", label: "What is Involved (Risk Anatomy)" },
            { id: "playbook", icon: "🛡️", label: "How to Manage (Defense Playbook)" },
            { id: "scenarios", icon: "📉", label: "Stress Tests & Tail Shocks" },
            { id: "ai", icon: "🤖", label: "AI Risk Manager (Chat)" },
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />

        {/* Body Content */}
        <div className="risk-modal-body">
          {/* Top Key Metrics Banner */}
          <div className="risk-stat-cards-grid">
            <div className={`risk-stat-card ${anatomy.riskProfileType === "UNDEFINED_RISK" ? "danger" : ""}`}>
              <span className="risk-stat-label">Capital at Risk / Max Loss</span>
              <span className="risk-stat-value" style={{ color: anatomy.riskProfileType === "UNDEFINED_RISK" ? "var(--color-danger)" : "var(--color-text-primary)" }}>
                {anatomy.capitalAtRiskFormatted}
              </span>
              <span className="risk-stat-sub">{anatomy.riskProfileType.replace("_", " ")}</span>
            </div>

            <div className="risk-stat-card highlight">
              <span className="risk-stat-label">Max Potential Profit</span>
              <span className="risk-stat-value" style={{ color: "var(--color-success)" }}>
                {anatomy.maxProfitFormatted}
              </span>
              <span className="risk-stat-sub">R:R Ratio {anatomy.riskRewardRatio}</span>
            </div>

            <div className="risk-stat-card">
              <span className="risk-stat-label">Probability of Profit (POP)</span>
              <span className="risk-stat-value" style={{ color: anatomy.probabilityOfProfit != null && anatomy.probabilityOfProfit >= 50 ? "var(--color-accent)" : "var(--color-warning)" }}>
                {anatomy.probabilityOfProfit != null ? `${anatomy.probabilityOfProfit.toFixed(1)}%` : "Unavailable — no chain IV"}
              </span>
              <span className="risk-stat-sub">Touch Prob: {anatomy.probabilityOfTouch != null ? `~${anatomy.probabilityOfTouch}%` : "—"}</span>
            </div>

            <div className="risk-stat-card">
              <span className="risk-stat-label">Directional Bias</span>
              <span className="risk-stat-value" style={{ fontSize: "var(--font-size-title-sm)" }}>
                {anatomy.directionalBias}
              </span>
              <span className="risk-stat-sub">
                Δ {anatomy.netDelta >= 0 ? "+" : ""}{anatomy.netDelta.toFixed(2)} (${anatomy.dollarDelta.toFixed(0)}/pt)
              </span>
            </div>
          </div>

          {/* TAB 1: WHAT IS INVOLVED (ANATOMY) */}
          <TabPanel idBase="risk-analysis" tabId="anatomy" active={activeTab === "anatomy"}>
            <>
              {/* Greeks Sensitivity Matrix */}
              <div className="risk-section-box">
                <div className="risk-section-header">
                  <h3 className="risk-section-title">
                    <span>⚡ Institutional Greeks Sensitivity Matrix</span>
                  </h3>
                  <span style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-dim)" }}>
                    Values per 1 unit contract lot
                  </span>
                </div>

                <div className="risk-greeks-grid">
                  <div className="risk-greek-item">
                    <div className="risk-greek-top">
                      <span className="risk-greek-name">DELTA (Δ)</span>
                      <span className="risk-greek-val" style={{ color: anatomy.netDelta >= 0 ? "var(--color-success)" : "var(--color-danger)" }}>
                        {anatomy.netDelta >= 0 ? "+" : ""}{anatomy.netDelta.toFixed(2)}
                      </span>
                    </div>
                    <div className="risk-greek-interpretation">
                      ${Math.abs(anatomy.dollarDelta).toFixed(2)} P&L drift for each $1 move in underlying spot.
                    </div>
                  </div>

                  <div className="risk-greek-item">
                    <div className="risk-greek-top">
                      <span className="risk-greek-name">GAMMA (Γ)</span>
                      <span className="risk-greek-val" style={{ color: anatomy.netGamma >= 0 ? "var(--color-accent)" : "var(--color-warning)" }}>
                        {anatomy.netGamma >= 0 ? "+" : ""}{anatomy.netGamma.toFixed(3)}
                      </span>
                    </div>
                    <div className="risk-greek-interpretation">
                      {anatomy.gammaRiskInterpretation}
                    </div>
                  </div>

                  <div className="risk-greek-item">
                    <div className="risk-greek-top">
                      <span className="risk-greek-name">THETA (Θ)</span>
                      <span className="risk-greek-val" style={{ color: anatomy.netTheta >= 0 ? "var(--color-success)" : "var(--color-danger)" }}>
                        {anatomy.netTheta >= 0 ? "+" : ""}${Math.abs(anatomy.netTheta * 100).toFixed(2)}/d
                      </span>
                    </div>
                    <div className="risk-greek-interpretation">
                      {anatomy.thetaInterpretation}
                    </div>
                  </div>

                  <div className="risk-greek-item">
                    <div className="risk-greek-top">
                      <span className="risk-greek-name">VEGA (ν)</span>
                      <span className="risk-greek-val" style={{ color: anatomy.netVega >= 0 ? "var(--color-sentiment-directional)" : "var(--color-text-muted)" }}>
                        {anatomy.netVega >= 0 ? "+" : ""}${Math.abs(anatomy.netVega * 100).toFixed(2)}/1% IV
                      </span>
                    </div>
                    <div className="risk-greek-interpretation">
                      {anatomy.vegaInterpretation}
                    </div>
                  </div>
                </div>
              </div>

              {/* Breakeven Safety Boundaries */}
              <div className="risk-section-box">
                <div className="risk-section-header">
                  <h3 className="risk-section-title">
                    <span>🎯 Breakeven Safety Cushions</span>
                  </h3>
                  <span style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
                    Spot: ${spot.toFixed(2)}
                  </span>
                </div>

                <div className="risk-breakevens-list">
                  {anatomy.breakevens.map((be, idx) => (
                    <div key={idx} className="risk-breakeven-pill">
                      <span>Breakeven #{idx + 1}:</span>
                      <span className="risk-be-price">${be.price.toFixed(2)}</span>
                      <span className={`risk-be-buffer ${be.direction.toLowerCase()}`}>
                        {be.direction === "ABOVE" ? `+${be.distancePct}% above spot` : `-${be.distancePct}% below spot`}
                      </span>
                    </div>
                  ))}
                  {subject.breakevenText && (
                    <div style={{ width: "100%", fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)", marginTop: "0.3rem" }}>
                      Notes: {subject.breakevenText}
                    </div>
                  )}
                </div>
              </div>

              {/* Early Assignment & Pin Risk Warning */}
              {anatomy.earlyAssignmentRisk.hasRisk && (
                <div className={`risk-warning-callout ${anatomy.earlyAssignmentRisk.severity.toLowerCase()}`}>
                  <div className="risk-warning-title">
                    <span>⚠️ American Option Early Assignment &amp; Dividend Alert</span>
                    <span style={{ fontSize: "0.75rem", textTransform: "uppercase", marginLeft: "auto", fontWeight: 800 }}>
                      Severity: {anatomy.earlyAssignmentRisk.severity}
                    </span>
                  </div>
                  <ul className="risk-warning-list">
                    {anatomy.earlyAssignmentRisk.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          </TabPanel>

          {/* TAB 2: HOW TO MANAGE (DEFENSE PLAYBOOK) */}
          <TabPanel idBase="risk-analysis" tabId="playbook" active={activeTab === "playbook"}>
            <>
              {/* Dynamic Position Sizing Calculator */}
              <div className="risk-sizing-calculator">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <h4 style={{ margin: 0, fontSize: "var(--font-size-body)", fontWeight: 700, color: "var(--color-text-primary)" }}>
                      📐 Risk-Budgeted Position Sizing Calculator
                    </h4>
                    <span style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
                      {playbook.sizingRationale}
                    </span>
                  </div>
                </div>

                <div className="risk-sizing-input-row">
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                    <span style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-secondary)" }}>Account Portfolio NAV:</span>
                    <div className="risk-sizing-input-wrap">
                      <span>$</span>
                      <TextInput
                        type="number"
                        min="1000"
                        step="1000"
                        value={accountNav}
                        onChange={(e) => setAccountNav(Math.max(500, Number(e.target.value) || 0))}
                      />
                    </div>
                  </div>

                  <div className="risk-sizing-result">
                    <span style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-secondary)" }}>Max Recommended Size:</span>
                    <span className="risk-sizing-contracts-val">
                      {recommendedContracts} contract{recommendedContracts > 1 ? "s" : ""}
                    </span>
                    <span style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
                      (≤{playbook.recommendedMaxAllocationPct}% risk budget = ${(accountNav * (playbook.recommendedMaxAllocationPct / 100)).toFixed(0)})
                    </span>
                  </div>
                </div>
              </div>

              {/* Profit & Stop Loss Rules Grid */}
              <div className="risk-playbook-cards">
                <div className="risk-rule-card profit">
                  <div className="risk-rule-header">
                    <span className="risk-rule-tag profit">🟢 Profit Taking Rule</span>
                    <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-success)", fontWeight: 700 }}>
                      Target: {playbook.profitTakingRule.targetPct}%
                    </span>
                  </div>
                  <div className="risk-rule-trigger">
                    {playbook.profitTakingRule.triggerPriceOrPnl}
                  </div>
                  <div className="risk-rule-action">
                    {playbook.profitTakingRule.actionText}
                  </div>
                  <div className="risk-rule-rationale">
                    💡 {playbook.profitTakingRule.rationale}
                  </div>
                </div>

                <div className="risk-rule-card stop">
                  <div className="risk-rule-header">
                    <span className="risk-rule-tag stop">🔴 Capital Preservation Stop-Loss</span>
                    <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-danger)", fontWeight: 700 }}>
                      Defense Trigger
                    </span>
                  </div>
                  <div className="risk-rule-trigger">
                    {playbook.stopLossRule.stopLossThreshold}
                  </div>
                  <div className="risk-rule-action">
                    {playbook.stopLossRule.actionText}
                  </div>
                  <div className="risk-rule-rationale">
                    🛡️ {playbook.stopLossRule.rationale}
                  </div>
                </div>
              </div>

              {/* Tactical Adjustments & Rolling Playbook */}
              <div className="risk-section-box">
                <div className="risk-section-header">
                  <h3 className="risk-section-title">
                    <span>🔄 Tactical Defense &amp; Rolling Playbook</span>
                  </h3>
                  <span style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-accent)" }}>
                    How to defend the trade when challenged
                  </span>
                </div>

                <div className="risk-adjustments-list">
                  {playbook.adjustments.map((adj, idx) => (
                    <div key={idx} className="risk-adjustment-card">
                      <div className="risk-adj-name">
                        <span>🛡️ {adj.name}</span>
                      </div>
                      <div className="risk-adj-row">
                        <span className="risk-adj-label">When to Trigger:</span>
                        <span className="risk-adj-value" style={{ color: "var(--color-warning)" }}>{adj.trigger}</span>
                      </div>
                      <div className="risk-adj-row">
                        <span className="risk-adj-label">Action:</span>
                        <span className="risk-adj-value">{adj.action}</span>
                      </div>
                      <div className="risk-adj-row">
                        <span className="risk-adj-label">Protection:</span>
                        <span className="risk-adj-value" style={{ color: "var(--color-accent)" }}>{adj.howItProtects}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          </TabPanel>

          {/* TAB 3: STRESS TESTS & SCENARIOS */}
          <TabPanel idBase="risk-analysis" tabId="scenarios" active={activeTab === "scenarios"}>
            <div className="risk-section-box">
              <div className="risk-section-header">
                <h3 className="risk-section-title">
                  <span>📉 Multi-Point Spot &amp; Tail Shock Stress Test</span>
                </h3>
                <span style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
                  Estimated P&L under sudden market moves
                </span>
              </div>

              <Table
                className="risk-scenario-table"
                columns={scenarioColumns}
                rows={scenarioMatrix}
                rowKey={(row) => String(row.spotChangePct)}
                rowClassName={(row) => (row.spotChangePct === 0 ? "spot-row" : "")}
              />

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)", marginTop: "1rem" }}>
                <div className="risk-tail-box">
                  <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", textTransform: "uppercase", fontWeight: 700 }}>
                    Tail Shock: -20% Flash Crash
                  </span>
                  <div style={{ fontSize: "var(--font-size-title)", fontWeight: 800, color: anatomy.tailShockDown20Pct >= 0 ? "var(--color-success)" : "var(--color-danger)", marginTop: "0.2rem" }}>
                    {anatomy.tailShockDown20Pct >= 0 ? "+" : ""}${anatomy.tailShockDown20Pct.toLocaleString()}
                  </div>
                </div>

                <div className="risk-tail-box">
                  <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", textTransform: "uppercase", fontWeight: 700 }}>
                    Tail Shock: +20% Squeeze
                  </span>
                  <div style={{ fontSize: "var(--font-size-title)", fontWeight: 800, color: anatomy.tailShockUp20Pct >= 0 ? "var(--color-success)" : "var(--color-danger)", marginTop: "0.2rem" }}>
                    {anatomy.tailShockUp20Pct >= 0 ? "+" : ""}${anatomy.tailShockUp20Pct.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>
          </TabPanel>

          {/* TAB 4: ASK AI AGENT */}
          <TabPanel idBase="risk-analysis" tabId="ai" active={activeTab === "ai"}>
            <div className="risk-ai-card">
              <div className="risk-ai-header">
                <h3 className="risk-ai-title">
                  <span>🤖 Ask AI Assistant to Manage This Trade</span>
                </h3>
                <span style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
                  Autonomous Agent Risk Orchestration
                </span>
              </div>

              <p style={{ margin: 0, fontSize: "var(--font-size-body)", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                Dispatch this tailored trade risk dossier directly to the multi-agent chat. The AI will evaluate market regime, Greeks drift, and formulate specific real-time defense actions:
              </p>

              <div className="risk-ai-prompt-box">
                {playbook.aiPrompt}
              </div>

              <div className="risk-ai-actions">
                <Button
                  type="button"
                  className="risk-btn-ask-ai"
                  onClick={() => handleSendToAiChat()}
                >
                  💬 Send Prompt to AI Chat
                </Button>
                <Button
                  type="button"
                  className="risk-btn-copy-prompt"
                  onClick={handleCopyPrompt}
                >
                  {copiedPrompt ? "✓ Copied to Clipboard!" : "📋 Copy Prompt"}
                </Button>
              </div>

              <div style={{ marginTop: "0.5rem" }}>
                <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-muted)", fontWeight: 700, display: "block", marginBottom: "0.4rem" }}>
                  Quick Question Presets:
                </span>
                <div className="risk-chips-carousel">
                  <Button
                    type="button"
                    className="risk-prompt-chip"
                    onClick={() => handleSendToAiChat(`How do I roll ${subject.underlyingSymbol} ${subject.strategyType || "trade"} if the short strike is breached?`)}
                  >
                    🔄 How do I roll if tested?
                  </Button>
                  <Button
                    type="button"
                    className="risk-prompt-chip"
                    onClick={() => handleSendToAiChat(`What is the optimal delta hedge for ${subject.underlyingSymbol} with Delta ${anatomy.netDelta.toFixed(2)}?`)}
                  >
                    ⚖️ How to delta hedge this?
                  </Button>
                  <Button
                    type="button"
                    className="risk-prompt-chip"
                    onClick={() => handleSendToAiChat(`Calculate protective collar or put wing costs for ${subject.underlyingSymbol}.`)}
                  >
                    🛡️ Protective collar cost?
                  </Button>
                  <Button
                    type="button"
                    className="risk-prompt-chip"
                    onClick={() => handleSendToAiChat(`What happens to this ${subject.underlyingSymbol} trade under an IV crush after earnings?`)}
                  >
                    📉 Impact of IV Crush?
                  </Button>
                </div>
              </div>
            </div>
          </TabPanel>
        </div>
          </Modal>
  );
}
