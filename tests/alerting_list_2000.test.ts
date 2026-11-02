/**
 * Issue #2000 Phase 5 slice 7 — the five-item alerting list.
 *
 * One coherent inventory (single source of truth: id, signal,
 * runbook link, delivery channel, claim semantics) over the
 * machinery slices 1, 2, and 6 established — DLQ depth, breaker
 * trips, stuck rows — plus the two signals built in-slice:
 * monolithic serve-stage failures and gather misses.
 *
 * Working defaults (NOT rulings), pinned here:
 * - Serve-stage failure = a followup.report job (the serve
 *   stage) reaching terminal `failed` WITHOUT chain identity.
 *   Chained serve failures never alert (visible in the stage
 *   feed + retryable per stage via retryAsyncJob); a retry's
 *   own failure never re-alerts (the incident was alerted on
 *   the original failure).
 * - Gather miss (event) = a gather run with missingSymbols > 0
 *   (any symbol requested but not stored, per the #2056 rule:
 *   live alone supplies rows, Yahoo-only never stores).
 * - Gather-miss alert = TOTAL miss only: requested > 0 and
 *   stored === 0. A partial miss is event-visible, not paged.
 * - Non-misses: a legitimately empty universe (requested 0)
 *   emits no event and no alert; a Yahoo-column-only gap
 *   (live rows exist, Yahoo complemented columns) is success,
 *   not a miss.
 */
import { describe, expect, it, vi } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  ALERTING_ITEMS,
  gatherMissText,
  isGatherMiss,
  maybeAlertServeFailure,
  serveStageFailureText,
  shouldAlertGatherMiss,
  shouldAlertServeFailure,
  type ServeFailureJob,
} from "../src/observability/alertingList";
import {
  foldEnvelopeToEvent,
} from "../src/observability/observabilityPorts";
import type { MessageEnvelope } from "../src/messaging/messagingPorts";
import { createGoalGatherEnrichment } from "../src/services/goalGather";
import type { ETradeQuote } from "../src/types";

function serveJob(over: Partial<ServeFailureJob>): ServeFailureJob {
  return {
    jobId: "job-serve-1",
    capability: "followup.report",
    stage: null,
    chainId: null,
    retryOf: null,
    userLogin: "tester",
    error: "report render failed: boom",
    ...over,
  };
}

function gatherEnvelope(over: Record<string, unknown>): MessageEnvelope {
  return {
    specversion: "1.0",
    id: "evt-gather-miss-1",
    source: "test",
    time: "2026-11-02T00:00:00.000Z",
    type: "goal.gather.missed",
    data: {},
    ...over,
  } as MessageEnvelope;
}

function mapBlobStorage() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async <T,>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
      put: async (key: string, value: unknown): Promise<void> => {
        store.set(key, value);
      },
    },
  };
}

function listing(symbol: string): ETradeQuote {
  return {
    symbol,
    companyName: `${symbol} Corp`,
    lastPrice: 100,
    change: 1,
    changePercent: 1,
    bid: 99,
    ask: 101,
    volume: 500_000,
    open: 99,
    high: 101,
    low: 98,
    timestamp: "2026-10-27T00:00:00.000Z",
  };
}

function served(symbol: string, source: string): ETradeQuote {
  return {
    ...listing(symbol),
    lastPrice: 150,
    change: 3,
    changePercent: 2,
    volume: 2_000_000,
    open: 147,
    high: 151,
    low: 146,
    source,
    quoteStatus: "LIVE",
    timestamp: "2026-10-27T00:00:00.000Z",
  };
}

const ROUTES = [
  {
    capability: "quotes",
    primaryProviderId: "etrade",
    gapFillProviderId: "yahoo",
    minTier: "freemium",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    capability: "historicalBars",
    primaryProviderId: "yahoo",
    gapFillProviderId: null,
    minTier: "freemium",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
] as any;

describe("alerting list inventory (#2000 slice 7)", () => {
  it("lists exactly the five items, each with a runbook link and the postSlackText channel", () => {
    expect(ALERTING_ITEMS.map((i) => i.id)).toEqual([
      "dlq-depth",
      "breaker-trip",
      "stuck-row",
      "serve-stage-failure",
      "gather-miss",
    ]);
    for (const item of ALERTING_ITEMS) {
      expect(item.runbook).toMatch(/^docs\/operations\/runbook\//);
      expect(item.delivery).toBe("postSlackText");
      expect(item.claim.length).toBeGreaterThan(0);
      expect(item.signal.length).toBeGreaterThan(0);
    }
  });
});

describe("serve-stage failure definition (#2000 slice 7)", () => {
  it("alerts on a monolithic serve failure (followup.report, no chain)", () => {
    expect(shouldAlertServeFailure(serveJob({}))).toBe(true);
  });

  it("does not alert on a chained serve failure (stage + chain identity)", () => {
    expect(
      shouldAlertServeFailure(serveJob({ stage: "serve", chainId: "chain-1" })),
    ).toBe(false);
  });

  it("does not alert on a retry's own failure (incident already alerted)", () => {
    expect(shouldAlertServeFailure(serveJob({ retryOf: "job-serve-0" }))).toBe(false);
  });

  it("does not alert on non-serve capabilities", () => {
    expect(shouldAlertServeFailure(serveJob({ capability: "followup.deliver" }))).toBe(false);
    expect(shouldAlertServeFailure(serveJob({ capability: "http.request" }))).toBe(false);
  });

  it("alert text carries job id + runbook link, never the error message", () => {
    const text = serveStageFailureText(serveJob({}));
    expect(text).toContain("job-serve-1");
    expect(text).toContain("docs/operations/runbook/alerting.md#serve-stage-failures");
    expect(text).not.toContain("boom");
  });

  it("handler records the failure state and posts for a first monolithic failure", async () => {
    const transitions: unknown[] = [];
    const audits: Array<{ type: string }> = [];
    const posts: string[] = [];
    const out = await maybeAlertServeFailure(serveJob({}), {
      recordTransition: (t) => {
        transitions.push(t);
      },
      audit: (type) => {
        audits.push({ type });
      },
      postText: async (text) => {
        posts.push(text);
        return { ok: true };
      },
    });
    expect(out).toEqual({ recorded: true, alerted: true });
    expect(transitions).toHaveLength(1);
    expect((transitions[0] as any).stage).toBe("serve");
    expect((transitions[0] as any).status).toBe("failed");
    expect(audits.map((a) => a.type)).toContain("async_job.serve_failed");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("job-serve-1");
  });

  it("handler records the failure state but does not re-alert for a retry", async () => {
    const transitions: unknown[] = [];
    const posts: string[] = [];
    const out = await maybeAlertServeFailure(serveJob({ retryOf: "job-serve-0" }), {
      recordTransition: (t) => {
        transitions.push(t);
      },
      audit: () => {},
      postText: async (text) => {
        posts.push(text);
        return { ok: true };
      },
    });
    expect(out).toEqual({ recorded: true, alerted: false });
    expect(transitions).toHaveLength(1);
    expect(posts).toHaveLength(0);
  });

  it("handler does nothing for chained serve failures or other capabilities", async () => {
    const transitions: unknown[] = [];
    const posts: string[] = [];
    const deps = {
      recordTransition: (t: unknown) => {
        transitions.push(t);
      },
      audit: () => {},
      postText: async (text: string) => {
        posts.push(text);
        return { ok: true };
      },
    };
    expect(
      await maybeAlertServeFailure(serveJob({ stage: "serve", chainId: "chain-1" }), deps),
    ).toEqual({ recorded: false, alerted: false });
    expect(
      await maybeAlertServeFailure(serveJob({ capability: "followup.deliver" }), deps),
    ).toEqual({ recorded: false, alerted: false });
    expect(transitions).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("a failed post never throws and is audited as failed", async () => {
    const audits: Array<{ type: string }> = [];
    const out = await maybeAlertServeFailure(serveJob({}), {
      recordTransition: () => {},
      audit: (type) => {
        audits.push({ type });
      },
      postText: async () => {
        throw new Error("slack down");
      },
    });
    expect(out).toEqual({ recorded: true, alerted: false });
    expect(audits.map((a) => a.type)).toContain("async_job.serve_alert_failed");
  });
});

describe("gather-miss definition (#2000 slice 7, #2056 rule)", () => {
  it("any missing symbol is a miss event; only a total miss pages", () => {
    expect(isGatherMiss({ requested: 4, stored: 2, missing: 2 })).toBe(true);
    expect(shouldAlertGatherMiss({ requested: 4, stored: 2, missing: 2 })).toBe(false);
    expect(isGatherMiss({ requested: 2, stored: 0, missing: 2 })).toBe(true);
    expect(shouldAlertGatherMiss({ requested: 2, stored: 0, missing: 2 })).toBe(true);
  });

  it("a legitimately empty universe is neither event nor alert", () => {
    expect(isGatherMiss({ requested: 0, stored: 0, missing: 0 })).toBe(false);
    expect(shouldAlertGatherMiss({ requested: 0, stored: 0, missing: 0 })).toBe(false);
  });

  it("full coverage is neither event nor alert (Yahoo-column gaps included)", () => {
    expect(isGatherMiss({ requested: 2, stored: 2, missing: 0 })).toBe(false);
    expect(shouldAlertGatherMiss({ requested: 2, stored: 2, missing: 0 })).toBe(false);
  });

  it("alert text carries run id + counts + runbook link, never symbol lists", () => {
    const text = gatherMissText({ runId: "goal-run-9", requested: 3, stored: 0, missing: 3 });
    expect(text).toContain("goal-run-9");
    expect(text).toContain("docs/operations/runbook/alerting.md#gather-misses");
    expect(text).not.toContain("AAPL");
  });
});

describe("gather-miss fold (#2000 slice 7, new type value only)", () => {
  it("folds counts only; symbol lists and error messages never survive", () => {
    const event = foldEnvelopeToEvent(
      gatherEnvelope({
        data: {
          tenantId: "tester",
          runId: "goal-run-9",
          requested: 3,
          stored: 0,
          missing: 3,
          symbols: ["AAPL", "MSFT", "NVDA"],
          error: "live provider exploded: boom",
        },
      }),
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe("goal.gather.missed");
    expect(event!.level).toBe("warn");
    expect(event!.tenantId).toBe("tester");
    expect(event!.runId).toBe("goal-run-9");
    expect(event!.fields).toEqual({ requested: 3, stored: 0, missing: 3 });
  });

  it("folds to null without tenant or run id, and for non-numeric counts", () => {
    expect(
      foldEnvelopeToEvent(gatherEnvelope({ data: { runId: "r", requested: 1, stored: 0, missing: 1 } })),
    ).toBeNull();
    expect(
      foldEnvelopeToEvent(gatherEnvelope({ data: { tenantId: "t", requested: 1, stored: 0, missing: 1 } })),
    ).toBeNull();
    const event = foldEnvelopeToEvent(
      gatherEnvelope({ data: { tenantId: "t", runId: "r", requested: "three", stored: 0, missing: 1 } }),
    );
    expect(event).not.toBeNull();
    expect(event!.fields).toEqual({ stored: 0, missing: 1 });
  });
});

describe("goal gather miss emission + alert (#2000 slice 7)", () => {
  function makeEnrich(over: {
    live: (symbols: string[]) => unknown[];
    yahoo?: (symbols: string[]) => unknown[];
    sink?: { write: ReturnType<typeof vi.fn> };
    alertText?: ReturnType<typeof vi.fn>;
  }) {
    const sql = new MockSqlStorage();
    const { storage } = mapBlobStorage();
    const sink = over.sink ?? { write: vi.fn(), writeBatch: vi.fn() };
    return {
      sink,
      alertText: over.alertText ?? vi.fn(),
      enrich: createGoalGatherEnrichment({
        sql: sql as never,
        blobStorage: storage as never,
        blobEnv: {},
        tenantId: "default",
        userLogin: "tester",
        runId: "goal-run-9",
        liveQuoteDeps: { fetchQuotes: vi.fn(async (s: string[]) => over.live(s)), fetchQuote: vi.fn() } as any,
        ...(over.yahoo
          ? { yahooQuoteDeps: { fetchQuotes: vi.fn(async (s: string[]) => over.yahoo!(s)), fetchQuote: vi.fn() } as any }
          : {}),
        routes: ROUTES,
        sink: sink as never,
        ...(over.alertText ? { alertText: over.alertText } : {}),
      }),
    };
  }

  it("total miss: miss event written AND alert fired", async () => {
    const sink = { write: vi.fn(), writeBatch: vi.fn() };
    const alertText = vi.fn();
    const { enrich } = makeEnrich({
      live: () => [],
      sink,
      alertText,
    });
    const out = await enrich.enrich([listing("AAPL"), listing("MSFT")]);
    expect(out.enrichedQuotes).toHaveLength(0);
    expect(out.missingSymbols.sort()).toEqual(["AAPL", "MSFT"]);
    const miss = sink.write.mock.calls.map((c) => c[0]).find((e) => e.type === "goal.gather.missed");
    expect(miss).toBeDefined();
    expect(miss.fields).toEqual({ requested: 2, stored: 0, missing: 2 });
    expect(miss.runId).toBe("goal-run-9");
    expect(alertText).toHaveBeenCalledTimes(1);
    expect(alertText.mock.calls[0][0]).toContain("goal-run-9");
  });

  it("partial miss: miss event written, NO alert (honest partial coverage)", async () => {
    const sink = { write: vi.fn(), writeBatch: vi.fn() };
    const alertText = vi.fn();
    const { enrich } = makeEnrich({
      live: (symbols) => symbols.filter((s) => s === "AAPL").map((s) => served(s, "E*TRADE live")),
      yahoo: (symbols) => symbols.filter((s) => s === "MSFT").map((s) => served(s, "Yahoo Finance")),
      sink,
      alertText,
    });
    const out = await enrich.enrich([listing("AAPL"), listing("MSFT")]);
    expect(out.enrichedQuotes.map((q) => q.symbol)).toEqual(["AAPL"]);
    expect(out.missingSymbols).toEqual(["MSFT"]);
    const miss = sink.write.mock.calls.map((c) => c[0]).find((e) => e.type === "goal.gather.missed");
    expect(miss).toBeDefined();
    expect(miss.fields).toEqual({ requested: 2, stored: 1, missing: 1 });
    expect(alertText).not.toHaveBeenCalled();
  });

  it("empty universe: no miss event, no alert", async () => {
    const sink = { write: vi.fn(), writeBatch: vi.fn() };
    const alertText = vi.fn();
    const { enrich } = makeEnrich({ live: () => [], sink, alertText });
    const out = await enrich.enrich([]);
    expect(out.enrichedQuotes).toHaveLength(0);
    expect(sink.write.mock.calls.map((c) => c[0]).find((e) => e.type === "goal.gather.missed")).toBeUndefined();
    expect(alertText).not.toHaveBeenCalled();
  });

  it("a throwing alert fn never fails the gather", async () => {
    const sink = { write: vi.fn(), writeBatch: vi.fn() };
    const alertText = vi.fn(async () => {
      throw new Error("slack down");
    });
    const { enrich } = makeEnrich({ live: () => [], sink, alertText });
    const out = await enrich.enrich([listing("AAPL")]);
    expect(out.missingSymbols).toEqual(["AAPL"]);
  });
});
