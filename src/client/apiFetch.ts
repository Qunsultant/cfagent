type AsyncJobStatusResponse = {
  jobId: string;
  capability: string;
  status: "queued" | "running" | "completed" | "failed";
  statusUrl: string;
  result?: unknown;
  responseStatus?: number;
  error?: string;
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

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const initialResponse = await globalThis.fetch(input, withCsrfInit(init));
  if (initialResponse.status !== 202) return initialResponse;

  let accepted: Partial<AsyncJobStatusResponse>;
  try {
    accepted = await initialResponse.clone().json() as AsyncJobStatusResponse;
  } catch {
    return initialResponse;
  }
  if (typeof accepted.jobId !== "string" || typeof accepted.statusUrl !== "string") return initialResponse;

  let delayMs = 500;
  const deadline = Date.now() + 10 * 60 * 1000;
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
    delayMs = Math.min(Math.round(delayMs * 1.5), 5_000);
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
