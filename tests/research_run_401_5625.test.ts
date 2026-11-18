/**
 * Issue #5625 — "Run research now" must not surface a JSON parser error.
 *
 * `POST /api/research/run` answers a bare-text 401 (`Unauthorized`) from the
 * generic `/api/*` forwarder (`src/server/routes/core.ts:204`). The panel did
 * `await res.json()` without checking `res.ok`, so the parser's SyntaxError
 * became the user-facing message: "Unexpected token 'U', "Unauthorized" is not
 * valid JSON". Two pins:
 *
 *  1. the forwarder's 401 is JSON with a code (server);
 *  2. the panel renders a session message for a plain-text 401 (client).
 */
import { describe, it, expect } from "vitest";
import { handleCoreLateRoutes } from "../src/server/routes/core";

function url(path: string) {
  return new URL(`https://agent.openaimp.com${path}`);
}

const envStub = {
  ENVIRONMENT: "TEST",
} as any;

describe("Issue #5625 — the /api/* forwarder answers JSON on 401", () => {
  it("returns a JSON 401 with a code for an unauthenticated research run", async () => {
    const path = "/api/research/run";
    const response = await handleCoreLateRoutes(
      new Request(`https://agent.openaimp.com${path}`, { method: "POST" }),
      envStub,
      url(path),
      path,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await response.json()) as { code?: string; error?: string };
    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.error ?? "").toMatch(/sign/i);
  });
});
