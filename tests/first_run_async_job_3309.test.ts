/**
 * Issue #3309 — first-run setup fails on every refresh.
 *
 * The owner's live Network read (2026-11-06) proved the cause: POST
 * /api/platform/accounts/setup returns 202 Accepted with an async-job
 * receipt, and the client required a 200 body with `created`. This
 * file pins the two halves of the fix that no 200-only test can:
 *
 * (a) AOP: the job-failed / job-timeout outcomes are coded messages —
 *     the codes resolve in the single outcome catalog, and the tests
 *     assert the message comes FROM the catalog (the #2573 precedent:
 *     structural classification, never raw text).
 * (b) 15-factor parity (F9): the prod 202 path reproduced locally,
 *     end to end — the setup POST is enqueued as an http.request job
 *     through the real HTTP-entry door, the job executes through the
 *     real platform-accounts route, and the completed job carries the
 *     {created, identity} body the client polls for. A 200-only local
 *     run is what hid this bug; this test is the recurrence guard.
 *     The job lifecycle is audible: queued → started → completed.
 *     A second session cannot read the first session's job (F15).
 */
import { describe, expect, it, vi } from "vitest";
import { enqueueHttpRequest } from "../src/agents/orchestrator/httpEntry";
import {
  executeAsyncJob,
  getAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import {
  handlePlatformAccountRoutes,
  type PlatformAccountPorts,
  type PlatformAccountRouteContext,
} from "../src/agents/routes/platformAccounts";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryStoreOperatorsAdapter } from "../src/data/inMemoryStoreOperatorsAdapter";
import { InMemoryOnboardingAdapter } from "../src/data/inMemoryOnboardingAdapter";
import { resolveOutcome, codedMessage } from "../src/outcomes/outcomeAspects";
import { FakeAsyncSql, makeAsyncCtx } from "./async-job-testkit";

const LOGIN = "parity-user-3309";

function makePorts(): PlatformAccountPorts {
  return {
    commercial: new InMemoryCommercialAdapter(),
    subscriptions: new InMemorySubscriptionAdapter(),
    prices: new InMemoryPriceCatalogueAdapter({ stock: 0.02, options: 0.05 }),
    operators: new InMemoryStoreOperatorsAdapter(),
    onboarding: new InMemoryOnboardingAdapter(),
  };
}

/** The real platform-accounts route as the job executor's routeRequest. */
function makePlatformRouteRequest(ports: PlatformAccountPorts) {
  const routeCtx: PlatformAccountRouteContext = {
    env: {} as never,
    audit: vi.fn(),
    ports,
  };
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const res = await handlePlatformAccountRoutes(request, url, url.pathname, "session-1", routeCtx);
    return res ?? new Response(JSON.stringify({ error: "no route matched" }), { status: 404 });
  };
}

describe("async-job outcome codes (#3309, AOP)", () => {
  it("FAILURE_ASYNC_JOB_STILL_PROCESSING resolves: failure, 408, retryable, catalog text", () => {
    const resolved = resolveOutcome("FAILURE_ASYNC_JOB_STILL_PROCESSING");
    expect(resolved.resolved).toBe(true);
    expect(resolved.entry?.outcome).toBe("failure");
    expect(resolved.entry?.httpStatus).toBe(408);
    expect(resolved.entry?.retryable).toBe(true);
    expect(resolved.entry?.category).toBe("job");
    expect(resolved.entry?.businessMessage).toBe(
      "Your request is still being processed. It will continue in the background — try again shortly.",
    );
    expect(codedMessage("FAILURE_ASYNC_JOB_STILL_PROCESSING")).toBe(
      "[FAILURE_ASYNC_JOB_STILL_PROCESSING] Your request is still being processed. It will continue in the background — try again shortly.",
    );
  });

  it("FAILURE_ASYNC_JOB_FAILED resolves: failure, 500, retryable, catalog text", () => {
    const resolved = resolveOutcome("FAILURE_ASYNC_JOB_FAILED");
    expect(resolved.resolved).toBe(true);
    expect(resolved.entry?.outcome).toBe("failure");
    expect(resolved.entry?.httpStatus).toBe(500);
    expect(resolved.entry?.retryable).toBe(true);
    expect(resolved.entry?.category).toBe("job");
    expect(resolved.entry?.businessMessage).toBe(
      "The background request could not be completed. Try again.",
    );
    expect(codedMessage("FAILURE_ASYNC_JOB_FAILED")).toBe(
      "[FAILURE_ASYNC_JOB_FAILED] The background request could not be completed. Try again.",
    );
  });
});

describe("setup 202 parity: enqueue → execute → completed (#3309)", () => {
  it("the queued setup job completes through the real route with {created, identity}", async () => {
    const sql = new FakeAsyncSql();
    const { ctx, audit } = makeAsyncCtx(sql);
    const ports = makePorts();
    const parityCtx = {
      ...ctx,
      routeRequest: makePlatformRouteRequest(ports),
    } as unknown as AsyncJobsContext;

    const request = new Request("https://agent.openaimp.com/api/platform/accounts/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-login": LOGIN },
      body: JSON.stringify({}),
    });
    const queued = await enqueueHttpRequest(
      {
        sessionKey: () => "session-1",
        recordMessage: () => {},
        addMessages: async () => ({}),
        submitAsyncJob: (job) => submitAsyncJob(ctx, job),
      },
      request,
      new URL(request.url),
    );
    expect(queued.status).toBe(202);
    const receipt = (await queued.json()) as { jobId: string; status: string; statusUrl: string };
    expect(receipt.status).toBe("queued");
    expect(receipt.statusUrl).toBe(`/api/jobs/${receipt.jobId}`);

    await executeAsyncJob(parityCtx, { jobId: receipt.jobId });

    const job = getAsyncJob(parityCtx, receipt.jobId);
    expect(job?.status).toBe("completed");
    expect(job?.responseStatus).toBe(200);
    const result = JSON.parse(String((job?.result as { body?: string } | undefined)?.body ?? "{}")) as {
      created?: unknown;
      identity?: { userLogin?: unknown; hasAccount?: unknown };
    };
    expect(result.created).toBe(true);
    expect(result.identity?.userLogin).toBe(LOGIN);
    expect(result.identity?.hasAccount).toBe(true);

    const audited = audit.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(audited).toContain("async_job.queued");
    expect(audited).toContain("async_job.started");
    expect(audited).toContain("async_job.completed");
  });

  it("a second session cannot read the first session's job", async () => {
    const sql = new FakeAsyncSql();
    const { ctx } = makeAsyncCtx(sql, "session-1");
    const ports = makePorts();
    const parityCtx = {
      ...ctx,
      routeRequest: makePlatformRouteRequest(ports),
    } as unknown as AsyncJobsContext;
    const request = new Request("https://agent.openaimp.com/api/platform/accounts/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-login": LOGIN },
      body: JSON.stringify({}),
    });
    const queued = await enqueueHttpRequest(
      {
        sessionKey: () => "session-1",
        recordMessage: () => {},
        addMessages: async () => ({}),
        submitAsyncJob: (job) => submitAsyncJob(ctx, job),
      },
      request,
      new URL(request.url),
    );
    const receipt = (await queued.json()) as { jobId: string };
    await executeAsyncJob(parityCtx, { jobId: receipt.jobId });

    const other = makeAsyncCtx(sql, "session-2");
    expect(getAsyncJob(other.ctx, receipt.jobId)).toBeUndefined();
  });
});
