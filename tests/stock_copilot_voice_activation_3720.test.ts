/**
 * Issue #3720 (Capability S3, epic #3488) — activate the EXISTING
 * voice channel for the Stock Copilot.
 *
 * The channel itself is not built here: the voice desk is #3418's
 * (src/trading/voice/agent.ts — ETradeVoiceTradingService, transcript
 * normalization, pronunciation tuning, the #815 per-turn forwarder
 * onto the session user's OrchestratorAgent, whose
 * POST /trading/voice/turn route runs the desk against the DO's real
 * ORM). What this suite pins is the ACTIVATION the slice adds:
 *
 *  1. Declaration — the stock registration declares voice in the
 *     #3489 manifest vocabulary (copilotRegistry), and the class
 *     manifest resolves voice ENABLED for OrchestratorAgent (the
 *     class that hosts the channel), while every other PortThink
 *     class keeps the fleet default (not-implemented): the
 *     activation is class-scoped, exactly as S4's was.
 *  2. Activation resolution — resolveStockCopilotVoiceActivation
 *     ties declaration to turn: active exactly when the turn
 *     carries the stock copilot's context (the sourceTab carrier,
 *     the chatTurnHelpers idiom) AND the class manifest's voice
 *     entry resolves enabled. The machinery's own externalized
 *     override (AGENT_CAPABILITIES_DISABLED=OrchestratorAgent:voice)
 *     withdraws it — disabled-by-config, no code change.
 *  3. The desk gate composition — the #3429 blanket refusal (a
 *     non-E*TRADE tenant's channel turn is refused before any
 *     service is built) is lifted for a voice turn ONLY when it
 *     carries the stock copilot's context, the activation is
 *     active, and the copilot's own selection resolver
 *     (#3451, resolveCopilotTradingSelection) resolves. The turn
 *     is then served by the existing desk, carrying the resolved
 *     broker; an unresolved selection fails closed (refusal
 *     stands), a withdrawn activation is audited
 *     (stock_copilot.voice_inactive) and the refusal stands, and
 *     a voice turn without the copilot context is refused exactly
 *     as before. The greeting path is not lifted.
 *  4. The execution invariant — voice order APPROVAL still
 *     executes only on E*TRADE: a copilot-context turn whose
 *     resolved broker is not E*TRADE gets the named refusal from
 *     the desk's approval leg and nothing executes (the neutral
 *     execution desk is #3556's build; this slice composes with
 *     its direction, it does not fork it). Without the carrier,
 *     the approval leg behaves exactly as it does today.
 *  5. The carrier chain — a voice turn's copilot context rides
 *     the EXISTING path end to end: WebSocket frame → the #815
 *     forwarder's DO request body → the DO route → the desk,
 *     where the transcript is normalized by the desk's own
 *     normalizer before it is answered.
 *
 * Harness: the #3429 gate suite's module mocks (tenantProviders +
 * the commercial composition seam — binding seams only), the
 * voice_trading suite's MockSqlStorage ORM, and a fake
 * ORCHESTRATOR_AGENT namespace at the actor-gateway seam.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  /** resolveTenantBroker's answer — the #3429 desk gate's read. */
  tenantBroker: "alpaca" as string,
  /** The commercial store's stored selection (null = absent). */
  storedBroker: null as string | null,
  /** The commercial store read throws → selection unresolved. */
  commercialFails: false,
  /** No AGENT_DB → the composition adapter is null → unresolved. */
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

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  createOrchestratorVoiceTurnForwarder,
  ETradeVoiceTradingService,
  handleVoiceWebSocketConnection,
  type VoiceTurnForwarder,
} from "../src/trading/voice/agent";
import {
  resolveStockCopilotVoiceActivation,
  STOCK_COPILOT_VOICE_SOURCE_TAB,
} from "../src/trading/voice/stockCopilotVoiceActivation";
import { STOCK_COPILOT_SOURCE_TAB } from "../src/agents/orchestrator/meshMcpClient";
import {
  CHANNEL_BROKER_UNAVAILABLE,
  handleTradingIntegrationsRoutes,
  type TradingIntegrationsRouteContext,
} from "../src/agents/routes/tradingIntegrations";
import { resolveAgentCapabilityManifest } from "../src/actors/capabilityManifest";
import { findCopilot } from "../src/client/chat/copilotRegistry";
import { ETradeRestClient } from "../src/trading/etrade/client";
import type { Env, VoiceTradingTurnResponse } from "../src/types";

const LOGIN = "alice";
const VOICE_PATH = "/trading/voice/turn";

beforeEach(() => {
  state.tenantBroker = "alpaca";
  state.storedBroker = null;
  state.commercialFails = false;
  state.commercialBound = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* 1. Declaration                                                      */
/* ------------------------------------------------------------------ */

describe("issue #3720 — the Stock Copilot's voice declaration", () => {
  it("the stock registration declares voice in the manifest vocabulary; general/options declare it not", () => {
    expect(findCopilot("stock")?.capabilities).toContain("voice");
    expect(findCopilot("stock")?.capabilities).toContain("mcpClient");
    expect(findCopilot("general")?.capabilities ?? []).not.toContain("voice");
    expect(findCopilot("options")?.capabilities ?? []).not.toContain("voice");
  });

  it("the voice carrier is the stock registration's sourceTab, the same carrier S4 reads", () => {
    expect(findCopilot("stock")?.sourceTab).toBe(STOCK_COPILOT_VOICE_SOURCE_TAB);
    expect(STOCK_COPILOT_VOICE_SOURCE_TAB).toBe(STOCK_COPILOT_SOURCE_TAB);
  });

  it("the class manifest resolves voice enabled for OrchestratorAgent — the class that hosts the desk", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent");
    expect(m.channels.voice.state).toBe("enabled");
  });

  it("the activation is class-scoped: other PortThink classes keep the fleet default", () => {
    for (const className of ["ResearchAgent", "TradingAgent", "ScheduledAgent"]) {
      const m = resolveAgentCapabilityManifest(className);
      expect(m.channels.voice.state, className).toBe("not-implemented");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. Activation resolution                                            */
/* ------------------------------------------------------------------ */

describe("issue #3720 — activation resolution (manifest-driven, stock context only)", () => {
  it("a stock-copilot voice context with the declaration in place is active", () => {
    const a = resolveStockCopilotVoiceActivation({
      sourceTab: STOCK_COPILOT_VOICE_SOURCE_TAB,
      env: {},
    });
    expect(a).toEqual({ active: true, state: "enabled" });
  });

  it("the production-shaped env (AGENT_CAPABILITIES_DISABLED explicitly empty, #3727) is active", () => {
    const a = resolveStockCopilotVoiceActivation({
      sourceTab: STOCK_COPILOT_VOICE_SOURCE_TAB,
      env: { AGENT_CAPABILITIES_DISABLED: "" },
    });
    expect(a).toEqual({ active: true, state: "enabled" });
  });

  it("turns without the stock context are not activated by this slice", () => {
    for (const sourceTab of ["Chat & Agents", "E*TRADE · Auto Options Research", undefined]) {
      const a = resolveStockCopilotVoiceActivation({ sourceTab, env: {} });
      expect(a.active, `sourceTab ${String(sourceTab)}`).toBe(false);
    }
  });

  it("withdrawing the declaration through the machinery's own override withdraws the activation", () => {
    const a = resolveStockCopilotVoiceActivation({
      sourceTab: STOCK_COPILOT_VOICE_SOURCE_TAB,
      env: { AGENT_CAPABILITIES_DISABLED: "OrchestratorAgent:voice" },
    });
    expect(a).toEqual({ active: false, state: "disabled-by-config" });
  });
});

/* ------------------------------------------------------------------ */
/* 3. The desk gate composition (route drive)                          */
/* ------------------------------------------------------------------ */

interface RouteDrive {
  ctx: TradingIntegrationsRouteContext;
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
}

function makeRouteDrive(envExtra: Record<string, unknown> = {}): RouteDrive {
  const audits: RouteDrive["audits"] = [];
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema("session-3720");
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
  } as unknown as TradingIntegrationsRouteContext;
  return { ctx, audits };
}

function voiceRequest(body: Record<string, unknown>): Request {
  return new Request(`https://agent.internal${VOICE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-login": LOGIN },
    body: JSON.stringify(body),
  });
}

async function driveVoiceTurn(drive: RouteDrive, body: Record<string, unknown>) {
  return handleTradingIntegrationsRoutes(
    voiceRequest(body),
    new URL(`https://agent.internal${VOICE_PATH}`),
    VOICE_PATH,
    "session-3720",
    drive.ctx,
  );
}

describe("issue #3720 — the voice desk serves the Stock Copilot's tenant under the activation", () => {
  it("an Alpaca tenant's stock-context voice turn is SERVED by the desk (normalized, answered, audited with the resolved broker)", async () => {
    const drive = makeRouteDrive();
    // "um" is stripped by the desk's own normalizer, leaving the
    // single-word capabilities prompt — the turn never reaches NLQ.
    const res = await driveVoiceTurn(drive, {
      transcript: "um help",
      sourceTab: STOCK_COPILOT_VOICE_SOURCE_TAB,
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as VoiceTradingTurnResponse;
    expect(body.actionType).toBe("capabilities");
    const turnAudit = drive.audits.find((a) => a.type === "trading.voice_turn");
    expect(turnAudit?.payload.copilotBrokerId).toBe("alpaca");
    expect(turnAudit?.payload.sourceTab).toBe(STOCK_COPILOT_VOICE_SOURCE_TAB);
  });

  it("the same tenant WITHOUT the copilot context is refused exactly as today (#3429 unchanged)", async () => {
    const drive = makeRouteDrive();
    const res = await driveVoiceTurn(drive, { transcript: "help" });
    expect(res!.status).toBe(501);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe(CHANNEL_BROKER_UNAVAILABLE);
  });

  it("a withdrawn activation is audited, never silent — and the refusal stands", async () => {
    const drive = makeRouteDrive({
      AGENT_CAPABILITIES_DISABLED: "OrchestratorAgent:voice",
    });
    const res = await driveVoiceTurn(drive, {
      transcript: "help",
      sourceTab: STOCK_COPILOT_VOICE_SOURCE_TAB,
    });
    expect(res!.status).toBe(501);
    const inactive = drive.audits.find(
      (a) => a.type === "stock_copilot.voice_inactive",
    );
    expect(inactive?.payload.state).toBe("disabled-by-config");
  });

  it("an unresolved copilot selection fails closed: the refusal stands", async () => {
    state.commercialBound = false;
    const drive = makeRouteDrive();
    const res = await driveVoiceTurn(drive, {
      transcript: "help",
      sourceTab: STOCK_COPILOT_VOICE_SOURCE_TAB,
    });
    expect(res!.status).toBe(501);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe(CHANNEL_BROKER_UNAVAILABLE);
  });

  it("an E*TRADE tenant's stock-context turn is served as today, carrying the resolved broker", async () => {
    state.tenantBroker = "etrade";
    state.storedBroker = "etrade";
    const drive = makeRouteDrive();
    const res = await driveVoiceTurn(drive, {
      transcript: "help",
      sourceTab: STOCK_COPILOT_VOICE_SOURCE_TAB,
    });
    expect(res!.status).toBe(200);
    const turnAudit = drive.audits.find((a) => a.type === "trading.voice_turn");
    expect(turnAudit?.payload.copilotBrokerId).toBe("etrade");
  });

  it("the greeting path is NOT lifted for a non-E*TRADE tenant (the lift is the turn path only)", async () => {
    const drive = makeRouteDrive();
    const res = await handleTradingIntegrationsRoutes(
      new Request("https://agent.internal/trading/voice/greeting", {
        method: "GET",
        headers: { "x-user-login": LOGIN },
      }),
      new URL("https://agent.internal/trading/voice/greeting"),
      "/trading/voice/greeting",
      "session-3720",
      drive.ctx,
    );
    expect(res!.status).toBe(501);
  });
});

/* ------------------------------------------------------------------ */
/* 4. The execution invariant at the desk's approval leg               */
/* ------------------------------------------------------------------ */

describe("issue #3720 — voice order execution stays E*TRADE-only until the neutral desk (#3556)", () => {
  const mockEnv = {
    APP_BASE_URL: "https://agent.openaimp.com",
    AI_SEARCH_ENDPOINT: "https://ai-search.internal",
    ORCHESTRATOR_AGENT: {} as never,
    ETRADE_ENVIRONMENT: "sandbox",
  } as unknown as Env;

  function makeService(): ETradeVoiceTradingService {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("session-3720");
    return new ETradeVoiceTradingService(mockEnv, orm, "session-3720");
  }

  it("an approval under a resolved non-E*TRADE copilot broker is refused by name and nothing executes", async () => {
    const placeOrder = vi
      .spyOn(ETradeRestClient.prototype, "placeOrder")
      .mockImplementation(async () => {
        throw new Error("placeOrder must not be reached");
      });
    const service = makeService();
    const res = await service.processVoiceTurn({
      transcript: "confirm order ord_123456",
      userLogin: LOGIN,
      copilotBrokerId: "alpaca",
    });
    expect(res.success).toBe(false);
    expect(res.actionType).toBe("error");
    expect(res.spokenText).toContain("Alpaca");
    // The spoken form is pronunciation-tuned (the tuner strips the
    // markdown `*`); the display form keeps the broker's name intact.
    expect(res.spokenText).toContain("ETRADE");
    expect(res.displayMarkdown).toContain("Alpaca");
    expect(res.displayMarkdown).toContain("E*TRADE");
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("without the carrier the approval leg behaves exactly as today (no copilot refusal)", async () => {
    const placeOrder = vi
      .spyOn(ETradeRestClient.prototype, "placeOrder")
      .mockImplementation(async () => {
        throw new Error("placeOrder must not be reached");
      });
    const service = makeService();
    const res = await service.processVoiceTurn({
      transcript: "confirm order ord_123456",
      userLogin: LOGIN,
    });
    // No draft exists, so today's desk answers with its own
    // nothing-to-approve outcome — never the copilot broker refusal.
    expect(res.spokenText).not.toContain("executes orders on E*TRADE");
    expect(placeOrder).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* 5. The carrier chain: WS frame → forwarder → DO body                */
/* ------------------------------------------------------------------ */

describe("issue #3720 — the copilot context rides the existing voice path", () => {
  it("the #815 forwarder carries the turn's sourceTab into the DO request body", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const namespace = {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (req: Request) => {
          expect(id).toBe(LOGIN);
          captured.body = (await req.json()) as Record<string, unknown>;
          return Response.json({
            success: true,
            spokenText: "ok",
            displayMarkdown: "ok",
            actionType: "capabilities",
            proposerDid: "did:agent:openaimp:trading",
            timestamp: new Date().toISOString(),
          } satisfies VoiceTradingTurnResponse);
        },
      }),
    };
    const forward = createOrchestratorVoiceTurnForwarder(
      { ORCHESTRATOR_AGENT: namespace } as unknown as Env,
      LOGIN,
    );
    const out = await forward({
      transcript: "quote AAPL",
      sourceTab: STOCK_COPILOT_VOICE_SOURCE_TAB,
    });
    expect(out.success).toBe(true);
    expect(captured.body).toMatchObject({
      transcript: "quote AAPL",
      sourceTab: STOCK_COPILOT_VOICE_SOURCE_TAB,
    });
  });

  it("a WebSocket turn frame's sourceTab reaches the forwarder's turn request", async () => {
    const seen: Array<{ sourceTab?: string; transcript?: string }> = [];
    const forwardTurn: VoiceTurnForwarder = async (req) => {
      seen.push({ sourceTab: req.sourceTab, transcript: req.transcript });
      return {
        success: true,
        spokenText: "desk summary",
        displayMarkdown: "desk summary",
        actionType: "capabilities",
        proposerDid: "did:agent:openaimp:trading",
        timestamp: new Date().toISOString(),
      };
    };
    const listeners: Record<string, Array<(e: { data: string }) => Promise<void>>> = {};
    const sent: string[] = [];
    const ws = {
      addEventListener: (event: string, cb: (e: { data: string }) => Promise<void>) => {
        (listeners[event] ??= []).push(cb);
      },
      send: (data: string) => sent.push(data),
      close: () => undefined,
    };
    await handleVoiceWebSocketConnection(
      ws as never,
      {} as Env,
      undefined,
      LOGIN,
      forwardTurn,
    );
    for (const cb of listeners["message"] ?? []) {
      await cb({
        data: JSON.stringify({
          type: "turn",
          transcript: "help",
          sourceTab: STOCK_COPILOT_VOICE_SOURCE_TAB,
        }),
      });
    }
    expect(seen).toEqual([
      { sourceTab: STOCK_COPILOT_VOICE_SOURCE_TAB, transcript: "help" },
    ]);
    const frames = sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(frames.some((f) => f.type === "assistant_turn")).toBe(true);
  });
});
