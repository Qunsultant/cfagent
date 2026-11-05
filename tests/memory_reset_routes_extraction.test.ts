/**
 * Issue #359-06: characterization for the memory + reset route extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handler in
 * src/agents/routes/memoryReset.ts — the matching order in routeRequest is
 * load-bearing, so the module must handle the (path, method) pairs in the
 * same sequence as the original inline blocks; (b) the delegation call site
 * in orchestrator.ts — one call site, between the autopilot handler and the
 * referrals+ads handler; and (c) the extracted entry point's behavior with
 * a mock context: each moved path responds as before, non-matching paths
 * return null (the orchestrator keeps routing).
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS
 * (handleAutopilotRoutes / handleReferralsAdsRoutes), never to a neighboring
 * domain's inline comments or blocks — those move when their domain is
 * extracted.
 *
 * The reset endpoints are destructive; the guards/confirmations are pinned:
 * the ?purge=false opt-out, the abortAllRequests reason string, and the
 * audit event names (memory.deleted / memory.cleared / history.purged /
 * history.cleared).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  handleMemoryResetRoutes,
  type MemoryResetRouteContext,
} from "../src/agents/routes/memoryReset";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const makeSql = (queries: Record<string, (...args: unknown[]) => unknown>) =>
  ({
    exec: (query: string, ...params: unknown[]) => {
      for (const [fragment, fn] of Object.entries(queries)) {
        if (query.includes(fragment)) return fn(query, ...params);
      }
      return [];
    },
  }) as any;

const baseCtx = (overrides: Partial<MemoryResetRouteContext> = {}): MemoryResetRouteContext =>
  ({
    ensureTables: () => makeSql({}),
    audit: vi.fn(),
    abortAllRequests: vi.fn(),
    resetTurnState: vi.fn(),
    clearConversationMessages: vi.fn(async () => {}),
    ...overrides,
  }) as MemoryResetRouteContext;

const req = (method: string, path: string) =>
  new Request(`https://agent.internal${path}`, { method });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

describe("memory/reset route inventory (extraction #369)", () => {
  it("the route conditions appear in the extracted module in the original relative order", () => {
    const moduleSrc = src("agents/routes/memoryReset.ts");
    const markers = [
      'path.endsWith("/memory")',
      'request.method === "GET"',
      'request.method === "DELETE"',
      'path.endsWith("/clear") || path.endsWith("/reset")',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = moduleSrc.indexOf(marker);
      expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("the original inline blocks are gone from orchestrator.ts; one delegation stands at the original position", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    expect(dispatchSrc).toContain("handleMemoryResetRoutes(request, url, path, sessionId,");
    // Distinctive comments that headed the inline blocks before extraction.
    expect(orchSrc).not.toContain("// Persistent Memory facts endpoint");
    expect(orchSrc).not.toContain("// Clear active conversation transcript and reset session state");
    // No leftover inline conditions for these paths.
    for (const cond of [
      'if (path.endsWith("/memory")) {',
      'path.endsWith("/clear") || path.endsWith("/reset")',
    ]) {
      expect(orchSrc, `inline condition should be gone: ${cond}`).not.toContain(cond);
    }
    // The extracted module is the sole owner of these blocks now.
    const moduleSrc = src("agents/routes/memoryReset.ts");
    expect(moduleSrc).toContain("// Persistent Memory facts endpoint");
    expect(moduleSrc).toContain("// Clear active conversation transcript and reset session state");
    // Single call site.
    const calls = [...dispatchSrc.matchAll(/handleMemoryResetRoutes\(request, url, path, sessionId,/g)];
    expect(calls).toHaveLength(1);
  });

  it("the delegation sits between the autopilot and referrals+ads handlers (delegation-call landmarks, #405)", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    const myIdx = dispatchSrc.indexOf("handleMemoryResetRoutes(request, url, path, sessionId,");
    const autopilotIdx = dispatchSrc.indexOf("handleAutopilotRoutes(request, url, path, sessionId,");
    const referralsIdx = dispatchSrc.indexOf("handleReferralsAdsRoutes(request, url, path, sessionId,");
    expect(autopilotIdx).toBeGreaterThan(-1);
    expect(referralsIdx).toBeGreaterThan(-1);
    expect(myIdx, "memory/reset delegation must follow the autopilot handler").toBeGreaterThan(autopilotIdx);
    expect(myIdx, "memory/reset delegation must precede the referrals+ads handler").toBeLessThan(referralsIdx);
  });
});

describe("handleMemoryResetRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const ctx = baseCtx();
    expect(await handleMemoryResetRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", ctx)).toBeNull();
    expect(await handleMemoryResetRoutes(req("POST", "/memoryx"), urlOf("/memoryx"), "/memoryx", "s", ctx)).toBeNull();
    // #1723: POST /api/memory is NO LONGER a fall-through — it is the new
    // remember route (same command, transport + envelope only). An
    // empty-body POST is a 400, not a null fall-through; the old pin
    // asserting null here is superseded by this slice.
    const postRes = await handleMemoryResetRoutes(req("POST", "/api/memory"), urlOf("/api/memory"), "/api/memory", "s", ctx);
    expect(postRes).not.toBeNull();
    expect(postRes!.status).toBe(400);
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("GET /memory maps rows to { key, value, updatedAt } with a count", async () => {
    const rows = [
      { key: "k1", value: "v1", updated_at: "2026-10-19T05:00:00Z" },
      { key: "k2", value: "v2", updated_at: "2026-10-19T06:00:00Z" },
    ];
    const ctx = baseCtx({ ensureTables: () => makeSql({ mas_memory: () => rows }) });
    const res = await handleMemoryResetRoutes(req("GET", "/api/memory"), urlOf("/api/memory"), "/api/memory", "s", ctx);
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body).toEqual({
      count: 2,
      memories: [
        { key: "k1", value: "v1", updatedAt: "2026-10-19T05:00:00Z" },
        { key: "k2", value: "v2", updatedAt: "2026-10-19T06:00:00Z" },
      ],
    });
  });

  it("DELETE /memory?key=k deletes one key and audits memory.deleted", async () => {
    const seen: Array<{ q: string; p: unknown[] }> = [];
    const ctx = baseCtx({
      ensureTables: () =>
        makeSql({
          mas_memory: (q: string, ...p: unknown[]) => {
            seen.push({ q, p });
            return [];
          },
        }),
    });
    const res = await handleMemoryResetRoutes(
      req("DELETE", "/api/memory?key=k9"),
      urlOf("/api/memory?key=k9"),
      "/api/memory",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(await res!.json()).toEqual({ success: true });
    expect(seen.some((s) => s.q.includes("DELETE FROM mas_memory WHERE key = ?") && s.p[0] === "k9")).toBe(true);
    expect(ctx.audit).toHaveBeenCalledWith("memory.deleted", "memory", { key: "k9" });
  });

  it("DELETE /memory without key deletes all and audits memory.cleared", async () => {
    const seen: string[] = [];
    const ctx = baseCtx({
      ensureTables: () =>
        makeSql({
          mas_memory: (q: string) => {
            seen.push(q);
            return [];
          },
        }),
    });
    const res = await handleMemoryResetRoutes(req("DELETE", "/api/memory"), urlOf("/api/memory"), "/api/memory", "s", ctx);
    expect(res).not.toBeNull();
    expect(await res!.json()).toEqual({ success: true });
    expect(seen.some((q) => q.trim() === "DELETE FROM mas_memory")).toBe(true);
    expect(ctx.audit).toHaveBeenCalledWith("memory.cleared", "memory", {});
  });

  it("POST /reset purges history by default: exact abort reason, history.purged audit", async () => {
    const seen: Array<{ q: string; p: unknown[] }> = [];
    const ctx = baseCtx({
      ensureTables: () =>
        makeSql({
          mas_messages: (q: string, ...p: unknown[]) => {
            seen.push({ q, p });
            return [];
          },
        }),
    });
    const res = await handleMemoryResetRoutes(req("POST", "/api/reset"), urlOf("/api/reset"), "/api/reset", "sess-1", ctx);
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("purged");
    expect(ctx.abortAllRequests).toHaveBeenCalledWith("Session reset requested by user");
    expect(ctx.resetTurnState).toHaveBeenCalled();
    expect(ctx.clearConversationMessages).toHaveBeenCalled();
    expect(seen.some((s) => s.q.includes("DELETE FROM mas_messages") && s.p[0] === "sess-1")).toBe(true);
    expect(ctx.audit).toHaveBeenCalledWith("history.purged", "orchestrator", {});
  });

  it("POST /reset?purge=false preserves history and audits history.cleared", async () => {
    let deleteRan = false;
    const ctx = baseCtx({
      ensureTables: () =>
        makeSql({
          mas_messages: () => {
            deleteRan = true;
            return [];
          },
        }),
    });
    const res = await handleMemoryResetRoutes(
      req("POST", "/api/reset?purge=false"),
      urlOf("/api/reset?purge=false"),
      "/api/reset",
      "sess-1",
      ctx
    );
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body.message).toContain("preserved");
    expect(deleteRan).toBe(false);
    expect(ctx.audit).toHaveBeenCalledWith("history.cleared", "orchestrator", {});
  });

  it("GET /clear matches too (method set preserved verbatim)", async () => {
    const ctx = baseCtx();
    const res = await handleMemoryResetRoutes(req("GET", "/api/clear"), urlOf("/api/clear"), "/api/clear", "sess-1", ctx);
    expect(res).not.toBeNull();
    expect((await res!.json()).success).toBe(true);
    expect(ctx.abortAllRequests).toHaveBeenCalled();
  });
});
