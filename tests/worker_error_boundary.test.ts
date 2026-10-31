import { describe, it, expect, vi } from "vitest";
import { classifyError, withErrorBoundary } from "../src/security/workerErrorBoundary";

/**
 * Issue #329 — Cloudflare 1101 is what a visitor saw when the Worker's fetch
 * handler threw (the KV quota error). The boundary must turn every escaped
 * failure into an HTTP response, and must label the quota case so the UI can
 * say "retry shortly" instead of showing an edge error page.
 */
const request = new Request("https://agent.openaimp.com/api/nlq");

describe("worker error boundary (#329)", () => {
  it("passes successful responses through untouched", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const wrapped = withErrorBoundary(handler);

    const res = await wrapped(request, {});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("turns a KV quota throw into 503 with a retryable code", async () => {
    const wrapped = withErrorBoundary(async () => {
      throw new Error("KV get() limit exceeded for the day.");
    }, { log: () => undefined });

    const res = await wrapped(request, {});
    const body = (await res.json()) as { code: string; error: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe("kv_quota_exhausted");
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("turns any other throw into 500 FAILURE_UNEXPECTED_ERROR via the outcome catalog (#2572)", async () => {
    const wrapped = withErrorBoundary(async () => {
      throw new TypeError("boom");
    }, { log: () => undefined });

    const res = await wrapped(request, {});
    const body = (await res.json()) as { code: string; error: string };

    expect(res.status).toBe(500);
    expect(body.code).toBe("FAILURE_UNEXPECTED_ERROR");
    expect(body.error).toBe(
      "[FAILURE_UNEXPECTED_ERROR] An unexpected error occurred. Our team has been notified."
    );
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("never leaks the original error text into the 500 body, but still logs it (#2572)", async () => {
    const log = vi.fn();
    const wrapped = withErrorBoundary(async () => {
      throw new Error("secret-technical-detail-12345");
    }, { log });

    const res = await wrapped(request, {});
    const body = (await res.json()) as { code: string; error: string };

    expect(res.status).toBe(500);
    expect(body.error).not.toContain("secret-technical-detail-12345");
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("secret-technical-detail-12345");
    expect(String(log.mock.calls[0][0])).toContain("FAILURE_UNEXPECTED_ERROR");
  });

  it("honours a thrown Response instead of wrapping it", async () => {
    const wrapped = withErrorBoundary(async () => {
      throw Response.redirect("https://agent.openaimp.com/", 302);
    }, { log: () => undefined });

    const res = await wrapped(request, {});

    expect(res.status).toBe(302);
  });

  it("handles non-Error throws without escaping", async () => {
    const wrapped = withErrorBoundary(async () => {
      throw "string failure";
    }, { log: () => undefined });

    const res = await wrapped(request, {});
    expect(res.status).toBe(500);
  });

  it("logs once per failure with the route", async () => {
    const log = vi.fn();
    const wrapped = withErrorBoundary(async () => {
      throw new Error("KV get() limit exceeded for the day.");
    }, { log });

    await wrapped(request, {});

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("/api/nlq");
  });

  it("classifies the quota wording, not the transport", () => {
    expect(classifyError(new Error("KV get() limit exceeded for the day.")).status).toBe(503);
    expect(classifyError(new Error("unrelated")).status).toBe(500);
    expect(classifyError(new Error("unrelated")).body).toEqual({
      error: "[FAILURE_UNEXPECTED_ERROR] An unexpected error occurred. Our team has been notified.",
      code: "FAILURE_UNEXPECTED_ERROR",
    });
  });
});
