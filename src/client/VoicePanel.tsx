import { Button, Notice, PageSection, PageShell, TextInput } from "./components/ui";
import { TradeExecutionPreview } from "./TradeExecutionPreview";
import { safePriceFormat } from "./formatters";
import type { BrokerPresentation } from "../trading/brokerPresentation";
import type { BrokerOrderDraft } from "../types";

/**
 * Voice trading desk panel (issue #3050, PR5).
 *
 * Moved out of the Hub's inline markup: the real-time voice desk — mic
 * controls, visualizer, quick chips, text fallback, and the conversation
 * feed with embedded HITL order previews — rendered in its own PageShell
 * inside the hub's shared shell. The markup is the Hub's, unchanged — only
 * the shell wrapper and section are new. Hub state and handlers arrive as
 * props; no data flow changed.
 */
export interface VoiceTranscriptEntry {
  role: "user" | "assistant";
  text: string;
  actionType?: string;
  orderId?: string;
  orderDraft?: any;
  brokerOrderRef?: string;
  marketQuote?: any;
  screenedStocks?: any[];
  timestamp: string;
}

interface VoicePanelProps {
  presentation: BrokerPresentation;
  selectedBroker: string;
  voiceStatus: "idle" | "listening" | "thinking" | "speaking";
  speechRecognitionActive: boolean;
  handleToggleVoiceRecording: () => void;
  voiceIsMuted: boolean;
  setVoiceIsMuted: (value: boolean) => void;
  voiceFailureCode: string | null;
  voiceInterim: string | null;
  handleVoiceTurn: (textToSubmit?: string) => Promise<void>;
  activeDraft: BrokerOrderDraft | null;
  voiceInputText: string;
  setVoiceInputText: (value: string) => void;
  voiceLoading: boolean;
  voiceTranscript: VoiceTranscriptEntry[];
  handleVoiceOrderAction: (action: "approve" | "cancel", orderId: string) => Promise<void>;
}

export function VoicePanel({
  presentation,
  selectedBroker,
  voiceStatus,
  speechRecognitionActive,
  handleToggleVoiceRecording,
  voiceIsMuted,
  setVoiceIsMuted,
  voiceFailureCode,
  voiceInterim,
  handleVoiceTurn,
  activeDraft,
  voiceInputText,
  setVoiceInputText,
  voiceLoading,
  voiceTranscript,
  handleVoiceOrderAction,
}: VoicePanelProps) {
  return (
    <PageShell
      title="Voice Trading Desk"
      scopeNote="Real-time conversational voice trading with speech synthesis and recognition — verbal quotes, screening, and strict two-stage verbal Human-in-the-Loop order drafting."
    >
      <PageSection title="Voice trading desk">
        <div className="tab-pane active voice-pane">
          {/* Issue #3429: the voice desk is E*TRADE\x27s service; say so for another broker. */}
          {selectedBroker !== "etrade" && (
            <Notice tone="warning" title={`${presentation.label} does not run the voice desk`}>
              The voice desk executes against E*TRADE. Nothing spoken here is previewed or routed for\n              {presentation.label}; use the Trading Hub order ticket or the neutral order API.
            </Notice>
          )}
          {/* Header Card */}
          <div className="voice-header-card">
            <div className="voice-header-top">
              <div>
                <span className="voice-header-badge">
                  Real-Time Voice Architecture
                </span>
                <h3 className="voice-header-title">
                  <span>🎙️</span> {presentation.deskName}
                </h3>
                <p className="voice-header-desc">
                  Real-time conversational voice trading with speech synthesis and recognition. Verbal quote inquiries, technical screening, and strict two-stage verbal Human-in-the-Loop order drafting.
                </p>
              </div>
              <div className="voice-header-status">
                <span className={`voice-status-pill ${voiceStatus}`}>
                  <span className={`voice-status-dot ${voiceStatus}`} />
                  {voiceStatus.toUpperCase()}
                </span>
              </div>
            </div>
          </div>

          <div className="voice-main-grid">
            {/* Visualizer & Mic Control Bar */}
            <div className="voice-control-card">
              <div className="voice-control-actions">
                <Button
                  type="button"
                  onClick={handleToggleVoiceRecording}
                  variant={speechRecognitionActive ? "danger" : "primary"}
                >
                  <span>{speechRecognitionActive ? "🛑 Stop Listening" : "🎙️ Push to Talk / Speak"}</span>
                </Button>

                <Button
                  type="button"
                  onClick={() => setVoiceIsMuted(!voiceIsMuted)}
                  variant="secondary"
                >
                  {voiceIsMuted ? "🔇 Voice Muted" : "🔊 Audio On"}
                </Button>
              </div>

              {/* Animated Audio Visualizer Bars */}
              <div className="voice-visualizer-bars">
                {[12, 24, 38, 20, 32, 16, 28, 36, 18, 26, 34, 14].map((h, i) => (
                  <div
                    key={i}
                    className={`voice-vbar ${voiceStatus}`}
                    style={{
                      height: voiceStatus === "speaking" || voiceStatus === "listening" ? `${Math.max(8, (h * (voiceStatus === "listening" ? 1.2 : 0.9)))}px` : "6px",
                    }}
                  />
                ))}
              </div>

              {/* Issue #3796: a named voice failure (the endpoint's
                  code) is a visible state, like the composer's —
                  never a silent fallback to the other backend. */}
              {voiceFailureCode && (
                <Notice tone="danger">
                  Voice failed ({voiceFailureCode}). Nothing was sent — type
                  your prompt below or use the quick chips instead.
                </Notice>
              )}

              {/* Interim Real-Time Transcript Display */}
              {voiceInterim && (
                <div className="voice-interim-box">
                  🎙️ <em>{voiceInterim}…</em>
                </div>
              )}

              {/* Quick Spoken Chips */}
              <div className="voice-chips-row">
                <Button
                  onClick={() => handleVoiceTurn("What is Nvidia trading at?")}
                  variant="secondary"
                  tone="subtle"
                  size="sm"
                >
                  📈 "What is Nvidia trading at?"
                </Button>
                <Button
                  onClick={() => handleVoiceTurn("Screen stocks priced between $20 and $200")}
                  variant="secondary"
                  tone="subtle"
                  size="sm"
                >
                  🔍 "Screen price range"
                </Button>
                <Button
                  onClick={() => handleVoiceTurn("What is my portfolio balance?")}
                  variant="secondary"
                  tone="subtle"
                  size="sm"
                >
                  💼 "Check portfolio balance"
                </Button>
                <Button
                  onClick={() => handleVoiceTurn("Buy 10 shares of NVDA at market")}
                  variant="primary"
                  tone="subtle"
                  size="sm"
                >
                  ⚡ "Buy 10 NVDA at market"
                </Button>
                {activeDraft && (
                  <>
                    <Button
                      onClick={() => handleVoiceTurn(`Confirm order ${activeDraft.orderId}`)}
                      variant="primary"
                      tone="subtle"
                      size="sm"
                    >
                      ✓ "Confirm order {activeDraft.orderId}"
                    </Button>
                    <Button
                      onClick={() => handleVoiceTurn(`Cancel order ${activeDraft.orderId}`)}
                      variant="danger"
                      tone="subtle"
                      size="sm"
                    >
                      ✕ "Cancel order {activeDraft.orderId}"
                    </Button>
                  </>
                )}
              </div>

              {/* Text Fallback Input Box */}
              <form
                onSubmit={(e) => { e.preventDefault(); handleVoiceTurn(); }}
                className="voice-input-form"
              >
                <TextInput
                  type="text"
                  placeholder="Or type a spoken command: e.g. 'What is Apple trading at?' or 'Buy 10 NVDA at market'"
                  value={voiceInputText}
                  onChange={(e) => setVoiceInputText(e.target.value)}
                  className="voice-text-input"
                />
                <Button
                  type="submit"
                  disabled={voiceLoading || !voiceInputText.trim()}
                  className="btn-voice-send"
                  variant="primary"
                 loading={voiceLoading}>
                  {"Send Voice Turn"}
                </Button>
              </form>
            </div>

            {/* Conversation Feed */}
            <div className="voice-feed-card">
              <h5 className="voice-feed-title">
                <span>💬</span> Live Voice Conversation History
              </h5>

              <div className="voice-feed-scroll">
                {voiceTranscript.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`voice-turn ${msg.role === "user" ? "user-turn" : "bot-turn"}`}
                  >
                    <div className="voice-turn-meta">
                      <span>{msg.role === "user" ? "👤 Trader (Voice)" : `🤖 ${presentation.deskAgentName}`}</span>
                      <span>• {msg.timestamp}</span>
                    </div>

                    <div className={`voice-bubble ${msg.role === "user" ? "user-bubble" : "bot-bubble"}`}>
                      <div>{msg.text}</div>

                      {/* Embedded HITL Order Preview Card in Voice Feed */}
                      {msg.actionType === "preview" && msg.orderDraft && (
                        <div className="voice-order-preview-box">
                          <div className="voice-order-preview-title">
                            🛡️ Order Preview Staged (HITL Required)
                          </div>
                          <div className="voice-order-preview-details">
                            <div><strong>Order ID:</strong> <code>{msg.orderDraft.orderId}</code></div>
                            <div><strong>Action:</strong> {msg.orderDraft.action} {msg.orderDraft.quantity} {msg.orderDraft.quantity === 1 ? "share" : "shares"} of {msg.orderDraft.symbol} {msg.orderDraft.orderType === "LIMIT" ? `(LIMIT @ ${safePriceFormat(msg.orderDraft.limitPrice || msg.orderDraft.estimatedPrice)})` : "(MARKET)"}</div>
                            <div><strong>Estimated Total:</strong> {safePriceFormat(msg.orderDraft.estimatedTotal)} USD</div>
                          </div>
                          {/* Issue #1773 (OWASP ASI-02): the voice
                              approve path shows the same exact
                              payload, fees, and slippage limits. */}
                          <TradeExecutionPreview draft={msg.orderDraft} />
                          <div className="voice-order-preview-actions">
                            <Button
                              onClick={() => handleVoiceOrderAction("approve", msg.orderDraft.orderId)}
                              variant="primary"
                              tone="subtle"
                            >
                              ✓ Voice Approve &amp; Execute
                            </Button>
                            <Button
                              onClick={() => handleVoiceOrderAction("cancel", msg.orderDraft.orderId)}
                              variant="danger"
                              tone="subtle"
                            >
                              ✕ Cancel Draft
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* Embedded Execution Receipt */}
                      {msg.actionType === "approval" && msg.brokerOrderRef && (
                        <div className="voice-receipt-box">
                          ✓ Broker Ref: <code>{msg.brokerOrderRef}</code> • Status: <strong>EXECUTED</strong>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </PageSection>
    </PageShell>
  );
}
