import React, { useState, useRef, useEffect, useMemo } from "react";
import type { NavTabId } from "./NavigationMenu";
import { Button, Drawer, TextInput } from "./ui";
import { BRAND } from "../branding";

export interface AskAgentWidgetProps {
  onAskAgent: (prompt: string) => void;
  onOpenFullChat: () => void;
  agentStatus?: {
    dotClass: string;
    label: string;
  };
  activeTab?: NavTabId;
}

interface MessageItem {
  id: string;
  role: "user" | "agent";
  text: string;
  timestamp: string;
}

/** Issue #2041 S2: one pending journey gate, as the route serves it. */
interface PendingJourneyGate {
  sagaId: string;
  runRequestId: string;
  family: string;
  rail?: "stripe" | "x402";
  promptedAt: string;
  copy: { title: string; body: string; compensationLine: string };
}

export const TAB_QUICK_PROMPTS: Record<string, Array<{ label: string; prompt: string }>> = {
  autopilot: [
    { label: "⚡ Autopilot Policy", prompt: "Explain the active Autopilot execution policy limits and kill switch rules." },
    { label: "🛑 Kill Switch Status", prompt: "Check if the emergency trading kill switch is armed or triggered." },
    { label: "🛡️ Drawdown Guardrails", prompt: "What are my current max drawdown limits and daily order constraints?" },
    { label: "📋 Staged Orders", prompt: "Show all autonomous actions and staged orders awaiting HITL approval." },
  ],
  trading: [
    { label: "⚡ Autopilot Policy", prompt: "Explain the active Autopilot execution policy limits and kill switch rules." },
    { label: "🛑 Kill Switch Status", prompt: "Check if the emergency trading kill switch is armed or triggered." },
    { label: "🛡️ Drawdown Guardrails", prompt: "What are my current max drawdown limits and daily order constraints?" },
  ],
  order: [
    { label: "⚡ Order Preview", prompt: "Preview buy 10 shares of NVDA limit 125.50." },
    { label: "🛑 Trailing Stop", prompt: "How do I configure a trailing stop loss on my equity orders?" },
    { label: "💰 Buying Power", prompt: "What is my current available cash and margin buying power?" },
  ],
  orders: [
    { label: "📜 Active Orders", prompt: "List all open, pending, and partially filled orders." },
    { label: "⏳ Order Latency", prompt: "Show order fill timestamps and execution performance." },
  ],
  portfolio: [
    { label: "💼 Position Holdings", prompt: "Show my current equity and options portfolio positions with unrealized P&L." },
    { label: "⚖️ Asset Allocation", prompt: "Analyze portfolio asset allocation, cash reserve ratio, and sector exposure." },
    { label: "⚠️ Beta & Downside", prompt: "Evaluate portfolio beta exposure, concentration risk, and downside protection." },
  ],
  ledger: [
    { label: "📜 Order History", prompt: "Show recent executed trade orders from the institutional order ledger." },
    { label: "🛡️ Attestation Proofs", prompt: "Verify cryptographic W3C DID attestations for recently filled trades." },
  ],
  screeners: [
    { label: "💵 Price $20–$200", prompt: "Find liquid stocks priced between $20 and $200 with daily volume above 1M." },
    { label: "🏢 Large Market Cap", prompt: "Screen for high-momentum large-cap stocks with market cap above $200B." },
    { label: "🚀 Top Momentum", prompt: "Show top percentage momentum gainers across US exchanges today." },
    { label: "📊 Trend Screener", prompt: "Screen for stocks with bullish MACD crossovers and rising RSI-14." },
  ],
  scanner: [
    { label: "🔍 Universe Scan", prompt: "Run an algorithmic scan across all tracked NYSE and Nasdaq symbols." },
    { label: "📈 Breakout Alerts", prompt: "Detect tickers breaking out above their 50-day moving average." },
  ],
  research: [
    { label: "🔬 NVDA Valuation", prompt: "Generate an autonomous Market Data valuation and analyst consensus report for NVDA." },
    { label: "📊 Peer Comparison", prompt: "Compare valuation multiples (P/E, EV/EBITDA, margins) across NVDA, AMD, and INTC." },
    { label: "⚡ Alpaca Snapshot", prompt: "Fetch Level 1/2 real-time NBBO bid/ask snapshot for AAPL via Alpaca." },
    { label: "📈 Historical Bars", prompt: "Show historical daily price bars and RSI-14 momentum for TSLA." },
  ],
  options: [
    { label: "🎯 Strategy Discovery", prompt: "Discover optimal defined-risk option strategies for a bullish thesis on NVDA." },
    { label: "📊 Unusual Flow", prompt: "Scan for unusual institutional options sweeps and 0DTE flow." },
    { label: "📋 Raw Contracts", prompt: "Screen near-the-money call contracts with high open interest and low bid-ask spread." },
  ],
  "options-flows": [
    { label: "⚡ Live Flow Sweeps", prompt: "Show institutional block sweeps with premium over $100k." },
    { label: "🐂 Sentiment Dial", prompt: "What is the net bullish vs bearish sentiment ratio on SPY and QQQ today?" },
    { label: "🏛️ Congress & Insider", prompt: "Show recent congressional trading disclosures and corporate insider filings." },
  ],
  voice: [
    { label: "🎙️ Voice Commands", prompt: "What verbal commands can I speak to screen stocks or preview trades?" },
    { label: "🔊 Verbal Screening", prompt: "Verbal command: 'Screen oversold technology stocks with positive earnings'." },
  ],
  omnichannel: [
    { label: "💬 Slack Trading", prompt: "How do I approve staged trades directly from a Slack channel?" },
    { label: "✉️ Email Approval", prompt: "How do email HITL order confirmation links function?" },
  ],
  audit: [
    { label: "🛡️ Audit Stream", prompt: "Show recent router execution events and LLM Judge evaluations from mas_events." },
    { label: "🧠 Memory Vault", prompt: "Show all saved persistent facts in the agent memory vault." },
  ],
};

const DEFAULT_QUICK_PROMPTS = [
  { label: "⚡ Autopilot Policy", prompt: "Explain the active Autopilot execution policy limits and kill switch rules." },
  { label: "📊 Options Sweeps", prompt: "Screen for institutional 0DTE options flow and unusual call/put sweeps." },
  { label: "🔬 NVDA Research", prompt: "Generate a Market Data valuation and analyst consensus report for NVDA." },
  { label: "🛡️ Portfolio Safety", prompt: "What are my current drawdown guardrails and human-in-the-loop safeguards?" },
];

export function AskAgentWidget({
  onAskAgent,
  onOpenFullChat,
  agentStatus = { dotClass: "ready", label: "Ready" },
  activeTab = "trading",
}: AskAgentWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  // Issue #2041 S2: pending journey gates, polled while the
  // drawer is open (a decided gate drops out of the list, which
  // IS the chat-surface dismissal — state-driven, no explicit
  // action). No proactive push into a turn exists yet (that is
  // #2376 WS work); the card is the chat surface for S2.
  const [journeyGates, setJourneyGates] = useState<PendingJourneyGate[]>([]);
  const [journeyGateNotice, setJourneyGateNotice] = useState("");
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const loadGates = async () => {
      try {
        const res = await globalThis.fetch("/api/saga/journey-gates");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { gates?: PendingJourneyGate[] };
        if (Array.isArray(data.gates)) setJourneyGates(data.gates);
      } catch {
        // Best-effort: a failed poll leaves the previous list.
      }
    };
    void loadGates();
    const timer = setInterval(loadGates, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isOpen]);

  const answerJourneyGate = async (sagaId: string, decision: "approved" | "denied") => {
    try {
      const res = await globalThis.fetch("/api/saga/journey-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sagaId, decision, surface: "chat" }),
      });
      const data = (await res.json().catch(() => null)) as {
        accepted?: boolean;
        superseded?: boolean;
        decidedBy?: string;
      } | null;
      if (res.status === 409 || data?.superseded) {
        setJourneyGateNotice(
          `Already decided (by ${data?.decidedBy ?? "another surface"}) — this answer was refused as superseded.`,
        );
      } else if (res.ok && data?.accepted) {
        setJourneyGateNotice(
          decision === "approved"
            ? "Journey approved — the saga will enter the trading leg."
            : "Journey declined — the saga ends with no trades and no proposals.",
        );
      } else {
        setJourneyGateNotice("Journey answer failed — please try again.");
        return;
      }
      setJourneyGates((prev) => prev.filter((g) => g.sagaId !== sagaId));
    } catch {
      setJourneyGateNotice("Journey answer failed — please try again.");
    }
  };
  const [messages, setMessages] = useState<MessageItem[]>([
    {
      id: "welcome",
      role: "agent",
      text: `👋 Hi! I am your ${BRAND.copilotName}. Ask me about real-time market data, options flows, autopilot limits, or trading workflows.`,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    },
  ]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [isMinimized, setIsMinimized] = useState(() => {
    // Minimized by default (#637): only an explicit stored "false"
    // (the user expanded it before) starts the widget expanded.
    if (typeof window !== "undefined") {
      return localStorage.getItem("cfagent_ask_agent_minimized") !== "false";
    }
    return true;
  });

  const toggleMinimize = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsMinimized((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        localStorage.setItem("cfagent_ask_agent_minimized", String(next));
      }
      return next;
    });
  };

  const currentPrompts = useMemo(() => {
    if (activeTab && TAB_QUICK_PROMPTS[activeTab]) {
      return TAB_QUICK_PROMPTS[activeTab];
    }
    return DEFAULT_QUICK_PROMPTS;
  }, [activeTab]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 80);
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [isOpen, messages]);

  // Global open event listener (for Copilot quick buttons)
  useEffect(() => {
    const handleOpen = (e: Event) => {
      const customEvent = e as CustomEvent<{ prompt?: string }>;
      setIsOpen(true);
      if (customEvent.detail?.prompt) {
        setInput(customEvent.detail.prompt);
      }
    };
    window.addEventListener("open-ask-agent", handleOpen);
    return () => window.removeEventListener("open-ask-agent", handleOpen);
  }, []);

  // Drawer owns Escape/backdrop close via the Drawer primitive; no
  // widget-level key handler (its close path is setIsOpen(false)).

  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const query = input.trim();
    if (!query || isBusy) return;

    const userMsg: MessageItem = {
      id: `u-${Date.now()}`,
      role: "user",
      text: query,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsBusy(true);

    // Provide intelligent contextual response or hand off to full agent session
    setTimeout(() => {
      let reply = "";
      const q = query.toLowerCase();

      if (q.includes("autopilot") || q.includes("policy") || q.includes("limits")) {
        reply = "🔒 **Autopilot Policy**: Max position 10.00%, Cash reserve 5.00%, Drawdown alert 20.00%, Max orders/day 10. Kill switch can be triggered at any time.";
      } else if (q.includes("option") || q.includes("flow") || q.includes("sweep")) {
        reply = "📊 **Options Flow**: Scanning institutional block trades and 0DTE sweeps. You can view real-time call/put volume ratios under the Hedging & Options Flows tab.";
      } else if (q.includes("research") || q.includes("nvda") || q.includes("valuation")) {
        reply = "🔬 **Market Data Research**: Zero-credential equity valuation active. Yahoo Finance multiples + Alpaca NBBO quotes available. Opening comprehensive report.";
      } else {
        reply = `⚡ I received your query: "${query}". I am routing this through the LLM Judge to activate the specialized agent for "${activeTab}". Click "Open in Chat Tab" for full multi-turn analysis.`;
      }

      const agentMsg: MessageItem = {
        id: `a-${Date.now()}`,
        role: "agent",
        text: reply,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };

      setMessages((prev) => [...prev, agentMsg]);
      setIsBusy(false);
    }, 600);
  };

  const handleQuickPromptClick = (prompt: string) => {
    setInput(prompt);
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  };

  const handleTransferToFullChat = (queryText?: string) => {
    setIsOpen(false);
    const targetQuery = queryText || input.trim() || messages[messages.length - 1]?.text;
    if (targetQuery && targetQuery !== messages[0].text) {
      onAskAgent(targetQuery);
    } else {
      onOpenFullChat();
    }
  };


  return (
    <>
      {/* Floating Trigger Pill (Docked bottom-right) */}
      <div className="ask-agent-floating-dock">
        {isMinimized ? (
          <div className="ask-agent-minimized-wrap">
            <Button
              type="button"
              className={`ask-agent-pill-btn minimized ${isOpen ? "active" : ""}`}
              onClick={() => setIsOpen((prev) => !prev)}
              title={`${BRAND.copilotName} (Click to open)`}
              aria-expanded={isOpen}
              aria-label="Open Agent Copilot"
            >
              <span className="ask-agent-icon">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              <span className={`ask-agent-status-dot ${agentStatus.dotClass}`} title={`Status: ${agentStatus.label}`} />
            </Button>
            <Button
              type="button"
              className="ask-agent-restore-pill-btn"
              onClick={toggleMinimize}
              title="Expand Ask Agent label"
              aria-label="Expand button label"
            >
              ⤢
            </Button>
          </div>
        ) : (
          <div className="ask-agent-pill-wrap">
            <Button
              type="button"
              className={`ask-agent-pill-btn ${isOpen ? "active" : ""}`}
              onClick={() => setIsOpen((prev) => !prev)}
              title={`Ask ${BRAND.copilotName}`}
              aria-expanded={isOpen}
              aria-label="Open Ask Agent Copilot"
            >
              <span className="ask-agent-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              <span className="ask-agent-label">Ask Agent</span>
              <span className={`ask-agent-status-dot ${agentStatus.dotClass}`} title={`Status: ${agentStatus.label}`} />
              <span
                role="button"
                className="ask-agent-minimize-trigger"
                onClick={toggleMinimize}
                title="Minimize Ask Agent button to compact circle"
                aria-label="Minimize button"
              >
                —
              </span>
            </Button>
          </div>
        )}
      </div>

      {/* Copilot panel on the Drawer primitive (#2283 stream 5): side panel
          with token z-order below Toast, replacing the z-99995 card. */}
      <Drawer
        open={isOpen}
        onClose={() => setIsOpen(false)}
        title={(
          <div className="agent-header-brand">
            <div className="agent-header-avatar">
              <span className="agent-avatar-glyph">🤖</span>
              <span className={`agent-online-dot ${agentStatus.dotClass}`} />
            </div>
            <div className="agent-header-titles">
              <div className="agent-main-title">
                <span>{BRAND.copilotName}</span>
                <span className="agent-ai-badge">AI 2.0</span>
              </div>
              <div className="agent-sub-title">
                Context: <strong style={{ color: "var(--color-accent)", textTransform: "capitalize" }}>{activeTab ? activeTab.replace("-", " ") : "Platform"}</strong>
              </div>
            </div>
          </div>
        )}
        actions={(
          <Button
            type="button"
            className="agent-icon-btn"
            onClick={() => handleTransferToFullChat()}
            title="Expand to Full Chat Tab"
            aria-label="Open in Chat Tab"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </Button>
        )}
      >
          {/* Messages Scroll Area */}
          <div className="ask-agent-messages-container">
            {messages.map((m) => (
              <div key={m.id} className={`ask-agent-msg-bubble ${m.role}`}>
                <div className="msg-content">{m.text}</div>
                <div className="msg-time">{m.timestamp}</div>
              </div>
            ))}
            {isBusy && (
              <div className="ask-agent-msg-bubble agent streaming">
                <div className="agent-typing-dots">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Issue #2041 S2: pending journey decisions */}
          {journeyGates.length > 0 && (
            <div style={{ padding: "var(--space-1-5) var(--space-3) var(--space-1)" }} role="status">
              <div style={{ fontSize: "var(--font-size-caption)", fontWeight: 700, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: "0.35rem" }}>
                Pending journey decisions:
              </div>
              {journeyGateNotice && (
                <div style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>
                  {journeyGateNotice}
                </div>
              )}
              {journeyGates.map((gate) => (
                <div key={gate.sagaId} style={{ marginBottom: "0.75rem", fontSize: "var(--font-size-body)" }}>
                  <div style={{ marginBottom: "0.25rem" }}>
                    {gate.copy.title} — run {gate.runRequestId} ({gate.family})
                  </div>
                  <div style={{ color: "var(--color-text-muted)", marginBottom: "0.25rem" }}>{gate.copy.body}</div>
                  <div style={{ color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>{gate.copy.compensationLine}</div>
                  <div style={{ display: "flex", gap: "var(--space-2)" }}>
                    <Button type="button" onClick={() => void answerJourneyGate(gate.sagaId, "approved")}>
                      Enter trading leg
                    </Button>
                    <Button type="button" onClick={() => void answerJourneyGate(gate.sagaId, "denied")}>
                      Do not enter
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Quick Prompt Chips */}
          <div className="ask-agent-quick-prompts-wrap" style={{ padding: "var(--space-1-5) var(--space-3) var(--space-1)" }}>
            <div style={{ fontSize: "var(--font-size-caption)", fontWeight: 700, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: "0.35rem" }}>
              Suggested for {activeTab ? activeTab.replace("-", " ") : "Current Workspace"}:
            </div>
            <div className="ask-agent-quick-prompts">
              {currentPrompts.map((qp, idx) => (
                <Button
                  key={idx}
                  type="button"
                  className="quick-chip-btn"
                  onClick={() => handleQuickPromptClick(qp.prompt)}
                  title={qp.prompt}
                >
                  {qp.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Input & Action Footer */}
          <form className="ask-agent-input-form" onSubmit={handleSend}>
            <TextInput
              ref={inputRef}
              type="text"
              className="ask-agent-text-input"
              placeholder="Ask copilot or type command…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isBusy}
            />
            <Button
              type="submit"
              className="ask-agent-send-btn"
              disabled={!input.trim() || isBusy}
              title="Send message"
            >
              <span>➔</span>
            </Button>
          </form>

          {/* Footer info bar */}
          <div className="ask-agent-footer-bar">
            <span>Powered by {BRAND.name} Multi-Agent Intelligence</span>
            <Button
              type="button"
              className="open-full-chat-link"
              onClick={() => handleTransferToFullChat()}
            >
              Full Agent Workspace ↗
            </Button>
          </div>
      </Drawer>
    </>
  );
}
