/**
 * Issue #3773 — the chat composer's voice control: the voice
 * channel of the copilot conversation itself.
 *
 * Rendered by the chat tab (AgentChatTabContent) directly above
 * the composer, only when the active copilot registration's voice
 * channel resolves effective (the server projection's
 * channels.voice.effective — switch AND #3720 class activation;
 * the tab owns that gate). Where the Stock Copilot panel's voice
 * control (#3738) runs DESK turns, this control feeds the CHAT
 * conversation: a transcript is submitted through the same send
 * path as a typed message (the tab's sendChatText via
 * onSubmitTranscript), so text and voice are two input channels
 * into ONE conversation. The assistant's reply to a
 * voice-submitted turn is spoken back, with a mute toggle; typed
 * turns are never spoken.
 *
 * HOW voice works is the provider seam's business
 * (src/client/voiceBackend.ts): the tab hands this control the
 * ONE adapter the server-resolved backend switch selected for
 * the active registration (webspeech — browser Web Speech; model
 * — server STT/TTS models), and this control consumes the seam
 * only. A backend failure surfaces its named code in a danger
 * Notice and submits nothing — never a silent fallback to the
 * other backend.
 *
 * Styling follows the host surface: the chat tab is the Fluent v9
 * surface (#3146), so the controls are the same Fluent primitives
 * as the composer they sit in, with Griffel styles in the #3230
 * pattern (no bespoke stylesheet); the notices are the ui/ Notice
 * — the same treatment as the desk control's.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  makeStyles,
} from "@fluentui/react-components";
import { Notice } from "../components/ui";
import type { VoiceBackend, VoiceCaptureHandle } from "../voiceBackend";
import { extractText } from "./types";

type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

const useStyles = makeStyles({
  bar: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-1-5)",
    paddingTop: "var(--space-1)",
    paddingBottom: "var(--space-1)",
    paddingLeft: "var(--space-3)",
    paddingRight: "var(--space-3)",
  },
});

export function ChatComposerVoiceControl(props: {
  /** The send path is unavailable (e.g. the session is resetting). */
  disabled?: boolean;
  /** A chat turn is in flight — the mic waits, and no reply is spoken mid-turn. */
  isBusy: boolean;
  /** The shared conversation (useAgentChat messages), for reply playback. */
  messages: readonly any[];
  /** The ONE voice backend the server switch resolved for this registration. */
  backend: VoiceBackend;
  /** Submit a captured transcript as a normal user chat turn. */
  onSubmitTranscript: (text: string) => void;
}) {
  const styles = useStyles();
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [interim, setInterim] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  /** A named capture failure (its code), shown until the next capture. */
  const [failureCode, setFailureCode] = useState<string | null>(null);
  /** A named reply-playback failure (its code) — the turn WAS sent. */
  const [playbackFailureCode, setPlaybackFailureCode] = useState<string | null>(null);
  const captureRef = useRef<VoiceCaptureHandle | null>(null);
  /** Armed by a voice submission: the next NEW assistant reply is spoken. */
  const armedRef = useRef(false);
  /** The last assistant message id at arm time — the reply must be newer. */
  const baselineReplyIdRef = useRef<string | null>(null);
  /** The assistant message id already spoken for (never spoken twice). */
  const spokenReplyIdRef = useRef<string | null>(null);
  const mutedRef = useRef(false);
  mutedRef.current = muted;
  const messagesRef = useRef(props.messages);
  messagesRef.current = props.messages;
  const backendRef = useRef(props.backend);
  backendRef.current = props.backend;

  // A backend switch (or unmount) abandons any live capture.
  useEffect(() => {
    return () => {
      captureRef.current?.stop();
      captureRef.current = null;
    };
  }, [props.backend]);

  // Reply playback: when a voice-submitted turn completes (no
  // longer busy) and a NEW assistant message is the latest reply,
  // speak it once through the SAME backend that captured the
  // turn. Typed turns never arm this, so they never trigger
  // playback. The mute toggle governs both backends.
  useEffect(() => {
    if (!armedRef.current || props.isBusy) return;
    const lastAssistant = [...props.messages]
      .reverse()
      .find((m) => m?.role === "assistant");
    if (!lastAssistant || typeof lastAssistant.id !== "string") return;
    if (
      lastAssistant.id === baselineReplyIdRef.current ||
      lastAssistant.id === spokenReplyIdRef.current
    ) {
      return;
    }
    const text = extractText(lastAssistant).trim();
    armedRef.current = false;
    if (!text) return;
    spokenReplyIdRef.current = lastAssistant.id;
    setStatus("speaking");
    void backendRef.current
      .speak(text, {
        muted: mutedRef.current,
        onEnd: () => setStatus("idle"),
        onError: (code) => {
          setPlaybackFailureCode(code);
          setStatus("idle");
        },
      })
      .then((spoke) => {
        if (!spoke) setStatus("idle");
      });
  }, [props.messages, props.isBusy]);

  const toggleRecording = () => {
    if (status === "listening") {
      captureRef.current?.stop();
      return;
    }
    if (status === "thinking") return;
    if (!props.backend.isSupported()) {
      setUnsupported(true);
      return;
    }
    setUnsupported(false);
    setFailureCode(null);
    setPlaybackFailureCode(null);
    const handle = props.backend.startCapture({
      onStart: () => setStatus("listening"),
      onInterim: (text) => setInterim(text),
      onProcessing: () => setStatus("thinking"),
      onFinal: (text) => {
        captureRef.current = null;
        setInterim(null);
        setStatus("idle");
        // Arm reply playback against the reply that exists NOW;
        // the spoken reply must be a newer assistant message.
        const lastAssistant = [...messagesRef.current]
          .reverse()
          .find((m) => m?.role === "assistant");
        baselineReplyIdRef.current =
          typeof lastAssistant?.id === "string" ? lastAssistant.id : null;
        armedRef.current = true;
        props.onSubmitTranscript(text);
      },
      onError: (code) => {
        captureRef.current = null;
        setInterim(null);
        setStatus("idle");
        // A NAMED failure (a voice endpoint's code) is a visible
        // state and submits nothing; a codeless browser
        // recognition error returns quietly to idle (the desk's
        // treatment).
        if (code) setFailureCode(code);
      },
      onEnd: () => {
        captureRef.current = null;
        setStatus((current) => (current === "listening" ? "idle" : current));
      },
    });
    if (!handle) {
      setUnsupported(true);
      setStatus("idle");
      return;
    }
    captureRef.current = handle;
  };

  return (
    <div data-testid="chat-composer-voice">
      {unsupported && (
        <Notice tone="warning">
          Speech recognition is not supported in this browser. Type your
          message below instead.
        </Notice>
      )}
      {failureCode && (
        <Notice tone="danger">
          Voice failed ({failureCode}). Nothing was sent — type your message
          below instead.
        </Notice>
      )}
      {playbackFailureCode && (
        <Notice tone="danger">
          Reply playback failed ({playbackFailureCode}).
        </Notice>
      )}
      <div className={styles.bar}>
        <Button
          type="button"
          appearance={status === "listening" ? "primary" : "subtle"}
          size="small"
          disabled={
            ((props.disabled || props.isBusy) && status !== "listening") ||
            status === "thinking"
          }
          onClick={toggleRecording}
          title="Start or stop voice input"
        >
          {status === "listening" ? "⏹ Stop listening" : "🎙 Speak"}
        </Button>
        <Button
          type="button"
          appearance="subtle"
          size="small"
          onClick={() => setMuted((m) => !m)}
          title="Toggle spoken replies"
        >
          {muted ? "🔇 Audio muted" : "🔊 Audio on"}
        </Button>
        <Badge
          size="small"
          appearance="tint"
          color={status === "idle" ? "subtle" : "informative"}
        >
          {STATUS_LABEL[status]}
        </Badge>
        {interim && (
          <span>
            🎙️ <em>{interim}…</em>
          </span>
        )}
      </div>
    </div>
  );
}
