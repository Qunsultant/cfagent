import { Badge, Button, Card, CardHeader, Flex, Notice, PageSection, PageShell, Stack, TextInput } from "./components/ui";
import { TradeExecutionPreview } from "./TradeExecutionPreview";
import { safePriceFormat } from "./formatters";
import type { BrokerPresentation } from "../trading";
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
        <Stack gap="2">
          {/* Issue #3429: the voice desk is E*TRADE\x27s service; say so for another broker. */}
          {selectedBroker !== "etrade" && (
            <Notice tone="warning" title={`${presentation.label} does not run the voice desk`}>
              The voice desk executes against E*TRADE. Nothing spoken here is previewed or routed for\n              {presentation.label}; use the Trading Hub order ticket or the neutral order API.
            </Notice>
          )}
          {/* Header Card */}
          <Card padding="md">
            <CardHeader
              title={<><span>🎙️</span> {presentation.deskName}</>}
              subtitle="Real-time conversational voice trading with speech synthesis and recognition. Verbal quote inquiries, technical screening, and strict two-stage verbal Human-in-the-Loop order drafting."
              belowSubtitle={
                <Badge tone="success" size="xs" uppercase>
                  Real-Time Voice Architecture
                </Badge>
              }
              meta={
                <Badge
                  tone={
                    voiceStatus === "speaking"
                      ? "accent"
                      : voiceStatus === "listening"
                        ? "success"
                        : voiceStatus === "thinking"
                          ? "warning"
                          : "neutral"
                  }
                  dot
                >
                  {voiceStatus.toUpperCase()}
                </Badge>
              }
            />
          </Card>

          <Stack gap="2">
            {/* Visualizer & Mic Control Bar */}
            <Card padding="md">
              <Flex gap="2" align="center" justify="center" wrap>
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
              </Flex>

              {/* Animated Audio Visualizer Bars */}
              <Flex gap="0-5" align="center" justify="center">
                {[12, 24, 38, 20, 32, 16, 28, 36, 18, 26, 34, 14].map((h, i) => (
                  <div
                    key={i}
                    style={{
                      height: voiceStatus === "speaking" || voiceStatus === "listening" ? `${Math.max(8, (h * (voiceStatus === "listening" ? 1.2 : 0.9)))}px` : "6px",
                      width: 6,
                      borderRadius: 3,
                      background:
                        voiceStatus === "speaking"
                          ? "var(--color-accent)"
                          : voiceStatus === "listening"
                            ? "var(--color-success)"
                            : "var(--color-border-medium)",
                    }}
                  />
                ))}
              </Flex>

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
                <Notice tone="accent">
                  🎙️ <em>{voiceInterim}…</em>
                </Notice>
              )}

              {/* Quick Spoken Chips */}
              <Flex gap="1" justify="center" wrap>
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
              </Flex>

              {/* Text Fallback Input Box */}
              <form
                onSubmit={(e) => { e.preventDefault(); handleVoiceTurn(); }}
              >
                <Flex gap="1" align="center">
                <TextInput
                  type="text"
                  placeholder="Or type a spoken command: e.g. 'What is Apple trading at?' or 'Buy 10 NVDA at market'"
                  value={voiceInputText}
                  onChange={(e) => setVoiceInputText(e.target.value)}
                />
                <Button
                  type="submit"
                  disabled={voiceLoading || !voiceInputText.trim()}
                  variant="primary"
                 loading={voiceLoading}>
                  {"Send Voice Turn"}
                </Button>
                </Flex>
              </form>
            </Card>

            {/* Conversation Feed */}
            <Card padding="md">
              <CardHeader title={<><span>💬</span> Live Voice Conversation History</>} />

              <Stack gap="2">
                {voiceTranscript.map((msg, idx) => (
                  <Stack
                    key={idx}
                    gap="0-5"
                    align={msg.role === "user" ? "end" : "start"}
                  >
                    <span className="ui-meta">
                      {msg.role === "user" ? "👤 Trader (Voice)" : `🤖 ${presentation.deskAgentName}`} • {msg.timestamp}
                    </span>

                    <Card padding="sm" highlight={msg.role === "user"}>
                      <div>{msg.text}</div>

                      {/* Embedded HITL Order Preview Card in Voice Feed */}
                      {msg.actionType === "preview" && msg.orderDraft && (
                        <Notice tone="warning" title="🛡️ Order Preview Staged (HITL Required)">
                          <Stack gap="2">
                            <Stack gap="0-5">
                              <div><strong>Order ID:</strong> <code>{msg.orderDraft.orderId}</code></div>
                              <div><strong>Action:</strong> {msg.orderDraft.action} {msg.orderDraft.quantity} {msg.orderDraft.quantity === 1 ? "share" : "shares"} of {msg.orderDraft.symbol} {msg.orderDraft.orderType === "LIMIT" ? `(LIMIT @ ${safePriceFormat(msg.orderDraft.limitPrice || msg.orderDraft.estimatedPrice)})` : "(MARKET)"}</div>
                              <div><strong>Estimated Total:</strong> {safePriceFormat(msg.orderDraft.estimatedTotal)} USD</div>
                            </Stack>
                            {/* Issue #1773 (OWASP ASI-02): the voice
                                approve path shows the same exact
                                payload, fees, and slippage limits. */}
                            <TradeExecutionPreview draft={msg.orderDraft} />
                            <Flex gap="1" wrap>
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
                            </Flex>
                          </Stack>
                        </Notice>
                      )}

                      {/* Embedded Execution Receipt */}
                      {msg.actionType === "approval" && msg.brokerOrderRef && (
                        <Notice tone="success">
                          ✓ Broker Ref: <code>{msg.brokerOrderRef}</code> • Status: <strong>EXECUTED</strong>
                        </Notice>
                      )}
                    </Card>
                  </Stack>
                ))}
              </Stack>
            </Card>
          </Stack>
        </Stack>
      </PageSection>
    </PageShell>
  );
}
