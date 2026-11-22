/**
 * Issue #1236 (epic #1151 remainder): discovery notifications as NEW
 * feature work (owner decisions 2026-10-25 16:14 EDT option (b) +
 * 16:30 EDT full surface + recommendations 1-4 approved; design
 * comment 6402669389).
 *
 * RED first: discovery chains still carry deliverViaChain: false, the
 * discovery options carry no channel fields, the schedule schema
 * rejects delivery fields for discovery, and the chain text carries
 * no draft footer. The planner itself needs no change — the bridge
 * outcome is what flips.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM } from "../src/orm";
import { upsertAccountBinding } from "../src/services/accountBindings";

// Issue #5100 (F3 of #5094): the NLQ arm resolves the tenant's broker
// selection server-side before stamping the binding tuple. The test
// tenant selects Alpaca paper; the binding is seeded per test below
// (see seedNlqBindings). Only resolveScreenSelection is stubbed.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    resolveScreenSelection: async () => ({
      resolved: true,
      selection: {
        connectionId: "alpaca:TEST:discnotif_nlq_user",
        brokerId: "alpaca",
        environment: "TEST",
        mode: "paper",
        externalAccountId: "PA-900",
      },
    }),
  };
});

/** The #5112 in-memory DO-namespace stub, for seeding NLQ bindings. */
function makeMemoryDoNamespace() {
  const store = new Map<string, string>();
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const payload = (await request.json()) as { op: string; key: string; value?: string };
      if (payload.op === "get") {
        return Response.json({ ok: true, value: store.get(payload.key) ?? null });
      }
      if (payload.op === "put" && payload.value !== undefined) {
        store.set(payload.key, payload.value);
        return Response.json({ ok: true });
      }
      if (payload.op === "delete") {
        store.delete(payload.key);
        return Response.json({ ok: true });
      }
      return new Response("Bad request", { status: 400 });
    },
  };
  return {
    idFromName: () => "singleton" as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  };
}

async function seedNlqBindings(env: any, login: string): Promise<void> {
  for (const binding of [
    { broker: "alpaca", mode: "paper", accountType: "stock", scope: "tenant", accountId: "PA-900" },
    { broker: "alpaca", mode: "paper", accountType: "options", scope: "tenant", accountId: "PA-900" },
  ] as const) {
    await upsertAccountBinding(env as never, login, binding);
  }
}

// The NLQ executor's module graph reaches the orchestrator, which
// extends AIChatAgent from @cloudflare/ai-chat — unresolvable under
// the node test loader (same pattern as screening_schema_parity).
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
import {
  executeNLQQueryAsync,
  type NLQPlan,
  type NLQSchedulingPort,
} from "../src/agents/nlq";
import type { AgentScheduleItem } from "../src/types";
import { buildScheduleSubmission } from "../src/client/scheduledOptionsManager/payloadBuilders";
import { blankDiscoveryRequestDraft } from "../src/client/ScheduledOptionsManager";
import type { ScheduleFormState } from "../src/client/scheduledOptionsManager/types";
import {
  planDeliveryFollowups,
  plannedDeliveryChannels,
  resolveScreenerFollowupConfig,
  followupDeliveryEmailSubject,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import { followupDeliveryText } from "../src/services/screenerFollowupDelivery";
import {
  buildDiscoveryDeliveryOutcome,
  discoveryDeliveryOpportunities,
} from "../src/services/scheduledTasks";
import {
  deliverDiscoveryDirect,
  SCREENING_DRAFT_FOOTER,
} from "../src/services/screeningDelivery";
import { buildSchedulePayload } from "../src/trading/screeningSchemas";
import type { DiscoverySymbolOutcome } from "../src/trading";

const CHAIN = { serveDelaySeconds: 60, deliverDelaySeconds: 3600 };
const NOW = "2026-10-25T00:00:00.000Z";

/** Config with NO env channels: only per-task recipients may plan. */
function bareConfig() {
  return resolveScreenerFollowupConfig({});
}

function discoveryOutcome(overrides: Partial<ScreenerRunOutcome> = {}): ScreenerRunOutcome {
  return {
    kind: "discovery",
    trigger: "scheduled",
    success: true,
    pdfKeys: [],
    canonicalReportId: "rep-d-1",
    thesis: "Strategy discovery (saved-request) — NVDA",
    summary: "Strategy discovery (saved-request) completed: 1 of 1 requests produced results.",
    matchedCount: 1,
    totalScanned: 1,
    ...overrides,
  } as ScreenerRunOutcome;
}

function rankedOutcome(symbol: string, label: string, price: number): DiscoverySymbolOutcome {
  return {
    symbol,
    status: "completed",
    ranked: [{ candidate: { label, underlyingPrice: price } }],
    bestTrade: { best: { candidate: { label, underlyingPrice: price } } },
  } as unknown as DiscoverySymbolOutcome;
}

describe("discovery chain deliver planning (#1236)", () => {
  it("plans real deliveries (no skipReason) for a serve-verified canonical discovery result with named channels", () => {
    const outcome = discoveryOutcome({
      deliverViaChain: true,
      stageChain: CHAIN,
      emailTo: "owner@example.com",
      slackChannel: "C123",
      webhookUrl: "https://example.com/hook",
      deliveryChannels: ["slack", "email", "webhook"],
    });
    const specs = planDeliveryFollowups(
      outcome,
      bareConfig(),
      { status: "ready", artifacts: [], canonicalReportId: "rep-d-1" },
      "main-d-1",
      "alice",
      { chainId: "chain-d-1", nowIso: NOW },
    );
    // CHANNEL_ORDER is slack, email, webhook; the allowlist keeps all
    // three because the task named all three — and NO env channel is
    // added (bareConfig configures none).
    expect(specs.map((s) => s.channel)).toEqual(["slack", "email", "webhook"]);
    for (const spec of specs) {
      expect(spec.payload.skipReason).toBeUndefined();
      expect(spec.stage).toBe("deliver");
      expect(spec.chainId).toBe("chain-d-1");
      expect(spec.runAt).toBe("2026-10-25T01:00:00.000Z");
      expect(spec.parentJobId).toBe("main-d-1");
    }
  });

  it("plans nothing when the task names no channels (empty allowlist), even with a canonical row", () => {
    const outcome = discoveryOutcome({
      deliverViaChain: true,
      stageChain: CHAIN,
      deliveryChannels: [],
    });
    expect(planDeliveryFollowups(
      outcome,
      bareConfig(),
      { status: "ready", artifacts: [], canonicalReportId: "rep-d-1" },
      "main-d-2",
      "alice",
      { chainId: "chain-d-2", nowIso: NOW },
    )).toEqual([]);
  });

  it("per-task recipients count without any env channel configured", () => {
    const outcome = discoveryOutcome({
      emailTo: "owner@example.com",
      slackChannel: "C123",
      webhookUrl: "https://example.com/hook",
      deliveryChannels: ["slack", "email", "webhook"],
    });
    expect(plannedDeliveryChannels(outcome, bareConfig())).toEqual(["slack", "email", "webhook"]);
  });

  it("empty allowlist plans nothing even when overrides are present", () => {
    const outcome = discoveryOutcome({
      emailTo: "owner@example.com",
      slackChannel: "C123",
      deliveryChannels: [],
    });
    expect(plannedDeliveryChannels(outcome, bareConfig())).toEqual([]);
  });
});

describe("discovery delivery text + subject (#1236)", () => {
  it("chain/direct text for discovery carries the draft footer; other kinds are unchanged", () => {
    const text = followupDeliveryText(discoveryOutcome({
      opportunities: [{ symbol: "NVDA", signal: "Bull Call Spread", lastPrice: 187.5 }],
      reportUrl: "/api/etrade/options/discovery-runs/run-1",
    }));
    expect(text).toContain("Discovery screen");
    expect(text).toContain("Bull Call Spread");
    expect(text).toContain("📄 Report: /api/etrade/options/discovery-runs/run-1");
    expect(text.endsWith(SCREENING_DRAFT_FOOTER)).toBe(true);

    const stockText = followupDeliveryText({
      kind: "stock",
      trigger: "scheduled",
      success: true,
      pdfKeys: [],
      universe: "NASDAQ100",
    } as ScreenerRunOutcome);
    expect(stockText.endsWith(SCREENING_DRAFT_FOOTER)).toBe(false);
  });

  it("email subject names Discovery for discovery outcomes and preserves the others", () => {
    expect(followupDeliveryEmailSubject(discoveryOutcome({}))).toContain("Discovery");
    expect(followupDeliveryEmailSubject({
      kind: "stock", trigger: "scheduled", success: true, pdfKeys: [],
    } as ScreenerRunOutcome)).toContain("Stock");
    expect(followupDeliveryEmailSubject({
      kind: "options", trigger: "scheduled", success: true, pdfKeys: [],
    } as ScreenerRunOutcome)).toContain("Options");
    // Goal keeps today's subject (the else branch) — this PR does not
    // change goal behavior.
    expect(followupDeliveryEmailSubject({
      kind: "goal", trigger: "scheduled", success: true, pdfKeys: [],
    } as ScreenerRunOutcome)).toContain("Options");
  });
});

describe("discovery opportunity mapping (#1236)", () => {
  it("prefers the best trade, falls back to the top ranked strategy, skips failed/abstained, caps at 10", () => {
    const outcomes = [
      rankedOutcome("NVDA", "Bull Call Spread", 187.5),
      {
        symbol: "AAPL",
        status: "completed",
        ranked: [{ candidate: { label: "Iron Condor", underlyingPrice: 250 } }],
      } as unknown as DiscoverySymbolOutcome,
      { symbol: "MSFT", status: "failed", error: "no chain" } as unknown as DiscoverySymbolOutcome,
      {
        symbol: "TSLA",
        status: "completed",
        abstained: true,
        ranked: [],
      } as unknown as DiscoverySymbolOutcome,
      ...Array.from({ length: 12 }, (_, i) => rankedOutcome(`SYM${i}`, `Strategy ${i}`, 10 + i)),
    ];
    const opps = discoveryDeliveryOpportunities(outcomes);
    expect(opps).toHaveLength(10);
    expect(opps[0]).toEqual({ symbol: "NVDA", signal: "Bull Call Spread", lastPrice: 187.5 });
    expect(opps[1]).toEqual({ symbol: "AAPL", signal: "Iron Condor", lastPrice: 250 });
    expect(opps.some((o) => o.symbol === "MSFT" || o.symbol === "TSLA")).toBe(false);
  });

  it("maps no-view best/ranked candidates the same way", () => {
    const outcomes = [{
      symbol: "NVDA",
      status: "completed",
      rankedNoView: [{ candidate: { label: "NoView Condor", underlyingPrice: 99 } }],
      bestNoViewTrade: { best: { candidate: { label: "NoView Condor", underlyingPrice: 99 } } },
    } as unknown as DiscoverySymbolOutcome];
    expect(discoveryDeliveryOpportunities(outcomes)).toEqual([
      { symbol: "NVDA", signal: "NoView Condor", lastPrice: 99 },
    ]);
  });
});

describe("discovery delivery outcome builder (#1236)", () => {
  const base = {
    runId: "run-1",
    status: "completed" as const,
    inputModel: "saved-request",
    symbols: ["NVDA"],
    summary: "Strategy discovery (saved-request) completed: 1 of 1 requests produced results.",
    trigger: "scheduled" as const,
    matchedCount: 1,
    totalScanned: 1,
    outcomes: [rankedOutcome("NVDA", "Bull Call Spread", 187.5)],
    reportId: "rep-d-1",
  };

  it("chain mode flips deliverViaChain with recipients + allowlist + enrichment + canonical link", () => {
    const outcome = buildDiscoveryDeliveryOutcome({
      ...base,
      chainMode: true,
      stageChain: CHAIN,
      emailTo: "owner@example.com",
      slackChannel: "C123",
      webhookUrl: "https://example.com/hook",
    });
    expect(outcome.kind).toBe("discovery");
    expect(outcome.deliverViaChain).toBe(true);
    expect(outcome.stageChain).toEqual(CHAIN);
    expect(outcome.emailTo).toBe("owner@example.com");
    expect(outcome.slackChannel).toBe("C123");
    expect(outcome.webhookUrl).toBe("https://example.com/hook");
    expect(outcome.deliveryChannels).toEqual(["slack", "email", "webhook"]);
    expect(outcome.canonicalReportId).toBe("rep-d-1");
    expect(outcome.reportUrl).toBe("/api/etrade/options/discovery-runs/run-1");
    expect(outcome.matchedCount).toBe(1);
    expect(outcome.totalScanned).toBe(1);
    expect(outcome.opportunities).toEqual([{ symbol: "NVDA", signal: "Bull Call Spread", lastPrice: 187.5 }]);
  });

  it("chain mode with no channels named plans nothing: empty allowlist, deliverViaChain still true", () => {
    const outcome = buildDiscoveryDeliveryOutcome({ ...base, chainMode: true, stageChain: CHAIN });
    expect(outcome.deliverViaChain).toBe(true);
    expect(outcome.deliveryChannels).toEqual([]);
    expect(outcome.emailTo).toBeUndefined();
  });

  it("direct mode carries the same content with deliverViaChain false and no allowlist/stageChain", () => {
    const outcome = buildDiscoveryDeliveryOutcome({
      ...base,
      chainMode: false,
      emailTo: "owner@example.com",
      slackChannel: "C123",
    });
    expect(outcome.deliverViaChain).toBe(false);
    expect(outcome.deliveryChannels).toBeUndefined();
    expect(outcome.stageChain).toBeUndefined();
    expect(outcome.emailTo).toBe("owner@example.com");
    expect(outcome.reportUrl).toBe("/api/etrade/options/discovery-runs/run-1");
    expect(outcome.opportunities).toHaveLength(1);
  });
});

describe("discovery schedule payload delivery fields (#1236)", () => {
  const discoveryCriteria = {
    requests: [{
      symbol: "NVDA",
      thesis: "bullish",
      targetPrice: 210,
      targetDate: "2027-01-15",
      expectedIvDirection: "rise",
      maxPlannedLoss: 750,
      minRewardRisk: 1.8,
      allowedStrategies: ["bull_call_spread"],
      minDte: 20,
      maxDte: 60,
    }],
  };

  it("accepts emailTo/slackChannel/webhookUrl on discovery schedules and carries them", () => {
    const built = buildSchedulePayload("autonomousStrategyDiscovery", {
      ...discoveryCriteria,
      emailTo: "owner@example.com",
      slackChannel: "C123",
      webhookUrl: "https://example.com/hook",
    }, { userLogin: "alice", trigger: "scheduled" });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value.emailTo).toBe("owner@example.com");
      expect(built.value.slackChannel).toBe("C123");
      expect(built.value.webhookUrl).toBe("https://example.com/hook");
    }
  });

  it("still rejects unknown fields on discovery schedules (strict schema)", () => {
    const built = buildSchedulePayload("autonomousStrategyDiscovery", {
      ...discoveryCriteria,
      pushToSlack: true,
    }, { userLogin: "alice", trigger: "scheduled" });
    expect(built.ok).toBe(false);
  });
});

describe("discovery direct delivery helper (#1236)", () => {
  function fakePort() {
    const deliver = vi.fn(async () => ({ ok: true as const }));
    return { deliver, notify: vi.fn() };
  }

  function outcomeWithChannels(overrides: Partial<ScreenerRunOutcome> = {}) {
    return discoveryOutcome({
      emailTo: "owner@example.com",
      slackChannel: "C123",
      webhookUrl: "https://example.com/hook",
      ...overrides,
    });
  }

  it("sends on exactly the named channels, in CHANNEL_ORDER, and never throws on a channel failure", async () => {
    const port = fakePort();
    port.deliver.mockRejectedValueOnce(new Error("slack boom"));
    const results = await deliverDiscoveryDirect({
      port,
      outcome: outcomeWithChannels(),
      config: bareConfig(),
      userLogin: "alice",
    });
    expect(port.deliver).toHaveBeenCalledTimes(3);
    expect(port.deliver.mock.calls.map((c) => (c[0] as { channel: string }).channel))
      .toEqual(["slack", "email", "webhook"]);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ channel: "slack", ok: false, error: "slack boom" });
    expect(results[1].ok).toBe(true);
    expect(results[2].ok).toBe(true);
  });

  it("blocks email on allowlist violation (FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED) without calling the port, other channels still send", async () => {
    const port = fakePort();
    const config = resolveScreenerFollowupConfig({ SCREENER_EMAIL_ALLOWLIST: "owner@example.com" });
    const results = await deliverDiscoveryDirect({
      port,
      outcome: outcomeWithChannels({ emailTo: "other@example.com" }),
      config,
      userLogin: "alice",
    });
    expect(port.deliver).toHaveBeenCalledTimes(2);
    expect(port.deliver.mock.calls.map((c) => (c[0] as { channel: string }).channel))
      .toEqual(["slack", "webhook"]);
    const emailResult = results.find((r) => r.channel === "email")!;
    expect(emailResult.ok).toBe(false);
    expect(emailResult.error).toContain("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");
  });

  it("sends nothing and returns [] when the task names no channels", async () => {
    const port = fakePort();
    const results = await deliverDiscoveryDirect({
      port,
      outcome: discoveryOutcome(),
      config: bareConfig(),
      userLogin: "alice",
    });
    expect(results).toEqual([]);
    expect(port.deliver).not.toHaveBeenCalled();
  });
});

describe("discovery panel schedule payload delivery fields (#1236)", () => {
  const baseForm: ScheduleFormState = {
    jobType: "strategyDiscovery",
    targetSymbols: "",
    maxItems: 100,
    targetUniverse: "NASDAQ100",
    sector: "Technology",
    minPrice: "",
    maxPrice: "",
    minMarketCap: "",
    maxPe: "",
    trendFilter: "",
    scheduleType: "interval",
    intervalSeconds: 3600,
    cronExpression: "30 13 * * 1-5",
    delaySeconds: 1800,
    scheduledDate: "",
    thesis: "bullish",
    riskProfile: "balanced",
    pushToSlack: true,
    slackChannel: "#options-alerts",
    emailTo: "owner@example.com",
    webhookUrl: "https://example.com/hook",
    discoveryRequests: [
      { ...blankDiscoveryRequestDraft(), symbol: "NVDA", targetPrice: "200", targetDate: "2027-12-18", maxPlannedLoss: "500", minRewardRisk: "1" },
    ],
    discoveryInputModel: "saved-request",
    derivedSource: "symbols",
    derivedSymbolsText: "",
    derivedWatchlistName: "",
    derivedProfileId: "",
    noViewDraft: {
      symbolsText: "",
      maxPlannedLoss: "",
      minRewardRisk: "",
      minProbabilityOfProfit: "",
      minDte: "",
      maxDte: "",
      riskProfile: "balanced",
    } as any,
    environment: "TEST",
  };

  function payload(form: ScheduleFormState): Record<string, any> {
    const built = buildScheduleSubmission(form);
    if ("error" in built) throw new Error(`unexpected builder error: ${built.error}`);
    return (built.requestBody as any).payload;
  }

  it("carries emailTo/slackChannel/webhookUrl on discovery schedules when named", () => {
    const p = payload(baseForm);
    expect(p.emailTo).toBe("owner@example.com");
    expect(p.slackChannel).toBe("#options-alerts");
    expect(p.webhookUrl).toBe("https://example.com/hook");
  });

  it("omits slackChannel when the push checkbox is off, keeps email/webhook", () => {
    const p = payload({ ...baseForm, pushToSlack: false });
    expect(p.slackChannel).toBeUndefined();
    expect(p.emailTo).toBe("owner@example.com");
    expect(p.webhookUrl).toBe("https://example.com/hook");
  });

  it("carries no delivery keys when the task names no channels", () => {
    const p = payload({ ...baseForm, pushToSlack: false, emailTo: "", webhookUrl: "" });
    expect("slackChannel" in p).toBe(false);
    expect("emailTo" in p).toBe(false);
    expect("webhookUrl" in p).toBe(false);
  });
});

describe("NLQ discovery schedule delivery fields (#1236)", () => {
  class FakeSchedulingPort implements NLQSchedulingPort {
    calls: Array<{ method: string; args: unknown[] }> = [];
    private seq = 0;
    async schedule(when: Date | string | number, callback: string, payload?: unknown, options?: { idempotent?: boolean }): Promise<AgentScheduleItem> {
      this.calls.push({ method: "schedule", args: [when, callback, payload, options] });
      return { id: `fake-${++this.seq}`, callback, payload, type: "scheduled", time: 0 } as AgentScheduleItem;
    }
    async scheduleEvery(intervalSeconds: number, callback: string, payload?: unknown): Promise<AgentScheduleItem> {
      this.calls.push({ method: "scheduleEvery", args: [intervalSeconds, callback, payload] });
      return { id: `fake-${++this.seq}`, callback, payload, type: "interval", intervalSeconds, time: 0 } as AgentScheduleItem;
    }
    async cancelSchedule(_id: string): Promise<boolean> {
      return false;
    }
    async listSchedules(): Promise<AgentScheduleItem[]> {
      return [];
    }
  }

  const sessionId = "discnotif_nlq_user";
  const nlqSessionNs = makeMemoryDoNamespace();
  const env = {
    APP_ENV: "TEST",
    // Issue #4249: these tests drive the NLQ scheduling entry
    // point, so the NLQ channel is explicitly on here (its default
    // is OFF — unconfigured NLQ scheduling refuses FEATURE_DISABLED).
    FEATURE_SCHEDULE_NLQ: "1",
    // Issue #5100 (F3 of #5094): the binding store for the NLQ arm.
    SESSION_STORE: nlqSessionNs,
  } as any;
  let orm: DatabaseORM;
  beforeEach(async () => {
    orm = new DatabaseORM(new MockSqlStorage() as any);
    await seedNlqBindings(env, sessionId);
  });

  it("NLQ discovery schedules carry the per-task recipients through to the armed payload", async () => {
    const port = new FakeSchedulingPort();
    const plan: NLQPlan = {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "interval",
        intervalSeconds: 3600,
        callback: "autonomousStrategyDiscovery",
        description: "NLQ discovery with notifications",
        requests: [{
          symbol: "NVDA",
          thesis: "bullish",
          targetPrice: 210,
          targetDate: "2027-01-15",
          expectedIvDirection: "rise",
          maxPlannedLoss: 750,
          minRewardRisk: 1.8,
          allowedStrategies: ["bull_call_spread"],
          minDte: 20,
          maxDte: 60,
        }],
        emailTo: "owner@example.com",
        slackChannel: "C123",
        webhookUrl: "https://example.com/hook",
      } as NLQPlan["scheduleData"],
    };
    const result = await executeNLQQueryAsync(orm, sessionId, plan, env, sessionId, undefined, {
      schedulingPort: port,
    });
    expect(result.status).toBe("scheduled");
    expect(port.calls).toHaveLength(1);
    const armed = port.calls[0].args[2] as Record<string, unknown>;
    expect(armed.emailTo).toBe("owner@example.com");
    expect(armed.slackChannel).toBe("C123");
    expect(armed.webhookUrl).toBe("https://example.com/hook");
  });

  it("NLQ market screens do NOT pick up delivery fields (discovery-only gate)", async () => {
    const port = new FakeSchedulingPort();
    const plan: NLQPlan = {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "interval",
        intervalSeconds: 3600,
        callback: "autonomousMarketScreen",
        description: "NLQ market screen naming recipients",
        universe: "NASDAQ100",
        emailTo: "owner@example.com",
      } as NLQPlan["scheduleData"],
    };
    const result = await executeNLQQueryAsync(orm, sessionId, plan, env, sessionId, undefined, {
      schedulingPort: port,
    });
    expect(result.status).toBe("scheduled");
    expect(port.calls).toHaveLength(1);
    const armed = port.calls[0].args[2] as Record<string, unknown>;
    expect("emailTo" in armed).toBe(false);
  });
});
