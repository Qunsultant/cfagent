import React from "react";
import { resolveErrorAspect } from "../../aspects/errorCodes";
import { logAspectEvent } from "../../aspects/loggingAspect";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { extractText } from "./types";
import { useUrlSyncedTabs } from "../useUrlSyncedTabs";
import { CapabilityNavBar, type CapabilityTabItem } from "../components/CapabilityNavBar";
import type { AdItem, User } from "./types";
import { MarkdownContent } from "./MarkdownContent";
import { ReasoningView } from "./ReasoningView";
import { ToolResultView } from "./ToolResultView";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Notice } from "../components/ui/Notice";
import { TextInput } from "../components/ui/TextInput";
import { useToast } from "../components/ui/Toast";
import { Modal } from "../components/ui/Modal";
export type ChatSubView = "general" | "options";

export function isValidChatSubView(view: unknown): view is ChatSubView {
  return typeof view === "string" && (view === "general" || view === "options");
}

interface AgentChatTabContentProps {
  user: User;
  ads: AdItem[];
  onAdClick: (ad: AdItem) => void;
  onOpenAdsTab: () => void;
  onNavigateTab?: (tab: "chat" | "nlq" | "audit" | "payments" | "referrals" | "ads" | "revenue" | "endpoints" | "trading" | "research" | "options-flows" | "workflows") => void;
  onStatusChange: (status: "ready" | "streaming" | "submitted" | "error") => void;
  onResetSession: (purge?: boolean) => Promise<void>;
  isResetting: boolean;
  resetNotice: string | null;
  authExpired: boolean;
  pendingPrompt?: { prompt: string; sourceTab: string } | null;
  onClearPendingPrompt?: () => void;
  showSponsorSpotlight?: boolean;
}

export function AgentChatTabContent({
  user,
  ads,
  onAdClick,
  onOpenAdsTab,
  onNavigateTab,
  onStatusChange,
  onResetSession,
  isResetting,
  resetNotice,
  authExpired,
  pendingPrompt,
  onClearPendingPrompt,
  showSponsorSpotlight = false,
}: AgentChatTabContentProps) {
  const [input, setInput] = useState("");
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const toast = useToast();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { activeTab: activeView, handleTabChange: handleViewChange } = useUrlSyncedTabs<ChatSubView>({
    param: "view",
    isValid: isValidChatSubView,
    defaultTab: "general",
  });

  const chatCapabilityTabs: CapabilityTabItem[] = useMemo(() => [
    {
      id: "general",
      label: "General Copilot",
      icon: "⚡",
      tooltip: {
        eyebrow: "AI Intelligence",
        title: "Multi-Agent Orchestrator",
        description: "Conversational multi-agent copilot for platform capabilities, market queries, and general workflows.",
      },
    },
    {
      id: "options",
      label: "Options Copilot",
      icon: "🎯",
      badge: "AI",
      badgeType: "cyan",
      tooltip: {
        eyebrow: "Options Intelligence",
        title: "Options Strategy & Structured Outputs",
        description: "Specialized copilot for options screening, multi-leg spreads, Greeks analysis, and interactive payoff visualizers.",
      },
    },
  ], []);

  // Issue #2568: Agents SDK routeAgentRequest routes by BINDING name
  // kebabbed, not class name. The binding is SEARCH_AGENT (class
  // OrchestratorAgent since migration v15, #2523); "OrchestratorAgent"
  // kebabs to /agents/orchestrator-agent/, for which no binding exists
  // ("does not match any Durable Object binding" in production).
  // "SearchAgent" kebabs to /agents/search-agent/, the existing binding.
  // Instance name (login) and DO state are unchanged: same SEARCH_AGENT
  // namespace, same idFromName(login). Do NOT re-add an
  // ORCHESTRATOR_AGENT binding (pinned against in
  // tests/orchestrator_root_namespace_1387.test.ts).
  const agent = useAgent({ agent: "SearchAgent", name: user.login });
  const { messages, sendMessage, status, error, connectionError } = useAgentChat({ agent });

  const activeError = error || connectionError;
  const errorAspect = useMemo(() => {
    if (status === "error" || Boolean(activeError)) {
      return resolveErrorAspect(activeError || "Agent connection or stream error");
    }
    return null;
  }, [status, activeError]);

  useEffect(() => {
    if (errorAspect) {
      logAspectEvent({
        aspect: "ClientChat",
        operationName: "streamError",
        code: errorAspect.code,
        level: "warn",
        error: errorAspect.message,
      });
    }
  }, [errorAspect]);

  useEffect(() => {
    onStatusChange(status);
  }, [status, onStatusChange]);

  useEffect(() => {
    if (pendingPrompt && status !== "streaming" && status !== "submitted" && !isResetting) {
      sendMessage({
        text: pendingPrompt.prompt,
        content: pendingPrompt.prompt,
        role: "user",
        parts: [{ type: "text", text: pendingPrompt.prompt }],
        metadata: { sourceTab: pendingPrompt.sourceTab, userLogin: user.login },
      } as any);
      onClearPendingPrompt?.();
    }
  }, [pendingPrompt, status, isResetting, sendMessage, user.login, onClearPendingPrompt]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  const isBusy = status === "streaming" || status === "submitted";

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isBusy || isResetting) return;

    if (typeof (agent as any).reconnect === "function" && (agent as any).readyState !== 1) {
      try {
        (agent as any).reconnect();
      } catch {
        // ignore
      }
    }

    const sourceTab = activeView === "options" ? "E*TRADE · Auto Options Research" : "Chat & Agents";
    try {
      sendMessage({
        text: input.trim(),
        content: input.trim(),
        role: "user",
        parts: [{ type: "text", text: input.trim() }],
        metadata: { sourceTab, userLogin: user.login },
      } as any);
      setInput("");
    } catch (err) {
      console.error("Failed to send chat message:", err);
    }
  };

  const handleChipClick = (prompt: string, sourceTab?: string) => {
    const effectiveSource = sourceTab || (activeView === "options" ? "E*TRADE · Auto Options Research" : "Chat & Agents");
    if (isBusy || isResetting) return;
    try {
      sendMessage({
        text: prompt,
        content: prompt,
        role: "user",
        parts: [{ type: "text", text: prompt }],
        metadata: { sourceTab, userLogin: user.login },
      } as any);
    } catch (err) {
      console.error("Failed to send chip action:", err);
    }
  };

  const handleClearWithConfirm = () => {
    setClearConfirmOpen(true);
  };

  return (
    <div className="chat-view">
      <CapabilityNavBar
        ariaLabel="Copilot modes"
        tabs={chatCapabilityTabs}
        activeTabId={activeView}
        onTabChange={handleViewChange}
        className="chat-capability-subnav"
      />
      {activeView === "options" && (
        <div className="options-copilot-banner">
          <div className="options-copilot-info">
            <span style={{ fontSize: "var(--font-size-title-sm)" }}>🎯</span>
            <div>
              <strong style={{ color: "var(--color-text-primary)" }}>Options Copilot Active:</strong>{" "}
              <span>Queries generate structured strategy cards with multi-leg execution plans, Greeks, and interactive payoff visualizers.</span>
            </div>
          </div>
          <Badge size="xs" uppercase tone="accent">Structured Outputs</Badge>
        </div>
      )}
      <Modal
        open={clearConfirmOpen}
        onClose={() => setClearConfirmOpen(false)}
        title="Clear conversation history?"
        footer={
          <>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setClearConfirmOpen(false);
                onResetSession(true);
              }}
            >
              Clear history
            </Button>{" "}
            <Button type="button" variant="secondary" onClick={() => setClearConfirmOpen(false)}>
              Cancel
            </Button>
          </>
        }
      >
        <p>Clear this conversation history? This cannot be undone.</p>
      </Modal>
      {/* Top Sponsor Spotlight Bar (Configurable via Settings) */}
      {showSponsorSpotlight && ads.length > 0 && (
        <div
          className="sponsor-spotlight-bar"
          style={{ borderColor: `${ads[0].accentColor}55` }}
        >
          <div className="sponsor-tag-group">
            <span
              className="sponsor-pill"
              style={{ background: `${ads[0].accentColor}25`, color: ads[0].accentColor }}
            >
              {ads[0].badge || "SPONSOR"}
            </span>
            <span className="sponsor-name">{ads[0].sponsor}</span>
          </div>
          <div className="sponsor-message">
            <strong>{ads[0].title}</strong> — {ads[0].tagline}
          </div>
          <div className="sponsor-actions">
            <Button
              className="sponsor-cta-btn"
              style={{ background: ads[0].accentColor }}
              onClick={() => onAdClick(ads[0])}
            >
              {ads[0].ctaText}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onOpenAdsTab}
              title="View all partner offers"
            >
              All Deals ↗
            </Button>
          </div>
        </div>
      )}

      {/* Action Bar */}
      <div className="chat-action-bar">
        <span className="chat-subtitle">Stateful Distributed Ledger Session</span>
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearWithConfirm}
            disabled={isResetting}
            title="Clear conversation and reset session"
          >
            {isResetting ? "⏳ Resetting…" : "🗑️ Clear chat"}
          </Button>
        )}
      </div>

      {resetNotice && (
        <Notice tone="success" variant="strip" icon={authExpired ? "🔒" : "✅"}>
          <span className="notice-text">{resetNotice}</span>
          {authExpired && (
            <a href="/login" className="notice-link-btn">
              Log In Again ➔
            </a>
          )}
        </Notice>
      )}

      {/* Messages Stream */}
      <div className="messages-stream">
        {messages.length === 0 ? (
          activeView === "options" ? (
            <div className="hero-welcome">
              <div className="hero-icon">🎯</div>
              <h3>Options Strategy &amp; Intelligence Copilot</h3>
              <p>
                Screen, construct, and evaluate structured multi-leg options strategies with real-time Greeks, risk-reward ratios, and 1-click execution. Responses produce interactive structured strategy cards and payoff curves.
              </p>
              <div className="quick-chips">
                <Button
                  variant="primary"
                  tone="subtle"
                  size="sm"
                  disabled={isBusy || isResetting}
                  onClick={() => handleChipClick("Screen for Bull Put credit spreads with max loss <= $30 and max profit > 0", "Options Strategy Guide")}
                >
                  🎯 Bull Put Spread (&le; $30 Max Loss)
                </Button>
                <Button
                  variant="primary"
                  tone="subtle"
                  size="sm"
                  disabled={isBusy || isResetting}
                  onClick={() => handleChipClick("Find delta-neutral Iron Condors on SPY with 30-45 DTE and probability of profit > 70%", "Options Strategy Guide")}
                >
                  🦅 SPY Iron Condor (High POP)
                </Button>
                <Button
                  variant="secondary"
                  tone="subtle"
                  size="sm"
                  disabled={isBusy || isResetting}
                  onClick={() => handleChipClick("Find covered call setups on AAPL targeting 15-20 delta with 30 DTE", "Options Strategy Guide")}
                >
                  📈 AAPL Covered Call (Income)
                </Button>
                <Button
                  variant="secondary"
                  tone="subtle"
                  size="sm"
                  disabled={isBusy || isResetting}
                  onClick={() => handleChipClick("Show recent aggressive institutional options sweeps and unusual volume alerts", "Options Flow Guide")}
                >
                  🌊 Unusual Options Flow Sweeps
                </Button>
                <Button
                  variant="secondary"
                  tone="subtle"
                  size="sm"
                  disabled={isBusy || isResetting}
                  onClick={() => handleChipClick("Evaluate straddle pricing, implied move, and volatility skew for upcoming earnings on NVDA", "Options Strategy Guide")}
                >
                  ⚡ NVDA Straddle / Volatility
                </Button>
                <Button
                  variant="secondary"
                  tone="subtle"
                  size="sm"
                  disabled={isBusy || isResetting}
                  onClick={() => handleChipClick("Calculate a delta-neutral portfolio hedge using index put options", "Trading Safety Guide")}
                >
                  🛡️ Portfolio Delta Hedge
                </Button>
              </div>
            </div>
          ) : (
          <div className="hero-welcome">
            <div className="hero-icon">⚡</div>
            <h3>Enterprise Multi-Agent Studio</h3>
            <p>
              Ask any question about platform capabilities, workflows, algorithmic decisioning, or command tools directly through chat. Your prompt is routed by an <strong>LLM Judge</strong> and orchestrated across specialized sub-agents with neural strategy intelligence and transactional ledger persistence.
            </p>
            <div className="quick-chips">
              <Button
                variant="primary"
                tone="subtle"
                size="sm"
                disabled={isBusy || isResetting}
                onClick={() => handleChipClick("What are the capabilities of this platform and how do I use the 8 core workflows?", "Platform Capabilities")}
              >
                ⚡ What can this platform do?
              </Button>
              <Button
                variant="primary"
                tone="subtle"
                size="sm"
                disabled={isBusy || isResetting}
                onClick={() => handleChipClick("How do I use the Stock Screener to find oversold tech stocks with RSI < 35?", "Stock Screener Guide")}
              >
                📈 How do I screen stocks?
              </Button>
              <Button
                variant="primary"
                tone="subtle"
                size="sm"
                disabled={isBusy || isResetting}
                onClick={() => handleChipClick("How do I screen for options strategies with max profit > 0 and max loss <= $30?", "Options Strategy Guide")}
              >
                🎯 Options: Max Profit &amp; Loss &le; $30
              </Button>
              <Button
                variant="secondary"
                tone="subtle"
                size="sm"
                disabled={isBusy || isResetting}
                onClick={() => handleChipClick("Explain how the PickBestTrades algorithm evaluates and scores setups.", "PickBestTrades Engine")}
              >
                🧠 How does PickBestTrades work?
              </Button>
              <Button
                variant="secondary"
                tone="subtle"
                size="sm"
                disabled={isBusy || isResetting}
                onClick={() => handleChipClick("How does Human-in-the-Loop (HITL) order execution and DID attestation work?", "Trading Safety Guide")}
              >
                🛡️ How does HITL order execution work?
              </Button>
              <Button
                variant="secondary"
                tone="subtle"
                size="sm"
                disabled={isBusy || isResetting}
                onClick={() => handleChipClick("How does the real-time Options Flow tracker identify institutional sweeps and sentiment?", "Options Flow Guide")}
              >
                🌊 How do options flow alerts work?
              </Button>
              <Button
                variant="secondary"
                tone="subtle"
                size="sm"
                disabled={isBusy || isResetting}
                onClick={() => handleChipClick("Perform market-data equity research on NVDA using yfinance and Alpaca", "Equity Research")}
              >
                🔬 Research NVDA (Market Data)
              </Button>
              <Button
                variant="secondary"
                tone="subtle"
                size="sm"
                disabled={isBusy || isResetting}
                onClick={() => handleChipClick("Draft a high-priority task: Complete SOC2 compliance review by next Monday", "Task Management")}
              >
                📋 Draft High-Priority Task
              </Button>
              <Button
                variant="secondary"
                tone="subtle"
                size="sm"
                disabled={isBusy || isResetting}
                onClick={() => handleChipClick("Remember that our enterprise team prefers TypeScript and dark-mode designs", "Memory Management")}
              >
                🧠 Store Session Fact
              </Button>
            </div>
          </div>
          )
        ) : (
          messages.map((msg: any) => {
            const isUser = msg.role === "user";
            const text = extractText(msg);

            // Extract reasoning stream parts
            const reasoningParts = !isUser && Array.isArray(msg.parts)
              ? msg.parts.filter((p: any) => p && p.type === "reasoning")
              : [];
            const reasoningText = reasoningParts
              .map((p: any) => p.text || p.reasoning || "")
              .filter(Boolean)
              .join("\n\n");

            // Extract legitimate tool parts (strictly excluding stream lifecycle events and reasoning)
            const toolParts = !isUser && Array.isArray(msg.parts)
              ? msg.parts.filter((p: any) => {
                  if (!p || typeof p !== "object") return false;
                  const t = p.type;
                  if (t === "text" || t === "reasoning" || t === "step-start" || t === "step-end" || t === "finish") {
                    return false;
                  }
                  return true;
                })
              : [];

            // Ignore empty assistant messages from interrupted or failed streams
            if (!isUser && !text && toolParts.length === 0 && !reasoningText) {
              return null;
            }

            return (
              <div key={msg.id || Math.random()} className={`message-row ${msg.role}`}>
                <div className="message-avatar">
                  {isUser ? (
                    <img src={user.avatar} alt="User" />
                  ) : (
                    <span className="bot-avatar">🤖</span>
                  )}
                </div>
                <div className="message-bubble">
                  <div className="message-header">
                    <span className="author-name">{isUser ? user.name : "Multi-Agent Orchestrator"}</span>
                    {isUser ? (
                      msg.metadata?.sourceTab && <span className="agent-tag">{msg.metadata.sourceTab}</span>
                    ) : <span className="agent-tag">Neural Strategy</span>}
                  </div>

                  {reasoningText && <ReasoningView reasoning={reasoningText} />}

                  {toolParts.length > 0 && (
                    <div className="tool-results-list">
                      {toolParts.map((part: any, pIdx: number) => {
                        const toolName = part.toolInvocation?.toolName || part.toolName || part.name || part.type || "tool";
                        const toolData = part.toolInvocation?.result ?? part.output ?? part.result ?? part.toolInvocation?.args ?? part.input ?? {};
                        return (
                          <ToolResultView
                            key={pIdx}
                            toolType={toolName}
                            data={toolData}
                            onAction={(actionPrompt) => handleChipClick(actionPrompt)}
                            isBusy={isBusy}
                          />
                        );
                      })}
                    </div>
                  )}

                  {text && <MarkdownContent text={text} onAction={(actionPrompt) => handleChipClick(actionPrompt)} />}
                </div>
              </div>
            );
          })
        )}

        {status === "streaming" && (
          <div className="message-row assistant">
            <div className="message-avatar">
              <span className="bot-avatar pulsing">🤖</span>
            </div>
            <div className="message-bubble streaming-bubble">
              <div className="typing-indicator">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Aspect-Oriented Error Diagnostic Card with Code, Cause & Actionable Resolution Playbook */}
      {errorAspect && (
        <Notice tone="danger" variant="box" className="chat-error-diagnostic-card">
          <div className="chat-error-card-header">
            <span className="error-badge-icon">⚠️</span>
            <div className="error-title-group">
              <div className="error-badge-row">
                <Badge size="xs" tone="danger">{errorAspect.code}</Badge>
                {errorAspect.isAiQuota && (
                  <Badge size="xs" uppercase tone="warning">Daily Free Quota Limit</Badge>
                )}
              </div>
              <strong className="error-headline">{errorAspect.title}</strong>
            </div>
          </div>

          <p className="error-diagnostic-desc">
            {errorAspect.message}
          </p>

          <div className="error-resolution-box">
            <div className="resolution-box-title">🛠️ What needs to be done to resolve this:</div>
            <ol className="resolution-steps-list">
              {errorAspect.resolutionSteps.map((step, idx) => (
                <li key={idx}>{step}</li>
              ))}
            </ol>
          </div>

          <div className="error-card-actions">
            {errorAspect.suggestedTab && onNavigateTab && (
              <Button
                variant="primary"
                onClick={() => onNavigateTab(errorAspect.suggestedTab as any)}
                title={`Navigate directly to ${errorAspect.suggestedTabLabel || errorAspect.suggestedTab}`}
              >
                🔍 {errorAspect.suggestedTabLabel || `Open ${errorAspect.suggestedTab.toUpperCase()} Tab`}
              </Button>
            )}
            <Button
              variant="secondary"
              tone="subtle"
              disabled={isResetting}
              onClick={() => {
                if (typeof (agent as any).reconnect === "function") {
                  try {
                    (agent as any).reconnect();
                  } catch {
                    // ignore
                  }
                }
                onResetSession(false);
              }}
              title="Reconnect agent WebSocket without clearing history"
            >
              🔄 Reconnect
            </Button>
            <Button
              variant="danger"
              tone="subtle"
              disabled={isResetting}
              onClick={() => handleClearWithConfirm()}
              title="Reset conversation state and clear history"
            >
              {isResetting ? "Resetting…" : "Reset & Clear History"}
            </Button>
            <Button
              className="error-action-btn copy"
              variant="secondary"
              tone="subtle"
              onClick={() => {
                const info = `Error Code: ${errorAspect.code}\nTitle: ${errorAspect.title}\nDetails: ${errorAspect.message}\nRemediation:\n${errorAspect.resolutionSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
                navigator.clipboard.writeText(info);
                toast.success("Diagnostic error information copied to clipboard.");
              }}
              title="Copy error code and diagnostic information"
            >
              📋 Copy Diagnostics
            </Button>
          </div>
        </Notice>
      )}


      {/* Persistent Capabilities & How-To Guide Strip */}
      <div
        className="capabilities-quick-bar"
        style={{
          display: "flex",
          gap: "var(--space-1-5)",
          padding: "var(--space-1-5) var(--space-3)",
          overflowX: "auto",
          borderTop: "1px solid var(--color-border-subtle)",
          background: "var(--color-surface-sunken)",
          whiteSpace: "nowrap",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: "var(--font-size-micro)", fontWeight: 700, color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
          💡 Guides:
        </span>
        <Button
          variant="accent"
          tone="subtle"
          size="sm"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("What are the capabilities of this platform and how do I use the 8 core workflows?", "Platform Capabilities")}
          title="Overview of all 8 platform workflows"
        >
          ⚡ Platform Capabilities
        </Button>
        <Button
          variant="primary"
          tone="subtle"
          size="sm"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("How do I use the Stock Screener to find equities and what fallback logic does it use?", "Stock Screener Guide")}
          title="Stock screener steps & fallback logic"
        >
          📈 Stock Screener
        </Button>
        <Button
          variant="accent"
          tone="subtle"
          size="sm"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("How do I screen for options strategies with max profit > 0 and max loss <= $30?", "Options Strategy Guide")}
          title="Screen options with budget risk limits"
        >
          🎯 Options: Max Profit & Loss
        </Button>
        <Button
          variant="warning"
          tone="subtle"
          size="sm"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("Explain how the PickBestTrades algorithm evaluates and scores setups.", "PickBestTrades Engine")}
          title="Multivariate opportunity scoring"
        >
          🧠 PickBestTrades Logic
        </Button>
        <Button
          variant="danger"
          tone="subtle"
          size="sm"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("How does Human-in-the-Loop (HITL) order execution and DID attestation work?", "Trading Safety Guide")}
          title="Safe trading with DID attestations"
        >
          🛡️ HITL Trading Guardrails
        </Button>
        <Button
          variant="accent"
          tone="subtle"
          size="sm"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("How does the real-time Options Flow tracker identify institutional sweeps and sentiment?", "Options Flow Guide")}
          title="Smart money sweeps and sentiment"
        >
          🌊 Options Flows & Sweeps
        </Button>
      </div>

      {/* Chat Input Bar */}
      <form className="chat-input-bar" onSubmit={handleSendChat}>
        <TextInput
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            isResetting
              ? "Resetting session…"
              : isBusy
              ? "Agent is processing response…"
              : activeView === "options"
              ? "Ask Options Copilot (e.g. 'Screen for Bull Put spreads on NVDA with max loss <= $30', 'Best SPY Iron Condor')..."
              : "Ask about platform capabilities, workflows, how to screen, draft orders, or query data…"
          }
          disabled={isBusy || isResetting}
          autoFocus
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!input.trim() || isBusy || isResetting}
        >
          {isBusy ? "Thinking…" : "Send ➔"}
        </Button>
      </form>
    </div>
  );
}
