/**
 * Issue Qunsultant/cfagent#4203 — direct `GET /api/schedule/runs`
 * parallel ledger read: redirect, not retire.
 *
 * RED first: these pins fail until `/api/schedule/runs` answers with
 * the merged read (`GET /api/ledger/runs`) instead of the
 * ScheduledAgent KV half only.
 *
 * - 4203-P01 redirect: an authenticated `GET /api/schedule/runs`
 *   returns the merged payload — both halves, newest-first, dedup on
 *   jobId+started+operation, `partial:false` — identical to
 *   `GET /api/ledger/runs` for the same query. It is NOT the KV-only
 *   payload the old branch returned.
 * - 4203-P02 merged read unchanged: `GET /api/ledger/runs` returns
 *   the same merged payload (the extraction of the shared helper is
 *   behavior-preserving; the #3124 parity tests stay the guard).
 * - 4203-P03 partial: a failed DO half degrades the redirect to
 *   `partial:true` with the KV half that succeeded, instead of the
 *   old branch's unmapped throw (this route's instance of the G6 gap,
 *   Qunsultant/cfagent#3645).
 * - 4203-P04 one read path: exactly one `listJobRuns` call site
 *   remains in `src/server/routes/trading.ts` (inside the shared
 *   merged-read helper both routes call), and the catalog entry for
 *   the route names the redirect target instead of a direct DO
 *   forward.
 *
 * Harness: the real worker fetch dispatch with a Map-backed SESSIONS
 * KV and stubbed ORCHESTRATOR_AGENT / SCHEDULED_AGENT namespaces
 * (same pattern as tests/fallback_identity_session_gate.test.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";
import type { Env } from "../src/types";
import { API_ENDPOINT_CATALOG } from "../src/client/iaaaEndpointCatalog";

const LOGIN = "octocat-4203";
const SESSION_ID = "0d9a4203-1c2b-4e3f-8a5b-420300000001";

// DO-SQLite half (authoritative home, first list wins a duplicate).
const DO_RUN = {
  jobId: "goal-a",
  started: "2026-11-12T10:00:00.000Z",
  operation: "goal.screen",
  system: "orchestrator",
  outcome: "ok",
};
// KV half.
const KV_RUN = {
  jobId: "goal-b",
  started: "2026-11-12T09:00:00.000Z",
  operation: "goal.screen",
  system: "scheduled-agent",
  outcome: "ok",
};
// Same (jobId, started, operation) as DO_RUN, KV-side copy: dedup
// must keep the DO half's row, not this one.
const KV_DUP_OF_DO = { ...DO_RUN, system: "scheduled-agent", outcome: "dup-kv" };

function makeEnv(opts: { doRuns?: unknown[] | null; doOk?: boolean } = {}) {
  const kv = new Map<string, string>();
  kv.set(
    `sessions:${SESSION_ID}`,
    JSON.stringify({ githubLogin: LOGIN, userId: "4203", login: LOGIN }),
  );
  const kvRuns = [KV_RUN, KV_DUP_OF_DO];
  const env: any = {
    SESSION_STORE: {
      idFromName: (name: string) => name,
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const body = (await req.json()) as {
            op: string;
            ns: string;
            key: string;
            value?: string;
          };
          const k = `${body.ns}:${body.key}`;
          if (body.op === "get") {
            return Response.json({ value: kv.get(k) ?? null });
          }
          if (body.op === "put") {
            kv.set(k, body.value ?? "");
            return Response.json({ ok: true });
          }
          if (body.op === "delete") {
            kv.delete(k);
            return Response.json({ ok: true });
          }
          return Response.json({ error: "unknown op" }, { status: 400 });
        },
      }),
    },
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname === "/schedules/runs") {
            if (opts.doOk === false) {
              return Response.json({ ok: false, error: "half down" }, { status: 500 });
            }
            return Response.json({ ok: true, runs: opts.doRuns ?? [DO_RUN] });
          }
          return Response.json({ ok: true });
        },
      }),
    },
    SCHEDULED_AGENT: {
      idFromName: (name: string) => name,
      get: (_id: unknown) => ({
        listJobRuns: async (_jobId?: string, _limit?: number) => kvRuns,
        listGoals: async () => [],
        getTickHistory: async () => [],
      }),
    },
  };
  return env as Env;
}

const authedGet = (env: Env, path: string) =>
  worker.fetch(
    new Request(`https://agent.test${path}`, {
      method: "GET",
      headers: { Cookie: `session_id=${SESSION_ID}` },
    }),
    env,
  );

describe("4203-P01 redirect: /api/schedule/runs answers the merged read", () => {
  it("returns both halves merged, newest-first, deduped — not the KV-only payload", async () => {
    const env = makeEnv();
    const res = await authedGet(env, "/api/schedule/runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; runs: unknown[]; partial: boolean };
    expect(body.ok).toBe(true);
    expect(body.partial).toBe(false);
    expect(body.runs).toEqual([DO_RUN, KV_RUN]);
  });

  it("applies the jobId filter to the merged list", async () => {
    const env = makeEnv();
    const res = await authedGet(env, "/api/schedule/runs?jobId=goal-b");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; runs: unknown[]; partial: boolean };
    expect(body.runs).toEqual([KV_RUN]);
  });
});

describe("4203-P02 merged read unchanged", () => {
  it("GET /api/ledger/runs returns the identical merged payload", async () => {
    const env = makeEnv();
    const [ledgerRes, directRes] = await Promise.all([
      authedGet(env, "/api/ledger/runs"),
      authedGet(env, "/api/schedule/runs"),
    ]);
    expect(ledgerRes.status).toBe(200);
    expect(directRes.status).toBe(200);
    expect(await ledgerRes.json()).toEqual(await directRes.json());
  });
});

describe("4203-P03 partial: a failed half degrades, never throws unmapped", () => {
  it("DO half down → partial:true with the KV half that succeeded", async () => {
    const env = makeEnv({ doOk: false });
    const res = await authedGet(env, "/api/schedule/runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; runs: unknown[]; partial: boolean };
    expect(body.ok).toBe(true);
    expect(body.partial).toBe(true);
    // The KV half that succeeded is BOTH KV rows, newest-first: the
    // KV-side copy of the DO row (KV_DUP_OF_DO) is the only surviving
    // copy of that run while the DO half is down, so it must be
    // returned — dropping it would silently lose history (#3123:
    // a failed fetch reads KV only so history is never dropped).
    // Dedup only prefers the DO row when the DO half answers (P01).
    expect(body.runs).toEqual([KV_DUP_OF_DO, KV_RUN]);
  });
});

describe("4203-P04 one read path (source pins)", () => {
  it("exactly one listJobRuns call site remains in trading.ts", () => {
    const trading = readFileSync("src/server/routes/trading.ts", "utf8");
    const calls = trading.match(/\.listJobRuns\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(trading).toContain("readMergedLedgerRuns(request, env, session.githubLogin)");
    const delegations = trading.match(/readMergedLedgerRuns\(request, env, session\.githubLogin\)/g) ?? [];
    expect(delegations).toHaveLength(2);
  });

  it("the catalog entry names the redirect target, not a direct DO forward", () => {
    const entry = API_ENDPOINT_CATALOG.find((e) => e.id === "schedule-runs-get");
    expect(entry).toBeDefined();
    expect(entry!.path).toBe("/api/schedule/runs");
    expect(entry!.authNote).toContain("/api/ledger/runs");
    expect(entry!.authNote).not.toContain("Forwards to the SCHEDULED_AGENT DO");
  });
});
