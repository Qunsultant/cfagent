type AsyncJobStatusResponse = {
  jobId: string;
  capability: string;
  status: "queued" | "running" | "completed" | "failed";
  statusUrl: string;
  result?: unknown;
  responseStatus?: number;
  error?: string;
};

/**
 * The 202 async-job contract (issue #3309, 15-factor F2 API first).
 *
 * A queued API request answers 202 Accepted with `Location` +
 * `Retry-After: 1` and a job receipt body `{jobId, status, statusUrl}`.
 * The caller MUST NOT assume a 200 body: it polls `statusUrl` until
 * the job reaches a terminal state. On completion the original
 * response is reconstructed (for capability `http.request`, the job
 * result carries the original body + headers + responseStatus); on
 * failure the poll returns a 500 carrying the job's error; on the
 * deadline it returns a 408 carrying the job receipt. The error
 * strings in the 408/500 bodies are transport detail — callers
 * classify the outcome structurally (status + jobId) and render a
 * coded outcome-catalog message, never the raw error text.
 *
 * The polling client keeps the session as its only identity: the
 * status poll is a same-origin GET, so the session cookie rides
 * along and the server reads the job session-scoped. No identity
 * header, no credential, and no session value is introduced here.
 */
export interface AsyncJobPollConfig {
  /** Delay before the first status poll. */
  initialDelayMs: number;
  /** Upper bound on the delay between polls. */
  maxDelayMs: number;
  /** Multiplicative backoff applied to the delay after each poll. */
  backoffFactor: number;
  /** Total wall-clock budget for polling before the 408. */
  deadlineMs: number;
}

/**
 * Poll timing configuration (15-factor F5: configuration, never
 * hardcoded literals). Values are the historical poll behavior,
 * unchanged: first poll after 500ms, backoff ×1.5 capped at 5s,
 * 10-minute deadline. Callers pass an override only to bound a
 * shorter wait (tests); production uses these defaults.
 */
export const DEFAULT_ASYNC_JOB_POLL_CONFIG: AsyncJobPollConfig = {
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffFactor: 1.5,
  deadlineMs: 10 * 60 * 1000,
};

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Q5 slice — CSRF token header for cookie-authenticated mutations.
 * Reads the readable `csrf_token` cookie minted at login (see
 * src/security/csrf.ts) and returns it as the X-CSRF-Token header.
 * Empty when no token exists (logged-out state, or a pre-slice
 * session before its next authenticated GET mints one) — the
 * server gate then rejects the mutation, fail-closed, until the
 * token exists. Never reads the HttpOnly session cookie.
 */
export function csrfHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  const token = match ? decodeURIComponent(match[1]) : "";
  return token ? { "X-CSRF-Token": token } : {};
}

/**
 * Shared by client modules that call globalThis.fetch directly
 * instead of apiFetch: returns the init with the CSRF header
 * merged in for non-GET requests (a no-op for GETs and when no
 * token cookie exists). Funnels should route every call through
 * this so the server gate never 403s a legitimate mutation.
 */
export function withCsrfInit(init: RequestInit | undefined): RequestInit | undefined {
  const method = (init?.method || "GET").toUpperCase();
  if (method === "GET") return init;
  const extra = csrfHeaders();
  if (Object.keys(extra).length === 0) return init;
  const existing = init?.headers;
  if (existing instanceof Headers) {
    const merged = new Headers(existing);
    for (const [key, value] of Object.entries(extra)) {
      if (!merged.has(key)) merged.set(key, value);
    }
    return { ...init, headers: merged };
  }
  return {
    ...init,
    headers: { ...extra, ...((existing as Record<string, string> | undefined) ?? {}) },
  };
}

import { resolveOutcome } from "../outcomes/outcomeAspects";

/**
 * Structural classification of a 202-poll outcome (#3309, the #2573
 * precedent: classify by shape, never by error text). The 408/500
 * bodies apiFetch returns for a polled job carry `{error, jobId,
 * ...}` — the `error` string is transport detail and is NEVER
 * rendered. What the caller renders is the catalog message for the
 * code returned here:
 * - a server `code` that resolves in the catalog wins (the caller
 *   already renders coded server bodies);
 * - 408 + jobId → the job is still running past the poll deadline;
 * - 500 + jobId → the job reached the failed terminal state.
 * Anything else returns undefined and the caller falls back to its
 * fixed per-status message.
 */
export function asyncJobErrorCode(status: number, data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.code === "string" && resolveOutcome(record.code).entry) return record.code;
  if (typeof record.jobId !== "string" || record.jobId.length === 0) return undefined;
  if (status === 408) return "FAILURE_ASYNC_JOB_STILL_PROCESSING";
  if (status === 500) return "FAILURE_ASYNC_JOB_FAILED";
  return undefined;
}

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  poll?: Partial<AsyncJobPollConfig>,
): Promise<Response> {
  const initialResponse = await globalThis.fetch(input, withCsrfInit(init));
  if (initialResponse.status !== 202) return initialResponse;

  let accepted: Partial<AsyncJobStatusResponse>;
  try {
    accepted = await initialResponse.clone().json() as AsyncJobStatusResponse;
  } catch {
    return initialResponse;
  }
  if (typeof accepted.jobId !== "string" || typeof accepted.statusUrl !== "string") return initialResponse;

  const config: AsyncJobPollConfig = { ...DEFAULT_ASYNC_JOB_POLL_CONFIG, ...poll };
  let delayMs = config.initialDelayMs;
  const deadline = Date.now() + config.deadlineMs;
  while (Date.now() < deadline) {
    await sleep(delayMs);
    const response = await globalThis.fetch(accepted.statusUrl, { headers: { "Accept": "application/json" } });
    if (!response.ok) return response;
    const job = await response.json() as AsyncJobStatusResponse;
    if (job.status === "failed") {
      return Response.json(
        { error: job.error || "Asynchronous request failed.", jobId: job.jobId, status: job.status },
        { status: 500 },
      );
    }
    if (job.status === "completed") {
      if (job.capability === "http.request") {
        const result = job.result as { body?: string; headers?: Record<string, string> } | undefined;
        const status = job.responseStatus || 200;
        return new Response(status === 204 || status === 304 ? null : result?.body || "", {
          status,
          headers: result?.headers,
        });
      }
      return Response.json(job.result, { status: job.responseStatus || 200 });
    }
    delayMs = Math.min(Math.round(delayMs * config.backoffFactor), config.maxDelayMs);
  }

  return Response.json(
    {
      error: "The request is still processing. The job will continue in the background.",
      jobId: accepted.jobId,
      statusUrl: accepted.statusUrl,
    },
    { status: 408 },
  );
}
