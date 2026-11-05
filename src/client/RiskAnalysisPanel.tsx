import React, { useEffect, useMemo, useRef, useState } from "react";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import {
  computeRiskProfile,
  type RiskLeg,
  type RiskSubject,
} from "./options/riskManagementEngine";
import {
  Button,
  Card,
  Flex,
  Grid,
  Notice,
  PageTemplate,
  Select,
  Stack,
  Table,
  Tabs,
  TabPanel,
  TextInput,
  type TableColumn,
} from "./components/ui";

export interface RiskAnalysisPanelProps {
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  /**
   * Ticket seed (issue #3125): when present, the analysis starts from
   * this subject — the order page's Risk tab passes the live ticket.
   * Data, not chrome: the host decides chrome via PageChromeContext,
   * so this prop never changes how the panel is composed.
   */
  seededSubject?: RiskSubject | null;
  /** Changes when the seed changes (ticket edits, asset switches). */
  seedKey?: string;
}

type RiskTab = "anatomy" | "playbook" | "scenarios" | "ai";

type SecurityType = "stock" | "options";

/** One leg of the manual options input (strings until Analyze parses). */
interface RiskLegInput {
  side: "BUY" | "SELL";
  optionType: "CALL" | "PUT";
  strike: string;
  expirationDate: string;
  quantity: number;
  iv: string;
}

const EMPTY_LEG: RiskLegInput = {
  side: "BUY",
  optionType: "CALL",
  strike: "",
  expirationDate: "",
  quantity: 1,
  iv: "",
};

function singleLegName(leg: RiskLegInput): string {
  if (leg.optionType === "CALL") return leg.side === "BUY" ? "Long Call" : "Short Call";
  return leg.side === "BUY" ? "Long Put" : "Short Put";
}

/**
 * Card header in the order-workspace pattern: distributed row, bold
 * title left, muted meta right. Built from the Flex primitive only —
 * the same header treatment the order ticket's form card uses.
 */
function CardHeader({ title, meta }: { title: string; meta?: string }) {
  return (
    <Flex justify="between" align="start" gap="2">
      <strong>{title}</strong>
      {meta && <span>{meta}</span>}
    </Flex>
  );
}

/** Label/value row in the calc-card pattern (summary surfaces). */
function SummaryRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Flex justify="between" align="start" gap="2">
      <span>{label}</span>
      {strong ? <strong>{value}</strong> : <span>{value}</span>}
    </Flex>
  );
}

/**
 * RiskAnalysisPanel — the Risk Analysis page (issue #3087, epic #3086),
 * redesigned to the order-workspace pattern (issue #3125): a form card
 * for input, a summary card with the headline numbers, a responsive
 * grid, and a card per content block — the same composition the stock
 * and options order pages use, not a stack of full-width tables.
 *
 * The panel owns its PageTemplate and nothing else about chrome: the host
 * decides how that shell renders via PageChromeContext (standalone
 * route → full shell; order page Risk tab → content only; nested host
 * → card surface). The SAME component renders in all three hosts with
 * zero changes to itself. Risk analysis previously existed only as
 * RiskAnalysisModal for in-memory subjects; this panel builds a
 * RiskSubject from typed input (stock or multi-leg options) and renders
 * the existing computeRiskProfile output inline — reusing the engine
 * and the modal's tab structure, not duplicating the math.
 */
export function RiskAnalysisPanel({
  onSendPrompt,
  seededSubject = null,
  seedKey = "manual",
}: RiskAnalysisPanelProps) {
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
  const [securityType, setSecurityType] = useState<SecurityType>("stock");
  const [legs, setLegs] = useState<RiskLegInput[]>([{ ...EMPTY_LEG }]);
  const [accountNav, setAccountNav] = useState<number>(25000);
  const [subject, setSubject] = useState<RiskSubject | null>(seededSubject);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  // A new seed (ticket edited, asset switched) replaces the analysis;
  // manual analysis is untouched while the seed is unchanged.
  const prevSeedKeyRef = useRef(seedKey);
  useEffect(() => {
    if (prevSeedKeyRef.current === seedKey) return;
    prevSeedKeyRef.current = seedKey;
    setSubject(seededSubject);
    setCopiedPrompt(false);
  }, [seedKey, seededSubject]);

  const profile = useMemo(
    () => (subject ? computeRiskProfile(subject) : null),
    [subject],
  );

  const validLegCount = legs.filter((leg) => {
    const strike = Number(leg.strike);
    return Number.isFinite(strike) && strike > 0;
  }).length;

  const handleAnalyze = () => {
    const cleanSymbol = symbol.trim().toUpperCase();
    if (!cleanSymbol) return;
    const parsedPrice = Number(price);
    const underlyingPrice =
      price.trim() !== "" && Number.isFinite(parsedPrice) && parsedPrice > 0
        ? parsedPrice
        : undefined;
    if (securityType === "stock") {
      setSubject({
        title: `${cleanSymbol} — Long Equity`,
        underlyingSymbol: cleanSymbol,
        underlyingPrice,
        strategyType: "Long Equity",
        sentiment: "bullish",
        quantity: 1,
        positionType: "EQUITY",
      });
    } else {
      const riskLegs: RiskLeg[] = legs
        .filter((leg) => {
          const strike = Number(leg.strike);
          return Number.isFinite(strike) && strike > 0;
        })
        .map((leg) => {
          const iv = Number(leg.iv);
          return {
            side: leg.side,
            optionType: leg.optionType,
            strike: Number(leg.strike),
            expirationDate: leg.expirationDate || undefined,
            quantity: Math.max(1, leg.quantity || 1),
            iv:
              leg.iv.trim() !== "" && Number.isFinite(iv) && iv > 0
                ? iv
                : undefined,
          };
        });
      if (riskLegs.length === 0) return;
      const name =
        riskLegs.length === 1 ? singleLegName(legs[0]) : "Custom multi-leg";
      setSubject({
        title: `${cleanSymbol} — ${name}`,
        underlyingSymbol: cleanSymbol,
        underlyingPrice,
        strategyType: name,
        sentiment:
          riskLegs.length === 1
            ? riskLegs[0].optionType === "CALL"
              ? "bullish"
              : "bearish"
            : "neutral",
        quantity: riskLegs.reduce((sum, leg) => sum + (leg.quantity ?? 1), 0),
        positionType: riskLegs.length === 1 ? "OPTION" : "MULTI_LEG",
        legs: riskLegs,
      });
    }
    setCopiedPrompt(false);
  };

  const updateLeg = (index: number, patch: Partial<RiskLegInput>) => {
    setLegs((current) =>
      current.map((leg, i) => (i === index ? { ...leg, ...patch } : leg)),
    );
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

  const analyzeDisabled =
    !symbol.trim() || (securityType === "options" && validLegCount === 0);

  return (
    <PageTemplate
      title="Risk Analysis"
      scopeNote="Symbol-based risk profile — computed locally by the risk engine; no position needed."
    >
      <Stack gap="4">
        <Card>
          <Stack gap="3">
            <CardHeader title="Analyze a symbol" meta="No broker position needed" />
            <Flex gap="2" align="end" wrap>
              <Select
                label="Security type"
                value={securityType}
                onChange={(e) => setSecurityType(e.target.value as SecurityType)}
              >
                <option value="stock">Stock</option>
                <option value="options">Options</option>
              </Select>
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
              <Button type="button" onClick={handleAnalyze} disabled={analyzeDisabled}>
                Analyze
              </Button>
            </Flex>
            {securityType === "options" && (
              <Stack gap="2">
                {legs.map((leg, index) => (
                  <Flex key={index} gap="2" align="end" wrap>
                    <Select
                      label="Side"
                      value={leg.side}
                      onChange={(e) =>
                        updateLeg(index, { side: e.target.value as "BUY" | "SELL" })
                      }
                    >
                      <option value="BUY">BUY</option>
                      <option value="SELL">SELL</option>
                    </Select>
                    <Select
                      label="Type"
                      value={leg.optionType}
                      onChange={(e) =>
                        updateLeg(index, { optionType: e.target.value as "CALL" | "PUT" })
                      }
                    >
                      <option value="CALL">CALL</option>
                      <option value="PUT">PUT</option>
                    </Select>
                    <TextInput
                      label="Strike ($)"
                      type="number"
                      min="0.01"
                      step="0.5"
                      value={leg.strike}
                      onChange={(e) => updateLeg(index, { strike: e.target.value })}
                    />
                    <TextInput
                      label="Expiration"
                      type="date"
                      value={leg.expirationDate}
                      onChange={(e) => updateLeg(index, { expirationDate: e.target.value })}
                    />
                    <TextInput
                      label="Quantity"
                      type="number"
                      min="1"
                      step="1"
                      value={leg.quantity}
                      onChange={(e) =>
                        updateLeg(index, { quantity: Math.max(1, Number.parseInt(e.target.value, 10) || 1) })
                      }
                    />
                    <TextInput
                      label="IV (optional)"
                      type="number"
                      min="0"
                      step="0.01"
                      value={leg.iv}
                      onChange={(e) => updateLeg(index, { iv: e.target.value })}
                    />
                    <Button
                      type="button"
                      onClick={() => setLegs((current) => current.filter((_, i) => i !== index))}
                      disabled={legs.length <= 1}
                    >
                      Remove
                    </Button>
                  </Flex>
                ))}
                <Flex gap="2">
                  <Button type="button" onClick={() => setLegs((current) => [...current, { ...EMPTY_LEG }])}>
                    Add leg
                  </Button>
                </Flex>
                <Notice tone="info">
                  Greeks need chain IV per leg — legs without IV are excluded
                  from Greek sums, never modeled with an assumed constant.
                  Structure, breakevens, and scenarios still compute.
                </Notice>
              </Stack>
            )}
          </Stack>
        </Card>
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

        {profile !== null && anatomy !== undefined && playbook !== undefined && subject !== null && (
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
              <Stack gap="4">
                <Grid autoFit minColumnWidth="md" gap="4">
                  <Card>
                    <Stack gap="2">
                      <CardHeader title="Risk profile" meta={subject.title} />
                      <SummaryRow
                        label="Underlying"
                        value={
                          subject.underlyingPrice !== undefined
                            ? `${subject.underlyingSymbol} @ $${subject.underlyingPrice.toFixed(2)}`
                            : `${subject.underlyingSymbol} @ $100 spot (assumed)`
                        }
                      />
                      <SummaryRow
                        label="Risk score"
                        value={`${anatomy.riskScore}/100 • ${anatomy.riskLevel}`}
                        strong
                      />
                      <SummaryRow label="Capital at risk" value={anatomy.capitalAtRiskFormatted} />
                      <SummaryRow label="Max profit" value={anatomy.maxProfitFormatted} />
                      <SummaryRow label="Risk / reward" value={anatomy.riskRewardRatio} />
                      <SummaryRow
                        label="Net delta"
                        value={`Δ ${anatomy.netDelta >= 0 ? "+" : ""}${anatomy.netDelta.toFixed(2)} (${anatomy.dollarDelta.toFixed(0)}/pt)`}
                      />
                      <SummaryRow
                        label="Probability of profit"
                        value={
                          anatomy.probabilityOfProfit != null
                            ? `${anatomy.probabilityOfProfit.toFixed(1)}%`
                            : "Unavailable — no chain IV"
                        }
                      />
                      <SummaryRow
                        label="Touch probability"
                        value={
                          anatomy.probabilityOfTouch != null
                            ? `~${anatomy.probabilityOfTouch}%`
                            : "—"
                        }
                      />
                      <SummaryRow label="Directional bias" value={anatomy.directionalBias} />
                    </Stack>
                  </Card>
                  {breakevenRows.length > 0 && (
                    <Card>
                      <Stack gap="3">
                        <CardHeader title="Breakeven safety cushions" />
                        <Table columns={breakevenColumns} rows={breakevenRows} rowKey={(r) => r.label} />
                        {subject.breakevenText && (
                          <Notice tone="info">Notes: {subject.breakevenText}</Notice>
                        )}
                      </Stack>
                    </Card>
                  )}
                </Grid>
                <Card>
                  <Stack gap="3">
                    <CardHeader title="Institutional Greeks sensitivity matrix" />
                    <Table columns={greekColumns} rows={greekRows} rowKey={(r) => r.greek} />
                    {anatomy.missingIvLegs != null && anatomy.missingIvLegs > 0 && (
                      <Notice tone="warning">
                        {anatomy.missingIvLegs} leg(s) excluded from Greek sums —
                        no chain IV supplied. Structure, breakevens, and scenarios
                        still compute; Greeks cover only legs with IV.
                      </Notice>
                    )}
                    {anatomy.greeksSource === "estimated" && (
                      <Notice tone="info">
                        Greeks modeled via Black-Scholes from supplied chain IV,
                        not broker-provided.
                      </Notice>
                    )}
                    {anatomy.greeksSource === "heuristic" && (
                      <Notice tone="info">
                        Greeks estimated from strategy heuristics — supply chain IV
                        per leg for modeled Greeks.
                      </Notice>
                    )}
                  </Stack>
                </Card>
                {anatomy.earlyAssignmentRisk.hasRisk && (
                  <Card>
                    <Stack gap="3">
                      <CardHeader title="Early assignment & dividend alert" />
                      <Notice tone="warning">
                        Severity: {anatomy.earlyAssignmentRisk.severity} —{" "}
                        {anatomy.earlyAssignmentRisk.reasons.join(" ")}
                      </Notice>
                    </Stack>
                  </Card>
                )}
              </Stack>
            </TabPanel>

            <TabPanel idBase="risk-analysis" tabId="playbook" active={activeTab === "playbook"}>
              <Stack gap="4">
                <Grid autoFit minColumnWidth="md" gap="4">
                  <Card>
                    <Stack gap="3">
                      <CardHeader title="Risk-budgeted position sizing" />
                      <span>{playbook.sizingRationale}</span>
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
                    </Stack>
                  </Card>
                  <Card>
                    <Stack gap="3">
                      <CardHeader title="Profit-taking rule" meta={`${playbook.profitTakingRule.targetPct}% target`} />
                      <span>
                        {playbook.profitTakingRule.triggerPriceOrPnl}: {playbook.profitTakingRule.actionText} — {playbook.profitTakingRule.rationale}
                      </span>
                    </Stack>
                  </Card>
                  <Card>
                    <Stack gap="3">
                      <CardHeader title="Stop-loss rule" meta={playbook.stopLossRule.stopLossThreshold} />
                      <span>
                        {playbook.stopLossRule.triggerCondition}: {playbook.stopLossRule.actionText} — {playbook.stopLossRule.rationale}
                      </span>
                    </Stack>
                  </Card>
                </Grid>
                {adjustmentRows.length > 0 && (
                  <Card>
                    <Stack gap="3">
                      <CardHeader title="Tactical defense & adjustment plays" />
                      <Table columns={adjustmentColumns} rows={adjustmentRows} rowKey={(r) => r.name} />
                    </Stack>
                  </Card>
                )}
              </Stack>
            </TabPanel>

            <TabPanel idBase="risk-analysis" tabId="scenarios" active={activeTab === "scenarios"}>
              <Card>
                <Stack gap="3">
                  <CardHeader title="Stress tests & tail shocks" />
                  <Table columns={scenarioColumns} rows={scenarioMatrix} rowKey={(r) => `${r.spotChangePct}`} />
                </Stack>
              </Card>
            </TabPanel>

            <TabPanel idBase="risk-analysis" tabId="ai" active={activeTab === "ai"}>
              <Card>
                <Stack gap="3">
                  <CardHeader title="AI risk dossier" meta="Dispatch to the multi-agent chat" />
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
                </Stack>
              </Card>
            </TabPanel>
          </>
        )}
      </Stack>
    </PageTemplate>
  );
}
