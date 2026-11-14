import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  ApiFetchTimeoutError,
  DEFAULT_ASYNC_JOB_POLL_CONFIG,
  isApiFetchTimeoutError,
} from "../src/client/apiFetch";

describe("apiFetch async job compatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ordinary responses without polling", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", nativeFetch);

    const response = await apiFetch("/api/jobs");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("polls a queued HTTP job and reconstructs the original response", async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { jobId: "job-1", status: "queued", statusUrl: "/api/jobs/job-1" },
        { status: 202 },
      ))
      .mockResolvedValueOnce(Response.json({
        jobId: "job-1",
        capability: "http.request",
        status: "completed",
        responseStatus: 201,
        result: { body: JSON.stringify({ created: true }), headers: { "content-type": "application/json" } },
      }));
    vi.stubGlobal("fetch", nativeFetch);

    const responsePromise = apiFetch("/api/example", { method: "POST" });
    await vi.waitFor(() => expect(nativeFetch).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    const response = await responsePromise;

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ created: true });
  });

  it("surfaces a failed background job as an explicit error response", async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { jobId: "job-2", status: "queued", statusUrl: "/api/jobs/job-2" },
        { status: 202 },
      ))
      .mockResolvedValueOnce(Response.json({
        jobId: "job-2",
        capability: "http.request",
        status: "failed",
        error: "Provider unavailable",
      }));
    vi.stubGlobal("fetch", nativeFetch);

    const responsePromise = apiFetch("/api/example");
    await vi.waitFor(() => expect(nativeFetch).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    const response = await responsePromise;

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ jobId: "job-2", error: "Provider unavailable" });
  });

  it("exposes the poll timing as configuration, not literals (#3309, factor 5)", async () => {
    expect(DEFAULT_ASYNC_JOB_POLL_CONFIG).toEqual({
      initialDelayMs: 500,
      maxDelayMs: 5000,
      backoffFactor: 1.5,
      deadlineMs: 10 * 60 * 1000,
    });
  });

  it("returns a 408 with the job receipt when the job is still running at the deadline (#3309)", async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { jobId: "job-3", status: "queued", statusUrl: "/api/jobs/job-3" },
        { status: 202 },
      ))
      // Fresh Response per poll: a shared instance would be
      // body-consumed after the first poll read.
      .mockImplementation(() => Promise.resolve(Response.json({
        jobId: "job-3",
        capability: "http.request",
        status: "running",
      })));
    vi.stubGlobal("fetch", nativeFetch);

    const response = await apiFetch(
      "/api/example",
      { method: "POST" },
      { deadlineMs: 1200, initialDelayMs: 100, maxDelayMs: 100 },
    );

    expect(response.status).toBe(408);
    const body = (await response.json()) as { jobId?: string; statusUrl?: string; error?: string };
    expect(body.jobId).toBe("job-3");
    expect(body.statusUrl).toBe("/api/jobs/job-3");
    expect(typeof body.error).toBe("string");
    expect(nativeFetch.mock.calls.length).toBeGreaterThan(2);
  });
});

describe("apiFetch opt-in request timeout (#4513)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A fetch implementation that never answers unless its signal aborts, like a hung request. */
  function hangUntilAborted(_input: unknown, init?: RequestInit): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });
  }

  it("rejects with ApiFetchTimeoutError when the initial fetch never returns", async () => {
    vi.stubGlobal("fetch", vi.fn(hangUntilAborted));

    const started = Date.now();
    const error = await apiFetch("/api/example", undefined, undefined, { timeoutMs: 25 }).catch(
      (err: unknown) => err,
    );

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(ApiFetchTimeoutError);
    expect((error as ApiFetchTimeoutError).timeoutMs).toBe(25);
    expect(isApiFetchTimeoutError(error)).toBe(true);
    expect(isApiFetchTimeoutError(new Error("other"))).toBe(false);
  });

  it("rejects with ApiFetchTimeoutError when a 202 status poll never returns", async () => {
    const nativeFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { jobId: "job-t", status: "queued", statusUrl: "/api/jobs/job-t" },
          { status: 202 },
        ),
      )
      .mockImplementation(hangUntilAborted);
    vi.stubGlobal("fetch", nativeFetch);

    const error = await apiFetch(
      "/api/example",
      undefined,
      { initialDelayMs: 10, maxDelayMs: 10 },
      { timeoutMs: 25 },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiFetchTimeoutError);
    expect(nativeFetch.mock.calls.length).toBe(2);
  });

  it("returns the response when a slow fetch completes within the timeout", async () => {
    const nativeFetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", nativeFetch);

    const response = await apiFetch("/api/example", undefined, undefined, { timeoutMs: 1_000 });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const init = nativeFetch.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes no timeout signal when the caller does not opt in", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", nativeFetch);

    await apiFetch("/api/example");

    expect(nativeFetch).toHaveBeenCalledTimes(1);
    const init = nativeFetch.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeUndefined();
  });

  it("still honors a caller signal that aborts before the timeout", async () => {
    const controller = new AbortController();
    const nativeFetch = vi.fn(hangUntilAborted);
    vi.stubGlobal("fetch", nativeFetch);

    const pending = apiFetch("/api/example", { signal: controller.signal }, undefined, {
      timeoutMs: 1_000,
    }).catch((err: unknown) => err);
    controller.abort();
    const error = await pending;

    expect(error).not.toBeInstanceOf(ApiFetchTimeoutError);
    expect(error).toBeInstanceOf(DOMException);
  });
});
