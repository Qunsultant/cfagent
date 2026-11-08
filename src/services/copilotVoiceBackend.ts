/**
 * Issue #3773 — the copilot voice channel's BACKEND switch:
 * which speech machinery serves a registration's voice turns.
 *
 * Two backends exist behind one seam (the client consumes
 * src/client/voiceBackend.ts; it never branches on the id):
 *
 *   webspeech — the browser's Web Speech API (recognition +
 *               synthesis in the client). The original channel.
 *   model     — real server-side models: recorded audio goes to
 *               the copilot voice endpoints, which run a Workers
 *               AI speech-to-text model (resolveAiModelName task
 *               key "voiceStt"); reply playback synthesizes with
 *               the text-to-speech model (task key "voiceTts").
 *
 * The switch is a configuration decision BESIDE the #3738 channel
 * switch, and it layers exactly like it (stored > env > code
 * default, the deciding layer named in the result):
 *
 *   stored  — the login's own stored setting (mas_settings key
 *             `copilot_voice_backend:<registration>`, the raw
 *             value `webspeech` or `model`), written through the
 *             copilot settings doors. The user's own decision wins.
 *   env     — the deployment default in wrangler vars
 *             (COPILOT_VOICE_BACKEND, entries
 *             `<registration>=webspeech|model`, the COPILOT_CHANNELS
 *             format).
 *   default — the code default below: webspeech for every
 *             registration (the channel as originally built).
 *
 * Composition with the channel switch: the CHANNEL gates whether
 * voice serves at all (channels.voice.effective); this switch
 * only chooses HOW, and is consulted only when the channel
 * serves. A model-backend request that reaches the voice
 * endpoints for a registration whose backend resolves to
 * webspeech is refused by name (VOICE_BACKEND_UNAVAILABLE) —
 * never a silent fallback to the other backend.
 *
 * Malformed entries never decide anything: they are collected
 * into `issues` and surfaced in the resolution (the channels
 * resolver's fail-visible posture), never silently applied.
 */

import {
  isCopilotRegistrationId,
  type CopilotChannelSwitchSource,
  type CopilotRegistrationId,
} from "./copilotChannels";
import type { Env } from "../types";

/** The voice backends. The client seam's ids mirror these literals. */
export const COPILOT_VOICE_BACKENDS = ["webspeech", "model"] as const;
export type CopilotVoiceBackendId = (typeof COPILOT_VOICE_BACKENDS)[number];

export function isCopilotVoiceBackendId(
  value: unknown,
): value is CopilotVoiceBackendId {
  return (
    typeof value === "string" &&
    (COPILOT_VOICE_BACKENDS as readonly string[]).includes(value)
  );
}

/** The deployment-layer var (wrangler vars): entries `<registration>=webspeech|model`. */
export const COPILOT_VOICE_BACKEND_ENV = "COPILOT_VOICE_BACKEND";

/** The named failure codes of the copilot voice endpoints. */
export const VOICE_STT_MODEL_FAILED = "voice_stt_model_failed";
export const VOICE_TTS_MODEL_FAILED = "voice_tts_model_failed";
export const VOICE_BACKEND_UNAVAILABLE = "voice_backend_unavailable";

/** The per-login stored-settings key for one registration's backend decision. */
export function copilotVoiceBackendSettingKey(
  registrationId: CopilotRegistrationId,
): string {
  return `copilot_voice_backend:${registrationId}`;
}

/**
 * THE code-default layer: webspeech for every registration — the
 * channel as originally built (browser Web Speech). A future
 * defaults change is a table edit here, never a new fallback at
 * a call site.
 */
export const COPILOT_VOICE_BACKEND_DEFAULTS: Record<
  CopilotRegistrationId,
  CopilotVoiceBackendId
> = {
  general: "webspeech",
  options: "webspeech",
  stock: "webspeech",
};

export interface CopilotVoiceBackendResolution {
  registrationId: CopilotRegistrationId;
  /** The backend that serves this registration's voice turns. */
  backend: CopilotVoiceBackendId;
  /** Which layer decided: the login's stored setting, the deployment env, or the code default. */
  source: CopilotChannelSwitchSource;
  /** Malformed entries encountered while resolving — surfaced, never applied. */
  issues: string[];
}

/**
 * Parse the STORED form — the raw scalar under one registration's
 * settings key (`webspeech` or `model`). Anything else decides
 * nothing and is reported as an issue.
 */
export function parseStoredCopilotVoiceBackend(raw: string | null | undefined): {
  decision: CopilotVoiceBackendId | undefined;
  issues: string[];
} {
  if (typeof raw !== "string" || !raw.trim()) return { decision: undefined, issues: [] };
  const normalized = raw.trim().toLowerCase();
  if (isCopilotVoiceBackendId(normalized)) return { decision: normalized, issues: [] };
  return {
    decision: undefined,
    issues: [
      `copilot voice backend setting: malformed value "${raw.trim()}" (expected "webspeech" or "model")`,
    ],
  };
}

/**
 * Parse the ENV form — entries `<registration>=webspeech|model`
 * in the single COPILOT_VOICE_BACKEND var (the COPILOT_CHANNELS
 * format). Malformed entries decide nothing and are reported as
 * issues.
 */
export function parseEnvCopilotVoiceBackendEntries(
  raw: string | null | undefined,
): { decisions: Map<CopilotRegistrationId, CopilotVoiceBackendId>; issues: string[] } {
  const decisions = new Map<CopilotRegistrationId, CopilotVoiceBackendId>();
  const issues: string[] = [];
  if (typeof raw !== "string") return { decisions, issues };
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const registration = eq > 0 ? trimmed.slice(0, eq).trim().toLowerCase() : "";
    const backend = eq > 0 ? trimmed.slice(eq + 1).trim().toLowerCase() : "";
    if (!isCopilotRegistrationId(registration) || !isCopilotVoiceBackendId(backend)) {
      issues.push(
        `${COPILOT_VOICE_BACKEND_ENV}: malformed entry "${trimmed}" (expected "<registration>=webspeech|model")`,
      );
      continue;
    }
    decisions.set(registration, backend);
  }
  return { decisions, issues };
}

/**
 * Resolve one registration's voice backend: the login's stored
 * decision wins, then the deployment env, then the code default.
 * Never throws; malformed config is reported in `issues`.
 */
export function resolveCopilotVoiceBackend(deps: {
  registrationId: CopilotRegistrationId;
  /** The hosting instance's settings reader (absent ⇒ no stored layer). */
  readSettingRaw?: (key: string) => string | null;
  /** The deployment env (absent ⇒ no env layer). */
  env?: Env | Record<string, unknown> | null;
}): CopilotVoiceBackendResolution {
  const { registrationId } = deps;
  const issues: string[] = [];

  if (deps.readSettingRaw) {
    const stored = parseStoredCopilotVoiceBackend(
      deps.readSettingRaw(copilotVoiceBackendSettingKey(registrationId)),
    );
    issues.push(...stored.issues);
    if (stored.decision !== undefined) {
      return { registrationId, backend: stored.decision, source: "stored", issues };
    }
  }

  const envRaw = deps.env
    ? (deps.env as Record<string, unknown>)[COPILOT_VOICE_BACKEND_ENV]
    : undefined;
  const envParsed = parseEnvCopilotVoiceBackendEntries(
    typeof envRaw === "string" ? envRaw : undefined,
  );
  issues.push(...envParsed.issues);
  const envDecision = envParsed.decisions.get(registrationId);
  if (envDecision !== undefined) {
    return { registrationId, backend: envDecision, source: "env", issues };
  }

  return {
    registrationId,
    backend: COPILOT_VOICE_BACKEND_DEFAULTS[registrationId],
    source: "default",
    issues,
  };
}
