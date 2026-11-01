// @vitest-environment node
/**
 * #2358 (#1976 step 4a) — async-job ports conformance.
 *
 * One contract suite per port (Queue / Read / Maintenance), run
 * over EVERY adapter the composition root can serve: the
 * DO-SQLite adapter (over a node:sqlite-backed SqlStorage
 * double with real semantics) via createAsyncJobPorts, and the
 * in-memory adapter via createInMemoryAsyncJobPorts. The
 * contract is the legacy family's behaviour as characterized in
 * async_jobs_step4a_characterization_2358: the guarded claim
 * (audit R-7 — exactly one winner, NOT transaction-wrapped),
 * guarded terminal transitions, submit-time retention prunes,
 * session scoping on every read, and maintenance clears that
 * never touch running rows.
 *
 * The suite also pins the two bypass closures this slice owns
 * outside the family table: the job-outcome port's maintenance
 * surface (countRows / clearRows with the prune watermark
 * preserved EXACTLY) and the paused-schedule port's clear().
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  createAsyncJobPorts,
  createInMemoryAsyncJobPorts,
  type AsyncJobPorts,
} from "../src/data/createAsyncJobPorts";
import {
  createEvidenceSatellitePorts,
  createInMemoryEvidenceSatellitePorts,
} from "../src/data/createEvidenceSatellitePorts";
import { createOptionsDiscoveryPorts } from "../src/data/createOptionsDiscoveryPorts";
import { InMemoryPausedScheduleStore } from "../src/data/inMemoryPausedScheduleAdapter";

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

const T0 = "2026-10-29T10:00:00.000Z";
const T1 = "2026-10-29T10:01:00.000Z";
const T2 = "2026-10-29T10:02:00.000Z";
const T3 = "2026-10-29T10:03:00.000Z";

function queued(p: AsyncJobPorts, jobId: string, sessionId = "s1", nowIso = T0, extra: Record<string, unknown> = {}): void {
  p.queue.insertQueued({
    jobId,
    sessionId,
    capability: "http.request",
    displayName: `Job ${jobId}`,
    payloadJson: JSON.stringify({ jobId }),
    nowIso,
    ...extra,
  } as never);
}

const ADAPTERS: Array<[string, () => AsyncJobPorts]> = [
  ["DO-SQLite", () => createAsyncJobPorts(new SqliteTestStorage() as never)],
  ["in-memory", () => createInMemoryAsyncJobPorts()],
];

for (const [name, make] of ADAPTERS) {
  describe(`conformance 4a [${name}]: AsyncJobQueuePort`, () => {
    it("ensureSchema is idempotent and insert/get round-trips with graph defaults", () => {
      const p = make();
      p.queue.ensureSchema();
      p.queue.ensureSchema();
      queued(p, "j1");
      const row = p.read.getRow("j1", "s1");
      expect(row?.status).toBe("queued");
      expect(row?.job_kind).toBe("main");
      expect(row?.parent_job_id).toBeNull();
      expect(row?.response_status).toBeNull();
      expect(p.read.getRow("j1", "other-session")).toBeUndefined();
    });

    it("insertQueued refuses a duplicate job_id (insert-or-throw, D-E.1)", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "j1");
      expect(() => queued(p, "j1")).toThrow();
    });

    it("THE CLAIM (R-7): two competing claims, exactly one wins; the loser writes nothing", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "j1");
      const first = p.queue.claim("j1", "s1", T1);
      const second = p.queue.claim("j1", "s1", T2);
      expect(first).toBe(true);
      expect(second).toBe(false);
      const row = p.read.getRow("j1", "s1");
      expect(row?.status).toBe("running");
      expect(row?.started_at).toBe(T1);
    });

    it("claim refuses wrong-session and terminal jobs", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "j1");
      expect(p.queue.claim("j1", "other", T1)).toBe(false);
      expect(p.queue.claim("j1", "s1", T1)).toBe(true);
      p.queue.complete("j1", "{}", 200, T2);
      expect(p.queue.claim("j1", "s1", T3)).toBe(false);
    });

    it("complete is guarded on running and stores result + response status", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "j1");
      expect(p.queue.complete("j1", "{}", 200, T1)).toBe(0);
      p.queue.claim("j1", "s1", T1);
      expect(p.queue.complete("j1", "{\"ok\":true}", 201, T2)).toBe(1);
      expect(p.queue.complete("j1", "{}", 200, T3)).toBe(0);
      const row = p.read.getRow("j1", "s1");
      expect(row?.status).toBe("completed");
      expect(row?.result_json).toBe("{\"ok\":true}");
      expect(row?.response_status).toBe(201);
      expect(row?.completed_at).toBe(T2);
    });

    it("failRunning / failQueued / reapStaleRunning are each guarded on their source status", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "jq");
      queued(p, "jr");
      queued(p, "jreap");
      expect(p.queue.failRunning("jq", "boom", T1)).toBe(0);
      expect(p.queue.failQueued("jq", "arm failed", T1)).toBe(1);
      expect(p.read.getRow("jq", "s1")?.status).toBe("failed");
      expect(p.read.getRow("jq", "s1")?.error).toBe("arm failed");
      expect(p.queue.failQueued("jq", "again", T2)).toBe(0);
      p.queue.claim("jr", "s1", T1);
      expect(p.queue.failQueued("jr", "nope", T2)).toBe(0);
      expect(p.queue.failRunning("jr", "exploded", T2)).toBe(1);
      expect(p.read.getRow("jr", "s1")?.error).toBe("exploded");
      p.queue.claim("jreap", "s1", T1);
      expect(p.queue.reapStaleRunning("jreap", "unknown outcome", T3)).toBe(1);
      expect(p.read.getRow("jreap", "s1")?.status).toBe("failed");
      expect(p.queue.reapStaleRunning("jreap", "again", T3)).toBe(0);
    });

    it("markStuckAlerted (#2567) claims exactly once, guarded on running + unclaimed, and is not a lifecycle transition", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "jstuck");
      expect(p.queue.markStuckAlerted("jstuck", T1)).toBe(0);
      p.queue.claim("jstuck", "s1", T1);
      expect(p.queue.markStuckAlerted("jstuck", T2)).toBe(1);
      expect(p.queue.markStuckAlerted("jstuck", T3)).toBe(0);
      const row = p.read.getRow("jstuck", "s1");
      expect(row?.status).toBe("running");
      expect(row?.stuck_alerted_at).toBe(T2);
      expect(row?.updated_at).toBe(T1);
    });

    it("insertTerminal lands a row directly at its terminal status", () => {
      const p = make();
      p.queue.ensureSchema();
      p.queue.insertTerminal({
        jobId: "bridge1",
        sessionId: "s1",
        capability: "screener.run",
        displayName: "Stock screen",
        status: "completed",
        payloadJson: "{}",
        resultJson: "{\"matchedCount\":3}",
        error: null,
        nowIso: T0,
        jobKind: "main",
        stage: "generate",
        chainId: "chain-1",
      });
      const row = p.read.getRow("bridge1", "s1");
      expect(row?.status).toBe("completed");
      expect(row?.completed_at).toBe(T0);
      expect(row?.chain_id).toBe("chain-1");
    });

    it("pruneTerminalBefore deletes only old terminal rows", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "old-queued", "s1", "2026-09-01T00:00:00.000Z");
      p.queue.insertTerminal({
        jobId: "old-done", sessionId: "s1", capability: "x", displayName: "x",
        status: "failed", payloadJson: "{}", resultJson: "{}", error: "e",
        nowIso: "2026-09-01T00:00:00.000Z",
      });
      p.queue.insertTerminal({
        jobId: "new-done", sessionId: "s1", capability: "x", displayName: "x",
        status: "completed", payloadJson: "{}", resultJson: "{}", error: null,
        nowIso: T0,
      });
      p.queue.pruneTerminalBefore("s1", "2026-09-15T00:00:00.000Z");
      expect(p.read.getRow("old-done", "s1")).toBeUndefined();
      expect(p.read.getRow("old-queued", "s1")?.status).toBe("queued");
      expect(p.read.getRow("new-done", "s1")?.status).toBe("completed");
    });

    it("pruneTerminalToCap keeps exactly the newest N terminal rows", () => {
      const p = make();
      p.queue.ensureSchema();
      for (let i = 0; i < 4; i++) {
        p.queue.insertTerminal({
          jobId: `t${i}`, sessionId: "s1", capability: "x", displayName: "x",
          status: "completed", payloadJson: "{}", resultJson: "{}", error: null,
          nowIso: `2026-10-29T10:0${i}:00.000Z`,
        });
      }
      queued(p, "still-queued", "s1", "2026-10-29T09:00:00.000Z");
      p.queue.pruneTerminalToCap("s1", 2);
      expect(p.read.getRow("t0", "s1")).toBeUndefined();
      expect(p.read.getRow("t1", "s1")).toBeUndefined();
      expect(p.read.getRow("t2", "s1")?.status).toBe("completed");
      expect(p.read.getRow("t3", "s1")?.status).toBe("completed");
      expect(p.read.getRow("still-queued", "s1")?.status).toBe("queued");
    });
  });

  describe(`conformance 4a [${name}]: AsyncJobReadPort`, () => {
    it("listRows is newest-first, limited, session-scoped, and carries no response_status", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "a", "s1", T0);
      queued(p, "b", "s1", T1);
      queued(p, "c", "s2", T2);
      const rows = p.read.listRows("s1", 10);
      expect(rows.map((r) => r.job_id)).toEqual(["b", "a"]);
      expect("response_status" in rows[0]).toBe(false);
      expect(p.read.listRows("s1", 1).map((r) => r.job_id)).toEqual(["b"]);
    });

    it("listQueued returns queued rows oldest-first with not_before", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "later", "s1", T1, { notBefore: "2026-10-29T11:00:00.000Z" });
      queued(p, "earlier", "s1", T0);
      p.queue.claim("earlier", "s1", T2);
      expect(p.read.listQueued("s1")).toEqual([
        { job_id: "later", not_before: "2026-10-29T11:00:00.000Z" },
      ]);
    });

    it("execution-state and claimed projections read the claimed row", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "j1", "s1", T0, { stage: "feed", chainId: "chain-9" });
      expect(p.read.getExecutionState("j1", "s1")).toEqual({ status: "queued", not_before: null });
      p.queue.claim("j1", "s1", T1);
      expect(p.read.getExecutionState("j1", "s1")?.status).toBe("running");
      const claimed = p.read.getClaimed("j1", "s1");
      expect(claimed?.capability).toBe("http.request");
      expect(claimed?.stage).toBe("feed");
      expect(claimed?.chain_id).toBe("chain-9");
      expect(p.read.getClaimed("j1", "other")).toBeUndefined();
    });

    it("retry source + session payload scan", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "src", "s1", T0, { parentJobId: "root", jobKind: "report", channel: "slack", stage: "serve", chainId: "c1" });
      const source = p.read.getRetrySource("src", "s1");
      expect(source?.parent_job_id).toBe("root");
      expect(source?.job_kind).toBe("report");
      expect(source?.channel).toBe("slack");
      expect(p.read.listSessionPayloads("s1")).toEqual([
        { job_id: "src", status: "queued", payload_json: JSON.stringify({ jobId: "src" }) },
      ]);
      expect(p.read.listSessionPayloads("nobody")).toEqual([]);
    });

    it("chainRows returns the chain's rows in creation order, session-scoped", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "second", "s1", T1, { chainId: "c1", stage: "serve" });
      queued(p, "first", "s1", T0, { chainId: "c1", stage: "feed" });
      queued(p, "other-chain", "s1", T2, { chainId: "c2" });
      queued(p, "other-session", "s2", T0, { chainId: "c1" });
      const rows = p.read.chainRows("c1", "s1");
      expect(rows.map((r) => r.job_id)).toEqual(["first", "second"]);
      expect(rows[0].stage).toBe("feed");
    });

    it("workflowRunRows is newest-first with payload included", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "a", "s1", T0);
      queued(p, "b", "s1", T1);
      const rows = p.read.workflowRunRows("s1", 10);
      expect(rows.map((r) => r.job_id)).toEqual(["b", "a"]);
      expect(rows[0].payload_json).toBe(JSON.stringify({ jobId: "b" }));
      expect(p.read.workflowRunRows("s1", 1)).toHaveLength(1);
    });

    it("activeJobPayloads returns only queued + running payloads", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "q1");
      queued(p, "r1");
      p.queue.claim("r1", "s1", T1);
      p.queue.insertTerminal({
        jobId: "done1", sessionId: "s1", capability: "x", displayName: "x",
        status: "completed", payloadJson: "{\"done\":true}", resultJson: "{}", error: null, nowIso: T0,
      });
      const payloads = p.read.activeJobPayloads().map((r) => r.payload_json).sort();
      expect(payloads).toEqual([JSON.stringify({ jobId: "q1" }), JSON.stringify({ jobId: "r1" })].sort());
    });
  });

  describe(`conformance 4a [${name}]: AsyncJobMaintenancePort`, () => {
    it("countByStatus breaks down the caller's session only", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "a");
      queued(p, "b");
      p.queue.claim("b", "s1", T1);
      queued(p, "c", "s2");
      const counts = Object.fromEntries(p.maintenance.countByStatus("s1").map((r) => [r.status, r.n]));
      expect(counts).toEqual({ queued: 1, running: 1 });
    });

    it("deleteByStatuses removes only the listed statuses, in the caller's session", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "q1");
      queued(p, "r1");
      p.queue.claim("r1", "s1", T1);
      p.queue.insertTerminal({
        jobId: "d1", sessionId: "s1", capability: "x", displayName: "x",
        status: "completed", payloadJson: "{}", resultJson: "{}", error: null, nowIso: T0,
      });
      queued(p, "other", "s2");
      p.maintenance.deleteByStatuses("s1", ["queued", "completed"]);
      expect(p.read.getRow("q1", "s1")).toBeUndefined();
      expect(p.read.getRow("d1", "s1")).toBeUndefined();
      expect(p.read.getRow("r1", "s1")?.status).toBe("running");
      expect(p.read.getRow("other", "s2")?.status).toBe("queued");
    });

    it("deleteAllNonRunning never deletes a running row", () => {
      const p = make();
      p.queue.ensureSchema();
      queued(p, "q1");
      queued(p, "r1");
      p.queue.claim("r1", "s1", T1);
      p.maintenance.deleteAllNonRunning("s1");
      expect(p.read.getRow("q1", "s1")).toBeUndefined();
      expect(p.read.getRow("r1", "s1")?.status).toBe("running");
    });
  });
}

describe("conformance 4a: job-outcome maintenance surface (the watermark pin)", () => {
  it("DO-SQLite: countRows/clearRows clear outcomes and preserve the pruned_at watermark exactly", () => {
    // Clock pin (#2451): list() self-prunes via maybePrune() on the
    // real clock, so with wall-clock time free-running the 24h prune
    // guard flips once real-now passes seed + 24h and the prune
    // rewrites the watermark this test pins. Freeze the clock at the
    // seed instant to seed, then advance it one hour — still inside
    // the prune interval, so list()'s internal maybePrune stays
    // suppressed on any wall-clock date, but any delete/rewrite of
    // the watermark would stamp t0 + 1h and fail the exact-equality
    // assertion below, exactly as a real-clock rewrite did before.
    vi.useFakeTimers();
    try {
      const t0 = Date.parse("2026-10-29T12:00:00.000Z");
      vi.setSystemTime(t0);
      const storage = new SqliteTestStorage();
      const ports = createEvidenceSatellitePorts(storage as never);
      ports.jobOutcomes.record({ id: "o1", kind: "stock", trigger: "manual", status: "completed", origin: "test" });
      ports.jobOutcomes.record({ id: "o2", kind: "options", trigger: "scheduled", status: "failed", origin: "test" });
      expect(ports.jobOutcomes.countRows()).toBe(2);
      expect(ports.jobOutcomes.maybePrune(t0)).toBe(true);
      vi.setSystemTime(t0 + 60 * 60 * 1000);
      const before = (storage.sqlite
        .prepare("SELECT v FROM mas_job_outcomes_meta WHERE k = 'pruned_at'")
        .get() as { v: string }).v;
      ports.jobOutcomes.clearRows();
      expect(ports.jobOutcomes.countRows()).toBe(0);
      expect(ports.jobOutcomes.list()).toEqual([]);
      const after = (storage.sqlite
        .prepare("SELECT v FROM mas_job_outcomes_meta WHERE k = 'pruned_at'")
        .get() as { v: string }).v;
      expect(after).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("in-memory: clearRows empties outcomes and preserves the prune watermark", () => {
    const ports = createInMemoryEvidenceSatellitePorts();
    ports.jobOutcomes.record({ id: "o1", kind: "stock", trigger: "manual", status: "completed", origin: "test" });
    const t0 = Date.parse("2026-10-29T12:00:00.000Z");
    expect(ports.jobOutcomes.maybePrune(t0)).toBe(true);
    ports.jobOutcomes.clearRows();
    expect(ports.jobOutcomes.countRows()).toBe(0);
    // Watermark preserved: a second maybePrune inside the interval
    // is still suppressed. Had clearRows reset it, this would run.
    expect(ports.jobOutcomes.maybePrune(t0 + 1000)).toBe(false);
  });
});

describe("conformance 4a: paused-schedule clear through its port", () => {
  const record = (id: string) => ({
    id,
    callback: "runScheduledScan",
    payload: { userLogin: "alice" },
    type: "interval" as const,
    intervalSeconds: 300,
    pausedAt: T0,
  });

  it("DO-SQLite stores (sync + async): clear() empties the table", async () => {
    const storage = new SqliteTestStorage();
    const ports = createOptionsDiscoveryPorts({
      sql: storage as never,
      scheduleSql: storage as never,
    });
    const store = ports.pausedSchedulesSync;
    store.save(record("p1"));
    store.save(record("p2"));
    expect(store.list()).toHaveLength(2);
    store.clear();
    expect(store.list()).toEqual([]);
    await expect(ports.pausedSchedules.list()).resolves.toEqual([]);
    // The async facade's clear() too.
    await ports.pausedSchedules.save(record("p3"));
    await ports.pausedSchedules.clear();
    await expect(ports.pausedSchedules.list()).resolves.toEqual([]);
  });

  it("in-memory store: clear() empties the store", async () => {
    const store = new InMemoryPausedScheduleStore();
    await store.save(record("p1"));
    expect(await store.list()).toHaveLength(1);
    await store.clear();
    expect(await store.list()).toEqual([]);
  });
});
