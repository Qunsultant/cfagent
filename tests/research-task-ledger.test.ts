/**
 * Issue #577 — durable research task ledger (transformation mandate §6;
 * design: docs/agents/agentic-architecture.md §5/§7).
 *
 * Unit tests run the real ResearchTaskLedger over an in-memory store
 * (the ResearchConfigService test idiom). The wiring tests pin the
 * orchestrator/agent integration by source evidence, matching the
 * repo's extraction/conformance test style: the Durable Objects
 * cannot be instantiated under Node, so the pinned contract is that
 * runResearchAndPublish creates, begins, completes, and escalates
 * tasks exactly where the design says it does.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ResearchTaskLedger,
  evaluateResearchOutcome,
  type ResearchTaskStore,
} from "../src/services/researchTaskLedger";

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
    now: () => `2026-10-20T10:00:${String(tick++).padStart(2, "0")}.000Z`,
    newId: () => `task-${++ids}`,
  });
}

const INPUT = {
  trigger: "manual" as const,
  userLogin: "alice",
  idempotencyKey: "research:manual:alice:run-0",
};

const GOOD_EVAL = evaluateResearchOutcome(
  {
    reportRunId: "run-1",
    previousRunId: "run-0",
    expectedTrigger: "manual",
    expectedUserLogin: "alice",
    reportTrigger: "manual",
    reportUserLogin: "alice",
    summary: "3 ideas",
    ideas: 3,
    watchlist: 2,
    rejected: 5,
  },
  "2026-10-20T10:01:00.000Z"
);

describe("ResearchTaskLedger lifecycle", () => {
  it("creates a queued task with history and round-trips through the store", () => {
    const store = memStore();
    const { task, created } = ledger(store).create(INPUT);
    expect(created).toBe(true);
    expect(task.status).toBe("queued");
    expect(task.history.map((h) => h.status)).toEqual(["queued"]);
    // A fresh ledger over the same store sees the same record.
    expect(ledger(store).get(task.id)?.idempotencyKey).toBe(INPUT.idempotencyKey);
  });

  it("dedups the record while a task for the idempotency key is active", () => {
    const store = memStore();
    const l = ledger(store);
    const first = l.create(INPUT);
    const dupe = l.create(INPUT);
    expect(dupe.created).toBe(false);
    expect(dupe.task.id).toBe(first.task.id);
    // Once the task reaches a terminal state, a new create is a new task.
    l.claim(first.task.id);
    l.start(first.task.id);
    l.complete(first.task.id, { path: "agent", reportRunId: "run-1", evaluation: GOOD_EVAL });
    const next = l.create(INPUT);
    expect(next.created).toBe(true);
    expect(next.task.id).not.toBe(first.task.id);
  });

  it("walks claimed → running → completed, recording path, report, evaluation", () => {
    const l = ledger(memStore());
    const { task } = l.create(INPUT);
    l.claim(task.id);
    l.start(task.id);
    l.heartbeat(task.id);
    const done = l.complete(task.id, {
      path: "agent",
      reportRunId: "run-1",
      evaluation: GOOD_EVAL,
    });
    expect(done.status).toBe("completed");
    expect(done.path).toBe("agent");
    expect(done.reportRunId).toBe("run-1");
    expect(done.evaluation?.verdict).toBe("pass");
    expect(done.history.map((h) => h.status)).toEqual([
      "queued",
      "claimed",
      "running",
      "completed",
    ]);
  });

  it("fail → escalate retains the error for a human", () => {
    const l = ledger(memStore());
    const { task } = l.create(INPUT);
    l.claim(task.id);
    l.start(task.id);
    const escalated = (() => {
      l.fail(task.id, "provider down");
      return l.escalate(task.id, "awaiting human review");
    })();
    expect(escalated.status).toBe("escalated");
    expect(escalated.error).toContain("provider down");
    expect(escalated.error).toContain("escalated:");
  });

  it("cancel works from queued, and invalid transitions throw", () => {
    const l = ledger(memStore());
    const { task } = l.create(INPUT);
    expect(() => l.start(task.id)).toThrow(/cannot move from queued to running/);
    expect(() => l.complete(task.id, { path: "agent", reportRunId: "r", evaluation: GOOD_EVAL })).toThrow();
    expect(l.cancel(task.id).status).toBe("cancelled");
    expect(() => l.claim(task.id)).toThrow(/cannot move from cancelled to claimed/);
    expect(() => l.claim("task-999")).toThrow(/not found/);
    expect(l.get("task-999")).toBeNull();
  });
});

describe("evaluateResearchOutcome (deterministic, not model-graded)", () => {
  it("passes a fresh, matching, complete report", () => {
    expect(GOOD_EVAL.verdict).toBe("pass");
    expect(GOOD_EVAL.checks).toHaveLength(6);
    expect(GOOD_EVAL.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails a stale runId (the stale-report case from #543)", () => {
    const ev = evaluateResearchOutcome(
      {
        reportRunId: "run-0",
        previousRunId: "run-0",
        expectedTrigger: "manual",
        expectedUserLogin: "alice",
        reportTrigger: "manual",
        reportUserLogin: "alice",
        summary: "old",
        ideas: 1,
        watchlist: 0,
        rejected: 0,
      },
      "2026-10-20T10:02:00.000Z"
    );
    expect(ev.verdict).toBe("fail");
    expect(ev.checks.find((c) => c.name === "run_id_fresh")?.ok).toBe(false);
  });

  it("fails mismatched trigger/login, empty summary, and negative counts", () => {
    const ev = evaluateResearchOutcome(
      {
        reportRunId: "run-9",
        previousRunId: "run-0",
        expectedTrigger: "scheduled",
        expectedUserLogin: "alice",
        reportTrigger: "manual",
        reportUserLogin: "bob",
        summary: "  ",
        ideas: -1,
        watchlist: 0,
        rejected: 0,
      },
      "2026-10-20T10:03:00.000Z"
    );
    expect(ev.verdict).toBe("fail");
    const byName = Object.fromEntries(ev.checks.map((c) => [c.name, c.ok]));
    expect(byName).toMatchObject({
      report_present: true,
      run_id_fresh: true,
      trigger_match: false,
      login_match: false,
      summary_present: false,
      counts_sane: false,
    });
  });
});

describe("slice wiring (source evidence)", () => {
  const orchestrator = fs.readFileSync(
    path.resolve(__dirname, "../src/agents/orchestrator/researchPublish.ts"),
    "utf8"
  );
  const researchAgent = fs.readFileSync(
    path.resolve(__dirname, "../src/agents/research-agent.ts"),
    "utf8"
  );
  const section = orchestrator.slice(
    orchestrator.indexOf("function runResearchAndPublish("),
    orchestrator.indexOf("export async function sendResearchSummaryEmail")
  );

  it("ResearchAgent persists the ledger in its own DO store", () => {
    expect(researchAgent).toContain("ResearchTaskLedger");
    expect(researchAgent).toContain("research_task_store");
    for (const m of ["createResearchTask", "beginResearchTask", "completeResearchTask", "failResearchTask"]) {
      expect(researchAgent).toContain(m);
    }
  });

  it("the orchestrator creates + begins before dispatch, completes after publish, escalates on total failure", () => {
    const createAt = section.indexOf("createResearchTask");
    const dispatchAt = section.indexOf("runAgentTool(ResearchAgent");
    const completeAt = section.indexOf("completeResearchTask");
    const failAt = section.indexOf("failResearchTask");
    expect(createAt).toBeGreaterThan(-1);
    expect(section).toContain("beginResearchTask");
    expect(createAt).toBeLessThan(dispatchAt);
    expect(completeAt).toBeGreaterThan(dispatchAt);
    expect(failAt).toBeGreaterThan(dispatchAt);
    // The evaluation fed to completion is the deterministic one.
    expect(section).toContain("evaluateResearchOutcome");
    // The execution path is the agent dispatch only (#6250 removed
    // the direct-pipeline fallback, so "fallback" can never be recorded).
    expect(section).toContain('executionPath: ResearchExecutionPath = "agent"');
    expect(section).not.toContain('= "fallback"');
  });
});

describe("stale detection and sweep (#615, R4)", () => {
  const T0 = Date.parse("2026-10-20T10:00:00.000Z");
  const MIN = 60_000;

  function clockLedger(store: ResearchTaskStore) {
    let nowMs = T0;
    let n = 0;
    const l = new ResearchTaskLedger(store, {
      now: () => new Date(nowMs).toISOString(),
      newId: () => `task-${++n}`,
    });
    return { l, advance: (ms: number) => { nowMs += ms; } };
  }

  function runningTask(l: ResearchTaskLedger, key: string) {
    const { task } = l.create({ ...INPUT, idempotencyKey: key });
    l.claim(task.id);
    l.start(task.id);
    return task.id;
  }

  it("does not flag a fresh active task", () => {
    const { l } = clockLedger(memStore());
    runningTask(l, "k-fresh");
    expect(l.findStale(30 * MIN)).toEqual([]);
  });

  it("flags queued, claimed and running tasks whose heartbeat aged out", () => {
    const { l, advance } = clockLedger(memStore());
    const q = l.create({ ...INPUT, idempotencyKey: "k-q" }).task.id;
    const c = l.create({ ...INPUT, idempotencyKey: "k-c" }).task.id;
    l.claim(c);
    const r = runningTask(l, "k-r");
    advance(31 * MIN);
    expect(l.findStale(30 * MIN).map((t) => t.id).sort()).toEqual([c, q, r].sort());
  });

  it("never flags terminal tasks, however old", () => {
    const { l, advance } = clockLedger(memStore());
    const done = runningTask(l, "k-done");
    l.complete(done, { path: "agent", reportRunId: "run-1", evaluation: GOOD_EVAL });
    const dead = runningTask(l, "k-dead");
    l.fail(dead, "boom");
    advance(24 * 60 * MIN);
    expect(l.findStale(30 * MIN)).toEqual([]);
  });

  it("a heartbeat refresh clears staleness", () => {
    const { l, advance } = clockLedger(memStore());
    const id = runningTask(l, "k-hb");
    advance(20 * MIN);
    l.heartbeat(id);
    advance(20 * MIN);
    expect(l.findStale(30 * MIN)).toEqual([]);
  });

  it("respects a custom threshold and findStale is read-only", () => {
    const { l, advance } = clockLedger(memStore());
    const id = runningTask(l, "k-th");
    advance(10 * MIN);
    expect(l.findStale(5 * MIN).map((t) => t.id)).toEqual([id]);
    expect(l.findStale(30 * MIN)).toEqual([]);
    expect(l.get(id)?.status).toBe("running");
  });

  it("sweepStale escalates stale tasks with the stale reason recorded", () => {
    const { l, advance } = clockLedger(memStore());
    const id = runningTask(l, "k-sweep");
    advance(45 * MIN);
    const swept = l.sweepStale(30 * MIN);
    expect(swept.map((t) => t.id)).toEqual([id]);
    const after = l.get(id);
    expect(after?.status).toBe("escalated");
    expect(after?.error).toContain("stale");
    expect(after?.error).toContain("1800000");
    expect(after?.history.map((h) => h.status)).toEqual([
      "queued", "claimed", "running", "failed", "escalated",
    ]);
  });

  it("sweepStale leaves fresh and terminal tasks untouched and does not re-sweep", () => {
    const { l, advance } = clockLedger(memStore());
    const staleId = runningTask(l, "k-old");
    advance(31 * MIN);
    const freshId = runningTask(l, "k-new");
    const doneId = runningTask(l, "k-fin");
    l.complete(doneId, { path: "agent", reportRunId: "run-9", evaluation: GOOD_EVAL });
    const swept = l.sweepStale(30 * MIN);
    expect(swept.map((t) => t.id)).toEqual([staleId]);
    expect(l.get(freshId)?.status).toBe("running");
    expect(l.get(doneId)?.status).toBe("completed");
    expect(l.sweepStale(30 * MIN)).toEqual([]);
  });

  it("exposes the operations on ResearchAgent (source evidence)", () => {
    const agent = fs.readFileSync(
      path.join(process.cwd(), "src/agents/research-agent.ts"),
      "utf8"
    );
    expect(agent).toContain("findStaleResearchTasks");
    expect(agent).toContain("sweepStaleResearchTasks");
    expect(agent).toContain(".findStale(");
    expect(agent).toContain(".sweepStale(");
  });
});

describe("record retention / pruneExpired (#635)", () => {
  const T0 = Date.parse("2026-10-20T10:00:00.000Z");
  const DAY = 24 * 60 * 60_000;

  function clockLedger(store: ResearchTaskStore) {
    let nowMs = T0;
    let n = 0;
    const l = new ResearchTaskLedger(store, {
      now: () => new Date(nowMs).toISOString(),
      newId: () => `task-${++n}`,
    });
    return { l, advance: (ms: number) => { nowMs += ms; } };
  }

  function completedTask(l: ResearchTaskLedger, key: string) {
    const { task } = l.create({ ...INPUT, idempotencyKey: key });
    l.claim(task.id);
    l.start(task.id);
    l.complete(task.id, { path: "agent", reportRunId: "run-1", evaluation: GOOD_EVAL });
    return task.id;
  }

  it("keeps terminal records younger than the retention window", () => {
    const { l, advance } = clockLedger(memStore());
    const id = completedTask(l, "k-young");
    advance(89 * DAY);
    expect(l.pruneExpired()).toEqual([]);
    expect(l.get(id)).not.toBeNull();
  });

  it("prunes completed and cancelled records older than 90 days", () => {
    const { l, advance } = clockLedger(memStore());
    const done = completedTask(l, "k-done");
    const cancelled = l.create({ ...INPUT, idempotencyKey: "k-cx" }).task.id;
    l.cancel(cancelled);
    advance(91 * DAY);
    expect(l.pruneExpired().sort()).toEqual([cancelled, done].sort());
    expect(l.get(done)).toBeNull();
    expect(l.get(cancelled)).toBeNull();
  });

  it("keeps failed/escalated records at 100 days but prunes them after 365", () => {
    const { l, advance } = clockLedger(memStore());
    const { task } = l.create({ ...INPUT, idempotencyKey: "k-esc" });
    l.claim(task.id);
    l.start(task.id);
    l.fail(task.id, "boom");
    l.escalate(task.id, "needs a human");
    advance(100 * DAY);
    expect(l.pruneExpired()).toEqual([]);
    advance(300 * DAY);
    expect(l.pruneExpired()).toEqual([task.id]);
  });

  it("never prunes active records, however old", () => {
    const { l, advance } = clockLedger(memStore());
    const { task } = l.create({ ...INPUT, idempotencyKey: "k-live" });
    l.claim(task.id);
    l.start(task.id);
    advance(400 * DAY);
    expect(l.pruneExpired()).toEqual([]);
    expect(l.get(task.id)?.status).toBe("running");
  });

  it("cleans the idempotency entry so the same key creates fresh after a prune", () => {
    const { l, advance } = clockLedger(memStore());
    const first = completedTask(l, "k-reuse");
    advance(91 * DAY);
    expect(l.pruneExpired()).toEqual([first]);
    const again = l.create({ ...INPUT, idempotencyKey: "k-reuse" });
    expect(again.created).toBe(true);
    expect(again.task.id).not.toBe(first);
  });

  it("respects custom retention values", () => {
    const { l, advance } = clockLedger(memStore());
    const id = completedTask(l, "k-custom");
    advance(10 * DAY);
    expect(l.pruneExpired({ retentionMs: 5 * DAY })).toEqual([id]);
  });

  it("exposes pruning on ResearchAgent (source evidence)", () => {
    const agent = fs.readFileSync(
      path.join(process.cwd(), "src/agents/research-agent.ts"),
      "utf8"
    );
    expect(agent).toContain("async pruneExpiredResearchTasks(");
    expect(agent).toContain(".pruneExpired(");
  });
});
