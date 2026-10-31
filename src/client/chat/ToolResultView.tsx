import { confirmationCardPresentation } from "../confirmationCard";
import { executionCardPresentation } from "../executionCard";
import { orderPreviewCardPresentation } from "../orderPreviewCard";
import { useState } from "react";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { OptionsStrategyCard } from "./OptionsStrategyCard";
export function ToolResultView({
  toolType,
  data,
  onAction,
  isBusy,
}: {
  toolType: string;
  data: any;
  onAction?: (prompt: string) => void;
  isBusy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const normalizedType = (toolType || "").toLowerCase();

  // 0. Options Strategy & Intelligence Tool
  if (
    normalizedType.includes("option") ||
    data?.bestTrade ||
    data?.candidate ||
    (Array.isArray(data?.rows) && typeof data?.targetTable === "string" && data.targetTable.includes("option")) ||
    (data?.symbol && (Array.isArray(data?.legs) || Array.isArray(data?.tradePlan))) ||
    data?.type === "options_alert" ||
    data?.type === "options_candidate"
  ) {
    return (
      <OptionsStrategyCard
        data={data}
        onAction={onAction}
        isBusy={isBusy}
      />
    );
  }

  // 1. Human-In-The-Loop Authorization Confirmation
  if (normalizedType.includes("confirm") || data?.auditNotice || (data?.draftId && (data?.status === "authorized" || data?.status === "scheduled" || data?.status === "rejected"))) {
    // Issue #141: this card records a human AUTHORIZATION decision, not
    // an execution. The pill states the decision (APPROVED / REJECTED);
    // execution outcomes render on the E*TRADE execution card below.
    // See confirmationCardPresentation.
    const confirmCard = confirmationCardPresentation(data);
    const draftId = data?.draftId || "draft";
    return (
      <Card padding="none" className="tool-card confirm-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">{confirmCard.icon}</span>
          <div className="tool-summary">
            <strong>Human Authorization:</strong> <code>{draftId}</code> ({confirmCard.verdict})
          </div>
          <Badge size="xs" uppercase tone={confirmCard.pillClass === "priority-urgent" ? "danger" : confirmCard.pillClass}>
            {confirmCard.pillLabel}
          </Badge>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        <div className="confirm-details">
          {data?.auditNotice || data?.note || confirmCard.detailFallback}
        </div>
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </Card>
    );
  }

  // 2. Knowledge Base Search
  if (normalizedType.includes("search") || data?.source?.includes("Search")) {
    const query = data?.query || data?.input?.query || "knowledge base";
    const resultsFound = data?.resultsFound !== false && (data?.count > 0 || (Array.isArray(data?.chunks) && data.chunks.length > 0));
    const count = data?.count ?? (Array.isArray(data?.chunks) ? data.chunks.length : 0);

    return (
      <Card padding="none" className="tool-card search-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">🔍</span>
          <div className="tool-summary">
            <strong>Knowledge Search:</strong> <em>"{query}"</em>
          </div>
          <Badge size="xs" uppercase tone={resultsFound ? "success" : "warning"}>
            {resultsFound ? `Knowledge (${count} docs)` : "0 Docs (Fallback)"}
          </Badge>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        {!resultsFound && (
          <div className="task-deadline">
            💡 No custom index documents matched. Orchestrator synthesized answer using domain knowledge.
          </div>
        )}
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data.chunks || data.results || data, null, 2)}</pre>
          </div>
        )}
      </Card>
    );
  }

  // Market Data & Research Tool (Yahoo Finance & Alpaca)
  if (
    normalizedType.includes("market_data") ||
    data?.provider === "Yahoo Finance" ||
    data?.provider === "Alpaca Market Data v2" ||
    data?.provider === "Hybrid (Alpaca + Yahoo Finance)" ||
    data?.analystConsensus ||
    data?.valuationMultiples ||
    data?.executiveSummary ||
    (data?.symbol && (data?.trailingPE !== undefined || data?.nbboSpread !== undefined))
  ) {
    const symbol = data?.symbol || data?.input?.symbol || "TICKER";
    const provider = data?.provider || (data?.analystConsensus ? "Yahoo Finance" : "Hybrid");
    const isReport = Boolean(data?.analystConsensus || data?.executiveSummary || data?.keyInsights);
    const isSnapshot = Boolean(data?.latestTrade && data?.latestQuote);
    const price = data?.currentPrice || data?.price || data?.lastPrice || data?.latestTrade?.price || 0;
    const change = data?.change || data?.change24h || 0;
    const changePercent = data?.changePercent || data?.changePercent24h || 0;
    const recommendation = data?.analystConsensus?.recommendation || data?.recommendation || "BUY";
    const targetPrice = data?.analystConsensus?.targetPrice || data?.targetPrice;

    return (
      <Card padding="none" className="tool-card market-data-card research-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">{isReport ? "🔬" : "📈"}</span>
          <div className="tool-summary">
            <strong>{isReport ? "Market Data Equity Research:" : "Market Data Quote:"}</strong> {symbol} — ${Number(price).toFixed(2)}{" "}
            <span className={change >= 0 ? "change-up" : "change-down"}>
              ({change >= 0 ? "+" : ""}{Number(change).toFixed(2)} / {changePercent >= 0 ? "+" : ""}{Number(changePercent).toFixed(2)}%)
            </span>
          </div>
          <Badge size="xs" uppercase tone="accent">{provider}</Badge>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>

        {isReport && (
          <div className="market-data-report-preview">
            <div className="market-data-metrics-row">
              <span className="metric-tag">
                🎯 <strong>Consensus:</strong> {recommendation.replace("_", " ")}
              </span>
              {targetPrice && (
                <span className="metric-tag">
                  🎯 <strong>Target:</strong> ${Number(targetPrice).toFixed(2)}
                </span>
              )}
              {data?.valuationMultiples?.trailingPE && (
                <span className="metric-tag">
                  📊 <strong>P/E:</strong> {Number(data.valuationMultiples.trailingPE).toFixed(1)}x
                </span>
              )}
              {data?.valuationMultiples?.pegRatio && (
                <span className="metric-tag">
                  ⚡ <strong>PEG:</strong> {Number(data.valuationMultiples.pegRatio).toFixed(2)}
                </span>
              )}
            </div>
            {data?.executiveSummary && (
              <div className="market-data-summary-text">{data.executiveSummary}</div>
            )}
            {data?.agentAttestation && (
              <div className="market-data-attestation-tag">
                🔏 Signed by: <code>{data.agentAttestation.agentDid}</code> (Alg: {data.agentAttestation.algorithm})
              </div>
            )}
          </div>
        )}

        {isSnapshot && (
          <div className="market-data-snapshot-preview">
            <div className="market-data-metrics-row">
              <span className="metric-tag">
                🟢 <strong>Bid:</strong> ${Number(data.latestQuote?.bidPrice || 0).toFixed(2)} ({data.latestQuote?.bidSize || 0})
              </span>
              <span className="metric-tag">
                🔴 <strong>Ask:</strong> ${Number(data.latestQuote?.askPrice || 0).toFixed(2)} ({data.latestQuote?.askSize || 0})
              </span>
              <span className="metric-tag">
                📏 <strong>Spread:</strong> ${Number(data.nbboSpread || 0).toFixed(3)}
              </span>
            </div>
          </div>
        )}

        <div className="hitl-actions">
          <Button variant="primary" tone="subtle" disabled={isBusy} onClick={() => onAction?.(`Preview buy 10 shares of ${symbol} on ETrade`)}>
            ⚡ Preview Buy 10 {symbol} (E*TRADE)
          </Button>
          {!isReport && (
            <Button variant="secondary" tone="subtle" disabled={isBusy} onClick={() => onAction?.(`Run full market-data research on ${symbol}`)}>
              🔬 Full Market Data Research
            </Button>
          )}
          <Button variant="secondary" tone="subtle" disabled={isBusy} onClick={() => onAction?.(`Compare valuation of ${symbol} against peers`)}>
            📊 Compare Valuation
          </Button>
        </div>

        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </Card>
    );
  }

  // 3. E*TRADE Trading Tool (Preview, Execution, Quote)
  if (
    normalizedType.includes("trade") ||
    normalizedType.includes("etrade") ||
    data?.orderId?.startsWith("ord_") ||
    data?.draftId?.startsWith("ord_") ||
    (data?.action && (data.action === "BUY" || data.action === "SELL" || data.action === "BUY_TO_COVER" || data.action === "SELL_SHORT")) ||
    data?.resultsFoundStocks
  ) {
    const isExecution = normalizedType.includes("execute") || data?.executionId || data?.brokerOrderRef;
    const isQuote = normalizedType.includes("quote") || (data?.symbol && data?.lastPrice && !data?.orderId && !data?.action);
    const orderId = data?.orderId || data?.draftId;
    const symbol = data?.symbol || data?.input?.symbol;
    const action = data?.action || data?.input?.action || "BUY";
    const quantity = data?.quantity || data?.input?.quantity || 1;
    const status = data?.status || "previewed";
    const price = data?.limitPrice || data?.estimatedPrice || data?.executionPrice || data?.lastPrice;

    if (isExecution) {
      // Issue #123 (F16): FILLED/EXECUTED only on an explicit success
      // signal; ambiguous results render a neutral status, and no broker
      // reference is ever fabricated. See executionCardPresentation.
      const execCard = executionCardPresentation(data);
      return (
        <Card padding="none" className="tool-card confirm-card trading-card">
          <div className="tool-card-header" onClick={() => setOpen(!open)}>
            <span className="tool-icon">📈</span>
            <div className="tool-summary">
              <strong>E*TRADE Execution:</strong> {execCard.verdict} {quantity} {symbol} ({action})
            </div>
            <Badge size="xs" uppercase tone={execCard.pillClass === "priority-urgent" ? "danger" : execCard.pillClass}>
              {execCard.pillLabel}
            </Badge>
            <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
          </div>
          <div className="confirm-details">
            {execCard.detail}
          </div>
          {open && (
            <div className="tool-card-body">
              <pre>{JSON.stringify(data, null, 2)}</pre>
            </div>
          )}
        </Card>
      );
    }

    if (isQuote) {
      return (
        <Card padding="none" className="tool-card quote-card trading-card">
          <div className="tool-card-header" onClick={() => setOpen(!open)}>
            <span className="tool-icon">📊</span>
            <div className="tool-summary">
              <strong>E*TRADE Quote:</strong> {symbol} — ${(price || 0).toFixed(2)} ({data.change >= 0 ? "+" : ""}{data.change?.toFixed(2) || 0})
            </div>
            <Badge size="xs" uppercase tone="info">Level 1 Live</Badge>
            <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
          </div>
          <div className="hitl-actions">
            <Button variant="primary" tone="subtle" disabled={isBusy} onClick={() => onAction?.(`Preview buy 10 shares of ${symbol}`)}>
              ⚡ Preview Buy 10 {symbol}
            </Button>
          </div>
          {open && (
            <div className="tool-card-body">
              <pre>{JSON.stringify(data, null, 2)}</pre>
            </div>
          )}
        </Card>
      );
    }

    // Default: Order Draft / Preview
    // Issue #151: the pill derives from the draft's ACTUAL status via
    // orderPreviewCardPresentation — a rejected draft reads REJECTED,
    // not a stale "Awaiting Approval"; and no placeholder order ID is
    // presented as a reserved one when the result carries none.
    const previewPill = orderPreviewCardPresentation(status);
    return (
      <Card padding="none" className="tool-card trading-card order-preview-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">📈</span>
          <div className="tool-summary">
            <strong>E*TRADE Trade Intent:</strong> {action} {quantity} {symbol} {price ? `@ $${Number(price).toFixed(2)}` : ""}
          </div>
          <Badge size="xs" uppercase tone={previewPill.pillClass === "priority-urgent" ? "danger" : previewPill.pillClass}>
            {previewPill.pillLabel}
          </Badge>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        <div className="payment-notice">
          🛡️ <strong>Safety Guarantee:</strong> No trade will be executed without explicit authorization.{orderId && (<> E*TRADE Order ID <code>{orderId}</code> reserved.</>)}
        </div>
        {orderId && status !== "executed" && status !== "rejected" && (
          <div className="hitl-actions">
            <Button variant="primary" tone="subtle" disabled={isBusy} onClick={() => onAction?.(`Approve trade draft ${orderId}`)}>
              ✅ Approve &amp; Execute Order
            </Button>
            <Button variant="danger" tone="subtle" disabled={isBusy} onClick={() => onAction?.(`Cancel trade draft ${orderId}`)}>
              ❌ Cancel Order
            </Button>
          </div>
        )}
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </Card>
    );
  }

  // 4. Payment Draft Tool
  if (normalizedType.includes("payment") || data?.status === "awaiting_confirmation" || data?.action) {
    const amount = data?.amount || data?.input?.amount;
    const currency = data?.currency || data?.input?.currency || "USD";
    const customer = data?.customer || data?.input?.customer;
    const action = data?.action || data?.input?.action || "transaction";
    const draftId = data?.draftId;

    return (
      <Card padding="none" className="tool-card payment-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">💳</span>
          <div className="tool-summary">
            <strong>Payment Intent ({String(action).toUpperCase()}):</strong> {amount ? `$${amount} ${currency}` : ""} for {customer || "customer"}
          </div>
          <Badge size="xs" uppercase tone="warning">Awaiting Approval</Badge>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        <div className="payment-notice">
          🛡️ <strong>Safety Guarantee:</strong> No money has been moved. An explicit human authorization is required before execution.
        </div>
        {draftId && data?.status === "awaiting_confirmation" && (
          <div className="hitl-actions">
            <Button variant="primary" tone="subtle" disabled={isBusy} onClick={() => onAction?.(`Approve payment draft ${draftId}`)}>
              ✅ Approve Draft
            </Button>
            <Button variant="danger" tone="subtle" disabled={isBusy} onClick={() => onAction?.(`Cancel payment draft ${draftId}`)}>
              ❌ Cancel
            </Button>
          </div>
        )}
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </Card>
    );
  }

  // 4. Task Draft Tool
  if (normalizedType.includes("task") || data?.taskId || data?.status === "draft") {
    const title = data?.title || data?.input?.title;
    const priority = data?.priority || data?.input?.priority || "medium";
    const dueDate = data?.dueDate || data?.input?.dueDate;
    const taskId = data?.taskId;

    return (
      <Card padding="none" className="tool-card task-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">📋</span>
          <div className="tool-summary">
            <strong>Task Proposal:</strong> {title}
          </div>
          <Badge size="xs" uppercase tone={priority === "urgent" || priority === "high" ? "danger" : priority === "medium" ? "warning" : "neutral"}>{String(priority).toUpperCase()}</Badge>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        {dueDate && <div className="task-deadline">📅 Target: {dueDate}</div>}
        {taskId && data?.status === "draft" && (
          <div className="hitl-actions">
            <Button variant="primary" tone="subtle" disabled={isBusy} onClick={() => onAction?.(`Confirm task ${taskId}`)}>
              ✅ Confirm Task
            </Button>
          </div>
        )}
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </Card>
    );
  }

  // 5. Memory Fact Tool
  if (normalizedType.includes("remember") || normalizedType.includes("recall") || data?.key || data?.facts) {
    const isRecall = normalizedType.includes("recall") || Array.isArray(data?.facts);
    return (
      <Card padding="none" className="tool-card memory-card">
        <div className="tool-card-header" onClick={() => setOpen(!open)}>
          <span className="tool-icon">🧠</span>
          <div className="tool-summary">
            {isRecall ? (
              <span><strong>Session Memory:</strong> Recalled {data?.count ?? data?.facts?.length ?? 0} facts</span>
            ) : (
              <span><strong>Session Memory:</strong> <code>{data.key}</code> = "{data.value}"</span>
            )}
          </div>
          <Badge size="xs" uppercase tone="info">Ledger Stored</Badge>
          <span className="toggle-arrow">{open ? "▲" : "▼"}</span>
        </div>
        {open && (
          <div className="tool-card-body">
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </div>
        )}
      </Card>
    );
  }

  // 6. Generic Fallback Tool (only for unrecognized custom tools)
  return (
    <details className="tool-call generic-tool">
      <summary>🔧 Tool Call: {toolType}</summary>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}
