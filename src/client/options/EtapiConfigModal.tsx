import React, { useState, useEffect } from "react";
import { apiFetch as fetch } from "../apiFetch";
import { Modal, TextInput, Select, Notice, Button, Flex, Stack, Card } from "../components/ui";
import type { EtapiConfig, AiModelDefinition } from "../../config/etapiConfig";

export interface EtapiConfigModalProps {
  isOpen?: boolean;
  onClose?: () => void;
  activeEnv?: "TEST" | "PROD";
  userLogin?: string;
  onConfigChanged?: (newConfig: EtapiConfig) => void;
  embedded?: boolean;
}

export function EtapiConfigModal({
  isOpen = true,
  onClose = () => {},
  activeEnv = "PROD",
  userLogin,
  onConfigChanged,
  embedded = false,
}: EtapiConfigModalProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"strategy" | "screener" | "weights" | "scanner" | "ai">("strategy");

  // Editable fields state
  const [riskFreeRatePct, setRiskFreeRatePct] = useState("4.0");
  const [feePerContract, setFeePerContract] = useState("0.65");
  const [maxCombinations, setMaxCombinations] = useState("5000");
  const [detailLimit, setDetailLimit] = useState("5000");

  const [defaultMaxDte, setDefaultMaxDte] = useState("90");
  const [defaultMinDte, setDefaultMinDte] = useState("0");
  const [unusualVolOiRatio, setUnusualVolOiRatio] = useState("1.5");
  const [atmBandPct, setAtmBandPct] = useState("2.0");
  const [maxScanSymbols, setMaxScanSymbols] = useState("20");
  const [maxReturnedContracts, setMaxReturnedContracts] = useState("10000");

  const [thesisWeight, setThesisWeight] = useState("30");
  const [rewardRiskWeight, setRewardRiskWeight] = useState("20");
  const [liquidityWeight, setLiquidityWeight] = useState("20");
  const [volatilityWeight, setVolatilityWeight] = useState("10");
  const [freshnessWeight, setFreshnessWeight] = useState("15");
  const [thetaWeight, setThetaWeight] = useState("5");
  const [popWeight, setPopWeight] = useState("15");
  const [cushionWeight, setCushionWeight] = useState("8");
  const [capitalWeight, setCapitalWeight] = useState("7");

  const [bullishFactor, setBullishFactor] = useState("1.05");
  const [bearishFactor, setBearishFactor] = useState("0.95");
  const [largeMoveFactor, setLargeMoveFactor] = useState("1.10");

  // AI & Safety Limits state
  const [availableModels, setAvailableModels] = useState<AiModelDefinition[]>([
    { id: "@cf/zai-org/glm-4.7-flash", name: "GLM 4.7 Flash (Flagship, 24k context)", provider: "workers-ai", contextWindow: 24000, supportsTools: true, supportsStreaming: true, category: "flagship" },
    { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B Instruct FP8 Fast", provider: "workers-ai", contextWindow: 131072, supportsTools: true, supportsStreaming: true, category: "reasoning" },
    { id: "@cf/meta/llama-3.1-70b-instruct", name: "Llama 3.1 70B Instruct", provider: "workers-ai", contextWindow: 131072, supportsTools: true, supportsStreaming: true, category: "general" },
    { id: "@cf/qwen/qwen2.5-72b-instruct", name: "Qwen 2.5 72B Instruct", provider: "workers-ai", contextWindow: 32768, supportsTools: true, supportsStreaming: true, category: "analytical" },
    { id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", name: "DeepSeek R1 Distill Qwen 32B", provider: "workers-ai", contextWindow: 65536, supportsTools: false, supportsStreaming: true, category: "reasoning" },
  ]);
  const [selectedDefaultModel, setSelectedDefaultModel] = useState("@cf/zai-org/glm-4.7-flash");
  // #930: no failover-model selector — the old failover key was consumed by no LLM
  // call path. reasoningModel is carried verbatim (not edited here) so a
  // save does not silently change it; the initial value is the current
  // baseline default, replaced by the loaded config when present.
  const [savedReasoningModel, setSavedReasoningModel] = useState("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  const [selectedIdeasModel, setSelectedIdeasModel] = useState("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  const [selectedComparisonModel, setSelectedComparisonModel] = useState("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  const [selectedNlqModel, setSelectedNlqModel] = useState("@cf/zai-org/glm-4.7-flash");
  const [temperatureDeterministic, setTemperatureDeterministic] = useState("0.0");
  const [temperatureAnalytical, setTemperatureAnalytical] = useState("0.2");
  const [temperatureCreative, setTemperatureCreative] = useState("0.7");
  const [maxOrderQuantity, setMaxOrderQuantity] = useState("10000");
  const [maxOrderTotalUsd, setMaxOrderTotalUsd] = useState("500000");
  const [maxDiscountPercent, setMaxDiscountPercent] = useState("90");

  const loadConfig = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/trading/options/config", {
        headers: {
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
      });
      if (!res.ok) throw new Error("Failed to load options configuration");
      const data = (await res.json()) as { config?: EtapiConfig };
      if (data?.config) {
        populateFields(data.config);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error loading config");
    } finally {
      setLoading(false);
    }
  };

  const populateFields = (cfg: EtapiConfig) => {
    if (cfg.strategyEngine) {
      setRiskFreeRatePct((cfg.strategyEngine.riskFreeRate * 100).toFixed(1));
      setFeePerContract(cfg.strategyEngine.feePerContract.toFixed(2));
      setMaxCombinations(String(cfg.strategyEngine.maxCombinations));
      setDetailLimit(String(cfg.strategyEngine.detailLimit));
      if (cfg.strategyEngine.scoreWeights) {
        setThesisWeight(String(Math.round(cfg.strategyEngine.scoreWeights.thesisAlignment * 100)));
        setRewardRiskWeight(String(Math.round(cfg.strategyEngine.scoreWeights.targetRewardRisk * 100)));
        setLiquidityWeight(String(Math.round(cfg.strategyEngine.scoreWeights.liquidity * 100)));
        setVolatilityWeight(String(Math.round(cfg.strategyEngine.scoreWeights.volatilityAlignment * 100)));
        setFreshnessWeight(String(Math.round(cfg.strategyEngine.scoreWeights.freshness * 100)));
        setThetaWeight(String(Math.round(cfg.strategyEngine.scoreWeights.thetaBurden * 100)));
        setPopWeight(String(Math.round((cfg.strategyEngine.scoreWeights.popAlignment ?? 0) * 100)));
        setCushionWeight(String(Math.round((cfg.strategyEngine.scoreWeights.cushion ?? 0) * 100)));
        setCapitalWeight(String(Math.round((cfg.strategyEngine.scoreWeights.capitalEfficiency ?? 0) * 100)));
      }
    }
    if (cfg.screener) {
      setDefaultMaxDte(String(cfg.screener.defaultMaxDte));
      setDefaultMinDte(String(cfg.screener.defaultMinDte));
      setUnusualVolOiRatio(String(cfg.screener.unusualVolumeOiRatio));
      setAtmBandPct((cfg.screener.atmBandPct * 100).toFixed(1));
      setMaxScanSymbols(String(cfg.screener.maxScanSymbols));
      setMaxReturnedContracts(String(cfg.screener.maxReturnedContracts));
    }
    if (cfg.opportunityScanner?.targetFactors) {
      setBullishFactor(String(cfg.opportunityScanner.targetFactors.bullish));
      setBearishFactor(String(cfg.opportunityScanner.targetFactors.bearish));
      setLargeMoveFactor(String(cfg.opportunityScanner.targetFactors.large_move));
    }
    if (cfg.ai) {
      if (cfg.ai.availableModels && cfg.ai.availableModels.length > 0) {
        setAvailableModels(cfg.ai.availableModels);
      }
      if (cfg.ai.defaultModel) setSelectedDefaultModel(cfg.ai.defaultModel);
      if (cfg.ai.reasoningModel) setSavedReasoningModel(cfg.ai.reasoningModel);
      if (cfg.ai.taskModels) {
        if (cfg.ai.taskModels.optionsIdeas) setSelectedIdeasModel(cfg.ai.taskModels.optionsIdeas);
        if (cfg.ai.taskModels.optionsComparison) setSelectedComparisonModel(cfg.ai.taskModels.optionsComparison);
        if (cfg.ai.taskModels.nlqValidation) setSelectedNlqModel(cfg.ai.taskModels.nlqValidation);
      }
      if (cfg.ai.temperatureDefaults) {
        setTemperatureDeterministic(String(cfg.ai.temperatureDefaults.deterministic ?? 0.0));
        setTemperatureAnalytical(String(cfg.ai.temperatureDefaults.analytical ?? 0.2));
        setTemperatureCreative(String(cfg.ai.temperatureDefaults.creative ?? 0.7));
      }
    }
    if (cfg.tradingConstraints) {
      if (cfg.tradingConstraints.maxOrderQuantity) setMaxOrderQuantity(String(cfg.tradingConstraints.maxOrderQuantity));
      if (cfg.tradingConstraints.maxOrderTotalUsd) setMaxOrderTotalUsd(String(cfg.tradingConstraints.maxOrderTotalUsd));
      if (cfg.tradingConstraints.maxDiscountPercent) setMaxDiscountPercent(String(cfg.tradingConstraints.maxDiscountPercent));
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadConfig();
      setSuccessMsg(null);
    }
  }, [isOpen, activeEnv]);


  const handleApplyOverrides = async () => {
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const overrides: Partial<EtapiConfig> = {
        strategyEngine: {
          riskFreeRate: Number(riskFreeRatePct) / 100,
          feePerContract: Number(feePerContract),
          maxCombinations: Number(maxCombinations),
          detailLimit: Number(detailLimit),
          maxLegs: 6,
          scoreWeights: {
            thesisAlignment: Number(thesisWeight) / 100,
            targetRewardRisk: Number(rewardRiskWeight) / 100,
            liquidity: Number(liquidityWeight) / 100,
            volatilityAlignment: Number(volatilityWeight) / 100,
            freshness: Number(freshnessWeight) / 100,
            thetaBurden: Number(thetaWeight) / 100,
            popAlignment: Number(popWeight) / 100,
            cushion: Number(cushionWeight) / 100,
            capitalEfficiency: Number(capitalWeight) / 100,
          },
        },
        screener: {
          maxScanSymbols: Number(maxScanSymbols),
          maxExpirationsPerSymbol: 20,
          // Issue #1545 — carried at the baseline default so a saved
          // config stays complete; tuned via ETAPI_SUBREQUEST_BUDGET,
          // not edited in this modal.
          subrequestBudget: 35,
          defaultMaxDte: Number(defaultMaxDte),
          defaultMinDte: Number(defaultMinDte),
          defaultQuoteAgeSeconds: 60,
          maxReturnedContracts: Number(maxReturnedContracts),
          maxRejectionsReturned: 50,
          symbolFetchConcurrency: 4,
          expiryFetchConcurrency: 3,
          unusualVolumeOiRatio: Number(unusualVolOiRatio),
          highDeltaThreshold: 0.65,
          highIvThreshold: 0.7,
          lowIvThreshold: 0.3,
          atmBandPct: Number(atmBandPct) / 100,
        },
        opportunityScanner: {
          maxScanSymbols: Number(maxScanSymbols),
          concurrency: 3,
          // Fit-gate defaults (issue #24) — carried so a saved config
          // stays complete; not edited in this modal.
          fitGate: {
            minCompositeScore: 55,
            minProbabilityOfProfit: 0.35,
            requireFresh: true,
            minConfidence: "MEDIUM" as const,
          },
          targetFactors: {
            bullish: Number(bullishFactor),
            bearish: Number(bearishFactor),
            large_move: Number(largeMoveFactor),
            range_bound: 1.0,
          },
          // Expected-move target multiples (issue #25) — carried so a
          // saved config stays complete; not edited in this modal.
          targetEmMultiples: {
            bullish: 0.6,
            bearish: -0.6,
            large_move: 1.2,
            range_bound: 0,
          },
        },
        ai: {
          defaultModel: selectedDefaultModel,
          fastModel: selectedDefaultModel,
          reasoningModel: savedReasoningModel,
          availableModels,
          taskModels: {
            optionsIdeas: selectedIdeasModel,
            optionsComparison: selectedComparisonModel,
            nlqPlanning: selectedNlqModel,
            nlqValidation: selectedNlqModel,
            orchestrator: selectedDefaultModel,
            marketResearch: selectedDefaultModel,
          },
          temperatureDefaults: {
            deterministic: Number(temperatureDeterministic),
            analytical: Number(temperatureAnalytical),
            creative: Number(temperatureCreative),
          },
          maxTokens: {
            nlq: 2048,
            ideas: 4096,
            comparison: 4096,
            orchestrator: 2048,
            search: 2048,
          },
        },
        tradingConstraints: {
          maxOrderQuantity: Number(maxOrderQuantity),
          maxOrderTotalUsd: Number(maxOrderTotalUsd),
          defaultOrderQuantity: 1,
          maxDiscountPercent: Number(maxDiscountPercent),
          maxPremiumPercent: 500,
          requireHitlVoiceConfirmation: true,
        },
      };

      const res = await fetch("/api/trading/options/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({ overrides }),
      });

      if (!res.ok) throw new Error("Failed to apply configuration overrides");
      const data = (await res.json()) as { config?: EtapiConfig };
      setSuccessMsg("✓ Runtime parameters applied live across all screeners and discovery engines!");
      if (data?.config && onConfigChanged) {
        onConfigChanged(data.config);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error applying overrides");
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefaults = async () => {
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await fetch("/api/trading/options/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({ reset: true }),
      });

      if (!res.ok) throw new Error("Failed to reset defaults");
      const data = (await res.json()) as { config?: EtapiConfig };
      if (data?.config) {
        populateFields(data.config);
        if (onConfigChanged) onConfigChanged(data.config);
      }
      setSuccessMsg("✓ Reset to environment baseline defaults (from environment.config.json).");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error resetting defaults");
    } finally {
      setSaving(false);
    }
  };

  const bodyContent = (
    <>
      {/* Tab Switcher */}
      <div
        style={{
          display: "flex",
          gap: "var(--space-2)",
            padding: "var(--space-3) var(--space-6)",
            background: "var(--color-surface-sunken)",
            borderBottom: "1px solid var(--color-border-subtle)",
          }}
        >
          <Button
            className="subnav-btn"
            style={{
              padding: "var(--space-1-5) var(--space-3)",
              fontSize: "var(--font-size-body-sm)",
              background: activeTab === "strategy" ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
              color: activeTab === "strategy" ? "var(--color-accent)" : "var(--color-text-muted)",
              borderColor: activeTab === "strategy" ? "var(--color-border-focus)" : "var(--color-border-subtle)",
            }}
            onClick={() => setActiveTab("strategy")}
          >
            📈 Strategy &amp; Pricing
          </Button>
          <Button
            className="subnav-btn"
            style={{
              padding: "var(--space-1-5) var(--space-3)",
              fontSize: "var(--font-size-body-sm)",
              background: activeTab === "screener" ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
              color: activeTab === "screener" ? "var(--color-accent)" : "var(--color-text-muted)",
              borderColor: activeTab === "screener" ? "var(--color-border-focus)" : "var(--color-border-subtle)",
            }}
            onClick={() => setActiveTab("screener")}
          >
            🔍 Screener Bounds
          </Button>
          <Button
            className="subnav-btn"
            style={{
              padding: "var(--space-1-5) var(--space-3)",
              fontSize: "var(--font-size-body-sm)",
              background: activeTab === "weights" ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
              color: activeTab === "weights" ? "var(--color-accent)" : "var(--color-text-muted)",
              borderColor: activeTab === "weights" ? "var(--color-border-focus)" : "var(--color-border-subtle)",
            }}
            onClick={() => setActiveTab("weights")}
          >
            ⚖️ Scoring Weights
          </Button>
          <Button
            className="subnav-btn"
            style={{
              padding: "var(--space-1-5) var(--space-3)",
              fontSize: "var(--font-size-body-sm)",
              background: activeTab === "scanner" ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
              color: activeTab === "scanner" ? "var(--color-accent)" : "var(--color-text-muted)",
              borderColor: activeTab === "scanner" ? "var(--color-border-focus)" : "var(--color-border-subtle)",
            }}
            onClick={() => setActiveTab("scanner")}
          >
            🎯 Opportunity Scanner
          </Button>
          <Button
            className="subnav-btn"
            style={{
              padding: "var(--space-1-5) var(--space-3)",
              fontSize: "var(--font-size-body-sm)",
              background: activeTab === "ai" ? "var(--color-accent-subtle)" : "var(--color-surface-sunken)",
              color: activeTab === "ai" ? "var(--color-accent)" : "var(--color-text-muted)",
              borderColor: activeTab === "ai" ? "var(--color-border-focus)" : "var(--color-border-subtle)",
            }}
            onClick={() => setActiveTab("ai")}
          >
            🤖 AI Models &amp; Guardrails
          </Button>
        </div>

        {/* Body content */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
          {error && (
            <Notice tone="danger">{error}</Notice>
          )}
          {successMsg && (
            <Notice tone="success">{successMsg}</Notice>
          )}

          {activeTab === "strategy" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              <div>
                <TextInput id="etapi-risk-free-rate-pct" label="Risk-Free Rate (%):" hint="Applied to Black-Scholes pricing &amp; carry cost."
                  type="number"
                  step="0.1"
                  min="0"
                  max="20"
                  value={riskFreeRatePct}
                  onChange={(e) => setRiskFreeRatePct(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-fee-per-contract" label="Fee per Contract ($):" hint="Standard brokerage fee (default $0.65)."
                  type="number"
                  step="0.05"
                  min="0"
                  value={feePerContract}
                  onChange={(e) => setFeePerContract(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-max-combinations" label="Max Combinations per Run:" hint="Limits multi-leg combinatorial explosion."
                  type="number"
                  step="50"
                  min="10"
                  max="50000"
                  value={maxCombinations}
                  onChange={(e) => setMaxCombinations(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-detail-limit" label="Detail Limit:" hint="Number of top strategies enriched with full Greeks."
                  type="number"
                  step="50"
                  min="5"
                  max="50000"
                  value={detailLimit}
                  onChange={(e) => setDetailLimit(e.target.value)}

                />
              </div>
            </div>
          )}

          {activeTab === "screener" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              <div>
                <TextInput id="etapi-default-max-dte" label="Default Max DTE (Days):"
                  type="number"
                  value={defaultMaxDte}
                  onChange={(e) => setDefaultMaxDte(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-default-min-dte" label="Default Min DTE (Days):"
                  type="number"
                  value={defaultMinDte}
                  onChange={(e) => setDefaultMinDte(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-unusual-vol-oi-ratio" label="Unusual Volume / OI Ratio:"
                  type="number"
                  step="0.1"
                  value={unusualVolOiRatio}
                  onChange={(e) => setUnusualVolOiRatio(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-atm-band-pct" label="ATM Band (% of spot):"
                  type="number"
                  step="0.5"
                  value={atmBandPct}
                  onChange={(e) => setAtmBandPct(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-max-scan-symbols" label="Max Scan Symbols:"
                  type="number"
                  value={maxScanSymbols}
                  onChange={(e) => setMaxScanSymbols(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-max-returned-contracts" label="Max Returned Contracts:"
                  type="number"
                  value={maxReturnedContracts}
                  onChange={(e) => setMaxReturnedContracts(e.target.value)}

                />
              </div>
            </div>
          )}

          {activeTab === "weights" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              <div>
                <TextInput id="etapi-thesis-weight" label="Thesis Alignment Weight (%):"
                  type="number"
                  value={thesisWeight}
                  onChange={(e) => setThesisWeight(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-reward-risk-weight" label="Target Reward / Risk Weight (%):"
                  type="number"
                  value={rewardRiskWeight}
                  onChange={(e) => setRewardRiskWeight(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-liquidity-weight" label="Liquidity &amp; Spread Weight (%):"
                  type="number"
                  value={liquidityWeight}
                  onChange={(e) => setLiquidityWeight(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-freshness-weight" label="Freshness Weight (%):"
                  type="number"
                  value={freshnessWeight}
                  onChange={(e) => setFreshnessWeight(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-volatility-weight" label="Volatility Alignment Weight (%):"
                  type="number"
                  value={volatilityWeight}
                  onChange={(e) => setVolatilityWeight(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-theta-weight" label="Theta Burden Weight (%):"
                  type="number"
                  value={thetaWeight}
                  onChange={(e) => setThetaWeight(e.target.value)}

                />
              </div>
            </div>
          )}

          {activeTab === "scanner" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              <div>
                <TextInput id="etapi-bullish-factor" label="Bullish Target Multiplier:" hint="1.05 = +5% upside target assumption"
                  type="number"
                  step="0.01"
                  value={bullishFactor}
                  onChange={(e) => setBullishFactor(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-bearish-factor" label="Bearish Target Multiplier:" hint="0.95 = -5% downside target assumption"
                  type="number"
                  step="0.01"
                  value={bearishFactor}
                  onChange={(e) => setBearishFactor(e.target.value)}

                />
              </div>
              <div>
                <TextInput id="etapi-large-move-factor" label="Large Move Target Multiplier:" hint="1.10 = +10% volatility straddle assumption"
                  type="number"
                  step="0.01"
                  value={largeMoveFactor}
                  onChange={(e) => setLargeMoveFactor(e.target.value)}

                />
              </div>
            </div>
          )}

          {activeTab === "ai" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
              <div style={{ padding: "var(--space-3)", background: "var(--color-accent-subtle)", border: "1px solid var(--color-border-focus)", borderRadius: "var(--radius-md, 8px)" }}>
                <h4 style={{ margin: "0 0 0.4rem", fontSize: "var(--font-size-body)", color: "var(--color-accent)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <span>🧠</span> Workflow Model Selection
                </h4>
                <p style={{ margin: "0 0 0.85rem", fontSize: "var(--font-size-caption)", color: "var(--color-text-muted)" }}>
                  Configure which neural AI model is assigned to each specific trading and intelligence workflow.
                </p>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" }}>
                  <div>
                    <Select id="etapi-selected-default-model" label="Default Flagship Model:"
                      value={selectedDefaultModel}
                      onChange={(e) => setSelectedDefaultModel(e.target.value)}

                    >
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} [{m.category.toUpperCase()}]
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <Select id="etapi-selected-ideas-model" label="Options Ideas Evaluator:"
                      value={selectedIdeasModel}
                      onChange={(e) => setSelectedIdeasModel(e.target.value)}

                    >
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} [{m.category.toUpperCase()}]
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <Select id="etapi-selected-comparison-model" label="Multi-Leg Options Comparator:"
                      value={selectedComparisonModel}
                      onChange={(e) => setSelectedComparisonModel(e.target.value)}

                    >
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} [{m.category.toUpperCase()}]
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div style={{ gridColumn: "span 2" }}>
                    <Select id="etapi-selected-nlq-model" label="NLQ Natural Language Query Validator:"
                      value={selectedNlqModel}
                      onChange={(e) => setSelectedNlqModel(e.target.value)}

                    >
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} [{m.category.toUpperCase()}]
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              </div>

              <div style={{ padding: "var(--space-3)", background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "8px" }}>
                <h4 style={{ margin: "0 0 0.4rem", fontSize: "var(--font-size-body)", color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <span>🌡️</span> Sampling Temperatures
                </h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "var(--space-3)" }}>
                  <div>
                    <TextInput id="etapi-temperature-deterministic" label="Deterministic (Orders):"
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={temperatureDeterministic}
                      onChange={(e) => setTemperatureDeterministic(e.target.value)}
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    />
                  </div>
                  <div>
                    <TextInput id="etapi-temperature-analytical" label="Analytical (Screener):"
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={temperatureAnalytical}
                      onChange={(e) => setTemperatureAnalytical(e.target.value)}
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    />
                  </div>
                  <div>
                    <TextInput id="etapi-temperature-creative" label="Creative (Ideas):"
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={temperatureCreative}
                      onChange={(e) => setTemperatureCreative(e.target.value)}
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    />
                  </div>
                </div>
              </div>

              <div style={{ padding: "var(--space-3)", background: "var(--color-danger-subtle)", border: "1px solid var(--color-danger)", borderRadius: "var(--radius-md, 8px)" }}>
                <h4 style={{ margin: "0 0 0.4rem", fontSize: "var(--font-size-body)", color: "var(--color-danger)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <span>🛡️</span> Trading Safety Limits &amp; Constraints
                </h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "var(--space-3)" }}>
                  <div>
                    <TextInput id="etapi-max-order-quantity" label="Max Order Shares:"
                      type="number"
                      value={maxOrderQuantity}
                      onChange={(e) => setMaxOrderQuantity(e.target.value)}
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    />
                  </div>
                  <div>
                    <TextInput id="etapi-max-order-total-usd" label="Max Total Value ($):"
                      type="number"
                      value={maxOrderTotalUsd}
                      onChange={(e) => setMaxOrderTotalUsd(e.target.value)}
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    />
                  </div>
                  <div>
                    <TextInput id="etapi-max-discount-percent" label="Max Discount Limit (%):"
                      type="number"
                      value={maxDiscountPercent}
                      onChange={(e) => setMaxDiscountPercent(e.target.value)}
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
    </>
  );

  if (embedded) {
    return (
      <div className="etapi-config-embedded">
        <Flex justify="between" align="center" wrap gap="3" className="mb-4">
          <Flex align="center" gap="3">
            <span className="text-xl">⚙️</span>
            <div>
              <h3 className="m-0 font-bold">
                ETAPI Engine Configuration &amp; Tuning
              </h3>
              <p className="m-0 text-muted">
                Externalized defaults • Zero hardcoding • Cascading overrides for active env [{activeEnv}]
              </p>
            </div>
          </Flex>
          <Flex gap="2">
            <Button variant="secondary" size="sm" onClick={handleResetDefaults} disabled={saving || loading}>
              Reset Defaults
            </Button>
            <Button variant="accent" size="sm" onClick={handleApplyOverrides} disabled={saving || loading}>
              {saving ? "Applying..." : "Apply Runtime Config"}
            </Button>
          </Flex>
        </Flex>
        <div className="etapi-config-embedded-body">
          {bodyContent}
        </div>
      </div>
    );
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      size="lg"
      title={
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <span style={{ fontSize: "var(--font-size-title)" }}>⚙️</span>
          <div>
            <h3 style={{ margin: 0, fontSize: "var(--font-size-title-sm)", fontWeight: 700, color: "var(--color-text-primary)" }}>
              ETAPI Engine Configuration &amp; Tuning
            </h3>
            <p style={{ margin: 0, fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
              Externalized defaults • Zero hardcoding • Cascading overrides for active env [{activeEnv}]
            </p>
          </div>
        </div>
      }
      footer={
        <div
          style={{
            padding: "var(--space-4) var(--space-6)",
            background: "var(--color-surface-sunken)",
            borderTop: "1px solid var(--color-border-subtle)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Button variant="secondary" onClick={handleResetDefaults} disabled={saving || loading}>
            Reset Defaults
          </Button>
          <div style={{ display: "flex", gap: "var(--space-3)" }}>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="accent" onClick={handleApplyOverrides} disabled={saving || loading}>
              {saving ? "Applying..." : "Apply Runtime Config"}
            </Button>
          </div>
        </div>
      }
    >
      {bodyContent}
    </Modal>
  );
}

export function EngineTuningPanel({
  activeEnv = "PROD",
  userLogin,
  onConfigChanged,
}: {
  activeEnv?: "TEST" | "PROD";
  userLogin?: string;
  onConfigChanged?: (newConfig: EtapiConfig) => void;
}) {
  return (
    <EtapiConfigModal
      isOpen={true}
      embedded={true}
      activeEnv={activeEnv}
      userLogin={userLogin}
      onConfigChanged={onConfigChanged}
    />
  );
}
