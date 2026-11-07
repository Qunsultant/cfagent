/**
 * Issue #3635 — Stock Copilot door fails on the /mcp surface: the route
 * shell never propagated the owning instance's SQL storage, so every
 * storage-needing door refused with door_unavailable.
 *
 * Pins the RCA:
 * 1. A storageless /mcp call to stock_copilot_status still throws
 *    door_unavailable (the honest refusal is preserved where storage
 *    is genuinely unavailable).
 * 2. The same call with storage supplied on the handler context returns
 *    live status synchronously (submitJob never called) — the fix.
 * 3. The run_stock_screen door's identical sync-path refusal
 *    (meshScreenDoor.ts ensureTables) is covered by the same
 *    propagation: storage-carrying context no longer refuses.
 */

import { describe, it, expect, vi } from "vitest";
import { handleOpenaimpMcpHttpRequest } from "../src/mcps/openaimp/handler";
import type { OpenaimpMcpHandlerContext } from "../src/mcps/openaimp/handler";
import { meshScreenDoorContextFromMcp } from "../src/agents/orchestrator/meshScreenDoor";

function mockSql() {
  return {
    exec: vi.fn().mockImplementation((query: string) => {
      const q = query.trim().toUpperCase();
      if (q.startsWith("SELECT") && q.includes("COPILOT_POSITIONS")) return [];
      if (q.startsWith("SELECT") && q.includes("STOCK_COPILOT_ACTIVITY")) return [];
      if (q.startsWith("SELECT") && q.includes("STOCK_COPILOT_CONTROL")) return [];
      return [];
    }),
  };
}

function statusRequest() {
  return new Request("https://agent.internal/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-login": "alice",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "stock_copilot_status",
        arguments: {},
      },
    }),
  });
}

function baseContext(overrides: Partial<OpenaimpMcpHandlerContext> = {}): OpenaimpMcpHandlerContext {
  return {
    env: {
      STOCK_COPILOT_PAPER_ENABLED: "1",
      HTTP_DELIVERY_MODE: "queued",
    } as any,
    orm: {} as any,
    sessionId: "session-3635",
    actingLogin: () => "alice",
    submitJob: vi.fn().mockResolvedValue({
      jobId: "mock-job-id",
      status: "queued",
      statusUrl: "/api/jobs/mock-job-id",
    }),
    audit: vi.fn(),
    principal: { kind: "session", login: "alice" },
    ...overrides,
  };
}

describe("Issue #3635: /mcp surface propagates instance SQL storage", () => {
  it("refuses stock_copilot_status with door_unavailable when the handler context carries no storage", async () => {
    const ctx = baseContext();
    const res = await handleOpenaimpMcpHttpRequest(statusRequest(), ctx);
    const data = (await res.json()) as any;
    expect(data.error).toBeDefined();
    expect(String(data.error?.message ?? "")).toMatch(/cannot access SQLite/);
  });

  it("returns live status synchronously when the handler context carries storage", async () => {
    const submitJob = vi.fn().mockResolvedValue({
      jobId: "mock-job-id",
      status: "queued",
      statusUrl: "/api/jobs/mock-job-id",
    });
    const ctx = baseContext({
      submitJob,
      // Typed field (no cast): the #3635 fix adds `storage` to
      // OpenaimpMcpHandlerContext.
      storage: { sql: mockSql() } as any,
    });

    const res = await handleOpenaimpMcpHttpRequest(statusRequest(), ctx);
    expect(res.status).toBe(200);

    // Synchronous despite HTTP_DELIVERY_MODE=queued: stock_copilot_*
    // are in SYNCHRONOUS_MCP_TOOLS and must never be queued.
    expect(submitJob).not.toHaveBeenCalled();

    const data = (await res.json()) as any;
    expect(data.error).toBeUndefined();
    expect(data.result).toBeDefined();
    expect(data.result.content).toBeDefined();
  });

  it("run_stock_screen door no longer refuses at ensureTables when storage is supplied", () => {
    const sql = mockSql();
    const withStorage = meshScreenDoorContextFromMcp({
      env: {},
      storage: { sql },
    } as any);
    expect(withStorage.ensureTables()).toBe(sql);

    const withoutStorage = meshScreenDoorContextFromMcp({ env: {} } as any);
    expect(() => withoutStorage.ensureTables()).toThrow(
      /no instance SQL storage/,
    );
  });
});
