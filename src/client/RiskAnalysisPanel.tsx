import React, { useMemo, useState } from "react";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import {
  computeRiskProfile,
  type RiskSubject,
} from "./options/riskManagementEngine";
import {
  Button,
  Flex,
  Notice,
  PageShell,
  PageSection,
  Table,
  Tabs,
  TabPanel,
  TextInput,
  type TableColumn,
} from "./components/ui";

export interface RiskAnalysisPanelProps {
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

type RiskTab = "anatomy" | "playbook" | "scenarios" | "ai";

/**
 * RiskAnalysisPanel — standalone Risk Analysis page (issue #3087, epic
 * #3086). Risk analysis previously existed only as RiskAnalysisModal for
 * in-memory subjects (positions, ledger trades); this page builds a
 * RiskSubject from a symbol input and renders the existing
 * computeRiskProfile output inline — anatomy, defense playbook, scenario
 * matrix, and AI prompt — reusing the engine and the modal's tab
 * structure, not duplicating the math. The modal and the hub are
 * untouched; this page owns its own primitives-only presentation (no
 * modal markup, no inline styles, no new CSS).
 */
export function RiskAnalysisPanel({ onSendPrompt }: RiskAnalysisPanelProps) {
  const { activeTab, handleTabChange: setActiveTab } =
    useUrlSyncedTabs<RiskTab>({
      param: "riskTab",
      isValid: (v): v is RiskTab =>
        v === "anatomy" ||
        v === "playbook" ||
        v === "scenarios" ||
        v === "ai",
      defaultTab: "anatomy",
    });
  const [symbol, setSymbol] = useState("");
  const [price, setPrice] = useState("");
  const [accountNav, setAccountNav] = useState<number>(25000);
  const [subject, setSubject] = useState<RiskSubject | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  const profile = useMemo(
    () => (subject ? computeRiskProfile(subject) : null),
    [subject],
  );

  const handleAnalyze = () => {
    const cleanSymbol = symbol.trim().toUpperCase();
    if (!cleanSymbol) return;
    const parsedPrice = Number(price);
    setSubject({
      title: `${cleanSymbol} — Long Equity`,
      underlyingSymbol: cleanSymbol,
      underlyingPrice:
        price.trim() !== "" && Number.isFinite(parsedPrice) && parsedPrice > 0
          ? parsedPrice
          : undefined,
      strategyType: "Long Equity",
      sentiment: "bullish",
      quantity: 1,
      positionType: "EQUITY",
    });
    setCopiedPrompt(false);
  };

  const handleCopyPrompt = () => {
    if (!profile) return;
    try {
      void navigator.clipboard?.writeText(profile.playbook.aiPrompt);
      setCopiedPrompt(true);
    } catch {
      setCopiedPrompt(false);
    }
  };

  const anatomy = profile?.anatomy;
  const playbook = profile?.playbook;
  const scenarioMatrix = profile?.scenarioMatrix ?? [];
  const priceMissing = subject !== null && subject.underlyingPrice === undefined;

  type StatRow = { metric: string; value: string };
  const statColumns: TableColumn<StatRow>[] = [
    { key: "metric", header: "Metric", render: (r) => r.metric },
    { key: "value", header: "Value", render: (r) => r.value },
  ];
  const statRows: StatRow[] = anatomy
    ? [
        { metric: "Risk score", value: `${anatomy.riskScore}/100 • ${anatomy.riskLevel}` },
        { metric: "Capital at risk", value: anatomy.capitalAtRiskFormatted },
        { metric: "Max profit", value: anatomy.maxProfitFormatted },
        { metric: "Risk / reward", value: anatomy.riskRewardRatio },
        {
          metric: "Probability of profit",
          value:
            anatomy.probabilityOfProfit != null
              ? `${anatomy.probabilityOfProfit.toFixed(1)}%`
              : "Unavailable — no chain IV",
        },
        {
          metric: "Touch probability",
          value:
            anatomy.probabilityOfTouch != null
              ? `~${anatomy.probabilityOfTouch}%`
              : "—",
        },
        { metric: "Directional bias", value: anatomy.directionalBias },
        {
          metric: "Net delta",
          value: `Δ ${anatomy.netDelta >= 0 ? "+" : ""}${anatomy.netDelta.toFixed(2)} (${anatomy.dollarDelta.toFixed(0)}/pt)`,
        },
      ]
    : [];

  type GreekRow = { greek: string; value: string; interpretation: string };
  const greekColumns: TableColumn<GreekRow>[] = [
    { key: "greek", header: "Greek", render: (r) => r.greek },
    { key: "value", header: "Value", render: (r) => r.value },
    { key: "interpretation", header: "Interpretation", render: (r) => r.interpretation },
  ];
  const greekRows: GreekRow[] = anatomy
    ? [
        {
          greek: "DELTA (Δ)",
          value: `${anatomy.netDelta >= 0 ? "+" : ""}${anatomy.netDelta.toFixed(2)}`,
          interpretation: `$${Math.abs(anatomy.dollarDelta).toFixed(2)} P&L drift for each $1 move in underlying spot.`,
        },
        {
          greek: "GAMMA (Γ)",
          value: `${anatomy.netGamma >= 0 ? "+" : ""}${anatomy.netGamma.toFixed(3)}`,
          interpretation: anatomy.gammaRiskInterpretation,
        },
        {
          greek: "THETA (Θ)",
          value: `${anatomy.netTheta >= 0 ? "+" : ""}$${Math.abs(anatomy.netTheta * 100).toFixed(2)}/d`,
          interpretation: anatomy.thetaInterpretation,
        },
        {
          greek: "VEGA (ν)",
          value: `${anatomy.netVega >= 0 ? "+" : ""}$${Math.abs(anatomy.netVega * 100).toFixed(2)}/1% IV`,
          interpretation: anatomy.vegaInterpretation,
        },
      ]
    : [];

  type BreakevenRow = { label: string; price: string; buffer: string };
  const breakevenColumns: TableColumn<BreakevenRow>[] = [
    { key: "label", header: "Breakeven", render: (r) => r.label },
    { key: "price", header: "Price", render: (r) => r.price },
    { key: "buffer", header: "Buffer from spot", render: (r) => r.buffer },
  ];
  const breakevenRows: BreakevenRow[] = (anatomy?.breakevens ?? []).map(
    (be, idx) => ({
      label: `Breakeven #${idx + 1}`,
      price: `$${be.price.toFixed(2)}`,
      buffer:
        be.direction === "ABOVE"
          ? `+${be.distancePct}% above spot`
          : `-${be.distancePct}% below spot`,
    }),
  );

  type ScenarioRow = (typeof scenarioMatrix)[number];
  const scenarioColumns: TableColumn<ScenarioRow>[] = [
    {
      key: "scenario",
      header: "Shock Scenario",
      render: (p) => (
        <span>
          {p.spotChangePct > 0 ? `+${p.spotChangePct}%` : `${p.spotChangePct}%`}
          {p.spotChangePct === 0 ? " (Current Spot)" : ""}
        </span>
      ),
    },
    {
      key: "price",
      header: "Underlying Price",
      render: (p) => `$${p.spotPrice.toFixed(2)}`,
    },
    {
      key: "pnl",
      header: "Est. P&L",
      render: (p) =>
        `${p.estimatedPnL > 0 ? "+" : ""}$${p.estimatedPnL.toFixed(2)}`,
    },
    { key: "status", header: "Status", render: (p) => p.outcomeLabel },
  ];

  type AdjustmentRow = {
    name: string;
    trigger: string;
    action: string;
    protection: string;
  };
  const adjustmentColumns: TableColumn<AdjustmentRow>[] = [
    { key: "name", header: "Adjustment", render: (r) => r.name },
    { key: "trigger", header: "Trigger", render: (r) => r.trigger },
    { key: "action", header: "Action", render: (r) => r.action },
    { key: "protection", header: "How it protects", render: (r) => r.protection },
  ];
  const adjustmentRows: AdjustmentRow[] = (playbook?.adjustments ?? []).map(
    (adj) => ({
      name: adj.name,
      trigger: adj.trigger,
      action: adj.action,
      protection: adj.howItProtects,
    }),
  );

  const recommendedContracts = playbook
    ? playbook.recommendedMaxContracts(accountNav)
    : 0;

  return (
    <PageShell
      title="Risk Analysis"
      scopeNote="Symbol-based risk profile — computed locally by the risk engine; no position needed."
    >
      <PageSection title="Analyze a symbol">
        <Flex gap="2" align="end">
          <TextInput
            label="Symbol"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="e.g. AAPL"
          />
          <TextInput
            label="Underlying price (optional)"
            type="number"
            min="0"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Defaults to $100 spot"
          />
          <Button type="button" onClick={handleAnalyze} disabled={!symbol.trim()}>
            Analyze
          </Button>
        </Flex>
        {subject === null && (
          <Notice tone="info">
            Enter a symbol to build its risk profile. No broker position is
            needed — the profile is computed from the symbol alone.
          </Notice>
        )}
        {priceMissing && (
          <Notice tone="warning">
            No price entered — scenarios assume a $100 spot (the engine
            default). Enter a price for real levels.
          </Notice>
        )}
      </PageSection>

      {profile !== null && anatomy !== undefined && playbook !== undefined && (
        <>
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

          <TabPanel idBase="risk-analysis" tabId="anatomy" active={activeTab === "anatomy"}>
            <PageSection title="Risk profile">
              <Table columns={statColumns} rows={statRows} rowKey={(r) => r.metric} />
            </PageSection>
            <PageSection title="Institutional Greeks sensitivity matrix">
              <Table columns={greekColumns} rows={greekRows} rowKey={(r) => r.greek} />
            </PageSection>
            {breakevenRows.length > 0 && (
              <PageSection title="Breakeven safety cushions">
                <Table columns={breakevenColumns} rows={breakevenRows} rowKey={(r) => r.label} />
                {subject?.breakevenText && (
                  <Notice tone="info">Notes: {subject.breakevenText}</Notice>
                )}
              </PageSection>
            )}
            {anatomy.earlyAssignmentRisk.hasRisk && (
              <PageSection title="Early assignment & dividend alert">
                <Notice tone="warning">
                  Severity: {anatomy.earlyAssignmentRisk.severity} —{" "}
                  {anatomy.earlyAssignmentRisk.reasons.join(" ")}
                </Notice>
              </PageSection>
            )}
          </TabPanel>

          <TabPanel idBase="risk-analysis" tabId="playbook" active={activeTab === "playbook"}>
            <PageSection
              title="Risk-budgeted position sizing calculator"
              description={playbook.sizingRationale}
            >
              <Flex gap="2" align="end">
                <TextInput
                  label="Account portfolio NAV"
                  type="number"
                  min="1000"
                  step="1000"
                  value={accountNav}
                  onChange={(e) => setAccountNav(Number(e.target.value) || 0)}
                />
              </Flex>
              <Notice tone="info">
                {recommendedContracts} contract{recommendedContracts > 1 ? "s" : ""} maximum
                (≤{playbook.recommendedMaxAllocationPct}% risk budget = $
                {(accountNav * (playbook.recommendedMaxAllocationPct / 100)).toFixed(0)})
              </Notice>
            </PageSection>
            <PageSection
              title="Profit-taking rule"
              description={`${playbook.profitTakingRule.targetPct}% target — ${playbook.profitTakingRule.triggerPriceOrPnl}: ${playbook.profitTakingRule.actionText} — ${playbook.profitTakingRule.rationale}`}
            />
            <PageSection
              title="Stop-loss rule"
              description={`${playbook.stopLossRule.stopLossThreshold} — ${playbook.stopLossRule.triggerCondition}: ${playbook.stopLossRule.actionText} — ${playbook.stopLossRule.rationale}`}
            />
            {adjustmentRows.length > 0 && (
              <PageSection title="Tactical defense & adjustment plays">
                <Table columns={adjustmentColumns} rows={adjustmentRows} rowKey={(r) => r.name} />
              </PageSection>
            )}
          </TabPanel>

          <TabPanel idBase="risk-analysis" tabId="scenarios" active={activeTab === "scenarios"}>
            <PageSection title="Stress tests & tail shocks">
              <Table columns={scenarioColumns} rows={scenarioMatrix} rowKey={(r) => `${r.spotChangePct}`} />
            </PageSection>
          </TabPanel>

          <TabPanel idBase="risk-analysis" tabId="ai" active={activeTab === "ai"}>
            <PageSection
              title="AI risk dossier"
              description="Dispatch this tailored trade risk dossier directly to the multi-agent chat. The AI will evaluate market regime, Greeks drift, and formulate specific real-time defense actions."
            >
              <Notice tone="info">{playbook.aiPrompt}</Notice>
              <Flex gap="2">
                <Button type="button" onClick={handleCopyPrompt}>
                  {copiedPrompt ? "Copied" : "Copy prompt"}
                </Button>
                {onSendPrompt && (
                  <Button
                    type="button"
                    onClick={() => onSendPrompt(playbook.aiPrompt, "options-risk")}
                  >
                    Send to chat
                  </Button>
                )}
              </Flex>
            </PageSection>
          </TabPanel>
        </>
      )}
    </PageShell>
  );
}
