import React from "react";
import { resolveErrorAspect } from "../../aspects/errorCodes";
import { logAspectEvent } from "../../aspects/loggingAspect";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { extractText } from "./types";
import { useUrlSyncedTabs } from "../useUrlSyncedTabs";
import { CapabilityNavBar, type CapabilityTabItem } from "../components/CapabilityNavBar";
import { TabHoverItem } from "../TabHoverItem";
import type { AdItem, User } from "./types";
import { MarkdownContent } from "./MarkdownContent";
import { ReasoningView } from "./ReasoningView";
import { ToolResultView } from "./ToolResultView";
import { StockCopilotPanel } from "../StockCopilotPanel";
import { setStockCopilotPaused } from "../stockCopilotApi";
import {
  copilotVoiceEffective,
  fetchCopilotChannels,
  type CopilotChannelsProjection,
} from "../copilotChannelsApi";
import {
  ChatComposerVoiceButtons,
  ChatComposerVoiceFeedback,
  useChatComposerVoice,
} from "./ChatComposerVoiceControl";
import { createVoiceBackend } from "../voiceBackend";
import { findCopilot, getRegisteredCopilots, hasCustomSurface, isRegisteredCopilotId } from "./copilotRegistry";
// Fluent v9 replaces our primitives on this page only (#3146 experiment).
// Measured gaps vs our primitives: no danger button (secondary used),
// no tone system (chips collapse to subtle), no strip/box Notice variant.
import {
  Badge,
  Button,
  Flex,
  Modal,
  Notice,
  Spinner,
  TextInput,
} from "../components/ui";
import { CardHeader } from "../components/ui";
import { createClientLogger } from "../clientLogger";
import { fetchAccountBindings } from "../accountBindingStore";
import { messageHasBindingSwitch } from "./bindingBridge";

const log = createClientLogger("client/AgentChatTabContent");

/* Issue #5843 — the Griffel blocks became tokens-only classes in
   primitives.css; these maps keep every `styles.x` call site unchanged. */
const composerStyles = { composerInput: "ui-chat-composer-input" };
const navRightStyles = { group: "ui-chat-nav-right" };
const providerStyles = { provider: "ui-chat-viewport" };
const quickChipsStyles = {
  chipsBar: "ui-chat-chips-bar",
  toggleButton: "ui-chat-chips-toggle",
};
const surfaceStyles = {
  splitLayout: "ui-chat-split",
  dashboardPane: "ui-chat-dashboard-pane",
  chatPane: "ui-chat-chat-pane",
  fullChatArea: "ui-chat-full-area",
};
export type ChatSubView = "general" | "options" | "stock" | (string & {});

export function isValidChatSubView(view: unknown): view is ChatSubView {
  return typeof view === "string" && (view === "general" || view === "options" || view === "stock" || isRegisteredCopilotId(view));
}

interface AgentChatTabContentProps {
  user: User;
  ads: AdItem[];
  onAdClick: (ad: AdItem) => void;
  onOpenAdsTab: () => void;
  onNavigateTab?: (tab: "chat" | "nlq" | "audit" | "payments" | "referrals" | "ads" | "marketing-hub" | "revenue" | "endpoints" | "trading" | "research" | "options-flows" | "workflows") => void;
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
  const [isPromptChipsExpanded, setIsPromptChipsExpanded] = useState(true);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
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

  // Issue #3773: the active registration's channel projection,
  // read from the server (GET /api/copilot-channels) — the
  // composer mic renders exactly when the projection's voice
  // channel resolves effective. Resolution is server-side (the
  // #3738 switch resolver + the #3720 activation); a failed or
  // absent read renders no mic (the affordance fails absent,
  // like the Stock Copilot panel's voice control).
  const [channelsProjection, setChannelsProjection] =
    useState<CopilotChannelsProjection | null>(null);
  useEffect(() => {
    let cancelled = false;
    setChannelsProjection(null);
    if (!isRegisteredCopilotId(activeView)) return;
    fetchCopilotChannels(activeView)
      .then((projection) => {
        if (!cancelled) setChannelsProjection(projection);
      })
      .catch(() => {
        if (!cancelled) setChannelsProjection(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeView, user.login]);

  // Issue #3773: the ONE voice backend adapter for the active
  // registration — the projection carries the server-resolved
  // backend switch (stored > env > code default "webspeech");
  // the composer control consumes the seam, never the id.
  const voiceBackend = useMemo(
    () =>
      channelsProjection
        ? createVoiceBackend(channelsProjection.voiceBackend.backend, {
            registration: activeView,
          })
        : null,
    [channelsProjection, activeView],
  );

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
    if (status === "ready" && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("stock-copilot:updated"));
    }
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

  // Issue #5101 (F4 of #5094): a chat switch through the
  // `broker_account_binding` tool re-binds the server binding — reload
  // the F2 client store from the server so every surface shows the new
  // binding. The tool result is masked, so the reload (not the result)
  // is the authority; each message id reloads at most once.
  const seenBindingToolMessagesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const msg of messages ?? []) {
      if (!msg || typeof msg !== "object") continue;
      const msgId = String((msg as any).id ?? "");
      if (!msgId || seenBindingToolMessagesRef.current.has(msgId)) continue;
      if (!messageHasBindingSwitch(msg)) continue;
      seenBindingToolMessagesRef.current.add(msgId);
      void fetchAccountBindings(true);
    }
  }, [messages]);

  const isBusy = status === "streaming" || status === "submitted";

  // The ONE chat send path: typed composer submits and voice
  // transcripts (#3773) both land as normal user turns through
  // here — same busy/reset guards, same reconnect, same sourceTab
  // carrier, same stock pause/resume text interception. Returns
  // true when the turn was submitted.
  const sendChatText = (raw: string): boolean => {
    const text = raw.trim();
    if (!text || isBusy || isResetting) return false;

    if (typeof (agent as any).reconnect === "function" && (agent as any).readyState !== 1) {
      try {
        (agent as any).reconnect();
      } catch {
        // ignore
      }
    }

    const baseSourceTab = activeView === "options" ? "Broker · Auto Options Research" : (currentCopilot?.sourceTab || "Chat & Agents");
    const isStockTradePrompt =
      activeView !== "options" &&
      !/\b(options?|calls?|puts?|iron condor|straddle|strangle|credit spread|debit spread|dte|greeks)\b/i.test(text) &&
      /\b(draft a limit (?:buy|sell)|limit (?:buy|sell) order|market (?:buy|sell) order|preview (?:buy|sell)|buy \d+\s+[a-z]{1,5}\b|sell \d+\s+[a-z]{1,5}\b|buy [a-z]{1,5} at (?:market|limit)|sell [a-z]{1,5} at (?:market|limit)|take-profit.*stop-loss|bracket exits?|alp_ord_|approve (?:[a-z]+\s+)?trade draft|stock copilot|enable autopilot|disable autopilot|autopilot status|autopilot limits|kill[- ]switch)\b/i.test(text);
    const sourceTab = isStockTradePrompt ? "Stock Copilot" : baseSourceTab;
    const lower = text.toLowerCase();
    if (activeView === "stock") {
      if (lower === "pause" || lower === "pause loop" || lower === "pause stock copilot" || lower.includes("pause the loop") || lower.includes("pause stock copilot")) {
        setStockCopilotPaused(true).catch(() => {});
      } else if (lower === "resume" || lower === "resume loop" || lower === "resume stock copilot" || lower.includes("resume the loop") || lower.includes("resume stock copilot")) {
        setStockCopilotPaused(false).catch(() => {});
      }
    }
    try {
      sendMessage({
        text,
        content: text,
        role: "user",
        parts: [{ type: "text", text }],
        metadata: { sourceTab, userLogin: user.login },
      } as any);
      return true;
    } catch (err) {
      log.error("agentChatTabContent.send_chat_message_failed", {
        message: "Failed to send chat message",
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  // Issue #3794: the tab owns the composer voice state so the
  // channel's feedback (named-failure notices, transient status)
  // can sit beside the chat box while its CONTROLS (mic + mute)
  // render inline inside the box — voice has no separate bar.
  // The hook is inert until the projection resolves a backend;
  // voiceOn is the #3773 gate (projection effective + backend).
  const voiceOn = copilotVoiceEffective(channelsProjection) && voiceBackend !== null;
  const composerVoice = useChatComposerVoice({
    disabled: isResetting,
    isBusy,
    messages,
    backend: voiceBackend,
    onSubmitTranscript: (text) => {
      sendChatText(text);
    },
  });

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (sendChatText(input)) setInput("");
  };

  const handleChipClick = (prompt: string, sourceTab?: string) => {
    const baseSource = sourceTab || (activeView === "options" ? "Broker · Auto Options Research" : (currentCopilot?.sourceTab || "Chat & Agents"));
    const isStockChip =
      activeView !== "options" &&
      !/\b(options?|calls?|puts?|iron condor|straddle|strangle|credit spread|debit spread|dte|greeks)\b/i.test(prompt) &&
      /\b(draft a limit (?:buy|sell)|limit (?:buy|sell) order|market (?:buy|sell) order|preview (?:buy|sell)|buy \d+\s+[a-z]{1,5}\b|sell \d+\s+[a-z]{1,5}\b|buy [a-z]{1,5} at (?:market|limit)|sell [a-z]{1,5} at (?:market|limit)|take-profit.*stop-loss|bracket exits?|alp_ord_|approve (?:[a-z]+\s+)?trade draft|stock copilot|enable autopilot|disable autopilot|autopilot status|autopilot limits|kill[- ]switch)\b/i.test(prompt);
    const effectiveSource = isStockChip ? "Stock Copilot" : baseSource;
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
        metadata: { sourceTab: effectiveSource, userLogin: user.login },
      } as any);
    } catch (err) {
      log.error("agentChatTabContent.send_chip_action_failed", {
        message: "Failed to send chip action",
        error: err instanceof Error ? err.message : String(err),
      });
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
              variant="primary"
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

      {resetNotice && (
        <Notice tone="success">
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
          <div className="hero-welcome">
            <div className="hero-icon">{currentCopilot?.hero?.icon || currentCopilot?.icon || "⚡"}</div>
            <CardHeader title={currentCopilot?.hero?.title || currentCopilot?.label} />
            <p>
              {currentCopilot?.hero?.description || currentCopilot?.tooltip?.description}
            </p>
            {currentCopilot?.quickChips && currentCopilot.quickChips.length > 0 && (
              <div className="quick-chips">
                {currentCopilot.quickChips.map((chip, idx) => (
                  <Button
                    key={idx}
                    variant="secondary" tone="subtle"
                    size="sm"
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
        <Notice tone="danger" variant="box">
            <div className="chat-error-card-header">
              <div className="error-title-group">
              <div className="error-badge-row">
                <Badge size="xs" tone="danger">{errorAspect.code}</Badge>
                {errorAspect.isAiQuota && (
                  <Badge size="xs" tone="warning" uppercase>Daily Free Quota Limit</Badge>
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
          </Notice>
      )}

      {/* Persistent Copilot Quick Prompt Chips Strip during ongoing conversation (#3656).
          Default quick chips references for #2563: Bull Put Spread, Iron Condor. */}
      {currentCopilot?.quickChips && currentCopilot.quickChips.length > 0 && messages.length > 0 && (
        <div
          className={quickChipsStyles.chipsBar}
          data-testid="copilot-quick-chips-bar"
        >
          <Button
            variant="secondary" tone="subtle"
            size="sm"
            className={quickChipsStyles.toggleButton}
            data-testid="toggle-copilot-chips"
            onClick={() => setIsPromptChipsExpanded((prev) => !prev)}
            title={isPromptChipsExpanded ? "Collapse quick prompt chips" : "Expand quick prompt chips"}
          >
            {isPromptChipsExpanded ? "▼ Prompts" : `▶ Prompts (${currentCopilot.quickChips.length})`}
          </Button>
          {isPromptChipsExpanded &&
            currentCopilot.quickChips.map((chip, idx) => (
              <Button
                key={idx}
                variant="secondary" tone="subtle"
                size="sm"
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
          variant="secondary" tone="subtle"
          size="sm"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("What are the capabilities of this platform and how do I use the 8 core workflows?", "Platform Capabilities")}
          title="Overview of all 8 platform workflows"
        >
          ⚡ Platform Capabilities
        </Button>
        <Button
          variant="secondary" tone="subtle"
          size="sm"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("How do I use the Stock Screener to find equities and what fallback logic does it use?", "Stock Screener Guide")}
          title="Stock screener steps & fallback logic"
        >
          📈 Stock Screener
        </Button>
        <Button
          variant="secondary" tone="subtle"
          size="sm"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("How do I screen for options strategies with max profit > 0 and max loss <= $30?", "Options Strategy Guide")}
          title="Screen options with budget risk limits"
        >
          🎯 Options: Max Profit & Loss
        </Button>
        <Button
          variant="secondary" tone="subtle"
          size="sm"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("Explain how the PickBestTrades algorithm evaluates and scores setups.", "PickBestTrades Engine")}
          title="Multivariate opportunity scoring"
        >
          🧠 PickBestTrades Logic
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("How does Human-in-the-Loop (HITL) order execution and DID attestation work?", "Trading Safety Guide")}
          title="Safe trading with DID attestations"
        >
          🛡️ HITL Trading Guardrails
        </Button>
        <Button
          variant="secondary" tone="subtle"
          size="sm"
          disabled={isBusy || isResetting}
          onClick={() => handleChipClick("How does the real-time Options Flow tracker identify institutional sweeps and sentiment?", "Options Flow Guide")}
          title="Smart money sweeps and sentiment"
        >
          🌊 Options Flows & Sweeps
        </Button>
      </div>

      {/* Voice channel feedback (#3773, #3794): the named-failure
          notices and transient status sit beside the chat box;
          the voice CONTROLS render inside the box itself — the
          Input's contentAfter slot, at the field's trailing edge —
          never on a separate bar and never as form-level siblings
          of the field. Rendered only when the active
          registration's voice channel resolves effective;
          transcripts submit through sendChatText, the same path
          as typed turns. */}
      {voiceOn && <ChatComposerVoiceFeedback voice={composerVoice} />}

      {/* Chat Input Bar */}
      <form className="chat-input-bar" onSubmit={handleSendChat}>
        <TextInput
          className={composerStyles.composerInput}
          type="text"
          aria-label="Ask the agent"
          value={input}
          onChange={(e) => setInput(e.target.value)}
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
          trailing={voiceOn ? <ChatComposerVoiceButtons voice={composerVoice} /> : undefined}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!input.trim() || isBusy || isResetting}
        >
{isBusy ? (<><Spinner size="sm" />{"Send ➔"}</>) : ("Send ➔")}
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
        rightContent={
          messages.length > 0 || currentCopilot ? (
            <div className={navRightStyles.group}>
              {/* Clear chat lives here now (owner surface pass
                  with #3794): immediately left of the Info badge,
                  so its old dedicated action-bar row no longer
                  takes vertical space from the chat area. Same
                  conditional render, handler, and states as
                  before; the confirm Dialog stays below. When no
                  copilot is registered the group renders with
                  just this button. */}
              {messages.length > 0 && (
                <Button
                  variant="secondary" tone="subtle"
                  size="sm"
                  onClick={handleClearWithConfirm}
                  disabled={isResetting}
                  title="Clear conversation and reset session"
                >
                  {isResetting ? (
                    <>
                      <Spinner size="sm" />
                      {"🗑️ Clear chat"}
                    </>
                  ) : (
                    "🗑️ Clear chat"
                  )}
                </Button>
              )}
              {currentCopilot && (
                <TabHoverItem
                  align="right"
                  eyebrow={currentCopilot.label}
                  title={currentCopilot.tooltip?.title || currentCopilot.label}
                  description={currentCopilot.banner?.description || currentCopilot.tooltip?.description || ""}
                >
                  <span
                    tabIndex={0}
                    role="note"
                    aria-label={`${currentCopilot.label} details`}
                  >
                  <Badge
                    className="copilot-hover-info-badge"
                    tone="accent"
                    size="sm"
                  >
                    ℹ️ {currentCopilot.label} Info
                  </Badge>
                  </span>
                </TabHoverItem>
              )}
            </div>
          ) : undefined
        }
      />
      <Modal
        open={clearConfirmOpen}
        onClose={() => setClearConfirmOpen(false)}
        title="Clear conversation history?"
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setClearConfirmOpen(false);
                onResetSession(true);
              }}
            >
              Clear history
            </Button>
            <Button type="button" variant="secondary" onClick={() => setClearConfirmOpen(false)}>
              Cancel
            </Button>
          </>
        }
      >
        <p>Clear this conversation history? This cannot be undone.</p>
      </Modal>
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

export function AgentChatTabContent(props: AgentChatTabContentProps) {
  return (
    <div className={providerStyles.provider}>
      <AgentChatTabContentInner {...props} />
    </div>
  );
}
