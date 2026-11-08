/** @vitest-environment jsdom */

/**
 * Issue #3738 — voice channel in the Stock Copilot view +
 * externalized per-copilot channel switches (on/off).
 *
 * The mechanism this suite pins:
 *
 *  1. A GENERIC switch model over (copilot registration × channel)
 *     for all five manifest channels (chat, webhooks, email, slack,
 *     voice), resolved stored > env > code-default with the
 *     effective source visible in the result (the platform's AOP
 *     precedence idiom — the stored settings layer the copilot
 *     panel already writes, the wrangler-vars deployment layer of
 *     #3727, then the code default that records today's behavior).
 *  2. The stock×voice pair wired end-to-end as first consumer:
 *     - the Stock Copilot panel renders its voice control only
 *       when voice resolves ON (switch AND the #3720 class-level
 *       activation — both must be on for the channel to serve);
 *     - a voice turn carrying the stock context while the switch
 *       is OFF is refused by name at the desk route
 *       (COPILOT_CHANNEL_DISABLED) and audited — distinct from
 *       the #3720 activation-withdrawal audit.
 *  3. Every other (registration × channel) resolves to its
 *     CURRENT effective state — this slice changes no other
 *     copilot's behavior.
 *  4. Production-shaped config (wrangler.jsonc vars): stock voice
 *     is ON, carried by the env layer explicitly.
 *
 * Harnesses: the #3720 suite's module mocks + MockSqlStorage ORM
 * for the desk route; the #3422 suite's node:sqlite shim for the
 * copilot routes; the #3422 panel suite's api-mock render idiom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------------------------------------------ */
/* Module mocks (the #3720 harness: binding seams only)                */
/* ------------------------------------------------------------------ */

const state = vi.hoisted(() => ({
  tenantBroker: "alpaca" as string,
  storedBroker: null as string | null,
  commercialFails: false,
  commercialBound: true,
}));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/tenantProviders")>();
  return {
    ...actual,
    resolveTenantBroker: async () => state.tenantBroker,
  };
});

vi.mock("../src/data/createCommercialPorts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/data/createCommercialPorts")>();
  return {
    ...actual,
    createCommercialAdapter: () =>
      state.commercialBound
        ? {
            getTenantBrokerSelection: async () => {
              if (state.commercialFails) throw new Error("store read failed");
              return state.storedBroker;
            },
          }
        : null,
  };
});

/* ------------------------------------------------------------------ */
/* Panel api mock (the #3422 render idiom: network boundary only)      */
/* ------------------------------------------------------------------ */

const apiState = vi.hoisted(() => ({
  status: null as null | Record<string, unknown>,
  failLoad: false,
}));

vi.mock("../src/client/stockCopilotApi", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    fetchStockCopilotStatus: vi.fn(async () => {
      if (apiState.failLoad || !apiState.status) throw new Error("load failed");
      return apiState.status;
    }),
    setStockCopilotPaused: vi.fn(async () => ({ ok: true, paused: true })),
    setStockCopilotSessions: vi.fn(async () => ({ ok: true, sessions: [] })),
  };
});

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  COPILOT_CHANNEL_DEFAULTS,
  COPILOT_CHANNEL_DISABLED,
  COPILOT_CHANNELS_ENV,
  COPILOT_REGISTRATION_SOURCE_TABS,
  copilotChannelsSettingKey,
  isCopilotRegistrationId,
  parseEnvCopilotChannelEntries,
  parseStoredCopilotChannelEntries,
  resolveCopilotChannel,
  resolveCopilotChannels,
} from "../src/services/copilotChannels";
import { CAPABILITY_CHANNELS } from "../src/actors/capabilityManifest";
import {
  findCopilot,
  getRegisteredCopilots,
} from "../src/client/chat/copilotRegistry";
import {
  CHANNEL_BROKER_UNAVAILABLE,
  handleTradingIntegrationsRoutes,
  type TradingIntegrationsRouteContext,
} from "../src/agents/routes/tradingIntegrations";
import {
  handleStockCopilotRoutes,
  type StockCopilotRouteContext,
} from "../src/agents/routes/stockCopilot";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { resolveIaaaTenant } from "../src/security/iaaaGithubEndToEnd";
import { BROKER_ENVIRONMENT_SETTING_KEY } from "../src/agents/routes/brokerEnvironment";
import { resolveStockCopilotVoiceActivation } from "../src/trading/voice/stockCopilotVoiceActivation";
import type { Env } from "../src/types";
import { StockCopilotPanel } from "../src/client/StockCopilotPanel";

beforeEach(() => {
  state.tenantBroker = "alpaca";
  state.storedBroker = null;
  state.commercialFails = false;
  state.commercialBound = true;
  apiState.status = null;
  apiState.failLoad = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* 1. The generic switch model: defaults = today's effective states    */
/* ------------------------------------------------------------------ */

describe("issue #3738 — copilot channel switch defaults record current behavior", () => {
  it("the code defaults live in ONE named table, complete over registrations × channels (the #3741 seam)", () => {
    // No scattered fallbacks: the exported COPILOT_CHANNEL_DEFAULTS
    // table is the code-default layer, and every resolver default
    // resolution must agree with it cell for cell.
    for (const registrationId of ["general", "options", "stock"] as const) {
      for (const channel of CAPABILITY_CHANNELS) {
        const cell = COPILOT_CHANNEL_DEFAULTS[registrationId][channel];
        expect(typeof cell, `${registrationId}:${channel}`).toBe("boolean");
        expect(resolveCopilotChannel({ registrationId, channel })).toMatchObject({
          enabled: cell,
          source: "default",
        });
      }
    }
    expect(COPILOT_CHANNEL_DEFAULTS).toEqual({
      general: { chat: true, webhooks: false, email: false, slack: false, voice: false },
      options: { chat: true, webhooks: false, email: false, slack: false, voice: false },
      stock: { chat: true, webhooks: false, email: false, slack: false, voice: true },
    });
  });

  it("chat is ON for every registration (the base channel each renders today)", () => {
    for (const registrationId of ["general", "options", "stock"] as const) {
      const r = resolveCopilotChannel({ registrationId, channel: "chat" });
      expect(r).toMatchObject({ enabled: true, source: "default" });
    }
  });

  it("voice is ON only for stock (the #3720 activation); general/options have no voice channel wired", () => {
    expect(resolveCopilotChannel({ registrationId: "stock", channel: "voice" }).enabled).toBe(true);
    expect(resolveCopilotChannel({ registrationId: "general", channel: "voice" }).enabled).toBe(false);
    expect(resolveCopilotChannel({ registrationId: "options", channel: "voice" }).enabled).toBe(false);
  });

  it("webhooks/email/slack are OFF per registration (class-level channels, no registration surface)", () => {
    for (const registrationId of ["general", "options", "stock"] as const) {
      for (const channel of ["webhooks", "email", "slack"] as const) {
        const r = resolveCopilotChannel({ registrationId, channel });
        expect(r, `${registrationId}:${channel}`).toMatchObject({
          enabled: false,
          source: "default",
        });
      }
    }
  });

  it("the model covers every registration × every manifest channel", () => {
    for (const registrationId of ["general", "options", "stock"] as const) {
      const all = resolveCopilotChannels({ registrationId });
      expect(Object.keys(all).sort()).toEqual([...CAPABILITY_CHANNELS].sort());
    }
  });

  it("registration ids and sourceTab carriers pin against the client registry", () => {
    const registryIds = getRegisteredCopilots().map((c) => c.id).sort();
    expect(registryIds).toEqual(["general", "options", "stock"]);
    for (const id of registryIds) {
      expect(isCopilotRegistrationId(id)).toBe(true);
      expect(COPILOT_REGISTRATION_SOURCE_TABS[id as keyof typeof COPILOT_REGISTRATION_SOURCE_TABS]).toBe(
        findCopilot(id)?.sourceTab,
      );
    }
    expect(isCopilotRegistrationId("nope")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Precedence: stored > env > code-default, source visible          */
/* ------------------------------------------------------------------ */

describe("issue #3738 — channel switch precedence (stored > env > default)", () => {
  it("env decides when nothing is stored, and says so", () => {
    const r = resolveCopilotChannel({
      registrationId: "stock",
      channel: "voice",
      env: { [COPILOT_CHANNELS_ENV]: "stock:voice=off" },
    });
    expect(r).toMatchObject({ enabled: false, source: "env" });
  });

  it("a stored decision beats the env layer, and says so", () => {
    const r = resolveCopilotChannel({
      registrationId: "stock",
      channel: "voice",
      readSettingRaw: (key) =>
        key === copilotChannelsSettingKey("stock") ? "voice=off" : null,
      env: { [COPILOT_CHANNELS_ENV]: "stock:voice=on" },
    });
    expect(r).toMatchObject({ enabled: false, source: "stored" });
  });

  it("a stored ON beats an env OFF (the user's own setting wins both ways)", () => {
    const r = resolveCopilotChannel({
      registrationId: "stock",
      channel: "voice",
      readSettingRaw: (key) =>
        key === copilotChannelsSettingKey("stock") ? "voice=on" : null,
      env: { [COPILOT_CHANNELS_ENV]: "stock:voice=off" },
    });
    expect(r).toMatchObject({ enabled: true, source: "stored" });
  });

  it("an env entry for another registration does not decide this one", () => {
    const r = resolveCopilotChannel({
      registrationId: "general",
      channel: "voice",
      env: { [COPILOT_CHANNELS_ENV]: "stock:voice=off" },
    });
    expect(r).toMatchObject({ enabled: false, source: "default" });
  });

  it("malformed entries decide nothing and are reported as issues", () => {
    const envParsed = parseEnvCopilotChannelEntries("stock:voice=maybe, bogus, stock:chat=off");
    expect(envParsed.decisions.get("stock:voice")).toBeUndefined();
    expect(envParsed.decisions.get("stock:chat")).toBe(false);
    expect(envParsed.issues.length).toBeGreaterThanOrEqual(2);
    const storedParsed = parseStoredCopilotChannelEntries("voice=off, wat=on");
    expect(storedParsed.decisions.voice).toBe(false);
    expect(storedParsed.issues.length).toBeGreaterThanOrEqual(1);
    const r = resolveCopilotChannel({
      registrationId: "stock",
      channel: "voice",
      env: { [COPILOT_CHANNELS_ENV]: "stock:voice=maybe" },
    });
    expect(r).toMatchObject({ enabled: true, source: "default" });
    expect(r.issues.length).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ */
/* 3. The desk route: switch OFF refuses by name; composition pinned   */
/* ------------------------------------------------------------------ */

const LOGIN = "alice";
const VOICE_PATH = "/trading/voice/turn";

interface RouteDrive {
  ctx: TradingIntegrationsRouteContext;
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
}

function makeRouteDrive(
  envExtra: Record<string, unknown> = {},
  settings: Record<string, string> = {},
): RouteDrive {
  const audits: RouteDrive["audits"] = [];
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema("session-3738");
  const storage = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
  };
  const ctx = {
    env: {
      APP_BASE_URL: "https://agent.openaimp.com",
      AI_SEARCH_ENDPOINT: "https://ai-search.internal",
      ORCHESTRATOR_AGENT: {} as never,
      ETRADE_ENVIRONMENT: "sandbox",
      ...envExtra,
    } as unknown as Env,
    getOrm: () => orm,
    audit: (type: string, _agent: unknown, payload: Record<string, unknown>) => {
      audits.push({ type, payload });
    },
    agentCtx: { storage } as never,
    nlqSchedulingPort: () => ({}) as never,
    getStorageSql: () => sql as never,
    readSettingRaw: (key: string) => settings[key] ?? null,
  } as unknown as TradingIntegrationsRouteContext;
  return { ctx, audits };
}

async function driveVoiceTurn(drive: RouteDrive, body: Record<string, unknown>) {
  return handleTradingIntegrationsRoutes(
    new Request(`https://agent.internal${VOICE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-login": LOGIN },
      body: JSON.stringify(body),
    }),
    new URL(`https://agent.internal${VOICE_PATH}`),
    VOICE_PATH,
    "session-3738",
    drive.ctx,
  );
}

describe("issue #3738 — a stock voice turn while the channel switch is OFF", () => {
  it("is refused by name (env OFF) and audited — the desk never sees it", async () => {
    const drive = makeRouteDrive({ [COPILOT_CHANNELS_ENV]: "stock:voice=off" });
    const res = await driveVoiceTurn(drive, {
      transcript: "um help",
      sourceTab: "Stock Copilot",
    });
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe(COPILOT_CHANNEL_DISABLED);
    expect(body.registrationId).toBe("stock");
    expect(body.channel).toBe("voice");
    const audit = drive.audits.find((a) => a.type === "stock_copilot.voice_channel_disabled");
    expect(audit?.payload.source).toBe("env");
    expect(drive.audits.some((a) => a.type === "trading.voice_turn")).toBe(false);
    expect(drive.audits.some((a) => a.type === "stock_copilot.voice_inactive")).toBe(false);
  });

  it("is refused by name when the STORED setting is OFF, beating an env ON", async () => {
    const drive = makeRouteDrive(
      { [COPILOT_CHANNELS_ENV]: "stock:voice=on" },
      { [copilotChannelsSettingKey("stock")]: "voice=off" },
    );
    const res = await driveVoiceTurn(drive, {
      transcript: "um help",
      sourceTab: "Stock Copilot",
    });
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe(COPILOT_CHANNEL_DISABLED);
    const audit = drive.audits.find((a) => a.type === "stock_copilot.voice_channel_disabled");
    expect(audit?.payload.source).toBe("stored");
  });

  it("composition: switch ON + class activation withdrawn (#3720) keeps the #3720 behavior, not the channel refusal", async () => {
    const drive = makeRouteDrive({
      [COPILOT_CHANNELS_ENV]: "stock:voice=on",
      AGENT_CAPABILITIES_DISABLED: "OrchestratorAgent:voice",
    });
    const res = await driveVoiceTurn(drive, {
      transcript: "um help",
      sourceTab: "Stock Copilot",
    });
    expect(res!.status).toBe(501);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe(CHANNEL_BROKER_UNAVAILABLE);
    expect(drive.audits.some((a) => a.type === "stock_copilot.voice_inactive")).toBe(true);
    expect(drive.audits.some((a) => a.type === "stock_copilot.voice_channel_disabled")).toBe(false);
  });

  it("with no switch config anywhere, the stock voice turn is served exactly as #3720 left it", async () => {
    const drive = makeRouteDrive();
    const res = await driveVoiceTurn(drive, {
      transcript: "um help",
      sourceTab: "Stock Copilot",
    });
    expect(res!.status).toBe(200);
    const turnAudit = drive.audits.find((a) => a.type === "trading.voice_turn");
    expect(turnAudit?.payload.copilotBrokerId).toBe("alpaca");
  });

  it("a non-stock voice turn is untouched by the stock switch (plain desk turn, refused as #3429 as before)", async () => {
    const drive = makeRouteDrive({ [COPILOT_CHANNELS_ENV]: "stock:voice=off" });
    const res = await driveVoiceTurn(drive, { transcript: "help" });
    expect(res!.status).toBe(501);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe(CHANNEL_BROKER_UNAVAILABLE);
  });
});

/* ------------------------------------------------------------------ */
/* 4. The copilot routes: status projection + the stored-layer door    */
/* ------------------------------------------------------------------ */

const STATUS_PATH = "/api/stock-copilot/status";
const CONTROL_PATH = "/api/stock-copilot/control";

async function makeCopilotCtx(options: {
  settings?: Map<string, string>;
  env?: Record<string, unknown>;
  withWriter?: boolean;
} = {}) {
  const settings = options.settings ?? new Map<string, string>();
  const writes: Array<{ key: string; value: string }> = [];
  const commercial = new InMemoryCommercialAdapter();
  await commercial.setTenantProviders(resolveIaaaTenant({}), {
    dataProviderId: "etrade",
    brokerId: "alpaca",
  });
  const sql = new MockSqlStorage();
  const ctx: StockCopilotRouteContext = {
    env: {
      STOCK_COPILOT_PAPER_ENABLED: "1",
      ...(options.env ?? {}),
    } as StockCopilotRouteContext["env"],
    sql: sql as never,
    getScreenerExecutionContext: async () => ({
      userLogin: "owner",
      environment: "TEST" as const,
    }),
    readSettingRaw: (key: string) =>
      key === BROKER_ENVIRONMENT_SETTING_KEY ? "TEST" : (settings.get(key) ?? null),
    ...(options.withWriter === false
      ? {}
      : {
          writeSetting: (key: string, value: string) => {
            writes.push({ key, value });
            settings.set(key, value);
          },
        }),
    commercial,
    audit: vi.fn(),
  };
  return { ctx, sql, settings, writes };
}

const copilotReq = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const callCopilot = (ctx: StockCopilotRouteContext, request: Request) => {
  const url = new URL(request.url);
  return handleStockCopilotRoutes(request, url, url.pathname, "session-1", ctx);
};

describe("issue #3738 — the status read projects the stock copilot's channel switches", () => {
  it("projects all five channels; voice composes switch + manifest activation (effective)", async () => {
    const { ctx } = await makeCopilotCtx();
    const res = await callCopilot(ctx, copilotReq("GET", STATUS_PATH));
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(Object.keys(body.channels).sort()).toEqual([...CAPABILITY_CHANNELS].sort());
    expect(body.channels.chat).toMatchObject({ enabled: true, source: "default" });
    expect(body.channels.slack).toMatchObject({ enabled: false, source: "default" });
    expect(body.channels.voice).toMatchObject({
      enabled: true,
      source: "default",
      manifestState: "enabled",
      effective: true,
    });
  });

  it("a stored voice OFF projects enabled:false / effective:false with source stored", async () => {
    const settings = new Map([[copilotChannelsSettingKey("stock"), "voice=off"]]);
    const { ctx } = await makeCopilotCtx({ settings });
    const res = await callCopilot(ctx, copilotReq("GET", STATUS_PATH));
    const body = (await res!.json()) as any;
    expect(body.channels.voice).toMatchObject({
      enabled: false,
      source: "stored",
      effective: false,
    });
  });

  it("an env voice OFF projects source env; a withdrawn manifest makes effective false while the switch stays on", async () => {
    const { ctx } = await makeCopilotCtx({
      env: { [COPILOT_CHANNELS_ENV]: "stock:voice=off" },
    });
    const res = await callCopilot(ctx, copilotReq("GET", STATUS_PATH));
    const body = (await res!.json()) as any;
    expect(body.channels.voice).toMatchObject({ enabled: false, source: "env", effective: false });

    const { ctx: ctx2 } = await makeCopilotCtx({
      env: { AGENT_CAPABILITIES_DISABLED: "OrchestratorAgent:voice" },
    });
    const res2 = await callCopilot(ctx2, copilotReq("GET", STATUS_PATH));
    const body2 = (await res2!.json()) as any;
    expect(body2.channels.voice).toMatchObject({
      enabled: true,
      manifestState: "disabled-by-config",
      effective: false,
    });
  });
});

describe("issue #3738 — the control route is the stored-layer door for channel switches", () => {
  it("writes the caller's channel decision to their settings and echoes the resolution", async () => {
    const { ctx, writes } = await makeCopilotCtx();
    const res = await callCopilot(
      ctx,
      copilotReq("POST", CONTROL_PATH, { channels: { voice: false } }),
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.ok).toBe(true);
    expect(writes).toEqual([
      { key: copilotChannelsSettingKey("stock"), value: "voice=off" },
    ]);
    expect(body.channels.voice).toMatchObject({
      enabled: false,
      source: "stored",
      effective: false,
    });
    // And the next status read resolves the stored decision.
    const status = await callCopilot(ctx, copilotReq("GET", STATUS_PATH));
    const statusBody = (await status!.json()) as any;
    expect(statusBody.channels.voice).toMatchObject({ enabled: false, source: "stored" });
  });

  it("merges with decisions already stored instead of overwriting them", async () => {
    const settings = new Map([[copilotChannelsSettingKey("stock"), "slack=on"]]);
    const { ctx, writes } = await makeCopilotCtx({ settings });
    const res = await callCopilot(
      ctx,
      copilotReq("POST", CONTROL_PATH, { channels: { voice: false } }),
    );
    expect(res?.status).toBe(200);
    expect(writes).toEqual([
      // Canonical channel order (CAPABILITY_CHANNELS): slack before voice.
      { key: copilotChannelsSettingKey("stock"), value: "slack=on,voice=off" },
    ]);
  });

  it("validates the channels field (unknown channel / non-boolean ⇒ 400, nothing written)", async () => {
    const { ctx, writes } = await makeCopilotCtx();
    const bad1 = await callCopilot(
      ctx,
      copilotReq("POST", CONTROL_PATH, { channels: { nope: true } }),
    );
    expect(bad1?.status).toBe(400);
    const bad2 = await callCopilot(
      ctx,
      copilotReq("POST", CONTROL_PATH, { channels: { voice: "off" } }),
    );
    expect(bad2?.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it("fails closed (500) when the host has no settings writer — never reports an unstored switch", async () => {
    const { ctx } = await makeCopilotCtx({ withWriter: false });
    const res = await callCopilot(
      ctx,
      copilotReq("POST", CONTROL_PATH, { channels: { voice: false } }),
    );
    expect(res?.status).toBe(500);
  });
});

/* ------------------------------------------------------------------ */
/* 5. The panel: the voice affordance renders only when voice is ON    */
/* ------------------------------------------------------------------ */

function panelStatus(channels?: Record<string, unknown>) {
  return {
    flagEnabled: true,
    paused: false,
    marketOpen: true,
    currentSession: "regular",
    enabledSessions: ["regular"],
    status: "live",
    selectionResolved: true,
    activeBroker: "alpaca",
    activeMode: "paper",
    userLogin: "owner",
    controlUpdatedAt: null,
    openPositions: [],
    closedPositions: [],
    activity: [],
    ...(channels ? { channels } : {}),
  };
}

async function renderPanel(status: Record<string, unknown>): Promise<{ container: HTMLElement; root: Root }> {
  apiState.status = status;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(StockCopilotPanel));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

describe("issue #3738 — the Stock Copilot panel's voice affordance", () => {
  it("renders the voice control when stock voice resolves ON (switch + activation)", async () => {
    const { container, root } = await renderPanel(
      panelStatus({
        voice: { enabled: true, source: "env", manifestState: "enabled", effective: true },
      }),
    );
    expect(container.textContent).toContain("Voice");
    expect(container.querySelector("[data-testid='stock-copilot-voice']")).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("renders NO voice control when the switch is OFF (effective false)", async () => {
    const { container, root } = await renderPanel(
      panelStatus({
        voice: { enabled: false, source: "stored", manifestState: "enabled", effective: false },
      }),
    );
    expect(container.querySelector("[data-testid='stock-copilot-voice']")).toBeNull();
    await act(async () => root.unmount());
  });

  it("renders NO voice control when the status carries no channel projection", async () => {
    const { container, root } = await renderPanel(panelStatus());
    expect(container.querySelector("[data-testid='stock-copilot-voice']")).toBeNull();
    await act(async () => root.unmount());
  });
});

/* ------------------------------------------------------------------ */
/* 6. Production-shaped config: stock voice ON, carried by env         */
/* ------------------------------------------------------------------ */

function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

describe("issue #3738 — production-shaped config (wrangler.jsonc vars)", () => {
  it("stock voice resolves ON from the env layer, and composes with the manifest activation", () => {
    const wrangler = JSON.parse(
      stripJsonc(readFileSync("wrangler.jsonc", "utf8")),
    ) as { vars?: Record<string, unknown> };
    const vars = { ...(wrangler.vars ?? {}) };
    expect(typeof vars[COPILOT_CHANNELS_ENV]).toBe("string");
    const r = resolveCopilotChannel({
      registrationId: "stock",
      channel: "voice",
      env: vars as Record<string, unknown>,
    });
    expect(r).toMatchObject({ enabled: true, source: "env" });
    const activation = resolveStockCopilotVoiceActivation({
      sourceTab: "Stock Copilot",
      env: vars as Record<string, unknown>,
    });
    expect(activation.state).toBe("enabled");
    expect(r.enabled && activation.state === "enabled").toBe(true);
  });
});
