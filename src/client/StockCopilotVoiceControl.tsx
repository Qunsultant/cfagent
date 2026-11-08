/**
 * Issue #3738 — the Stock Copilot panel's voice control.
 *
 * Rendered by StockCopilotPanel only when the stock registration's
 * voice channel resolves ON (the #3738 channel switch composed
 * with the #3720 class-level activation — the status read's
 * channels.voice.effective). It runs voice turns through the
 * EXISTING desk client machinery (src/client/voiceDeskClient.ts —
 * the Trading Hub voice tab's STT → POST /api/trading/voice/turn →
 * TTS pattern, extracted and shared by #3738), stamping each turn
 * with the stock registration's context (sourceTab) so the #3720
 * route composition serves it under the copilot's own broker
 * selection. Order drafting keeps the desk's two-stage verbal
 * Human-in-the-Loop confirmation — this control adds no execution
 * path of its own.
 *
 * Built only from src/client/components/ui/ primitives with
 * token-only styling (ux-architecture §20); classes live in
 * stockCopilotPanel.css (the panel's registered stylesheet).
 */
import React, { useRef, useState } from "react";
import { Badge, Button, Notice, TextInput } from "./components/ui";
import {
  isVoiceRecognitionSupported,
  speakVoiceText,
  startVoiceRecognition,
  submitVoiceTurn,
} from "./voiceDeskClient";

type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

interface VoiceExchange {
  role: "user" | "assistant";
  text: string;
}

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

export function StockCopilotVoiceControl(props: { sourceTab: string }) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [exchanges, setExchanges] = useState<VoiceExchange[]>([]);
  const [interim, setInterim] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  const runTurn = async (raw: string) => {
    const prompt = raw.trim();
    if (!prompt) return;
    setFailed(false);
    setInputText("");
    setInterim(null);
    setStatus("thinking");
    setExchanges((prev) => [...prev, { role: "user", text: prompt }]);
    try {
      const data = await submitVoiceTurn(prompt, {
        sourceTab: props.sourceTab,
      });
      const reply =
        data.spokenText || data.displayMarkdown || "Request processed.";
      setExchanges((prev) => [...prev, { role: "assistant", text: reply }]);
      setStatus("speaking");
      const spoke = speakVoiceText(data.spokenText || "", {
        muted,
        onEnd: () => setStatus("idle"),
      });
      if (!spoke) setStatus("idle");
    } catch {
      setFailed(true);
      setStatus("idle");
    }
  };

  const toggleRecording = () => {
    if (status === "listening") {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      setStatus("idle");
      return;
    }
    if (!isVoiceRecognitionSupported()) {
      setUnsupported(true);
      return;
    }
    setUnsupported(false);
    const handle = startVoiceRecognition({
      onStart: () => setStatus("listening"),
      onInterim: (text) => setInterim(text),
      onFinal: (text) => {
        recognitionRef.current = null;
        setInterim(null);
        void runTurn(text);
      },
      onError: () => {
        recognitionRef.current = null;
        setStatus("idle");
      },
      onEnd: () => {
        recognitionRef.current = null;
        setStatus((current) => (current === "listening" ? "idle" : current));
      },
    });
    if (!handle) {
      setUnsupported(true);
      setStatus("idle");
      return;
    }
    recognitionRef.current = handle;
  };

  return (
    <div data-testid="stock-copilot-voice">
      <div className="scp-section-title">Voice</div>
      <p className="scp-desc">
        Talk to the Stock Copilot through the voice desk — quotes, screening,
        positions, and order drafts with the desk's two-stage verbal
        confirmation. Turns run under the copilot's selected broker.
      </p>
      <div className="scp-actions">
        <Button
          type="button"
          variant={status === "listening" ? "primary" : "secondary"}
          size="sm"
          onClick={toggleRecording}
          title="Start or stop voice input"
        >
          {status === "listening" ? "⏹ Stop listening" : "🎙 Speak"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setMuted((m) => !m)}
          title="Toggle spoken replies"
        >
          {muted ? "🔇 Audio muted" : "🔊 Audio on"}
        </Button>
        <Badge size="sm" tone={status === "idle" ? "neutral" : "info"} dot>
          {STATUS_LABEL[status]}
        </Badge>
      </div>
      {unsupported && (
        <Notice tone="warning">
          Speech recognition is not supported in this browser. Type your
          request below instead.
        </Notice>
      )}
      {failed && (
        <Notice tone="danger">
          The voice turn could not be processed. Try again.
        </Notice>
      )}
      {interim && (
        <p className="scp-desc">
          🎙️ <em>{interim}…</em>
        </p>
      )}
      <div className="scp-voice-input">
        <TextInput
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runTurn(inputText);
          }}
          placeholder="Or type a voice-desk request…"
          aria-label="Voice desk request"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void runTurn(inputText)}
          disabled={status === "thinking" || inputText.trim().length === 0}
        >
          Send
        </Button>
      </div>
      {exchanges.length > 0 && (
        <div className="scp-feed">
          {exchanges.map((exchange, i) => (
            <div className="scp-feed-row" key={i}>
              <Badge size="xs" tone={exchange.role === "user" ? "info" : "neutral"}>
                {exchange.role === "user" ? "You" : "Copilot"}
              </Badge>
              <span className="scp-feed-main">{exchange.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
