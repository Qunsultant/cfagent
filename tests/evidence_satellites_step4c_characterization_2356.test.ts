// @vitest-environment node
/**
 * Issue #2356 (#1976 step 4c, ADR 0022 D-I step 4) —
 * CHARACTERIZATION pins for the evidence satellites, written
 * against the UNPORTED service modules before the port cutover.
 * They pin current behaviour through the existing public surface
 * (the same import paths the cutover turns into §22 re-export
 * shims over src/data ports):
 *
 *  - goalScenarioStore: tables enumerated from DDL (mas_goals,
 *    mas_scenarios, mas_outcomes); tenant scoping on every read/
 *    write; createGoal refuses a missing owner; scenario/outcome
 *    referential honesty (no orphan / cross-tenant attaches);
 *  - jobOutcomes: BOTH tables from DDL (mas_job_outcomes AND
 *    mas_job_outcomes_meta — audit R-9); upsert-merge semantics
 *    (undefined never wipes, delivery states merge key-wise, a
 *    completed re-record clears a stale coded error); the prune
 *    watermark (first maybePrune true, immediate repeat false);
 *    age + cap pruning;
 *  - strategyReviews: same-day INSERT OR REPLACE dedupe by the
 *    derived id, list ordering (created_at DESC, rank ASC),
 *    decide only from pending;
 *  - outcomeTracking: append-only lifecycle (start is
 *    idempotent, first terminal stands, no UPDATE ever issued
 *    against the tracking table), Unverified when no price,
 *    expireDueOutcomes never invents a P&L;
 *  - comparison ledger (recommendationKernel writer +
 *    comparisonRunner reader): round-trip + the reader's
 *    in-code sort (created_at, arm, candidate_id, id —
 *    the id tie-break added by #2367; the writer-stamped
 *    created_at pins run on a frozen clock, see in-line);
 *  - screeningActivity: never-throws record (null on missing
 *    fields), tenant-scoped newest-first list, detail JSON
 *    round-trip, corrupt detail reads back as { raw }.
 *
 * These pins must be green before the cutover and green after
 * it — that is what makes the cutover behaviour-preserving.
 *
 * DOUBLES: node:sqlite-backed SqlStorage (real SQLite
 * semantics), because MockSqlStorage cannot execute the
 * watermark / prune / ordering shapes faithfully. The exec
 * result carries a `changes` property (run-info), matching
 * what decideStrategyReview reads from the legacy seam.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  GOAL_SCENARIO_TABLES,
  createGoal,
  createScenario,
  getGoal,
  getScenario,
  listGoals,
  listOutcomes,
  listScenarios,
  recordOutcome,
  updateGoalStatus,
} from "../src/services/goalScenarioStore";
import {
  JOB_OUTCOMES_KEEP_ROWS,
  listJobOutcomes,
  maybePruneJobOutcomes,
  pruneJobOutcomes,
  recordJobOutcome,
} from "../src/services/jobOutcomes";
import {
  decideStrategyReview,
  listStrategyReviews,
  recordStrategyCandidates,
} from "../src/services/strategyReviews";
import {
  buildOutcomesPath,
  expireDueOutcomes,
  listOutcomeTracking,
  recordOutcomeTerminal,
  startOutcomeTracking,
} from "../src/services/outcomeTracking";
import {
  ensureComparisonLedgerTable,
  recordComparisonArmOutcome,
} from "../src/services/recommendationKernel";
import { listComparisonOutcomes } from "../src/services/comparisonRunner";
import {
  buildScreeningActivityFeed,
  listScreeningActivity,
  recordScreeningActivity,
} from "../src/services/screeningActivity";

/** SqlStorage-shaped executor over node:sqlite (real semantics). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] & { changes?: number } {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { changes?: number };
    out.changes = Number(info.changes);
    return out;
  }
}

function freshSql(): SqliteTestStorage & { exec: (...a: never[]) => unknown } {
  return new SqliteTestStorage() as never;
}

function tableNames(sql: SqliteTestStorage): string[] {
  const rows = sql.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// goalScenarioStore
// ---------------------------------------------------------------------------

describe("characterization 4c: goalScenarioStore", () => {
  it("declares and creates exactly its three DDL tables", () => {
    const sql = freshSql();
    expect(GOAL_SCENARIO_TABLES).toEqual(["mas_goals", "mas_scenarios", "mas_outcomes"]);
    const g = createGoal(sql as never, { userLogin: "alice", kind: "income", title: "T" });
    expect(g.id).toMatch(/^goal:/);  // #5175 slice 3: goal records mint goal:<time36>-<rand6>
    const names = tableNames(sql);
    for (const t of GOAL_SCENARIO_TABLES) expect(names, t).toContain(t);
  });

  it("createGoal refuses a missing owner (no default identity)", () => {
    const sql = freshSql();
    expect(() =>
      createGoal(sql as never, { kind: "income", title: "T" } as never),
    ).toThrow(/requires an owning userLogin/);
  });

  it("goal CRUD round-trips with tenant isolation", () => {
    const sql = freshSql();
    const g = createGoal(sql as never, {
      userLogin: "alice", kind: "income", title: "Income", payload: { x: 1 },
    });
    expect(getGoal(sql as never, "alice", g.id)?.title).toBe("Income");
    expect(getGoal(sql as never, "alice", g.id)?.payload).toEqual({ x: 1 });
    expect(getGoal(sql as never, "bob", g.id)).toBeNull();
    expect(listGoals(sql as never, "bob")).toEqual([]);
    expect(listGoals(sql as never, "alice")).toHaveLength(1);
    expect(listGoals(sql as never, "alice", "active")).toEqual([]);
    expect(updateGoalStatus(sql as never, "bob", g.id, "active")).toBe(false);
    expect(updateGoalStatus(sql as never, "alice", g.id, "active")).toBe(true);
    expect(getGoal(sql as never, "alice", g.id)?.status).toBe("active");
    expect(listGoals(sql as never, "alice", "active")).toHaveLength(1);
  });

  it("scenario attach is referentially honest and tenant-scoped", () => {
    const sql = freshSql();
    const g = createGoal(sql as never, { userLogin: "alice", kind: "hedge_protect", title: "H" });
    expect(
      createScenario(sql as never, {
        userLogin: "alice", goalId: "missing", portfolioRef: { kind: "real" },
      }),
    ).toBeNull();
    expect(
      createScenario(sql as never, {
        userLogin: "bob", goalId: g.id, portfolioRef: { kind: "real" },
      }),
    ).toBeNull();
    const s = createScenario(sql as never, {
      userLogin: "alice", goalId: g.id,
      portfolioRef: { kind: "hypothetical", ref: "p1" }, shocks: { spy: -0.1 },
    });
    expect(s?.id).toMatch(/^scen:/);  // #5175 slice 3: scenario rows mint scen:<uuid>
    expect(s?.portfolioRef).toEqual({ kind: "hypothetical", ref: "p1" });
    expect(getScenario(sql as never, "bob", s!.id)).toBeNull();
    expect(listScenarios(sql as never, "alice", g.id)).toHaveLength(1);
  });

  it("outcome recording checks named parents for the same tenant", () => {
    const sql = freshSql();
    const g = createGoal(sql as never, { userLogin: "alice", kind: "income", title: "I" });
    expect(
      recordOutcome(sql as never, { userLogin: "alice", goalId: "nope", kind: "paper" }),
    ).toBeNull();
    const o = recordOutcome(sql as never, {
      userLogin: "alice", goalId: g.id, kind: "paper",
      recommendationRef: "rec-1", metrics: { pnl: 3 },
    });
    expect(o?.id).toMatch(/^outc:/);  // #5175 slice 3: outcome rows mint outc:<uuid>
    expect(listOutcomes(sql as never, "alice", { goalId: g.id })).toHaveLength(1);
    expect(listOutcomes(sql as never, "bob")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// jobOutcomes (BOTH tables — audit R-9)
// ---------------------------------------------------------------------------

describe("characterization 4c: jobOutcomes", () => {
  it("creates BOTH DDL tables (outcomes + meta watermark)", () => {
    const sql = freshSql();
    recordJobOutcome(sql as never, {
      id: "j1", kind: "stock", trigger: "manual", status: "completed", origin: "test",
    });
    maybePruneJobOutcomes(sql as never, Date.parse("2026-10-29T00:00:00.000Z"));
    const names = tableNames(sql);
    expect(names).toContain("mas_job_outcomes");
    expect(names).toContain("mas_job_outcomes_meta");
  });

  it("upsert-merge: undefined never wipes, delivery merges key-wise, completed clears stale error", () => {
    const sql = freshSql();
    recordJobOutcome(sql as never, {
      id: "j1", kind: "options", trigger: "scheduled", status: "failed",
      scanned: 10, codedError: "E1", deliveryStates: { email: "sent" }, origin: "bus",
      createdAt: "2026-10-28T00:00:00.000Z",
    });
    const merged = recordJobOutcome(sql as never, {
      id: "j1", kind: "options", trigger: "scheduled", status: "completed",
      deliveryStates: { slack: "sent" }, origin: "tree",
    });
    expect(merged.scanned).toBe(10);
    expect(merged.codedError).toBeNull();
    expect(merged.deliveryStates).toEqual({ email: "sent", slack: "sent" });
    expect(merged.createdAt).toBe("2026-10-28T00:00:00.000Z");
    expect(listJobOutcomes(sql as never)).toHaveLength(1);
  });

  it("lists newest first and honours the limit", () => {
    const sql = freshSql();
    recordJobOutcome(sql as never, {
      id: "old", kind: "stock", trigger: "manual", status: "completed", origin: "t",
      createdAt: "2026-10-27T00:00:00.000Z",
    });
    recordJobOutcome(sql as never, {
      id: "new", kind: "stock", trigger: "manual", status: "completed", origin: "t",
      createdAt: "2026-10-28T00:00:00.000Z",
    });
    expect(listJobOutcomes(sql as never).map((r) => r.id)).toEqual(["new", "old"]);
    expect(listJobOutcomesSafe(sql)).toEqual(["new"]);
  });

  it("maybePrune watermark: first call prunes, immediate repeat is a no-op", () => {
    const sql = freshSql();
    const t0 = Date.parse("2026-10-29T00:00:00.000Z");
    expect(maybePruneJobOutcomes(sql as never, t0)).toBe(true);
    expect(maybePruneJobOutcomes(sql as never, t0 + 1000)).toBe(false);
    expect(maybePruneJobOutcomes(sql as never, t0 + 25 * 3_600_000)).toBe(true);
  });

  it("prune applies age and cap rules independently", () => {
    const sql = freshSql();
    const now = Date.parse("2026-10-29T00:00:00.000Z");
    recordJobOutcome(sql as never, {
      id: "ancient", kind: "stock", trigger: "manual", status: "completed", origin: "t",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    recordJobOutcome(sql as never, {
      id: "fresh", kind: "stock", trigger: "manual", status: "completed", origin: "t",
      createdAt: "2026-10-28T00:00:00.000Z",
    });
    const byAge = pruneJobOutcomes(sql as never, { retentionDays: 90, now: () => now });
    expect(byAge.deletedByAge).toBe(1);
    expect(listJobOutcomes(sql as never).map((r) => r.id)).toEqual(["fresh"]);
    for (let i = 0; i < 5; i++) {
      recordJobOutcome(sql as never, {
        id: `cap-${i}`, kind: "stock", trigger: "manual", status: "completed", origin: "t",
        createdAt: `2026-10-28T0${i}:00:00.000Z`,
      });
    }
    const byCap = pruneJobOutcomes(sql as never, {
      retentionDays: 0, keepRows: 2, now: () => now,
    });
    expect(byCap.deletedByCap).toBe(4);
    expect(JOB_OUTCOMES_KEEP_ROWS).toBe(500);
  });
});

function listJobOutcomesSafe(sql: SqliteTestStorage): string[] {
  return listJobOutcomes(sql as never, 1).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// strategyReviews
// ---------------------------------------------------------------------------

describe("characterization 4c: strategyReviews", () => {
  it("records, lists newest/rank-ordered, and dedupes same-day by derived id", () => {
    const sql = freshSql();
    recordStrategyCandidates(sql as never, "AAPL", [
      { id: "c2", label: "B", rank: 2, rationale: "r2", quantStatus: "verified" },
      { id: "c1", label: "A", rank: 1, rationale: "r1", quantStatus: "unverified" },
    ]);
    const rows = listStrategyReviews(sql as never);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.candidateId)).toEqual(["c1", "c2"]);
    expect(rows[0].decision).toBe("pending");
    recordStrategyCandidates(sql as never, "AAPL", [
      { id: "c1", label: "A2", rank: 1, rationale: "r1b", quantStatus: "verified" },
    ]);
    const after = listStrategyReviews(sql as never);
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.candidateId === "c1")?.label).toBe("A2");
  });

  it("decide moves only pending rows, exactly once", () => {
    const sql = freshSql();
    recordStrategyCandidates(sql as never, "MSFT", [
      { id: "c1", label: "A", rank: 1, rationale: "r", quantStatus: "verified" },
    ]);
    const row = listStrategyReviews(sql as never)[0];
    expect(decideStrategyReview(sql as never, row.id, "approved")).toBe(true);
    expect(decideStrategyReview(sql as never, row.id, "rejected")).toBe(false);
    expect(listStrategyReviews(sql as never, "approved")).toHaveLength(1);
    expect(listStrategyReviews(sql as never, "pending")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// outcomeTracking
// ---------------------------------------------------------------------------

describe("characterization 4c: outcomeTracking", () => {
  function seedOutcome(sql: SqliteTestStorage): void {
    const g = createGoal(sql as never, { userLogin: "alice", kind: "income", title: "I" });
    recordOutcome(sql as never, {
      userLogin: "alice", goalId: g.id, kind: "paper", recommendationRef: "rec-1",
    });
  }

  it("start requires an existing outcome row and is idempotent", () => {
    const sql = freshSql();
    expect(
      startOutcomeTracking(sql as never, "alice", { recommendationRef: "ghost" }),
    ).toBeNull();
    seedOutcome(sql);
    const s1 = startOutcomeTracking(sql as never, "alice", {
      recommendationRef: "rec-1", now: new Date("2026-10-20T00:00:00.000Z"),
    });
    expect(s1?.status).toBe("open");
    expect(s1?.quality).toBe("pending");
    const s2 = startOutcomeTracking(sql as never, "alice", {
      recommendationRef: "rec-1", now: new Date("2026-10-21T00:00:00.000Z"),
    });
    expect(s2?.trackedAt).toBe(s1?.trackedAt);
    expect(listOutcomeTracking(sql as never, "alice")).toHaveLength(1);
    expect(listOutcomeTracking(sql as never, "bob")).toEqual([]);
  });

  it("first terminal stands; a terminal without a price is Unverified", () => {
    const sql = freshSql();
    seedOutcome(sql);
    startOutcomeTracking(sql as never, "alice", { recommendationRef: "rec-1" });
    expect(
      recordOutcomeTerminal(sql as never, "alice", "rec-1", { kind: "expired" }).appended,
    ).toBe(true);
    const again = recordOutcomeTerminal(sql as never, "alice", "rec-1", {
      kind: "realized", pnlAfterCost: 5,
    });
    expect(again.appended).toBe(false);
    const summary = listOutcomeTracking(sql as never, "alice")[0];
    expect(summary.status).toBe("expired");
    expect(summary.quality).toBe("unverified");
    expect(summary.pnlAfterCost).toBeNull();
  });

  it("never issues an UPDATE against the tracking table (append-only)", () => {
    const sql = freshSql();
    seedOutcome(sql);
    const queries: string[] = [];
    const recording = {
      exec: (q: string, ...a: unknown[]) => {
        queries.push(q);
        return (sql.exec as (...x: unknown[]) => unknown)(q, ...a);
      },
    };
    startOutcomeTracking(recording as never, "alice", { recommendationRef: "rec-1" });
    recordOutcomeTerminal(recording as never, "alice", "rec-1", {
      kind: "realized", pnlAfterCost: 1,
    });
    expect(
      queries.some((q) => /^\s*UPDATE\s+mas_outcome_tracking/i.test(q)),
    ).toBe(false);
  });

  it("expireDueOutcomes awaits a supplied price instead of inventing one", () => {
    const sql = freshSql();
    seedOutcome(sql);
    startOutcomeTracking(sql as never, "alice", {
      recommendationRef: "rec-1", expiryDate: "2026-10-01",
    });
    const now = new Date("2026-10-29T00:00:00.000Z");
    expect(expireDueOutcomes(sql as never, "alice", { now, finalPnlByRef: {} }))
      .toEqual({ expired: [], awaitingPrice: ["rec-1"] });
    expect(
      expireDueOutcomes(sql as never, "alice", { now, finalPnlByRef: { "rec-1": 2.5 } }),
    ).toEqual({ expired: ["rec-1"], awaitingPrice: [] });
    const path = buildOutcomesPath(sql as never, "alice", { ideas: [] } as never);
    expect(path[0].tracking?.quality).toBe("verified");
  });
});

// ---------------------------------------------------------------------------
// comparison ledger (kernel writer + runner reader)
// ---------------------------------------------------------------------------

describe("characterization 4c: comparison ledger", () => {
  it("round-trips writer rows through the reader, sorted in code", () => {
    const sql = freshSql();
    ensureComparisonLedgerTable(sql as never);
    const cand = (id: string, structure: string) =>
      ({ id, structure, symbol: "AAPL", status: "ranked", provenance: "panel" }) as never;
    // #2367 (§7 adaptation): the writer stamps wall-clock
    // created_at per record, and the asserted order below is
    // the reader's (arm, candidate) tie-break — which only
    // engages when the stamps tie. Unfrozen, the two run-1
    // records land in the same millisecond only ~93% of the
    // time (measured), so the pin flaked whenever a boundary
    // fell between the stamps and created_at — correctly —
    // ordered quant first. The clock is frozen so the tie
    // this pin exercises happens by construction; every
    // assertion below is unchanged.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-29T00:00:00.000Z"));
      recordComparisonArmOutcome(sql as never, {
        runId: "run-1", arm: "quant", candidate: cand("c2", "spread"),
      });
      recordComparisonArmOutcome(sql as never, {
        runId: "run-1", arm: "llm", candidate: cand("c1", "spread"),
      });
      recordComparisonArmOutcome(sql as never, {
        runId: "run-2", arm: "llm", candidate: cand("c9", "naked"),
      });
    } finally {
      vi.useRealTimers();
    }
    const all = listComparisonOutcomes(sql as never);
    expect(all).toHaveLength(3);
    const run1 = listComparisonOutcomes(sql as never, "run-1");
    expect(run1.map((r) => r.arm)).toEqual(["llm", "quant"]);
    expect(run1[0].candidate_id).toBe("c1");
    const names = tableNames(sql);
    expect(names).toContain("mas_comparison_arm_outcomes");
  });

  it("created_at is the reader's primary sort key (clock-controlled, #2367)", () => {
    const sql = freshSql();
    ensureComparisonLedgerTable(sql as never);
    const cand = (id: string, structure: string) =>
      ({ id, structure, symbol: "AAPL", status: "ranked", provenance: "panel" }) as never;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-29T00:00:00.000Z"));
      recordComparisonArmOutcome(sql as never, {
        runId: "run-1", arm: "quant", candidate: cand("c2", "spread"),
      });
      vi.setSystemTime(new Date("2026-10-29T00:00:01.000Z"));
      recordComparisonArmOutcome(sql as never, {
        runId: "run-1", arm: "llm", candidate: cand("c1", "spread"),
      });
    } finally {
      vi.useRealTimers();
    }
    // Distinct stamps: created_at decides before arm is ever
    // consulted — the exact configuration that used to flake
    // the round-trip pin when it arose by chance.
    const run1 = listComparisonOutcomes(sql as never, "run-1");
    expect(run1.map((r) => r.arm)).toEqual(["quant", "llm"]);
    expect(run1.map((r) => r.created_at)).toEqual([
      "2026-10-29T00:00:00.000Z",
      "2026-10-29T00:00:01.000Z",
    ]);
  });
});

// ---------------------------------------------------------------------------
// screeningActivity
// ---------------------------------------------------------------------------

describe("characterization 4c: screeningActivity", () => {
  it("records and lists tenant-scoped, newest first, with detail round-trip", () => {
    const sql = freshSql();
    const id = recordScreeningActivity(sql as never, {
      userLogin: "alice", kind: "screen_run", summary: "ran",
      detail: { n: 1 }, createdAt: "2026-10-28T00:00:00.000Z",
    });
    expect(id).toMatch(/^sact_/);
    recordScreeningActivity(sql as never, {
      userLogin: "alice", kind: "delivery", summary: "sent",
      createdAt: "2026-10-29T00:00:00.000Z",
    });
    recordScreeningActivity(sql as never, {
      userLogin: "bob", kind: "screen_run", summary: "other",
      createdAt: "2026-10-29T01:00:00.000Z",
    });
    const rows = listScreeningActivity(sql as never, "alice");
    expect(rows.map((r) => r.summary)).toEqual(["sent", "ran"]);
    expect(rows[1].detail).toEqual({ n: 1 });
    expect(tableNames(sql)).toContain("mas_screening_activity");
  });

  it("record never throws: missing fields return null; feed merges the activity source", () => {
    const sql = freshSql();
    expect(
      recordScreeningActivity(sql as never, {
        userLogin: "", kind: "screen_run", summary: "x",
      } as never),
    ).toBeNull();
    recordScreeningActivity(sql as never, {
      userLogin: "alice", kind: "screen_run", summary: "ran",
      createdAt: "2026-10-29T00:00:00.000Z",
    });
    const feed = buildScreeningActivityFeed(sql as never, "alice");
    expect(feed).toHaveLength(1);
    expect(feed[0].source).toBe("activity");
  });

  it("corrupt detail_json reads back as { raw }", () => {
    const sql = freshSql();
    recordScreeningActivity(sql as never, {
      userLogin: "alice", kind: "screen_run", summary: "ran",
    });
    sql.exec(
      "UPDATE mas_screening_activity SET detail_json = 'not-json' WHERE user_login = 'alice'",
    );
    expect(listScreeningActivity(sql as never, "alice")[0].detail)
      .toEqual({ raw: "not-json" });
  });
});
