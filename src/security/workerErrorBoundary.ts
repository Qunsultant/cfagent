import { isKvLimitError } from "./kvResilience";
import { codedMessage } from "../outcomes/outcomeAspects";

/**
 * Last line of defence against Cloudflare error 1101.
 *
 * 1101 is what the edge returns when the Worker's fetch handler throws and
 * nothing catches it. A thrown KV quota error therefore became a site-wide
 * outage rather than a degraded response. This boundary converts any escaped
 * error into a real HTTP response with a code the UI can act on, and keeps the
 * stack in the logs instead of in the visitor's face.
 *
 * Kept free of Worker-only imports so it can be unit tested under Node.
 *
 * Issue #2572 (AOP): the generic 500 body is a catalog-coded body, not a
 * hardcoded string. The single outcome resolver
 * (src/outcomes/outcomeAspects.ts, over src/outcomes/outcomeCatalog.json)
 * owns the wording; changing the wording is a catalog change, never a code
 * change here. The original error text stays in the log only — it must
 * never appear in the response body. The KV-quota special case is
 * unchanged: it is a distinct, retryable condition with its own code and
 * Retry-After, not an unexpected error.
 */
export interface ErrorBoundaryOptions {
  log?: (message: string, error: unknown) => void;
}

export interface ErrorBody {
  error: string;
  code: "kv_quota_exhausted" | "FAILURE_UNEXPECTED_ERROR";
}

export function classifyError(error: unknown): { status: number; body: ErrorBody } {
  if (isKvLimitError(error)) {
    return {
      status: 503,
      body: {
        error:
          "Session storage is temporarily unavailable. Retry shortly; reads resume automatically once the store recovers.",
        code: "kv_quota_exhausted",
      },
    };
  }
  return {
    status: 500,
    body: { error: codedMessage("FAILURE_UNEXPECTED_ERROR"), code: "FAILURE_UNEXPECTED_ERROR" },
  };
}

export function withErrorBoundary<TEnv>(
  handler: (request: Request, env: TEnv) => Promise<Response>,
  options: ErrorBoundaryOptions = {}
): (request: Request, env: TEnv) => Promise<Response> {
  const log = options.log ?? ((message: string, error: unknown) => console.error(message, error));

  return async (request: Request, env: TEnv): Promise<Response> => {
    try {
      return await handler(request, env);
    } catch (error) {
      // A handler that throws a Response is using it as control flow (e.g. a
      // redirect helper); honour it instead of wrapping it as a 500.
      if (error instanceof Response) return error;

      const { status, body } = classifyError(error);
      const message = error instanceof Error ? error.message : String(error);
      log(`[worker] ${request.method} ${new URL(request.url).pathname} failed (${body.code}): ${message}`, error);

      return Response.json(body, {
        status,
        headers: { "Cache-Control": "no-store", "Retry-After": status === 503 ? "30" : "5" },
      });
    }
  };
}
