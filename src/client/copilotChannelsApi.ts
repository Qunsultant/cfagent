/**
 * Client for the per-registration channel projection read
 * (issue #3773): GET /api/copilot-channels?registration=<id>.
 *
 * The projection is the server's, never the client's: the route
 * resolves the requested registration's channel switches through
 * the #3738 resolver composed with the #3720 activation (the same
 * projection the Stock Copilot status read serves — the shape
 * below IS the status read's channels shape, re-exported). The
 * chat surface consumes exactly one decision from it: whether the
 * active registration's voice channel serves (voice.effective),
 * which gates the composer mic. No precedence is reimplemented
 * here.
 */

import { apiFetch } from "./apiFetch";
import type { StockCopilotChannelsStatus } from "./stockCopilotApi";

/** The channel projection, identical in shape to the stock status read's. */
export type CopilotChannelsStatus = StockCopilotChannelsStatus;

/** The voice backends (mirrors src/services/copilotVoiceBackend.ts). */
export type CopilotVoiceBackendId = "webspeech" | "model";

/**
 * The voice channel's backend projection: which speech machinery
 * serves the registration's voice turns, and which layer decided.
 * Rides beside the channels in both projection reads.
 */
export interface CopilotVoiceBackendStatus {
  backend: CopilotVoiceBackendId;
  source: "stored" | "env" | "default";
}

export interface CopilotChannelsProjection {
  registration: string;
  channels: CopilotChannelsStatus;
  voiceBackend: CopilotVoiceBackendStatus;
}

export async function fetchCopilotChannels(
  registration: string,
): Promise<CopilotChannelsProjection> {
  const resp = await apiFetch(
    `/api/copilot-channels?registration=${encodeURIComponent(registration)}`,
  );
  const data = (await resp
    .json()
    .catch(() => ({}))) as CopilotChannelsProjection & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

/**
 * The composer-mic gate, and the only decision the chat surface
 * takes from the projection: the voice channel serves when the
 * switch is on AND the class-level activation is enabled — the
 * server composes both into `effective`; anything missing or
 * malformed reads as off (the affordance fails absent, like the
 * panel's).
 */
export function copilotVoiceEffective(
  projection: CopilotChannelsProjection | null | undefined,
): boolean {
  return projection?.channels?.voice?.effective === true;
}

/**
 * A voice-endpoint failure carrying the server's NAMED error code
 * (voice_stt_model_failed / voice_tts_model_failed /
 * voice_backend_unavailable / COPILOT_CHANNEL_DISABLED — codes are
 * mirrored literals from src/services/copilotVoiceBackend.ts and
 * copilotChannels.ts). The voice seam surfaces the code; it never
 * falls back to the other backend.
 */
export class CopilotVoiceError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.name = "CopilotVoiceError";
    this.code = code;
  }
}

async function voiceErrorCode(resp: Response): Promise<string> {
  const data = (await resp.json().catch(() => ({}))) as { error?: unknown };
  return typeof data.error === "string" && data.error
    ? data.error
    : "voice_backend_unavailable";
}

/**
 * Model backend, speech-to-text: POST the recorded audio (base64,
 * the knowledge-corpus body convention) to the copilot voice STT
 * endpoint; resolves with the transcript. Throws CopilotVoiceError
 * with the server's named code on any failure.
 */
export async function transcribeCopilotVoice(
  registration: string,
  audioBase64: string,
  contentType?: string,
): Promise<string> {
  const resp = await apiFetch(
    `/api/copilot-channels/voice/stt?registration=${encodeURIComponent(registration)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioBase64,
        ...(contentType ? { contentType } : {}),
      }),
    },
  );
  if (!resp.ok) throw new CopilotVoiceError(await voiceErrorCode(resp));
  const data = (await resp.json().catch(() => ({}))) as { text?: unknown };
  if (typeof data.text !== "string" || !data.text.trim()) {
    throw new CopilotVoiceError("voice_stt_model_failed");
  }
  return data.text;
}

/**
 * Model backend, text-to-speech: POST the reply text to the
 * copilot voice TTS endpoint; resolves with the audio blob.
 * Throws CopilotVoiceError with the server's named code on any
 * failure.
 */
export async function synthesizeCopilotVoice(
  registration: string,
  text: string,
): Promise<Blob> {
  const resp = await apiFetch(
    `/api/copilot-channels/voice/tts?registration=${encodeURIComponent(registration)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  if (!resp.ok) throw new CopilotVoiceError(await voiceErrorCode(resp));
  return resp.blob();
}
