import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, DEFAULT_ASYNC_JOB_POLL_CONFIG } from "../src/client/apiFetch";

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
