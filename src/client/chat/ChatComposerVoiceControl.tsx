/**
 * Issue #3773 — the chat composer's voice control: the voice
 * channel of the copilot conversation itself.
 *
 * The voice channel feeds the CHAT conversation: a transcript is
 * submitted through the same send path as a typed message (the
 * tab's sendChatText via onSubmitTranscript), so text and voice
 * are two input channels into ONE conversation. The assistant's
 * reply to a voice-submitted turn is spoken back, with a mute
 * toggle; typed turns are never spoken. (Where this control
 * serves the conversation, the Stock Copilot panel's old voice
 * section ran DESK turns; #3794 retired that section — voice
 * lives only in the chat box.)
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
 * Issue #3794 — placement: the CONTROLS (mic + mute) sit INLINE
 * inside the chat box row, alongside the text input and the Send
 * control, like a standard chat interface — never on a separate
 * bar. The state therefore lives in useChatComposerVoice, owned
 * by the tab: the tab renders ChatComposerVoiceFeedback (the
 * named-failure Notices and transient status — feedback, not
 * controls) beside the box, and ChatComposerVoiceButtons inside
 * the composer form. ChatComposerVoiceControl remains as the
 * composed form (feedback over a buttons row) for standalone use.
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
  inline: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-1-5)",
    flexShrink: 0,
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-1-5)",
    paddingTop: "var(--space-1)",
    paddingLeft: "var(--space-3)",
    paddingRight: "var(--space-3)",
  },
});

export interface ChatComposerVoiceControlProps {
  /** The send path is unavailable (e.g. the session is resetting). */
  disabled?: boolean;
  /** A chat turn is in flight — the mic waits, and no reply is spoken mid-turn. */
  isBusy: boolean;
  /** The shared conversation (useAgentChat messages), for reply playback. */
  messages: readonly any[];
  /** The ONE voice backend the server switch resolved for this registration (null until it resolves). */
  backend: VoiceBackend | null;
  /** Submit a captured transcript as a normal user chat turn. */
  onSubmitTranscript: (text: string) => void;
}

export interface ChatComposerVoice {
  status: VoiceStatus;
  interim: string | null;
  muted: boolean;
  unsupported: boolean;
  /** A named capture failure (its code), shown until the next capture. */
  failureCode: string | null;
  /** A named reply-playback failure (its code) — the turn WAS sent. */
  playbackFailureCode: string | null;
  /** The mic is unavailable (send path busy/resetting, or a capture is being transcribed). */
  micDisabled: boolean;
  toggleRecording: () => void;
  toggleMuted: () => void;
}

/**
 * The composer voice state machine (#3773), owned by the caller
 * since #3794 split the render: feedback renders beside the chat
 * box, the controls inside it, and both read this one state. The
 * hook is inert while no backend has resolved (backend null).
 */
export function useChatComposerVoice(
  props: ChatComposerVoiceControlProps,
): ChatComposerVoice {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [interim, setInterim] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [failureCode, setFailureCode] = useState<string | null>(null);
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
    const backend = backendRef.current;
    if (!backend) return;
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
    void backend
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
    const backend = props.backend;
    if (!backend) return;
    if (status === "listening") {
      captureRef.current?.stop();
      return;
    }
    if (status === "thinking") return;
    if (!backend.isSupported()) {
      setUnsupported(true);
      return;
    }
    setUnsupported(false);
    setFailureCode(null);
    setPlaybackFailureCode(null);
    const handle = backend.startCapture({
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

  const micDisabled =
    ((props.disabled || props.isBusy) && status !== "listening") ||
    status === "thinking";

  return {
    status,
    interim,
    muted,
    unsupported,
    failureCode,
    playbackFailureCode,
    micDisabled,
    toggleRecording,
    toggleMuted: () => setMuted((m) => !m),
  };
}

/**
 * The voice channel's FEEDBACK (#3794): the named-failure Notices
 * and the transient status (badge + interim transcript). Feedback
 * is not a control bar — it renders beside the chat box, and only
 * while there is something to report (an idle, healthy channel
 * renders nothing here; its controls sit in the box).
 */
export function ChatComposerVoiceFeedback(props: { voice: ChatComposerVoice }) {
  const styles = useStyles();
  const { voice } = props;
  const showStatus = voice.status !== "idle" || voice.interim !== null;
  if (!voice.unsupported && !voice.failureCode && !voice.playbackFailureCode && !showStatus) {
    return null;
  }
  return (
    <div>
      {voice.unsupported && (
        <Notice tone="warning">
          Speech recognition is not supported in this browser. Type your
          message below instead.
        </Notice>
      )}
      {voice.failureCode && (
        <Notice tone="danger">
          Voice failed ({voice.failureCode}). Nothing was sent — type your message
          below instead.
        </Notice>
      )}
      {voice.playbackFailureCode && (
        <Notice tone="danger">
          Reply playback failed ({voice.playbackFailureCode}).
        </Notice>
      )}
      {showStatus && (
        <div className={styles.statusRow}>
          <Badge
            size="small"
            appearance="tint"
            color={voice.status === "idle" ? "subtle" : "informative"}
          >
            {STATUS_LABEL[voice.status]}
          </Badge>
          {voice.interim && (
            <span>
              🎙️ <em>{voice.interim}…</em>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The voice channel's CONTROLS (#3794): the mic and the mute
 * toggle. These render INLINE inside the chat box row (the
 * composer form), alongside the text input and the Send control —
 * the only place voice controls appear.
 */
export function ChatComposerVoiceButtons(props: { voice: ChatComposerVoice }) {
  const styles = useStyles();
  const { voice } = props;
  return (
    <div className={styles.inline} data-testid="chat-composer-voice">
      <Button
        type="button"
        appearance={voice.status === "listening" ? "primary" : "subtle"}
        size="small"
        disabled={voice.micDisabled}
        onClick={voice.toggleRecording}
        title="Start or stop voice input"
      >
        {voice.status === "listening" ? "⏹ Stop listening" : "🎙 Speak"}
      </Button>
      <Button
        type="button"
        appearance="subtle"
        size="small"
        onClick={voice.toggleMuted}
        title="Toggle spoken replies"
      >
        {voice.muted ? "🔇 Audio muted" : "🔊 Audio on"}
      </Button>
    </div>
  );
}

/**
 * The composed control (#3773): feedback over a buttons row, for
 * standalone use. The chat tab does NOT use this form — since
 * #3794 it owns the hook and places the pieces itself (feedback
 * beside the box, buttons inside it).
 */
export function ChatComposerVoiceControl(props: ChatComposerVoiceControlProps) {
  const styles = useStyles();
  const voice = useChatComposerVoice(props);
  return (
    <div>
      <ChatComposerVoiceFeedback voice={voice} />
      <div className={styles.bar}>
        <ChatComposerVoiceButtons voice={voice} />
      </div>
    </div>
  );
}
