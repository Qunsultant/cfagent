// @vitest-environment node
/**
 * #2359 (#1976 step 4d) — CHARACTERIZATION for the orchestrator
 * tables + bypass closure slice, written against the UNMODIFIED
 * implementation (the four ensureTables-owned tables, the
 * recordMessage / configureContext bypasses, the reportDispatch
 * confirmations, the preset routes + resolution, the autopilot
 * state/verdict surfaces, and the canonical-report write seam
 * with its usage-metering companion). Every pin here must pass
 * before the cutover and keep passing after it: the slice moves
 * statements behind ports; it changes no behaviour.
 *
 * The class-level pins drive the real OrchestratorAgent under
 * the actor-cutover mock idiom (agents / Think / ai-chat stubbed
 * at the framework boundary) over a node:sqlite-backed storage
 * double with real SQL semantics. The module-level pins wire
 * each extracted module's context to that same class instance's
 * ensureTables — exactly how the class composes them in
 * production.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
vi.mock("@cloudflare/think", () => {
  return {
    Think: class StubThink {
      ctx: any;
      env: any;
      lifecycle: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
        this.lifecycle = { start: async () => {} };
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
      async listSchedules() {
        return [];
      }
      async cancelSchedule(_id: string) {
        return true;
      }
      async clearMessages() {}
    },
  };
});
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      messages: any[];
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
        this.messages = [];
      }
    },
  };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import {
  evaluateAndRecordAutopilotVerdict,
  getAutopilotState,
  readAutopilotStateRaw,
  writeAutopilotState,
  type AutopilotContext,
} from "../src/agents/orchestrator/autopilot";
import {
  createReportConfirmation,
  decideReportConfirmation,
  getReportConfirmation,
  getReportDispatchHitl,
  setReportDispatchHitl,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";
import { assembleGrounding, type ChatTurnHelpersContext } from "../src/agents/orchestrator/chatTurnHelpers";
import { handleAutopilotRoutes, type AutopilotRouteContext } from "../src/agents/routes/autopilot";
import { handleReportsRoutes } from "../src/agents/routes/reports";
import { handleScreenerPresetRoutes } from "../src/agents/routes/screenerPresets";
import { resolvePresetFilter } from "../src/services/screenerPresetResolution";
import {
  deleteCanonicalReport,
  ensureScheduledReportsTable,
  getCanonicalReport,
  getScheduledReportById,
  listScheduledReports,
  listUsageEvents,
  listUsageEventsByTenant,
  recordUsageEvent,
  searchScheduledReports,
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
} from "../src/services/scheduledReports";
import { runCanonicalIndexBackfillPage } from "../src/services/reportSemanticIndex";
import { DoSqliteCanonicalReportStore } from "../src/data/doSqliteCanonicalReportStoreAdapter";
import { DoSqliteUsageEventStore } from "../src/data/doSqliteUsageEventAdapter";
import { MockD1Database } from "./mock-d1";

/** SqlStorage-shaped executor over node:sqlite (real semantics).
 *  Write results carry rowsWritten, mirroring the DO cursor. */
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

const SESSION = "step4d-session";

function makeAgent(env: Record<string, unknown> = { AI: {}, SESSION_SECRET: "step4d-test-secret" }) {
  const sql = new SqliteTestStorage();
  const kv = new Map<string, unknown>();
  const ctx = {
    id: { toString: () => SESSION },
    storage: {
      sql,
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
    },
  };
  const agent = new OrchestratorAgent(ctx as never, env as never) as any;
  return { agent, sql };
}

function tableNames(sql: SqliteTestStorage): string[] {
  return Array.from(
    sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
  ).map((r: any) => String(r.name));
}

// ---------------------------------------------------------------------
// Class level: ensureTables DDL, recordMessage, configureContext,
// seed/purge — the orchestrator's own writes, pinned as found.
// ---------------------------------------------------------------------

describe("characterization 4d [class]: ensureTables + own writes", () => {
  it("ensureTables creates the four orchestrator-owned tables (and mas_settings), idempotently", () => {
    const { agent, sql } = makeAgent();
    agent.ensureTables();
    agent.ensureTables();
    const names = tableNames(sql);
    for (const t of ["mas_autopilot", "mas_settings", "mas_report_confirmations", "mas_screener_presets", "mas_policy_verdicts"]) {
      expect(names, t).toContain(t);
    }
    const verdictCols = Array.from(sql.exec("PRAGMA table_info(mas_policy_verdicts)")).map((c: any) => String(c.name));
    expect(verdictCols).toContain("signature");
    const idx = Array.from(sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_mas_policy_verdicts_created'"));
    expect(idx).toHaveLength(1);
  });

  it("the confirmations probed migration adds report_id to a pre-#308 table", () => {
    const { agent, sql } = makeAgent();
    sql.exec(`CREATE TABLE mas_report_confirmations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
    )`);
    agent.ensureTables();
    const cols = Array.from(sql.exec("PRAGMA table_info(mas_report_confirmations)")).map((c: any) => String(c.name));
    expect(cols).toContain("report_id");
  });

  it("recordMessage writes one mas_messages row, content truncated at 30000 chars", () => {
    const { agent, sql } = makeAgent();
    agent.recordMessage("user", "x".repeat(30_010), "orchestrator");
    const rows = Array.from(sql.exec("SELECT session_id, role, content, agent FROM mas_messages")) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe(SESSION);
    expect(rows[0].role).toBe("user");
    expect(rows[0].agent).toBe("orchestrator");
    expect(String(rows[0].content).length).toBe(30_000);
  });

  it("recordMessage never throws when the write fails", () => {
    const { agent, sql } = makeAgent();
    agent.ensureTables();
    sql.exec("DROP TABLE mas_messages");
    // ensureTables recreates the shared table, so break the write
    // itself: a duplicate id is not reachable from outside; instead
    // pin the swallow by dropping the table AND stubbing ensure.
    const original = agent.ensureTables.bind(agent);
    agent.ensureTables = () => {
      const s = original();
      sql.exec("DROP TABLE mas_messages");
      return s;
    };
    expect(() => agent.recordMessage("user", "hi", "orchestrator")).not.toThrow();
  });

  it("configureContext resolves the newest 8 memory facts, newest first; null when empty", async () => {
    const { agent, sql } = makeAgent();
    agent.ensureTables();
    const blocks = agent.configureContext();
    expect(blocks.map((b: any) => b.label)).toContain("session-memory");
    const resolve = blocks[0].resolve as () => Promise<string | null>;
    expect(await resolve()).toBeNull();
    for (let i = 0; i < 10; i++) {
      sql.exec(
        "INSERT INTO mas_memory (key, value, updated_at) VALUES (?, ?, ?)",
        `k${i}`,
        `v${i}`,
        `2026-10-29T10:00:${String(i).padStart(2, "0")}.000Z`
      );
    }
    const text = await resolve();
    const lines = String(text).split("\n");
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe(`- k9: "v9"`);
    expect(lines[7]).toBe(`- k2: "v2"`);
  });

  it("ensureTables seeds the four sponsor ads exactly once", () => {
    const { agent, sql } = makeAgent();
    agent.ensureTables();
    agent.ensureTables();
    const rows = Array.from(sql.exec("SELECT id FROM mas_ads ORDER BY id")) as any[];
    expect(rows.map((r) => r.id)).toEqual(["ad_ai_search", "ad_durable_objects", "ad_openaimp", "ad_workers_ai"]);
  });

  it("ensureTables purges the two fabricated seed transactions and keeps real rows", () => {
    const { agent, sql } = makeAgent();
    agent.ensureTables();
    const cols = Array.from(sql.exec("PRAGMA table_info(mas_transactions)")).map((c: any) => String(c.name));
    const insert = (id: string) => {
      const values = cols.map((c) => (c === "id" ? id : c.endsWith("_at") ? "2026-10-29T10:00:00.000Z" : ""));
      sql.exec(`INSERT INTO mas_transactions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...values);
    };
    insert("pay_init_stripe");
    insert("pay_init_paypal");
    insert("pay_real_1");
    agent.ensureTables();
    const ids = Array.from(sql.exec("SELECT id FROM mas_transactions")).map((r: any) => String(r.id));
    expect(ids).toEqual(["pay_real_1"]);
  });
});

// ---------------------------------------------------------------------
// Module level: autopilot state + verdict ledger.
// ---------------------------------------------------------------------

function autopilotCtx(agent: any, sql: SqliteTestStorage, audit?: AutopilotContext["audit"]): AutopilotContext {
  return {
    env: { SESSION_SECRET: "step4d-test-secret" } as never,
    ensureTables: () => agent.ensureTables(),
    getOrm: () => {
      throw new Error("getOrm not used by these pins");
    },
    audit: audit ?? (() => {}),
    autopilotStateKey: "autopilot_state_v1",
  } as AutopilotContext;
}

describe("characterization 4d [module]: autopilot state + verdicts", () => {
  it("state round-trips through write/get; raw is {} before any write", () => {
    const { agent, sql } = makeAgent();
    const ctx = autopilotCtx(agent, sql);
    expect(readAutopilotStateRaw(ctx)).toEqual({});
    const next = writeAutopilotState(ctx, { running: true });
    expect(next.running).toBe(true);
    expect(next.killSwitch).toBe(false);
    const again = writeAutopilotState(ctx, { killSwitch: true, killSwitchReason: "test halt" });
    expect(again.running).toBe(true);
    expect(again.killSwitchReason).toBe("test halt");
    expect(getAutopilotState(ctx).running).toBe(true);
  });

  it("ordersToday rolls to 0 when the stored date is not today", () => {
    const { agent, sql } = makeAgent();
    const ctx = autopilotCtx(agent, sql);
    agent.ensureTables();
    sql.exec(
      "INSERT OR REPLACE INTO mas_autopilot (key, value, updated_at) VALUES (?, ?, ?)",
      "autopilot_state_v1",
      JSON.stringify({ running: true, ordersToday: 7, ordersDate: "2000-01-01" }),
      "2000-01-01T00:00:00.000Z"
    );
    const state = getAutopilotState(ctx);
    expect(state.ordersToday).toBe(0);
    expect(state.ordersDate).toBe(new Date().toISOString().slice(0, 10));
    expect(state.running).toBe(true);
  });

  it("evaluateAndRecord persists a signed verdict row and emits the ledger audit", async () => {
    const { agent, sql } = makeAgent();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx = autopilotCtx(agent, sql, (type, _agent, payload) => audits.push({ type, payload }));
    const { verdict, attestation } = await evaluateAndRecordAutopilotVerdict(ctx, {
      userLogin: "alice",
      requestedEnv: undefined,
      sessionId: SESSION,
      intent: { symbol: "AAPL", action: "BUY", quantity: 5, orderType: "MARKET", estimatedPrice: 100, estimatedTotal: 500 },
      dryRun: true,
    });
    expect(attestation.signature).toBeTruthy();
    const rows = Array.from(sql.exec("SELECT * FROM mas_policy_verdicts")) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(verdict.verdictId);
    expect(rows[0].symbol).toBe("AAPL");
    expect(rows[0].dry_run).toBe(1);
    expect(rows[0].passed).toBe(verdict.passed ? 1 : 0);
    expect(rows[0].signature).toBe(attestation.signature);
    expect(audits.map((a) => a.type)).toContain("autopilot.policy_verdict");
  });

  it("GET /autopilot serves state + the newest verdicts in the route projection", async () => {
    const { agent, sql } = makeAgent();
    const ctx = autopilotCtx(agent, sql);
    await evaluateAndRecordAutopilotVerdict(ctx, {
      userLogin: "alice",
      requestedEnv: undefined,
      sessionId: SESSION,
      intent: { symbol: "MSFT", action: "BUY", quantity: 1, orderType: "MARKET", estimatedPrice: 10, estimatedTotal: 10 },
      dryRun: true,
    });
    const routeCtx: AutopilotRouteContext = {
      ensureTables: () => agent.ensureTables(),
      audit: () => {},
      getAutopilotState: () => getAutopilotState(ctx) as never,
      writeAutopilotState: (patch) => writeAutopilotState(ctx, patch) as never,
      evaluateAndRecordAutopilotVerdict: (params) => evaluateAndRecordAutopilotVerdict(ctx, params),
    };
    const res = await handleAutopilotRoutes(
      new Request("http://x/autopilot", { method: "GET" }),
      new URL("http://x/autopilot"),
      "/autopilot",
      SESSION,
      routeCtx
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.engine).toBe("riskPolicyEngine");
    expect(body.recentVerdicts).toHaveLength(1);
    expect(body.recentVerdicts[0].symbol).toBe("MSFT");
    expect(body.recentVerdicts[0]).not.toHaveProperty("limits_json");
  });
});

// ---------------------------------------------------------------------
// Module level: reportDispatch confirmations (+ the G-7 settings
// pair, pinned as found — it does NOT move in this slice).
// ---------------------------------------------------------------------

function dispatchCtx(agent: any): ReportDispatchContext {
  return {
    env: {} as never,
    ensureTables: () => agent.ensureTables(),
    getOrm: () => {
      throw new Error("getOrm not used by these pins");
    },
    reportDispatchHitlKey: "report_dispatch_hitl",
    reportConfirmationTtlMs: 24 * 60 * 60 * 1000,
    sendReportEmail: async () => true,
    sendReportWebhook: async () => ({ success: true }),
  } as ReportDispatchContext;
}

describe("characterization 4d [module]: report confirmations + settings pair", () => {
  it("create/get/decide round-trips a confirmation with its report link", () => {
    const { agent } = makeAgent();
    const ctx = dispatchCtx(agent);
    const id = createReportConfirmation(ctx, "email", JSON.stringify({ recipient: "a@b.c" }), "rep_1");
    expect(id).toMatch(/^rc_/);
    const row = getReportConfirmation(ctx, id);
    expect(row.status).toBe("pending");
    expect(row.kind).toBe("email");
    expect(row.report_id).toBe("rep_1");
    decideReportConfirmation(ctx, id, "approved", "alice");
    const decided = getReportConfirmation(ctx, id);
    expect(decided.status).toBe("approved");
    expect(decided.decided_by).toBe("alice");
    expect(decided.decided_at).toBeTruthy();
    expect(getReportConfirmation(ctx, "rc_missing")).toBeNull();
  });

  it("create sweeps pending confirmations older than the TTL, keeps fresh ones", () => {
    const { agent, sql } = makeAgent();
    const ctx = dispatchCtx(agent);
    agent.ensureTables();
    sql.exec(
      "INSERT INTO mas_report_confirmations (id, kind, payload_json, status, created_at, report_id) VALUES (?, ?, ?, ?, ?, ?)",
      "rc_old",
      "email",
      "{}",
      "pending",
      new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      null
    );
    const fresh = createReportConfirmation(ctx, "webhook", "{}", null);
    expect(getReportConfirmation(ctx, "rc_old")).toBeNull();
    expect(getReportConfirmation(ctx, fresh)).not.toBeNull();
  });

  it("the settings pair round-trips and HITL defaults ON (only explicit 0 opts out)", () => {
    const { agent } = makeAgent();
    const ctx = dispatchCtx(agent);
    expect(getReportDispatchHitl(ctx)).toBe(true);
    setReportDispatchHitl(ctx, false);
    expect(getReportDispatchHitl(ctx)).toBe(false);
    setReportDispatchHitl(ctx, true);
    expect(getReportDispatchHitl(ctx)).toBe(true);
  });

  it("GET /trading/reports/pending lists live confirmations and expires stale ones with an audit", async () => {
    const { agent, sql } = makeAgent();
    const ctx = dispatchCtx(agent);
    // The live row is created FIRST (creation itself sweeps expired
    // pendings); the stale row is inserted afterwards so the ROUTE's
    // expiry path — not the create sweep — is what this pin drives.
    const live = createReportConfirmation(ctx, "email", JSON.stringify({ recipient: "a@b.c", fileName: "r.xlsx" }), null);
    sql.exec(
      "INSERT INTO mas_report_confirmations (id, kind, payload_json, status, created_at, report_id) VALUES (?, ?, ?, ?, ?, ?)",
      "rc_stale",
      "email",
      JSON.stringify({ recipient: "a@b.c", fileName: "r.xlsx" }),
      "pending",
      new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      null
    );
    const audits: string[] = [];
    const res = await handleReportsRoutes(
      new Request("http://x/trading/reports/pending", { method: "GET" }),
      new URL("http://x/trading/reports/pending"),
      "/trading/reports/pending",
      SESSION,
      {
        ensureTables: () => agent.ensureTables(),
        reportConfirmationTtlMs: () => 24 * 60 * 60 * 1000,
        decideReportConfirmation: (id: string, status: "approved" | "rejected" | "expired", by: string | null) =>
          decideReportConfirmation(ctx, id, status, by),
        audit: (type: string) => audits.push(type),
      } as never
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.pending.map((p: any) => p.confirmationId)).toEqual([live]);
    expect(getReportConfirmation(ctx, "rc_stale")?.status).toBe("expired");
    expect(audits).toContain("research_report.confirmation_expired");
  });

  it("GET /trading/reports/confirmations joins a run through its canonical report row", async () => {
    const { agent, sql } = makeAgent();
    const ctx = dispatchCtx(agent);
    // #6101 step 8: seeded through the D1 seam now. NOTE — the
    // route's join still serves through the DO read port in src
    // (findIdByRunId over mas_reports), so it sees no row until
    // that join is migrated to D1; flagged to the parent, left failing.
    const mock = new MockD1Database();
    const env = { AGENT_DB: mock as unknown as never };
    const stored = await storeReportAtGeneration(
      {
        runId: "screener:2026-10-29T10:00:00.000Z",
        generationId: "screener:2026-10-29T10:00:00.000Z",
        userLogin: "alice",
        title: "Screen",
        source: "screener",
        summary: "s",
        body: {},
      },
      env,
    );
    expect(stored).not.toBeNull();
    const cid = createReportConfirmation(ctx, "screener", JSON.stringify({ delivery: { channel: "email" } }), stored!.reportId);
    const res = await handleReportsRoutes(
      new Request("http://x/trading/reports/confirmations?runId=screener:2026-10-29T10:00:00.000Z", { method: "GET" }),
      new URL("http://x/trading/reports/confirmations?runId=screener:2026-10-29T10:00:00.000Z"),
      "/trading/reports/confirmations",
      SESSION,
      {
        ensureTables: () => agent.ensureTables(),
        env,
        reportConfirmationTtlMs: () => 24 * 60 * 60 * 1000,
        decideReportConfirmation: (id: string, status: "approved" | "rejected" | "expired", by: string | null) =>
          decideReportConfirmation(ctx, id, status, by),
        audit: () => {},
      } as never
    );
    const body = (await res!.json()) as any;
    expect(body.confirmations.map((c: any) => c.confirmationId)).toEqual([cid]);
    const empty = await handleReportsRoutes(
      new Request("http://x/trading/reports/confirmations?runId=nope", { method: "GET" }),
      new URL("http://x/trading/reports/confirmations?runId=nope"),
      "/trading/reports/confirmations",
      SESSION,
      {
        ensureTables: () => agent.ensureTables(),
        env,
        reportConfirmationTtlMs: () => 24 * 60 * 60 * 1000,
        decideReportConfirmation: (id: string, status: "approved" | "rejected" | "expired", by: string | null) =>
          decideReportConfirmation(ctx, id, status, by),
        audit: () => {},
      } as never
    );
    expect(((await empty!.json()) as any).confirmations).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Module level: screener presets — routes + run-time resolution.
// ---------------------------------------------------------------------

describe("characterization 4d [module]: screener presets", () => {
  function presetCtx(agent: any) {
    return { ensureTables: () => agent.ensureTables() };
  }
  async function req(agent: any, method: string, path: string, login: string, body?: unknown) {
    return handleScreenerPresetRoutes(
      new Request(`http://x${path}`, {
        method,
        headers: { "x-user-login": login, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      new URL(`http://x${path}`),
      path,
      SESSION,
      presetCtx(agent)
    );
  }

  it("create/list/delete round-trips, scoped per user with no existence oracle", async () => {
    const { agent } = makeAgent();
    const created = await req(agent, "POST", "/screener/presets", "alice", {
      name: "RSI bounce",
      assetClass: "stocks",
      criteria: { minRsi: 30, maxRsi: 70, minVolume: 100000 },
    });
    expect(created?.status).toBe(201);
    const createdBody = (await created!.json()) as any;
    const id = createdBody.preset.id as string;
    const aliceList = (await (await req(agent, "GET", "/screener/presets", "alice"))!.json()) as any;
    expect(aliceList.presets).toHaveLength(1);
    expect(aliceList.presets[0].criteria).toEqual({ minRsi: 30, maxRsi: 70, minVolume: 100000 });
    const bobList = (await (await req(agent, "GET", "/screener/presets", "bob"))!.json()) as any;
    expect(bobList.presets).toEqual([]);
    const bobDelete = await req(agent, "DELETE", `/screener/presets/${id}`, "bob");
    expect(bobDelete?.status).toBe(404);
    const aliceDelete = await req(agent, "DELETE", `/screener/presets/${id}`, "alice");
    expect(aliceDelete?.status).toBe(200);
    const after = (await (await req(agent, "GET", "/screener/presets", "alice"))!.json()) as any;
    expect(after.presets).toEqual([]);
  });

  it("invalid criteria are rejected with 400 and nothing is stored", async () => {
    const { agent } = makeAgent();
    const res = await req(agent, "POST", "/screener/presets", "alice", {
      name: "bad",
      assetClass: "stocks",
      criteria: { nope: 1 },
    });
    expect(res?.status).toBe(400);
    const list = (await (await req(agent, "GET", "/screener/presets", "alice"))!.json()) as any;
    expect(list.presets).toEqual([]);
  });

  it("resolvePresetFilter resolves own presets and hides other users' rows", async () => {
    const { agent, sql } = makeAgent();
    const created = await req(agent, "POST", "/screener/presets", "alice", {
      name: "Calls",
      assetClass: "options",
      criteria: { contractType: "CALL", minDte: 7, maxDte: 45 },
    });
    const id = ((await created!.json()) as any).preset.id as string;
    const own = resolvePresetFilter(sql as never, "alice", id);
    expect(own.ok).toBe(true);
    if (own.ok) {
      expect(own.assetClass).toBe("options");
      expect(own.criteria).toEqual({ contractType: "CALL", minDte: 7, maxDte: 45 });
    }
    const other = resolvePresetFilter(sql as never, "bob", id);
    expect(other).toEqual({ ok: false, error: "Preset not found." });
    const missing = resolvePresetFilter(sql as never, "alice", "nope");
    expect(missing).toEqual({ ok: false, error: "Preset not found." });
  });
});

// ---------------------------------------------------------------------
// Chat grounding: the mas_memory read in chatTurnHelpers.
// ---------------------------------------------------------------------

describe("characterization 4d [module]: assembleGrounding memory read", () => {
  it("inlines the newest 8 facts in the legacy block format; empty when none", async () => {
    const { agent, sql } = makeAgent();
    agent.ensureTables();
    const ctx = {
      env: {},
      ensureTables: () => agent.ensureTables(),
      getOrm: () => {
        throw new Error("unused");
      },
      sessionKey: () => SESSION,
      audit: () => {},
      submitAsyncJob: async () => ({ jobId: "j", status: "queued" as const, statusUrl: "" }),
      getAsyncJob: () => undefined,
      listAsyncJobs: () => [],
      getMessages: async () => [],
      activeTurnMetadata: undefined,
    } as unknown as ChatTurnHelpersContext;
    const empty = await assembleGrounding(ctx, "");
    expect(empty.memoryContext).toBe("");
    sql.exec("INSERT INTO mas_memory (key, value, updated_at) VALUES (?, ?, ?)", "k1", "v1", "2026-10-29T10:00:00.000Z");
    sql.exec("INSERT INTO mas_memory (key, value, updated_at) VALUES (?, ?, ?)", "k2", "v2", "2026-10-29T10:01:00.000Z");
    const grounded = await assembleGrounding(ctx, "");
    expect(grounded.memoryContext).toBe(
      `\nActive Persistent Memory (SQLite Session Facts):\n- k2: "v2"\n- k1: "v1"`
    );
  });
});

// ---------------------------------------------------------------------
// The canonical-report write seam + usage metering (scheduledReports).
// ---------------------------------------------------------------------

describe("characterization 4d [seam]: canonical report store", () => {
  function seamSql() {
    return new SqliteTestStorage() as never;
  }
  // #6101 step 8: the canonical seam writes D1 agent_reports now
  // (the DO mas_reports table is frozen); reads go through the D1
  // list/search/by-id functions with an env-bound MockD1Database.
  // The DO sql handle stays for the usage-metering companion tests
  // below, which still own their DO store.
  function seamEnv() {
    const mock = new MockD1Database();
    return { AGENT_DB: mock as unknown as never };
  }
  const input = (over: Record<string, unknown> = {}) => ({
    runId: "run-1",
    generationId: "gen-1",
    userLogin: "alice",
    title: "Daily screen",
    source: "screener",
    summary: "10 scanned",
    body: { hello: "world" },
    ...over,
  });

  it("stores inline with a recorded fan-out outcome; reads back byte-identical", async () => {
    const env = seamEnv();
    const stored = await storeReportAtGeneration(input(), env);
    expect(stored?.created).toBe(true);
    expect(stored?.fanout.outcome).toBe("stored_inline");
    expect(stored?.fanout.body).toBe("inline");
    const hit = await getCanonicalReport(env, stored!.reportId);
    expect(hit?.title).toBe("Daily screen");
    expect(hit?.body).toBe(JSON.stringify({ hello: "world" }));
    expect(hit?.bodyR2Key).toBeNull();
    // #6101: D1 carries no fan-out column — the read-back outcome
    // is ALWAYS null (named loss). The store result above still
    // carries the outcome as known at return time.
    expect(hit?.fanoutOutcome).toBeNull();
  });

  it("dedupes on (generation, owner): second store returns the same row, still one row", async () => {
    const env = seamEnv();
    const first = await storeReportAtGeneration(input(), env);
    const second = await storeReportAtGeneration(input({ title: "Changed title" }), env);
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first?.reportId);
    expect(second?.fanout.outcome).toBe("deduped");
    expect(await listScheduledReports(env, { userLogin: "alice" })).toHaveLength(1);
    expect((await getCanonicalReport(env, first!.reportId))?.title).toBe("Daily screen");
    // INVERTED for #2398 (§7 — this was the #2359 as-found pin):
    // the generation UNIQUE index is tenant-scoped now —
    // (user_login, generation_id), matching the dedupe SELECT —
    // so a second tenant storing the same generation id lands
    // its OWN row (a stored outcome, no REPORT_FANOUT_FAILED),
    // and the first tenant's row is untouched.
    const other = await storeReportAtGeneration(input({ userLogin: "bob", title: "Bob screen" }), env);
    expect(other?.created).toBe(true);
    expect(other?.reportId).not.toBe(first?.reportId);
    expect(other?.fanout.outcome).toBe("stored_inline");
    expect(await listScheduledReports(env, {})).toHaveLength(2);
    expect(await listScheduledReports(env, { userLogin: "alice" })).toHaveLength(1);
    expect(await listScheduledReports(env, { userLogin: "bob" })).toHaveLength(1);
    expect((await getCanonicalReport(env, other!.reportId))?.title).toBe("Bob screen");
    expect((await getCanonicalReport(env, first!.reportId))?.title).toBe("Daily screen");
    // And bob's own re-store dedupes against HIS row, not alice's.
    const bobAgain = await storeReportAtGeneration(input({ userLogin: "bob", title: "Bob changed" }), env);
    expect(bobAgain?.created).toBe(false);
    expect(bobAgain?.reportId).toBe(other?.reportId);
    expect(await listScheduledReports(env, {})).toHaveLength(2);
  });

  it("refuses an owner-less write (null, no row) and bad input", async () => {
    const env = seamEnv();
    expect(await storeReportAtGeneration(input({ userLogin: "" }), env)).toBeNull();
    expect(await storeReportAtGeneration(input({ runId: "" }), env)).toBeNull();
    expect(await listScheduledReports(env, {})).toEqual([]);
  });

  it("R2 path: body put BEFORE the row insert; the row keeps only the pointer", async () => {
    const env = seamEnv();
    const objects = new Map<string, string>();
    const order: string[] = [];
    const bucket = {
      put: async (key: string, value: string) => {
        order.push("put");
        objects.set(key, value);
      },
      get: async (key: string) => {
        const text = objects.get(key);
        return text === undefined ? null : { text: async () => text };
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    };
    const stored = await storeReportAtGenerationWithR2({ ...env, REPORTS_BUCKET: bucket as never }, input());
    expect(stored?.created).toBe(true);
    expect(stored?.fanout.outcome).toBe("stored_r2");
    const hit = await getCanonicalReport(env, stored!.reportId);
    expect(hit?.body).toBe("");
    expect(hit?.bodyR2Key).toBe(`reports/${stored!.reportId}.json`);
    expect(objects.get(hit!.bodyR2Key!)).toBe(JSON.stringify({ hello: "world" }));
    // The coupled delete removes the object with the row.
    expect(await deleteCanonicalReport({ ...env, REPORTS_BUCKET: bucket as never }, stored!.reportId)).toBe(true);
    expect(objects.size).toBe(0);
    expect(await getCanonicalReport(env, stored!.reportId)).toBeNull();
  });

  it("R2 put failure falls back to the inline shape and records inline_fallback", async () => {
    const env = seamEnv();
    const bucket = {
      put: async () => {
        throw new Error("r2 down");
      },
    };
    const stored = await storeReportAtGenerationWithR2({ ...env, REPORTS_BUCKET: bucket as never }, input());
    expect(stored?.created).toBe(true);
    expect(stored?.fanout.outcome).toBe("stored_inline_fallback");
    expect(stored?.fanout.code).toBe("DATA_REPORT_FANOUT_DEGRADED");
    const hit = await getCanonicalReport(env, stored!.reportId);
    expect(hit?.body).toBe(JSON.stringify({ hello: "world" }));
    expect(hit?.bodyR2Key).toBeNull();
  });

  it("search/list/by-id honour owner scoping exactly as the legacy reads", async () => {
    const env = seamEnv();
    await storeReportAtGeneration(input(), env);
    await storeReportAtGeneration(input({ runId: "run-2", generationId: "gen-2", userLogin: "bob", title: "Bob screen" }), env);
    expect((await searchScheduledReports(env, "screen", 5, { userLogin: "alice" })).map((h) => h.title)).toEqual(["Daily screen"]);
    expect(await searchScheduledReports(env, "screen", 5)).toHaveLength(2);
    expect((await listScheduledReports(env, { userLogin: "bob" })).map((h) => h.title)).toEqual(["Bob screen"]);
    const aliceId = (await listScheduledReports(env, { userLogin: "alice" }))[0].id;
    expect(await getScheduledReportById(env, aliceId, { userLogin: "bob" })).toBeNull();
    expect((await getScheduledReportById(env, aliceId, { userLogin: "alice" }))?.title).toBe("Daily screen");
    expect((await getScheduledReportById(env, aliceId))?.title).toBe("Daily screen");
  });

  it("usage metering round-trips per tenant and refuses bad input", () => {
    const sql = seamSql();
    const id = recordUsageEvent(sql, { userLogin: "alice", runId: "run-1", category: "research_run", detail: { n: 1 }, tenantId: "tenant-a" });
    expect(id).toMatch(/^use_/);
    recordUsageEvent(sql, { userLogin: "bob", runId: "run-2", category: "research_evaluation", tenantId: "tenant-b" });
    expect(listUsageEvents(sql, "alice").map((e) => e.category)).toEqual(["research_run"]);
    expect(listUsageEvents(sql, "alice")[0].runId).toBe("run-1");
    expect(listUsageEvents(sql, "alice")[0].tenantId).toBe("tenant-a");
    expect(recordUsageEvent(sql, { userLogin: "", runId: "r", category: "c" })).toBeNull();
    // Issue #3185: the tenant read is the same rows, tenant-scoped.
    expect(listUsageEventsByTenant(sql, "tenant-a").map((e) => e.runId)).toEqual(["run-1"]);
    expect(listUsageEventsByTenant(sql, "tenant-b").map((e) => e.runId)).toEqual(["run-2"]);
  });

  it("a legacy usage_events table without tenant_id upgrades in place, legacy rows stay NULL (issue #3185)", () => {
    const sql = seamSql();
    // The pre-#3185 shape: no tenant_id column at all.
    sql.exec(`CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      user_login TEXT NOT NULL,
      run_id TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at TEXT NOT NULL,
      detail_json TEXT
    )`);
    sql.exec(
      `INSERT INTO usage_events (id, user_login, run_id, category, created_at, detail_json) VALUES (?, ?, ?, ?, ?, ?)`,
      "use_legacy",
      "alice",
      "run-legacy",
      "research_run",
      "2026-11-01T00:00:00.000Z",
      null,
    );
    // The ensure path probes and ALTERs the column in place.
    const stamped = recordUsageEvent(sql, { userLogin: "alice", runId: "run-1", category: "research_run", tenantId: "tenant-a" });
    expect(stamped).toMatch(/^use_/);
    const events = listUsageEvents(sql, "alice");
    // Newest first: the stamped row, then the legacy row.
    expect(events.map((e) => e.runId)).toEqual(["run-1", "run-legacy"]);
    expect(events[0].tenantId).toBe("tenant-a");
    expect(events[1].tenantId).toBeNull();
    expect(listUsageEventsByTenant(sql, "tenant-a").map((e) => e.runId)).toEqual(["run-1"]);
    const cols = Array.from(sql.exec("PRAGMA table_info(usage_events)")) as Array<{ name?: unknown }>;
    expect(cols.map((c) => String(c.name))).toContain("tenant_id");
  });

  it("retention prune + DSAR delete/count on the DO usage-event store (#3185 bridge)", () => {
    const sql = seamSql();
    const store = new DoSqliteUsageEventStore(sql);
    const seed = (id: string, login: string, createdAt: string) =>
      sql.exec(
        `INSERT INTO usage_events (id, user_login, run_id, category, created_at, detail_json, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, login, `run-${id}`, "research_run", createdAt, null, "tenant-a",
      );
    // ensureSchema via a first record, then direct seeds with
    // controlled timestamps (the store's prune is 365d).
    recordUsageEvent(sql, { userLogin: "alice", runId: "run-seed", category: "research_run", tenantId: "tenant-a" });
    seed("use_old_alice", "alice", "2025-01-01T00:00:00.000Z");
    seed("use_new_alice", "alice", "2026-11-01T00:00:00.000Z");
    seed("use_old_bob", "bob", "2025-01-01T00:00:00.000Z");
    expect(store.countByUser("alice")).toBe(3);
    expect(store.countByUser("bob")).toBe(1);
    // The 365d prune drops only the old rows, both logins.
    expect(store.pruneBefore("2026-01-01T00:00:00.000Z")).toBe(2);
    expect(store.countByUser("alice")).toBe(2);
    expect(store.countByUser("bob")).toBe(0);
    // DSAR delete erases one login only.
    expect(store.deleteByUser("alice")).toBe(2);
    expect(store.countByUser("alice")).toBe(0);
    expect(listUsageEvents(sql, "alice")).toEqual([]);
  });

  it("the index backfill page reads stored rows in creation order", async () => {
    const sql = seamSql();
    // #6101 step 8: the backfill page is DO-only BY DECISION (the
    // route + weekly sweep read frozen DO rows via
    // listIndexBackfillRows; a D1 backfill would need a different
    // design — list recent D1 rows, re-publish idempotently — and
    // is not in this slice). So the rows are seeded into the
    // frozen DO table through its store port, not the D1 seam:
    // D1-seeded rows are invisible to this page by design.
    ensureScheduledReportsTable(sql);
    const store = new DoSqliteCanonicalReportStore(sql as never);
    const seedDo = (over: Record<string, unknown>) => {
      const base = input(over);
      store.insertRow({
        id: `rep-${base.generationId}`,
        runId: base.runId as string,
        title: base.title as string,
        source: base.source as string,
        summary: base.summary as string,
        body: JSON.stringify(base.body),
        createdAt: base.createdAt as string,
        generationId: base.generationId as string,
        owner: base.userLogin as string,
        bodyR2Key: null,
        fanoutOutcomeJson: "{}",
      });
    };
    seedDo({ createdAt: "2026-10-29T10:00:00.000Z" });
    seedDo({ runId: "run-2", generationId: "gen-2", createdAt: "2026-10-29T10:01:00.000Z" });
    seedDo({ runId: "run-3", generationId: "gen-3", createdAt: "2026-10-29T10:02:00.000Z" });
    const page1 = await runCanonicalIndexBackfillPage(undefined, sql, { limit: 2, offset: 0 });
    expect(page1.rows).toBe(2);
    expect(page1.upserted).toBe(0);
    expect(page1.nextOffset).toBe(2);
    const page2 = await runCanonicalIndexBackfillPage(undefined, sql, { limit: 2, offset: 2 });
    expect(page2.rows).toBe(1);
    expect(page2.nextOffset).toBeNull();
  });
});
