import { useState } from "react";
import { Button, Select, Table, TextInput, type TableColumn } from "../components/ui";
import { apiFetch as fetch } from "../apiFetch";
import type { ScreenedOptionContractItem } from "../../types";
import { buildPaymentSignature, describeChallenge, sendUsdcPayment, type PaidTransfer, type X402Challenge } from "../x402Pay";
import { OptionsDataDownloadDropdown } from "./OptionsDataDownloadDropdown";
import {
  defaultOptionsCriteria,
  optionsCriteriaToFilter,
  optionsFilterToCriteria,
  OptionsCriteriaPanel,
} from "../OptionsCriteriaPanel";
import { ScreenerPresetManager } from "../ScreenerPresetManager";
import type { TradeOrderContext } from "../trading/tradeOrderContext";
import { RiskAnalysisModal } from "./RiskAnalysisModal";
import type { RiskSubject } from "./riskManagementEngine";

interface RawContractsScreenerProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  initialSymbol?: string;
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
  onSelectContract?: (contract: ScreenedOptionContractItem) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

interface PendingPayment {
  challenge: X402Challenge;
  filters: Record<string, unknown>;
  paid?: PaidTransfer;
}

function numberFilter(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}

const POPULAR_SYMBOLS = ["NVDA", "TSLA", "SPY", "QQQ", "AAPL", "MSFT", "AMZN", "AMD"];

export function RawContractsScreener({
  activeEnv,
  userLogin,
  initialSymbol = "NVDA",
  onPreviewTrade,
  onSelectContract,
  onSendPrompt,
}: RawContractsScreenerProps) {
  const [riskSubject, setRiskSubject] = useState<RiskSubject | null>(null);
  const [symbol, setSymbol] = useState(initialSymbol);
  // Issue #1498 (#940-D): the six raw filter controls (contract type, DTE,
  // volume, open interest, spread) moved into OptionsCriteriaPanel, which
  // adds the remaining verified criteria (moneyness, strike distance,
  // premium, greeks, IV) as toggle rows. All panel rows default off, which
  // preserves the old form's behavior: omitted DTE falls back to the
  // engine defaults (0/90), an omitted type screens BOTH.
  const [optionsCriteria, setOptionsCriteria] = useState(defaultOptionsCriteria);
  const [lastSentOptionsFilters, setLastSentOptionsFilters] = useState<Record<string, unknown> | null>(null);
  const [maxResults, setMaxResults] = useState("5000");
  // Issue #959: sort keys are the canonical OptionScreenSortKey values
  // the engine actually implements. The previous "openInterest",
  // "impliedVolatility" and "strike" values were not engine sort keys —
  // the engine's sanitizer silently discarded them and every such
  // selection sorted by volume. "Open Interest" is dropped (no engine
  // comparator exists; adding one is an engine change, out of #959's
  // scope); IV maps to the canonical "iv" key and Strike to
  // "strikeDistance" (distance from spot), which now actually sort.
  const [sortBy, setSortBy] = useState<"volume" | "iv" | "spreadPct" | "strikeDistance">("volume");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [contracts, setContracts] = useState<ScreenedOptionContractItem[]>([]);
  const [summary, setSummary] = useState("");
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [reportUrl, setReportUrl] = useState<string | null>(null);

  // In-memory table search & filter
  const [tableSearch, setTableSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"ALL" | "CALL" | "PUT">("ALL");

  // Payment challenge state
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const [payStatus, setPayStatus] = useState("");

  const callScreen = async (filters: Record<string, unknown>, paymentSignature?: string) => {
    const response = await fetch("/api/trading/options/screen", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-environment": activeEnv,
        ...(userLogin ? { "x-user-login": userLogin } : {}),
        ...(paymentSignature ? { "PAYMENT-SIGNATURE": paymentSignature } : {}),
      },
      body: JSON.stringify({ ...filters, pushToSlack: true }),
    });

    const body = (await response.json()) as Record<string, any>;
    if (response.status === 402) {
      const challenge = body.protocols?.x402?.challenge as X402Challenge | undefined;
      if (!challenge) throw new Error(body.error || "Payment required, but no payment challenge was returned.");
      return {
        challenge,
        reason: paymentSignature ? (body.reason as string | undefined) : undefined,
        retryable: /not yet visible/i.test(String(body.reason || "")),
      };
    }

    const data = body as {
      error?: string;
      contracts?: ScreenedOptionContractItem[];
      filterSummary?: string;
      validationError?: string;
      totalUnderlyingsScanned?: number;
      totalContractsEvaluated?: number;
      matchedCount?: number;
      totalMatches?: number;
      scannedAt?: string;
      reportUrl?: string;
    };

    if (!response.ok) throw new Error(data.error || `Screening request failed [HTTP ${response.status}].`);
    if (data.validationError) throw new Error(data.validationError);

    const results = (data.contracts || []) as ScreenedOptionContractItem[];
    setContracts(results);
    setSummary(
      data.filterSummary ||
        `${data.totalContractsEvaluated ?? 0} evaluated · ${data.totalMatches ?? results.length} matching contracts (limit ${filters.limit})`
    );
    setScannedAt(data.scannedAt ? new Date(data.scannedAt).toLocaleTimeString() : new Date().toLocaleTimeString());
    setReportUrl(data.reportUrl || null);
    setPending(null);
    return null;
  };

  const runWithoutPaying = async () => {
    if (!pending || loading) return;
    setLoading(true);
    setError("");
    try {
      await callScreen(pending.filters);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screening failed.");
    } finally {
      setLoading(false);
    }
  };

  const payAndRun = async () => {
    if (!pending || loading) return;
    setLoading(true);
    setError("");
    try {
      let current = pending;
      for (let attempt = 0; attempt < 5; attempt++) {
        const paid = current.paid ?? (await sendUsdcPayment(current.challenge, setPayStatus));
        current = { ...current, paid };
        setPending(current);
        setPayStatus("Verifying payment…");
        const signature = await buildPaymentSignature(current.challenge, paid);
        const outcome = await callScreen(current.filters, signature);
        if (!outcome) return;
        if (!outcome.retryable) throw new Error(outcome.reason || "Payment could not be verified.");
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      throw new Error("Payment sent but not yet visible to the server. Click retry to verify.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Payment failed.");
    } finally {
      setLoading(false);
      setPayStatus("");
    }
  };

  const handleScreenSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!symbol.trim() || loading) return;
    setLoading(true);
    setError("");
    setContracts([]);
    setSummary("");
    setPending(null);

    try {
      const filters = {
        underlyingSymbols: [symbol.trim().toUpperCase()],
        limit: numberFilter(maxResults) ?? 5000,
        sortBy,
        ...optionsCriteriaToFilter(optionsCriteria),
      };
      setLastSentOptionsFilters(filters);

      const outcome = await callScreen(filters);
      if (outcome) setPending({ challenge: outcome.challenge, filters });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screening request failed.");
    } finally {
      setLoading(false);
    }
  };

  // Filter in-memory results
  const filteredContracts = contracts.filter((c) => {
    if (typeFilter !== "ALL" && c.optionType !== typeFilter) return false;
    if (tableSearch.trim()) {
      const query = tableSearch.toLowerCase();
      const matchSymbol = (c.symbol || c.displaySymbol || c.osiKey || "").toLowerCase().includes(query);
      const matchStrike = String(c.strikePrice).includes(query);
      const matchExpiry = (c.expirationDate || "").toLowerCase().includes(query);
      if (!matchSymbol && !matchStrike && !matchExpiry) return false;
    }
    return true;
  });


  type ContractRow = ScreenedOptionContractItem & {
    _idx: number;
    _isCall: boolean;
    _mid: number;
    _ivPct: string;
    _label: string;
  };
  const contractRows: ContractRow[] = filteredContracts.map((c, idx) => ({
    ...c,
    _idx: idx,
    _isCall: c.optionType === "CALL",
    _mid: Number(((c.bid + c.ask) / 2).toFixed(2)),
    _ivPct: c.impliedVolatility ? (c.impliedVolatility * 100).toFixed(1) : "—",
    _label: c.displaySymbol || c.symbol || c.osiKey || `Option #${idx + 1}`,
  }));
  const contractColumns: TableColumn<ContractRow>[] = [
    {
      key: "contract", header: "Contract", headerClassName: "sticky-head",
      render: (row) => (
        <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-muted)" }}>{row._label}</span>
      ),
    },
    {
      key: "type", header: "Type", headerClassName: "sticky-head",
      render: (row) => (
        <span
          style={{
            padding: "var(--space-0-5) var(--space-1-5)",
            fontWeight: 700,
            background: row._isCall ? "var(--color-success-subtle)" : "var(--color-danger-subtle)",
            color: row._isCall ? "var(--color-success)" : "var(--color-danger)",
            border: `1px solid ${row._isCall ? "var(--color-success)" : "var(--color-danger)"}`,
          }}
        >
          {row.optionType}
        </span>
      ),
    },
    {
      key: "strike", header: "Strike", headerClassName: "sticky-head",
      render: (row) => (
        <span style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>
          ${Number(row.strikePrice).toFixed(2)}
        </span>
      ),
    },
    {
      key: "moneyness", header: "Moneyness", headerClassName: "sticky-head",
      render: (row) => (
        <span
          style={{
            fontSize: "var(--font-size-caption)",
            padding: "var(--space-0-5) var(--space-1-5)",
            borderRadius: "var(--radius-xs, 3px)",
            background: row.moneyness === "ITM" ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
            color: row.moneyness === "ITM" ? "var(--color-accent)" : "var(--color-text-muted)",
          }}
        >
          {row.moneyness || "OTM"}
        </span>
      ),
    },
    {
      key: "expiration", header: "Expiration / DTE", headerClassName: "sticky-head",
      render: (row) => (
        <span>
          {row.expirationDate} <span style={{ color: "var(--color-text-dim)" }}>({row.daysToExpiration}d)</span>
        </span>
      ),
    },
    {
      key: "bid", header: "Bid", headerClassName: "sticky-head",
      render: (row) => <span>${Number(row.bid).toFixed(2)}</span>,
    },
    {
      key: "ask", header: "Ask", headerClassName: "sticky-head",
      render: (row) => <span>${Number(row.ask).toFixed(2)}</span>,
    },
    {
      key: "mid", header: "Mid", headerClassName: "sticky-head",
      render: (row) => <span style={{ fontWeight: 600 }}>${row._mid.toFixed(2)}</span>,
    },
    {
      key: "spread", header: "Spread %", headerClassName: "sticky-head",
      render: (row) => (
        <span style={{ color: row.spreadPct > 15 ? "var(--color-danger)" : "var(--color-text-secondary)" }}>
          {Number(row.spreadPct).toFixed(1)}%
        </span>
      ),
    },
    {
      key: "vol", header: "Vol", headerClassName: "sticky-head",
      render: (row) => <span style={{ fontWeight: 600 }}>{(row.volume ?? 0).toLocaleString()}</span>,
    },
    {
      key: "oi", header: "Open Int", headerClassName: "sticky-head",
      render: (row) => <span>{(row.openInterest ?? 0).toLocaleString()}</span>,
    },
    {
      key: "iv", header: "IV %", headerClassName: "sticky-head",
      render: (row) => <span>{row._ivPct}%</span>,
    },
    {
      key: "delta", header: "Delta", headerClassName: "sticky-head",
      render: (row) => (
        <span style={{ color: Number(row.delta) >= 0 ? "var(--color-success)" : "var(--color-danger)" }}>
          {row.delta !== undefined ? Number(row.delta).toFixed(3) : "—"}
        </span>
      ),
    },
    {
      key: "gamma", header: "Gamma", headerClassName: "sticky-head",
      render: (row) => <span>{row.gamma !== undefined ? Number(row.gamma).toFixed(4) : "—"}</span>,
    },
    {
      key: "theta", header: "Theta", headerClassName: "sticky-head",
      render: (row) => (
        <span style={{ color: "var(--color-danger)" }}>
          {row.theta !== undefined ? Number(row.theta).toFixed(3) : "—"}
        </span>
      ),
    },
    {
      key: "vega", header: "Vega", headerClassName: "sticky-head",
      render: (row) => <span>{row.vega !== undefined ? Number(row.vega).toFixed(3) : "—"}</span>,
    },
    {
      key: "action", header: "Action", headerClassName: "sticky-head",
      render: (row) => (
        <div style={{ display: "flex", gap: "var(--space-1)" }}>
          {onSelectContract && (
            <Button
              className="subnav-btn"
              style={{ padding: "var(--space-1) var(--space-1-5)", fontSize: "var(--font-size-caption)" }}
              title="Inspect in options tools"
              onClick={() => onSelectContract(row)}
            >
              Select
            </Button>
          )}
          <Button
            className="subnav-btn"
            style={{ padding: "var(--space-1) var(--space-1-5)", fontSize: "var(--font-size-caption)", borderColor: "var(--color-warning)", color: "var(--color-warning)" }}
            title="Analyze risk profile and mitigation playbook"
            onClick={() =>
              setRiskSubject({
                title: `${row.optionType} $${row.strikePrice} (${row.expirationDate})`,
                underlyingSymbol: row.underlyingSymbol,
                underlyingPrice: row.underlyingPrice,
                strategyType: `Long ${row.optionType}`,
                sentiment: row._isCall ? "bullish" : "bearish",
                expirationDate: row.expirationDate,
                dte: row.daysToExpiration,
                quantity: 1,
                netDebit: row._mid,
                maxProfit: row._isCall ? null : row.strikePrice * 100,
                maxLoss: row._mid * 100,
                chanceOfProfit: row._isCall ? (row.delta ? Math.min(99, Math.abs(row.delta) * 100) : 50) : (row.delta ? Math.min(99, Math.abs(row.delta) * 100) : 50),
                breakevens: [row._isCall ? Number((row.strikePrice + row._mid).toFixed(2)) : Number((row.strikePrice - row._mid).toFixed(2))],
                legs: [
                  {
                    side: "BUY",
                    action: "BUY",
                    optionType: row.optionType,
                    strike: row.strikePrice,
                    expirationDate: row.expirationDate,
                    entryPrice: row._mid,
                    bid: row.bid,
                    ask: row.ask,
                    iv: row.impliedVolatility,
                    delta: row.delta,
                    gamma: row.gamma,
                    theta: row.theta,
                    vega: row.vega,
                  },
                ],
                netGreeks: {
                  delta: row.delta,
                  gamma: row.gamma,
                  theta: row.theta,
                  vega: row.vega,
                },
                bid: row.bid,
                ask: row.ask,
                openInterest: row.openInterest,
                volume: row.volume,
              })
            }
          >
            🛡️ Risk
          </Button>
          {onPreviewTrade && (
            <Button
              className="subnav-btn"
              style={{ padding: "var(--space-1) var(--space-1-5)", fontSize: "var(--font-size-caption)", borderColor: "var(--color-accent)", color: "var(--color-accent)" }}
              title="Preview buy trade order"
              onClick={() =>
                onPreviewTrade({
                  assetClass: "options",
                  symbol: row.underlyingSymbol,
                  action: "BUY",
                  quantity: 1,
                  underlyingPrice: row.underlyingPrice,
                  label: `Buy 1x ${row._label} (${row.optionType} $${row.strikePrice})`,
                  legs: [`BUY 1 ${row._label} @ $${row._mid.toFixed(2)}`],
                  optionLegs: [{
                    securityType: "OPTN",
                    side: "BUY",
                    quantity: 1,
                    optionType: row.optionType,
                    strike: row.strikePrice,
                    expirationDate: row.expirationDate,
                  }],
                  strategyNetDebit: row._mid * 100,
                })
              }
            >
              Trade
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="raw-contracts-screener-view" style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      {/* Top Banner & Quick Underlying Chips */}
      <div
        style={{
          background: "var(--color-card)",
          border: "1px solid var(--color-accent-border)",
          borderRadius: "10px",
          padding: "var(--space-4) var(--space-5)",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-4)",
        }}
      >
        <div>
          <h3 style={{ margin: "0 0 0.25rem", fontSize: "var(--font-size-title-sm)", color: "var(--color-accent)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <span>📋 Raw Option Contracts Screener</span>
            <span style={{ fontSize: "var(--font-size-caption)", background: "var(--color-accent-subtle)", border: "1px solid var(--color-border-focus)", borderRadius: "var(--radius-xs, 4px)", padding: "var(--space-0-5) var(--space-2)", color: "var(--color-accent)" }}>
              Live E*TRADE Chains
            </span>
          </h3>
          <p style={{ margin: 0, fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
            Query live individual option contracts with implied volatility, bid/ask spreads, Greeks, and liquidity bounds.
          </p>
        </div>

        {/* Quick Ticker Chips */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1-5)", flexWrap: "wrap" }}>
          <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-dim)" }}>Quick symbols:</span>
          {POPULAR_SYMBOLS.map((s) => (
            <Button
              key={s}
              className="subnav-btn"
              style={{
                padding: "var(--space-1) var(--space-2-5)",
                fontSize: "var(--font-size-caption)",
                background: symbol.toUpperCase() === s ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
                borderColor: symbol.toUpperCase() === s ? "var(--color-border-focus)" : "var(--color-border-subtle)",
                color: symbol.toUpperCase() === s ? "var(--color-accent)" : "var(--color-text-secondary)",
              }}
              onClick={() => setSymbol(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      </div>

      {/* Screener Parameter Form */}
      <form
        className="options-request-form screeners-filter-form"
        onSubmit={(e) => void handleScreenSubmit(e)}
        style={{ margin: 0 }}
      >
        <TextInput label="Underlying Symbol"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          placeholder="e.g. NVDA, TSLA, SPY"
          required
          style={{ fontWeight: 600, letterSpacing: "0.05em" }}
        />

        <Select label="Sort By" value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}>
          <option value="volume">Volume (Highest First)</option>
          <option value="iv">Implied Volatility (IV)</option>
          <option value="spreadPct">Tightest Spread (%)</option>
          <option value="strikeDistance">Strike Distance</option>
        </Select>

        <TextInput label="Max Results (Limit)"
          type="number"
          min="10"
          max="10000"
          value={maxResults}
          onChange={(e) => setMaxResults(e.target.value)}
          placeholder="5000"
        />

        <div className="screener-criteria-presets-deck">
          <ScreenerPresetManager
            assetClass="options"
            userLogin={userLogin}
            currentFilter={optionsCriteriaToFilter(optionsCriteria)}
            filterToCriteria={optionsFilterToCriteria}
            onApplyPreset={setOptionsCriteria}
          />
          <OptionsCriteriaPanel
            criteria={optionsCriteria}
            onChange={setOptionsCriteria}
            lastSentFilters={lastSentOptionsFilters}
          />
        </div>
        <div className="options-form-footer" style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <Button type="submit" disabled={loading} style={{ minWidth: "180px", fontWeight: 600 }} loading={loading}>
            {`⚡ Screen ${symbol || "Options"} Contracts`}
          </Button>
        </div>
      </form>

      {/* Optional Payment Challenge */}
      {pending && (
        <div className="options-error" role="status" style={{ borderColor: "var(--color-accent)" }}>
          <p>
            <strong>Payment Optional (x402 Protocol).</strong> Pay ${pending.challenge.amount.toFixed(2)} {describeChallenge(pending.challenge).label} ({describeChallenge(pending.challenge).paymentPath.shortLabel}) or run for free.
          </p>
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "0.5rem" }}>
            <Button disabled={loading} onClick={() => void payAndRun()}>
              {loading ? payStatus || "Working…" : pending.paid ? "Retry Verification" : `Pay $${pending.challenge.amount.toFixed(2)} & Run`}
            </Button>
            {!pending.paid && (
              <Button disabled={loading} onClick={() => void runWithoutPaying()}>
                Skip Payment &amp; Run Free
              </Button>
            )}
          </div>
        </div>
      )}

      {error && <div className="options-error" role="alert">{error}</div>}

      {/* Results Header with In-Memory Filter and Exporter */}
      {(contracts.length > 0 || summary) && (
        <div
          style={{
            background: "var(--color-surface-sunken)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "8px",
            padding: "var(--space-3) var(--space-4)",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--space-3)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <span style={{ fontSize: "var(--font-size-body)", fontWeight: 600, color: "var(--color-text-primary)" }}>
              {summary || `${contracts.length} contracts retrieved`}
            </span>
            {scannedAt && (
              <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-muted)" }}>
                · Updated: {scannedAt}
              </span>
            )}
            {reportUrl && <a href={reportUrl} download>📄 Download this run’s PDF</a>}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
            {/* Type selector */}
            <div style={{ display: "flex", border: "1px solid var(--color-border-medium)", borderRadius: "6px", overflow: "hidden" }}>
              {(["ALL", "CALL", "PUT"] as const).map((t) => (
                <Button
                  key={t}
                  style={{
                    padding: "var(--space-1) var(--space-2-5)",
                    fontSize: "0.75rem",
                    border: "none",
                    background: typeFilter === t ? "var(--color-info-subtle)" : "transparent",
                    color: typeFilter === t ? "var(--color-accent)" : "var(--color-text-muted)",
                    cursor: "pointer",
                  }}
                  onClick={() => setTypeFilter(t)}
                >
                  {t}
                </Button>
              ))}
            </div>

            {/* In-table search input */}
            <TextInput
              type="text"
              placeholder="Filter by strike / expiry…"
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              style={{
                padding: "var(--space-1) var(--space-2-5)",
                fontSize: "var(--font-size-caption)",
                background: "var(--color-input)",
                border: "1px solid var(--color-input-border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--color-input-foreground)",
                width: "180px",
              }}
            />

            {/* Export Dropdown */}
            {contracts.length > 0 && (
              <OptionsDataDownloadDropdown
                symbol={symbol}
                activeEnv={activeEnv}
                userLogin={userLogin}
              />
            )}
          </div>
        </div>
      )}

      {/* Contracts Table */}
      {contracts.length > 0 && (
        <div className="options-table-scroll" style={{ maxHeight: "650px", overflowY: "auto", fontSize: "var(--font-size-body-sm)" }}>
          <Table
            columns={contractColumns}
            rows={contractRows}
            rowKey={(row) => `${row.symbol || row.displaySymbol || row.osiKey || row._idx}:${row._idx}`}
            className="options-comparison-table"
          />
        </div>
      )}

      {contracts.length === 0 && !loading && (
        <div
          style={{
            padding: "calc(var(--space-6) * 2) var(--space-6)",
            textAlign: "center",
            background: "var(--color-surface-sunken)",
            border: "1px dashed var(--color-border-subtle)",
            borderRadius: "var(--radius-md, 8px)",
            color: "var(--color-text-dim)",
          }}
        >
          <p style={{ margin: "0 0 0.5rem", fontSize: "var(--font-size-title-sm)", color: "var(--color-text-muted)" }}>
            No screened contracts loaded yet.
          </p>
          <p style={{ margin: 0, fontSize: "var(--font-size-body)" }}>
            Select an underlying symbol above and click <strong>Screen Contracts</strong> to stream live contracts from E*TRADE.
          </p>
        </div>
      )}

      {/* Risk Analysis & Management Playbook Modal */}
      <RiskAnalysisModal
        isOpen={Boolean(riskSubject)}
        onClose={() => setRiskSubject(null)}
        subject={riskSubject}
        onSendPrompt={onSendPrompt}
      />
    </div>
  );
}
