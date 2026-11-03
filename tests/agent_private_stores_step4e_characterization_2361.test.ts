// @vitest-environment node
/**
 * Issue #2361 (#1976 step 4e) — CHARACTERIZATION for the agent-private
 * stores, written BEFORE the port cutover and required to stay green
 * after it. Everything here drives the REAL agent classes (or the real
 * lock module) over a node:sqlite storage double — no behaviour is
 * reimplemented in the test.
 *
 * Pins, by area:
 *
 *  ResearchAgent tables (research_settings / research_runs /
 *  research_evaluations / research_task_store):
 *   - ensureTables creates exactly the four agent-private tables,
 *     idempotently, and NEVER any shared-schema (mas_*) table — the
 *     R-7 property from step 3a in its observable form: this agent's
 *     storage setup touches only its own tables.
 *   - The settings/task KV stores are FAIL-SOFT on a fresh store
 *     (get → null, list → []) — runDiscoveryIfDue reads its marker
 *     before any ensure runs, so the property is load-bearing.
 *   - Settings writes are single-row DELETE+INSERT overwrites.
 *   - The config service round-trips through the public RPC-shaped
 *     methods, and an invalid patch is rejected atomically.
 *   - The task ledger lifecycle (create idempotency, begin, heartbeat,
 *     complete, fail → escalate, stale sweep) over the agent's store.
 *   - persistRun upserts by run_id (one row, latest JSON wins) and
 *     stamps status published / no_qualifying from the idea count;
 *     the KV history list separately appends one summary per persist.
 *   - getTrackRecord orders runs newest-first and joins the LATEST
 *     evaluation per run.
 *   - evaluateDueRuns selects exactly the old, not-yet-evaluated runs;
 *     a due run whose report carries no research identity is attempted
 *     and reported as failed without any provider contact.
 *   - runDiscoveryIfDue's no-fire paths (weekend / too-early /
 *     already-fired) read the durable marker from this agent's own
 *     settings store.
 *
 *  Screen-run lock module (services/screenRunLock.ts) over REAL
 *  sqlite (the fake-based suites pin the statement logic; this pins
 *  the same state machine against real statement semantics):
 *   - acquire → contention → release-by-token cycle, wrong/null token
 *     releases are no-ops, per (user, universe) scoping.
 *   - isScreenRunning boundary: exactly STALE_MS old still counts as
 *     running; one ms older does not (but startedAt is still reported).
 *   - stale takeover transfers ownership and reports tookOverStale.
 *   - release does NOT ensure the table (as-found: it throws on a
 *     store where the lock table was never created).
 *
 *  ScreenerAgent lock wiring (the class composes the lock over its own
 *  ctx.storage.sql):
 *   - isScreenRunning on a fresh agent reports not-running and creates
 *     the lock table in the agent's own storage.
 *   - a lock held (via the module, same storage) makes the probe
 *     report running and makes runScreen reject with the
 *     operator-facing "Screen already running for <universe>" error
 *     before any screening work starts.
 *   - a stale held lock probes as not-running.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("agents", () => {
  class MockAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  }
  return { Agent: MockAgent, getCurrentAgent: () => undefined };
});

vi.mock("../src/actors/thinkAdapter", () => {
  class MockPortThink {
    name: string | undefined;
    initialState: unknown;
    ctx: any;
    env: any;
    constructor(ctx: any, env: any, _opts?: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    async schedule(): Promise<void> {}
    async scheduleEvery(): Promise<string> {
      return "mock";
    }
    async cancelSchedule(): Promise<boolean> {
      return true;
    }
    async getSchedule(): Promise<undefined> {
      return undefined;
    }
    async getSchedules(): Promise<[]> {
      return [];
    }
  }
  return { PortThink: MockPortThink };
});

import {
  ResearchAgent,
  RESEARCH_DISCOVERY_LAST_RUN_KEY,
} from "../src/agents/research-agent";
import { ScreenerAgent } from "../src/agents/screener-agent";
import { evaluateResearchOutcome } from "../src/services/researchTaskLedger";
import {
  SCREEN_RUN_LOCK_STALE_MS,
  acquireScreenRunLock,
  ensureScreenRunLockTable,
  isScreenRunning,
  releaseScreenRunLock,
  type ScreenRunLockSql,
} from "../src/services/screenRunLock";

/** node:sqlite-backed SqlStorage double (same shape as the step-4d harness). */
class SqliteTestStorage {
  private db = new DatabaseSync(":memory:");
  exec(query: string, ...args: unknown[]): unknown[] {
    const stmt = this.db.prepare(query);
    const verb = query.trimStart().slice(0, 6).toUpperCase();
    if (verb === "SELECT" || query.trimStart().toUpperCase().startsWith("PRAGMA")) {
      return stmt.all(...(args as any[])) as unknown[];
    }
    const info = stmt.run(...(args as any[]));
    return [{ rowsWritten: Number(info.changes) }];
  }
  tableNames(): string[] {
    const rows = this.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }
}

function makeCtx(sql: SqliteTestStorage): any {
  const kv = new Map<string, unknown>();
  return {
    storage: {
      sql,
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
      list: async () => new Map(),
    },
  };
}

function makeResearchAgent(sql = new SqliteTestStorage()): ResearchAgent {
  return new ResearchAgent(makeCtx(sql), {} as any);
}

function makeScreenerAgent(sql = new SqliteTestStorage()): ScreenerAgent {
  return new ScreenerAgent(makeCtx(sql), {} as any);
}

/** The lock module's callback shape, bound to a storage double. */
function lockSqlOver(sql: SqliteTestStorage): ScreenRunLockSql {
  return (query: string, params: unknown[]) =>
    sql.exec(query, ...params) as Array<Record<string, unknown>>;
}

function reportFixture(over: Record<string, unknown> = {}): any {
  return {
    runId: "run-1",
    trigger: "manual",
    userLogin: "alice",
    createdAt: "2026-10-20T21:05:00.000Z",
    rulesVersion: "1.0.0",
    summary: "2 ideas published",
    ideas: [
      {
        symbol: "AVGO",
        structure: "bull_put_spread",
        outlook: "bullish",
        thesis: "t",
        invalidation: "i",
        entrySpot: 100,
        legs: [{ quantity: 1 }, { quantity: -1 }],
        economics: { maxLoss: 200 },
      },
      {
        symbol: "MSFT",
        structure: "iron_condor",
        outlook: "neutral",
        thesis: "t",
        invalidation: "i",
        entrySpot: 400,
        legs: [{ quantity: 1 }],
        economics: { maxLoss: 100 },
      },
    ],
    watchlist: [],
    rejected: [],
    candidates: [],
    ...over,
  };
}

describe("characterization 4e: ResearchAgent's private tables", () => {
  it("ensureTables creates exactly the four agent-private tables, idempotently, and no shared-schema tables", () => {
    const sql = new SqliteTestStorage();
    const agent = makeResearchAgent(sql);
    (agent as any).ensureTables();
    (agent as any).ensureTables();
    const names = sql.tableNames();
    for (const t of [
      "research_settings",
      "research_runs",
      "research_evaluations",
      "research_task_store",
    ]) {
      expect(names).toContain(t);
    }
    // R-7 observable form: nothing from the shared ORM schema appears.
    expect(names.some((n) => n.startsWith("mas_"))).toBe(false);
    expect(names.some((n) => n.startsWith("screener"))).toBe(false);
  });

  it("settings and task stores are fail-soft before any ensure (missing table reads as empty)", () => {
    const agent = makeResearchAgent();
    expect((agent as any).settingsStore().get("anything")).toBeNull();
    expect((agent as any).taskStore().get("anything")).toBeNull();
    expect((agent as any).taskStore().list("research:task:")).toEqual([]);
  });

  it("settings writes are single-row overwrites carrying an updated_at stamp", () => {
    const sql = new SqliteTestStorage();
    const agent = makeResearchAgent(sql);
    (agent as any).ensureTables();
    const store = (agent as any).settingsStore();
    store.set("k1", "v1");
    store.set("k1", "v2");
    expect(store.get("k1")).toBe("v2");
    const rows = sql.exec(
      "SELECT value, updated_at FROM research_settings WHERE key = 'k1'"
    ) as Array<{ value: string; updated_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].updated_at).toBeTruthy();
    store.set("k2", "other");
    expect((sql.exec("SELECT key FROM research_settings") as unknown[]).length).toBe(2);
  });

  it("config service round-trips through the public methods; an invalid patch is rejected atomically", async () => {
    const agent = makeResearchAgent();
    (agent as any).ensureTables();
    expect((await agent.getResearchConfig()).maxIdeas).toBe(5);
    const saved = await agent.saveConfig({ maxIdeas: 7 });
    expect(saved.errors).toEqual([]);
    expect((await agent.getResearchConfig()).maxIdeas).toBe(7);
    const rejected = await agent.saveConfig({ maxIdeas: 99 });
    expect(rejected.errors).toEqual(["maxIdeas must be 1..20"]);
    // Atomic rejection: the stored value is untouched.
    expect((await agent.getResearchConfig()).maxIdeas).toBe(7);
  });

  it("task lifecycle over the agent's own store: create (idempotent), begin, heartbeat, complete", async () => {
    const agent = makeResearchAgent();
    (agent as any).ensureTables();
    const first = await agent.createResearchTask({
      kind: "goal_discovery",
      userLogin: "alice",
      idempotencyKey: "char-1",
      payload: { goals: [] },
    });
    expect(first.created).toBe(true);
    expect(first.task.status).toBe("queued");
    const dupe = await agent.createResearchTask({
      kind: "goal_discovery",
      userLogin: "alice",
      idempotencyKey: "char-1",
      payload: { goals: [] },
    });
    expect(dupe.created).toBe(false);
    expect(dupe.task.id).toBe(first.task.id);

    const begun = await agent.beginResearchTask(first.task.id);
    expect(begun?.status).toBe("running");
    const beaten = await agent.heartbeatResearchTask(first.task.id);
    expect(beaten?.status).toBe("running");
    const evaluation = evaluateResearchOutcome({
      status: "produced",
      ideaCount: 2,
      evaluatedCount: 2,
      minIdeas: 1,
      checks: [],
    } as any);
    const done = await agent.completeResearchTask(first.task.id, {
      path: "agent",
      reportRunId: "run-1",
      evaluation,
    });
    expect(done?.status).toBe("completed");
    expect(done?.reportRunId).toBe("run-1");
    const listed = await agent.listResearchTasks(10);
    expect(listed.map((t) => t.id)).toEqual([first.task.id]);
  });

  it("fail escalates, and the stale sweep closes an abandoned active task as escalated", async () => {
    const agent = makeResearchAgent();
    (agent as any).ensureTables();
    const a = await agent.createResearchTask({
      kind: "goal_discovery",
      userLogin: "alice",
      idempotencyKey: "char-fail",
      payload: {},
    });
    await agent.beginResearchTask(a.task.id);
    const failed = await agent.failResearchTask(a.task.id, "provider down", true);
    expect(failed?.status).toBe("escalated");

    const b = await agent.createResearchTask({
      kind: "goal_discovery",
      userLogin: "alice",
      idempotencyKey: "char-stale",
      payload: {},
    });
    await agent.beginResearchTask(b.task.id);
    // A negative threshold makes "staleness" a pure function of stored
    // state (any recorded heartbeat is older than now + 1ms) — no
    // wall-clock waiting, no flakiness.
    const stale = await agent.findStaleResearchTasks(-1);
    expect(stale.map((t) => t.id)).toEqual([b.task.id]);
    const swept = await agent.sweepStaleResearchTasks(-1);
    expect(swept.map((t) => t.id)).toEqual([b.task.id]);
    expect((await agent.getResearchTask(b.task.id))?.status).toBe("escalated");
  });

  it("persistRun upserts by run_id with status from the idea count; the KV history appends per persist", async () => {
    const sql = new SqliteTestStorage();
    const agent = makeResearchAgent(sql);
    (agent as any).ensureTables();
    await (agent as any).persistRun(reportFixture());
    let rows = sql.exec(
      "SELECT status, ideas_count FROM research_runs WHERE run_id = 'run-1'"
    ) as Array<{ status: string; ideas_count: number }>;
    expect(rows).toEqual([{ status: "published", ideas_count: 2 }]);

    await (agent as any).persistRun(
      reportFixture({ summary: "revised", ideas: [] })
    );
    rows = sql.exec(
      "SELECT status, ideas_count FROM research_runs WHERE run_id = 'run-1'"
    ) as Array<{ status: string; ideas_count: number }>;
    // Still exactly one row; the second write replaced it wholesale.
    // Still exactly one table row; the second write replaced it
    // wholesale. The KV history is a separate append-per-persist list:
    // both persists are recorded there, newest first.
    expect(rows).toEqual([{ status: "no_qualifying", ideas_count: 0 }]);
    const history = await agent.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ runId: "run-1", ideas: 0 });
    expect(history[1]).toMatchObject({ runId: "run-1", ideas: 2 });
  });

  it("getTrackRecord: newest run first, and the LATEST evaluation per run wins the join", async () => {
    const sql = new SqliteTestStorage();
    const agent = makeResearchAgent(sql);
    (agent as any).ensureTables();
    await (agent as any).persistRun(
      reportFixture({ runId: "run-old", createdAt: "2026-10-19T21:05:00.000Z" })
    );
    await (agent as any).persistRun(
      reportFixture({
        runId: "run-new",
        createdAt: "2026-10-21T21:05:00.000Z",
        ideas: [reportFixture().ideas[0]],
      })
    );
    // Two evaluations of run-old, inserted oldest-first (the agent's
    // read order); the later evaluatedAt must win.
    const seedEval = (id: string, evaluatedAt: string, pnl: number) =>
      sql.exec(
        "INSERT INTO research_evaluations (id, run_id, evaluated_at, evaluation_json) VALUES (?, ?, ?, ?)",
        id,
        "run-old",
        evaluatedAt,
        JSON.stringify({
          runId: "run-old",
          evaluatedAt,
          ideas: [
            {
              symbol: "AVGO",
              structure: "bull_put_spread",
              pnlEstimatePerUnit: pnl,
              evalSpot: 101,
              directionCorrect: true,
              invalidated: false,
              notes: [],
            },
          ],
        })
      );
    seedEval("ev-1", "2026-10-22T21:00:00.000Z", -50);
    seedEval("ev-2", "2026-10-23T21:00:00.000Z", 75);

    const record = await agent.getTrackRecord();
    expect(record.published).toBe(3);
    expect(record.evaluated).toBe(1);
    expect(record.ideas[0].runId).toBe("run-new");
    const avgo = record.ideas.find(
      (i) => i.runId === "run-old" && i.symbol === "AVGO"
    );
    expect(avgo?.evaluation?.pnlEstimatePerUnit).toBe(75);
  });

  it("evaluateDueRuns selects exactly the old un-evaluated runs; an identity-less report fails without provider contact", async () => {
    const sql = new SqliteTestStorage();
    const agent = makeResearchAgent(sql);
    (agent as any).ensureTables();
    const now = Date.parse("2026-10-25T12:00:00.000Z");
    const seedRun = (runId: string, createdAt: string, report: unknown) =>
      sql.exec(
        "INSERT INTO research_runs (run_id, trigger, user_login, created_at, rules_version, status, ideas_count, report_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        runId,
        "scheduled",
        "alice",
        createdAt,
        "1.0.0",
        "published",
        1,
        JSON.stringify(report)
      );
    // Due: 4 days old, never evaluated, report carries NO userLogin —
    // evaluateRun declines on identity before any provider is built.
    seedRun("due-1", "2026-10-21T21:05:00.000Z", {
      runId: "due-1",
      createdAt: "2026-10-21T21:05:00.000Z",
      ideas: [],
    });
    // Not due: old but already evaluated.
    seedRun("done-1", "2026-10-21T21:05:00.000Z", {
      runId: "done-1",
      userLogin: "alice",
      createdAt: "2026-10-21T21:05:00.000Z",
      ideas: [],
    });
    sql.exec(
      "INSERT INTO research_evaluations (id, run_id, evaluated_at, evaluation_json) VALUES (?, ?, ?, ?)",
      "ev-done",
      "done-1",
      "2026-10-22T21:00:00.000Z",
      "{}"
    );
    // Not due: only one hour old.
    seedRun("young-1", "2026-10-25T11:00:00.000Z", {
      runId: "young-1",
      userLogin: "alice",
      createdAt: "2026-10-25T11:00:00.000Z",
      ideas: [],
    });
    const result = await agent.evaluateDueRuns(undefined, 24 * 3600_000, now);
    expect(result).toEqual({ evaluated: [], failed: ["due-1"] });
  });

  it("runDiscoveryIfDue no-fire paths read the marker from the agent's own settings store", async () => {
    const sql = new SqliteTestStorage();
    const agent = makeResearchAgent(sql);
    // Fresh store, no tables yet: the marker read must not throw.
    const weekend = await agent.runDiscoveryIfDue(
      new Date("2026-10-31T22:00:00.000Z"),
      { userLogin: "alice" }
    );
    expect(weekend).toEqual({ fired: false, dateKey: "2026-10-31" });
    const tooEarly = await agent.runDiscoveryIfDue(
      new Date("2026-11-02T10:00:00.000Z"),
      { userLogin: "alice" }
    );
    expect(tooEarly).toEqual({ fired: false, dateKey: "2026-11-02" });
    // Marker already written for the day → already-fired, at fire hour.
    (agent as any).ensureTables();
    (agent as any)
      .settingsStore()
      .set(RESEARCH_DISCOVERY_LAST_RUN_KEY, "2026-11-02");
    const already = await agent.runDiscoveryIfDue(
      new Date("2026-11-02T22:30:00.000Z"),
      { userLogin: "alice" }
    );
    expect(already).toEqual({ fired: false, dateKey: "2026-11-02" });
  });
});

describe("characterization 4e: screen-run lock module over real sqlite", () => {
  it("acquire / contention / token-release cycle with per-scope isolation", () => {
    const sql = new SqliteTestStorage();
    const exec = lockSqlOver(sql);
    ensureScreenRunLockTable(exec);
    const t0 = 1_700_000_000_000;
    const first = acquireScreenRunLock(exec, "alice", "nasdaq100", t0);
    expect(first.acquired).toBe(true);
    expect(first.tookOverStale).toBe(false);
    expect(first.startedAt).toBe(t0);
    expect(first.token).toBeTruthy();

    const blocked = acquireScreenRunLock(exec, "alice", "nasdaq100", t0 + 1000);
    expect(blocked.acquired).toBe(false);
    expect(blocked.startedAt).toBe(t0);

    // Different universe and different user are independent scopes.
    expect(acquireScreenRunLock(exec, "alice", "sp500", t0).acquired).toBe(true);
    expect(acquireScreenRunLock(exec, "bob", "nasdaq100", t0).acquired).toBe(true);

    // Wrong token and null token releases change nothing.
    releaseScreenRunLock(exec, "alice", "nasdaq100", "not-the-token");
    expect(isScreenRunning(exec, "alice", "nasdaq100", t0 + 2000).running).toBe(true);
    releaseScreenRunLock(exec, "alice", "nasdaq100", null);
    expect(isScreenRunning(exec, "alice", "nasdaq100", t0 + 2000).running).toBe(true);

    releaseScreenRunLock(exec, "alice", "nasdaq100", first.token);
    expect(isScreenRunning(exec, "alice", "nasdaq100", t0 + 2000)).toEqual({
      running: false,
      startedAt: null,
    });
    expect(acquireScreenRunLock(exec, "alice", "nasdaq100", t0 + 3000).acquired).toBe(true);
  });

  it("staleness boundary: exactly STALE_MS still runs; +1ms does not, and takeover transfers ownership", () => {
    const sql = new SqliteTestStorage();
    const exec = lockSqlOver(sql);
    ensureScreenRunLockTable(exec);
    const t0 = 1_700_000_000_000;
    const holder = acquireScreenRunLock(exec, "alice", "nasdaq100", t0);
    expect(holder.acquired).toBe(true);
    expect(isScreenRunning(exec, "alice", "nasdaq100", t0 + SCREEN_RUN_LOCK_STALE_MS)).toEqual({
      running: true,
      startedAt: t0,
    });
    expect(
      isScreenRunning(exec, "alice", "nasdaq100", t0 + SCREEN_RUN_LOCK_STALE_MS + 1)
    ).toEqual({ running: false, startedAt: t0 });

    const takeover = acquireScreenRunLock(
      exec,
      "alice",
      "nasdaq100",
      t0 + SCREEN_RUN_LOCK_STALE_MS + 1
    );
    expect(takeover.acquired).toBe(true);
    expect(takeover.tookOverStale).toBe(true);
    expect(takeover.startedAt).toBe(t0 + SCREEN_RUN_LOCK_STALE_MS + 1);
    // The old holder's token no longer releases the lock.
    releaseScreenRunLock(exec, "alice", "nasdaq100", holder.token);
    expect(
      isScreenRunning(exec, "alice", "nasdaq100", t0 + SCREEN_RUN_LOCK_STALE_MS + 2)
        .running
    ).toBe(true);
    releaseScreenRunLock(exec, "alice", "nasdaq100", takeover.token);
    expect(
      isScreenRunning(exec, "alice", "nasdaq100", t0 + SCREEN_RUN_LOCK_STALE_MS + 2)
        .running
    ).toBe(false);
  });

  it("release does not ensure the table (as-found: throws when the lock table was never created)", () => {
    const sql = new SqliteTestStorage();
    const exec = lockSqlOver(sql);
    expect(() => releaseScreenRunLock(exec, "alice", "nasdaq100", "tok")).toThrow(
      /no such table/
    );
  });
});

describe("characterization 4e: ScreenerAgent lock wiring", () => {
  it("fresh agent: probe reports not-running and creates the lock table in the agent's own storage", async () => {
    const sql = new SqliteTestStorage();
    const agent = makeScreenerAgent(sql);
    // #2840: the probe also reports the in-flight run id + status
    // (null / "idle" when nothing runs).
    await expect(agent.isScreenRunning("nasdaq100", "owner")).resolves.toEqual({
      running: false,
      startedAt: null,
      runId: null,
      status: "idle",
    });
    expect(sql.tableNames()).toContain("screen_run_locks");
  });

  it("a held lock makes the probe report running and runScreen reject before any screening", async () => {
    const sql = new SqliteTestStorage();
    const agent = makeScreenerAgent(sql);
    const exec = lockSqlOver(sql);
    const held = acquireScreenRunLock(exec, "owner", "nasdaq100", Date.now());
    expect(held.acquired).toBe(true);
    await expect(agent.isScreenRunning("nasdaq100", "owner")).resolves.toEqual({
      running: true,
      startedAt: held.startedAt,
      runId: `screen:owner:nasdaq100:${held.startedAt}`,
      status: "running",
    });
    await expect(agent.isScreenRunning("sp500", "owner")).resolves.toEqual({
      running: false,
      startedAt: null,
      runId: null,
      status: "idle",
    });
    await expect(
      agent.runScreen({ userLogin: "owner", universe: "nasdaq100" } as any)
    ).rejects.toThrow("Screen already running for nasdaq100");
  });

  it("a stale held lock probes as not-running", async () => {
    const sql = new SqliteTestStorage();
    const agent = makeScreenerAgent(sql);
    const exec = lockSqlOver(sql);
    const staleAt = Date.now() - SCREEN_RUN_LOCK_STALE_MS - 1000;
    const held = acquireScreenRunLock(exec, "owner", "nasdaq100", staleAt);
    expect(held.acquired).toBe(true);
    await expect(agent.isScreenRunning("nasdaq100", "owner")).resolves.toEqual({
      running: false,
      startedAt: staleAt,
      runId: null,
      status: "idle",
    });
  });
});

// Source-level guard for this file's own premise: the characterization
// above is only meaningful while the legacy module keeps its public
// surface. (Cheap tripwire if the exports move.)
describe("characterization 4e: lock module public surface", () => {
  it("services/screenRunLock.ts exports the pinned API", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../src/services/screenRunLock.ts", import.meta.url)),
      "utf8"
    );
    for (const name of [
      "SCREEN_RUN_LOCK_STALE_MS",
      "ensureScreenRunLockTable",
      "acquireScreenRunLock",
      "releaseScreenRunLock",
      "isScreenRunning",
    ]) {
      expect(text).toContain(name);
    }
  });
});
