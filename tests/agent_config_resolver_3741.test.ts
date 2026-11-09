/**
 * Issue #3741 — the ONE resolver: conformance suite.
 *
 * Pins the decision record adopted on the issue (2026-11-08):
 * one resolver for channels, runtimes, tools, and choices;
 * granularity code default → class → tenant → instance/
 * registration → run (most granular wins); stored > env > code
 * default with stored flips live at resolve time; the effective
 * source NAMED in every result; same-layer last-writer-wins with
 * every flip audited; the operator layer can PIN an entry so
 * lower layers cannot flip it (a pin is named as the effective
 * source and lower-layer write attempts refuse by name); state
 * OFF = fully ephemeral, with manifest requires-edges refusing
 * by name where an enabled capability requires state.
 *
 * Production preservation: with production's current env (the
 * wrangler vars: COPILOT_CHANNELS "stock:voice=on",
 * COPILOT_VOICE_BACKEND "", CHAT_NLQ_MODE "off",
 * SCREENER_ND_MODE "on", AGENT_CAPABILITIES_DISABLED "") and no
 * stored settings, every migrated consumer resolves exactly as
 * it did before the generalization.
 */
import { describe, it, expect } from "vitest";
import {
  resolveAgentConfig,
  writeAgentConfigValue,
  listAgentConfigEntries,
  AGENT_CONFIG_PINNED,
  AGENT_CONFIG_UNKNOWN_ENTRY,
  AGENT_CONFIG_INVALID_VALUE,
  AGENT_CONFIG_WRITE_UNSUPPORTED,
  type AgentConfigIdentity,
} from "../src/services/agentConfigRegistry";
import {
  resolveCopilotChannel,
  resolveCopilotChannels,
} from "../src/services/copilotChannels";
import {
  resolveVoiceBackend,
  resolveCopilotVoiceBackend,
} from "../src/services/copilotVoiceBackend";
import {
  resolveChatNlqMode,
  resolveChatNlqTurnMode,
} from "../src/config/chatNlqModes";
import {
  resolveScreenerNdGate,
  resolveScreenerNdGateFromEnv,
  resolveScreenerNdGateResolved,
} from "../src/config/screenerModes";
import {
  resolveAgentCapabilityManifest,
  type CapabilityId,
} from "../src/actors/capabilityManifest";
import { handleCopilotChannelsRoutes } from "../src/agents/routes/copilotChannels";
import type { Env } from "../src/types";

/** Production's current deployment layer (wrangler.jsonc vars). */
const PRODUCTION_ENV = {
  COPILOT_CHANNELS: "stock:voice=on",
  COPILOT_VOICE_BACKEND: "",
  CHAT_NLQ_MODE: "off",
  SCREENER_ND_MODE: "on",
  AGENT_CAPABILITIES_DISABLED: "",
} as unknown as Env;

/** An in-memory mas_settings stand-in: the stored layer. */
function makeStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    readSettingRaw: (key: string) => map.get(key) ?? null,
    writeSetting: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function makeAudit() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    audit: (type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
    },
  };
}

const ORCHESTRATOR: AgentConfigIdentity = { className: "OrchestratorAgent" };
const SCREENER: AgentConfigIdentity = { className: "ScreenerAgent" };

describe("#3741 one resolver — registry and identity", () => {
  it("registers every family: channels, voice backend, the two choices, and all capabilities", () => {
    const entries = listAgentConfigEntries();
    for (const channel of ["chat", "webhooks", "email", "slack", "voice"]) {
      expect(entries).toContain(`channel:${channel}`);
    }
    expect(entries).toContain("voiceBackend");
    expect(entries).toContain("chatNlqMode");
    expect(entries).toContain("screenerNdMode");
    for (const capability of [
      "chat", "webhooks", "email", "slack", "voice",
      "mcpClient", "scheduler", "state", "lifecycle", "webSockets",
      "workspace", "sandbox", "browser", "webFetch", "webSearch",
      "aiSearch", "payments", "observability",
    ]) {
      expect(entries).toContain(capability);
    }
  });

  it("(a) two agents resolve the same choice differently from externalized config alone", () => {
    const store = makeStore({ "chat_nlq_mode:ScreenerAgent": "on" });
    const deps = { readSettingRaw: store.readSettingRaw, env: {} };
    const screener = resolveAgentConfig("chatNlqMode", SCREENER, deps);
    const orchestrator = resolveAgentConfig("chatNlqMode", ORCHESTRATOR, deps);
    expect(screener.value).toBe("on");
    expect(screener.source).toBe("stored");
    expect(orchestrator.value).toBe("off");
    expect(orchestrator.source).toBe("default");
  });

  it("(a) two registrations resolve the same channel differently from env alone", () => {
    const stock = resolveAgentConfig("channel:voice", { registrationId: "stock" }, { env: PRODUCTION_ENV });
    const general = resolveAgentConfig("channel:voice", { registrationId: "general" }, { env: PRODUCTION_ENV });
    expect(stock.value).toBe(true);
    expect(stock.source).toBe("env");
    expect(general.value).toBe(false);
    expect(general.source).toBe("default");
  });

  it("(b) changing externalized config changes the resolution with no code change", () => {
    const store = makeStore();
    const deps = { readSettingRaw: store.readSettingRaw, env: {} };
    const identity: AgentConfigIdentity = { surfaceId: "stock" };
    expect(resolveAgentConfig("voiceBackend", identity, deps).value).toBe("webspeech");
    store.map.set("copilot_voice_backend:stock", "model");
    const after = resolveAgentConfig("voiceBackend", identity, deps);
    expect(after.value).toBe("model");
    expect(after.source).toBe("stored");
  });
});

describe("#3741 production preservation — the defaults register holds (c)", () => {
  it("channels under production env, nothing stored", () => {
    const deps = { env: PRODUCTION_ENV };
    for (const registrationId of ["general", "options", "stock"] as const) {
      const chat = resolveAgentConfig("channel:chat", { registrationId }, deps);
      expect(chat.value).toBe(true);
      for (const channel of ["webhooks", "email", "slack"] as const) {
        const r = resolveAgentConfig(`channel:${channel}`, { registrationId }, deps);
        expect(r.value).toBe(false);
        expect(r.source).toBe("default");
      }
    }
    const stockVoice = resolveAgentConfig("channel:voice", { registrationId: "stock" }, deps);
    expect(stockVoice.value).toBe(true);
    expect(stockVoice.source).toBe("env");
    for (const registrationId of ["general", "options"] as const) {
      const r = resolveAgentConfig("channel:voice", { registrationId }, deps);
      expect(r.value).toBe(false);
      expect(r.source).toBe("default");
    }
    // The delegating family resolver agrees, pair by pair.
    for (const registrationId of ["general", "options", "stock"] as const) {
      const viaFamily = resolveCopilotChannels({ registrationId, env: PRODUCTION_ENV });
      for (const channel of ["chat", "webhooks", "email", "slack", "voice"] as const) {
        const viaResolver = resolveAgentConfig(`channel:${channel}`, { registrationId }, deps);
        expect(viaFamily[channel].enabled).toBe(viaResolver.value);
        expect(viaFamily[channel].source).toBe(viaResolver.source);
      }
    }
  });

  it("voice backend is webspeech on every surface (default), family resolvers agree", () => {
    for (const surfaceId of ["general", "options", "stock", "trading-desk"] as const) {
      const r = resolveAgentConfig("voiceBackend", { surfaceId }, { env: PRODUCTION_ENV });
      expect(r.value).toBe("webspeech");
      expect(r.source).toBe("default");
      const viaFamily = resolveVoiceBackend({ surfaceId, env: PRODUCTION_ENV });
      expect(viaFamily.backend).toBe("webspeech");
      expect(viaFamily.source).toBe("default");
    }
    const viaRegistration = resolveCopilotVoiceBackend({ registrationId: "stock", env: PRODUCTION_ENV });
    expect(viaRegistration.backend).toBe("webspeech");
  });

  it("chat/NLQ resolves off from the production env; the turn resolver agrees", () => {
    const r = resolveAgentConfig("chatNlqMode", ORCHESTRATOR, { env: PRODUCTION_ENV });
    expect(r.value).toBe("off");
    expect(r.source).toBe("env");
    const turn = resolveChatNlqTurnMode({ env: PRODUCTION_ENV });
    expect(turn.mode).toBe("off");
    expect(turn.level).toBe("env");
    expect(turn.invalid).toBe(false);
    // Nothing configured at all: the built-in default (off) holds.
    const bare = resolveAgentConfig("chatNlqMode", ORCHESTRATOR, { env: {} });
    expect(bare.value).toBe("off");
    expect(bare.source).toBe("default");
    expect(resolveChatNlqMode({}).mode).toBe("off");
    expect(resolveChatNlqMode({}).level).toBe("builtin");
  });

  it("screener ND resolves on from the production env; the gate resolver agrees", () => {
    const r = resolveAgentConfig("screenerNdMode", SCREENER, { env: PRODUCTION_ENV });
    expect(r.value).toBe("on");
    expect(r.source).toBe("env");
    const gate = resolveScreenerNdGateFromEnv(PRODUCTION_ENV);
    expect(gate.enabled).toBe(true);
    expect(gate.invalid).toBe(false);
    // Nothing configured: the built-in default (off) holds.
    expect(resolveScreenerNdGate(undefined)).toEqual({ enabled: false, invalid: false, raw: undefined });
    expect(resolveAgentConfig("screenerNdMode", SCREENER, { env: {} }).value).toBe("off");
  });

  it("capabilities are config-enabled for every class under the production env", () => {
    for (const className of ["OrchestratorAgent", "ScreenerAgent", "PaymentsAgent", "BrowserAgent"]) {
      for (const capability of ["state", "scheduler", "payments", "mcpClient", "workspace"] as const) {
        const r = resolveAgentConfig(capability, { className }, { env: PRODUCTION_ENV });
        expect(r.value).toBe(true);
        expect(r.pinned).toBe(false);
      }
    }
  });
});

describe("#3741 chat/NLQ composition — carriers, stored, env (migration 1)", () => {
  it("the per-user carrier beats the stored layer; the stored layer beats env", () => {
    const store = makeStore({ "chat_nlq_mode:stock": "on" });
    const withUser = resolveChatNlqTurnMode({
      env: { CHAT_NLQ_MODE: "off" },
      scopedChatNlqModes: { user: "off" },
      registrationId: "stock",
      readSettingRaw: store.readSettingRaw,
    });
    expect(withUser.mode).toBe("off");
    expect(withUser.level).toBe("user");

    const storedOnly = resolveChatNlqTurnMode({
      env: { CHAT_NLQ_MODE: "off" },
      registrationId: "stock",
      readSettingRaw: store.readSettingRaw,
    });
    expect(storedOnly.mode).toBe("on");
    expect(storedOnly.level).toBe("stored");
  });

  it("an invalid carrier still fails closed — the stored layer never rescues it", () => {
    const store = makeStore({ "chat_nlq_mode:stock": "on" });
    const r = resolveChatNlqTurnMode({
      env: { CHAT_NLQ_MODE: "on" },
      scopedChatNlqModes: { user: "bogus" },
      registrationId: "stock",
      readSettingRaw: store.readSettingRaw,
    });
    expect(r.mode).toBe("off");
    expect(r.invalid).toBe(true);
    expect(r.level).toBe("user");
  });

  it("the class-scoped stored key serves a class identity; the bare key is the tenant fallback", () => {
    const store = makeStore({ "chat_nlq_mode": "on" });
    const deps = { readSettingRaw: store.readSettingRaw, env: {} };
    const r = resolveAgentConfig("chatNlqMode", ORCHESTRATOR, deps);
    expect(r.value).toBe("on");
    expect(r.source).toBe("stored");
    store.map.set("chat_nlq_mode:OrchestratorAgent", "off");
    const classWins = resolveAgentConfig("chatNlqMode", ORCHESTRATOR, deps);
    expect(classWins.value).toBe("off");
    expect(classWins.source).toBe("stored");
  });
});

describe("#3741 screener ND composition (migration 2)", () => {
  it("the stored layer serves hosts that supply a reader; env-only hosts are unchanged", () => {
    const store = makeStore({ "screener_nd_mode:ScreenerAgent": "off" });
    const resolved = resolveScreenerNdGateResolved({
      env: PRODUCTION_ENV,
      readSettingRaw: store.readSettingRaw,
    });
    expect(resolved.value).toBe("off");
    expect(resolved.source).toBe("stored");
    // The env-only gate (the workflow hosts) still reads env alone.
    expect(resolveScreenerNdGateFromEnv(PRODUCTION_ENV).enabled).toBe(true);
  });

  it("an invalid env value still fails closed with the raw preserved", () => {
    const gate = resolveScreenerNdGate("bogus");
    expect(gate.enabled).toBe(false);
    expect(gate.invalid).toBe(true);
    expect(gate.raw).toBe("bogus");
    const resolved = resolveScreenerNdGateResolved({ env: { SCREENER_ND_MODE: "bogus" } });
    expect(resolved.value).toBe("off");
    expect(resolved.invalid).toBe(true);
    expect(resolved.source).toBe("env");
  });
});

describe("#3741 operator pins (d, e)", () => {
  it("(d) a pin is named as the effective source and freezes the operator-layer value", () => {
    const store = makeStore({ "copilot_voice_backend:stock": "model" });
    const env = { COPILOT_VOICE_BACKEND: "", AGENT_CONFIG_PINS: "*:voiceBackend" };
    const r = resolveAgentConfig("voiceBackend", { surfaceId: "stock" }, { readSettingRaw: store.readSettingRaw, env });
    expect(r.pinned).toBe(true);
    expect(r.source).toBe("pin");
    // The stored "model" flip does NOT take effect under the pin;
    // the frozen value is the operator layer's (env absent → default).
    expect(r.value).toBe("webspeech");
    const viaFamily = resolveVoiceBackend({ surfaceId: "stock", readSettingRaw: store.readSettingRaw, env });
    expect(viaFamily.backend).toBe("webspeech");
    expect(viaFamily.source).toBe("pin");
  });

  it("(d) a pinned capability cannot be disabled below the operator layer — the pin beats the disable list", () => {
    const env = {
      AGENT_CAPABILITIES_DISABLED: "*:payments",
      AGENT_CONFIG_PINS: "*:payments",
    };
    const r = resolveAgentConfig("payments", ORCHESTRATOR, { env });
    expect(r.value).toBe(true);
    expect(r.source).toBe("pin");
    expect(r.pinned).toBe(true);
  });

  it("(e) a lower-layer write against a pinned entry refuses by name and changes nothing", () => {
    const store = makeStore();
    const audit = makeAudit();
    const env = { AGENT_CONFIG_PINS: "*:voiceBackend" };
    const result = writeAgentConfigValue(
      {
        readSettingRaw: store.readSettingRaw,
        writeSetting: store.writeSetting,
        audit: audit.audit,
        env,
        actor: "alice",
      },
      "voiceBackend",
      { surfaceId: "stock" },
      "model",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(AGENT_CONFIG_PINNED);
      expect(result.message).toContain("voiceBackend");
    }
    expect(store.map.has("copilot_voice_backend:stock")).toBe(false);
    const refusals = audit.events.filter((e) => e.type === "agent_config.write_refused");
    expect(refusals).toHaveLength(1);
    expect(refusals[0].payload.error).toBe(AGENT_CONFIG_PINNED);
    expect(refusals[0].payload.actor).toBe("alice");
  });

  it("a scoped pin binds only its scope: another class's write proceeds", () => {
    const store = makeStore();
    const env = { AGENT_CONFIG_PINS: "ScreenerAgent:screenerNdMode" };
    const refused = writeAgentConfigValue(
      { readSettingRaw: store.readSettingRaw, writeSetting: store.writeSetting, env, actor: "alice" },
      "screenerNdMode",
      SCREENER,
      "off",
    );
    expect(refused.ok).toBe(false);
    const allowed = writeAgentConfigValue(
      { readSettingRaw: store.readSettingRaw, writeSetting: store.writeSetting, env, actor: "alice" },
      "screenerNdMode",
      ORCHESTRATOR,
      "off",
    );
    expect(allowed.ok).toBe(true);
    expect(store.map.get("screener_nd_mode:OrchestratorAgent")).toBe("off");
  });
});

describe("#3741 the write door — stored-layer writes, audit, last-writer-wins (f)", () => {
  it("writes the voice-backend surface keys (#3796's stored layer gains its door)", () => {
    const store = makeStore();
    const audit = makeAudit();
    const result = writeAgentConfigValue(
      {
        readSettingRaw: store.readSettingRaw,
        writeSetting: store.writeSetting,
        audit: audit.audit,
        env: {},
        actor: "alice",
      },
      "voiceBackend",
      { surfaceId: "trading-desk" },
      "model",
    );
    expect(result.ok).toBe(true);
    expect(store.map.get("copilot_voice_backend:trading-desk")).toBe("model");
    // The flip is live at resolve time — no redeploy, no cache.
    const r = resolveAgentConfig("voiceBackend", { surfaceId: "trading-desk" }, { readSettingRaw: store.readSettingRaw, env: {} });
    expect(r.value).toBe("model");
    expect(r.source).toBe("stored");
    const writes = audit.events.filter((e) => e.type === "agent_config.write");
    expect(writes).toHaveLength(1);
    expect(writes[0].payload).toMatchObject({
      entryId: "voiceBackend",
      key: "copilot_voice_backend:trading-desk",
      oldValue: null,
      newValue: "model",
      layer: "stored",
      actor: "alice",
    });
  });

  it("(f) same-layer last-writer-wins, with an audit entry for BOTH flips", () => {
    const store = makeStore();
    const audit = makeAudit();
    const deps = {
      readSettingRaw: store.readSettingRaw,
      writeSetting: store.writeSetting,
      audit: audit.audit,
      env: {},
    };
    const first = writeAgentConfigValue({ ...deps, actor: "alice" }, "chatNlqMode", ORCHESTRATOR, "on");
    const second = writeAgentConfigValue({ ...deps, actor: "copilot-self" }, "chatNlqMode", ORCHESTRATOR, "off");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(store.map.get("chat_nlq_mode:OrchestratorAgent")).toBe("off");
    const writes = audit.events.filter((e) => e.type === "agent_config.write");
    expect(writes).toHaveLength(2);
    expect(writes[0].payload).toMatchObject({ oldValue: null, newValue: "on", actor: "alice" });
    expect(writes[1].payload).toMatchObject({ oldValue: "on", newValue: "off", actor: "copilot-self" });
    const r = resolveAgentConfig("chatNlqMode", ORCHESTRATOR, { readSettingRaw: store.readSettingRaw, env: {} });
    expect(r.value).toBe("off");
    expect(r.source).toBe("stored");
  });

  it("a channel write merges into the stored map — unnamed decisions survive", () => {
    const store = makeStore({ "copilot_channels:stock": "voice=off" });
    const result = writeAgentConfigValue(
      { readSettingRaw: store.readSettingRaw, writeSetting: store.writeSetting, env: {}, actor: "alice" },
      "channel:slack",
      { registrationId: "stock" },
      "on",
    );
    expect(result.ok).toBe(true);
    expect(store.map.get("copilot_channels:stock")).toBe("slack=on,voice=off");
    const voice = resolveCopilotChannel({ registrationId: "stock", channel: "voice", readSettingRaw: store.readSettingRaw, env: {} });
    expect(voice.enabled).toBe(false);
    expect(voice.source).toBe("stored");
  });

  it("unknown entries, invalid values, and stored-less entries refuse by name", () => {
    const store = makeStore();
    const deps = { readSettingRaw: store.readSettingRaw, writeSetting: store.writeSetting, env: {}, actor: "alice" };
    const unknown = writeAgentConfigValue(deps, "nope", ORCHESTRATOR, "on");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toBe(AGENT_CONFIG_UNKNOWN_ENTRY);

    const invalid = writeAgentConfigValue(deps, "voiceBackend", { surfaceId: "stock" }, "carrier-pigeon");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toBe(AGENT_CONFIG_INVALID_VALUE);
      expect(invalid.message).toContain("webspeech");
    }
    expect(store.map.size).toBe(0);

    const capability = writeAgentConfigValue(deps, "payments", ORCHESTRATOR, "off");
    expect(capability.ok).toBe(false);
    if (!capability.ok) expect(capability.error).toBe(AGENT_CONFIG_WRITE_UNSUPPORTED);
  });
});

describe("#3741 capability entries agree with the manifest's config layer", () => {
  const rows: Array<{
    env: Record<string, string>;
    className: string;
    scopes?: string[];
    capability: CapabilityId;
    disabled: boolean;
  }> = [
    { env: {}, className: "OrchestratorAgent", capability: "state", disabled: false },
    { env: { AGENT_CAPABILITIES_DISABLED: "*:state" }, className: "OrchestratorAgent", capability: "state", disabled: true },
    { env: { AGENT_CAPABILITIES_DISABLED: "*:state" }, className: "ScreenerAgent", capability: "state", disabled: true },
    { env: { AGENT_CAPABILITIES_DISABLED: "OrchestratorAgent:payments" }, className: "OrchestratorAgent", capability: "payments", disabled: true },
    { env: { AGENT_CAPABILITIES_DISABLED: "OrchestratorAgent:payments" }, className: "ScreenerAgent", capability: "payments", disabled: false },
    { env: { AGENT_CAPABILITIES_DISABLED: "ORCHESTRATOR_AGENT:state" }, className: "OrchestratorAgent", scopes: ["ORCHESTRATOR_AGENT"], capability: "state", disabled: true },
    { env: { AGENT_CAPABILITIES_DISABLED: "ORCHESTRATOR_AGENT:state" }, className: "OrchestratorAgent", capability: "state", disabled: false },
    { env: { AGENT_CAPABILITIES_DISABLED: "ScreenerAgent:scheduler" }, className: "ScreenerAgent", capability: "scheduler", disabled: true },
  ];

  it("the resolver's config decision matches the manifest's disabled-by-config outcome on enabled postures", () => {
    for (const row of rows) {
      const r = resolveAgentConfig(row.capability, { className: row.className, scopes: row.scopes }, { env: row.env });
      expect(r.value, `${row.className}:${row.capability}`).toBe(!row.disabled);
      if (row.disabled) expect(r.source).toBe("env");
      // The manifest, given the same bindings, lands the same state.
      const manifest = resolveAgentCapabilityManifest(row.className, {
        env: row.env,
        bindings: row.scopes ?? [],
      });
      const flat = { ...manifest.channels, ...manifest.capabilities, ...manifest.tools };
      expect(flat[row.capability].state === "disabled-by-config", `${row.className}:${row.capability}`).toBe(row.disabled);
    }
  });

  it("malformed disable entries surface as issues in both resolutions", () => {
    const env = { AGENT_CAPABILITIES_DISABLED: "nonsense" };
    const r = resolveAgentConfig("state", ORCHESTRATOR, { env });
    expect(r.value).toBe(true);
    expect(r.issues.length).toBeGreaterThan(0);
    const manifest = resolveAgentCapabilityManifest("OrchestratorAgent", { env });
    expect(manifest.configIssues.length).toBeGreaterThan(0);
  });
});

describe("#3741 state OFF = ephemeral — requires-edges refuse by name", () => {
  it("disabling state names every enabled capability that requires it (OrchestratorAgent)", () => {
    const env = { AGENT_CAPABILITIES_DISABLED: "*:state" };
    const manifest = resolveAgentCapabilityManifest("OrchestratorAgent", { env });
    expect(manifest.capabilities.state.state).toBe("disabled-by-config");
    expect(manifest.refusals).toContain("capability_requires_state:workspace");
    expect(manifest.refusals).toContain("capability_requires_state:scheduler");
    expect(manifest.refusals).toContain("capability_requires_state:payments");

    const r = resolveAgentConfig("state", ORCHESTRATOR, { env });
    expect(r.value).toBe(false);
    expect(r.refusals).toEqual(manifest.refusals);
  });

  it("a requirer that is not enabled does not refuse (ScreenerAgent payments is not-implemented)", () => {
    const env = { AGENT_CAPABILITIES_DISABLED: "*:state" };
    const manifest = resolveAgentCapabilityManifest("ScreenerAgent", { env });
    expect(manifest.refusals).toContain("capability_requires_state:workspace");
    expect(manifest.refusals).toContain("capability_requires_state:scheduler");
    expect(manifest.refusals).not.toContain("capability_requires_state:payments");
  });

  it("no refusals while state serves", () => {
    const manifest = resolveAgentCapabilityManifest("OrchestratorAgent", { env: PRODUCTION_ENV as unknown as Record<string, unknown> });
    expect(manifest.refusals).toEqual([]);
    const r = resolveAgentConfig("state", ORCHESTRATOR, { env: PRODUCTION_ENV });
    expect(r.refusals).toEqual([]);
  });
});

describe("#3741 the write door over HTTP (routes/copilotChannels family)", () => {
  function doorCtx(store: ReturnType<typeof makeStore>, audit: ReturnType<typeof makeAudit>, env: Record<string, unknown> = {}) {
    return {
      env: env as Env,
      getScreenerExecutionContext: async () => ({ userLogin: "alice" }),
      readSettingRaw: store.readSettingRaw,
      writeSetting: store.writeSetting,
      audit: (type: string, _agent: "orchestrator", payload: Record<string, unknown>) => audit.audit(type, payload),
    };
  }

  function call(ctx: unknown, url: string, body?: unknown) {
    const request = new Request(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const u = new URL(url);
    return handleCopilotChannelsRoutes(request, u, u.pathname, "sess", ctx as never);
  }

  it("POST writes a voice-backend surface key; the surface read then projects it", async () => {
    const store = makeStore();
    const audit = makeAudit();
    const ctx = doorCtx(store, audit);
    const res = await call(ctx, "https://x/api/copilot-channels/config", {
      entry: "voiceBackend",
      surface: "trading-desk",
      value: "model",
    });
    expect(res?.status).toBe(200);
    const json = (await res!.json()) as { ok: boolean; key: string };
    expect(json.ok).toBe(true);
    expect(json.key).toBe("copilot_voice_backend:trading-desk");
    expect(store.map.get("copilot_voice_backend:trading-desk")).toBe("model");
    expect(audit.events.filter((e) => e.type === "agent_config.write")).toHaveLength(1);

    const read = await call(ctx, "https://x/api/voice/backend?surface=trading-desk");
    const readJson = (await read!.json()) as { voiceBackend: { backend: string; source: string } };
    expect(readJson.voiceBackend.backend).toBe("model");
    expect(readJson.voiceBackend.source).toBe("stored");
  });

  it("GET config names the resolution's source and pin state", async () => {
    const store = makeStore();
    const audit = makeAudit();
    const res = await call(doorCtx(store, audit), "https://x/api/copilot-channels/config?entry=voiceBackend&surface=stock");
    expect(res?.status).toBe(200);
    const json = (await res!.json()) as { value: string; source: string; pinned: boolean };
    expect(json.value).toBe("webspeech");
    expect(json.source).toBe("default");
    expect(json.pinned).toBe(false);
  });

  it("the door fails closed: 401 without a login, named refusals otherwise", async () => {
    const store = makeStore();
    const audit = makeAudit();
    const anon = {
      ...doorCtx(store, audit),
      getScreenerExecutionContext: async () => undefined,
    };
    const anonRes = await call(anon, "https://x/api/copilot-channels/config", { entry: "voiceBackend", surface: "stock", value: "model" });
    expect(anonRes?.status).toBe(401);

    const ctx = doorCtx(store, audit);
    const unknown = await call(ctx, "https://x/api/copilot-channels/config", { entry: "nope", value: "on" });
    expect(unknown?.status).toBe(400);
    expect(((await unknown!.json()) as { error: string }).error).toBe(AGENT_CONFIG_UNKNOWN_ENTRY);

    const invalid = await call(ctx, "https://x/api/copilot-channels/config", { entry: "voiceBackend", surface: "stock", value: "carrier-pigeon" });
    expect(invalid?.status).toBe(400);
    expect(((await invalid!.json()) as { error: string }).error).toBe(AGENT_CONFIG_INVALID_VALUE);

    const unsupported = await call(ctx, "https://x/api/copilot-channels/config", { entry: "payments", value: "off" });
    expect(unsupported?.status).toBe(400);
    expect(((await unsupported!.json()) as { error: string }).error).toBe(AGENT_CONFIG_WRITE_UNSUPPORTED);
    expect(store.map.size).toBe(0);
  });

  it("a pinned entry's door write is refused 403 by name and stores nothing", async () => {
    const store = makeStore();
    const audit = makeAudit();
    const ctx = doorCtx(store, audit, { AGENT_CONFIG_PINS: "*:voiceBackend" });
    const res = await call(ctx, "https://x/api/copilot-channels/config", { entry: "voiceBackend", surface: "stock", value: "model" });
    expect(res?.status).toBe(403);
    expect(((await res!.json()) as { error: string }).error).toBe(AGENT_CONFIG_PINNED);
    expect(store.map.size).toBe(0);
  });

  it("a host without a settings writer fails closed (500, named) rather than reporting success", async () => {
    const store = makeStore();
    const audit = makeAudit();
    const ctx = { ...doorCtx(store, audit), writeSetting: undefined };
    const res = await call(ctx, "https://x/api/copilot-channels/config", { entry: "voiceBackend", surface: "stock", value: "model" });
    expect(res?.status).toBe(500);
    expect(((await res!.json()) as { error: string }).error).toBe("AGENT_CONFIG_WRITE_UNAVAILABLE");
  });
});
