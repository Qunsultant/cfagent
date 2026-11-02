/**
 * Issue #2599 (F1 only): the manual panel routes fail fast before
 * any scan when the auth guard blocks.
 *
 * The guard itself is unit-pinned in
 * tests/options_auth_freshness_2599.test.ts; here the route-facing
 * seam (panelAuthResponse) is mocked to prove the wiring: blocked
 * → coded 401 before ETradeService/scan/record are ever reached
 * (the mock context's getOrm throws, so any scan attempt would
 * surface as a 400 "boom" instead); proceeding → the route falls
 * through to its existing path (here the throwing getOrm, i.e.
 * 400, proving the guard did not swallow the request).
 *
 * No existing test file is touched: this file is new, and the
 * mocked module is only the new F1 module.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockState = vi.hoisted(() => ({
  response: null as null | { status: number; error: string },
}));

vi.mock("../src/services/optionsAuthFreshness", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/optionsAuthFreshness")>();
  return {
    ...actual,
    panelAuthResponse: vi.fn(async () =>
      mockState.response
        ? Response.json(
            { error: mockState.response.error },
            { status: mockState.response.status },
          )
        : null,
    ),
  };
});

import {
  handleEtradeOptionsRoutes,
  type EtradeOptionsRouteContext,
} from "../src/agents/routes/etradeOptions";

const baseCtx = (
  overrides: Partial<EtradeOptionsRouteContext> = {},
): EtradeOptionsRouteContext =>
  ({
    env: {} as never,
    getOrm: () => {
      throw new Error("boom");
    },
    agentCtx: {} as never,
    ensureTables: () => ({} as never),
    requestedEnv: undefined,
    getScreenerAgent: () => {
      throw new Error("boom");
    },
    ...overrides,
  }) as EtradeOptionsRouteContext;

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      "x-user-login": "alice",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

// A body that passes parseOptionsDiscoveryRequest: every required
// strategy-request field present, allowedStrategies resolvable.
const validBody = {
  symbol: "TSLA",
  thesis: "bullish",
  targetPrice: 300,
  targetDate: "2026-12-18",
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 1000,
  minRewardRisk: 1.5,
  allowedStrategies: ["long_call"],
};

describe("manual panel auth guard wiring (#2599 F1)", () => {
  beforeEach(() => {
    mockState.response = null;
  });

  it("blocked guard on /strategies → coded 401 before any scan (no boom from getOrm)", async () => {
    mockState.response = {
      status: 401,
      error:
        "[FAILURE_AUTH_TOKEN_EXPIRED] E*TRADE connection expired. Please reconnect your account in Settings. — No scan ran.",
    };
    const res = await handleEtradeOptionsRoutes(
      req("POST", "/api/trading/options/strategies", validBody),
      urlOf("/api/trading/options/strategies"),
      "/api/trading/options/strategies",
      "s",
      baseCtx(),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toMatch(/FAILURE_AUTH_TOKEN_EXPIRED/);
    expect(body.error).not.toMatch(/boom/);
  });

  it("blocked guard on /best-trade → coded 401 before any scan", async () => {
    mockState.response = {
      status: 401,
      error:
        "[FAILURE_AUTH_NO_SESSION] No E*TRADE session is stored for this account. Please connect your account in Settings. — No scan ran.",
    };
    const res = await handleEtradeOptionsRoutes(
      req("POST", "/api/trading/options/best-trade", validBody),
      urlOf("/api/trading/options/best-trade"),
      "/api/trading/options/best-trade",
      "s",
      baseCtx(),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toMatch(/FAILURE_AUTH_NO_SESSION/);
    expect(body.error).not.toMatch(/boom/);
  });

  it("proceeding guard falls through to the existing path (throwing getOrm → 400, not 401)", async () => {
    mockState.response = null;
    const res = await handleEtradeOptionsRoutes(
      req("POST", "/api/trading/options/strategies", validBody),
      urlOf("/api/trading/options/strategies"),
      "/api/trading/options/strategies",
      "s",
      baseCtx(),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("boom");
  });
});
