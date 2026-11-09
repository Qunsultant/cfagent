/** @vitest-environment jsdom */

/**
 * Issue #3796 — ONE reusable voice implementation: the backend
 * switch, the STT/TTS endpoints, and the client seam are keyed by
 * SURFACE, and every surface consumes the same implementation.
 *
 * What this suite pins:
 *
 *  1. Surface-parameterized resolution (src/services/
 *     copilotVoiceBackend.ts generalized): surfaces are the
 *     copilot registrations (general / options / stock — stored
 *     keys and behavior byte-identical to #3773) plus the trading
 *     desk as a first-class surface key in the same namespace
 *     (`copilot_voice_backend:trading-desk`), resolved stored >
 *     env > code default (webspeech everywhere) with the deciding
 *     layer named. Surfaces resolve INDEPENDENTLY: one surface's
 *     stored/env decision never moves another's.
 *  2. Surface-parameterized endpoints: POST /api/voice/stt and
 *     /api/voice/tts?surface=<id> serve the model backend for any
 *     surface, behind THAT surface's availability gate — copilot
 *     surfaces keep the #3738 channel gate (403
 *     COPILOT_CHANNEL_DISABLED); the desk surface composes with
 *     the desk's own #3429 gate (a non-desk-broker tenant gets
 *     the 501 BROKER_CHANNEL_UNAVAILABLE refusal, before any
 *     model runs). The landed copilot paths
 *     (/api/copilot-channels/voice/*) keep working unchanged.
 *     GET /api/voice/backend?surface=<id> projects any surface's
 *     resolved backend + source. The family discipline holds:
 *     401 without a verified login, 400 for an unknown surface,
 *     503 voice_backend_unavailable when the surface does not
 *     resolve to the model backend (never a silent fallback),
 *     502 named model failures.
 *  3. The client seam (src/client/voiceBackend.ts): ONE adapter
 *     pair serves every surface — createVoiceBackend for copilot
 *     registrations (unchanged, #3773) and
 *     createSurfaceVoiceBackend for a named surface; the desk
 *     adapter posts to the surface endpoints, the webspeech
 *     adapter delegates to the shared recognition/TTS helpers.
 *  4. The Trading Desk voice tab renders on the seam: its mic
 *     control is present for a desk-broker tenant (the tab's own
 *     #3429 notice behavior is the 3429 suite's pin, unchanged).
 *
 * Harnesses: the #3773 suite's route-context idiom and media
 * mocks; the #3429 suite's tenantProviders mock for the desk
 * gate; the #3429 notice suite's SSR hub render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* The desk gate's broker (the #3429 suite's mock idiom). */
const brokerState = vi.hoisted(() => ({ broker: "etrade" }));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/tenantProviders")>();
  return {
    ...actual,
    resolveTenantBroker: async () => brokerState.broker,
  };
});

import {
  handleCopilotChannelsRoutes,
  type CopilotChannelsRouteContext,
} from "../src/agents/routes/copilotChannels";
import {
  COPILOT_VOICE_BACKEND_ENV,
  TRADING_DESK_VOICE_SURFACE_ID,
  copilotVoiceBackendSettingKey,
  isVoiceSurfaceId,
  resolveCopilotVoiceBackend,
  resolveVoiceBackend,
  voiceBackendSettingKey,
} from "../src/services/copilotVoiceBackend";
import { COPILOT_CHANNELS_ENV } from "../src/services/copilotChannels";
import { CHANNEL_BROKER_UNAVAILABLE } from "../src/agents/routes/tradingIntegrations";

/* ------------------------------------------------------------------ */
/* 1. Surface-parameterized resolution                                 */
/* ------------------------------------------------------------------ */

describe("issue #3796 — the voice backend switch resolves per SURFACE", () => {
  const readFrom = (settings: Map<string, string>) => (key: string) =>
    settings.get(key) ?? null;

  it("the desk is a first-class surface key in the same stored namespace", () => {
    expect(TRADING_DESK_VOICE_SURFACE_ID).toBe("trading-desk");
    expect(voiceBackendSettingKey(TRADING_DESK_VOICE_SURFACE_ID)).toBe(
      "copilot_voice_backend:trading-desk",
    );
    // Copilot keys are byte-identical to the #3773 keys.
    for (const registrationId of ["general", "options", "stock"] as const) {
      expect(voiceBackendSettingKey(registrationId)).toBe(
        copilotVoiceBackendSettingKey(registrationId),
      );
    }
    expect(isVoiceSurfaceId("trading-desk")).toBe(true);
    expect(isVoiceSurfaceId("stock")).toBe(true);
    expect(isVoiceSurfaceId("banana")).toBe(false);
    expect(isVoiceSurfaceId(undefined)).toBe(false);
  });

  it("code default is webspeech for the desk surface (source named)", () => {
    const resolved = resolveVoiceBackend({
      surfaceId: TRADING_DESK_VOICE_SURFACE_ID,
    });
    expect(resolved).toMatchObject({
      surfaceId: "trading-desk",
      backend: "webspeech",
      source: "default",
      issues: [],
    });
  });

  it("the env layer decides for the desk surface (same var, surface entries)", () => {
    const env = { [COPILOT_VOICE_BACKEND_ENV]: "trading-desk=model" };
    expect(
      resolveVoiceBackend({ surfaceId: TRADING_DESK_VOICE_SURFACE_ID, env }),
    ).toMatchObject({ backend: "model", source: "env" });
  });

  it("the desk's stored layer wins over the env layer", () => {
    const settings = new Map([
      [voiceBackendSettingKey(TRADING_DESK_VOICE_SURFACE_ID), "webspeech"],
    ]);
    const resolved = resolveVoiceBackend({
      surfaceId: TRADING_DESK_VOICE_SURFACE_ID,
      readSettingRaw: readFrom(settings),
      env: { [COPILOT_VOICE_BACKEND_ENV]: "trading-desk=model" },
    });
    expect(resolved).toMatchObject({ backend: "webspeech", source: "stored" });
  });

  it("surfaces resolve independently — one surface's decision never moves another's", () => {
    const settings = new Map([
      [voiceBackendSettingKey(TRADING_DESK_VOICE_SURFACE_ID), "model"],
    ]);
    const readSettingRaw = readFrom(settings);
    expect(
      resolveVoiceBackend({
        surfaceId: TRADING_DESK_VOICE_SURFACE_ID,
        readSettingRaw,
      }),
    ).toMatchObject({ backend: "model", source: "stored" });
    expect(
      resolveVoiceBackend({ surfaceId: "stock", readSettingRaw }),
    ).toMatchObject({ backend: "webspeech", source: "default" });

    const env = { [COPILOT_VOICE_BACKEND_ENV]: "stock=model" };
    expect(resolveVoiceBackend({ surfaceId: "stock", env })).toMatchObject({
      backend: "model",
      source: "env",
    });
    expect(
      resolveVoiceBackend({ surfaceId: TRADING_DESK_VOICE_SURFACE_ID, env }),
    ).toMatchObject({ backend: "webspeech", source: "default" });
  });

  it("malformed desk entries decide nothing and surface as issues", () => {
    const fromEnv = resolveVoiceBackend({
      surfaceId: TRADING_DESK_VOICE_SURFACE_ID,
      env: { [COPILOT_VOICE_BACKEND_ENV]: "trading-desk=banana" },
    });
    expect(fromEnv.backend).toBe("webspeech");
    expect(fromEnv.source).toBe("default");
    expect(fromEnv.issues).toHaveLength(1);

    const settings = new Map([
      [voiceBackendSettingKey(TRADING_DESK_VOICE_SURFACE_ID), "banana"],
    ]);
    const fromStored = resolveVoiceBackend({
      surfaceId: TRADING_DESK_VOICE_SURFACE_ID,
      readSettingRaw: readFrom(settings),
    });
    expect(fromStored.backend).toBe("webspeech");
    expect(fromStored.source).toBe("default");
    expect(fromStored.issues).toHaveLength(1);
  });

  it("the copilot resolver keeps its #3773 shape and answers (delegation, no drift)", () => {
    const settings = new Map([[copilotVoiceBackendSettingKey("stock"), "model"]]);
    const resolved = resolveCopilotVoiceBackend({
      registrationId: "stock",
      readSettingRaw: readFrom(settings),
    });
    expect(resolved).toMatchObject({
      registrationId: "stock",
      backend: "model",
      source: "stored",
    });
  });
});

/* ------------------------------------------------------------------ */
/* 2. Surface-parameterized endpoints                                  */
/* ------------------------------------------------------------------ */

function makeCtx(options: {
  settings?: Map<string, string>;
  env?: Record<string, unknown>;
  login?: string | null;
} = {}): CopilotChannelsRouteContext {
  const settings = options.settings ?? new Map<string, string>();
  return {
    env: { ...(options.env ?? {}) } as CopilotChannelsRouteContext["env"],
    getScreenerExecutionContext: async () =>
      options.login === null
        ? undefined
        : { userLogin: options.login ?? "owner", environment: "TEST" as const },
    readSettingRaw: (key: string) => settings.get(key) ?? null,
  };
}

function callSurface(
  ctx: CopilotChannelsRouteContext,
  path: string,
  init: { method: string; body?: unknown },
) {
  const url = new URL(`https://agent.internal${path}`);
  return handleCopilotChannelsRoutes(
    new Request(url, {
      method: init.method,
      headers: { "Content-Type": "application/json" },
      ...(init.body !== undefined
        ? { body: JSON.stringify(init.body) }
        : {}),
    }),
    url,
    path.split("?")[0],
    "session-1",
    ctx,
  );
}

const AUDIO_B64 = Buffer.from("fake-audio-bytes").toString("base64");
const MP3_BYTES = Buffer.from("fake-mp3-bytes");

describe("issue #3796 — GET /api/voice/backend projects any surface's backend", () => {
  beforeEach(() => {
    brokerState.broker = "etrade";
  });

  it("the desk surface projects its code default (webspeech, source named)", async () => {
    const res = await callSurface(
      makeCtx(),
      "/api/voice/backend?surface=trading-desk",
      { method: "GET" },
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({
      surface: "trading-desk",
      voiceBackend: { backend: "webspeech", source: "default" },
    });
  });

  it("the desk surface projects its stored decision", async () => {
    const settings = new Map([
      [voiceBackendSettingKey(TRADING_DESK_VOICE_SURFACE_ID), "model"],
    ]);
    const res = await callSurface(
      makeCtx({ settings }),
      "/api/voice/backend?surface=trading-desk",
      { method: "GET" },
    );
    expect(res?.status).toBe(200);
    expect(((await res!.json()) as any).voiceBackend).toEqual({
      backend: "model",
      source: "stored",
    });
  });

  it("a copilot surface reads through the same projection route", async () => {
    const env = { [COPILOT_VOICE_BACKEND_ENV]: "stock=model" };
    const res = await callSurface(makeCtx({ env }), "/api/voice/backend?surface=stock", {
      method: "GET",
    });
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({
      surface: "stock",
      voiceBackend: { backend: "model", source: "env" },
    });
  });

  it("an unknown or missing surface is a 400; no login is a 401", async () => {
    expect(
      (await callSurface(makeCtx(), "/api/voice/backend?surface=banana", { method: "GET" }))
        ?.status,
    ).toBe(400);
    expect(
      (await callSurface(makeCtx(), "/api/voice/backend", { method: "GET" }))?.status,
    ).toBe(400);
    expect(
      (
        await callSurface(makeCtx({ login: null }), "/api/voice/backend?surface=trading-desk", {
          method: "GET",
        })
      )?.status,
    ).toBe(401);
  });
});

describe("issue #3796 — the surface STT/TTS endpoints compose with each surface's own gate", () => {
  beforeEach(() => {
    brokerState.broker = "etrade";
  });

  function deskModelCtx(aiRun?: unknown) {
    return makeCtx({
      settings: new Map([
        [voiceBackendSettingKey(TRADING_DESK_VOICE_SURFACE_ID), "model"],
      ]),
      env: { ...(aiRun !== undefined ? { AI: { run: aiRun } } : {}) },
    });
  }

  it("desk STT runs the voiceStt model for a desk-broker tenant and returns the transcript", async () => {
    const aiRun = vi.fn(async () => ({ text: "  what is my balance  " }));
    const res = await callSurface(deskModelCtx(aiRun), "/api/voice/stt?surface=trading-desk", {
      method: "POST",
      body: { audioBase64: AUDIO_B64 },
    });
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ text: "what is my balance" });
    const [model] = aiRun.mock.calls[0] as unknown as [string];
    expect(model).toBe("@cf/openai/whisper-large-v3-turbo");
  });

  it("desk TTS returns audio bytes for a desk-broker tenant", async () => {
    const aiRun = vi.fn(async () => ({ audio: MP3_BYTES.toString("base64") }));
    const res = await callSurface(deskModelCtx(aiRun), "/api/voice/tts?surface=trading-desk", {
      method: "POST",
      body: { text: "Your balance is ready." },
    });
    expect(res?.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toContain("audio/mpeg");
    expect(Buffer.from(await res!.arrayBuffer()).equals(MP3_BYTES)).toBe(true);
  });

  it("the desk gate precedes the backend: a non-desk-broker tenant gets the #3429 refusal, and no model runs", async () => {
    brokerState.broker = "alpaca";
    const aiRun = vi.fn(async () => ({ text: "x" }));
    const res = await callSurface(deskModelCtx(aiRun), "/api/voice/stt?surface=trading-desk", {
      method: "POST",
      body: { audioBase64: AUDIO_B64 },
    });
    expect(res?.status).toBe(501);
    const body = (await res!.json()) as any;
    expect(body.code).toBe(CHANNEL_BROKER_UNAVAILABLE);
    expect(body.broker).toBe("alpaca");
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("a webspeech-resolved desk is refused at the model endpoints (503, named, no fallback)", async () => {
    const aiRun = vi.fn(async () => ({ text: "x" }));
    const res = await callSurface(
      makeCtx({ env: { AI: { run: aiRun } } }),
      "/api/voice/stt?surface=trading-desk",
      { method: "POST", body: { audioBase64: AUDIO_B64 } },
    );
    expect(res?.status).toBe(503);
    expect(((await res!.json()) as any).error).toBe("voice_backend_unavailable");
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("a failed desk STT model call is the named 502 voice_stt_model_failed", async () => {
    const aiRun = vi.fn(async () => {
      throw new Error("model exploded");
    });
    const res = await callSurface(deskModelCtx(aiRun), "/api/voice/stt?surface=trading-desk", {
      method: "POST",
      body: { audioBase64: AUDIO_B64 },
    });
    expect(res?.status).toBe(502);
    expect(((await res!.json()) as any).error).toBe("voice_stt_model_failed");
  });

  it("a copilot surface on the generalized route keeps the channel gate (403 COPILOT_CHANNEL_DISABLED)", async () => {
    const aiRun = vi.fn(async () => ({ text: "x" }));
    const ctx = makeCtx({
      env: {
        [COPILOT_VOICE_BACKEND_ENV]: "general=model",
        AI: { run: aiRun },
      },
    });
    const res = await callSurface(ctx, "/api/voice/stt?surface=general", {
      method: "POST",
      body: { audioBase64: AUDIO_B64 },
    });
    expect(res?.status).toBe(403);
    expect(((await res!.json()) as any).error).toBe("COPILOT_CHANNEL_DISABLED");
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("a copilot surface on the generalized route serves when its channel and backend allow", async () => {
    const aiRun = vi.fn(async () => ({ text: "positions please" }));
    const ctx = makeCtx({
      env: {
        [COPILOT_CHANNELS_ENV]: "stock:voice=on",
        [COPILOT_VOICE_BACKEND_ENV]: "stock=model",
        AI: { run: aiRun },
      },
    });
    const res = await callSurface(ctx, "/api/voice/stt?surface=stock", {
      method: "POST",
      body: { audioBase64: AUDIO_B64 },
    });
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ text: "positions please" });
  });

  it("the landed copilot paths keep working unchanged (compatibility, same handler)", async () => {
    const aiRun = vi.fn(async () => ({ text: "still works" }));
    const ctx = makeCtx({
      env: {
        [COPILOT_CHANNELS_ENV]: "stock:voice=on",
        [COPILOT_VOICE_BACKEND_ENV]: "stock=model",
        AI: { run: aiRun },
      },
    });
    const res = await callSurface(
      ctx,
      "/api/copilot-channels/voice/stt?registration=stock",
      { method: "POST", body: { audioBase64: AUDIO_B64 } },
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ text: "still works" });
  });

  it("an unknown surface on the voice endpoints is a 400; a non-matching path returns null", async () => {
    const aiRun = vi.fn(async () => ({ text: "x" }));
    expect(
      (
        await callSurface(
          makeCtx({ env: { AI: { run: aiRun } } }),
          "/api/voice/stt?surface=banana",
          { method: "POST", body: { audioBase64: AUDIO_B64 } },
        )
      )?.status,
    ).toBe(400);
    const miss = await callSurface(makeCtx(), "/api/voice/nope?surface=trading-desk", {
      method: "POST",
      body: {},
    });
    expect(miss).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 3. The client seam — one adapter pair, every surface                */
/* ------------------------------------------------------------------ */

/* The network boundary: apiFetch, routed by URL. */
const apiState = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init?: unknown }>,
  sttErrorBody: null as Record<string, unknown> | null,
  sttText: "desk transcript",
}));

vi.mock("../src/client/apiFetch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/client/apiFetch")>();
  return {
    ...actual,
    apiFetch: async (url: string, init?: unknown) => {
      apiState.calls.push({ url, init });
      if (url.includes("/api/voice/stt")) {
        if (apiState.sttErrorBody) {
          return {
            ok: false,
            status: 501,
            json: async () => apiState.sttErrorBody,
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ text: apiState.sttText }),
        };
      }
      if (url.includes("/api/voice/tts")) {
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob(["mp3"], { type: "audio/mpeg" }),
        };
      }
      if (url.includes("/api/voice/backend")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            surface: "trading-desk",
            voiceBackend: { backend: "model", source: "stored" },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
});

/* The recognition/synthesis boundary (the #3773 suite's mock). */
const voiceState = vi.hoisted(() => ({
  supported: true,
  handlers: null as null | {
    onStart?: () => void;
    onInterim?: (text: string) => void;
    onFinal?: (text: string) => void;
    onError?: () => void;
    onEnd?: () => void;
  },
  speakCalls: [] as Array<{ text: string; muted?: boolean }>,
}));

vi.mock("../src/client/voiceDeskClient", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/client/voiceDeskClient")>();
  return {
    ...actual,
    isVoiceRecognitionSupported: () => voiceState.supported,
    startVoiceRecognition: (handlers: typeof voiceState.handlers) => {
      voiceState.handlers = handlers;
      handlers?.onStart?.();
      return { stop: vi.fn() };
    },
    speakVoiceText: (text: string, opts?: { muted?: boolean }) => {
      voiceState.speakCalls.push({ text, muted: opts?.muted });
      return true;
    },
  };
});

import {
  CopilotVoiceError,
  fetchVoiceSurfaceBackend,
  transcribeVoiceSurface,
} from "../src/client/copilotChannelsApi";
import { createSurfaceVoiceBackend } from "../src/client/voiceBackend";

const mediaState = vi.hoisted(() => ({
  getUserMedia: vi.fn(),
  play: vi.fn(),
}));

class MockMediaRecorder {
  static isTypeSupported = () => true;
  mimeType = "audio/webm";
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["recorded-audio"], { type: "audio/webm" }),
    });
    this.onstop?.();
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("issue #3796 — the surface client: projection read + endpoints keyed by surface", () => {
  beforeEach(() => {
    apiState.calls = [];
    apiState.sttErrorBody = null;
    apiState.sttText = "desk transcript";
  });

  it("fetchVoiceSurfaceBackend reads the surface projection route", async () => {
    const projection = await fetchVoiceSurfaceBackend("trading-desk");
    expect(projection).toEqual({
      surface: "trading-desk",
      voiceBackend: { backend: "model", source: "stored" },
    });
    expect(apiState.calls[0].url).toBe("/api/voice/backend?surface=trading-desk");
  });

  it("transcribeVoiceSurface posts to the surface STT endpoint and resolves the transcript", async () => {
    await expect(transcribeVoiceSurface("trading-desk", "QUJD", "audio/webm")).resolves.toBe(
      "desk transcript",
    );
    expect(apiState.calls[0].url).toBe("/api/voice/stt?surface=trading-desk");
  });

  it("a desk-gate refusal body ({code}) surfaces as the named CopilotVoiceError code", async () => {
    apiState.sttErrorBody = { code: "BROKER_CHANNEL_UNAVAILABLE" };
    await expect(transcribeVoiceSurface("trading-desk", "QUJD")).rejects.toMatchObject({
      name: "CopilotVoiceError",
      code: "BROKER_CHANNEL_UNAVAILABLE",
    });
    expect(CopilotVoiceError).toBeDefined();
  });
});

describe("issue #3796 — the desk consumes the same seam (createSurfaceVoiceBackend)", () => {
  const savedGlobals: Record<string, unknown> = {};

  beforeEach(() => {
    apiState.calls = [];
    apiState.sttErrorBody = null;
    voiceState.handlers = null;
    voiceState.speakCalls = [];
    mediaState.getUserMedia.mockReset();
    mediaState.play.mockReset();
    mediaState.getUserMedia.mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    });
    mediaState.play.mockResolvedValue(undefined);
    for (const key of ["MediaRecorder", "Audio"] as const) {
      savedGlobals[key] = (globalThis as any)[key];
    }
    (globalThis as any).MediaRecorder = MockMediaRecorder;
    (globalThis as any).Audio = class MockAudio {
      play = mediaState.play;
      addEventListener() {}
      removeEventListener() {}
      pause() {}
    };
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: mediaState.getUserMedia },
      configurable: true,
    });
    (URL as any).createObjectURL = vi.fn(() => "blob:mock");
    (URL as any).revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    for (const key of ["MediaRecorder", "Audio"] as const) {
      (globalThis as any)[key] = savedGlobals[key];
    }
  });

  it("model adapter for the desk surface: records, posts to the SURFACE endpoint on stop, yields the transcript", async () => {
    const backend = createSurfaceVoiceBackend("model", { surface: "trading-desk" });
    const onFinal = vi.fn();
    const onError = vi.fn();
    const handle = backend.startCapture({ onFinal, onError });
    expect(handle).not.toBeNull();
    await flush();
    handle!.stop();
    // The finalize chain (recorder stop → FileReader → endpoint)
    // completes asynchronously; poll for the outcome rather than
    // counting ticks (fixed tick counts flake under shard load).
    await vi.waitFor(() =>
      expect(onFinal).toHaveBeenCalledWith("desk transcript"),
    );
    expect(onError).not.toHaveBeenCalled();
    const sttCall = apiState.calls.find((c) => c.url.includes("/api/voice/stt"));
    expect(sttCall?.url).toBe("/api/voice/stt?surface=trading-desk");
  });

  it("model adapter for the desk surface: muted never reaches TTS; unmuted synthesizes via the surface endpoint and plays", async () => {
    const backend = createSurfaceVoiceBackend("model", { surface: "trading-desk" });
    await expect(backend.speak("reply", { muted: true })).resolves.toBe(false);
    expect(apiState.calls.some((c) => c.url.includes("/api/voice/tts"))).toBe(false);
    await expect(backend.speak("reply", {})).resolves.toBe(true);
    const ttsCall = apiState.calls.find((c) => c.url.includes("/api/voice/tts"));
    expect(ttsCall?.url).toBe("/api/voice/tts?surface=trading-desk");
    expect(mediaState.play).toHaveBeenCalledTimes(1);
  });

  it("model adapter for the desk surface: a refused STT call surfaces the named code, never a fallback", async () => {
    apiState.sttErrorBody = { code: "BROKER_CHANNEL_UNAVAILABLE" };
    const backend = createSurfaceVoiceBackend("model", { surface: "trading-desk" });
    const onFinal = vi.fn();
    const onError = vi.fn();
    const handle = backend.startCapture({ onFinal, onError });
    await flush();
    handle!.stop();
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith("BROKER_CHANNEL_UNAVAILABLE"),
    );
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("webspeech adapter for the desk surface: capture delegates to the shared recognition; speak to the shared TTS", async () => {
    const backend = createSurfaceVoiceBackend("webspeech", { surface: "trading-desk" });
    const onFinal = vi.fn();
    const handle = backend.startCapture({ onFinal });
    expect(handle).not.toBeNull();
    voiceState.handlers?.onFinal?.("via recognition");
    expect(onFinal).toHaveBeenCalledWith("via recognition");
    await expect(backend.speak("a reply", {})).resolves.toBe(true);
    expect(voiceState.speakCalls).toEqual([{ text: "a reply", muted: undefined }]);
    // The webspeech path never reaches the surface endpoints.
    expect(apiState.calls).toEqual([]);
  });
});
