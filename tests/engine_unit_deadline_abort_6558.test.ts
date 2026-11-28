// @vitest-environment node
/**
 * Issue #6558 (F3) — engine units abort on stage deadline.
 *
 * The engine's own header stated the gap verbatim: a unit past
 * its stage deadline is recorded timed_out and the run fails,
 * but the underlying step promise is not cancellable, so its
 * late writes may still land. This file pins the fix, at the
 * engine-unit layer (so it covers both hosts — the Workflow
 * host's step.do journal and the DO host's inline dispatch):
 *
 * - a deadline-fired staged unit stops: the deadline aborts the
 *   unit's signal and a step observing it stops its in-flight
 *   work, while the run still fails with the unit timed_out (the
 *   `timed_out` outcome contract is unchanged);
 * - the async mode (`runAsyncUnit`, F1) carries the caller's
 *   signal into the step's context, so a capability step
 *   observing it stops when the executor's deadline fires;
 * - the executor deadline itself carries the signal (transferred
 *   from the #6546 prototype, re-applied onto the converged
 *   path): a deadline-fired http.request leg stops via its
 *   Request signal and the row still fails with
 *   FAILURE_ASYNC_JOB_TIMEOUT;
 * - the race-site pin: every Promise.race against the executor
 *   deadline carries an abort path, or is recorded here as
 *   un-abortable with a reason. A new race site without one
 *   trips the pin.
 *
 * Per-leg abort status (#6558, converged path):
 * - Staged engine units — the unit signal (this slice, proven
 *   below): `JobStepContext.signal`, aborted by `withUnitDeadline`.
 * - Async engine units (`runAsyncUnit`) — the request signal
 *   (this slice, proven below): the executor passes its deadline
 *   signal; the step observes it.
 * - http.request — Request signal (this slice, proven below).
 * - mcp.tool — signal threaded into the tool context (this
 *   slice); per-tool consumption (each tool's fetch opting in)
 *   is follow-up work, not this slice.
 * - followup.report / serveReportStage — UN-ABORTABLE: local ORM
 *   reads only, no outbound I/O; the race is a backstop.
 * - followup.deliver notify + deliver, followup.notify — signal
 *   threaded into the delivery-port input (this slice); transport
 *   consumption (the sends behind the port) is follow-up work.
 * - shard.execute, feed.snapshot, nlq.execute — signal threaded
 *   into the leg's entry deps/options (this slice); the internal
 *   provider fetches (engine/agents/screener) do not consume it
 *   yet — follow-up work, not this slice.
 * - task.draft — no race site: a synchronous draft, no I/O to
 *   abort; nothing to thread.
 * - Wait steps (`wait.event`, `wait.sleep`) bypass the stage
 *   deadline by design (a 600s default would kill an approval
 *   wait) — they carry no abort signal; the exemption is pinned
 *   below, not assumed.
 *
 * Harness mirrors tests/job_pipeline_stage_control_3549.test.ts
 * (engine) and tests/async_capability_engine_6554.test.ts
 * (executor legs).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { BusinessError } from "../src/outcomes/outcomeAspects";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type AsyncUnitRequest,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import {
  createAsyncCapabilityEngine,
  createExecutionDeadline,
  executeAsyncJob,
  FAILURE_ASYNC_JOB_TIMEOUT_CODE,
  getAsyncJob,
  resolveAsyncJobMaxRuntimeMs,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { MockD1Database } from "./mock-d1";
import { FakeAsyncSql, makeAsyncCtx } from "./async-job-testkit";

/** The step-context abort seam, as the engine exposes it. */
type StepWithSignal = JobStepContext & { signal?: AbortSignal };

function makeEngineHarness(steps: ReturnType<typeof createBuiltinStepRegistry>) {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const deps: JobPipelineDeps = {
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps,
  };
  return { control: createJobPipelineControl(deps) };
}

describe("engine unit deadline aborts the step signal (#6558)", () => {
  it("a deadline-fired staged unit stops via its signal and still records timed_out", async () => {
    let seenSignal: AbortSignal | undefined;
    let settledVia: "abort" | "ran-on" | "pending" = "pending";
    const steps = createBuiltinStepRegistry();
    steps.register("hanging", async (ctx) => {
      const signal = (ctx as StepWithSignal).signal;
      seenSignal = signal;
      if (!signal) {
        // No abort seam: the step runs on past its deadline.
        await new Promise((resolve) => setTimeout(resolve, 50));
        settledVia = "ran-on";
        return { output: { stopped: false } };
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          settledVia = "abort";
          resolve();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            settledVia = "abort";
            resolve();
          },
          { once: true },
        );
      });
      return { output: { stopped: true } };
    });
    const h = makeEngineHarness(steps);
    await h.control.defineJob({
      jobId: "abort-job",
      root: {
        kind: "dummy",
        steps: [{ step: "hanging" }],
        timeoutMs: 10,
        executionMode: { delivery: "sync" },
      },
    });
    const outcome = await h.control.runJob("abort-job");
    // The run still fails on deadline — the fix stops the
    // abandoned work, it does not change the outcome.
    expect(outcome.state).toBe("failed");
    const view = await h.control.getJob("abort-job");
    expect(view.stages[0]?.units[0]?.status).toBe("timed_out");
    // The step stopped via its abort, not via its own completion.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seenSignal).toBeDefined();
    expect(seenSignal?.aborted).toBe(true);
    expect((seenSignal?.reason as { code?: unknown } | undefined)?.code).toBe(
      "job_stage_timed_out",
    );
    expect(settledVia).toBe("abort");
  });

  it("a fast staged step completes and its signal is never aborted", async () => {
    let seenSignal: AbortSignal | undefined;
    const steps = createBuiltinStepRegistry();
    steps.register("fast", async (ctx) => {
      seenSignal = (ctx as StepWithSignal).signal;
      return { output: { ok: true } };
    });
    const h = makeEngineHarness(steps);
    await h.control.defineJob({
      jobId: "fast-job",
      root: {
        kind: "dummy",
        steps: [{ step: "fast" }],
        timeoutMs: 5000,
        executionMode: { delivery: "sync" },
      },
    });
    const outcome = await h.control.runJob("fast-job");
    expect(outcome.state).toBe("completed");
    expect(seenSignal).toBeDefined();
    expect(seenSignal?.aborted).toBe(false);
  });

  it("runAsyncUnit carries the request signal into the step context", async () => {
    let seenSignal: AbortSignal | undefined;
    let settledVia: "abort" | "complete" | "pending" = "pending";
    const steps = createBuiltinStepRegistry();
    steps.register("async.capability.http.request", async (ctx) => {
      const signal = (ctx as StepWithSignal).signal;
      seenSignal = signal;
      if (!signal) {
        settledVia = "complete";
        return { output: { stopped: false } };
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          settledVia = "abort";
          resolve();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            settledVia = "abort";
            resolve();
          },
          { once: true },
        );
      });
      return { output: { stopped: true } };
    });
    const h = makeEngineHarness(steps);
    const controller = new AbortController();
    const request = {
      capability: "http.request",
      input: {},
      asyncJobId: "job-async-abort",
    } as AsyncUnitRequest & { signal?: AbortSignal };
    request.signal = controller.signal;
    const outcomePromise = h.control.runAsyncUnit(request);
    setTimeout(() => controller.abort(new Error("deadline fired")), 10);
    const outcome = await outcomePromise;
    expect(outcome.state).toBe("completed");
    expect(outcome.output).toMatchObject({ stopped: true });
    expect(seenSignal).toBe(controller.signal);
    expect(settledVia).toBe("abort");
  });

  it("runAsyncUnit carries a coded step failure's code across the boundary", async () => {
    const steps = createBuiltinStepRegistry();
    steps.register("async.capability.http.request", async () => {
      throw new BusinessError(FAILURE_ASYNC_JOB_TIMEOUT_CODE, { maxRuntimeMs: 60 });
    });
    const h = makeEngineHarness(steps);
    const outcome = await h.control.runAsyncUnit({
      capability: "http.request",
      input: {},
      asyncJobId: "job-async-coded",
    });
    expect(outcome.state).toBe("failed");
    // The message alone carries no code (BusinessError.message is
    // the business message); the code rides errorCode, so the
    // executor can render the row's coded failure from it.
    expect(outcome.error).not.toContain(FAILURE_ASYNC_JOB_TIMEOUT_CODE);
    expect(outcome.errorCode).toBe(FAILURE_ASYNC_JOB_TIMEOUT_CODE);
  });

  it("runAsyncUnit without a signal leaves the step context signal-less (no deadline, no abort)", async () => {
    let seenSignal: AbortSignal | undefined = undefined;
    let sawField = false;
    const steps = createBuiltinStepRegistry();
    steps.register("async.capability.http.request", async (ctx) => {
      sawField = "signal" in ctx;
      seenSignal = (ctx as StepWithSignal).signal;
      return { output: { ok: true } };
    });
    const h = makeEngineHarness(steps);
    const outcome = await h.control.runAsyncUnit({
      capability: "http.request",
      input: {},
      asyncJobId: "job-async-no-signal",
    });
    expect(outcome.state).toBe("completed");
    expect(sawField).toBe(false);
    expect(seenSignal).toBeUndefined();
  });
});

describe("deadline signal (#6558, transferred from #6546)", () => {
  it("aborts the signal when the deadline fires, with the timeout error as reason", async () => {
    const deadline = createExecutionDeadline(10) as ReturnType<typeof createExecutionDeadline> & {
      signal: AbortSignal;
    };
    // Attach the race handler FIRST: if an assertion below throws,
    // the deadline's rejection is already handled and never
    // surfaces as an unhandled rejection.
    const settled = Promise.race([
      deadline.promise,
      new Promise((resolve) => setTimeout(() => resolve("no-fire" as const), 100)),
    ]);
    settled.then(
      () => {},
      () => {},
    );
    expect(deadline.signal.aborted).toBe(false);
    const error = await settled.then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).not.toBeNull();
    expect((error as { code?: unknown }).code).toBe(FAILURE_ASYNC_JOB_TIMEOUT_CODE);
    // The abort is the same event as the rejection: the signal fires
    // with the timeout error as its reason, so a leg awaiting the
    // signal sees the cataloged code, not a bare AbortError.
    expect(deadline.signal.aborted).toBe(true);
    expect((deadline.signal.reason as { code?: unknown }).code).toBe(
      FAILURE_ASYNC_JOB_TIMEOUT_CODE,
    );
    deadline.cancel();
  });

  it("a fast leg wins the race and the signal is never aborted", async () => {
    const deadline = createExecutionDeadline(500) as ReturnType<typeof createExecutionDeadline> & {
      signal: AbortSignal;
    };
    const fastLeg = Promise.resolve("done");
    await expect(Promise.race([fastLeg, deadline.promise])).resolves.toBe("done");
    deadline.cancel();
    expect(deadline.signal.aborted).toBe(false);
    const outcome = await Promise.race([
      deadline.promise.then(
        () => "fired" as const,
        () => "fired" as const,
      ),
      new Promise((resolve) => setTimeout(() => resolve("no-fire" as const), 30)),
    ]);
    expect(outcome).toBe("no-fire");
    expect(deadline.signal.aborted).toBe(false);
  });

  it("a disabled deadline (0) never aborts its signal", async () => {
    const deadline = createExecutionDeadline(0) as ReturnType<typeof createExecutionDeadline> & {
      signal: AbortSignal;
    };
    expect(deadline.signal.aborted).toBe(false);
    const outcome = await Promise.race([
      deadline.promise.then(
        () => "fired" as const,
        () => "fired" as const,
      ),
      new Promise((resolve) => setTimeout(() => resolve("no-fire" as const), 30)),
    ]);
    expect(outcome).toBe("no-fire");
    expect(deadline.signal.aborted).toBe(false);
    deadline.cancel();
  });

  it("the env resolver still parses a fractional-minute deadline (the test seam)", () => {
    // 0.001 minutes = 60 ms: the executor test below fires the
    // deadline on fake timers without waiting out a real minute.
    expect(resolveAsyncJobMaxRuntimeMs({ ASYNC_JOB_MAX_RUNTIME_MINUTES: "0.001" })).toBe(60);
  });
});

describe("deadline-fired leg stops (#6558, transferred from #6546)", () => {
  function makeHarness() {
    const sql = new FakeAsyncSql();
    const { ctx } = makeAsyncCtx(sql, "owner-login-1");
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("test_session_user");
    const engine = createAsyncCapabilityEngine();
    const harnessCtx = ctx as unknown as AsyncJobsContext & Record<string, unknown>;
    harnessCtx.env = {
      AGENT_DB: new MockD1Database(),
      ASYNC_JOB_MAX_RUNTIME_MINUTES: "0.001",
    };
    harnessCtx.getOrm = () => orm as never;
    harnessCtx.routeRequest = vi.fn(async () => new Response("ok", { status: 200 })) as never;
    harnessCtx.engine = engine.control as never;
    return { sql, ctx: harnessCtx as unknown as AsyncJobsContext, engine };
  }

  it("an http.request leg's fetch aborts when the deadline fires, and the row still fails with FAILURE_ASYNC_JOB_TIMEOUT", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      // A hung leg that behaves like a fetch: it settles ONLY when
      // its request's signal aborts, and records how it settled.
      let capturedSignal: AbortSignal | undefined;
      let settledVia: "abort" | "complete" | "pending" = "pending";
      (h.ctx.routeRequest as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (request: Request) =>
          new Promise<Response>((_resolve, reject) => {
            capturedSignal = request.signal;
            request.signal.addEventListener("abort", () => {
              settledVia = "abort";
              reject(request.signal.reason);
            });
          }),
      );
      const submitted = await submitAsyncJob(h.ctx, {
        capability: "http.request",
        payload: { method: "GET", pathAndQuery: "/api/ping" },
      } as never);
      const run = executeAsyncJob(h.ctx, { jobId: submitted.jobId });
      // The deadline is 60 ms of fake time; the leg would hang
      // forever without the abort.
      await vi.advanceTimersByTimeAsync(61);
      await run;
      // The leg stopped via its abort, not via its own completion.
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(true);
      expect(settledVia).toBe("abort");
      // The #3907 outcome contract is unchanged: the row goes
      // terminal with the cataloged timeout code.
      const row = getAsyncJob(h.ctx, submitted.jobId);
      expect(row?.status).toBe("failed");
      expect(row?.errorCode).toBe(FAILURE_ASYNC_JOB_TIMEOUT_CODE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fast http.request leg completes and its signal is never aborted", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      let capturedSignal: AbortSignal | undefined;
      (h.ctx.routeRequest as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (request: Request) => {
          capturedSignal = request.signal;
          return new Response("ok", { status: 200 });
        },
      );
      const submitted = await submitAsyncJob(h.ctx, {
        capability: "http.request",
        payload: { method: "GET", pathAndQuery: "/api/ping" },
      } as never);
      const run = executeAsyncJob(h.ctx, { jobId: submitted.jobId });
      await vi.advanceTimersByTimeAsync(61);
      await run;
      const row = getAsyncJob(h.ctx, submitted.jobId);
      expect(row?.status).toBe("completed");
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("deadline race-site pin (#6558)", () => {
  const EXECUTOR_SOURCE = readFileSync(
    join(process.cwd(), "src/agents/orchestrator/asyncJobs.ts"),
    "utf8",
  );
  const ENGINE_SOURCE = readFileSync(
    join(process.cwd(), "src/services/jobPipelineEngine.ts"),
    "utf8",
  );
  const STEPS_SOURCE = readFileSync(
    join(process.cwd(), "src/services/jobPipelineSteps.ts"),
    "utf8",
  );
  const RACE_SITES = (EXECUTOR_SOURCE.match(/executionDeadline\.promise/g) ?? []).length;
  const SIGNAL_SITES = (EXECUTOR_SOURCE.match(/executionDeadline\.signal/g) ?? []).length;

  it("nine legs race the executor deadline — a tenth trips the pin", () => {
    expect(RACE_SITES).toBe(9);
  });

  it("nine signal sites thread the deadline signal — eight leg sites plus the engine-unit seam", () => {
    // Eight leg race sites thread the signal (http, mcp, deliver
    // notify, deliver, notify, shard, feed, nlq); the ninth is
    // the runAsyncUnit call, which carries the deadline signal
    // into the engine unit. The one signal-less race site is
    // serveReportStage (local ORM reads, no outbound I/O),
    // asserted below. A new race site without an abort path, or
    // a dropped threading, trips this pin.
    expect(SIGNAL_SITES).toBe(9);
  });

  it("the one signal-less site is the followup.report serveReportStage (local ORM reads, no outbound I/O)", () => {
    const serveAt = EXECUTOR_SOURCE.indexOf("serveReportStage({");
    expect(serveAt).toBeGreaterThan(-1);
    const nextPromise = EXECUTOR_SOURCE.indexOf("executionDeadline.promise", serveAt);
    expect(nextPromise).toBeGreaterThan(serveAt);
    expect(EXECUTOR_SOURCE.slice(serveAt, nextPromise)).not.toContain("executionDeadline.signal");
  });

  it("the engine's unit deadline aborts its signal when it fires", () => {
    const start = ENGINE_SOURCE.indexOf("private async withUnitDeadline");
    expect(start).toBeGreaterThan(-1);
    const end = ENGINE_SOURCE.indexOf("private async deriveResumePosition", start);
    expect(end).toBeGreaterThan(start);
    const body = ENGINE_SOURCE.slice(start, end);
    expect(body).toContain("new AbortController");
    expect(body).toContain("controller.abort(");
  });

  it("the step context carries the abort signal (the unit's seam)", () => {
    expect(STEPS_SOURCE).toContain("signal?: AbortSignal");
  });

  it("the async-unit request carries the caller's signal (the converged seam)", () => {
    const start = ENGINE_SOURCE.indexOf("export interface AsyncUnitRequest");
    expect(start).toBeGreaterThan(-1);
    const end = ENGINE_SOURCE.indexOf("export interface AsyncUnitOutcome", start);
    expect(end).toBeGreaterThan(start);
    expect(ENGINE_SOURCE.slice(start, end)).toContain("signal?: AbortSignal");
  });

  it("wait steps bypass the stage deadline by design — the exemption is explicit, not a gap", () => {
    const start = ENGINE_SOURCE.indexOf("private async runUnit");
    expect(start).toBeGreaterThan(-1);
    const end = ENGINE_SOURCE.indexOf("Race a unit's execution against its stage deadline", start);
    expect(end).toBeGreaterThan(start);
    const body = ENGINE_SOURCE.slice(start, end);
    expect(body).toContain("WAIT_EVENT_STEP");
    expect(body).toContain("WAIT_SLEEP_STEP");
  });
});
