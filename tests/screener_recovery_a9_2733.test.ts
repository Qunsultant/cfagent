// @vitest-environment node
/**
 * Issue #2733 (tracker #2708 A9) — ScreenerAgent start-up recovery
 * for interrupted runs.
 *
 * Before this slice the agent had no onStart: a run interrupted by
 * a Durable Object eviction left its #607 task-ledger record in an
 * active state (queued / claimed / running) until the orchestrator's
 * six-hourly stale sweep (#618, heartbeat-age gated at 30 minutes,
 * #615) happened to reach the instance. The recovery built here is
 * incarnation-keyed, not heartbeat-keyed: a fresh incarnation has
 * executed nothing, so every active record it finds at onStart
 * belongs to a dead incarnation and is terminally marked
 * failed → escalated with the interruption recorded — never
 * auto-rerun (the #615 doctrine), never silently dropped.
 *
 * Pins drive the REAL ScreenerAgent class over one shared storage
 * double (Map KV + node:sqlite), constructing a fresh agent over
 * the same store to model instance replacement — the fleet's S12
 * evidence pattern (module seam, not live workerd eviction).
 * Ledger-level pins drive the real ScreenerTaskLedger over an
 * in-memory store (the #607 suite's fixture shape).
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ScreenerAgent } from "../src/agents/screener-agent";
import {
  ScreenerTaskLedger,
  evaluateScreenerOutcome,
  type ScreenerTask,
  type ScreenerTaskStore,
} from "../src/services/screenerTaskLedger";
import { createScreenRunLockPort } from "../src/data/createScreenRunLockPorts";
import { SCREEN_RUN_LOCK_STALE_MS } from "../src/data/screenRunLockPorts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** One DO instance's storage: async KV + the SQLite handle, shared
 * across every incarnation a test constructs over it. */
function makeInstanceStorage() {
  const kv = new Map<string, unknown>();
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
        return stmt.all(...(args as never[])) as unknown[];
      }
      const info = stmt.run(...(args as never[]));
      const out = [] as unknown[] & { rowsWritten?: number };
      out.rowsWritten = Number(info.changes);
      return out;
    },
  };
  const storage: any = {
    sql,
    get: async (key: string) => kv.get(key),
    put: async (key: string, value: unknown) => {
      kv.set(key, value);
    },
    delete: async (key: string) => {
      kv.delete(key);
    },
    list: async (opts?: { prefix?: string }) => {
      const out = new Map<string, unknown>();
      for (const [k, v] of kv) {
        if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v);
      }
      return out;
    },
  };
  return { storage, kv, sql };
}

function makeAgent(storage: unknown): ScreenerAgent {
  return new ScreenerAgent({ storage } as any, {} as any);
}

const MANUAL = {
  trigger: "manual" as const,
  universe: "nasdaq100",
  sector: "ALL",
  userLogin: "alice",
};

const GOOD_EVAL = evaluateScreenerOutcome(
  {
    success: true,
    runTimestamp: "2026-11-01T12:00:30.000Z",
    totalScanned: 100,
    matchedCount: 10,
    opportunities: 5,
    partial: false,
    qualificationPresent: false,
    error: null,
  },
  "2026-11-01T12:01:00.000Z"
);

/* ------------------------------------------------------------------ */
/* Agent-level recovery (instance replacement over the same store)     */
/* ------------------------------------------------------------------ */

describe("ScreenerAgent start-up recovery (#2733)", () => {
  it("marks a prior incarnation's running task interrupted (failed → escalated) on onStart — fresh heartbeat or not", async () => {
    const { storage } = makeInstanceStorage();
    const a = makeAgent(storage);
    const { task } = await a.createScreenerTask({
      ...MANUAL,
      idempotencyKey: "k-running",
    });
    await a.beginScreenerTask(task.id);
    // Incarnation A is evicted here: its execution never resolves
    // the record. The heartbeat is seconds old — the #615 stale
    // sweep would not touch this record for 30 minutes, and the
    // #618 sweep for up to six hours.

    const b = makeAgent(storage);
    await b.onStart();

    const after = await b.getScreenerTask(task.id);
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
    const { storage } = makeInstanceStorage();
    const a = makeAgent(storage);
    const { task } = await a.createScreenerTask({
      ...MANUAL,
      idempotencyKey: "k-queued",
    });
    // Died between create and claim: still queued at restart.

    const b = makeAgent(storage);
    const recovered = await b.recoverInterruptedScreenerTasks();
    expect(recovered.map((t) => t.id)).toEqual([task.id]);
    expect(recovered[0]?.status).toBe("escalated");
    expect((await b.getScreenerTask(task.id))?.status).toBe("escalated");
  });

  it("leaves terminal records byte-identical", async () => {
    const { storage } = makeInstanceStorage();
    const a = makeAgent(storage);

    const done = await a.createScreenerTask({
      ...MANUAL,
      idempotencyKey: "k-done",
    });
    await a.beginScreenerTask(done.task.id);
    await a.completeScreenerTask(done.task.id, {
      runTimestamp: "2026-11-01T12:00:30.000Z",
      totalScanned: 100,
      matchedCount: 10,
      opportunitiesCount: 5,
      partial: false,
      evaluation: GOOD_EVAL,
    });

    const cancelled = await a.createScreenerTask({
      ...MANUAL,
      idempotencyKey: "k-cancelled",
    });
    await a.cancelScreenerTask(cancelled.task.id, "duplicate suppressed");

    const failed = await a.createScreenerTask({
      ...MANUAL,
      idempotencyKey: "k-failed",
    });
    await a.beginScreenerTask(failed.task.id);
    await a.failScreenerTask(failed.task.id, "provider down", true);

    const ids = [done.task.id, cancelled.task.id, failed.task.id];
    const before = new Map<string, ScreenerTask | null>();
    for (const id of ids) {
      before.set(id, JSON.parse(JSON.stringify(await a.getScreenerTask(id))));
    }

    const b = makeAgent(storage);
    await b.onStart();

    for (const id of ids) {
      expect(await b.getScreenerTask(id)).toEqual(before.get(id));
    }
  });

  it("is replay-safe: a second start-up pass changes nothing", async () => {
    const { storage } = makeInstanceStorage();
    const a = makeAgent(storage);
    const { task } = await a.createScreenerTask({
      ...MANUAL,
      idempotencyKey: "k-replay",
    });
    await a.beginScreenerTask(task.id);

    const b = makeAgent(storage);
    await b.onStart();
    const afterFirst = JSON.parse(
      JSON.stringify(await b.getScreenerTask(task.id))
    );

    const c = makeAgent(storage);
    await c.onStart();
    expect(await c.getScreenerTask(task.id)).toEqual(afterFirst);
    expect(await c.recoverInterruptedScreenerTasks()).toEqual([]);
  });

  it("frees the idempotency slot: a genuinely new run creates a fresh task", async () => {
    const { storage } = makeInstanceStorage();
    const a = makeAgent(storage);
    const first = await a.createScreenerTask({
      ...MANUAL,
      idempotencyKey: "k-slot",
    });
    await a.beginScreenerTask(first.task.id);

    const b = makeAgent(storage);
    await b.onStart();

    const second = await b.createScreenerTask({
      ...MANUAL,
      idempotencyKey: "k-slot",
    });
    expect(second.created).toBe(true);
    expect(second.task.id).not.toBe(first.task.id);
    expect(second.task.status).toBe("queued");
  });

  it("does not free a fresh run lock; the stale takeover still admits a new run and the recovered record stays terminal", async () => {
    const { storage, sql } = makeInstanceStorage();
    // The lock the agent itself composes (the family's one
    // composition root) over the same instance storage.
    const lock = createScreenRunLockPort(sql as any, { env: {} });
    const t0 = Date.now();
    const held = lock.acquire("alice", "nasdaq100", t0);
    expect(held.acquired).toBe(true);

    const a = makeAgent(storage);
    const { task } = await a.createScreenerTask({
      ...MANUAL,
      idempotencyKey: "k-lock",
    });
    await a.beginScreenerTask(task.id);

    const b = makeAgent(storage);
    await b.onStart();
    expect((await b.getScreenerTask(task.id))?.status).toBe("escalated");

    // Recovery did NOT touch the lock: a fresh row still refuses.
    expect(await b.isScreenRunning("nasdaq100", "alice")).toEqual({
      running: true,
      startedAt: t0,
      runId: `screen:alice:nasdaq100:${t0}`,
      status: "running",
    });
    expect(lock.acquire("alice", "nasdaq100", t0 + 60_000).acquired).toBe(
      false
    );

    // The lock's own stale takeover (#1993) is the release valve…
    const takeover = lock.acquire(
      "alice",
      "nasdaq100",
      t0 + SCREEN_RUN_LOCK_STALE_MS + 1
    );
    expect(takeover.acquired).toBe(true);
    expect(takeover.tookOverStale).toBe(true);

    // …and it cannot resurrect the recovered record: no collision,
    // no double execution of the interrupted run.
    expect((await b.getScreenerTask(task.id))?.status).toBe("escalated");
  });

  it("onStart never throws, even when the recovery write fails", async () => {
    const { storage } = makeInstanceStorage();
    const a = makeAgent(storage);
    const { task } = await a.createScreenerTask({
      ...MANUAL,
      idempotencyKey: "k-broken",
    });
    await a.beginScreenerTask(task.id);

    // #3515 S3: the onStart recovery failure now travels as a structured
    // screenerAgent.on_start_recovery_failed event (level error) on the
    // console-info JSON fallback, not a console.error line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    storage.put = async () => {
      throw new Error("storage down");
    };
    const b = makeAgent(storage);
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
    const failed = events.find((e) => e.operation === "screenerAgent.on_start_recovery_failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("error");
    expect(String(failed?.fields.message ?? "")).toContain("[ScreenerAgent][onStart] Interrupted-run recovery failed:");
    infoSpy.mockRestore();
  });

  it("onStart on an empty ledger is a no-op", async () => {
    const { storage } = makeInstanceStorage();
    const b = makeAgent(storage);
    await expect(b.onStart()).resolves.toBeUndefined();
    expect(await b.listScreenerTasks()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Ledger-level transition rules                                       */
/* ------------------------------------------------------------------ */

function memStore(): ScreenerTaskStore {
  const raw = new Map<string, string>();
  return {
    get: async (k) => (raw.has(k) ? raw.get(k)! : null),
    set: async (k, v) => void raw.set(k, v),
    delete: async (k) => void raw.delete(k),
    list: async (prefix) =>
      [...raw.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
  };
}

let tick = 0;
let ids = 0;
function ledger(store: ScreenerTaskStore): ScreenerTaskLedger {
  tick = 0;
  ids = 0;
  return new ScreenerTaskLedger(store, {
    now: () =>
      `2026-11-01T12:00:${String(tick++).padStart(2, "0")}.000Z`,
    newId: () => `stask-${++ids}`,
  });
}

const LEDGER_INPUT = {
  trigger: "scheduled" as const,
  universe: "TECH",
  sector: "ALL",
  userLogin: "alice",
  idempotencyKey: "screener:scheduled:TECH:ALL:2026-11-01T12:00",
};

describe("ScreenerTaskLedger interrupted recovery (#2733)", () => {
  it("markInterrupted moves every active state to escalated with the reason recorded", async () => {
    const store = memStore();
    const l = ledger(store);

    const queued = await l.create({ ...LEDGER_INPUT, idempotencyKey: "q" });
    const claimed = await l.create({ ...LEDGER_INPUT, idempotencyKey: "c" });
    await l.claim(claimed.task.id);
    const running = await l.create({ ...LEDGER_INPUT, idempotencyKey: "r" });
    await l.claim(running.task.id);
    await l.start(running.task.id);

    for (const t of [queued.task, claimed.task, running.task]) {
      const marked = await l.markInterrupted(
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

  it("markInterrupted refuses a terminal task", async () => {
    const store = memStore();
    const l = ledger(store);
    const { task } = await l.create(LEDGER_INPUT);
    await l.cancel(task.id, "suppressed");
    await expect(l.markInterrupted(task.id, "interrupted")).rejects.toThrow(
      /cannot move from cancelled to failed/
    );
  });

  it("recoverInterrupted returns only the active records it marked", async () => {
    const store = memStore();
    const l = ledger(store);
    const active = await l.create({ ...LEDGER_INPUT, idempotencyKey: "a" });
    const done = await l.create({ ...LEDGER_INPUT, idempotencyKey: "d" });
    await l.cancel(done.task.id, "suppressed");

    const recovered = await l.recoverInterrupted(
      "interrupted: agent restarted before the run completed (start-up recovery)"
    );
    expect(recovered.map((t) => t.id)).toEqual([active.task.id]);
    expect((await l.get(done.task.id))?.status).toBe("cancelled");
    expect(await l.recoverInterrupted("interrupted")).toEqual([]);
  });
});
