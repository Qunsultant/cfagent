/**
 * Issue #2603 — route-level pins for POST /trading/options/regenerate.
 *
 * These cover the handler's OWN decisions, which the pure-rebuild pins and
 * the button pin cannot see: identity, owner scoping, the 404 for no stored
 * run, the 422 refusal that names what the stored record is missing, and the
 * delegation of the rebuilt request into the unified executor. The executor
 * itself is the already-tested unified path, so it is mocked here — this is
 * a test of the seam, not of the run.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

const executeUnifiedOptions = vi.fn(async () => Response.json({ status: "ok", runId: "options:new" }));

vi.mock("../src/agents/routes/etradeOptionsScreen", () => ({
  executeUnifiedOptions: (...args: unknown[]) => executeUnifiedOptions(...(args as [])),
}));

import { executeOptionsRegenerate } from "../src/agents/routes/optionsRegenerate";
import { storeReportAtGeneration } from "../src/services/scheduledReports";

/** Minimal SqlStorage shim over node:sqlite (the #2528 harness shape). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] & { rowsWritten?: number } {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

function seedOptionsRun(
  sql: never,
  over: { userLogin?: string; body?: Record<string, unknown>; generationId?: string } = {},
) {
  const stored = storeReportAtGeneration(sql, {
    runId: `options:${over.generationId ?? "gen-1"}`,
    generationId: over.generationId ?? "gen-1",
    userLogin: over.userLogin ?? "alice",
    title: "Options screen — TSLA",
    source: "options_scanner",
    summary: "1 symbol scanned",
    body: over.body ?? {
      symbol: "TSLA",
      thesis: "income",
      strategyMode: "all",
      trigger: "manual",
    },
  } as never);
  return stored!;
}

function ctxFor(sql: never) {
  return { ensureTables: () => sql, env: {} } as never;
}

function request(body: Record<string, unknown> = {}, login: string | null = "alice"): Request {
  return new Request("https://app.test/api/trading/options/regenerate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(login ? { "x-user-login": login } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  executeUnifiedOptions.mockClear();
});

describe("POST /trading/options/regenerate — the handler's own decisions (#2603)", () => {
  it("refuses an unauthenticated caller", async () => {
    const sql = new SqliteTestStorage() as never;
    const res = await executeOptionsRegenerate({
      request: request({}, null),
      sessionId: "s",
      ctx: ctxFor(sql),
    });
    expect(res.status).toBe(401);
    expect(executeUnifiedOptions).not.toHaveBeenCalled();
  });

  it("404s when the caller has no stored options run", async () => {
    const sql = new SqliteTestStorage() as never;
    const res = await executeOptionsRegenerate({
      request: request({}),
      sessionId: "s",
      ctx: ctxFor(sql),
    });
    expect(res.status).toBe(404);
    expect(executeUnifiedOptions).not.toHaveBeenCalled();
  });

  it("does not regenerate another owner's run (owner scoping)", async () => {
    const sql = new SqliteTestStorage() as never;
    const bobs = seedOptionsRun(sql, { userLogin: "bob" });
    const res = await executeOptionsRegenerate({
      request: request({ reportId: bobs.reportId }),
      sessionId: "s",
      ctx: ctxFor(sql),
    });
    expect(res.status).toBe(404);
    expect(executeUnifiedOptions).not.toHaveBeenCalled();
  });

  it("422s with the missing fields when the stored record cannot name the request", async () => {
    const sql = new SqliteTestStorage() as never;
    const stored = seedOptionsRun(sql, { body: { thesis: "income", trigger: "manual" } });
    const res = await executeOptionsRegenerate({
      request: request({ reportId: stored.reportId }),
      sessionId: "s",
      ctx: ctxFor(sql),
    });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as { error?: string; missing?: string[] };
    expect(payload.missing).toContain("symbol or symbols");
    expect(payload.error).toMatch(/cannot be re-run/i);
    expect(executeUnifiedOptions).not.toHaveBeenCalled();
  });

  it("hands the REBUILT request to the unified executor and passes its response through", async () => {
    const sql = new SqliteTestStorage() as never;
    const stored = seedOptionsRun(sql);
    const res = await executeOptionsRegenerate({
      request: request({ reportId: stored.reportId }),
      sessionId: "session-1",
      ctx: ctxFor(sql),
    });
    expect(res.status).toBe(200);
    expect(executeUnifiedOptions).toHaveBeenCalledTimes(1);
    const arg = executeUnifiedOptions.mock.calls[0]![0] as unknown as {
      sessionId: string;
      reqData: Record<string, unknown>;
    };
    expect(arg.sessionId).toBe("session-1");
    // Rebuilt from the STORED row, with provenance — not echoed from the body.
    expect(arg.reqData).toMatchObject({
      symbol: "TSLA",
      thesis: "income",
      strategyMode: "all",
      regeneratedFrom: stored.reportId,
    });
    expect(arg.reqData.regeneratedAt).toEqual(expect.any(String));
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("defaults to the caller's latest options run when no id is sent", async () => {
    const sql = new SqliteTestStorage() as never;
    const stored = seedOptionsRun(sql);
    const res = await executeOptionsRegenerate({
      request: request({}),
      sessionId: "s",
      ctx: ctxFor(sql),
    });
    expect(res.status).toBe(200);
    const arg = executeUnifiedOptions.mock.calls[0]![0] as unknown as {
      reqData: Record<string, unknown>;
    };
    expect(arg.reqData.regeneratedFrom).toBe(stored.reportId);
  });
});
