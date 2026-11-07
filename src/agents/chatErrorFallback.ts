/**
 * Issue #669 (Think migration step 3b) — shared chat error fallback.
 *
 * Extracted verbatim from OrchestratorAgent.buildChatErrorFallback
 * (issue #312) so the live class and the Think shadow built the same
 * deterministic degraded answer from one implementation. Since the
 * step-4 cutover (issue #686) the production class is the only
 * caller. Callers pass a this-bound context (the #359 routes
 * idiom): their own orm, session id, audit sink, NLQ stores and
 * scheduling port.
 */
import { executeNaturalLanguageQuery, formatMarketCap, type NLQSchedulingPort, type NLQStockScreenPort } from "./nlq";
import { resolveErrorAspect } from "../aspects/errorCodes";
import { logAspectEvent } from "../aspects/loggingAspect";
import type { DatabaseORM } from "../orm";
import type { ScanRunStore } from "../data/scanRunPorts";
import type { StrategyProfileStore } from "../data/strategyProfilePorts";
import type { Env } from "../types";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/chatErrorFallback",
});

export interface ChatErrorFallbackContext {
  env: Env;
  orm: DatabaseORM;
  sessionId: string;
  /** Audit sink; the agent attribution is the caller's orchestrator. */
  audit: (type: string, payload: Record<string, unknown>) => void;
  scanRunStore: ScanRunStore;
  profileStore: StrategyProfileStore;
  schedulingPort: NLQSchedulingPort;
  stockScreenPort: NLQStockScreenPort;
}

/**
 * Issue #312: shared degraded-answer builder for chat turns. Runs the
 * deterministic NLQ fallback and returns the same diagnostic text the
 * WebSocket chat streams; POST /api/chat returns it as JSON instead.
 */
export async function buildChatErrorFallback(
  ctx: ChatErrorFallbackContext,
  streamErr: unknown,
  userText: string,
  userLogin: string
): Promise<string> {
  const aspect = resolveErrorAspect(streamErr);
  logAspectEvent({
    aspect: "ChatStream",
    operationName: "streamInitializationError",
    code: aspect.code,
    level: "error",
    error: aspect.message,
    metadata: { userText, userLogin },
    audit: (e, _c, p) => ctx.audit(e, p),
  });
  ctx.audit("stream.error", { code: aspect.code, error: aspect.message });

  // Attempt deterministic query execution (e.g. Stock Screener or Research query)
  let deterministicSection = "";
  if (userText && userText.trim().length > 0) {
    try {
      const { result } = await executeNaturalLanguageQuery(
        ctx.orm,
        ctx.sessionId,
        userText,
        ctx.env,
        userLogin,
        undefined,
        { scanRunStore: ctx.scanRunStore, profileStore: ctx.profileStore, schedulingPort: ctx.schedulingPort, stockScreenPort: ctx.stockScreenPort }
      );
      if (result && result.status !== "error") {
        if (Array.isArray(result.rows) && result.rows.length > 0) {
          deterministicSection = [
            "",
            "---",
            "### 📈 Deterministic Results (Executed without AI tokens):",
            `Found **${result.count || result.rows.length}** results matching your criteria:`,
            "",
            ...result.rows.slice(0, 12).map((row: any) => {
              const sym = row.symbol || row.ticker || "";
              const name = row.companyName || row.name || "";
              const mcap = row.marketCap ? ` · MCap: ${formatMarketCap(Number(row.marketCap))}` : "";
              const price = row.price !== undefined ? ` · Price: $${Number(row.price).toFixed(2)}` : "";
              const change = row.changePct !== undefined ? ` (${row.changePct >= 0 ? "+" : ""}${Number(row.changePct).toFixed(2)}%)` : "";
              return `- **${sym}** ${name ? `(${name})` : ""}${price}${change}${mcap}`;
            }),
          ].join("\n");
        } else if (result.summary) {
          deterministicSection = `\n\n---\n### 📈 Deterministic Result:\n${result.summary}`;
        }
      }
    } catch (fallbackQueryErr) {
      structuredLog.warn("chatErrorFallback.deterministic_fallback_query_failed", {
        message: "[OrchestratorAgent] Deterministic fallback query error:",
        error: fallbackQueryErr instanceof Error ? fallbackQueryErr.message : String(fallbackQueryErr),
      });
    }
  }

  const fallbackText = [
    `⚠️ **[${aspect.code}] ${aspect.title}**`,
    "",
    `**Diagnosis:** ${aspect.message}`,
    "",
    "**What needs to be done to resolve this:**",
    ...aspect.resolutionSteps.map((step, idx) => `${idx + 1}. ${step}`),
    "",
    aspect.suggestedTab
      ? `👉 **Direct Navigation:** Go to the **${aspect.suggestedTabLabel || aspect.suggestedTab}** from the navigation bar to run scans and queries directly with direct exchange feeds.`
      : "",
    deterministicSection,
  ].filter(Boolean).join("\n");
  return fallbackText;
}
