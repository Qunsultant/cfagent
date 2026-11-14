// @vitest-environment node
/**
 * Issue #2361 (#1976 step 4e) — CONFORMANCE for the agent-private
 * store families: the ResearchStore ports (research_settings /
 * research_task_store / research_runs / research_evaluations) and
 * the ScreenRunLockPort. The contract describes run over BOTH
 * adapter sets (DO-SQLite over a node:sqlite double, and the
 * in-memory doubles) via a [name, make] table — the step-4d
 * conformance shape.
 *
 * Pinned beyond the shared contracts:
 *  - R-7 counting pins: composing either family executes ZERO
 *    CREATEs; the research family's ensureSchema creates exactly
 *    its four agent-private tables and ZERO shared-schema tables
 *    (no mas_* name, ever) — ResearchAgent's never-initializes-
 *    the-shared-schema invariant in its post-4e form.
 *  - The DO lock adapter's as-found release asymmetry (release
 *    does not ensure; pinned here for the DO set only — the
 *    in-memory double has no table concept).
 *  - Source-scan pins: both agent files now hold ZERO surface-1
 *    and ZERO surface-2 census-pattern matches, and the legacy
 *    lock module holds no lock statement strings (they live in
 *    the DO adapter). These are the local form of the deltas the
 *    global census pin will record at ship time.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createResearchStorePorts,
  createInMemoryResearchStorePorts,
} from "../src/data/createResearchStorePorts";
import {
  createScreenRunLockPort,
  createInMemoryScreenRunLockPort,
} from "../src/data/createScreenRunLockPorts";
import {
  SCREEN_RUN_LOCK_STALE_MS,
  type ScreenRunLockPort,
} from "../src/data/screenRunLockPorts";
import type { ResearchStorePorts } from "../src/data/researchStorePorts";

/** node:sqlite-backed SqlStorage double (step-4d harness shape). */
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

/** Counting wrapper: records every statement for the R-7 pins. */
class CountingStorage {
  statements: string[] = [];
  constructor(private readonly inner: SqliteTestStorage) {}
  exec(query: string, ...args: unknown[]): unknown[] {
    this.statements.push(query);
    return this.inner.exec(query, ...args);
  }
  creates(): string[] {
    return this.statements.filter((s) => /CREATE TABLE/i.test(s));
  }
}

const researchSets: Array<[string, () => ResearchStorePorts]> = [
  ["do-sqlite", () => createResearchStorePorts(new SqliteTestStorage())],
  ["in-memory", () => createInMemoryResearchStorePorts()],
];

const lockSets: Array<[string, () => ScreenRunLockPort]> = [
  ["do-sqlite", () => createScreenRunLockPort(new SqliteTestStorage())],
  ["in-memory", () => createInMemoryScreenRunLockPort()],
];

describe("conformance 4e: ResearchStore ports", () => {
  for (const [name, make] of researchSets) {
    describe(name, () => {
      it("settings: fail-soft reads, single-row overwrite semantics", () => {
        const ports = make();
        // No ensureSchema yet: reads are fail-soft by contract.
        expect(ports.settings.get("missing")).toBeNull();
        ports.ensureSchema();
        expect(ports.settings.get("missing")).toBeNull();
        ports.settings.set("k", "v1");
        expect(ports.settings.get("k")).toBe("v1");
        ports.settings.set("k", "v2");
        expect(ports.settings.get("k")).toBe("v2");
        ports.settings.set("other", "x");
        expect(ports.settings.get("other")).toBe("x");
      });

      it("tasks: fail-soft reads, set/get/delete, prefix list in write order", () => {
        const ports = make();
        expect(ports.tasks.get("missing")).toBeNull();
        expect(ports.tasks.list("research:task:")).toEqual([]);
        ports.ensureSchema();
        ports.tasks.set("research:task:a", "1");
        ports.tasks.set("research:task:b", "2");
        ports.tasks.set("research:idem:a", "a");
        expect(ports.tasks.get("research:task:a")).toBe("1");
        expect(ports.tasks.list("research:task:")).toEqual([
          { key: "research:task:a", value: "1" },
          { key: "research:task:b", value: "2" },
        ]);
        // Overwrite keeps one row; the ledger-facing delete removes it.
        ports.tasks.set("research:task:a", "1b");
        expect(ports.tasks.list("research:task:")).toHaveLength(2);
        expect(ports.tasks.get("research:task:a")).toBe("1b");
        ports.tasks.delete("research:task:a");
        expect(ports.tasks.get("research:task:a")).toBeNull();
        expect(ports.tasks.list("research:task:")).toEqual([
          { key: "research:task:b", value: "2" },
        ]);
      });

      it("runs: replace upserts by run_id; report feed is newest-first; refs scan in write order", () => {
        const ports = make();
        ports.ensureSchema();
        const run = (runId: string, createdAt: string, json: string) => ({
          runId,
          trigger: "manual",
          userLogin: "alice",
          createdAt,
          rulesVersion: "1.0.0",
          status: "published",
          ideasCount: 1,
          reportJson: json,
        });
        ports.runs.replaceRun(run("r1", "2026-10-20T00:00:00.000Z", "J1"));
        ports.runs.replaceRun(run("r2", "2026-10-22T00:00:00.000Z", "J2"));
        ports.runs.replaceRun(run("r3", "2026-10-21T00:00:00.000Z", "J3"));
        expect(ports.runs.listReportJsonValues()).toEqual(["J2", "J3", "J1"]);
        expect(ports.runs.getReportJsonValue("r3")).toBe("J3");
        expect(ports.runs.getReportJsonValue("nope")).toBeUndefined();
        expect(ports.runs.listRunRefs()).toEqual([
          { runId: "r1", createdAt: "2026-10-20T00:00:00.000Z" },
          { runId: "r2", createdAt: "2026-10-22T00:00:00.000Z" },
          { runId: "r3", createdAt: "2026-10-21T00:00:00.000Z" },
        ]);
        // Replace: one row, latest JSON wins.
        ports.runs.replaceRun(run("r1", "2026-10-20T00:00:00.000Z", "J1b"));
        expect(ports.runs.getReportJsonValue("r1")).toBe("J1b");
        expect(ports.runs.listRunRefs()).toHaveLength(3);
      });

      it("evaluations: insert-or-throw on id; feed is oldest-first; run ids in write order", () => {
        const ports = make();
        ports.ensureSchema();
        const ev = (id: string, runId: string, at: string, json: string) => ({
          id,
          runId,
          evaluatedAt: at,
          evaluationJson: json,
        });
        ports.evaluations.insertEvaluation(ev("e2", "r1", "2026-10-23T00:00:00.000Z", "E2"));
        ports.evaluations.insertEvaluation(ev("e1", "r1", "2026-10-22T00:00:00.000Z", "E1"));
        ports.evaluations.insertEvaluation(ev("e3", "r2", "2026-10-24T00:00:00.000Z", "E3"));
        expect(ports.evaluations.listEvaluationJsonValues()).toEqual(["E1", "E2", "E3"]);
        expect(ports.evaluations.listEvaluatedRunIds()).toEqual(["r1", "r1", "r2"]);
        expect(() =>
          ports.evaluations.insertEvaluation(ev("e1", "r9", "2026-10-25T00:00:00.000Z", "EX"))
        ).toThrow(/UNIQUE constraint failed/);
        // The failed insert changed nothing.
        expect(ports.evaluations.listEvaluationJsonValues()).toEqual(["E1", "E2", "E3"]);
      });
    });
  }
});

describe("conformance 4e: ScreenRunLockPort", () => {
  for (const [name, make] of lockSets) {
    describe(name, () => {
      it("acquire / contention / token-release cycle with per-scope isolation", () => {
        const lock = make();
        const t0 = 1_700_000_000_000;
        const first = lock.acquire("alice", "nasdaq100", t0);
        expect(first.acquired).toBe(true);
        expect(first.tookOverStale).toBe(false);
        expect(first.startedAt).toBe(t0);
        const blocked = lock.acquire("alice", "nasdaq100", t0 + 1000);
        expect(blocked).toEqual({
          acquired: false,
          token: null,
          startedAt: t0,
          tookOverStale: false,
        });
        expect(lock.acquire("alice", "sp500", t0).acquired).toBe(true);
        expect(lock.acquire("bob", "nasdaq100", t0).acquired).toBe(true);
        lock.release("alice", "nasdaq100", "not-the-token");
        expect(lock.isRunning("alice", "nasdaq100", t0 + 2000).running).toBe(true);
        lock.release("alice", "nasdaq100", null);
        expect(lock.isRunning("alice", "nasdaq100", t0 + 2000).running).toBe(true);
        lock.release("alice", "nasdaq100", first.token);
        expect(lock.isRunning("alice", "nasdaq100", t0 + 2000)).toEqual({
          running: false,
          startedAt: null,
        });
      });

      it("staleness boundary and takeover transfer ownership", () => {
        const lock = make();
        const t0 = 1_700_000_000_000;
        const holder = lock.acquire("alice", "nasdaq100", t0);
        expect(holder.acquired).toBe(true);
        expect(lock.isRunning("alice", "nasdaq100", t0 + SCREEN_RUN_LOCK_STALE_MS)).toEqual({
          running: true,
          startedAt: t0,
        });
        expect(
          lock.isRunning("alice", "nasdaq100", t0 + SCREEN_RUN_LOCK_STALE_MS + 1)
        ).toEqual({ running: false, startedAt: t0 });
        // Not yet stale: a contender at exactly the boundary loses.
        expect(
          lock.acquire("alice", "nasdaq100", t0 + SCREEN_RUN_LOCK_STALE_MS).acquired
        ).toBe(false);
        const takeover = lock.acquire(
          "alice",
          "nasdaq100",
          t0 + SCREEN_RUN_LOCK_STALE_MS + 1
        );
        expect(takeover.acquired).toBe(true);
        expect(takeover.tookOverStale).toBe(true);
        lock.release("alice", "nasdaq100", holder.token);
        expect(
          lock.isRunning("alice", "nasdaq100", t0 + SCREEN_RUN_LOCK_STALE_MS + 2)
            .running
        ).toBe(true);
        lock.release("alice", "nasdaq100", takeover.token);
        expect(
          lock.isRunning("alice", "nasdaq100", t0 + SCREEN_RUN_LOCK_STALE_MS + 2)
            .running
        ).toBe(false);
      });
    });
  }

  it("DO adapter only: release does not ensure the table (as-found asymmetry)", () => {
    const lock = createScreenRunLockPort(new SqliteTestStorage());
    expect(() => lock.release("alice", "nasdaq100", "tok")).toThrow(/no such table/);
    // Acquire and probe DO ensure.
    lock.ensureSchema();
    expect(() => lock.release("alice", "nasdaq100", "tok")).not.toThrow();
  });
});

describe("conformance 4e: R-7 counting pins", () => {
  it("composing either family executes zero DDL", () => {
    const researchCounting = new CountingStorage(new SqliteTestStorage());
    createResearchStorePorts(researchCounting as any);
    expect(researchCounting.statements).toEqual([]);
    const lockCounting = new CountingStorage(new SqliteTestStorage());
    createScreenRunLockPort(lockCounting as any);
    expect(lockCounting.statements).toEqual([]);
  });

  it("the research family's ensureSchema creates exactly its four private tables and no shared-schema table", () => {
    const inner = new SqliteTestStorage();
    const counting = new CountingStorage(inner);
    const ports = createResearchStorePorts(counting as any);
    ports.ensureSchema();
    const created = counting
      .creates()
      .map((s) => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(s)?.[1])
      .sort();
    expect(created).toEqual([
      "research_evaluations",
      "research_runs",
      "research_settings",
      "research_task_store",
    ]);
    // Idempotent: a second ensure creates nothing new.
    ports.ensureSchema();
    expect(inner.tableNames().filter((n) => n.startsWith("mas_"))).toEqual([]);
    expect(inner.tableNames()).toEqual([
      "research_evaluations",
      "research_runs",
      "research_settings",
      "research_task_store",
    ]);
  });

  it("the lock family's ensureSchema creates only screen_run_locks", () => {
    const inner = new SqliteTestStorage();
    const counting = new CountingStorage(inner);
    const lock = createScreenRunLockPort(counting as any);
    lock.ensureSchema();
    expect(inner.tableNames()).toEqual(["screen_run_locks"]);
  });
});

describe("conformance 4e: source-scan pins (the census deltas, local form)", () => {
  const SURFACE_1 = /(?:\bsql|\bstorage|this\.sql|ctx\.storage(?:\.sql)?|\.sql)\s*\.\s*exec\s*\(/g;
  const SURFACE_2 = /\(\s*[\w.[\]]+\s+as\s+any\s*\)\s*\.\s*exec\s*\(/g;
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("research-agent.ts and screener-agent.ts hold zero surface-1 and zero surface-2 sites", () => {
    for (const rel of ["../src/agents/research-agent.ts", "../src/agents/screener-agent.ts"]) {
      const text = read(rel);
      expect(text.match(SURFACE_1) ?? []).toEqual([]);
      expect(text.match(SURFACE_2) ?? []).toEqual([]);
    }
  });

  it("services/screenRunLock.ts holds no lock statement strings (they live in the DO adapter)", () => {
    const text = read("../src/services/screenRunLock.ts");
    for (const fragment of [
      "INSERT INTO screen_run_locks",
      "UPDATE screen_run_locks",
      "DELETE FROM screen_run_locks",
      "CREATE TABLE IF NOT EXISTS screen_run_locks",
      "SELECT token, started_at",
    ]) {
      expect(text).not.toContain(fragment);
    }
    const adapter = read("../src/data/doSqliteScreenRunLockAdapter.ts");
    // The DML still lives in the adapter; the CREATE moved in
    // #4282 P2b to the DO catalogue
    // (src/data/schemaComponent/doCatalogue.ts), which the
    // adapter reads through doTableSql("screen_run_locks").
    for (const fragment of [
      "INSERT INTO screen_run_locks",
      "UPDATE screen_run_locks",
      "DELETE FROM screen_run_locks",
    ]) {
      expect(adapter).toContain(fragment);
    }
    expect(adapter).toContain('doTableSql("screen_run_locks")');
    const catalogue = read("../src/data/schemaComponent/doCatalogue.ts");
    expect(catalogue).toContain("CREATE TABLE IF NOT EXISTS screen_run_locks");
  });

  it("the mas_learnings read in screener-agent.ts is untouched (audit R-1 fence)", () => {
    const text = read("../src/agents/screener-agent.ts");
    expect(text).toContain('getActiveLearnings(this.sql, "screener")');
  });
});
