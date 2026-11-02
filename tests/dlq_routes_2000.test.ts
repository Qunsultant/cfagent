/**
 * Phase 5 Slice 1 (#2000) — DLQ operator routes.
 *
 * The gate mirrors the commercial operator routes: the
 * x-user-login header against env COMMERCIAL_STORE_OPERATORS
 * UNION the store operator list (env-only when AGENT_DB is
 * unbound). Non-operators get 403, never a separate 401.
 */
import { describe, it, expect, vi } from "vitest";
import { InMemoryDeadLetterStoreAdapter } from "../src/data/inMemoryDeadLetterStoreAdapter";
import { handleDlqRoutes, type DlqRouteContext } from "../src/agents/routes/dlq";

const ENVELOPE = {
  specversion: "1.0",
  id: "env-1",
  source: "test",
  type: "options_analysis",
  time: "2026-11-02T00:00:00.000Z",
  data: { taskType: "options_analysis", payload: { userLogin: "op1" } },
  jobid: "job-1",
};

function req(path: string, init: { method?: string; login?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (init.login) headers["x-user-login"] = init.login;
  return new Request(`https://worker.test${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

function call(path: string, request: Request, ctx: DlqRouteContext) {
  return handleDlqRoutes(request, new URL(`https://worker.test${path}`), path, "session-1", ctx);
}

function ctx(over: Partial<DlqRouteContext> = {}): DlqRouteContext {
  return {
    env: { COMMERCIAL_STORE_OPERATORS: "op1" },
    store: new InMemoryDeadLetterStoreAdapter(),
    senders: {},
    sendAlert: vi.fn(async () => {}),
    ...over,
  };
}

describe("DLQ operator routes (#2000 slice 1)", () => {
  it("anonymous and non-operator callers get 403 before any store access", async () => {
    const c = ctx();
    const anon = await call("/api/ops/dlq/records", req("/api/ops/dlq/records"), c);
    expect(anon!.status).toBe(403);
    const mallory = await call("/api/ops/dlq/records", req("/api/ops/dlq/records", { login: "mallory" }), c);
    expect(mallory!.status).toBe(403);
  });

  it("an unbound store yields 503 for an operator", async () => {
    // Operator authorized via the env list; the DLQ store itself unbound.
    const c = ctx({ store: undefined, env: { COMMERCIAL_STORE_OPERATORS: "op1" } });
    const res = await call("/api/ops/dlq/records", req("/api/ops/dlq/records", { login: "op1" }), c);
    expect(res!.status).toBe(503);
  });

  it("GET records returns un-replayed rows newest-first for an operator", async () => {
    const store = new InMemoryDeadLetterStoreAdapter();
    await store.insert({ queue: "screener-events", reason: "no_handler", messageId: "a", createdAtMs: 1000 });
    await store.insert({ queue: "screener-events", reason: "denied", messageId: "b", createdAtMs: 2000 });
    const res = await call("/api/ops/dlq/records", req("/api/ops/dlq/records", { login: "op1" }), ctx({ store }));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { records: Array<{ messageId: string }> };
    expect(body.records.map((r) => r.messageId)).toEqual(["b", "a"]);
  });

  it("POST replay succeeds, sends the identical envelope, and marks the record", async () => {
    const store = new InMemoryDeadLetterStoreAdapter();
    const row = await store.insert({ queue: "screener-events", reason: "no_handler", messageId: "env-1", envelope: ENVELOPE, createdAtMs: 1000 });
    const sent: unknown[] = [];
    const res = await call(
      "/api/ops/dlq/replay",
      req("/api/ops/dlq/replay", { method: "POST", login: "op1", body: { recordId: row.id } }),
      ctx({ store, senders: { "screener-events": { send: async (b: unknown) => { sent.push(b); } } } }),
    );
    expect(res!.status).toBe(200);
    expect(sent).toEqual([ENVELOPE]);
    expect((await store.getById(row.id))!.replayedAtMs).not.toBeNull();
  });

  it("POST replay maps refusals to 400, unknown records to 404, and bad bodies to 400", async () => {
    const store = new InMemoryDeadLetterStoreAdapter();
    const denied = await store.insert({ queue: "screener-events", reason: "denied", messageId: "x", envelope: ENVELOPE, createdAtMs: 1000 });
    const sent: unknown[] = [];
    const c = ctx({ store, senders: { "screener-events": { send: async (b: unknown) => { sent.push(b); } } } });
    const refused = await call("/api/ops/dlq/replay", req("/api/ops/dlq/replay", { method: "POST", login: "op1", body: { recordId: denied.id } }), c);
    expect(refused!.status).toBe(400);
    expect((await refused!.json()) as { code: string }).toMatchObject({ code: "denied" });
    expect(sent).toHaveLength(0);
    const unknown = await call("/api/ops/dlq/replay", req("/api/ops/dlq/replay", { method: "POST", login: "op1", body: { recordId: "nope" } }), c);
    expect(unknown!.status).toBe(404);
    const bad = await call("/api/ops/dlq/replay", req("/api/ops/dlq/replay", { method: "POST", login: "op1", body: {} }), c);
    expect(bad!.status).toBe(400);
  });

  it("non-matching paths fall through (null)", async () => {
    expect(await call("/api/ops/other", req("/api/ops/other", { login: "op1" }), ctx())).toBeNull();
    expect(await call("/api/ops/dlq/records", req("/api/ops/dlq/records", { method: "DELETE", login: "op1" }), ctx())).toBeNull();
  });
});
