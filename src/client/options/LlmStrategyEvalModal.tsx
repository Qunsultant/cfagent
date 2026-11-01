import React, { useEffect, useState } from "react";
import { apiFetch as fetch } from "../apiFetch";
import {
  downloadRawOptionsIdeasXls,
  downloadOptionsIdeasReportXls,
  downloadRetrievedOptionsDataXls,
  type OptionsIdeasReportExport,
  type RawOptionsIdeasExport,
  type RetrievedOptionsDataExport,
} from "../runExport";
import type { TradeOrderContext, TradeOrderLeg } from "../trading/tradeOrderContext";
import "./strategyDiscovery.css";

import { Button, Modal, TextInput, FieldShell } from "../components/ui";
export interface StrategyToEvaluate {
  symbol: string;
  strategyName: string;
  sentiment?: string;
  targetPrice?: number;
  expirationDate?: string;
  dte?: number;
  legsText?: string;
  netDebit?: number;
  maxLoss?: number | null;
  maxProfit?: number | null;
  chanceOfProfit?: number;
  breakevenText?: string;
  underlyingPrice?: number;
  legs?: string[];
  optionLegs?: TradeOrderLeg[];
}

interface LlmOptionsIdeasResponse {
  mode: "llm_evaluation_of_quant_candidates";
  llmInput?: RawOptionsIdeasExport;
  retrievedData?: RetrievedOptionsDataExport;
  dataCoverage: {
    expirationCount: number;
    chainCount: number;
    contractCount: number;
    sentContractCount?: number;
    estimatedInputTokens?: number;
    inputTruncated?: boolean;
    cached?: boolean;
    fetchedAt?: number;
  };
  groups?: OptionsIdeasReportExport["groups"];
  finalAnalysis?: OptionsIdeasReportExport["finalAnalysis"] & {
    systemPrompt?: string;
    userPrompt?: string;
  };
  llm: {
    status: "complete" | "error";
    model?: string;
    error?: string;
    answer?: string;
    contractSymbols?: string[];
  };
}

export interface LlmStrategyEvalModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeEnv?: "TEST" | "PROD";
  userLogin?: string;
  strategy: StrategyToEvaluate | null;
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
}

export function LlmStrategyEvalModal({
  isOpen,
  onClose,
  activeEnv = "TEST",
  userLogin,
  strategy,
  onPreviewTrade,
}: LlmStrategyEvalModalProps) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<LlmOptionsIdeasResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exportError, setExportError] = useState("");

  // Build default contextual prompt whenever strategy changes
  useEffect(() => {
    if (strategy) {
      const legsSnippet = strategy.legsText ? ` with legs ${strategy.legsText}` : "";
      const targetSnippet = strategy.targetPrice ? ` target price $${strategy.targetPrice}` : "";
      const expSnippet = strategy.expirationDate ? ` expiring ${strategy.expirationDate}` : "";
      const debitSnippet = strategy.netDebit !== undefined ? ` (net debit/credit: $${Math.abs(strategy.netDebit)})` : "";
      const defaultPrompt = `Evaluate the ${strategy.strategyName} strategy on ${strategy.symbol}${legsSnippet}${expSnippet}${targetSnippet}${debitSnippet}. Analyze the risk/reward, implied volatility, Greeks exposure, probability of profit, and advise whether this trade is optimal or if alternative strikes/dates in the chain are superior.`;
      setQuestion(defaultPrompt);
      setResult(null);
      setError("");
      setExportError("");
    }
  }, [strategy]);

  if (!isOpen || !strategy) return null;

  const runLlmEvaluation = async (queryText: string, forceRefresh = false) => {
    if (loading) return;
    setLoading(true);
    setError("");
    setExportError("");
    try {
      const response = await fetch("/api/trading/options/llm-ideas", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({
          symbol: strategy.symbol.trim().toUpperCase(),
          question: queryText.trim(),
          refresh: forceRefresh,
        }),
      });
      const data = (await response.json()) as LlmOptionsIdeasResponse | { error?: string };
      if (!response.ok) {
        if ("retrievedData" in data && data.retrievedData) {
          setResult(data as LlmOptionsIdeasResponse);
          return;
        }
        throw new Error(
          "error" in data ? data.error || "LLM options evaluation failed." : "LLM options evaluation failed."
        );
      }
      setResult(data as LlmOptionsIdeasResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "LLM options evaluation failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadRaw = async () => {
    if (!result?.retrievedData) return;
    setExportError("");
    try {
      await downloadRetrievedOptionsDataXls(result.retrievedData);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Could not create raw E*TRADE data export.");
    }
  };

  const handleDownloadNormalized = async () => {
    if (!result?.llmInput) return;
    setExportError("");
    try {
      await downloadRawOptionsIdeasXls(result.llmInput);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Could not create normalized input export.");
    }
  };

  const handleDownloadReport = async () => {
    if (!result?.retrievedData) return;
    setExportError("");
    try {
      await downloadOptionsIdeasReportXls({
        symbol: result.retrievedData.symbol,
        question: result.retrievedData.question,
        dataCoverage: result.dataCoverage,
        groups: result.groups || [],
        finalAnalysis: result.finalAnalysis || {
          status: result.llm.status,
          model: result.llm.model,
          answer: result.llm.answer,
          error: result.llm.error,
        },
      });
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Could not create analysis report export.");
    }
  };

  const handleOrderTicket = () => {
    if (!onPreviewTrade || !strategy) return;
    const ctx: TradeOrderContext = {
      assetClass: "options",
      symbol: strategy.symbol,
      action: strategy.sentiment?.includes("bearish") ? "SELL_SHORT" : "BUY",
      quantity: 1,
      underlyingPrice: strategy.underlyingPrice,
      label: `${strategy.strategyName} (LLM Evaluated)`,
      legs: strategy.legs || [strategy.legsText || strategy.strategyName],
      optionLegs: strategy.optionLegs,
      strategyNetDebit: strategy.netDebit,
    };
    onPreviewTrade(ctx);
  };

  return (
        <Modal open={isOpen} onClose={onClose} size="none" panelClassName="llm-eval-modal-content" ariaLabel="Neural strategy evaluation">
        {/* Modal Header */}
        <div className="llm-eval-modal-header">
          <div className="llm-eval-title-group">
            <span className="llm-eval-badge">🧠 Neural Strategy Evaluation</span>
            <h3>{strategy.strategyName} on {strategy.symbol}</h3>
            {strategy.legsText && <span className="llm-eval-legs-subtitle">{strategy.legsText}</span>}
          </div>
          <Button variant="ghost" type="button" className="llm-eval-close-btn" onClick={onClose} title="Close">
            ✕
          </Button>
        </div>

        {/* Modal Body */}
        <div className="llm-eval-modal-body">
          {/* Strategy Summary Pill Strip */}
          <div className="llm-eval-strategy-strip">
            <div>
              <span>Underlying</span>
              <strong>{strategy.symbol}</strong>
            </div>
            {strategy.targetPrice && (
              <div>
                <span>Target Price</span>
                <strong>${strategy.targetPrice.toFixed(2)}</strong>
              </div>
            )}
            {strategy.expirationDate && (
              <div>
                <span>Expiration</span>
                <strong>{strategy.expirationDate} ({strategy.dte ?? 0}d)</strong>
              </div>
            )}
            {strategy.netDebit !== undefined && (
              <div>
                <span>{strategy.netDebit >= 0 ? "Net Debit" : "Net Credit"}</span>
                <strong>${Math.abs(strategy.netDebit).toLocaleString()}</strong>
              </div>
            )}
            {strategy.chanceOfProfit !== undefined && (
              <div>
                <span>Est. POP</span>
                <strong>{strategy.chanceOfProfit}%</strong>
              </div>
            )}
          </div>

          {/* Prompt Form */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runLlmEvaluation(question);
            }}
            className="llm-eval-form"
          >
            <FieldShell id="llm-eval-question" className="llm-eval-label" label="Natural-Language Evaluation Prompt">
              <TextInput id="llm-eval-question"
                multiline
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={3}
                required
                maxLength={4000}
                placeholder="Ask the LLM to evaluate this strategy against live raw and normalized chains..."
              />
            </FieldShell>

            <div className="llm-eval-action-bar">
              <Button
                variant="primary"
                type="submit"
                className="llm-eval-submit-btn"
                disabled={loading || !question.trim()}
               loading={loading}>
                {"🚀 Run LLM Evaluation"}
              </Button>
              <Button
                type="button"
                className="subnav-btn"
                disabled={loading || !question.trim()}
                onClick={() => void runLlmEvaluation(question, true)}
                title="Force refresh live E*TRADE option chains into persistent cache"
                style={{
                  padding: "var(--space-2) var(--space-4)",
                  fontSize: "var(--font-size-body-sm)",
                  background: "var(--color-surface-sunken)",
                  border: "1px solid var(--color-border-subtle)",
                  color: "var(--color-accent)",
                  borderRadius: "var(--radius-sm, 6px)",
                  cursor: "pointer",
                }}
              >
                🔄 Refresh Market Chains
              </Button>
              {result && onPreviewTrade && (
                <Button
                  type="button"
                  className="llm-eval-order-btn"
                  onClick={handleOrderTicket}
                >
                  ⚡ Open in Fast Order Ticket
                </Button>
              )}
            </div>
          </form>

          {/* Error alerts */}
          {error && <div className="options-error" role="alert">{error}</div>}
          {exportError && <div className="options-error" role="alert">{exportError}</div>}

          {/* Results Area */}
          {result && (
            <div className="llm-eval-results-container">
              {/* Coverage & Model Meta */}
              <div className="llm-eval-meta-bar">
                <span>Model: <strong>{result.llm.model || "Neural Llama 3.3"}</strong></span>
                <span>•</span>
                <span>{result.dataCoverage.expirationCount} Expirations</span>
                <span>•</span>
                <span>{result.dataCoverage.contractCount} Total Contracts</span>
                <span>•</span>
                <span>{result.dataCoverage.sentContractCount ?? result.dataCoverage.contractCount} Evaluated</span>
                {result.dataCoverage?.cached && (
                  <span
                    style={{
                      background: "var(--color-success-subtle)",
                      color: "var(--color-success)",
                      border: "1px solid var(--color-success)",
                      padding: "var(--space-0-5) var(--space-2)",
                      borderRadius: "var(--radius-xs, 4px)",
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      marginLeft: "auto",
                    }}
                  >
                    ⚡ Stored Market Cache
                  </span>
                )}
              </div>

              {/* Final Synthesis / Cross-group Ranking */}
              {result.finalAnalysis?.status === "complete" ? (
                <div className="llm-eval-synthesis-card">
                  <h4>Synthesis & Recommendations</h4>
                  <p className="llm-eval-answer-text">{result.finalAnalysis.answer}</p>

                  {(result.finalAnalysis.rankings || []).length > 0 && (
                    <div className="llm-eval-rankings-list">
                      <h5>Cross-Group Ranked Trades:</h5>
                      {result.finalAnalysis.rankings!.map((item) => {
                        const group = result.groups?.find((g) => g.id === item.groupId);
                        return (
                          <div key={item.groupId} className="llm-eval-ranking-item">
                            <span className="llm-eval-rank-num">#{item.rank}</span>
                            <div className="llm-eval-rank-body">
                              <strong>{item.strategy} ({group?.label || item.groupId})</strong>
                              <p>{item.rationale}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="llm-eval-synthesis-card">
                  <h4>LLM Analysis Response</h4>
                  <p className="llm-eval-answer-text">
                    {result.llm.answer || (result.llm.error ? `⚠️ Synthesis note: ${result.llm.error}` : "Analysis completed across cohorts.")}
                  </p>
                </div>
              )}

              {/* Expiration Group Breakdown */}
              {result.groups && result.groups.length > 0 && (
                <div className="llm-eval-groups-grid">
                  {result.groups.map((group) => (
                    <div key={group.id} className="llm-eval-group-card">
                      <div className="llm-eval-group-header">
                        <strong>{group.label}</strong>
                        <span>{group.contractCount} contracts ({group.expirationCount} exp)</span>
                      </div>
                      <p className={`llm-eval-group-answer ${group.status === "error" ? "cohort-error" : ""}`}>
                        {group.answer || (group.error ? `⚠️ Cohort analysis note: ${group.error}` : "No candidate strategy identified.")}
                      </p>
                      {group.contractSymbols && group.contractSymbols.length > 0 && (
                        <div className="llm-eval-group-contracts">
                          {group.contractSymbols.map((sym) => (
                            <span key={sym} className="llm-contract-chip">{sym}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* DOWNLOAD RAW & NORMALIZED DATA CAPABILITY */}
              <div className="llm-eval-export-strip">
                <div className="llm-eval-export-title">
                  <span>📥 Export Raw & Normalized Options Data:</span>
                  <small>Download complete data packages as Excel 97–2003 (.xls) workbooks</small>
                </div>
                <div className="llm-eval-export-buttons">
                  <Button
                    type="button"
                    className="llm-export-btn raw"
                    onClick={() => void handleDownloadRaw()}
                    title="Download complete retrieved E*TRADE JSON & raw option chains"
                  >
                    📦 Raw E*TRADE Data (.xls)
                  </Button>
                  <Button
                    type="button"
                    className="llm-export-btn normalized"
                    onClick={() => void handleDownloadNormalized()}
                    title="Download normalized LLM input prompts, contracts, and Greeks"
                  >
                    📊 Normalized LLM Input (.xls)
                  </Button>
                  <Button
                    type="button"
                    className="llm-export-btn report"
                    onClick={() => void handleDownloadReport()}
                    title="Download complete LLM analysis report & verified contracts"
                  >
                    📄 Full Analysis Report (.xls)
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
          </Modal>
  );
}
