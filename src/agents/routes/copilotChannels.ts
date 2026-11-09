/**
 * Issue #3773 — the chat surface's per-registration channel read:
 * GET /api/copilot-channels?registration=<id>.
 *
 * The copilot chat composer renders its voice affordance (the mic)
 * exactly when the ACTIVE registration's voice channel resolves
 * effective. That resolution is the platform's, not the client's:
 * the #3738 switch resolver (src/services/copilotChannels.ts —
 * stored > env > code-default) composed with the #3720 class-level
 * activation, projected through the shared routes-layer helper
 * (copilotChannelProjection.ts) — the same projection the Stock
 * Copilot status read serves (#3738), so the panel and the
 * composer can never disagree about whether voice serves. No
 * second resolver and no client-side precedence live here or in
 * the caller.
 *
 * The read is per-login (the stored layer is the login's own
 * setting), so it carries the copilot route family's fail-closed
 * discipline: without the instance's verified login context there
 * is nothing to resolve (401). An unknown registration is a 400 —
 * never a silent fall-back to another registration's switches.
 *
 * The same family serves the voice channel's MODEL backend
 * endpoints (the backend switch is src/services/
 * copilotVoiceBackend.ts — the channel gates presence, the switch
 * chooses how):
 *
 *   POST /api/copilot-channels/voice/stt?registration=<id>
 *     { audioBase64, contentType? } → { text }
 *     The recorded audio runs through the Workers AI STT model
 *     (resolveAiModelName task key "voiceStt") on env.AI.
 *   POST /api/copilot-channels/voice/tts?registration=<id>
 *     { text } → audio bytes (audio/mpeg)
 *     The reply text runs through the TTS model (task key
 *     "voiceTts").
 *
 * Both carry the family's discipline (401 without a verified
 * login, 400 for an unknown registration), then the channel gate
 * (voice not effective ⇒ 403 COPILOT_CHANNEL_DISABLED), then the
 * backend gate: the endpoints serve the MODEL backend only — a
 * registration resolving to webspeech, or a missing AI binding,
 * is refused by name (503 voice_backend_unavailable), never a
 * silent fallback. Model failures are named too (502
 * voice_stt_model_failed / voice_tts_model_failed).
 *
 * Issue #3796 — ONE voice implementation, keyed by SURFACE: the
 * same handler also serves the surface-parameterized routes,
 *
 *   GET  /api/voice/backend?surface=<id>
 *     → { surface, voiceBackend: { backend, source } }
 *   POST /api/voice/stt?surface=<id>   (same contract as above)
 *   POST /api/voice/tts?surface=<id>   (same contract as above)
 *
 * where a surface is a copilot registration or the trading desk
 * (`trading-desk`). The copilot paths above are the compatibility
 * form of the same routes (surface = the registration) and keep
 * working unchanged. Each surface passes through ITS OWN
 * availability gate before the shared backend gate: a copilot
 * surface keeps the channel gate (403 COPILOT_CHANNEL_DISABLED);
 * the desk surface composes with the desk's own gate — the #3429
 * broker gate the desk turn route enforces (a tenant whose
 * selected broker is not the desk's broker gets the 501
 * BROKER_CHANNEL_UNAVAILABLE refusal, before any model runs).
 * The desk's turn route and its gates are untouched: reuse here
 * is at the voice layer (capture/playback backends, models),
 * never the conversation layer.
 */

import {
  COPILOT_CHANNEL_DISABLED,
  isCopilotRegistrationId,
} from "../../services/copilotChannels";
import {
  isVoiceSurfaceId,
  resolveVoiceBackend,
  VOICE_BACKEND_UNAVAILABLE,
  VOICE_STT_MODEL_FAILED,
  VOICE_TTS_MODEL_FAILED,
  type VoiceSurfaceId,
} from "../../services/copilotVoiceBackend";
import { base64ToBytes } from "../../services/reportBlobStore";
import { resolveTenantBroker } from "../../services/tenantProviders";
import { resolveAiModelName } from "../model";
import {
  projectCopilotChannelStatuses,
  projectCopilotVoiceBackend,
  projectVoiceBackend,
} from "./copilotChannelProjection";
import { channelBrokerRefusal } from "./tradingIntegrations";
import type { Env } from "../../types";

/** Structural mirror of OrchestratorAgent's ScreenerExecutionContext
 *  (the routes idiom — routes do not import the orchestrator). */
type ScreenerExecutionContext = {
  userLogin: string;
  environment?: "TEST" | "PROD";
};

/** The subset of OrchestratorAgent surface this handler needs. */
export interface CopilotChannelsRouteContext {
  env: Env;
  /** The instance's acting identity (settings are per-login). */
  getScreenerExecutionContext: () => Promise<ScreenerExecutionContext | undefined>;
  /** The instance's settings reader (the resolver's stored layer). */
  readSettingRaw: (key: string) => string | null;
}

/**
 * The voice endpoints' availability gate for ONE surface
 * (#3796): each surface is gated by its own semantics, composed
 * here — never silently widened or narrowed.
 *
 * - A copilot surface keeps the #3738 channel gate: the voice
 *   channel must resolve effective (switch + class activation),
 *   else the family's 403 COPILOT_CHANNEL_DISABLED.
 * - The trading-desk surface composes with the desk's own #3429
 *   gate — the same broker gate the desk turn route enforces
 *   before it builds its service: a tenant whose selected broker
 *   is not the desk's broker gets the 501
 *   BROKER_CHANNEL_UNAVAILABLE refusal (the ONE refusal
 *   implementation, routes/tradingIntegrations.ts). The #3720
 *   copilot-context lift belongs to copilot-context turns on the
 *   turn route; a desk-surface voice call carries no copilot
 *   context, so no lift applies here.
 *
 * Returns the refusal Response, or null when the surface serves.
 */
async function voiceSurfaceGate(
  surfaceId: VoiceSurfaceId,
  ctx: CopilotChannelsRouteContext,
): Promise<Response | null> {
  if (isCopilotRegistrationId(surfaceId)) {
    const channels = projectCopilotChannelStatuses({
      registrationId: surfaceId,
      readSettingRaw: ctx.readSettingRaw,
      env: ctx.env,
    });
    if (!channels.voice.effective) {
      return Response.json(
        {
          error: COPILOT_CHANNEL_DISABLED,
          message: `The voice channel is not enabled for the ${surfaceId} copilot.`,
        },
        { status: 403 },
      );
    }
    return null;
  }
  const selectedBroker = await resolveTenantBroker(ctx.env);
  if (selectedBroker !== "etrade") {
    return channelBrokerRefusal(selectedBroker);
  }
  return null;
}

/**
 * Handles the copilot channel-projection read, the copilot voice
 * endpoints, and the #3796 surface-parameterized voice routes.
 * Returns a Response on match, null when the path does not match
 * (the orchestrator then continues its sequential matching).
 */
export async function handleCopilotChannelsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: CopilotChannelsRouteContext,
): Promise<Response | null> {
  const isChannelsRead =
    path.endsWith("/copilot-channels") && request.method === "GET";
  const isCopilotVoiceStt =
    path.endsWith("/copilot-channels/voice/stt") && request.method === "POST";
  const isCopilotVoiceTts =
    path.endsWith("/copilot-channels/voice/tts") && request.method === "POST";
  const isSurfaceBackendRead =
    path.endsWith("/voice/backend") && request.method === "GET";
  const isSurfaceVoiceStt =
    path.endsWith("/voice/stt") && request.method === "POST" && !isCopilotVoiceStt;
  const isSurfaceVoiceTts =
    path.endsWith("/voice/tts") && request.method === "POST" && !isCopilotVoiceTts;
  const isVoiceStt = isCopilotVoiceStt || isSurfaceVoiceStt;
  const isVoiceTts = isCopilotVoiceTts || isSurfaceVoiceTts;
  if (
    !isChannelsRead &&
    !isVoiceStt &&
    !isVoiceTts &&
    !isSurfaceBackendRead
  ) {
    return null;
  }

  // Fail closed: without the instance's verified login context
  // there is no "own instance" whose switches could resolve.
  const executionContext = await ctx
    .getScreenerExecutionContext()
    .catch(() => undefined);
  if (!executionContext?.userLogin) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  // Resolve WHICH surface this call serves: the copilot routes
  // name it by registration (the surface IS the registration);
  // the surface routes name it directly.
  let surfaceId: VoiceSurfaceId;
  if (isChannelsRead || isCopilotVoiceStt || isCopilotVoiceTts) {
    const registration = url.searchParams.get("registration");
    if (!isCopilotRegistrationId(registration)) {
      return Response.json(
        {
          error:
            "Unknown copilot registration (expected one of: general, options, stock)",
        },
        { status: 400 },
      );
    }
    surfaceId = registration;

    if (isChannelsRead) {
      return Response.json({
        registration,
        channels: projectCopilotChannelStatuses({
          registrationId: registration,
          readSettingRaw: ctx.readSettingRaw,
          env: ctx.env,
        }),
        voiceBackend: projectCopilotVoiceBackend({
          registrationId: registration,
          readSettingRaw: ctx.readSettingRaw,
          env: ctx.env,
        }),
      });
    }
  } else {
    const surface = url.searchParams.get("surface");
    if (!isVoiceSurfaceId(surface)) {
      return Response.json(
        {
          error:
            'Unknown voice surface (expected a copilot registration or "trading-desk")',
        },
        { status: 400 },
      );
    }
    surfaceId = surface;

    if (isSurfaceBackendRead) {
      return Response.json({
        surface,
        voiceBackend: projectVoiceBackend({
          surfaceId: surface,
          readSettingRaw: ctx.readSettingRaw,
          env: ctx.env,
        }),
      });
    }
  }

  // The voice endpoints serve the model backend only, and only
  // when the surface itself serves: the surface's availability
  // gate first (named refusal), then the backend gate (503,
  // named — never a silent fallback to webspeech).
  const gateRefusal = await voiceSurfaceGate(surfaceId, ctx);
  if (gateRefusal) return gateRefusal;
  const backend = resolveVoiceBackend({
    surfaceId,
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  if (backend.backend !== "model" || !ctx.env.AI) {
    return Response.json(
      {
        error: VOICE_BACKEND_UNAVAILABLE,
        message:
          backend.backend !== "model"
            ? isCopilotRegistrationId(surfaceId)
              ? `The ${surfaceId} copilot's voice backend is "${backend.backend}", not "model".`
              : `The ${surfaceId} voice surface's backend is "${backend.backend}", not "model".`
            : "The Workers AI binding is not available in this deployment.",
      },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  // The Workers AI binding's run surface, narrowed to the two
  // speech models' input/output shapes.
  const aiRun = (
    ctx.env.AI as unknown as {
      run: (
        model: string,
        inputs: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    }
  ).run.bind(ctx.env.AI);

  if (isVoiceStt) {
    const audioBase64 =
      typeof body?.audioBase64 === "string" ? body.audioBase64 : "";
    if (!audioBase64) {
      return Response.json(
        { error: "Field 'audioBase64' must be a non-empty base64 string." },
        { status: 400 },
      );
    }
    let audioBytes: Uint8Array;
    try {
      audioBytes = base64ToBytes(audioBase64);
    } catch {
      return Response.json(
        { error: "Field 'audioBase64' must be a non-empty base64 string." },
        { status: 400 },
      );
    }
    const model = resolveAiModelName(ctx.env, "voiceStt");
    try {
      const result = await aiRun(model, { audio: Array.from(audioBytes) });
      const text = typeof result?.text === "string" ? result.text.trim() : "";
      if (!text) throw new Error("the STT model returned no transcript");
      return Response.json({ text });
    } catch {
      return Response.json(
        {
          error: VOICE_STT_MODEL_FAILED,
          message: `Speech transcription failed on the configured STT model (${model}).`,
        },
        { status: 502 },
      );
    }
  }

  // isVoiceTts
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return Response.json(
      { error: "Field 'text' must be a non-empty string." },
      { status: 400 },
    );
  }
  const model = resolveAiModelName(ctx.env, "voiceTts");
  try {
    const result = await aiRun(model, { prompt: text });
    const audioBase64 =
      typeof result?.audio === "string" ? result.audio : "";
    if (!audioBase64) throw new Error("the TTS model returned no audio");
    return new Response(base64ToBytes(audioBase64) as unknown as BodyInit, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(
      {
        error: VOICE_TTS_MODEL_FAILED,
        message: `Speech synthesis failed on the configured TTS model (${model}).`,
      },
      { status: 502 },
    );
  }
}
