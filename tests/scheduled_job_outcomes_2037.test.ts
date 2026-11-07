/**
 * Issue Qunsultant/cfagent#2037 — internal-dispatch observability.
 *
 * The 2026-10-27 reflection-dispatch exception was invisible to our own
 * systems: no AE event, no audit record, no alert, and even a Tuesday
 * skip left no trace. This suite pins the slice that closes those gaps:
 *
 * - trace-correlated dispatches (traceparent rides the tick),
 * - exactly one outcome sink (mas_events type scheduled_job.outcome),
 * - repeat-failure alerting via the existing Slack route at a
 *   configured consecutive-failure threshold,
 * - AE error events carrying a code, never a message (#1743 rule).
 */
import { describe, it, expect, vi } from "vitest";
import {
  SCHEDULED_JOB_OUTCOME_TYPE,
  isScheduledJobDispatchPath,
  isScheduledJobId,
  recordScheduledJobOutcome,
  sanitizeScheduledJobErrorCode,
  buildScheduledJobOutcomePayload,
  observeInternalDispatch,
  type ScheduledJobOutcomeInput,
  type ScheduledJobOutcomeStore,
} from "../src/observability/scheduledJobOutcomes";
import { resolveScheduledJobAlertThreshold } from "../src/config/scheduledJobAlert";
import { backgroundDispatchHeadersWithTrace } from "../src/security/backgroundAttribution";
import { handleScheduledJobOutcomeRoute } from "../src/agents/routes/scheduledJobOutcome";
import { InMemoryObservabilityAdapter } from "../src/observability/inMemoryObservabilityAdapter";
import { newTraceContext } from "../src/observability/observabilityPorts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

function memoryStore(): ScheduledJobOutcomeStore & {
  rows: Array<{ job: string; outcome: string; createdAt: string }>;
} {
  const rows: Array<{ job: string; outcome: string; createdAt: string }> = [];
  let seq = 0;
  return {
    rows,
    writeOutcome(input: ScheduledJobOutcomeInput) {
      seq += 1;
      rows.push({
        job: input.job,
        outcome: input.outcome,
        createdAt: `2026-11-02T00:00:${String(seq).padStart(2, "0")}.000Z`,
      });
    },
    recentOutcomes() {
      return [...rows];
    },
  };
}

describe("scheduled-job outcome codes (#2037)", () => {
  it("keeps short codes, degrades anything message-like to unknown", () => {
    expect(sanitizeScheduledJobErrorCode("dispatch_failed")).toBe("dispatch_failed");
    expect(sanitizeScheduledJobErrorCode("unknown")).toBe("unknown");
    expect(sanitizeScheduledJobErrorCode("Cannot read properties of undefined")).toBe("unknown");
    expect(sanitizeScheduledJobErrorCode("boom: stack line 1\nline 2")).toBe("unknown");
    expect(sanitizeScheduledJobErrorCode(undefined)).toBe("unknown");
    expect(sanitizeScheduledJobErrorCode(42)).toBe("unknown");
    expect(sanitizeScheduledJobErrorCode("x".repeat(65))).toBe("unknown");
  });

  // Adapted for #3527 S5: the closed vocabulary GREW by exactly
  // the two registered jobs (corpus-sync, reports-index-backfill).
  // The invariant stays an exact set — extended, not loosened.
  it("names exactly the five tick jobs", () => {
    expect(isScheduledJobId("reflection")).toBe(true);
    expect(isScheduledJobId("research")).toBe(true);
    expect(isScheduledJobId("adaptation")).toBe(true);
    expect(isScheduledJobId("corpus-sync")).toBe(true);
    expect(isScheduledJobId("reports-index-backfill")).toBe(true);
    expect(isScheduledJobId("")).toBe(false);
  });

  // Adapted for #3527 S5: the dispatch-path set grew with the
  // vocabulary — both new POST paths are observed; the paged
  // manual backfill route is still NOT a scheduled dispatch.
  it("matches only the five scheduled-job POST dispatches", () => {
    expect(isScheduledJobDispatchPath("/reflection/run", "POST")).toBe(true);
    expect(isScheduledJobDispatchPath("/research/scheduled-tick", "POST")).toBe(true);
    expect(isScheduledJobDispatchPath("/adaptation/weights/run", "POST")).toBe(true);
    expect(isScheduledJobDispatchPath("/reflection/run", "GET")).toBe(false);
    expect(isScheduledJobDispatchPath("/knowledge/corpus-sync", "POST")).toBe(true);
    expect(isScheduledJobDispatchPath("/trading/reports/index-backfill-sweep", "POST")).toBe(true);
    expect(isScheduledJobDispatchPath("/trading/reports/index-backfill", "POST")).toBe(false);
    expect(isScheduledJobDispatchPath("/api/audit", "GET")).toBe(false);
  });

  it("builds a code-only payload (no message field, ever)", () => {
    const payload = buildScheduledJobOutcomePayload({
      job: "reflection",
      outcome: "failed",
      traceId: TRACE_ID,
      errorCode: "dispatch_failed",
    });
    // The row type travels as the mas_events type (audit call arg),
    // not inside the payload; the payload itself is code-only.
    expect(payload).not.toHaveProperty("message");
    expect(JSON.stringify(payload)).not.toContain("Cannot read");
    expect(payload.job).toBe("reflection");
    expect(payload.errorCode).toBe("dispatch_failed");
  });
});

describe("scheduled-job alert threshold config (#2037)", () => {
  it("defaults to 3 consecutive failures; blank/unparseable fall back; 0 disables", () => {
    expect(resolveScheduledJobAlertThreshold({})).toBe(3);
    expect(resolveScheduledJobAlertThreshold({ SCHEDULED_JOB_ALERT_THRESHOLD: "" })).toBe(3);
    expect(resolveScheduledJobAlertThreshold({ SCHEDULED_JOB_ALERT_THRESHOLD: "nope" })).toBe(3);
    expect(resolveScheduledJobAlertThreshold({ SCHEDULED_JOB_ALERT_THRESHOLD: "5" })).toBe(5);
    expect(resolveScheduledJobAlertThreshold({ SCHEDULED_JOB_ALERT_THRESHOLD: "0" })).toBe(0);
    expect(resolveScheduledJobAlertThreshold({ SCHEDULED_JOB_ALERT_THRESHOLD: "-2" })).toBe(0);
  });
});

describe("recordScheduledJobOutcome (#2037)", () => {
  it("records ran/skipped without alerting", async () => {
    const store = memoryStore();
    const alert = vi.fn(async () => {});
    for (const outcome of ["ran", "skipped"] as const) {
      const res = await recordScheduledJobOutcome(
        { store, alert, threshold: 3 },
        { job: "reflection", outcome, traceId: TRACE_ID },
      );
      expect(res.recorded).toBe(true);
      expect(res.streak).toBe(0);
      expect(res.alerted).toBe(false);
    }
    expect(alert).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(2);
  });

  it("alerts exactly when the streak hits the threshold, then repeats per multiple", async () => {
    const store = memoryStore();
    const alert = vi.fn(async () => {});
    const fail = () =>
      recordScheduledJobOutcome(
        { store, alert, threshold: 3 },
        { job: "reflection", outcome: "failed", traceId: TRACE_ID, errorCode: "dispatch_failed" },
      );
    expect((await fail()).alerted).toBe(false);
    expect((await fail()).alerted).toBe(false);
    const third = await fail();
    expect(third.streak).toBe(3);
    expect(third.alerted).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String(alert.mock.calls[0][0])).toContain("reflection");
    expect(String(alert.mock.calls[0][0])).toContain("3 consecutive");
    expect(String(alert.mock.calls[0][0])).toContain("dispatch_failed");
    expect(String(alert.mock.calls[0][0])).not.toContain("stack");
    expect((await fail()).alerted).toBe(false);
    expect((await fail()).alerted).toBe(false);
    expect((await fail()).alerted).toBe(true);
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it("a success or skip resets the streak, and jobs do not share streaks", async () => {
    const store = memoryStore();
    const alert = vi.fn(async () => {});
    const run = (job: "reflection" | "research", outcome: "ran" | "skipped" | "failed") =>
      recordScheduledJobOutcome({ store, alert, threshold: 2 }, { job, outcome, traceId: TRACE_ID });
    await run("reflection", "failed");
    await run("research", "failed");
    await run("reflection", "ran");
    const res = await run("reflection", "failed");
    expect(res.streak).toBe(1);
    expect(res.alerted).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("a failing alert never fails the recording", async () => {
    const store = memoryStore();
    const alert = vi.fn(async () => {
      throw new Error("slack down");
    });
    await recordScheduledJobOutcome(
      { store, alert, threshold: 1 },
      { job: "adaptation", outcome: "failed", traceId: TRACE_ID, errorCode: "dispatch_failed" },
    );
    await recordScheduledJobOutcome(
      { store, alert, threshold: 1 },
      { job: "adaptation", outcome: "failed", traceId: TRACE_ID, errorCode: "dispatch_failed" },
    );
    expect(store.rows).toHaveLength(2);
  });

  it("threshold 0 never alerts but still records", async () => {
    const store = memoryStore();
    const alert = vi.fn(async () => {});
    const res = await recordScheduledJobOutcome(
      { store, alert, threshold: 0 },
      { job: "reflection", outcome: "failed", traceId: TRACE_ID },
    );
    expect(res.recorded).toBe(true);
    expect(res.alerted).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("observeInternalDispatch (#2037)", () => {
  it("emits an info AE event correlated to the tick trace on success", async () => {
    const sink = new InMemoryObservabilityAdapter();
    const trace = newTraceContext();
    await observeInternalDispatch(Promise.resolve(new Response("ok")), {
      job: "reflection",
      sink,
      trace,
      recordFailure: vi.fn(async () => {}),
      alertUnreachable: vi.fn(async () => {}),
    });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].level).toBe("info");
    expect(sink.events[0].traceId).toBe(trace.traceId);
    expect(sink.events[0].fields.job).toBe("reflection");
  });

  it("a rejected dispatch emits an AE error event with a code, never the message, and records the failure", async () => {
    const sink = new InMemoryObservabilityAdapter();
    const trace = newTraceContext();
    const recordFailure = vi.fn(async () => {});
    const alertUnreachable = vi.fn(async () => {});
    const boom = new Error("Cannot read properties of undefined (reading 'fetch')");
    (boom as { code?: string }).code = "dispatch_failed";
    await observeInternalDispatch(Promise.reject(boom), {
      job: "reflection",
      sink,
      trace,
      recordFailure,
      alertUnreachable,
    });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].level).toBe("error");
    expect(sink.events[0].errorCode).toBe("dispatch_failed");
    expect(sink.events[0].traceId).toBe(trace.traceId);
    expect(JSON.stringify(sink.events[0])).not.toContain("Cannot read");
    expect(recordFailure).toHaveBeenCalledTimes(1);
    const input = recordFailure.mock.calls[0][0] as ScheduledJobOutcomeInput;
    expect(input.job).toBe("reflection");
    expect(input.outcome).toBe("failed");
    expect(input.traceId).toBe(trace.traceId);
    expect(input.errorCode).toBe("dispatch_failed");
    expect(alertUnreachable).not.toHaveBeenCalled();
  });

  it("when the outcome record itself is unreachable, the fail-loud alert fires and nothing rejects", async () => {
    const sink = new InMemoryObservabilityAdapter();
    const alertUnreachable = vi.fn(async () => {});
    await expect(
      observeInternalDispatch(Promise.reject(new Error("do down")), {
        job: "research",
        sink,
        trace: newTraceContext(),
        recordFailure: vi.fn(async () => {
          throw new Error("audit route down");
        }),
        alertUnreachable,
      }),
    ).resolves.toBeUndefined();
    expect(alertUnreachable).toHaveBeenCalledTimes(1);
  });

  it("a 500 Response is not a dispatch failure (the DO-side record stands; no second record)", async () => {
    const sink = new InMemoryObservabilityAdapter();
    const recordFailure = vi.fn(async () => {});
    await observeInternalDispatch(Promise.resolve(new Response("err", { status: 500 })), {
      job: "adaptation",
      sink,
      trace: newTraceContext(),
      recordFailure,
      alertUnreachable: vi.fn(async () => {}),
    });
    expect(recordFailure).not.toHaveBeenCalled();
  });
});

describe("tick dispatch headers (#2037)", () => {
  it("carries identity, background kind, and the tick traceparent together", () => {
    const headers = backgroundDispatchHeadersWithTrace("svc-background", TRACEPARENT);
    expect(headers["x-user-login"]).toBe("svc-background");
    expect(headers["x-actor-kind"]).toBe("background");
    expect(headers["traceparent"]).toBe(TRACEPARENT);
  });
});

describe("handler outcome audits (#2037 acceptance: a skip leaves a record)", () => {
  it("a Tuesday reflection run audits a skipped outcome (no longer invisible)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-03T12:00:00.000Z")); // Tuesday
      const { handleReflectionRun } = await import(
        "../src/agents/routes/etradeBrokerLearning"
      );
      const audit = vi.fn();
      const ctx = {
        getOrm: () => ({}),
        audit,
        env: {},
        traceId: TRACE_ID,
      } as never;
      const res = await handleReflectionRun(ctx);
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.skipped).toBe("not Sunday");
      expect(audit).toHaveBeenCalledTimes(1);
      const [type, agent, payload] = audit.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      expect(type).toBe(SCHEDULED_JOB_OUTCOME_TYPE);
      expect(agent).toBe("orchestrator");
      expect(payload.job).toBe("reflection");
      expect(payload.outcome).toBe("skipped");
      expect(payload.traceId).toBe(TRACE_ID);
      expect(payload.reason).toBe("not Sunday");
      expect(payload).not.toHaveProperty("message");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a research tick that does not fire audits a skipped outcome with its guard reason", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-07T12:00:00.000Z")); // Saturday
      const { handleScreenerResearchRoutes } = await import(
        "../src/agents/routes/screenerResearch"
      );
      const rows: Array<Record<string, unknown>> = [];
      const ctx = {
        getScreenerAgent: () => {
          throw new Error("unused");
        },
        getScreenerExecutionContext: async () => undefined,
        getResearchAgent: () => null,
        runResearchAndPublish: vi.fn(async () => ({ success: true })),
        getOrm: () => ({
          events: {
            create: (row: Record<string, unknown>) => {
              rows.push(row);
            },
            findMany: () => [],
          },
        }),
        readSettingRaw: () => null,
        writeSetting: () => {},
        env: {},
        traceId: TRACE_ID,
      } as never;
      const request = new Request("https://agent.internal/research/scheduled-tick", {
        method: "POST",
        headers: { "x-user-login": "svc-background" },
      });
      const res = await handleScreenerResearchRoutes(
        request,
        new URL(request.url),
        "/research/scheduled-tick",
        "session",
        ctx,
      );
      expect(res?.status).toBe(200);
      const data = (await res!.json()) as Record<string, unknown>;
      expect(data.skipped).toBe(true);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.type).toBe(SCHEDULED_JOB_OUTCOME_TYPE);
      const payload = row.payload as Record<string, unknown>;
      expect(payload.job).toBe("research");
      expect(payload.outcome).toBe("skipped");
      expect(payload.reason).toBe("weekend");
      expect(payload.traceId).toBe(TRACE_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an adaptation run that already ran this week audits a skipped outcome", async () => {
    const { handleScreenerResearchRoutes } = await import(
      "../src/agents/routes/screenerResearch"
    );
    const { isoWeekKey, WEIGHTS_LAST_RUN_WEEK_KEY } = await import(
      "../src/services/strategyWeightsV2"
    );
    vi.useFakeTimers();
    try {
      const now = new Date("2026-11-02T12:00:00.000Z"); // Monday
      vi.setSystemTime(now);
      const rows: Array<Record<string, unknown>> = [];
      const settings = new Map<string, string>([
        [WEIGHTS_LAST_RUN_WEEK_KEY, isoWeekKey(now)],
      ]);
      const ctx = {
        getScreenerAgent: () => {
          throw new Error("unused");
        },
        getScreenerExecutionContext: async () => undefined,
        getResearchAgent: () => ({
          getTrackRecord: async () => ({ ideas: [] }),
          getResearchConfig: async () => null,
        }),
        runResearchAndPublish: vi.fn(async () => ({ success: true })),
        getOrm: () => ({
          events: {
            create: (row: Record<string, unknown>) => {
              rows.push(row);
            },
            findMany: () => [],
          },
        }),
        readSettingRaw: (key: string) => settings.get(key) ?? null,
        writeSetting: (key: string, value: string) => {
          settings.set(key, value);
        },
        env: {},
        traceId: TRACE_ID,
      } as never;
      const request = new Request("https://agent.internal/adaptation/weights/run", {
        method: "POST",
        headers: { "x-user-login": "svc-background" },
        body: JSON.stringify({}),
      });
      const res = await handleScreenerResearchRoutes(
        request,
        new URL(request.url),
        "/adaptation/weights/run",
        "session",
        ctx,
      );
      expect(res?.status).toBe(200);
      const data = (await res!.json()) as Record<string, unknown>;
      expect(data.skipped).toBe("already ran this week");
      expect(rows).toHaveLength(1);
      const payload = rows[0].payload as Record<string, unknown>;
      expect(payload.job).toBe("adaptation");
      expect(payload.outcome).toBe("skipped");
      expect(payload.traceId).toBe(TRACE_ID);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("POST /scheduled-job-outcome route (#2037)", () => {
  function routeCtx(overrides: Record<string, unknown> = {}) {
    const store = memoryStore();
    const alerts: string[] = [];
    return {
      store,
      alerts,
      ctx: {
        audit: vi.fn(),
        getOrm: () => ({
          events: {
            create: (row: Record<string, unknown>) =>
              store.writeOutcome({
                job: row.payload
                  ? (row.payload as Record<string, unknown>).job as "reflection"
                  : "reflection",
                outcome: (row.payload as Record<string, unknown>).outcome as "failed",
                traceId: null,
              }),
            findMany: () => [],
          },
        }),
        env: { SERVICE_USER_LOGIN: "svc-background" },
        sendAlert: async (text: string) => {
          alerts.push(text);
        },
        ...overrides,
      } as never,
    };
  }

  it("refuses a caller that is not the background service identity", async () => {
    const { ctx } = routeCtx();
    const req = new Request("https://agent.internal/scheduled-job-outcome", {
      method: "POST",
      headers: { "x-user-login": "alice", "x-actor-kind": "background" },
      body: JSON.stringify({ job: "reflection", outcome: "failed" }),
    });
    const res = await handleScheduledJobOutcomeRoute(req, ctx);
    expect(res.status).toBe(401);
  });

  it("refuses an unknown job or outcome without writing", async () => {
    const { ctx } = routeCtx();
    const req = new Request("https://agent.internal/scheduled-job-outcome", {
      method: "POST",
      headers: { "x-user-login": "svc-background", "x-actor-kind": "background" },
      body: JSON.stringify({ job: "nope", outcome: "failed" }),
    });
    const res = await handleScheduledJobOutcomeRoute(req, ctx);
    expect(res.status).toBe(400);
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("records a background dispatch failure and reports the streak", async () => {
    const { ctx } = routeCtx();
    const body = { job: "reflection", outcome: "failed", traceId: TRACE_ID, errorCode: "dispatch_failed" };
    const req = new Request("https://agent.internal/scheduled-job-outcome", {
      method: "POST",
      headers: { "x-user-login": "svc-background", "x-actor-kind": "background" },
      body: JSON.stringify(body),
    });
    const res = await handleScheduledJobOutcomeRoute(req, ctx);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.success).toBe(true);
    expect(data.job).toBe("reflection");
    expect(data.outcome).toBe("failed");
    expect(ctx.audit).toHaveBeenCalledTimes(1);
    const auditArgs = (ctx.audit as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(auditArgs[0]).toBe(SCHEDULED_JOB_OUTCOME_TYPE);
  });
});
