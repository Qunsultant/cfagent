import { useState } from "react";
import { Button, Table, TextInput, FieldShell, type TableColumn } from "../components/ui";
import { apiFetch as fetch } from "../apiFetch";
import {
  downloadRawOptionsIdeasXls,
  downloadOptionsIdeasReportXls,
  downloadRetrievedOptionsDataXls,
  type OptionsIdeasReportExport,
  type RawOptionsIdeasExport,
  type RetrievedOptionsDataExport,
} from "../runExport";
import "./optionsResearch.css";

export interface LlmOptionsIdeasResponse {
  mode: "llm_evaluation_of_quant_candidates";
  isSynthetic?: boolean;
  notice?: string;
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
    isFallback?: boolean;
  };
  llm: {
    status: "complete" | "error";
    model?: string;
    error?: string;
    answer?: string;
    contractSymbols?: string[];
  };
}

type ContractDetailRow = NonNullable<
  NonNullable<LlmOptionsIdeasResponse["groups"]>[number]["contractDetails"]
>[number];
const contractColumns: TableColumn<ContractDetailRow>[] = [
  { key: "expiry", header: "Expiry", render: (r) => r.expiration },
  { key: "contract", header: "Contract", render: (r) => r.symbol },
  { key: "type", header: "Type", render: (r) => r.contract.optionType },
  { key: "strike", header: "Strike", render: (r) => r.contract.strikePrice },
  { key: "bid", header: "Bid", render: (r) => r.contract.bid },
  { key: "ask", header: "Ask", render: (r) => r.contract.ask },
  { key: "last", header: "Last", render: (r) => r.contract.lastPrice },
  { key: "volume", header: "Volume", render: (r) => r.contract.volume ?? "—" },
  { key: "oi", header: "Open interest", render: (r) => r.contract.openInterest ?? "—" },
  { key: "delta", header: "Delta", render: (r) => r.contract.delta ?? "—" },
  { key: "iv", header: "IV", render: (r) => r.contract.impliedVolatility ?? "—" },
];

export interface LlmOptionsIdeasPanelProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
}

export function LlmOptionsIdeasPanel({ activeEnv, userLogin }: LlmOptionsIdeasPanelProps) {
  const [symbol, setSymbol] = useState("NVDA");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<LlmOptionsIdeasResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exportError, setExportError] = useState("");

  const runAnalysis = async (requestedQuestion: string, forceRefresh = false) => {
    if (loading) return;
    setLoading(true);
    setError("");
    setResult(null);
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
          symbol: symbol.trim().toUpperCase(),
          question: requestedQuestion.trim(),
          refresh: forceRefresh,
        }),
      });
      const data = (await response.json()) as LlmOptionsIdeasResponse | { error?: string };
      if (!response.ok) {
        if ("retrievedData" in data && data.retrievedData) {
          setResult(data as LlmOptionsIdeasResponse);
          return;
        }
        throw new Error("error" in data ? data.error || "LLM options research request failed." : "LLM options research request failed.");
      }
      setResult(data as LlmOptionsIdeasResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "LLM options research request failed.");
    } finally {
      setLoading(false);
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runAnalysis(question);
  };

  const downloadInput = async () => {
    if (!result?.llmInput) return;
    setExportError("");
    try {
      await downloadRawOptionsIdeasXls(result.llmInput);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Could not create the .xls input export.");
    }
  };

  const downloadRetrievedData = async () => {
    if (!result?.retrievedData) return;
    setExportError("");
    try {
      await downloadRetrievedOptionsDataXls(result.retrievedData);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Could not create the raw E*TRADE data export.");
    }
  };

  const downloadReport = async () => {
    if (!result?.retrievedData) return;
    setExportError("");
    try {
      await downloadOptionsIdeasReportXls({
        symbol: result.retrievedData.symbol,
        question: result.retrievedData.question,
        dataCoverage: result.dataCoverage,
        groups: result.groups || [],
        finalAnalysis: result.finalAnalysis || { status: result.llm.status, model: result.llm.model, answer: result.llm.answer, error: result.llm.error },
      });
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Could not create the .xls analysis report.");
    }
  };

  const sampleQuestions = [
    "Find the strongest bullish, bearish, and neutral options strategy in each expiration group. Explain exact legs and risks.",
    "For each expiration group, identify the best defined-risk bullish strategy using the available calls and puts.",
    "Compare near-, mid-, and long-term chains for the best strategy when I expect the underlying to move sharply in either direction.",
    "Find the best neutral or income-oriented strategy in each expiration group and explain the market conditions it needs.",
  ];

  return (
    <section className="trading-section options-research-section llm-options-ideas-panel">
      <form className="options-request-form llm-options-ideas-form" onSubmit={(event) => void submit(event)}>
        <TextInput label="Underlying ticker"
          required
          maxLength={10}
          value={symbol}
          onChange={(event) => setSymbol(event.target.value)}
          placeholder="e.g. NVDA"
        />
        <FieldShell id="llm-options-question" className="llm-options-question" label="Your question">
        <TextInput id="llm-options-question"
          multiline
          required
          maxLength={4000}
          rows={4}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="For example: Find the strongest options strategies for bullish, bearish, neutral, and directional scenarios. Explain the structure, relevant contract data, and risks."
        />
        </FieldShell>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end", flexWrap: "wrap" }}>
          <Button type="submit" disabled={loading || !symbol.trim() || !question.trim()} loading={loading}>
            {"Ask LLM"}
          </Button>
          <Button
            type="button"
            className="options-eval-llm-btn"
            disabled={loading || !symbol.trim() || !question.trim()}
            onClick={() => void runAnalysis(question, true)}
            title="Force refresh live chains and update market cache"
            style={{ minHeight: "38px" }}
          >
            🔄 Refresh Chains
          </Button>
        </div>
      </form>

      <div className="llm-ideas-samples" aria-label="Sample analysis questions">
        <strong>Try a sample:</strong>
        {sampleQuestions.map((sample) => (
          <Button
            key={sample}
            type="button"
            disabled={loading || !symbol.trim()}
            onClick={() => {
              setQuestion(sample);
              void runAnalysis(sample);
            }}
          >
            {sample}
          </Button>
        ))}
      </div>

      <p className="options-assumptions">
        Sample questions submit immediately using the ticker above. All group requests and the final ranking input are available as an Excel 97–2003 .xls export. The analysis report, exact LLM inputs, and all retrieved raw chains can each be downloaded after retrieval.
      </p>
      {error && <div className="options-error" role="alert">{error}</div>}

      {result && (
        <section className="options-comparison" aria-label="Raw-data LLM analysis">
          <header className="options-results-header">
            <div>
              <h3>LLM analysis report</h3>
              <span>
                {result.llm.model || "Configured model"} ·{" "}
                {result.dataCoverage.sentContractCount ?? result.dataCoverage.contractCount} of {result.dataCoverage.contractCount} contracts sent ·{" "}
                {result.dataCoverage.expirationCount} expirations
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
              {(result.isSynthetic || result.retrievedData?.dataSource?.includes("synthetic")) && (
                <span
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    borderRadius: "var(--radius-full, 999px)",
                    background: "var(--color-warning-subtle)",
                    border: "1px solid var(--color-warning)",
                    color: "var(--color-warning)",
                    fontSize: "var(--font-size-caption)",
                    fontWeight: 700,
                  }}
                  title="Synthetic preview in TEST environment - not live market data"
                >
                  🧪 Synthetic Preview (TEST)
                </span>
              )}
              {result.finalAnalysis?.isFallback && (
                <span
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    borderRadius: "var(--radius-full, 999px)",
                    background: "var(--color-surface-sunken)",
                    border: "1px solid var(--color-border-subtle)",
                    color: "var(--color-text-muted)",
                    fontSize: "var(--font-size-caption)",
                    fontWeight: 600,
                  }}
                  title="Deterministic fallback ranking synthesized due to upstream model timeout or rate limit"
                >
                  ⚙️ Deterministic Fallback Ranking
                </span>
              )}
              {result.dataCoverage.cached && (
                <span
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    borderRadius: "var(--radius-full, 999px)",
                    background: "var(--color-success-subtle)",
                    border: "1px solid var(--color-success)",
                    color: "var(--color-success)",
                    fontSize: "var(--font-size-caption)",
                    fontWeight: 700,
                  }}
                  title="Accelerated from local options chain cache"
                >
                  ⚡ Stored Market Cache
                </span>
              )}
            </div>
          </header>
          {result.notice && (
            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--color-text-muted)",
                background: "var(--color-surface-sunken)",
                border: "1px solid var(--color-border-subtle)",
                borderRadius: "var(--radius-sm, 6px)",
                padding: "var(--space-1-5) var(--space-2-5)",
                marginBottom: "0.75rem",
              }}
            >
              ℹ️ {result.notice}
            </div>
          )}
          {result.finalAnalysis?.status === "complete" ? (
            <article className="options-llm-answer">
              <h4>Overall group-winner ranking</h4>
              <p>{result.finalAnalysis.answer}</p>
              {(result.finalAnalysis.rankings || []).map((item) => {
                const group = result.groups?.find((entry) => entry.id === item.groupId);
                return (
                  <div className="llm-ideas-ranking" key={item.groupId}>
                    <strong>#{item.rank} · {group?.label || item.groupId}</strong>
                    <span>{item.strategy}</span>
                    <p>{item.rationale}</p>
                  </div>
                );
              })}
            </article>
          ) : (
            <div className="options-error" role="alert">
              Final cross-group ranking is unavailable: {result.finalAnalysis?.error || result.llm.error || "No completed group analyses were available."} Group-level results below are still available; no overall winner is inferred.
            </div>
          )}
          {(result.groups || []).map((group) => (
            <article className="options-llm-answer llm-ideas-group" key={group.id}>
              <header>
                <h4>{group.label}</h4>
                <span>{group.status === "complete" ? `${group.contractCount} contracts · ${group.expirationCount} expirations` : "Analysis failed"}</span>
              </header>
              {group.status === "complete"
                ? <p>{group.answer}</p>
                : <div className="options-error" role="alert">{group.error}</div>}
              {(group.contractSymbols || []).length > 0 && (
                <p><b>Referenced E*TRADE contracts:</b> {group.contractSymbols?.join(", ")}</p>
              )}
              {(group.contractDetails || []).length > 0 && (
                <div className="options-table-scroll">
                  <Table
                    className="options-table"
                    columns={contractColumns}
                    rows={group.contractDetails ?? []}
                    rowKey={(row) => row.symbol}
                  />
                </div>
              )}
              {(group.contractWarnings || []).map((warning) => (
                <p className="options-comparison-note" role="note" key={warning}>{warning}</p>
              ))}
              {group.inputTruncated && (
                <p className="options-comparison-note">Input was sampled to fit the model context ({group.sentContractCount} of {group.contractCount} group contracts sent).</p>
              )}
            </article>
          ))}
          <div style={{ display: "flex", gap: "var(--space-2-5)", flexWrap: "wrap", marginTop: "0.5rem" }}>
            <Button type="button" className="options-eval-llm-btn" onClick={() => void downloadReport()}>
              📥 Download analysis report (.xls)
            </Button>
            {result.llmInput && (
              <Button type="button" className="options-eval-llm-btn" onClick={() => void downloadInput()}>
                📥 Download exact inputs (.xls)
              </Button>
            )}
            {result.retrievedData && (
              <Button type="button" className="options-eval-llm-btn" onClick={() => void downloadRetrievedData()}>
                📥 Download all retrieved raw data (.xls)
              </Button>
            )}
          </div>
          {exportError && <div className="options-error" role="alert">Export failed: {exportError}</div>}
          {result.dataCoverage.inputTruncated && (
            <p className="options-comparison-note">
              One or more group inputs were reduced to fit the context window, prioritizing near-the-money and more liquid strikes across expirations. The raw-data export includes all retrieved chains.
              {result.dataCoverage.estimatedInputTokens
                ? ` Estimated input: ${result.dataCoverage.estimatedInputTokens.toLocaleString()} tokens.`
                : ""}
            </p>
          )}
          <p className="options-comparison-note">
            Retrieved {result.dataCoverage.chainCount} option-chain responses. Contract references are checked against the data sent to each LLM request; these recommendations are not independently verified optimality or execution assessments.
          </p>
        </section>
      )}
    </section>
  );
}
