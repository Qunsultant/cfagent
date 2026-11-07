/**
 * Issue #3121 Slice S5 — named entry points for the three Worker crons
 * (inventory §3 Q(b), Option A CONFIRMED 2026-11-07 on #3592).
 *
 * Parity for the S5 slice of the scheduling consolidation program:
 * `scheduled()` becomes a thin dispatch (`event.cron` → named entry
 * point) and each cron runs through a named consolidated-scheduler
 * entry point — `tick` (`*\/30`), `renewTokens` (`0 3`), `retention`
 * (`0 4`) — with the gate, the per-tick trace, the observer wiring,
 * the dispatch order, and the guards preserved verbatim from
 * `src/server/routes/queue.ts` `handleScheduledEvent`. Each dispatch
 * writes one ledger row recording the DISPATCH (not downstream
 * outcomes — downstream work has its own rows) via the
 * background-gated `POST /schedules/record-cron-dispatch` route.
 *
 * - S5-P01 `resolveCronEntryPoint` maps exactly the three Worker
 *   crons to their entry points; anything else → null.
 * - S5-P02 tick with the gate denied records a skip row and calls
 *   ZERO dispatches; renewal with the same denied gate still runs.
 * - S5-P03 tick provisioned calls onCron + all six POST dispatches
 *   exactly once, in order, under ONE trace (same trace id on every
 *   dispatch); a failing research dispatch does not fail the tick;
 *   the success row carries scheduleId = the cron expression.
 * - S5-P04 renewal runs without identity; a renewal failure records
 *   a failure row AND propagates in the await path, and records the
 *   row while still resolving in the waitUntil path.
 * - S5-P05 retention gate denied → no POST + skip row; provisioned
 *   → POST with background headers + success row; a non-2xx
 *   response is logged, not thrown.
 * - S5-P06 `buildCronDispatchRecord` is pure and exact; the row
 *   round-trips through `SqlJobRunRecordStore` unchanged.
 * - S5-P07 `parseCronDispatchRecordPayload` rejects every malformed
 *   shape and accepts a valid payload per entry point; the route
 *   enforces background attribution (401), payload validity (400),
 *   and stores the row (200).
 * - S5-P08 thinness: `handleScheduledEvent` delegates to the
 *   entry-point runner and carries none of the dispatch literals;
 *   `CRON_ENTRY_POINTS` is single-sourced from S1 `WORKER_CRONS`.
 * - S5-P09 S0 doc pins: Q(b) records the CONFIRMED Option A
 *   decision; §1.2 names seven dispatches incl. the
 *   reports-index-backfill sweep; §9 carries the S5 rows.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  CRON_ENTRY_POINTS,
  buildCronDispatchRecord,
  parseCronDispatchRecordPayload,
  resolveCronEntryPoint,
  runCronEntryPoint,
  runRenewTokensEntryPoint,
  runRetentionEntryPoint,
  runTickEntryPoint,
  type CronDispatchRecordInput,
  type CronEntryPointDeps,
} from "../src/services/consolidatedCronEntries";
import {
  WORKER_CRONS,
  WORKER_TICK_CRON,
} from "../src/services/consolidatedScheduling";
import { handleCronDispatchRecordRoute } from "../src/agents/routes/cronDispatchRecord";
import { recordCronDispatchRun } from "../src/agents/orchestrator/scheduleCallbackRunRecords";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import { InMemoryObservabilityAdapter } from "../src/observability/inMemoryObservabilityAdapter";
import type { Env } from "../src/types";

const TICK_CRON = "*/30 * * * *";
const RENEW_CRON = "0 3 * * *";
const RETENTION_CRON = "0 4 * * *";

const SERVICE_LOGIN = "svc-background";
const STARTED = "2026-11-07T10:30:00.000Z";
const FINISHED = "2026-11-07T10:30:01.000Z";

/** node:sqlite double for the SqlStorage seam (same shape as #2337 / S1-P05). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  get sql(): SqliteTestStorage {
    return this;
  }
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

function source(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function makeOrchestrator(opts: {
  failUrls?: Set<string>;
  statusByUrl?: Map<string, number>;
} = {}) {
  const calls: FetchCall[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url: request.url, method: request.method, headers });
    if (opts.failUrls?.has(request.url)) {
      throw Object.assign(new Error("dispatch failed"), {
        code: "dispatch_failed",
      });
    }
    return new Response("{}", {
      status: opts.statusByUrl?.get(request.url) ?? 200,
    });
  };
  return { calls, fetch };
}

function makeDeps(overrides: Partial<CronEntryPointDeps> = {}): {
  deps: CronEntryPointDeps;
  orchestrator: ReturnType<typeof makeOrchestrator>;
  records: CronDispatchRecordInput[];
  errors: unknown[][];
  infos: unknown[][];
  slackTexts: string[];
  onCronCalls: { count: number };
  renewCalls: { count: number };
} {
  const orchestrator = makeOrchestrator();
  const records: CronDispatchRecordInput[] = [];
  const errors: unknown[][] = [];
  const infos: unknown[][] = [];
  const slackTexts: string[] = [];
  const onCronCalls = { count: 0 };
  const renewCalls = { count: 0 };
  const deps: CronEntryPointDeps = {
    cron: TICK_CRON,
    entryPoint: "tick",
    serviceUserLogin: SERVICE_LOGIN,
    serviceProvisioned: true,
    orchestrator,
    scheduledAgent: {
      onCron: async () => {
        onCronCalls.count += 1;
      },
    },
    renewTokens: async () => {
      renewCalls.count += 1;
      return { renewed: 2, skipped: 1, failed: 0 };
    },
    createSink: () => new InMemoryObservabilityAdapter(),
    slackPoster: async (text: string) => {
      slackTexts.push(text);
    },
    dispatchAndAwait: async (promise: Promise<unknown>) => {
      await promise;
    },
    recordDispatch: async (input: CronDispatchRecordInput) => {
      records.push(input);
    },
    now: () => new Date(FINISHED),
    logError: (...args: unknown[]) => {
      errors.push(args);
    },
    logInfo: (...args: unknown[]) => {
      infos.push(args);
    },
    ...overrides,
  };
  return {
    deps,
    orchestrator,
    records,
    errors,
    infos,
    slackTexts,
    onCronCalls,
    renewCalls,
  };
}

function traceIdOf(traceparent: string | undefined): string | null {
  if (!traceparent) return null;
  const parts = traceparent.split("-");
  return parts.length === 4 ? parts[1] : null;
}

const TICK_POST_URLS = [
  "https://agent.internal/research/scheduled-tick",
  "https://agent.internal/reflection/run",
  "https://agent.internal/adaptation/weights/run",
  "https://agent.internal/knowledge/corpus-sync",
  "https://agent.internal/trading/reports/index-backfill-sweep",
  "https://agent.internal/payments/agentic/commercial/lifecycle/digest/run-due",
];

describe("S5-P01 cron → entry-point routing", () => {
  it("maps exactly the three Worker crons", () => {
    expect(resolveCronEntryPoint(TICK_CRON)).toBe("tick");
    expect(resolveCronEntryPoint(RENEW_CRON)).toBe("renewTokens");
    expect(resolveCronEntryPoint(RETENTION_CRON)).toBe("retention");
  });

  it("returns null for unknown strings, non-strings, and null", () => {
    expect(resolveCronEntryPoint("0 21 * * 1-5")).toBeNull();
    expect(resolveCronEntryPoint("")).toBeNull();
    expect(resolveCronEntryPoint("*/30 * * *")).toBeNull();
    expect(resolveCronEntryPoint(42)).toBeNull();
    expect(resolveCronEntryPoint(undefined)).toBeNull();
    expect(resolveCronEntryPoint(null)).toBeNull();
    expect(resolveCronEntryPoint({})).toBeNull();
  });

  it("exposes the tick cron as the S1 tick constant", () => {
    expect(TICK_CRON).toBe(WORKER_TICK_CRON);
  });
});

describe("S5-P02 tick gate denial / renewal gate independence", () => {
  it("tick with no service login: zero dispatches, skip row, error logged", async () => {
    const { deps, orchestrator, records, errors, onCronCalls } = makeDeps({
      serviceUserLogin: null,
      serviceProvisioned: false,
    });
    await runTickEntryPoint(deps);
    expect(onCronCalls.count).toBe(0);
    expect(orchestrator.calls).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      cron: TICK_CRON,
      entryPoint: "tick",
      outcome: "skipped",
    });
    expect(records[0].detail).toMatch(/not configured/i);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("tick with login set but unprovisioned: zero dispatches, skip row naming the denial", async () => {
    const { deps, orchestrator, records, errors, onCronCalls } = makeDeps({
      serviceUserLogin: SERVICE_LOGIN,
      serviceProvisioned: false,
    });
    await runTickEntryPoint(deps);
    expect(onCronCalls.count).toBe(0);
    expect(orchestrator.calls).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("skipped");
    expect(records[0].detail).toMatch(/not provisioned/i);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("renewal with the same denied gate still runs and records success", async () => {
    const { deps, records, renewCalls } = makeDeps({
      cron: RENEW_CRON,
      entryPoint: "renewTokens",
      serviceUserLogin: null,
      serviceProvisioned: false,
    });
    await runRenewTokensEntryPoint(deps);
    expect(renewCalls.count).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      cron: RENEW_CRON,
      entryPoint: "renewTokens",
      outcome: "success",
    });
  });
});

describe("S5-P03 provisioned tick dispatch order, trace, and observer", () => {
  it("calls onCron + all six POST dispatches exactly once, in order, under one trace", async () => {
    const { deps, orchestrator, records, onCronCalls } = makeDeps();
    await runTickEntryPoint(deps);
    expect(onCronCalls.count).toBe(1);
    expect(orchestrator.calls.map((c) => c.url)).toEqual(TICK_POST_URLS);
    // One trace per tick: every dispatch carries a child span of the
    // same trace, so the traceparent differs per dispatch (fresh
    // span id) while the trace id is identical.
    const traceIds = orchestrator.calls.map((c) =>
      traceIdOf(c.headers["traceparent"]),
    );
    expect(new Set(traceIds).size).toBe(1);
    expect(traceIds[0]).toMatch(/^[0-9a-f]{32}$/);
    for (const call of orchestrator.calls) {
      expect(call.headers["x-user-login"]).toBe(SERVICE_LOGIN);
      expect(call.headers["x-actor-kind"]).toBe("background");
      expect(call.method).toBe("POST");
    }
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      cron: TICK_CRON,
      entryPoint: "tick",
      outcome: "success",
    });
    // The success row is built through buildCronDispatchRecord:
    // scheduleId is the cron expression (checked exactly in S5-P06).
    expect(
      buildCronDispatchRecord(records[0]).scheduleId,
    ).toBe(TICK_CRON);
  });

  it("a failing research dispatch does not fail the tick (observer swallows)", async () => {
    const orchestrator = makeOrchestrator({
      failUrls: new Set(["https://agent.internal/research/scheduled-tick"]),
    });
    const { deps, records, slackTexts } = makeDeps({ orchestrator });
    await expect(runTickEntryPoint(deps)).resolves.toBeUndefined();
    // The observer records the failure through the outcome route on
    // the same tick trace; the tick still completes and records success.
    const outcomePosts = orchestrator.calls.filter(
      (c) => c.url === "https://agent.internal/scheduled-job-outcome",
    );
    expect(outcomePosts).toHaveLength(1);
    expect(traceIdOf(outcomePosts[0].headers["traceparent"])).toBe(
      traceIdOf(
        orchestrator.calls.find(
          (c) => c.url === "https://agent.internal/reflection/run",
        )?.headers["traceparent"],
      ),
    );
    expect(slackTexts).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("success");
  });

  it("the dispatcher routes by entry-point name", async () => {
    const { deps, orchestrator, onCronCalls } = makeDeps();
    await runCronEntryPoint("tick", deps);
    expect(onCronCalls.count).toBe(1);
    expect(orchestrator.calls).toHaveLength(6);
  });
});

describe("S5-P04 renewal without identity and renewal failure paths", () => {
  it("renewal runs without identity (null login, unprovisioned) and records success", async () => {
    const { deps, records, renewCalls, infos } = makeDeps({
      cron: RENEW_CRON,
      entryPoint: "renewTokens",
      serviceUserLogin: null,
      serviceProvisioned: false,
    });
    await runRenewTokensEntryPoint(deps);
    expect(renewCalls.count).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      cron: RENEW_CRON,
      entryPoint: "renewTokens",
      outcome: "success",
    });
    expect(
      infos.some((args) =>
        String(args[0]).includes(
          "[scheduled] E*TRADE account-token renewal completed",
        ),
      ),
    ).toBe(true);
  });

  it("renewal failure (await path): failure row recorded AND the rejection propagates", async () => {
    const boom = new Error("token store down");
    const { deps, records } = makeDeps({
      cron: RENEW_CRON,
      entryPoint: "renewTokens",
      serviceUserLogin: null,
      serviceProvisioned: false,
      renewTokens: async () => {
        throw boom;
      },
    });
    await expect(runRenewTokensEntryPoint(deps)).rejects.toThrow(
      "token store down",
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      cron: RENEW_CRON,
      entryPoint: "renewTokens",
      outcome: "failure",
    });
    expect(records[0].error).toMatch(/token store down/);
  });

  it("renewal failure (waitUntil path): failure row recorded, entry point still resolves", async () => {
    const backgrounded: Promise<unknown>[] = [];
    const boom = new Error("token store down");
    const { deps, records } = makeDeps({
      cron: RENEW_CRON,
      entryPoint: "renewTokens",
      serviceUserLogin: null,
      serviceProvisioned: false,
      renewTokens: async () => {
        throw boom;
      },
      dispatchAndAwait: async (promise: Promise<unknown>) => {
        backgrounded.push(promise);
      },
    });
    await expect(runRenewTokensEntryPoint(deps)).resolves.toBeUndefined();
    await Promise.allSettled(backgrounded);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("failure");
    expect(records[0].error).toMatch(/token store down/);
  });
});

describe("S5-P05 retention gate, dispatch, and non-2xx", () => {
  it("retention gate denied: no POST, skip row recorded", async () => {
    const { deps, orchestrator, records, errors } = makeDeps({
      cron: RETENTION_CRON,
      entryPoint: "retention",
      serviceUserLogin: null,
      serviceProvisioned: false,
    });
    await runRetentionEntryPoint(deps);
    expect(orchestrator.calls).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      cron: RETENTION_CRON,
      entryPoint: "retention",
      outcome: "skipped",
    });
    expect(records[0].detail).toMatch(/not configured/i);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("retention provisioned: POST with background headers, success row recorded", async () => {
    const { deps, orchestrator, records } = makeDeps({
      cron: RETENTION_CRON,
      entryPoint: "retention",
    });
    await runRetentionEntryPoint(deps);
    expect(orchestrator.calls).toHaveLength(1);
    expect(orchestrator.calls[0].url).toBe(
      "https://agent.internal/schedules/trigger-retention",
    );
    expect(orchestrator.calls[0].method).toBe("POST");
    expect(orchestrator.calls[0].headers["x-user-login"]).toBe(SERVICE_LOGIN);
    expect(orchestrator.calls[0].headers["x-actor-kind"]).toBe("background");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      cron: RETENTION_CRON,
      entryPoint: "retention",
      outcome: "success",
    });
  });

  it("retention non-2xx response: error logged, entry point still resolves", async () => {
    const orchestrator = makeOrchestrator({
      statusByUrl: new Map([
        ["https://agent.internal/schedules/trigger-retention", 500],
      ]),
    });
    const { deps, records, errors } = makeDeps({
      cron: RETENTION_CRON,
      entryPoint: "retention",
      orchestrator,
    });
    await expect(runRetentionEntryPoint(deps)).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("success");
  });
});

describe("S5-P06 cron dispatch record shape and store round-trip", () => {
  it("buildCronDispatchRecord is pure and exact for each entry point", () => {
    for (const [cron, entryPoint] of [
      [TICK_CRON, "tick"],
      [RENEW_CRON, "renewTokens"],
      [RETENTION_CRON, "retention"],
    ] as const) {
      const record = buildCronDispatchRecord({
        cron,
        entryPoint,
        outcome: "success",
        started: STARTED,
        finished: FINISHED,
      });
      expect(record).toMatchObject({
        jobId: cron,
        operation: entryPoint,
        system: "worker-cron",
        triggeredBy: "scheduled",
        trigger: "worker-cron",
        scheduleId: cron,
        asyncJobId: null,
        workflowId: null,
        outcome: "success",
        started: STARTED,
        finished: FINISHED,
      });
    }
    const failure = buildCronDispatchRecord({
      cron: TICK_CRON,
      entryPoint: "tick",
      outcome: "failure",
      started: STARTED,
      finished: FINISHED,
      error: "boom",
    });
    expect(failure.error).toBe("boom");
    const skipped = buildCronDispatchRecord({
      cron: RETENTION_CRON,
      entryPoint: "retention",
      outcome: "skipped",
      started: STARTED,
      finished: FINISHED,
      detail: "service user is not provisioned for the platform tier",
    });
    expect(skipped.detail).toMatch(/not provisioned/);
  });

  it("recordCronDispatchRun writes one row readable back with those fields", () => {
    const storage = new SqliteTestStorage();
    recordCronDispatchRun(storage.sql, {
      cron: TICK_CRON,
      entryPoint: "tick",
      outcome: "success",
      started: STARTED,
      finished: FINISHED,
    });
    const store = new SqlJobRunRecordStore(storage.sql);
    const rows = store.listByJob(TICK_CRON);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      jobId: TICK_CRON,
      operation: "tick",
      system: "worker-cron",
      triggeredBy: "scheduled",
      trigger: "worker-cron",
      scheduleId: TICK_CRON,
      asyncJobId: null,
      workflowId: null,
      outcome: "success",
    });
  });
});

describe("S5-P07 payload validation and the record route", () => {
  const validTick = {
    cron: TICK_CRON,
    entryPoint: "tick",
    outcome: "success",
    started: STARTED,
    finished: FINISHED,
  };

  it("rejects unknown cron, mismatched entry point, bad outcome, and bad timestamps", () => {
    expect(parseCronDispatchRecordPayload(null)).toBeNull();
    expect(parseCronDispatchRecordPayload("nope")).toBeNull();
    expect(parseCronDispatchRecordPayload({ ...validTick, cron: "0 5 * * *" })).toBeNull();
    expect(
      parseCronDispatchRecordPayload({ ...validTick, entryPoint: "retention" }),
    ).toBeNull();
    expect(
      parseCronDispatchRecordPayload({ ...validTick, outcome: "ran" }),
    ).toBeNull();
    expect(
      parseCronDispatchRecordPayload({ ...validTick, started: "not-a-date" }),
    ).toBeNull();
    expect(
      parseCronDispatchRecordPayload({ ...validTick, finished: undefined }),
    ).toBeNull();
    expect(
      parseCronDispatchRecordPayload({ ...validTick, error: 42 }),
    ).toBeNull();
    expect(
      parseCronDispatchRecordPayload({ ...validTick, detail: {} }),
    ).toBeNull();
  });

  it("rejects skipped without detail and failure without error", () => {
    expect(
      parseCronDispatchRecordPayload({ ...validTick, outcome: "skipped" }),
    ).toBeNull();
    expect(
      parseCronDispatchRecordPayload({ ...validTick, outcome: "failure" }),
    ).toBeNull();
    expect(
      parseCronDispatchRecordPayload({
        ...validTick,
        outcome: "skipped",
        detail: "service user is not provisioned for the platform tier",
      }),
    ).not.toBeNull();
    expect(
      parseCronDispatchRecordPayload({
        ...validTick,
        outcome: "failure",
        error: "boom",
      }),
    ).not.toBeNull();
  });

  it("accepts a valid payload for each entry point", () => {
    expect(
      parseCronDispatchRecordPayload(validTick),
    ).toMatchObject({ cron: TICK_CRON, entryPoint: "tick" });
    expect(
      parseCronDispatchRecordPayload({
        cron: RENEW_CRON,
        entryPoint: "renewTokens",
        outcome: "success",
        started: STARTED,
        finished: FINISHED,
      }),
    ).toMatchObject({ cron: RENEW_CRON, entryPoint: "renewTokens" });
    expect(
      parseCronDispatchRecordPayload({
        cron: RETENTION_CRON,
        entryPoint: "retention",
        outcome: "success",
        started: STARTED,
        finished: FINISHED,
      }),
    ).toMatchObject({ cron: RETENTION_CRON, entryPoint: "retention" });
  });

  function routeRequest(body: unknown, headers?: Record<string, string>) {
    return new Request(
      "https://agent.internal/schedules/record-cron-dispatch",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(headers ?? {}) },
        body: JSON.stringify(body),
      },
    );
  }

  function routeCtx(storage: SqliteTestStorage) {
    return {
      env: { SERVICE_USER_LOGIN: SERVICE_LOGIN } as unknown as Env,
      sql: storage.sql,
    };
  }

  const backgroundHeaders = {
    "x-user-login": SERVICE_LOGIN,
    "x-actor-kind": "background",
  };

  it("non-background caller → 401", async () => {
    const storage = new SqliteTestStorage();
    const noHeaders = await handleCronDispatchRecordRoute(
      routeRequest(validTick),
      routeCtx(storage),
    );
    expect(noHeaders.status).toBe(401);
    expect(await noHeaders.json()).toMatchObject({
      success: false,
      error: "Background service dispatch required.",
    });
    const wrongLogin = await handleCronDispatchRecordRoute(
      routeRequest(validTick, {
        "x-user-login": "someone-else",
        "x-actor-kind": "background",
      }),
      routeCtx(storage),
    );
    expect(wrongLogin.status).toBe(401);
    expect(new SqlJobRunRecordStore(storage.sql).listByJob(TICK_CRON)).toHaveLength(0);
  });

  it("background caller + invalid payload → 400", async () => {
    const storage = new SqliteTestStorage();
    const res = await handleCronDispatchRecordRoute(
      routeRequest({ ...validTick, entryPoint: "retention" }, backgroundHeaders),
      routeCtx(storage),
    );
    expect(res.status).toBe(400);
    expect(new SqlJobRunRecordStore(storage.sql).listByJob(TICK_CRON)).toHaveLength(0);
  });

  it("background caller + valid payload → 200 and the row is stored", async () => {
    const storage = new SqliteTestStorage();
    const res = await handleCronDispatchRecordRoute(
      routeRequest(validTick, backgroundHeaders),
      routeCtx(storage),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      jobId: TICK_CRON,
      scheduleId: TICK_CRON,
    });
    const rows = new SqlJobRunRecordStore(storage.sql).listByJob(TICK_CRON);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: "tick",
      system: "worker-cron",
      outcome: "success",
    });
  });
});

describe("S5-P08 thinness of handleScheduledEvent and single-sourced routing", () => {
  it("handleScheduledEvent delegates to the entry-point runner and carries no dispatch literal", () => {
    const queue = source("src/server/routes/queue.ts");
    const start = queue.indexOf("export async function handleScheduledEvent");
    const end = queue.indexOf("export async function handleQueueBatch");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = queue.slice(start, end);
    expect(fn).toContain("resolveCronEntryPoint");
    expect(fn).toContain("runCronEntryPoint");
    for (const literal of [
      "research/scheduled-tick",
      "/reflection/run",
      "/adaptation/weights/run",
      "/knowledge/corpus-sync",
      "reports/index-backfill-sweep",
      "digest/run-due",
      "renewAllStoredETradeTokens(",
    ]) {
      expect(fn).not.toContain(literal);
    }
  });

  it("CRON_ENTRY_POINTS is single-sourced: exactly the S1 WORKER_CRONS", () => {
    expect(CRON_ENTRY_POINTS).toHaveLength(3);
    expect([...CRON_ENTRY_POINTS.map((e) => e.cron)].sort()).toEqual(
      [...WORKER_CRONS].sort(),
    );
    expect(
      CRON_ENTRY_POINTS.map((e) => `${e.cron}→${e.entryPoint}`).sort(),
    ).toEqual(
      [
        `${RENEW_CRON}→renewTokens`,
        `${RETENTION_CRON}→retention`,
        `${TICK_CRON}→tick`,
      ].sort(),
    );
  });
});

describe("S5-P09 S0 doc pins", () => {
  it("Q(b) records the CONFIRMED Option A decision on #3592", () => {
    const doc = source("docs/architecture/scheduling/3121-s0-inventory.md");
    const start = doc.indexOf("### Q(b)");
    const end = doc.indexOf("### Q(c)");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const qb = doc.slice(start, end);
    expect(qb).toContain("CONFIRMED");
    expect(qb).toContain("Option A");
    expect(qb).toContain("#3592");
    expect(qb).toContain("6708544001");
  });

  it("§1.2 names seven dispatches including the reports-index-backfill sweep", () => {
    const doc = source("docs/architecture/scheduling/3121-s0-inventory.md");
    const start = doc.indexOf("### 1.2");
    const end = doc.indexOf("### 1.3");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fanout = doc.slice(start, end);
    expect(fanout).toContain("reports-index-backfill");
    expect(fanout.toLowerCase()).toContain("seven dispatches");
    expect(fanout).toContain("index-backfill-sweep");
  });

  it("§9 carries the S5 landed rows", () => {
    const doc = source("docs/architecture/scheduling/3121-s0-inventory.md");
    const start91 = doc.indexOf("### 9.1");
    const end91 = doc.indexOf("### 9.2");
    expect(start91).toBeGreaterThan(-1);
    const section91 = doc.slice(start91, end91);
    expect(section91).toContain("S5 — landed");
    const start94 = doc.indexOf("### 9.4");
    const end94 = doc.indexOf("### 9.5");
    expect(start94).toBeGreaterThan(-1);
    const section94 = doc.slice(start94, end94);
    expect(section94).toContain("S5 — landed");
    expect(section94).not.toContain("S5 (planned)");
  });
});
