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
import { StockCopilotPanel } from "../StockCopilotPanel";
import { setStockCopilotPaused } from "../stockCopilotApi";
import { findCopilot, getRegisteredCopilots, hasCustomSurface, isRegisteredCopilotId } from "./copilotRegistry";
// Fluent v9 replaces our primitives on this page only (#3146 experiment).
// Measured gaps vs our primitives: no danger button (secondary used),
// no tone system (chips collapse to subtle), no strip/box Notice variant.
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  FluentProvider,
  Input,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Spinner,
  Toast,
  Toaster,
  ToastTitle,
  useToastController,
  webDarkTheme,
  webLightTheme,
} from "@fluentui/react-components";
export type ChatSubView = "general" | "options" | "stock" | (string & {});

// #3230: Fluent v9 Input renders a wrapper root around the inner
// <input>, so the old `.chat-input-bar input { flex: 1 }` rule no
// longer stretches the composer — the rule lands on the inner input,
// which is not a flex item of the form, while the Fluent root has no
// flex growth and collapses to intrinsic width. Grow the Fluent root
// itself with Griffel (no .css change, no inline style): the composer
// stretches full length across the bar minus the Send button, as
// before #3146. minWidth: 0 lets it shrink below its content width.
const useComposerStyles = makeStyles({
  composerInput: {
    flexGrow: 1,
    minWidth: 0,
  },
});

// #3407 (incident — chat stopped scrolling after #3146): Fluent v9's
// FluentProvider renders a plain block <div> root (its Griffel styles
// set only color/background/typography), so it broke the flex height
// chain tab-viewport → .chat-view → .messages-stream: .chat-view's
// flex: 1 went inert against a block parent, the stream grew with
// content and never overflowed, and the scrollIntoView effect scrolled
// the document instead of the pane. Grow the Fluent root itself with
// Griffel (same pattern as the #3230 composer fix): the wrapper takes
// over the flex-item role .chat-view used to have, and the theme
// background is preserved (a real box, not display: contents).
// minHeight: 0 lets it shrink below its content height so the stream
// can overflow and scroll.
const useProviderStyles = makeStyles({
  provider: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
});

// #3449, #3521, #3541: copilots with custom surfaces (e.g. Stock Copilot)
// render a side-by-side workspace on desktop:
// - Left pane: dedicated copilot dashboard (StockCopilotPanel) with its own scrolling
// - Right pane: conversational chat stream and composer with its own scrolling
// Eliminates the vertical 50% squishing and dual scrollbars on the same axis,
// while enabling direct interactive chat and autonomous loop adjustments.
const useSurfaceStyles = makeStyles({
  splitLayout: {
    display: "flex",
    flexDirection: "row",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    overflow: "hidden",
    "@media (max-width: 900px)": {
      flexDirection: "column",
    },
  },
  dashboardPane: {
    display: "flex",
    flexDirection: "column",
    flexBasis: "50%",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    minWidth: 0,
    borderRight: "1px solid var(--color-border-subtle)",
    overflowY: "auto",
    "@media (max-width: 900px)": {
      flexBasis: "45%",
      borderRight: "none",
      borderBottom: "1px solid var(--color-border-subtle)",
    },
  },
  chatPane: {
    display: "flex",
    flexDirection: "column",
    flexBasis: "50%",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    "@media (max-width: 900px)": {
      flexBasis: "55%",
    },
  },
  fullChatArea: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    overflow: "hidden",
  },
});

export function isValidChatSubView(view: unknown): view is ChatSubView {
  return typeof view === "string" && (view === "general" || view === "options" || view === "stock" || isRegisteredCopilotId(view));
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

export function AgentChatTabContentInner({
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
  const composerStyles = useComposerStyles();
  const surfaceStyles = useSurfaceStyles();
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const { dispatchToast } = useToastController();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { activeTab: activeView, handleTabChange: handleViewChange } = useUrlSyncedTabs<ChatSubView>({
    param: "view",
    aliases: ["copilot", "subtab", "subview"],
    isValid: isValidChatSubView,
    defaultTab: "general",
  });

  const chatCapabilityTabs: CapabilityTabItem[] = useMemo(() => {
    return getRegisteredCopilots().map((copilot) => ({
      id: copilot.id,
      label: copilot.label,
      icon: copilot.icon,
      badge: copilot.badge,
      badgeType: copilot.badgeType,
      tooltip: copilot.tooltip,
    }));
  }, []);

  const currentCopilot = useMemo(() => {
    return findCopilot(activeView) || findCopilot("general");
  }, [activeView]);

  // Issue #2568: Agents SDK routeAgentRequest routes by BINDING name
  // kebabbed, not class name. The binding was SEARCH_AGENT (class
  // OrchestratorAgent since migration v15, #2523), so this tab passed
  // "SearchAgent" — /agents/search-agent/ — as the interim fix.
  // Issue #2570 finished the rename on the binding side: the binding
  // is now ORCHESTRATOR_AGENT, "OrchestratorAgent" kebabs to
  // /agents/orchestrator-agent/, a real binding route, and the class
  // name is the correct address again. Instance name (login) and DO
  // state are unchanged by the binding rename: namespaces are per
  // class, not per binding name — same namespace, same
  // idFromName(login). (Pinned in
  // tests/orchestrator_binding_rename_2570.test.ts and
  // tests/agent_chat_routing_2568.test.ts.)
  const agent = useAgent({ agent: "OrchestratorAgent", name: user.login });
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
    messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
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

    const sourceTab = activeView === "options" ? "E*TRADE · Auto Options Research" : (currentCopilot?.sourceTab || "Chat & Agents");
    const lower = input.trim().toLowerCase();
    if (activeView === "stock") {
      if (lower === "pause" || lower === "pause loop" || lower === "pause stock copilot" || lower.includes("pause the loop") || lower.includes("pause stock copilot")) {
        setStockCopilotPaused(true).catch(() => {});
      } else if (lower === "resume" || lower === "resume loop" || lower === "resume stock copilot" || lower.includes("resume the loop") || lower.includes("resume stock copilot")) {
        setStockCopilotPaused(false).catch(() => {});
      }
    }
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
    const effectiveSource = sourceTab || (activeView === "options" ? "E*TRADE · Auto Options Research" : (currentCopilot?.sourceTab || "Chat & Agents"));
    if (isBusy || isResetting) return;
    const lower = prompt.trim().toLowerCase();
    if (activeView === "stock") {
      if (lower.includes("pause the stock copilot") || lower.includes("pause loop")) {
        setStockCopilotPaused(true).catch(() => {});
      } else if (lower.includes("resume the stock copilot") || lower.includes("resume loop")) {
        setStockCopilotPaused(false).catch(() => {});
      }
    }
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

  const renderChatConversation = () => (
    <>
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
              appearance="primary"
              className="sponsor-cta-btn"
              style={{ background: ads[0].accentColor }}
              onClick={() => onAdClick(ads[0])}
            >
              {ads[0].ctaText}
            </Button>
            <Button
              appearance="secondary"
              size="small"
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
        <span className="chat-subtitle">Stateful Distributed Ledger Session · neural strategy intelligence</span>
        {/* Default quick chips references for #2563: Bull Put Spread, Iron Condor */}
        {messages.length > 0 && (
          <Button
            appearance="subtle"
            size="small"
            onClick={handleClearWithConfirm}
            disabled={isResetting}
            title="Clear conversation and reset session"
          >
{isResetting ? (<><Spinner size="tiny" />{"🗑️ Clear chat"}</>) : ("🗑️ Clear chat")}
          </Button>
        )}
      </div>

      {resetNotice && (
        <MessageBar intent="success">
          <MessageBarBody>
            <span className="notice-text">{resetNotice}</span>
            {authExpired && (
              <a href="/login" className="notice-link-btn">
                Log In Again ➔
              </a>
            )}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Messages Stream */}
      <div className="messages-stream">
        {messages.length === 0 ? (
          <div className="hero-welcome">
            <div className="hero-icon">{currentCopilot?.hero?.icon || currentCopilot?.icon || "⚡"}</div>
            <h3>{currentCopilot?.hero?.title || currentCopilot?.label}</h3>
            <p>
              {currentCopilot?.hero?.description || currentCopilot?.tooltip?.description}
            </p>
            {currentCopilot?.quickChips && currentCopilot.quickChips.length > 0 && (
              <div className="quick-chips">
                {currentCopilot.quickChips.map((chip, idx) => (
                  <Button
                    key={idx}
                    appearance="subtle"
                    size="small"
                    disabled={isBusy || isResetting}
                    onClick={() =>
                      handleChipClick(
                        chip.prompt,
                        chip.category || currentCopilot?.sourceTab || currentCopilot?.label || "Copilot Guide",
                      )
                    }
                  >
                    {chip.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
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
        <MessageBar intent="error" className="chat-error-diagnostic-card">
          <MessageBarBody>
            <div className="chat-error-card-header">
              <div className="error-title-group">
              <div className="error-badge-row">
                <Badge size="extra-small" color="danger" appearance="filled">{errorAspect.code}</Badge>
                {errorAspect.isAiQuota && (
                  <Badge size="extra-small" style={{ textTransform: "uppercase" }} color="warning" appearance="tint">Daily Free Quota Limit</Badge>
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
              {errorAspect.resolutionSteps.map((step: string, sIdx: number) => (
                <li key={sIdx}>{step}</li>
              ))}
            </ol>
          </div>
          </MessageBarBody>
        </MessageBar>
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
          appearance="subtle"
          size="small"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("What are the capabilities of this platform and how do I use the 8 core workflows?", "Platform Capabilities")}
          title="Overview of all 8 platform workflows"
        >
          ⚡ Platform Capabilities
        </Button>
        <Button
          appearance="subtle"
          size="small"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("How do I use the Stock Screener to find equities and what fallback logic does it use?", "Stock Screener Guide")}
          title="Stock screener steps & fallback logic"
        >
          📈 Stock Screener
        </Button>
        <Button
          appearance="subtle"
          size="small"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("How do I screen for options strategies with max profit > 0 and max loss <= $30?", "Options Strategy Guide")}
          title="Screen options with budget risk limits"
        >
          🎯 Options: Max Profit & Loss
        </Button>
        <Button
          appearance="subtle"
          size="small"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("Explain how the PickBestTrades algorithm evaluates and scores setups.", "PickBestTrades Engine")}
          title="Multivariate opportunity scoring"
        >
          🧠 PickBestTrades Logic
        </Button>
        <Button
          appearance="secondary"
          size="small"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("How does Human-in-the-Loop (HITL) order execution and DID attestation work?", "Trading Safety Guide")}
          title="Safe trading with DID attestations"
        >
          🛡️ HITL Trading Guardrails
        </Button>
        <Button
          appearance="subtle"
          size="small"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("How does the real-time Options Flow tracker identify institutional sweeps and sentiment?", "Options Flow Guide")}
          title="Smart money sweeps and sentiment"
        >
          🌊 Options Flows & Sweeps
        </Button>
      </div>

      {/* Chat Input Bar */}
      <form className="chat-input-bar" onSubmit={handleSendChat}>
        <Input
          className={composerStyles.composerInput}
          type="text"
          aria-label="Ask the agent"
          value={input}
          onChange={(_e, data) => setInput(data.value)}
          placeholder={
            isResetting
              ? "Resetting session…"
              : isBusy
              ? "Agent is processing response…"
              : currentCopilot?.composerPlaceholder
              ? currentCopilot.composerPlaceholder
              : activeView === "options"
              ? "Ask Options Copilot (e.g. 'Screen for Bull Put spreads on NVDA with max loss <= $30', 'Best SPY Iron Condor')..."
              : "Ask about platform capabilities, workflows, how to screen, draft orders, or query data…"
          }
          disabled={isBusy || isResetting}
          autoFocus
        />
        <Button
          type="submit"
          appearance="primary"
          disabled={!input.trim() || isBusy || isResetting}
        >
{isBusy ? (<><Spinner size="tiny" />{"Send ➔"}</>) : ("Send ➔")}
        </Button>
      </form>
    </>
  );

  return (
    <div className="chat-view">
      <CapabilityNavBar
        ariaLabel="Copilot modes"
        tabs={chatCapabilityTabs}
        activeTabId={activeView}
        onTabChange={handleViewChange}
        className="chat-capability-subnav"
      />
      {/* Copilot Mode Banner (Options Copilot, Stock Copilot, or registered custom copilot) */}
      {currentCopilot?.banner && (
        <div className="options-copilot-banner">
          <div className="options-copilot-info">
            <span style={{ fontSize: "var(--font-size-title-sm)" }}>{currentCopilot.banner.icon}</span>
            <div>
              <strong style={{ color: "var(--color-text-primary)" }}>{currentCopilot.banner.headline}</strong>{" "}
              <span>{currentCopilot.banner.description}</span>
            </div>
          </div>
          {currentCopilot.banner.badgeText && (
            <Badge size="extra-small" style={{ textTransform: "uppercase" }} color={currentCopilot.banner.badgeColor || "brand"} appearance="tint">
              {currentCopilot.banner.badgeText}
            </Badge>
          )}
        </div>
      )}
      <Dialog
        open={clearConfirmOpen}
        onOpenChange={(_e, data) => {
          if (!data.open) setClearConfirmOpen(false);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Clear conversation history?</DialogTitle>
            <DialogContent>
              <p>Clear this conversation history? This cannot be undone.</p>
            </DialogContent>
            <DialogActions>
              <Button
                type="button"
                appearance="secondary"
                onClick={() => {
                  setClearConfirmOpen(false);
                  onResetSession(true);
                }}
              >
                Clear history
              </Button>
              <Button type="button" appearance="secondary" onClick={() => setClearConfirmOpen(false)}>
                Cancel
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      {/* #3449, #3521, #3541 — side-by-side copilot workspace:
          When a copilot declares a custom surface (e.g. Stock Copilot),
          render its telemetry/controls in a dedicated dashboard pane alongside
          the conversational chatbox (messages stream and sticky composer).
          Both panes have independent scrolling contexts, eliminating vertical
          squishing and nested scrollbar conflicts while allowing users to chat
          interactively with Stock Copilot. */}
      {currentCopilot && hasCustomSurface(currentCopilot) ? (
        <div className={surfaceStyles.splitLayout}>
          <div className={surfaceStyles.dashboardPane}>
            {currentCopilot.renderCustom ? (
              currentCopilot.renderCustom({ user, onChipClick: handleChipClick, onNavigateTab })
            ) : (
              <StockCopilotPanel />
            )}
          </div>
          <div className={surfaceStyles.chatPane}>
            {renderChatConversation()}
          </div>
        </div>
      ) : (
        <div className={surfaceStyles.fullChatArea}>
          {renderChatConversation()}
        </div>
      )}
    </div>
  );
}

function readFluentTheme() {
  if (typeof document === "undefined") return webLightTheme;
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? webDarkTheme
    : webLightTheme;
}

export function AgentChatTabContent(props: AgentChatTabContentProps) {
  const [fluentTheme, setFluentTheme] = useState(readFluentTheme);
  const providerStyles = useProviderStyles();
  useEffect(() => {
    const update = () => setFluentTheme(readFluentTheme());
    window.addEventListener("theme-changed", update);
    return () => window.removeEventListener("theme-changed", update);
  }, []);
  return (
    <FluentProvider theme={fluentTheme} className={providerStyles.provider}>
      <Toaster />
      <AgentChatTabContentInner {...props} />
    </FluentProvider>
  );
}
