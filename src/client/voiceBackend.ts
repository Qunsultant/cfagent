/**
 * Issue #3773 — the chat voice channel's provider seam: ONE
 * abstraction, two adapters. The composer mic
 * (chat/ChatComposerVoiceControl.tsx) consumes this seam only; it
 * never branches on the backend id.
 *
 * Which adapter serves a registration is a server-resolved
 * configuration decision (src/services/copilotVoiceBackend.ts —
 * stored > env > code default "webspeech"), carried to the chat
 * surface in the channel projection (voiceBackend). The adapters:
 *
 *   webSpeechVoiceBackend — the browser's Web Speech API, through
 *     the shared voice client (voiceDeskClient.ts — the one voice
 *     stack): live interim transcripts, in-browser synthesis.
 *   modelVoiceBackend — real server models: the mic is captured
 *     with MediaRecorder and POSTed to the copilot voice STT
 *     endpoint (Workers AI transcription); reply playback POSTs
 *     the reply text to the TTS endpoint and plays the returned
 *     audio. No interim transcript exists on this path (the
 *     transcript arrives whole, on stop).
 *
 * Failure posture: an adapter failure surfaces its NAMED code
 * through onError (the endpoint's code, carried by
 * CopilotVoiceError) — never a silent fallback to the other
 * backend. (Browser recognition errors carry no code: the desk's
 * treatment, a quiet return to idle.)
 */

import {
  CopilotVoiceError,
  synthesizeCopilotVoice,
  transcribeCopilotVoice,
  type CopilotVoiceBackendId,
} from "./copilotChannelsApi";
import {
  isVoiceRecognitionSupported,
  speakVoiceText,
  startVoiceRecognition,
} from "./voiceDeskClient";

export type VoiceBackendId = CopilotVoiceBackendId;

export interface VoiceCaptureHandlers {
  /** Capture has actually started (recognition live / recorder running). */
  onStart?: () => void;
  /** Live interim transcript (webspeech only — the model path has none). */
  onInterim?: (text: string) => void;
  /** Capture stopped; the backend is producing the transcript (model path). */
  onProcessing?: () => void;
  /** The final transcript — submitted as a normal chat turn by the caller. */
  onFinal: (text: string) => void;
  /**
   * Capture failed. A named `code` (a voice endpoint's error code)
   * means the surface shows the named failure state; no code means
   * a quiet return to idle (browser recognition errors).
   */
  onError?: (code?: string) => void;
  /** Capture fully ended (after onFinal/onError). */
  onEnd?: () => void;
}

export interface VoiceCaptureHandle {
  stop: () => void;
}

export interface VoiceSpeakOptions {
  muted?: boolean;
  onEnd?: () => void;
  /** Playback failed with a named code (model path). */
  onError?: (code: string) => void;
}

export interface VoiceBackend {
  readonly id: VoiceBackendId;
  /** True when this browser can capture through this backend at all. */
  isSupported: () => boolean;
  /** Begin capture; null when capture cannot start (unsupported). */
  startCapture: (handlers: VoiceCaptureHandlers) => VoiceCaptureHandle | null;
  /**
   * Speak a reply. Resolves true when playback started; false when
   * muted or synthesis is unavailable. Muted never reaches the
   * model endpoint (no synthesis is requested).
   */
  speak: (text: string, opts?: VoiceSpeakOptions) => Promise<boolean>;
}

/* ------------------------------------------------------------------ */
/* webspeech — the browser Web Speech adapter                          */
/* ------------------------------------------------------------------ */

function createWebSpeechVoiceBackend(): VoiceBackend {
  return {
    id: "webspeech",
    isSupported: () => isVoiceRecognitionSupported(),
    startCapture: (handlers) =>
      startVoiceRecognition({
        onStart: handlers.onStart,
        onInterim: handlers.onInterim,
        onFinal: handlers.onFinal,
        // Browser recognition errors carry no named code (the
        // desk's treatment): the surface returns quietly to idle.
        onError: () => handlers.onError?.(),
        onEnd: handlers.onEnd,
      }),
    speak: (text, opts) =>
      Promise.resolve(
        speakVoiceText(text, { muted: opts?.muted, onEnd: opts?.onEnd }),
      ),
  };
}

/* ------------------------------------------------------------------ */
/* model — the server STT/TTS adapter                                  */
/* ------------------------------------------------------------------ */

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      resolve(dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : "");
    };
    reader.onerror = () => reject(new Error("audio read failed"));
    reader.readAsDataURL(blob);
  });
}

function namedCode(err: unknown): string {
  return err instanceof CopilotVoiceError ? err.code : "voice_backend_unavailable";
}

function createModelVoiceBackend(registration: string): VoiceBackend {
  return {
    id: "model",
    isSupported: () =>
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof MediaRecorder !== "undefined",
    startCapture: (handlers) => {
      let stream: MediaStream | null = null;
      let recorder: MediaRecorder | null = null;
      let chunks: Blob[] = [];
      let cancelled = false;

      const releaseStream = () => {
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
      };

      const finalize = async () => {
        releaseStream();
        const blob = new Blob(chunks, {
          type: recorder?.mimeType || "audio/webm",
        });
        chunks = [];
        handlers.onProcessing?.();
        try {
          const audioBase64 = await blobToBase64(blob);
          const text = await transcribeCopilotVoice(
            registration,
            audioBase64,
            blob.type,
          );
          handlers.onFinal(text);
        } catch (err) {
          handlers.onError?.(namedCode(err));
        }
        handlers.onEnd?.();
      };

      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((mediaStream) => {
          if (cancelled) {
            mediaStream.getTracks().forEach((track) => track.stop());
            return;
          }
          stream = mediaStream;
          recorder = new MediaRecorder(mediaStream);
          recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) chunks.push(event.data);
          };
          recorder.onstop = () => {
            void finalize();
          };
          recorder.start();
          handlers.onStart?.();
        })
        .catch(() => {
          // Mic permission / device failure: the model backend
          // cannot capture — named, never a webspeech fallback.
          handlers.onError?.("voice_backend_unavailable");
          handlers.onEnd?.();
        });

      return {
        stop: () => {
          if (recorder && recorder.state !== "inactive") {
            recorder.stop();
          } else if (!stream) {
            // getUserMedia still pending: abandon the capture.
            cancelled = true;
            handlers.onEnd?.();
          }
        },
      };
    },
    speak: async (text, opts) => {
      if (opts?.muted) return false;
      let audioBlob: Blob;
      try {
        audioBlob = await synthesizeCopilotVoice(registration, text);
      } catch (err) {
        opts?.onError?.(namedCode(err));
        return false;
      }
      const objectUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(objectUrl);
      const cleanup = () => URL.revokeObjectURL(objectUrl);
      audio.addEventListener("ended", () => {
        cleanup();
        opts?.onEnd?.();
      });
      audio.addEventListener("error", () => {
        cleanup();
        opts?.onEnd?.();
      });
      try {
        await audio.play();
        return true;
      } catch {
        cleanup();
        return false;
      }
    },
  };
}

/**
 * Build the adapter the projection resolved for one registration.
 * The seam's only construction point: surfaces ask for the
 * resolved id and consume the VoiceBackend interface.
 */
export function createVoiceBackend(
  id: VoiceBackendId,
  deps: { registration: string },
): VoiceBackend {
  return id === "model"
    ? createModelVoiceBackend(deps.registration)
    : createWebSpeechVoiceBackend();
}
