// @vitest-environment node
/**
 * Issue #2761 (tracker #2708 A10) — ResearchAgent start-up recovery
 * for interrupted runs.
 *
 * Before this slice the agent had no onStart: a delegated run
 * interrupted by a Durable Object eviction left its #577
 * task-ledger record in an active state (queued / claimed /
 * running) until the orchestrator's #618 stale sweep (heartbeat-age
 * gated at 30 minutes, #615) happened to reach the instance — or
 * indefinitely, for an instance no sweep reaches. The recovery
 * built here is incarnation-keyed, not heartbeat-keyed: a fresh
 * incarnation has executed nothing, so every active record it
 * finds at onStart belongs to a dead incarnation and is terminally
 * marked failed → escalated with the interruption recorded —
 * never auto-rerun (the #615 doctrine), never silently dropped.
 *
 * Mark, not resume — the design decision, with its evidence: the
 * ledger record carries lifecycle state + attribution only (id,
 * idempotency key, trigger, userLogin, status, timestamps; on
 * completion path / reportRunId / evaluation). It carries no
 * request payload beyond trigger + login (a run's configOverride
 * and the discovery inputs are never recorded), no checkpoint,
 * and no partial results — and `persistRun` writes the report
 * inside runResearch BEFORE the orchestrator completes the task,
 * so an eviction in that window leaves a published report beside
 * an active record; a "resume" would publish a second, divergent
 * report for one delegated run. Retry as a NEW run belongs to the
 * caller/workflow layer.
 *
 * Pins drive the REAL ResearchAgent class over one shared storage
 * double (node:sqlite + Map KV — the step-4e characterization
 * harness shape), constructing a fresh agent over the same store
 * to model instance replacement — the fleet's S12 evidence
 * pattern (module seam, not live workerd eviction). Ledger-level
 * pins drive the real ResearchTaskLedger over an in-memory store
 * (the #577 suite's fixture shape).
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ResearchAgent } from "../src/agents/research-agent";
import {
  ResearchTaskLedger,
  evaluateResearchOutcome,
  type ResearchTask,
  type ResearchTaskStore,
} from "../src/services/researchTaskLedger";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** node:sqlite-backed SqlStorage double (the step-4e harness shape),
 * shared across every incarnation a test constructs over it. */
class SqliteTestStorage {
  private db = new DatabaseSync(":memory:");
  exec(query: string, ...args: unknown[]): unknown[] {
    const stmt = this.db.prepare(query);
    const verb = query.trimStart().slice(0, 6).toUpperCase();
    if (verb === "SELECT" || query.trimStart().toUpperCase().startsWith("PRAGMA")) {
      return stmt.all(...(args as never[])) as unknown[];
    }
    const info = stmt.run(...(args as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

function makeCtx(sql: { exec: SqliteTestStorage["exec"] }): any {
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

function makeAgent(sql: SqliteTestStorage): ResearchAgent {
  return new ResearchAgent(makeCtx(sql), {} as any);
}

const GOOD_EVAL = evaluateResearchOutcome(
  {
    reportRunId: "run-2026-11-01-1",
    previousRunId: null,
    expectedTrigger: "manual",
    expectedUserLogin: "alice",
    reportTrigger: "manual",
    reportUserLogin: "alice",
    summary: "3 ideas qualified",
    ideas: 3,
    watchlist: 1,
    rejected: 0,
  },
  "2026-11-01T12:01:00.000Z"
);

/* ------------------------------------------------------------------ */
/* Agent-level recovery (instance replacement over the same store)     */
/* ------------------------------------------------------------------ */

describe("ResearchAgent start-up recovery (#2761)", () => {
  it("marks a prior incarnation's running task interrupted (failed → escalated) on onStart — fresh heartbeat or not", async () => {
    const sql = new SqliteTestStorage();
    const a = makeAgent(sql);
    const { task } = await a.createResearchTask({
      trigger: "manual",
      userLogin: "alice",
      idempotencyKey: "k-running",
    });
    await a.beginResearchTask(task.id);
    await a.heartbeatResearchTask(task.id);
    // Incarnation A is evicted here: its execution never resolves
    // the record. The heartbeat is seconds old — the #615 stale
    // sweep would not touch this record for 30 minutes, and the
    // #618 sweep only when it next reaches this instance.

    const b = makeAgent(sql);
    await b.onStart();

    const after = await b.getResearchTask(task.id);
    expect(after?.status).toBe("escalated");
    expect(after?.error).toContain("interrupted");
    expect(after?.history.map((h) => h.status)).toEqual([
      "queued",
      "claimed",
      "running",
      "failed",
      "escalated",
    ]);
    expect(after?.history.at(-2)?.note).toContain("interrupted");
    expect(after?.history.at(-1)?.note).toContain("interrupted run recovery");
  });

  it("recovers a queued record too, and returns the recovered tasks", async () => {
    const sql = new SqliteTestStorage();
    const a = makeAgent(sql);
    const { task } = await a.createResearchTask({
      trigger: "scheduled",
      userLogin: "alice",
      idempotencyKey: "k-queued",
    });
    // Died between create and claim: still queued at restart.

    const b = makeAgent(sql);
    const recovered = await b.recoverInterruptedResearchTasks();
    expect(recovered.map((t) => t.id)).toEqual([task.id]);
    expect(recovered[0]?.status).toBe("escalated");
    expect((await b.getResearchTask(task.id))?.status).toBe("escalated");
  });

  it("leaves terminal records byte-identical", async () => {
    const sql = new SqliteTestStorage();
    const a = makeAgent(sql);

    const done = await a.createResearchTask({
      trigger: "manual",
      userLogin: "alice",
      idempotencyKey: "k-done",
    });
    await a.beginResearchTask(done.task.id);
    await a.completeResearchTask(done.task.id, {
      path: "agent",
      reportRunId: "run-2026-11-01-1",
      evaluation: GOOD_EVAL,
    });

    const failed = await a.createResearchTask({
      trigger: "manual",
      userLogin: "alice",
      idempotencyKey: "k-failed",
    });
    await a.beginResearchTask(failed.task.id);
    await a.failResearchTask(failed.task.id, "provider down", true);

    const ids = [done.task.id, failed.task.id];
    const before = new Map<string, ResearchTask | null>();
    for (const id of ids) {
      before.set(id, JSON.parse(JSON.stringify(await a.getResearchTask(id))));
    }

    const b = makeAgent(sql);
    await b.onStart();

    for (const id of ids) {
      expect(await b.getResearchTask(id)).toEqual(before.get(id));
    }
  });

  it("is replay-safe: a second start-up pass changes nothing", async () => {
    const sql = new SqliteTestStorage();
    const a = makeAgent(sql);
    const { task } = await a.createResearchTask({
      trigger: "manual",
      userLogin: "alice",
      idempotencyKey: "k-replay",
    });
    await a.beginResearchTask(task.id);

    const b = makeAgent(sql);
    await b.onStart();
    const afterFirst = JSON.parse(
      JSON.stringify(await b.getResearchTask(task.id))
    );

    const c = makeAgent(sql);
    await c.onStart();
    expect(await c.getResearchTask(task.id)).toEqual(afterFirst);
    expect(await c.recoverInterruptedResearchTasks()).toEqual([]);
  });

  it("preserves idempotency semantics in both directions: an active record dedupes, a recovered record frees the slot", async () => {
    const sql = new SqliteTestStorage();
    const a = makeAgent(sql);
    const first = await a.createResearchTask({
      trigger: "manual",
      userLogin: "alice",
      idempotencyKey: "k-slot",
    });
    await a.beginResearchTask(first.task.id);

    // While the record is active, a duplicate dispatch shares it —
    // recovery must not weaken the dedupe that live runs rely on.
    const dupe = await a.createResearchTask({
      trigger: "manual",
      userLogin: "alice",
      idempotencyKey: "k-slot",
    });
    expect(dupe.created).toBe(false);
    expect(dupe.task.id).toBe(first.task.id);

    const b = makeAgent(sql);
    await b.onStart();

    // Once the zombie is terminally marked, the same key admits a
    // genuinely new run instead of dedup-blocking on it forever.
    const second = await b.createResearchTask({
      trigger: "manual",
      userLogin: "alice",
      idempotencyKey: "k-slot",
    });
    expect(second.created).toBe(true);
    expect(second.task.id).not.toBe(first.task.id);
    expect(second.task.status).toBe("queued");
  });

  it("onStart never throws, even when the recovery write fails", async () => {
    const sql = new SqliteTestStorage();
    const a = makeAgent(sql);
    const { task } = await a.createResearchTask({
      trigger: "manual",
      userLogin: "alice",
      idempotencyKey: "k-broken",
    });
    await a.beginResearchTask(task.id);

    // Same store, but writes to the task table now fail (reads are
    // fail-soft by the port contract; writes propagate). The
    // recovery pass sees the orphaned record and its mark write
    // throws — onStart must log, not propagate: a throw out of
    // onStart is terminal for the instance.
    const failingSql = {
      exec: (query: string, ...args: unknown[]) => {
        if (
          /^\s*(DELETE|INSERT|UPDATE)/i.test(query) &&
          query.includes("research_task_store")
        ) {
          throw new Error("storage down");
        }
        return sql.exec(query, ...args);
      },
    };
    // #3515 S3: the onStart recovery failure now travels as a structured
    // researchAgent.on_start_recovery_failed event (level error) on the
    // console-info JSON fallback, not a console.error line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const b = new ResearchAgent(makeCtx(failingSql), {} as any);
    await expect(b.onStart()).resolves.toBeUndefined();
    const events: Array<{ operation: string; level: string; fields: Record<string, unknown> }> = [];
    for (const call of infoSpy.mock.calls) {
      try {
        const parsed = JSON.parse(String(call[0])) as {
          operation?: unknown;
          level?: unknown;
          fields?: unknown;
        };
        if (parsed && typeof parsed.operation === "string") {
          events.push({
            operation: parsed.operation,
            level: typeof parsed.level === "string" ? parsed.level : "",
            fields:
              parsed.fields && typeof parsed.fields === "object"
                ? (parsed.fields as Record<string, unknown>)
                : {},
          });
        }
      } catch {
        // Non-JSON console.info lines are not structured events.
      }
    }
    const failed = events.find((e) => e.operation === "researchAgent.on_start_recovery_failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("error");
    expect(String(failed?.fields.message ?? "")).toContain("[ResearchAgent][onStart] Interrupted-run recovery failed:");
    infoSpy.mockRestore();
  });

  it("onStart on an empty ledger is a no-op", async () => {
    const sql = new SqliteTestStorage();
    const b = makeAgent(sql);
    await expect(b.onStart()).resolves.toBeUndefined();
    expect(await b.listResearchTasks()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Ledger-level transition rules                                       */
/* ------------------------------------------------------------------ */

function memStore(): ResearchTaskStore {
  const raw = new Map<string, string>();
  return {
    get: (k) => (raw.has(k) ? raw.get(k)! : null),
    set: (k, v) => void raw.set(k, v),
    delete: (k) => void raw.delete(k),
    list: (prefix) =>
      [...raw.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
  };
}

let tick = 0;
let ids = 0;
function ledger(store: ResearchTaskStore): ResearchTaskLedger {
  tick = 0;
  ids = 0;
  return new ResearchTaskLedger(store, {
    now: () => `2026-11-01T12:00:${String(tick++).padStart(2, "0")}.000Z`,
    newId: () => `rtask-${++ids}`,
  });
}

const LEDGER_INPUT = {
  trigger: "scheduled" as const,
  userLogin: "alice",
  idempotencyKey: "research:scheduled:2026-11-01T12:00",
};

describe("ResearchTaskLedger interrupted recovery (#2761)", () => {
  it("markInterrupted moves every active state to escalated with the reason recorded", () => {
    const store = memStore();
    const l = ledger(store);

    const queued = l.create({ ...LEDGER_INPUT, idempotencyKey: "q" });
    const claimed = l.create({ ...LEDGER_INPUT, idempotencyKey: "c" });
    l.claim(claimed.task.id);
    const running = l.create({ ...LEDGER_INPUT, idempotencyKey: "r" });
    l.claim(running.task.id);
    l.start(running.task.id);

    for (const t of [queued.task, claimed.task, running.task]) {
      const marked = l.markInterrupted(
        t.id,
        "interrupted: agent restarted before the run completed (start-up recovery)"
      );
      expect(marked.status).toBe("escalated");
      expect(marked.error).toContain("interrupted: agent restarted");
      expect(marked.error).toContain("interrupted run recovery");
      expect(marked.history.map((h) => h.status).slice(-2)).toEqual([
        "failed",
        "escalated",
      ]);
    }
  });

  it("markInterrupted refuses a terminal task", () => {
    const store = memStore();
    const l = ledger(store);
    const { task } = l.create(LEDGER_INPUT);
    l.cancel(task.id);
    expect(() => l.markInterrupted(task.id, "interrupted")).toThrow(
      /cannot move from cancelled to failed/
    );
  });

  it("recoverInterrupted returns only the active records it marked", () => {
    const store = memStore();
    const l = ledger(store);
    const active = l.create({ ...LEDGER_INPUT, idempotencyKey: "a" });
    const done = l.create({ ...LEDGER_INPUT, idempotencyKey: "d" });
    l.cancel(done.task.id);

    const recovered = l.recoverInterrupted(
      "interrupted: agent restarted before the run completed (start-up recovery)"
    );
    expect(recovered.map((t) => t.id)).toEqual([active.task.id]);
    expect(l.get(done.task.id)?.status).toBe("cancelled");
    expect(l.recoverInterrupted("interrupted")).toEqual([]);
  });
});
