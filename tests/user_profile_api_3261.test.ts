/**
 * Issue #3261 — profileApi coded-error contract (AOP, #1969 program).
 *
 * The client renders the server's coded body verbatim: a coded
 * failure becomes a ProfileApiError carrying the server's code +
 * message (+ field when the server names one); an uncoded body or
 * a network failure falls back to one fixed generic string per
 * operation (the #2573 ACCOUNT_PANEL_FALLBACK_MESSAGE precedent).
 * A 409 FAILURE_PROFILE_DUPLICATE refetches the profile — the
 * save already landed — instead of surfacing an error.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  fetchProfile,
  newIdempotencyKey,
  ProfileApiError,
  saveProfile,
} from "../src/client/profileApi";
import { getOutcome, codedMessage } from "../src/outcomes/outcomeAspects";

const catalogMessage = (code: string): string => getOutcome(code)!.businessMessage;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const VIEW = {
  userLogin: "prof-api-a",
  displayName: "Ada",
  phone: "+1 555-0100",
  updatedAtMs: 1234,
};

let fetchCalls: { url: string; init?: RequestInit }[] = [];
let fetchQueue: (Response | Error)[] = [];

function stubFetch(queue: (Response | Error)[]) {
  fetchQueue = [...queue];
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      const next = fetchQueue.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("fetch queue exhausted");
      return next;
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchProfile (#3261)", () => {
  it("returns the view, ignoring the coded envelope fields", async () => {
    stubFetch([
      jsonResponse(200, {
        code: "SUCCESS_PROFILE_READ",
        message: catalogMessage("SUCCESS_PROFILE_READ"),
        ...VIEW,
      }),
    ]);
    await expect(fetchProfile()).resolves.toEqual(VIEW);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("/api/platform/accounts/profile");
  });

  it("surfaces a coded 401 as a ProfileApiError with the catalog message", async () => {
    stubFetch([
      jsonResponse(401, {
        code: "FAILURE_PROFILE_NOT_SIGNED_IN",
        message: catalogMessage("FAILURE_PROFILE_NOT_SIGNED_IN"),
      }),
    ]);
    const err = await fetchProfile().catch((e) => e);
    expect(err).toBeInstanceOf(ProfileApiError);
    expect(err.code).toBe("FAILURE_PROFILE_NOT_SIGNED_IN");
    expect(err.status).toBe(401);
    expect(err.message).toBe(catalogMessage("FAILURE_PROFILE_NOT_SIGNED_IN"));
  });

  it("falls back to a fixed generic string for an uncoded body or a network failure", async () => {
    stubFetch([jsonResponse(500, { error: "boom: raw store text" })]);
    const uncoded = await fetchProfile().catch((e) => e);
    expect(uncoded).toBeInstanceOf(ProfileApiError);
    expect(uncoded.code).toBe("");
    expect(uncoded.message).toBe(
      "Your profile could not be loaded. Check your connection and try again.",
    );
    expect(uncoded.message).not.toContain("boom");

    stubFetch([new Error("network down")]);
    const offline = await fetchProfile().catch((e) => e);
    expect(offline).toBeInstanceOf(ProfileApiError);
    expect(offline.status).toBe(0);
    expect(offline.message).toBe(
      "Your profile could not be loaded. Check your connection and try again.",
    );
  });
});

describe("saveProfile (#3261)", () => {
  it("sends the idempotency key and returns the saved view with the coded message", async () => {
    stubFetch([
      jsonResponse(200, {
        code: "SUCCESS_PROFILE_UPDATED",
        message: catalogMessage("SUCCESS_PROFILE_UPDATED"),
        ...VIEW,
      }),
    ]);
    const result = await saveProfile({ displayName: "Ada" }, "key-api-1");
    expect(result.duplicate).toBe(false);
    expect(result.message).toBe(catalogMessage("SUCCESS_PROFILE_UPDATED"));
    expect(result.profile).toEqual(VIEW);
    expect(fetchCalls).toHaveLength(1);
    expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual({
      idempotencyKey: "key-api-1",
      displayName: "Ada",
    });
  });

  it("refetches on a 409 duplicate and returns the duplicate message, not an error", async () => {
    stubFetch([
      jsonResponse(409, {
        code: "FAILURE_PROFILE_DUPLICATE",
        message: catalogMessage("FAILURE_PROFILE_DUPLICATE"),
        duplicate: true,
      }),
      jsonResponse(200, {
        code: "SUCCESS_PROFILE_READ",
        message: catalogMessage("SUCCESS_PROFILE_READ"),
        ...VIEW,
      }),
    ]);
    const result = await saveProfile({ displayName: "Ada" }, "key-api-2");
    expect(result.duplicate).toBe(true);
    expect(result.message).toBe(catalogMessage("FAILURE_PROFILE_DUPLICATE"));
    expect(result.profile).toEqual(VIEW);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1].url).toBe("/api/platform/accounts/profile");
    expect(fetchCalls[1].init?.method).toBeUndefined();
  });

  it("surfaces a coded 400 with the failing field", async () => {
    stubFetch([
      jsonResponse(400, {
        code: "FAILURE_PROFILE_VALIDATION",
        message: catalogMessage("FAILURE_PROFILE_VALIDATION"),
        field: "phone",
      }),
    ]);
    const err = await saveProfile({ phone: "call me" }, "key-api-3").catch((e) => e);
    expect(err).toBeInstanceOf(ProfileApiError);
    expect(err.code).toBe("FAILURE_PROFILE_VALIDATION");
    expect(err.status).toBe(400);
    expect(err.field).toBe("phone");
    expect(err.message).toBe(catalogMessage("FAILURE_PROFILE_VALIDATION"));
  });

  it("throws (not refetches) on a 409 that is not a profile duplicate", async () => {
    stubFetch([jsonResponse(409, { code: "SOME_OTHER_CONFLICT", message: "other conflict" })]);
    const err = await saveProfile({ displayName: "Ada" }, "key-api-4").catch((e) => e);
    expect(err).toBeInstanceOf(ProfileApiError);
    expect(err.code).toBe("SOME_OTHER_CONFLICT");
    expect(fetchCalls).toHaveLength(1);
  });

  it("polls a 202 async-job receipt and returns the saved view once the job completes (#3309)", async () => {
    stubFetch([
      Response.json(
        { jobId: "job-3309", status: "queued", statusUrl: "/api/jobs/job-3309" },
        { status: 202 },
      ),
      Response.json({
        jobId: "job-3309",
        capability: "http.request",
        status: "completed",
        responseStatus: 200,
        result: {
          body: JSON.stringify({
            code: "SUCCESS_PROFILE_UPDATED",
            message: catalogMessage("SUCCESS_PROFILE_UPDATED"),
            ...VIEW,
          }),
          headers: { "content-type": "application/json" },
        },
      }),
    ]);
    const result = await saveProfile({ displayName: "Ada" }, "key-3309");
    expect(result.duplicate).toBe(false);
    expect(result.message).toBe(catalogMessage("SUCCESS_PROFILE_UPDATED"));
    expect(result.profile).toEqual(VIEW);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1].url).toBe("/api/jobs/job-3309");
  });

  it("a failed async job surfaces a coded error, never the raw job error text (#3309)", async () => {
    stubFetch([
      Response.json(
        { jobId: "job-3309", status: "queued", statusUrl: "/api/jobs/job-3309" },
        { status: 202 },
      ),
      Response.json({
        jobId: "job-3309",
        capability: "http.request",
        status: "failed",
        error: "D1 explode: raw store detail",
      }),
    ]);
    const err = await saveProfile({ displayName: "Ada" }, "key-3309").catch((e) => e);
    expect(err).toBeInstanceOf(ProfileApiError);
    expect(err.code).toBe("FAILURE_ASYNC_JOB_FAILED");
    expect(err.status).toBe(500);
    expect(err.message).toBe(codedMessage("FAILURE_ASYNC_JOB_FAILED"));
    expect(err.message).not.toContain("D1 explode");
  });

  it("a still-processing 408 surfaces the coded timeout message (#3309)", async () => {
    stubFetch([
      Response.json(
        {
          error: "The request is still processing. The job will continue in the background.",
          jobId: "job-3309",
          statusUrl: "/api/jobs/job-3309",
        },
        { status: 408 },
      ),
    ]);
    const err = await saveProfile({ displayName: "Ada" }, "key-3309").catch((e) => e);
    expect(err).toBeInstanceOf(ProfileApiError);
    expect(err.code).toBe("FAILURE_ASYNC_JOB_STILL_PROCESSING");
    expect(err.status).toBe(408);
    expect(err.message).toBe(codedMessage("FAILURE_ASYNC_JOB_STILL_PROCESSING"));
  });
});

describe("newIdempotencyKey (#3261)", () => {
  it("returns a non-empty key, different on every call", () => {
    const first = newIdempotencyKey();
    const second = newIdempotencyKey();
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first).not.toBe(second);
  });
});
