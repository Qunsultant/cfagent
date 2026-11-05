/**
 * Issue #359-05: characterization for the autopilot route extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handler in
 * src/agents/routes/autopilot.ts — the matching order in routeRequest is
 * load-bearing, so the module must handle the 5 (path, method) pairs in the
 * same sequence as the original inline blocks; and (b) the extracted entry
 * point's behavior with a mock context: each moved path responds as before,
 * non-matching paths return null (the orchestrator keeps routing).
 *
 * The policy-verdict pipeline stays behind the context's
 * evaluateAndRecordAutopilotVerdict() (owner: OrchestratorAgent) — the route
 * shell never inlines the policy engine, the balance snapshot, or the
 * mas_policy_verdicts insert.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  handleAutopilotRoutes,
  type AutopilotRouteContext,
  type AutopilotState,
} from "../src/agents/routes/autopilot";
import { DEFAULT_AUTOPILOT_LIMITS } from "../src/services/riskPolicyEngine";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const makeSql = (tables: Record<string, any[]>, opts: { throwOn?: string[] } = {}) =>
  ({
    exec: (query: string, ..._params: unknown[]) => {
      for (const t of opts.throwOn ?? []) if (query.includes(t)) throw new Error(`no such table: ${t}`);
      for (const [table, rows] of Object.entries(tables)) {
        if (query.includes(table)) return rows;
      }
      return [];
    },
  }) as any;

const state0: AutopilotState = {
  running: false,
  killSwitch: false,
  killSwitchReason: null,
  limits: { ...DEFAULT_AUTOPILOT_LIMITS },
  ordersToday: 0,
  ordersDate: "2026-10-19",
  peakEquity: null,
  updatedAt: null,
};

const baseCtx = (overrides: Partial<AutopilotRouteContext> = {}): AutopilotRouteContext =>
  ({
    ensureTables: () => makeSql({}),
    audit: vi.fn(),
    getAutopilotState: () => ({ ...state0 }),
    writeAutopilotState: vi.fn((patch: Record<string, unknown>) => ({ ...state0, ...patch })),
    evaluateAndRecordAutopilotVerdict: vi.fn(async () => ({
      verdict: { verdictId: "v1", passed: true, executionAllowed: true, intents: { symbol: "AAPL", action: "BUY", quantity: 10 } },
      attestation: { signature: "sig", keyId: "k1" },
    })),
    ...overrides,
  }) as AutopilotRouteContext;

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("autopilot route inventory (extraction #368)", () => {
  it("the 5 route conditions appear in the extracted module in the original relative order", () => {
    const moduleSrc = src("agents/routes/autopilot.ts");
    const markers = [
      'path.endsWith("/autopilot") && request.method === "GET"',
      'path.endsWith("/autopilot/jobs") && request.method === "GET"',
      'path.endsWith("/autopilot/state") && request.method === "POST"',
      'path.endsWith("/autopilot/kill-switch") && request.method === "POST"',
      'path.endsWith("/autopilot/limits") && (request.method === "POST" || request.method === "PUT")',
      'path.endsWith("/autopilot/evaluate") && request.method === "POST"',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = moduleSrc.indexOf(marker);
      expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("the original inline blocks are gone from orchestrator.ts; the delegation stands in their place", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    expect(dispatchSrc).toContain("handleAutopilotRoutes(request, url, path, sessionId,");
    // The extracted module is the sole owner of these blocks now.
    expect(orchSrc).not.toContain('if (path.endsWith("/autopilot") && request.method === "GET") {');
    expect(orchSrc).not.toContain('if (path.endsWith("/autopilot/evaluate") && request.method === "POST") {');
    const moduleSrc = src("agents/routes/autopilot.ts");
    expect(moduleSrc).toContain("// Autopilot control center (autopilot Phase 1)");
  });

  it("the autopilot blocks remain a single contiguous handler (no second position this slice)", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    const calls = [...dispatchSrc.matchAll(/handleAutopilotRoutes\(request, url, path, sessionId,/g)];
    expect(calls).toHaveLength(1);
  });
});

describe("handleAutopilotRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const ctx = baseCtx();
    expect(await handleAutopilotRoutes(req("GET", "/api/audit"), new URL("https://x/api/audit"), "/api/audit", "s", ctx)).toBeNull();
    expect(await handleAutopilotRoutes(req("GET", "/autopilotx"), new URL("https://x/autopilotx"), "/autopilotx", "s", ctx)).toBeNull();
    expect(await handleAutopilotRoutes(req("DELETE", "/autopilot"), new URL("https://x/autopilot"), "/autopilot", "s", ctx)).toBeNull();
  });

  it("GET /autopilot returns state, engine tag, and recent verdicts", async () => {
    const rows = [{ id: "v9", symbol: "NVDA", action: "BUY" }];
    const ctx = baseCtx({ ensureTables: () => makeSql({ mas_policy_verdicts: rows }) });
    const res = await handleAutopilotRoutes(req("GET", "/api/autopilot"), new URL("https://x/api/autopilot"), "/api/autopilot", "s1", ctx);
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body.running).toBe(false);
    expect(body.engine).toBe("riskPolicyEngine");
    expect(body.recentVerdicts).toEqual(rows);
  });

  it("GET /autopilot tolerates a missing verdicts table (empty list)", async () => {
    const ctx = baseCtx({ ensureTables: () => makeSql({}, { throwOn: ["mas_policy_verdicts"] }) });
    const res = await handleAutopilotRoutes(req("GET", "/api/autopilot"), new URL("https://x/api/autopilot"), "/api/autopilot", "s1", ctx);
    const body = await res!.json();
    expect(body.recentVerdicts).toEqual([]);
  });

  it("POST /autopilot/state validates running and audits the change", async () => {
    const ctx = baseCtx();
    const bad = await handleAutopilotRoutes(req("POST", "/api/autopilot/state", {}), new URL("https://x"), "/api/autopilot/state", "s1", ctx);
    expect(bad!.status).toBe(400);
    const ok = await handleAutopilotRoutes(req("POST", "/api/autopilot/state", { running: true }), new URL("https://x"), "/api/autopilot/state", "s1", ctx);
    const body = await ok!.json();
    expect(body.running).toBe(true);
    expect(ctx.writeAutopilotState).toHaveBeenCalledWith({ running: true });
    expect(ctx.audit).toHaveBeenCalledWith("autopilot.state_changed", "trading", expect.objectContaining({ running: true, by: "s1" }));
  });

  it("POST /autopilot/kill-switch applies the default reason and slices it at 200 chars", async () => {
    const ctx = baseCtx();
    const on = await handleAutopilotRoutes(req("POST", "/api/autopilot/kill-switch", { active: true, reason: "x".repeat(300) }), new URL("https://x"), "/api/autopilot/kill-switch", "s", ctx);
    const onBody = await on!.json();
    expect(onBody.killSwitch).toBe(true);
    expect(onBody.killSwitchReason!.length).toBe(200);
    const off = await handleAutopilotRoutes(req("POST", "/api/autopilot/kill-switch", { active: false }), new URL("https://x"), "/api/autopilot/kill-switch", "s", ctx);
    const offBody = await off!.json();
    expect(offBody.killSwitchReason).toBeNull();
    expect(ctx.audit).toHaveBeenCalledWith("autopilot.kill_switch", "trading", expect.objectContaining({ active: false, reason: null }));
  });

  it("POST /autopilot/limits normalizes limits, stores and audits them", async () => {
    const ctx = baseCtx();
    const res = await handleAutopilotRoutes(req("POST", "/api/autopilot/limits", { maxOrdersPerDay: 5 }), new URL("https://x"), "/api/autopilot/limits", "s", ctx);
    const body = await res!.json();
    expect(body.limits).toBeDefined();
    expect(ctx.audit).toHaveBeenCalledWith("autopilot.limits_updated", "trading", expect.objectContaining({ limits: body.limits }));
  });

  it("POST /autopilot/evaluate rejects a missing symbol/positive quantity", async () => {
    const ctx = baseCtx();
    const res = await handleAutopilotRoutes(req("POST", "/api/autopilot/evaluate", { symbol: "", quantity: 0 }), new URL("https://x"), "/api/autopilot/evaluate", "s", ctx);
    expect(res!.status).toBe(400);
    expect(ctx.evaluateAndRecordAutopilotVerdict).not.toHaveBeenCalled();
  });

  it("POST /autopilot/evaluate delegates to the pipeline and echoes verdict + requestedBy", async () => {
    const ctx = baseCtx();
    const res = await handleAutopilotRoutes(
      req("POST", "/api/autopilot/evaluate", { symbol: "aapl", quantity: 10, action: "buy", requestedBy: "qa" }, { "x-user-login": "alice" }),
      new URL("https://x"),
      "/api/autopilot/evaluate",
      "sess-9",
      ctx
    );
    const body = await res!.json();
    expect(body.verdict.verdictId).toBe("v1");
    expect(body.attestation.signature).toBe("sig");
    expect(body.requestedBy).toBe("qa");
    expect(ctx.evaluateAndRecordAutopilotVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-9", userLogin: "alice", dryRun: true, intent: expect.objectContaining({ symbol: "AAPL", quantity: 10 }) })
    );
  });
});
