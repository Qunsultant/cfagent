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
 *
 * Issue #3796 — the switch is keyed by SURFACE, not only by
 * copilot registration: there is ONE voice implementation, and
 * the trading desk is a first-class surface of it beside the
 * three registrations. A surface contributes only its id; the
 * layering, the stored-key namespace, the env var, and the code
 * default (webspeech on every surface) are shared. Copilot
 * registrations keep their existing keys and behavior exactly —
 * a stored `copilot_voice_backend:<registration>` value wins
 * exactly as it did before the generalization — and each surface
 * resolves independently: one surface's decision never moves
 * another's.
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

/**
 * The voice SURFACES (#3796): the copilot registrations plus the
 * trading desk. A surface is the unit the backend switch, the
 * STT/TTS endpoints, and the client seam are keyed by; surfaces
 * consume the ONE voice implementation and contribute only their
 * id and their turn-submission semantics.
 */
export const TRADING_DESK_VOICE_SURFACE_ID = "trading-desk";
export type VoiceSurfaceId =
  | CopilotRegistrationId
  | typeof TRADING_DESK_VOICE_SURFACE_ID;

export function isVoiceSurfaceId(value: unknown): value is VoiceSurfaceId {
  return (
    isCopilotRegistrationId(value) || value === TRADING_DESK_VOICE_SURFACE_ID
  );
}

/** The per-login stored-settings key for one surface's backend decision. */
export function voiceBackendSettingKey(surfaceId: VoiceSurfaceId): string {
  return `copilot_voice_backend:${surfaceId}`;
}

/** The per-login stored-settings key for one registration's backend decision. */
export function copilotVoiceBackendSettingKey(
  registrationId: CopilotRegistrationId,
): string {
  return voiceBackendSettingKey(registrationId);
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

/**
 * THE code-default layer for every SURFACE (#3796): webspeech
 * everywhere — the desk's voice as originally built included.
 * The registration rows are the #3773 table above; the desk row
 * joins it here so one table serves the generalized resolver.
 */
export const VOICE_BACKEND_DEFAULTS: Record<
  VoiceSurfaceId,
  CopilotVoiceBackendId
> = {
  ...COPILOT_VOICE_BACKEND_DEFAULTS,
  [TRADING_DESK_VOICE_SURFACE_ID]: "webspeech",
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
 * Parse the ENV form — entries `<surface>=webspeech|model`
 * in the single COPILOT_VOICE_BACKEND var (the COPILOT_CHANNELS
 * format; #3796: the surface key is a copilot registration or
 * the trading-desk surface). Malformed entries decide nothing
 * and are reported as issues.
 */
export function parseEnvCopilotVoiceBackendEntries(
  raw: string | null | undefined,
): { decisions: Map<VoiceSurfaceId, CopilotVoiceBackendId>; issues: string[] } {
  const decisions = new Map<VoiceSurfaceId, CopilotVoiceBackendId>();
  const issues: string[] = [];
  if (typeof raw !== "string") return { decisions, issues };
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const surface = eq > 0 ? trimmed.slice(0, eq).trim().toLowerCase() : "";
    const backend = eq > 0 ? trimmed.slice(eq + 1).trim().toLowerCase() : "";
    if (!isVoiceSurfaceId(surface) || !isCopilotVoiceBackendId(backend)) {
      issues.push(
        `${COPILOT_VOICE_BACKEND_ENV}: malformed entry "${trimmed}" (expected "<surface>=webspeech|model")`,
      );
      continue;
    }
    decisions.set(surface, backend);
  }
  return { decisions, issues };
}

/** The surface-keyed resolution (#3796): the resolver's result for ANY voice surface. */
export interface VoiceBackendResolution {
  surfaceId: VoiceSurfaceId;
  /** The backend that serves this surface's voice turns. */
  backend: CopilotVoiceBackendId;
  /** Which layer decided: the login's stored setting, the deployment env, or the code default. */
  source: CopilotChannelSwitchSource;
  /** Malformed entries encountered while resolving — surfaced, never applied. */
  issues: string[];
}

/**
 * Resolve one SURFACE's voice backend (#3796): the login's stored
 * decision wins, then the deployment env, then the code default.
 * Never throws; malformed config is reported in `issues`. Every
 * surface — copilot registration or trading desk — resolves
 * through this one function, each from its own stored key and
 * its own env entries.
 */
export function resolveVoiceBackend(deps: {
  surfaceId: VoiceSurfaceId;
  /** The hosting instance's settings reader (absent ⇒ no stored layer). */
  readSettingRaw?: (key: string) => string | null;
  /** The deployment env (absent ⇒ no env layer). */
  env?: Env | Record<string, unknown> | null;
}): VoiceBackendResolution {
  const { surfaceId } = deps;
  const issues: string[] = [];

  if (deps.readSettingRaw) {
    const stored = parseStoredCopilotVoiceBackend(
      deps.readSettingRaw(voiceBackendSettingKey(surfaceId)),
    );
    issues.push(...stored.issues);
    if (stored.decision !== undefined) {
      return { surfaceId, backend: stored.decision, source: "stored", issues };
    }
  }

  const envRaw = deps.env
    ? (deps.env as Record<string, unknown>)[COPILOT_VOICE_BACKEND_ENV]
    : undefined;
  const envParsed = parseEnvCopilotVoiceBackendEntries(
    typeof envRaw === "string" ? envRaw : undefined,
  );
  issues.push(...envParsed.issues);
  const envDecision = envParsed.decisions.get(surfaceId);
  if (envDecision !== undefined) {
    return { surfaceId, backend: envDecision, source: "env", issues };
  }

  return {
    surfaceId,
    backend: VOICE_BACKEND_DEFAULTS[surfaceId],
    source: "default",
    issues,
  };
}

/**
 * Resolve one registration's voice backend: the login's stored
 * decision wins, then the deployment env, then the code default.
 * Never throws; malformed config is reported in `issues`.
 * (#3796: the registration-shaped view of resolveVoiceBackend —
 * the same resolution, keyed by the registration surface.)
 */
export function resolveCopilotVoiceBackend(deps: {
  registrationId: CopilotRegistrationId;
  /** The hosting instance's settings reader (absent ⇒ no stored layer). */
  readSettingRaw?: (key: string) => string | null;
  /** The deployment env (absent ⇒ no env layer). */
  env?: Env | Record<string, unknown> | null;
}): CopilotVoiceBackendResolution {
  const resolved = resolveVoiceBackend({
    surfaceId: deps.registrationId,
    readSettingRaw: deps.readSettingRaw,
    env: deps.env,
  });
  return {
    registrationId: deps.registrationId,
    backend: resolved.backend,
    source: resolved.source,
    issues: resolved.issues,
  };
}
