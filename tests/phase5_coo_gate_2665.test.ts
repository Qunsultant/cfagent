/**
 * Monetization Phase 2 slice 2.10 (#2665) — COO readiness gate over the
 * #2000 Phase 5 deployment surface.
 *
 * Phase 5 slices 1–8 landed (PRs #2769/#2774/#2789/#2794/#2799/#2802/#2805/
 * #2807), and every one of them states "no COO gate hit" because no slice
 * changed a binding. This file is the gate itself: it pins the deployed
 * surface as one inventory — DLQ, durable breaker store, Q1 consumer,
 * stuck alert, alerting list, gather-miss event, stage + resource event
 * types, trace surfacing — plus the poll-202 lens inputs (apiFetch poll
 * bound, goalTrack cadences). It deliberately does NOT re-pin what the
 * slice tests already pin (wrangler queue declarations:
 * dlq_wrangler_pin_2000.test.ts; consumer configs vs wrangler:
 * cloudflare_migration_step1_queue_consumer_2544.test.ts; goalTrack
 * defaults: polling_config_2419.test.ts — cited, and re-asserted here
 * only as gate-surface inputs).
 *
 * Leaf imports only: no server.ts import, so this suite stays fast.
 * The verdict these pins support is recorded in the §15 on #2665 and
 * the gate comment on #2000 — this file checks the surface, not the
 * verdict text.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { maybeAlertDlqDepth } from "../src/messaging/dlqDepthAlert";
import {
  DEFAULT_DLQ_DEPTH_ALERT_THRESHOLD,
  resolveDlqDepthAlertThreshold,
} from "../src/config/dlqDepthAlert";
import { replayDeadLetter } from "../src/messaging/deadLetterReplay";
import { createDeadLetterStoreAdapter } from "../src/data/createDeadLetterStorePorts";
import { DurableCircuitBreaker } from "../src/breakers/durableBreakerAdapter";
import { D1BreakerStateStoreAdapter } from "../src/data/d1BreakerStateStoreAdapter";
import { createBreakerTripSubscriber } from "../src/breakers/breakerTripAlert";
import {
  SCREENER_EVENTS_CONSUMER_CONFIG,
  createScreenerEventsWorkHandler,
} from "../src/messaging/screenerEventsConsumer";
import {
  DEFAULT_STUCK_RUN_ALERT_THRESHOLD_MS,
  resolveStuckRunAlertThresholdMs,
} from "../src/config/stuckRunAlert";
import {
  ALERTING_ITEMS,
  maybeAlertServeFailure,
} from "../src/observability/alertingList";
import { foldEnvelopeToEvent } from "../src/observability/observabilityPorts";
import {
  TRACE_ID_SHAPE,
  handleMeshTraceRoute,
} from "../src/data/meshTraceRoute";
import { POLLING_CONFIG_DEFAULTS } from "../src/client/pollingConfig";
import { apiFetch } from "../src/client/apiFetch";
import type { MessageEnvelope } from "../src/messaging/messagingPorts";

function envelope(
  over: Partial<MessageEnvelope> & { type: string },
): MessageEnvelope {
  return {
    specversion: "1.0",
    id: "evt-gate-1",
    source: "test",
    time: "2026-11-03T00:00:00.000Z",
    data: {},
    ...over,
  };
}

describe("COO readiness gate — #2000 Phase 5 deployment surface (#2665)", () => {
  it("DLQ: depth alert, replay, and D1 dead-letter store are wired (slice 1)", () => {
    expect(typeof maybeAlertDlqDepth).toBe("function");
    expect(typeof replayDeadLetter).toBe("function");
    expect(typeof createDeadLetterStoreAdapter).toBe("function");
    expect(DEFAULT_DLQ_DEPTH_ALERT_THRESHOLD).toBe(10);
    expect(resolveDlqDepthAlertThreshold({})).toBe(10);
    // No new binding: the store is composed over the existing AGENT_DB.
    expect(createDeadLetterStoreAdapter({})).toBeNull();
  });

  it("Breaker: durable store over existing D1 + trip subscriber (slice 2)", () => {
    expect(typeof DurableCircuitBreaker).toBe("function");
    expect(typeof D1BreakerStateStoreAdapter).toBe("function");
    expect(typeof createBreakerTripSubscriber).toBe("function");
  });

  it("Q1: screener-events consumer kept, DLQ-named (slice 8 KEEP)", () => {
    expect(SCREENER_EVENTS_CONSUMER_CONFIG.deadLetterQueue).toBe(
      "screener-events-dlq",
    );
    expect(SCREENER_EVENTS_CONSUMER_CONFIG.maxRetries).toBe(2);
    expect(typeof createScreenerEventsWorkHandler).toBe("function");
  });

  it("Stuck: 30-minute alert threshold default; alerting list carries the stuck row (slice 6)", () => {
    expect(DEFAULT_STUCK_RUN_ALERT_THRESHOLD_MS).toBe(30 * 60 * 1000);
    expect(resolveStuckRunAlertThresholdMs({})).toBe(30 * 60 * 1000);
    const stuck = ALERTING_ITEMS.find((i) => i.id === "stuck-row");
    expect(stuck).toBeDefined();
    expect(stuck!.runbook).toBe("docs/operations/runbook/stuck-runs.md");
    expect(stuck!.delivery).toBe("postSlackText");
  });

  it("Alerting list: exactly the five Phase 5 signals, one channel, each claimed (slice 7)", () => {
    expect(ALERTING_ITEMS.map((i) => i.id).sort()).toEqual([
      "breaker-trip",
      "dlq-depth",
      "gather-miss",
      "serve-stage-failure",
      "stuck-row",
    ]);
    for (const item of ALERTING_ITEMS) {
      expect(item.delivery).toBe("postSlackText");
      expect(item.runbook.length).toBeGreaterThan(0);
      expect(item.claim.length).toBeGreaterThan(0);
      expect(item.signal.length).toBeGreaterThan(0);
    }
    expect(typeof maybeAlertServeFailure).toBe("function");
  });

  it.each([
    "screener.stage.feed_completed",
    "screener.stage.feed_failed",
    "screener.stage.gather_completed",
    "screener.stage.gather_failed",
    "screener.stage.analysis_completed",
    "screener.stage.analysis_failed",
    "screener.stage.deliver_completed",
    "screener.stage.deliver_failed",
  ])("Stage event %s folds with ids only (slice 4)", (type) => {
    const e = foldEnvelopeToEvent(
      envelope({
        type,
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        data: {
          tenantId: "tenant-a",
          runId: "run-1",
          count: 42,
          promptKey: "must-not-survive",
          error: "must-not-survive",
        },
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.type).toBe(type);
    expect(JSON.stringify(e)).not.toContain("must-not-survive");
  });

  it("Gather-miss event folds counts+ids only, tenant-less folds to null (slice 7)", () => {
    const e = foldEnvelopeToEvent(
      envelope({
        type: "goal.gather.missed",
        data: {
          tenantId: "tenant-a",
          runId: "run-1",
          requested: 5,
          stored: 0,
          symbols: ["AAA", "BBB"],
        },
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.type).toBe("goal.gather.missed");
    expect(JSON.stringify(e)).not.toContain("AAA");
    expect(
      foldEnvelopeToEvent(
        envelope({ type: "goal.gather.missed", data: { runId: "run-1" } }),
      ),
    ).toBeNull();
  });

  it("Breaker + resource event types fold (slices 2/5)", () => {
    const trip = foldEnvelopeToEvent(
      envelope({
        type: "breaker.state_changed",
        data: {
          providerId: "provider-a",
          from: "closed",
          to: "open",
          trips: 1,
          fallbacks: 0,
        },
      }),
    );
    expect(trip).not.toBeNull();
    const res = foldEnvelopeToEvent(
      envelope({
        type: "resource.sql_op",
        data: {
          tenantId: "tenant-a",
          runId: "run-1",
          ns: "sessions",
          op: "get",
          rowsRead: 3,
          rowsWritten: 0,
        },
      }),
    );
    expect(res).not.toBeNull();
  });

  it("Trace surfacing: route handler + trace-id shape (slice 3)", () => {
    expect(typeof handleMeshTraceRoute).toBe("function");
    expect(TRACE_ID_SHAPE.test("a".repeat(32))).toBe(true);
    expect(TRACE_ID_SHAPE.test("not-a-trace-id")).toBe(false);
  });

  it("Poll-202 lens inputs: goalTrack cadences (pinned also in polling_config_2419.test.ts)", () => {
    expect(POLLING_CONFIG_DEFAULTS.goalTrackPollMs).toBe(2_000);
    expect(POLLING_CONFIG_DEFAULTS.goalTrackDeadlineMs).toBe(600_000);
  });
});

describe("Poll-202 lens — apiFetch backoff bound (#2665)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a never-completing 202 job polls at most 124 times before the 408", async () => {
    vi.useFakeTimers();
    let statusFetches = 0;
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === "/start") {
        return new Response(
          JSON.stringify({ jobId: "job-1", statusUrl: "/api/jobs/job-1" }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      }
      statusFetches += 1;
      return new Response(
        JSON.stringify({ jobId: "job-1", status: "running", statusUrl: "/api/jobs/job-1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = apiFetch("/start");
    let settled: Response | null = null;
    void pending.then((r) => {
      settled = r;
    });
    // Drive fake time forward until the 408 lands. Each advance settles
    // the pending sleep + fetch pair; the loop exits at the 10-min deadline.
    for (let i = 0; i < 40 && settled === null; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(settled).not.toBeNull();
    const settledRes = settled as unknown as Response;
    expect(settledRes.status).toBe(408);
    const body = (await settledRes.json()) as {
      jobId: string;
    };
    expect(body.jobId).toBe("job-1");
    // Backoff derivation (apiFetch.ts): 500, 750, 1125, 1688, 2532, 3798,
    // then 5000ms caps; cumulative 11393 + 117×5000 = 596393 < 600000, one
    // more sleep+fetch lands past the deadline → 6 + 118 = 124 polls.
    expect(statusFetches).toBe(124);
  });
});
