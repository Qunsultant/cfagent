/**
 * #584 — tenant isolation + usage metering for research runs (EP-003, EP-009).
 *
 * TDD: these tests define the expected behavior first. They fail until the
 * user_login scoping and usage-events ledger are implemented.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { MockD1Database } from "./mock-d1";
import { reconcileUsageEventsProjection } from "../src/agents/orchestrator/usageEventsReconcile";
import {
  createD1UsageEventMirrorDb,
  D1UsageEventMirrorAdapter,
  ensureUsageEventMirrorSchema,
} from "../src/data/d1UsageEventMirrorAdapter";
import {
  storeReportAtGeneration,
  getScheduledReportById,
  searchScheduledReports,
  listScheduledReports,
  recordUsageEvent,
  listUsageEvents,
  listUsageEventsByTenant,
  type ScheduledReportInput,
} from "../src/services/scheduledReports";

const baseInput = (over: Partial<ScheduledReportInput>): ScheduledReportInput => ({
  runId: "run-1",
  generationId: `gen-${Math.random().toString(36).slice(2)}`,
  title: "Research report",
  source: "research",
  summary: "bullish ideas",
  body: "full report body",
  userLogin: "alice",
  ...over,
});

// #6101 step 8: the canonical seam writes D1 agent_reports now
// (the DO mas_reports table is frozen); reads go through the D1
// list/search/by-id functions with an env-bound MockD1Database.
function d1Env() {
  const mock = new MockD1Database();
  return { AGENT_DB: mock as unknown as never };
}

describe("#584 report isolation (EP-003)", () => {
  it("stores the owning user on the canonical report row", async () => {
    const env = d1Env();
    const res = await storeReportAtGeneration(baseInput({ userLogin: "alice" }), env);
    expect(res).not.toBeNull();
    const hit = await getScheduledReportById(env, res!.reportId);
    expect(hit?.userLogin).toBe("alice");
  });

  it("lists only the requesting user's reports", async () => {
    const env = d1Env();
    await storeReportAtGeneration(baseInput({ userLogin: "alice" }), env);
    await storeReportAtGeneration(baseInput({ userLogin: "bob" }), env);
    const alice = await listScheduledReports(env, { userLogin: "alice" });
    const bob = await listScheduledReports(env, { userLogin: "bob" });
    expect(alice.length).toBe(1);
    expect(bob.length).toBe(1);
    expect(alice[0]).not.toEqual(bob[0]);
  });

  it("search excludes other users' reports", async () => {
    const env = d1Env();
    await storeReportAtGeneration(
      baseInput({ userLogin: "alice", summary: "zephyr bullish outlook" }),
      env,
    );
    await storeReportAtGeneration(
      baseInput({ userLogin: "bob", summary: "zephyr bearish outlook" }),
      env,
    );
    const hits = await searchScheduledReports(env, "zephyr", 50, {
      userLogin: "bob",
    });
    expect(hits.length).toBe(1);
    expect(hits[0].summary).toContain("bearish");
  });

  it("refuses to backfill an ownerless report into a synthetic tenant", async () => {
    const env = d1Env();
    // Multi-tenant SaaS: no login means no tenant. The write is refused
    // rather than filed under "default".
    expect(await storeReportAtGeneration(baseInput({ userLogin: "" }), env)).toBeNull();
    expect(await listScheduledReports(env, {})).toHaveLength(0);
  });

  it("without a user, list and search keep legacy unfiltered behavior", async () => {
    const env = d1Env();
    await storeReportAtGeneration(baseInput({ userLogin: "alice" }), env);
    await storeReportAtGeneration(baseInput({ userLogin: "bob" }), env);
    // No userLogin → no filter (identity strings not yet unified; #488).
    expect((await listScheduledReports(env, {})).length).toBe(2);
    expect((await listScheduledReports(env)).length).toBe(2);
  });
});

describe("#584 usage metering (EP-009)", () => {
  it("records a research run usage event attributed to the user", () => {
    const sql = new MockSqlStorage();
    recordUsageEvent(sql, {
      userLogin: "alice",
      runId: "run-1",
      category: "research_run",
      tenantId: "tenant-a",
    });
    const events = listUsageEvents(sql, "alice");
    expect(events.length).toBe(1);
    expect(events[0].runId).toBe("run-1");
    expect(events[0].category).toBe("research_run");
    // Issue #3185: the stamp rides the event through the service seam.
    expect(events[0].tenantId).toBe("tenant-a");
  });

  it("usage events are scoped per user", () => {
    const sql = new MockSqlStorage();
    recordUsageEvent(sql, {
      userLogin: "alice",
      runId: "run-1",
      category: "research_run",
      tenantId: "tenant-a",
    });
    recordUsageEvent(sql, {
      userLogin: "bob",
      runId: "run-2",
      category: "research_evaluation",
      tenantId: "tenant-b",
    });
    expect(listUsageEvents(sql, "alice").length).toBe(1);
    expect(listUsageEvents(sql, "bob").length).toBe(1);
    expect(listUsageEvents(sql, "carol").length).toBe(0);
  });

  it("usage events are scoped per tenant, and an absent stamp matches no tenant (issue #3185)", () => {
    const sql = new MockSqlStorage();
    recordUsageEvent(sql, {
      userLogin: "alice",
      runId: "run-1",
      category: "research_run",
      tenantId: "tenant-a",
    });
    recordUsageEvent(sql, {
      userLogin: "alice",
      runId: "run-2",
      category: "research_evaluation",
      tenantId: "tenant-a",
    });
    recordUsageEvent(sql, {
      userLogin: "bob",
      runId: "run-3",
      category: "research_run",
      tenantId: "tenant-b",
    });
    // No tenantId: legacy / unattributed — visible by login, invisible by tenant.
    recordUsageEvent(sql, {
      userLogin: "carol",
      runId: "run-4",
      category: "research_run",
    });
    expect(listUsageEventsByTenant(sql, "tenant-a").map((e) => e.runId).sort()).toEqual([
      "run-1",
      "run-2",
    ]);
    expect(listUsageEventsByTenant(sql, "tenant-b").map((e) => e.runId)).toEqual(["run-3"]);
    expect(listUsageEventsByTenant(sql, "tenant-none")).toEqual([]);
    expect(listUsageEventsByTenant(sql, "")).toEqual([]);
    expect(listUsageEvents(sql, "carol")[0].tenantId).toBeNull();
  });

  it("the ResearchAgent half (research_evaluation, sync write) reaches the mirror only through the reconcile sweep (#3185 bridge)", async () => {
    const sql = new MockSqlStorage();
    // The sync recordUsageEvent site carries no env and never calls
    // the live hook — the row exists only in this instance until
    // the sweep projects it.
    recordUsageEvent(sql, {
      userLogin: "alice",
      runId: "run-eval-1",
      category: "research_evaluation",
      tenantId: "tenant-a",
    });
    const mock = new MockD1Database();
    const mirror = new D1UsageEventMirrorAdapter(createD1UsageEventMirrorDb(mock as never));
    await ensureUsageEventMirrorSchema(mirror.db);
    expect(await mirror.listByTenant("tenant-a")).toEqual([]);
    const result = await reconcileUsageEventsProjection({
      env: { AGENT_DB: mock as never },
      sql: sql as never,
      sourceInstance: "research:alice",
      nowMs: Date.parse("2026-11-20T00:00:00.000Z"),
    });
    expect(result.errors).toEqual([]);
    expect(result.reconciled).toBe(1);
    const mirrored = await mirror.listByTenant("tenant-a");
    expect(mirrored.map((r) => r.runId)).toEqual(["run-eval-1"]);
    expect(mirrored[0].category).toBe("research_evaluation");
    expect(mirrored[0].sourceInstance).toBe("research:alice");
  });
});
