/** @vitest-environment jsdom */

/**
 * Issue #3773 — mic in the chat box: the copilot chat composer
 * carries the voice channel, so the user chats with the copilot
 * by text or by voice — one conversation, two input channels.
 *
 * What this suite pins:
 *
 *  1. A generic channel-projection read for the chat surface:
 *     GET /api/copilot-channels?registration=<id> resolves the
 *     requested registration's channel switches through the SAME
 *     composition the Stock Copilot status read uses (#3738:
 *     resolveCopilotChannels stored > env > code-default, voice
 *     composed with the #3720 class-level activation) — no second
 *     resolver, no client-side precedence. Fail-closed like the
 *     copilot route family: no verified login ⇒ 401; an unknown
 *     registration ⇒ 400; a non-matching path ⇒ null.
 *  2. The projection is data-driven, not stock-hardcoded: stock
 *     voice resolves effective under production-shaped config;
 *     general voice is off by default and ON when the login's
 *     stored switch says so; a withdrawn class activation makes
 *     effective false while the switch stays on.
 *  3. Parity: for the stock registration the generic read's
 *     channels are byte-identical to the Stock Copilot status
 *     read's channels for the same inputs — the two surfaces can
 *     never disagree about whether voice serves.
 *  4. The voice BACKEND switch (owner enhancement, 2026-11-08):
 *     src/services/copilotVoiceBackend.ts resolves webspeech |
 *     model per registration, stored > env > code default
 *     (webspeech), source named, malformed entries surfaced as
 *     issues — the channels resolver's exact layering. The
 *     projection carries { backend, source } beside the channels
 *     (stock parity holds for it too). The channel gates
 *     presence; the backend only chooses how.
 *  5. The model endpoints: POST /api/copilot-channels/voice/stt
 *     and /voice/tts, session-gated like the family, channel gate
 *     (403 COPILOT_CHANNEL_DISABLED) before the backend gate
 *     (503 voice_backend_unavailable — webspeech-resolved or no
 *     AI binding, never a fallback); the STT/TTS models resolve
 *     through resolveAiModelName's voiceStt / voiceTts task keys;
 *     model failures are the named 502s.
 *  6. The client seam (src/client/voiceBackend.ts): one
 *     VoiceBackend interface, webspeech and model adapters; the
 *     composer control consumes the seam only. The model adapter
 *     records via MediaRecorder, posts the audio on stop, and
 *     submits the returned transcript through the same chat send
 *     path; a failed STT call surfaces the named code and submits
 *     nothing; reply playback synthesizes through TTS unless
 *     muted (muted never reaches the endpoint).
 *
 * Harnesses: the #3738 suite's route-context idiom (MockSqlStorage
 * + in-memory commercial adapter for the stock status parity leg).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  handleCopilotChannelsRoutes,
  type CopilotChannelsRouteContext,
} from "../src/agents/routes/copilotChannels";
import {
  handleStockCopilotRoutes,
  type StockCopilotRouteContext,
} from "../src/agents/routes/stockCopilot";
import {
  COPILOT_CHANNELS_ENV,
  copilotChannelsSettingKey,
} from "../src/services/copilotChannels";
import { CAPABILITY_CHANNELS } from "../src/actors/capabilityManifest";
import { MockSqlStorage } from "./mock-sql";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { resolveIaaaTenant } from "../src/security/iaaaGithubEndToEnd";
import { BROKER_ENVIRONMENT_SETTING_KEY } from "../src/agents/routes/brokerEnvironment";

/* ------------------------------------------------------------------ */
/* The generic projection read                                         */
/* ------------------------------------------------------------------ */

function makeChannelsCtx(options: {
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

const CHANNELS_PATH = "/api/copilot-channels";

function callChannels(
  ctx: CopilotChannelsRouteContext,
  registration?: string,
  path: string = CHANNELS_PATH,
) {
  const url = new URL(
    `https://agent.internal${path}${registration !== undefined ? `?registration=${registration}` : ""}`,
  );
  return handleCopilotChannelsRoutes(
    new Request(url, { method: "GET" }),
    url,
    path,
    "session-1",
    ctx,
  );
}

describe("issue #3773 — GET /api/copilot-channels projects any registration's channels", () => {
  it("stock voice is effective under production-shaped config (env layer decides)", async () => {
    const ctx = makeChannelsCtx({
      env: { [COPILOT_CHANNELS_ENV]: "stock:voice=on" },
    });
    const res = await callChannels(ctx, "stock");
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.registration).toBe("stock");
    expect(Object.keys(body.channels).sort()).toEqual([...CAPABILITY_CHANNELS].sort());
    expect(body.channels.chat).toMatchObject({ enabled: true, source: "default" });
    expect(body.channels.voice).toMatchObject({
      enabled: true,
      source: "env",
      manifestState: "enabled",
      effective: true,
    });
  });

  it("general voice is OFF by default (no mic) — the gate is the projection, not the registration name", async () => {
    const ctx = makeChannelsCtx();
    const res = await callChannels(ctx, "general");
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.channels.voice).toMatchObject({
      enabled: false,
      source: "default",
      manifestState: "enabled",
      effective: false,
    });
  });

  it("general voice turns effective when the login's stored switch says on (data-driven, not stock-only)", async () => {
    const settings = new Map([[copilotChannelsSettingKey("general"), "voice=on"]]);
    const ctx = makeChannelsCtx({ settings });
    const res = await callChannels(ctx, "general");
    const body = (await res!.json()) as any;
    expect(body.channels.voice).toMatchObject({
      enabled: true,
      source: "stored",
      effective: true,
    });
  });

  it("a stored voice OFF for stock beats the env ON — effective false, source stored", async () => {
    const settings = new Map([[copilotChannelsSettingKey("stock"), "voice=off"]]);
    const ctx = makeChannelsCtx({
      settings,
      env: { [COPILOT_CHANNELS_ENV]: "stock:voice=on" },
    });
    const res = await callChannels(ctx, "stock");
    const body = (await res!.json()) as any;
    expect(body.channels.voice).toMatchObject({
      enabled: false,
      source: "stored",
      effective: false,
    });
  });

  it("a withdrawn class activation (#3720) makes effective false while the switch stays on", async () => {
    const ctx = makeChannelsCtx({
      env: { AGENT_CAPABILITIES_DISABLED: "OrchestratorAgent:voice" },
    });
    const res = await callChannels(ctx, "stock");
    const body = (await res!.json()) as any;
    expect(body.channels.voice).toMatchObject({
      enabled: true,
      manifestState: "disabled-by-config",
      effective: false,
    });
  });

  it("an unknown or missing registration is a 400 (never a silent default)", async () => {
    const ctx = makeChannelsCtx();
    const bad = await callChannels(ctx, "nope");
    expect(bad?.status).toBe(400);
    const missing = await callChannels(ctx, undefined);
    expect(missing?.status).toBe(400);
  });

  it("fails closed without a verified login context (401), like the copilot route family", async () => {
    const ctx = makeChannelsCtx({ login: null });
    const res = await callChannels(ctx, "stock");
    expect(res?.status).toBe(401);
  });

  it("returns null for non-matching paths so the dispatcher falls through", async () => {
    const ctx = makeChannelsCtx();
    const res = await callChannels(ctx, "stock", "/api/something-else");
    expect(res).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Parity with the Stock Copilot status read                           */
/* ------------------------------------------------------------------ */

describe("issue #3773 — the generic projection cannot disagree with the stock status read", () => {
  it("stock channels from /api/copilot-channels deep-equal the status read's channels", async () => {
    const settings = new Map<string, string>();
    const env = { [COPILOT_CHANNELS_ENV]: "stock:voice=on" };
    const commercial = new InMemoryCommercialAdapter();
    await commercial.setTenantProviders(resolveIaaaTenant({}), {
      dataProviderId: "etrade",
      brokerId: "alpaca",
    });
    const stockCtx: StockCopilotRouteContext = {
      env: { STOCK_COPILOT_PAPER_ENABLED: "1", ...env } as StockCopilotRouteContext["env"],
      sql: new MockSqlStorage() as never,
      getScreenerExecutionContext: async () => ({
        userLogin: "owner",
        environment: "TEST" as const,
      }),
      readSettingRaw: (key: string) =>
        key === BROKER_ENVIRONMENT_SETTING_KEY ? "TEST" : (settings.get(key) ?? null),
      commercial,
      audit: vi.fn(),
    };
    const statusUrl = new URL("https://agent.internal/api/stock-copilot/status");
    const statusRes = await handleStockCopilotRoutes(
      new Request(statusUrl, { method: "GET" }),
      statusUrl,
      "/api/stock-copilot/status",
      "session-1",
      stockCtx,
    );
    expect(statusRes?.status).toBe(200);
    const statusBody = (await statusRes!.json()) as any;

    const genericRes = await callChannels(
      makeChannelsCtx({ settings, env }),
      "stock",
    );
    expect(genericRes?.status).toBe(200);
    const genericBody = (await genericRes!.json()) as any;
    expect(genericBody.channels).toEqual(statusBody.channels);
  });
});

/* ------------------------------------------------------------------ */
/* Client: the composer voice control + the chat-tab gate              */
/* ------------------------------------------------------------------ */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/* jsdom has no ResizeObserver; Fluent's MessageBar reflow hook
 * constructs one on mount. A no-op observer is the standard stub
 * (the same class of stub as the scrollIntoView one in the tab
 * harness below). */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = NoopResizeObserver;

/* Voice client mock: the recognition/synthesis boundary only. */
const voiceState = vi.hoisted(() => ({
  supported: true,
  startReturnsNull: false,
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
      if (voiceState.startReturnsNull) return null;
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

/* Chat hooks mock (the #3449 harness idiom). */
const chatState = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  messages: [] as any[],
  status: "ready" as string,
}));

vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: () => ({
    messages: chatState.messages,
    sendMessage: chatState.sendMessage,
    status: chatState.status,
    error: null,
    connectionError: null,
  }),
}));

vi.mock("agents/react", () => ({
  useAgent: () => ({ reconnect: vi.fn(), readyState: 1 }),
}));

vi.mock("../src/client/StockCopilotPanel", () => ({
  StockCopilotPanel: () => (
    <div data-testid="stock-copilot-panel">Stock Copilot Panel Surface</div>
  ),
}));

/* Channel projection mock: the network boundary for the tab's read. */
const channelsState = vi.hoisted(() => ({
  byRegistration: {} as Record<string, unknown>,
}));

/* Voice endpoint mock state: the model backend's network boundary. */
const voiceApiState = vi.hoisted(() => ({
  transcribe: vi.fn(),
  synthesize: vi.fn(),
}));

vi.mock("../src/client/copilotChannelsApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/client/copilotChannelsApi")>();
  return {
    ...actual,
    fetchCopilotChannels: vi.fn(async (registration: string) => {
      const projection = channelsState.byRegistration[registration];
      if (!projection) throw new Error("no projection");
      return projection;
    }),
    transcribeCopilotVoice: (...args: unknown[]) => voiceApiState.transcribe(...args),
    synthesizeCopilotVoice: (...args: unknown[]) => voiceApiState.synthesize(...args),
  };
});

import { ChatComposerVoiceControl } from "../src/client/chat/ChatComposerVoiceControl";
import { AgentChatTabContent } from "../src/client/chat/AgentChatTabContent";
import {
  copilotVoiceEffective,
  CopilotVoiceError,
} from "../src/client/copilotChannelsApi";
import { createVoiceBackend } from "../src/client/voiceBackend";

const wsBackend = () => createVoiceBackend("webspeech", { registration: "stock" });
const modelBackend = () => createVoiceBackend("model", { registration: "stock" });

function projectionFor(
  registration: string,
  voiceEffective: boolean,
  backend: "webspeech" | "model" = "webspeech",
) {
  return {
    registration,
    channels: {
      chat: { enabled: true, source: "default" },
      webhooks: { enabled: false, source: "default" },
      email: { enabled: false, source: "default" },
      slack: { enabled: false, source: "default" },
      voice: {
        enabled: voiceEffective,
        source: "env",
        manifestState: "enabled",
        effective: voiceEffective,
      },
    },
    voiceBackend: { backend, source: "default" },
  };
}

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

function mount(node: React.ReactNode): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

async function renderInto(
  root: Root,
  node: React.ReactNode,
): Promise<void> {
  await act(async () => {
    root.render(node);
  });
  await flush();
  await flush();
}

function clickButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent || "").includes(label),
  );
  if (!button) throw new Error(`button not found: ${label}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const userMsg = (id: string, text: string) => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});
const assistantMsg = (id: string, text: string) => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});

describe("issue #3773 — the gate helper reads the projection, nothing else", () => {
  it("copilotVoiceEffective is true exactly when voice.effective is true", () => {
    expect(copilotVoiceEffective(projectionFor("stock", true) as never)).toBe(true);
    expect(copilotVoiceEffective(projectionFor("stock", false) as never)).toBe(false);
    expect(copilotVoiceEffective(null)).toBe(false);
    expect(copilotVoiceEffective(undefined)).toBe(false);
    expect(copilotVoiceEffective({ registration: "stock" } as never)).toBe(false);
  });
});

describe("issue #3773 — ChatComposerVoiceControl", () => {
  beforeEach(() => {
    voiceState.supported = true;
    voiceState.startReturnsNull = false;
    voiceState.handlers = null;
    voiceState.speakCalls = [];
  });

  it("a final transcript submits through the chat send path (onSubmitTranscript)", async () => {
    const onSubmitTranscript = vi.fn();
    const { container, root } = mount(null);
    await renderInto(
      root,
      <ChatComposerVoiceControl backend={wsBackend()}
        isBusy={false}
        messages={[]}
        onSubmitTranscript={onSubmitTranscript}
      />,
    );
    clickButton(container, "Speak");
    expect(voiceState.handlers).not.toBeNull();
    act(() => voiceState.handlers?.onInterim?.("show my pos"));
    expect(container.textContent).toContain("show my pos");
    act(() => voiceState.handlers?.onFinal?.("show my positions"));
    expect(onSubmitTranscript).toHaveBeenCalledTimes(1);
    expect(onSubmitTranscript).toHaveBeenCalledWith("show my positions");
    await act(async () => root.unmount());
  });

  it("unsupported recognition is a named notice, never a dead button", async () => {
    voiceState.supported = false;
    const { container, root } = mount(null);
    await renderInto(
      root,
      <ChatComposerVoiceControl backend={wsBackend()}
        isBusy={false}
        messages={[]}
        onSubmitTranscript={vi.fn()}
      />,
    );
    clickButton(container, "Speak");
    expect(container.textContent).toContain(
      "Speech recognition is not supported in this browser",
    );
    await act(async () => root.unmount());
  });

  it("a recognizer that fails to start also lands on the named notice", async () => {
    voiceState.startReturnsNull = true;
    const { container, root } = mount(null);
    await renderInto(
      root,
      <ChatComposerVoiceControl backend={wsBackend()}
        isBusy={false}
        messages={[]}
        onSubmitTranscript={vi.fn()}
      />,
    );
    clickButton(container, "Speak");
    expect(container.textContent).toContain(
      "Speech recognition is not supported in this browser",
    );
    await act(async () => root.unmount());
  });

  it("the reply to a voice-submitted turn is spoken once the turn completes", async () => {
    const onSubmitTranscript = vi.fn();
    const { container, root } = mount(null);
    const render = (messages: any[], isBusy: boolean) =>
      renderInto(
        root,
        <ChatComposerVoiceControl backend={wsBackend()}
          isBusy={isBusy}
          messages={messages}
          onSubmitTranscript={onSubmitTranscript}
        />,
      );
    await render([], false);
    clickButton(container, "Speak");
    act(() => voiceState.handlers?.onFinal?.("what is the loop doing"));
    expect(onSubmitTranscript).toHaveBeenCalledWith("what is the loop doing");
    // The user turn lands and the agent is busy: nothing spoken yet.
    await render([userMsg("u1", "what is the loop doing")], true);
    expect(voiceState.speakCalls).toEqual([]);
    // The reply completes: spoken exactly once, with the reply text.
    await render(
      [userMsg("u1", "what is the loop doing"), assistantMsg("a1", "The loop is scanning.")],
      false,
    );
    expect(voiceState.speakCalls).toEqual([
      { text: "The loop is scanning.", muted: false },
    ]);
    await act(async () => root.unmount());
  });

  it("typed turns never trigger speech playback (no voice submit, no speech)", async () => {
    const { root } = mount(null);
    await renderInto(
      root,
      <ChatComposerVoiceControl backend={wsBackend()}
        isBusy={false}
        messages={[userMsg("u1", "typed question"), assistantMsg("a1", "typed reply")]}
        onSubmitTranscript={vi.fn()}
      />,
    );
    expect(voiceState.speakCalls).toEqual([]);
    await act(async () => root.unmount());
  });

  it("muting passes through to playback (the reply is not voiced aloud)", async () => {
    const onSubmitTranscript = vi.fn();
    const { container, root } = mount(null);
    const render = (messages: any[], isBusy: boolean) =>
      renderInto(
        root,
        <ChatComposerVoiceControl backend={wsBackend()}
          isBusy={isBusy}
          messages={messages}
          onSubmitTranscript={onSubmitTranscript}
        />,
      );
    await render([], false);
    clickButton(container, "Speak");
    act(() => voiceState.handlers?.onFinal?.("status please"));
    clickButton(container, "Audio on");
    await render(
      [userMsg("u1", "status please"), assistantMsg("a1", "All quiet.")],
      false,
    );
    expect(voiceState.speakCalls).toEqual([{ text: "All quiet.", muted: true }]);
    await act(async () => root.unmount());
  });
});

describe("issue #3773 — the chat tab renders the mic from the projection (data-driven gate)", () => {
  const mockUser = {
    login: "test-user",
    name: "Test User",
    avatar: "https://example.com/avatar.png",
  } as any;

  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    chatState.sendMessage.mockClear();
    chatState.messages = [];
    chatState.status = "ready";
    channelsState.byRegistration = {};
    voiceState.supported = true;
    voiceState.handlers = null;
    voiceState.speakCalls = [];
  });

  async function renderTab(view: string) {
    window.history.replaceState({}, "", `/?tab=chat&view=${view}`);
    const { container, root } = mount(null);
    await renderInto(
      root,
      <AgentChatTabContent
        user={mockUser}
        ads={[]}
        onAdClick={vi.fn()}
        onOpenAdsTab={vi.fn()}
        onStatusChange={vi.fn()}
        onResetSession={vi.fn()}
        isResetting={false}
        resetNotice={null}
        authExpired={false}
      />,
    );
    return { container, root };
  }

  it("stock view + voice effective ⇒ the composer mic renders", async () => {
    channelsState.byRegistration = { stock: projectionFor("stock", true) };
    const { container, root } = await renderTab("stock");
    expect(container.querySelector("[data-testid='chat-composer-voice']")).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("the mic + mute controls sit INLINE inside the chat box (.chat-input-bar), not on a bar above it (#3794)", async () => {
    channelsState.byRegistration = { stock: projectionFor("stock", true) };
    const { container, root } = await renderTab("stock");
    const bar = container.querySelector(".chat-input-bar");
    expect(bar).not.toBeNull();
    const voice = container.querySelector("[data-testid='chat-composer-voice']");
    expect(voice).not.toBeNull();
    // The voice controls live inside the composer form itself,
    // alongside the text input — no separate voice bar anywhere.
    expect(bar!.contains(voice)).toBe(true);
    const barButtons = [...bar!.querySelectorAll("button")].map(
      (b) => b.textContent ?? "",
    );
    expect(barButtons.join(" ")).toContain("Speak");
    expect(barButtons.join(" ")).toContain("Audio on");
    expect(bar!.querySelector("input")).not.toBeNull();
    // And no voice control exists outside the box.
    const outside = [...container.querySelectorAll("button")].filter(
      (b) => !bar!.contains(b) && (b.textContent ?? "").includes("Speak"),
    );
    expect(outside).toEqual([]);
    await act(async () => root.unmount());
  });

  it("stock view + voice NOT effective ⇒ no mic", async () => {
    channelsState.byRegistration = { stock: projectionFor("stock", false) };
    const { container, root } = await renderTab("stock");
    expect(container.querySelector("[data-testid='chat-composer-voice']")).toBeNull();
    await act(async () => root.unmount());
  });

  it("general view follows its own projection (off by default ⇒ no mic; stored on ⇒ mic)", async () => {
    channelsState.byRegistration = { general: projectionFor("general", false) };
    const off = await renderTab("general");
    expect(off.container.querySelector("[data-testid='chat-composer-voice']")).toBeNull();
    await act(async () => off.root.unmount());

    channelsState.byRegistration = { general: projectionFor("general", true) };
    const on = await renderTab("general");
    expect(on.container.querySelector("[data-testid='chat-composer-voice']")).not.toBeNull();
    await act(async () => on.root.unmount());
  });

  it("a voice transcript in the stock view lands as a normal chat turn (same sendMessage, stock sourceTab)", async () => {
    channelsState.byRegistration = { stock: projectionFor("stock", true) };
    const { container, root } = await renderTab("stock");
    clickButton(container, "Speak");
    act(() => voiceState.handlers?.onFinal?.("What is the loop doing?"));
    expect(chatState.sendMessage).toHaveBeenCalledTimes(1);
    expect(chatState.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "What is the loop doing?",
        role: "user",
        metadata: expect.objectContaining({ sourceTab: "Stock Copilot" }),
      }),
    );
    await act(async () => root.unmount());
  });

  it("a model-backend projection renders the same mic (the gate is the channel; the backend only chooses how)", async () => {
    channelsState.byRegistration = {
      stock: projectionFor("stock", true, "model"),
    };
    const { container, root } = await renderTab("stock");
    expect(container.querySelector("[data-testid='chat-composer-voice']")).not.toBeNull();
    await act(async () => root.unmount());
  });
});

/* ------------------------------------------------------------------ */
/* The voice BACKEND switch + the model endpoints + the client seam    */
/* ------------------------------------------------------------------ */

import {
  resolveCopilotVoiceBackend,
  copilotVoiceBackendSettingKey,
  COPILOT_VOICE_BACKEND_ENV,
} from "../src/services/copilotVoiceBackend";
import { COPILOT_CHANNEL_DISABLED } from "../src/services/copilotChannels";

describe("issue #3773 — the voice backend switch resolves stored > env > default (source named)", () => {
  const readFrom = (settings: Map<string, string>) => (key: string) =>
    settings.get(key) ?? null;

  it("code default is webspeech for every registration", () => {
    for (const registrationId of ["general", "options", "stock"] as const) {
      const resolved = resolveCopilotVoiceBackend({ registrationId });
      expect(resolved.backend).toBe("webspeech");
      expect(resolved.source).toBe("default");
      expect(resolved.issues).toEqual([]);
    }
  });

  it("the env layer decides per registration (COPILOT_VOICE_BACKEND entries)", () => {
    const env = { [COPILOT_VOICE_BACKEND_ENV]: "stock=model" };
    expect(resolveCopilotVoiceBackend({ registrationId: "stock", env })).toMatchObject({
      backend: "model",
      source: "env",
    });
    expect(resolveCopilotVoiceBackend({ registrationId: "general", env })).toMatchObject({
      backend: "webspeech",
      source: "default",
    });
  });

  it("the stored layer wins over the env layer", () => {
    const settings = new Map([[copilotVoiceBackendSettingKey("stock"), "webspeech"]]);
    const resolved = resolveCopilotVoiceBackend({
      registrationId: "stock",
      readSettingRaw: readFrom(settings),
      env: { [COPILOT_VOICE_BACKEND_ENV]: "stock=model" },
    });
    expect(resolved).toMatchObject({ backend: "webspeech", source: "stored" });
  });

  it("malformed entries decide nothing and surface as issues", () => {
    const settings = new Map([[copilotVoiceBackendSettingKey("stock"), "banana"]]);
    const fromStored = resolveCopilotVoiceBackend({
      registrationId: "stock",
      readSettingRaw: readFrom(settings),
    });
    expect(fromStored.backend).toBe("webspeech");
    expect(fromStored.source).toBe("default");
    expect(fromStored.issues).toHaveLength(1);

    const fromEnv = resolveCopilotVoiceBackend({
      registrationId: "stock",
      env: { [COPILOT_VOICE_BACKEND_ENV]: "stock=banana" },
    });
    expect(fromEnv.backend).toBe("webspeech");
    expect(fromEnv.source).toBe("default");
    expect(fromEnv.issues).toHaveLength(1);
  });

  it("the projection read carries voiceBackend + source, and stock parity holds for it too", async () => {
    const settings = new Map<string, string>();
    const env = {
      [COPILOT_CHANNELS_ENV]: "stock:voice=on",
      [COPILOT_VOICE_BACKEND_ENV]: "stock=model",
    };
    const genericRes = await callChannels(makeChannelsCtx({ settings, env }), "stock");
    expect(genericRes?.status).toBe(200);
    const genericBody = (await genericRes!.json()) as any;
    expect(genericBody.voiceBackend).toEqual({ backend: "model", source: "env" });

    const commercial = new InMemoryCommercialAdapter();
    await commercial.setTenantProviders(resolveIaaaTenant({}), {
      dataProviderId: "etrade",
      brokerId: "alpaca",
    });
    const stockCtx: StockCopilotRouteContext = {
      env: { STOCK_COPILOT_PAPER_ENABLED: "1", ...env } as StockCopilotRouteContext["env"],
      sql: new MockSqlStorage() as never,
      getScreenerExecutionContext: async () => ({
        userLogin: "owner",
        environment: "TEST" as const,
      }),
      readSettingRaw: (key: string) =>
        key === BROKER_ENVIRONMENT_SETTING_KEY ? "TEST" : (settings.get(key) ?? null),
      commercial,
      audit: vi.fn(),
    };
    const statusUrl = new URL("https://agent.internal/api/stock-copilot/status");
    const statusRes = await handleStockCopilotRoutes(
      new Request(statusUrl, { method: "GET" }),
      statusUrl,
      "/api/stock-copilot/status",
      "session-1",
      stockCtx,
    );
    expect(statusRes?.status).toBe(200);
    const statusBody = (await statusRes!.json()) as any;
    expect(statusBody.voiceBackend).toEqual(genericBody.voiceBackend);
  });
});

describe("issue #3773 — the model-backend voice endpoints (STT/TTS)", () => {
  const AUDIO_B64 = Buffer.from("fake-audio-bytes").toString("base64");
  const MP3_BYTES = Buffer.from("fake-mp3-bytes");

  function voiceCtx(aiRun?: unknown, envExtra: Record<string, unknown> = {}) {
    return makeChannelsCtx({
      env: {
        [COPILOT_CHANNELS_ENV]: "stock:voice=on",
        [COPILOT_VOICE_BACKEND_ENV]: "stock=model",
        ...(aiRun !== undefined ? { AI: { run: aiRun } } : {}),
        ...envExtra,
      },
    });
  }

  function callVoice(
    ctx: CopilotChannelsRouteContext,
    kind: "stt" | "tts",
    body: unknown,
    registration = "stock",
  ) {
    const path = `/api/copilot-channels/voice/${kind}`;
    const url = new URL(
      `https://agent.internal${path}?registration=${registration}`,
    );
    return handleCopilotChannelsRoutes(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      url,
      path,
      "session-1",
      ctx,
    );
  }

  it("STT runs the resolved voiceStt model over the posted audio and returns the transcript", async () => {
    const aiRun = vi.fn(async () => ({ text: "  show my positions  " }));
    const res = await callVoice(voiceCtx(aiRun), "stt", { audioBase64: AUDIO_B64 });
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ text: "show my positions" });
    expect(aiRun).toHaveBeenCalledTimes(1);
    const [model, inputs] = aiRun.mock.calls[0] as unknown as [string, { audio: number[] }];
    expect(model).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(Array.isArray(inputs.audio)).toBe(true);
    expect(inputs.audio).toHaveLength(Buffer.from("fake-audio-bytes").length);
  });

  it("TTS runs the resolved voiceTts model and returns audio bytes", async () => {
    const aiRun = vi.fn(async () => ({
      audio: MP3_BYTES.toString("base64"),
    }));
    const res = await callVoice(voiceCtx(aiRun), "tts", { text: "The loop is scanning." });
    expect(res?.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toContain("audio/mpeg");
    expect(Buffer.from(await res!.arrayBuffer()).equals(MP3_BYTES)).toBe(true);
    const [model, inputs] = aiRun.mock.calls[0] as unknown as [string, { prompt: string }];
    expect(model).toBe("@cf/myshell-ai/melotts");
    expect(inputs.prompt).toBe("The loop is scanning.");
  });

  it("a failed STT model call is the named 502 voice_stt_model_failed", async () => {
    const aiRun = vi.fn(async () => {
      throw new Error("model exploded");
    });
    const res = await callVoice(voiceCtx(aiRun), "stt", { audioBase64: AUDIO_B64 });
    expect(res?.status).toBe(502);
    expect(((await res!.json()) as any).error).toBe("voice_stt_model_failed");
  });

  it("a failed TTS model call is the named 502 voice_tts_model_failed", async () => {
    const aiRun = vi.fn(async () => ({ audio: "" }));
    const res = await callVoice(voiceCtx(aiRun), "tts", { text: "hello" });
    expect(res?.status).toBe(502);
    expect(((await res!.json()) as any).error).toBe("voice_tts_model_failed");
  });

  it("no AI binding ⇒ 503 voice_backend_unavailable (named, no fallback)", async () => {
    const res = await callVoice(voiceCtx(undefined), "stt", { audioBase64: AUDIO_B64 });
    expect(res?.status).toBe(503);
    expect(((await res!.json()) as any).error).toBe("voice_backend_unavailable");
  });

  it("a webspeech-resolved registration is refused at the model endpoints (503, named)", async () => {
    const aiRun = vi.fn(async () => ({ text: "x" }));
    const ctx = makeChannelsCtx({
      env: {
        [COPILOT_CHANNELS_ENV]: "stock:voice=on",
        AI: { run: aiRun },
      },
    });
    const res = await callVoice(ctx, "stt", { audioBase64: AUDIO_B64 });
    expect(res?.status).toBe(503);
    expect(((await res!.json()) as any).error).toBe("voice_backend_unavailable");
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("the channel gate precedes the backend: voice off ⇒ 403 COPILOT_CHANNEL_DISABLED", async () => {
    const aiRun = vi.fn(async () => ({ text: "x" }));
    const ctx = makeChannelsCtx({
      env: {
        [COPILOT_VOICE_BACKEND_ENV]: "general=model",
        AI: { run: aiRun },
      },
    });
    const res = await callVoice(ctx, "stt", { audioBase64: AUDIO_B64 }, "general");
    expect(res?.status).toBe(403);
    expect(((await res!.json()) as any).error).toBe(COPILOT_CHANNEL_DISABLED);
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("malformed bodies are 400s; no login is a 401", async () => {
    const aiRun = vi.fn(async () => ({ text: "x" }));
    expect((await callVoice(voiceCtx(aiRun), "stt", {}))?.status).toBe(400);
    expect((await callVoice(voiceCtx(aiRun), "tts", { text: "  " }))?.status).toBe(400);
    const anon = makeChannelsCtx({
      login: null,
      env: {
        [COPILOT_CHANNELS_ENV]: "stock:voice=on",
        [COPILOT_VOICE_BACKEND_ENV]: "stock=model",
        AI: { run: aiRun },
      },
    });
    expect((await callVoice(anon, "stt", { audioBase64: AUDIO_B64 }))?.status).toBe(401);
  });
});

/* Media mocks for the model adapter: jsdom has no MediaRecorder,
 * no getUserMedia, and no playable Audio. */
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

describe("issue #3773 — the client voice seam (one seam, two adapters)", () => {
  const savedGlobals: Record<string, unknown> = {};

  beforeEach(() => {
    voiceState.supported = true;
    voiceState.startReturnsNull = false;
    voiceState.handlers = null;
    voiceState.speakCalls = [];
    voiceApiState.transcribe.mockReset();
    voiceApiState.synthesize.mockReset();
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

  it("webspeech adapter: capture delegates to the shared recognition; speak delegates to the shared TTS", async () => {
    const backend = createVoiceBackend("webspeech", { registration: "stock" });
    const onFinal = vi.fn();
    const handle = backend.startCapture({ onFinal });
    expect(handle).not.toBeNull();
    expect(voiceState.handlers).not.toBeNull();
    voiceState.handlers?.onFinal?.("via recognition");
    expect(onFinal).toHaveBeenCalledWith("via recognition");
    await expect(backend.speak("a reply", {})).resolves.toBe(true);
    expect(voiceState.speakCalls).toEqual([{ text: "a reply", muted: undefined }]);
  });

  it("model adapter: records, posts the audio to STT on stop, and yields the transcript", async () => {
    voiceApiState.transcribe.mockResolvedValue("show my positions");
    const backend = createVoiceBackend("model", { registration: "stock" });
    const onStart = vi.fn();
    const onFinal = vi.fn();
    const onError = vi.fn();
    const handle = backend.startCapture({ onStart, onFinal, onError });
    expect(handle).not.toBeNull();
    await flush();
    expect(onStart).toHaveBeenCalledTimes(1);
    handle!.stop();
    await flush();
    await flush();
    expect(voiceApiState.transcribe).toHaveBeenCalledWith(
      "stock",
      expect.any(String),
      "audio/webm",
    );
    expect(onFinal).toHaveBeenCalledWith("show my positions");
    expect(onError).not.toHaveBeenCalled();
  });

  it("model adapter: mic permission failure is the named voice_backend_unavailable", async () => {
    mediaState.getUserMedia.mockRejectedValue(new Error("denied"));
    const backend = createVoiceBackend("model", { registration: "stock" });
    const onError = vi.fn();
    const onFinal = vi.fn();
    backend.startCapture({ onFinal, onError });
    await flush();
    expect(onError).toHaveBeenCalledWith("voice_backend_unavailable");
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("model adapter speak: muted never reaches TTS; unmuted synthesizes and plays", async () => {
    voiceApiState.synthesize.mockResolvedValue(new Blob(["mp3"], { type: "audio/mpeg" }));
    const backend = createVoiceBackend("model", { registration: "stock" });
    await expect(backend.speak("reply", { muted: true })).resolves.toBe(false);
    expect(voiceApiState.synthesize).not.toHaveBeenCalled();
    await expect(backend.speak("reply", {})).resolves.toBe(true);
    expect(voiceApiState.synthesize).toHaveBeenCalledWith("stock", "reply");
    expect(mediaState.play).toHaveBeenCalledTimes(1);
  });

  it("control + model backend: record → stop → the STT transcript submits as a chat turn", async () => {
    voiceApiState.transcribe.mockResolvedValue("show my positions");
    const onSubmitTranscript = vi.fn();
    const { container, root } = mount(null);
    await renderInto(
      root,
      <ChatComposerVoiceControl
        backend={modelBackend()}
        isBusy={false}
        messages={[]}
        onSubmitTranscript={onSubmitTranscript}
      />,
    );
    clickButton(container, "Speak");
    await flush();
    clickButton(container, "Stop listening");
    await flush();
    await flush();
    expect(onSubmitTranscript).toHaveBeenCalledWith("show my positions");
    await act(async () => root.unmount());
  });

  it("control + model backend: a failed STT call surfaces the named state and submits nothing", async () => {
    voiceApiState.transcribe.mockRejectedValue(
      new CopilotVoiceError("voice_stt_model_failed"),
    );
    const onSubmitTranscript = vi.fn();
    const { container, root } = mount(null);
    await renderInto(
      root,
      <ChatComposerVoiceControl
        backend={modelBackend()}
        isBusy={false}
        messages={[]}
        onSubmitTranscript={onSubmitTranscript}
      />,
    );
    clickButton(container, "Speak");
    await flush();
    clickButton(container, "Stop listening");
    await flush();
    await flush();
    expect(container.textContent).toContain("voice_stt_model_failed");
    expect(container.textContent).toContain("Nothing was sent");
    expect(onSubmitTranscript).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("control + model backend: the reply to a model-voice turn is synthesized and played; muted skips TTS", async () => {
    voiceApiState.transcribe.mockResolvedValue("status please");
    voiceApiState.synthesize.mockResolvedValue(new Blob(["mp3"], { type: "audio/mpeg" }));
    const onSubmitTranscript = vi.fn();
    const { container, root } = mount(null);
    const render = (messages: any[], isBusy: boolean) =>
      renderInto(
        root,
        <ChatComposerVoiceControl
          backend={modelBackend()}
          isBusy={isBusy}
          messages={messages}
          onSubmitTranscript={onSubmitTranscript}
        />,
      );
    await render([], false);
    clickButton(container, "Speak");
    await flush();
    clickButton(container, "Stop listening");
    await flush();
    await flush();
    expect(onSubmitTranscript).toHaveBeenCalledWith("status please");
    await render(
      [userMsg("u1", "status please"), assistantMsg("a1", "All quiet.")],
      false,
    );
    await flush();
    expect(voiceApiState.synthesize).toHaveBeenCalledWith("stock", "All quiet.");
    expect(mediaState.play).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
