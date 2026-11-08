/**
 * The voice desk's client machinery — ONE implementation, shared
 * by every voice surface (issue #3738).
 *
 * The Trading Hub's voice tab (#3418) built this pattern inline:
 * browser speech recognition (STT) → POST /api/trading/voice/turn
 * → speech-synthesis playback (TTS) of the desk's spoken reply.
 * Issue #3738 extracts those helpers here so the Stock Copilot
 * panel's voice control runs its turns through the SAME client
 * machinery — carrying the stock registration's context
 * (sourceTab) so the #3720 route composition serves them — rather
 * than growing a second voice client stack. The hub consumes the
 * same helpers; its behavior is unchanged.
 */

import { apiFetch } from "./apiFetch";

/** The desk turn's response shape, as consumed by the voice surfaces. */
export interface VoiceDeskTurnResult {
  success?: boolean;
  spokenText?: string;
  displayMarkdown?: string;
  actionType?: string;
  orderId?: string;
  orderDraft?: unknown;
  brokerOrderRef?: string;
  marketQuote?: unknown;
  screenedStocks?: unknown[];
  [key: string]: unknown;
}

/**
 * Submit one voice turn to the desk. `sourceTab` stamps the
 * copilot context the turn belongs to (the #3720 carrier);
 * `environment` mirrors the hub's broker-environment header when
 * the surface has one.
 */
export async function submitVoiceTurn(
  transcript: string,
  opts?: { sourceTab?: string; environment?: string },
): Promise<VoiceDeskTurnResult> {
  const resp = await apiFetch("/api/trading/voice/turn", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts?.environment ? { "x-environment": opts.environment } : {}),
    },
    body: JSON.stringify({
      transcript,
      ...(opts?.sourceTab ? { sourceTab: opts.sourceTab } : {}),
    }),
  });
  return (await resp.json()) as VoiceDeskTurnResult;
}

/**
 * Speak a desk reply (the hub's TTS helper): cancels any current
 * utterance, then speaks at the desk's rate/pitch. Returns false
 * when speech synthesis is unavailable or the surface is muted.
 */
export function speakVoiceText(
  text: string,
  opts?: {
    muted?: boolean;
    onStart?: () => void;
    onEnd?: () => void;
  },
): boolean {
  if (
    typeof window === "undefined" ||
    !("speechSynthesis" in window) ||
    opts?.muted
  ) {
    return false;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.pitch = 1.0;
  utterance.onstart = () => opts?.onStart?.();
  utterance.onend = () => opts?.onEnd?.();
  utterance.onerror = () => opts?.onEnd?.();
  window.speechSynthesis.speak(utterance);
  return true;
}

export interface VoiceRecognitionHandlers {
  onStart?: () => void;
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: () => void;
  onEnd?: () => void;
}

/** True when the browser offers the Web Speech recognition API. */
export function isVoiceRecognitionSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(
      (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition,
    )
  );
}

/**
 * Start one recognition pass (the hub's STT helper): single
 * utterance, interim results streamed to onInterim, the final
 * transcript delivered to onFinal. Returns a stop handle, or null
 * when recognition is unsupported or fails to start.
 */
export function startVoiceRecognition(
  handlers: VoiceRecognitionHandlers,
): { stop: () => void } | null {
  if (typeof window === "undefined") return null;
  const SpeechRecognition =
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  try {
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => handlers.onStart?.();
    recognition.onresult = (event: any) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      if (interim) handlers.onInterim?.(interim);
      if (final) handlers.onFinal?.(final);
    };
    recognition.onerror = () => handlers.onError?.();
    recognition.onend = () => handlers.onEnd?.();

    recognition.start();
    return {
      stop: () => {
        try {
          recognition.stop();
        } catch {
          // Already stopped — the pass is over either way.
        }
      },
    };
  } catch {
    return null;
  }
}
