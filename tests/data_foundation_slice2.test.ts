// @vitest-environment node
/**
 * Issue #1676 ([AGENTIC] Slice 2, shard jobs projection,
 * sub-issue of the #1546 AgentDB program) — TDD red-first.
 *
 * The port/dialect suite runs UNCHANGED against the Drizzle D1
 * adapter (over a MockD1Database backed by node:sqlite) and the
 * in-memory adapter. Pinned contracts:
 *  - Migration 0003 owns the agent_shard_jobs DDL; the Drizzle
 *    schema maps it.
 *  - Every row carries tenant/workspace/chain/version/timestamps
 *    and provenance (writer, source DO, source version).
 *  - One row per (chain, job): inline shard ids for completed
 *    legs, rails job ids for submitted legs, `leg:<stepId>` for
 *    failed legs. Replaying the same status is a no-op; a status
 *    change writes version+1.
 *  - Only legs that ran project anything: completed, submitted,
 *    failed. Skipped / blocked / unimplemented project nothing.
 *  - A projection failure never fails the run: the projector
 *    reports it and returns, never throws; reconciliation then
 *    converges rails state to the projection.
 *  - No projection writer accepts auth material of any kind;
 *    port modules never import a store client; domain modules
 *    never import drizzle-orm.
 *  - Submission specs are never persisted (they may carry
 *    operator identity / query text): submitted rows store only
 *    the job id and detail.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  createD1ShardJobDb,
  D1ShardJobAdapter,
  ensureShardJobSchema,
} from "../src/data/d1ShardJobAdapter";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import {
  MIGRATION_0003_AGENT_SHARD_JOBS,
  MIGRATION_0038_AGENT_SHARD_JOBS_WORKFLOW_RUN_ID,
  applyMigrations,
} from "../src/data/migrationRunner";
import { agentShardJobs } from "../src/data/drizzleSchema";
import type {
  LegOutcome,
  ShardJobRow,
  ShardJobStore,
} from "../src/data/shardJobPorts";
import {
  projectLegOutcomes,
  reconcileShardJobs,
  SHARD_JOB_RESULT_JSON_MAX,
  type RailsJobState,
} from "../src/data/shardJobProjection";
import {
  projectRunLegs,
  readJobHistory,
} from "../src/data/createShardJobPorts";
import {
  handleJobHistoryRoute,
  handleReconcileJobsRoute,
} from "../src/data/shardJobRoute";

/** Minimal D1Database stand-in over node:sqlite (test-only, same as slices 0/1). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

async function makeD1Store(): Promise<ShardJobStore> {
  const mock = new MockD1Database();
  const db = createD1ShardJobDb(mock as any);
  await ensureShardJobSchema(db);
  return new D1ShardJobAdapter(db);
}

function jobRow(
  overrides: Partial<ShardJobRow> & { chainId: string; jobKey: string },
): ShardJobRow {
  return {
    tenantId: "primary",
    workspaceId: "primary",
    version: 1,
    status: "completed",
    stage: "feed",
    capabilityId: "feed-dataprovider",
    detail: "Completed.",
    resultJson: "null",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    provenanceWriter: "test",
    provenanceSourceDo: "ScheduledAgent",
    provenanceSourceVersion: "1",
    ...overrides,
  };
}

function leg(
  overrides: Partial<LegOutcome> & { stepId: string },
): LegOutcome {
  return {
    capabilityId: "feed-dataprovider",
    stage: "feed",
    status: "completed",
    detail: "Completed.",
    ...overrides,
  };
}

describe("shard job port / dialect suite (#1676)", () => {
  const factories: Array<{
    name: string;
    make: () => Promise<ShardJobStore>;
  }> = [
    { name: "d1", make: makeD1Store },
    {
      name: "in-memory",
      make: async () => new InMemoryShardJobAdapter(),
    },
  ];

  for (const factory of factories) {
    describe(`adapter: ${factory.name}`, () => {
      it("no rows → latest and list reads are empty", async () => {
        const store = await factory.make();
        expect(await store.latestJob("primary", "c1", "j1")).toBeNull();
        expect(await store.listJobsForChain("primary", "c1")).toEqual([]);
        expect(await store.listJobsByStatus("primary", "submitted")).toEqual(
          [],
        );
      });

      it("latest version wins regardless of insert order", async () => {
        const store = await factory.make();
        await store.recordJob(
          jobRow({ chainId: "c1", jobKey: "j1", version: 2, status: "failed" }),
        );
        await store.recordJob(
          jobRow({ chainId: "c1", jobKey: "j1", version: 1, status: "submitted" }),
        );
        const latest = await store.latestJob("primary", "c1", "j1");
        expect(latest?.status).toBe("failed");
        expect(latest?.version).toBe(2);
      });

      it("replaying the same (tenant, chain, job, version) is a no-op", async () => {
        const store = await factory.make();
        await store.recordJob(
          jobRow({ chainId: "c1", jobKey: "j1", version: 1, status: "submitted" }),
        );
        await store.recordJob(
          jobRow({ chainId: "c1", jobKey: "j1", version: 1, status: "completed" }),
        );
        expect((await store.latestJob("primary", "c1", "j1"))?.status).toBe(
          "submitted",
        );
      });

      it("listJobsForChain returns latest per job only", async () => {
        const store = await factory.make();
        await store.recordJob(
          jobRow({ chainId: "c1", jobKey: "j1", version: 1, status: "submitted", updatedAtMs: 1000 }),
        );
        await store.recordJob(
          jobRow({ chainId: "c1", jobKey: "j1", version: 2, status: "completed", updatedAtMs: 2000 }),
        );
        await store.recordJob(
          jobRow({ chainId: "c1", jobKey: "j2", version: 1, status: "submitted", updatedAtMs: 1500 }),
        );
        await store.recordJob(
          jobRow({ chainId: "c2", jobKey: "j1", version: 1, status: "submitted" }),
        );
        const jobs = await store.listJobsForChain("primary", "c1");
        expect(jobs.map((j) => j.jobKey)).toEqual(["j1", "j2"]);
        expect(jobs[0].status).toBe("completed");
        expect(jobs[0].version).toBe(2);
      });

      it("listJobsByStatus returns latest rows with that status only", async () => {
        const store = await factory.make();
        await store.recordJob(
          jobRow({ chainId: "c1", jobKey: "j1", version: 1, status: "submitted" }),
        );
        await store.recordJob(
          jobRow({ chainId: "c1", jobKey: "j1", version: 2, status: "completed" }),
        );
        await store.recordJob(
          jobRow({ chainId: "c1", jobKey: "j2", version: 1, status: "submitted" }),
        );
        const submitted = await store.listJobsByStatus("primary", "submitted");
        expect(submitted.map((j) => j.jobKey)).toEqual(["j2"]);
      });

      it("tenant isolation: one tenant's rows are invisible to another", async () => {
        const store = await factory.make();
        await store.recordJob(
          jobRow({ chainId: "c1", jobKey: "j1", tenantId: "tenant-a" }),
        );
        expect(await store.latestJob("tenant-b", "c1", "j1")).toBeNull();
        expect(await store.listJobsForChain("tenant-b", "c1")).toEqual([]);
        expect(await store.listJobsByStatus("tenant-b", "completed")).toEqual([]);
        expect(await store.latestJob("primary", "c1", "j1")).toBeNull();
      });
    });
  }
});

describe("migration 0003 (#1676)", () => {
  it("applies once, records _migrations, second apply is a no-op", async () => {
    const mock = new MockD1Database();
    const db = createD1ShardJobDb(mock as any);
    await applyMigrations(db, [MIGRATION_0003_AGENT_SHARD_JOBS]);
    await applyMigrations(db, [MIGRATION_0003_AGENT_SHARD_JOBS]);
    const rows = mock.sqlite
      .prepare("SELECT version, name FROM _migrations ORDER BY version")
      .all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 3 });
    const found = mock.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .all("agent_shard_jobs");
    expect(found).toHaveLength(1);
  });

  it("migration DDL and Drizzle schema agree on columns", () => {
    const rawColumns = getTableConfig(agentShardJobs as any).columns as any;
    const schemaColumns = Array.isArray(rawColumns)
      ? rawColumns.map((c: any) => c.name as string)
      : Object.keys(rawColumns).map((s) =>
          s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        );
    const block = MIGRATION_0003_AGENT_SHARD_JOBS.sql
      .split("CREATE TABLE IF NOT EXISTS agent_shard_jobs (")[1]
      .split("\n);")[0];
    const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]);
    // Issue #2989: migration 0038 adds workflow_run_id by ALTER
    // (0003 is already applied and still owns the CREATE DDL),
    // so the expected set is 0003's columns plus the ALTERed one.
    const altered = [
      ...MIGRATION_0038_AGENT_SHARD_JOBS_WORKFLOW_RUN_ID.sql.matchAll(/ADD COLUMN (\w+)/g),
    ].map((m) => m[1]);
    expect([...ddlColumns, ...altered].sort()).toEqual(schemaColumns.sort());
  });
});

describe("shard job projection (#1676, R5)", () => {
  const base = {
    tenantId: "primary",
    workspaceId: "primary",
    chainId: "c1",
    nowMs: 5000,
    writer: "scheduled-agent:fire",
  };

  it("completed legs project one row per shard id", async () => {
    const store = new InMemoryShardJobAdapter();
    const result = await projectLegOutcomes({
      store,
      ...base,
      legs: [
        leg({
          stepId: "s1",
          status: "completed",
          result: {
            chainId: "c1",
            shardJobIds: ["chain-exec:c1:feed:a", "chain-exec:c1:feed:b"],
            result: { format: "csv", key: "k", fileName: "f.csv" },
          },
        }),
      ],
    });
    expect(result.projected).toBe(true);
    expect(result.projectedJobs).toBe(2);
    const jobs = await store.listJobsForChain("primary", "c1");
    expect(jobs.map((j) => j.jobKey).sort()).toEqual([
      "chain-exec:c1:feed:a",
      "chain-exec:c1:feed:b",
    ]);
    expect(jobs.every((j) => j.status === "completed")).toBe(true);
  });

  it("shared stage shard ids across legs dedupe to one row per job", async () => {
    const store = new InMemoryShardJobAdapter();
    await projectLegOutcomes({
      store,
      ...base,
      legs: [
        leg({
          stepId: "s1",
          capabilityId: "feed-dataprovider",
          status: "completed",
          result: { shardJobIds: ["chain-exec:c1:feed:a"] },
        }),
        leg({
          stepId: "s2",
          capabilityId: "feed-screener-pipeline",
          status: "completed",
          result: { shardJobIds: ["chain-exec:c1:feed:a"] },
        }),
      ],
    });
    expect((await store.listJobsForChain("primary", "c1")).length).toBe(1);
  });

  it("replaying the same outcome is a no-op; a status change writes version+1", async () => {
    const store = new InMemoryShardJobAdapter();
    const submitted = leg({
      stepId: "s9",
      capabilityId: "serve-report",
      stage: "serve",
      status: "submitted",
      detail: "Submitted to the rails.",
      result: { jobId: "rails-1", detail: "Submitted to the rails." },
    });
    await projectLegOutcomes({ store, ...base, legs: [submitted] });
    const replay = await projectLegOutcomes({ store, ...base, legs: [submitted] });
    expect(replay.skippedJobs).toBe(1);
    expect(replay.projectedJobs).toBe(0);
    // Same job key reported with a new status writes version+1 and
    // preserves first-seen time. (The realistic driver of a status
    // change is reconcile from rails states, covered below; this
    // pins the projector's versioning mechanism itself.)
    await projectLegOutcomes({
      store,
      ...base,
      legs: [
        leg({
          stepId: "s9",
          capabilityId: "serve-report",
          stage: "serve",
          status: "completed",
          result: { shardJobIds: ["rails-1"], result: { ok: true } },
        }),
      ],
    });
    const latest = await store.latestJob("primary", "c1", "rails-1");
    expect(latest?.status).toBe("completed");
    expect(latest?.version).toBe(2);
    expect(latest?.createdAtMs).toBe(5000);
  });

  it("submitted rows never persist submission specs", async () => {
    const store = new InMemoryShardJobAdapter();
    await projectLegOutcomes({
      store,
      ...base,
      legs: [
        leg({
          stepId: "s9",
          capabilityId: "serve-report",
          stage: "serve",
          status: "submitted",
          result: {
            jobId: "rails-9",
            detail: "Submitted.",
            submission: {
              capability: "nlq.execute",
              payload: { query: "secret query", userLogin: "operator-x" },
            },
          },
        }),
      ],
    });
    const row = await store.latestJob("primary", "c1", "rails-9");
    expect(row?.resultJson).not.toContain("secret query");
    expect(row?.resultJson).not.toContain("operator-x");
    expect(row?.resultJson).not.toContain("submission");
  });

  it("failed legs project leg-keyed rows; skipped/blocked/unimplemented project nothing", async () => {
    const store = new InMemoryShardJobAdapter();
    const result = await projectLegOutcomes({
      store,
      ...base,
      legs: [
        leg({ stepId: "bad", status: "failed", detail: "Boom." }),
        leg({ stepId: "sk", status: "skipped", detail: "Skipped." }),
        leg({ stepId: "bl", status: "blocked", detail: "Blocked." }),
        leg({ stepId: "un", status: "unimplemented", detail: "No executor." }),
      ],
    });
    expect(result.projectedJobs).toBe(1);
    const jobs = await store.listJobsForChain("primary", "c1");
    expect(jobs.map((j) => j.jobKey)).toEqual(["leg:bad"]);
    expect(jobs[0].status).toBe("failed");
  });

  it("completed legs without shard ids fall back to leg-keyed rows", async () => {
    const store = new InMemoryShardJobAdapter();
    await projectLegOutcomes({
      store,
      ...base,
      legs: [leg({ stepId: "s3", status: "completed", result: {} })],
    });
    expect((await store.listJobsForChain("primary", "c1")).map((j) => j.jobKey)).toEqual([
      "leg:s3",
    ]);
  });

  it("oversized results are capped, never unbounded", async () => {
    const store = new InMemoryShardJobAdapter();
    await projectLegOutcomes({
      store,
      ...base,
      legs: [
        leg({
          stepId: "big",
          status: "completed",
          result: { shardJobIds: ["j-big"], result: { blob: "x".repeat(20000) } },
        }),
      ],
    });
    const row = await store.latestJob("primary", "c1", "j-big");
    expect(row).not.toBeNull();
    expect(row!.resultJson.length).toBeLessThanOrEqual(
      SHARD_JOB_RESULT_JSON_MAX + 20,
    );
    expect(row!.resultJson.endsWith("[truncated]")).toBe(true);
  });

  it("a projection failure never throws; it is reported", async () => {
    const throwing: ShardJobStore = {
      recordJob: async () => {
        throw new Error("store down");
      },
      latestJob: async () => null,
      listJobsForChain: async () => [],
      listJobsByStatus: async () => [],
    };
    const result = await projectLegOutcomes({
      store: throwing,
      ...base,
      legs: [leg({ stepId: "s1", status: "completed", result: { shardJobIds: ["j1"] } })],
    });
    expect(result.projected).toBe(false);
    expect(result.error).toContain("store down");
  });

  it("composition root: unbound env is a no-op, never a throw", async () => {
    const projected = await projectRunLegs(
      {},
      {
        tenantId: "primary",
        workspaceId: "primary",
        chainId: "c1",
        legs: [leg({ stepId: "s1" })],
        nowMs: 5000,
        writer: "test",
      },
    );
    expect(projected).toMatchObject({ projected: false, skipped: true });
    expect(await readJobHistory({}, "primary", "c1")).toBeNull();
  });
});

describe("shard job reconciliation (#1676, R5)", () => {
  const base = {
    tenantId: "primary",
    workspaceId: "primary",
    nowMs: 9000,
  };

  function railsState(
    overrides: Partial<RailsJobState> & { jobKey: string; chainId: string },
  ): RailsJobState {
    return {
      status: "completed",
      stage: "serve",
      capabilityId: "serve-report",
      detail: "Rails job completed.",
      createdAtMs: 1000,
      updatedAtMs: 8000,
      ...overrides,
    };
  }

  it("advances submitted rows to terminal rails status, preserving first-seen time", async () => {
    const store = new InMemoryShardJobAdapter();
    await store.recordJob(
      jobRow({
        chainId: "c1",
        jobKey: "rails-1",
        status: "submitted",
        createdAtMs: 1000,
        updatedAtMs: 1000,
      }),
    );
    const report = await reconcileShardJobs({
      store,
      ...base,
      railsStates: [railsState({ jobKey: "rails-1", chainId: "c1" })],
    });
    expect(report).toMatchObject({ checked: 1, reconciled: 1, alreadyCurrent: 0 });
    const latest = await store.latestJob("primary", "c1", "rails-1");
    expect(latest?.status).toBe("completed");
    expect(latest?.version).toBe(2);
    expect(latest?.createdAtMs).toBe(1000);
  });

  it("already-current rows are untouched; unknown rails jobs create version-1 rows", async () => {
    const store = new InMemoryShardJobAdapter();
    await store.recordJob(
      jobRow({
        chainId: "c1",
        jobKey: "rails-1",
        status: "completed",
        createdAtMs: 1000,
        updatedAtMs: 8000,
      }),
    );
    const report = await reconcileShardJobs({
      store,
      ...base,
      railsStates: [
        railsState({ jobKey: "rails-1", chainId: "c1" }),
        railsState({ jobKey: "rails-2", chainId: "c1", status: "failed", detail: "Rails job failed." }),
      ],
    });
    expect(report).toMatchObject({ checked: 2, reconciled: 1, alreadyCurrent: 1 });
    expect((await store.latestJob("primary", "c1", "rails-2"))?.version).toBe(1);
  });

  it("per-record failures are collected, never thrown", async () => {
    const inner = new InMemoryShardJobAdapter();
    await inner.recordJob(
      jobRow({ chainId: "c1", jobKey: "rails-1", status: "submitted" }),
    );
    const failing: ShardJobStore = {
      ...inner,
      recordJob: async (row: ShardJobRow) => {
        if (row.jobKey === "rails-1") throw new Error("write failed");
        return inner.recordJob(row);
      },
      latestJob: (t: string, c: string, k: string) => inner.latestJob(t, c, k),
      listJobsForChain: (t: string, c: string) => inner.listJobsForChain(t, c),
      listJobsByStatus: (t: string, s: any) => inner.listJobsByStatus(t, s),
    };
    const report = await reconcileShardJobs({
      store: failing,
      ...base,
      railsStates: [railsState({ jobKey: "rails-1", chainId: "c1" })],
    });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("rails-1");
  });
});

describe("job-history route (#1676)", () => {
  const session = { githubLogin: "owner", internalUserId: "u1" };

  it("401 unauthenticated; 405 non-GET; 400 without chainId", async () => {
    const readHistory = async () => [];
    expect(
      (
        await handleJobHistoryRoute({
          session: null,
          method: "GET",
          tenantId: "primary",
          chainId: "c1",
          readHistory,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await handleJobHistoryRoute({
          session,
          method: "POST",
          tenantId: "primary",
          chainId: "c1",
          readHistory,
        })
      ).status,
    ).toBe(405);
    expect(
      (
        await handleJobHistoryRoute({
          session,
          method: "GET",
          tenantId: "primary",
          chainId: "",
          readHistory,
        })
      ).status,
    ).toBe(400);
  });

  it("200 returns projection rows only, never DO fields", async () => {
    const res = await handleJobHistoryRoute({
      session,
      method: "GET",
      tenantId: "primary",
      chainId: "c1",
      readHistory: async () => [
        jobRow({ chainId: "c1", jobKey: "j1", version: 2, status: "completed" }),
      ],
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.chainId).toBe("c1");
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({
      jobKey: "j1",
      status: "completed",
      stage: "feed",
      capabilityId: "feed-dataprovider",
      version: 2,
    });
    expect(body.jobs[0]).not.toHaveProperty("tenantId");
  });

  it("500 on read failure, never a partial body", async () => {
    const res = await handleJobHistoryRoute({
      session,
      method: "GET",
      tenantId: "primary",
      chainId: "c1",
      readHistory: async () => {
        throw new Error("boom");
      },
    });
    expect(res.status).toBe(500);
  });
});

describe("jobs-reconcile route (#1676)", () => {
  const session = { githubLogin: "owner", internalUserId: "u1" };
  const report = { checked: 1, reconciled: 1, alreadyCurrent: 0, errors: [] };

  it("401 / 405 / 403 unwired / 403 non-admin", async () => {
    const runReconcile = async () => report;
    expect(
      (
        await handleReconcileJobsRoute({
          session: null,
          method: "POST",
          isPlatformAdmin: true,
          tenantId: "primary",
          runReconcile,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await handleReconcileJobsRoute({
          session,
          method: "GET",
          isPlatformAdmin: true,
          tenantId: "primary",
          runReconcile,
        })
      ).status,
    ).toBe(405);
    expect(
      (
        await handleReconcileJobsRoute({
          session: { githubLogin: "owner" },
          method: "POST",
          isPlatformAdmin: true,
          tenantId: "primary",
          runReconcile,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await handleReconcileJobsRoute({
          session,
          method: "POST",
          isPlatformAdmin: false,
          tenantId: "primary",
          runReconcile,
        })
      ).status,
    ).toBe(403);
  });

  it("200 returns the report for platform admins; 500 on failure", async () => {
    const ok = await handleReconcileJobsRoute({
      session,
      method: "POST",
      isPlatformAdmin: true,
      tenantId: "primary",
      runReconcile: async () => report,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ reconciled: 1 });
    const bad = await handleReconcileJobsRoute({
      session,
      method: "POST",
      isPlatformAdmin: true,
      tenantId: "primary",
      runReconcile: async () => {
        throw new Error("boom");
      },
    });
    expect(bad.status).toBe(500);
  });
});

describe("port purity (#1676, R1/R9)", () => {
  it("port and projection modules never import a store client or write SQL", () => {
    for (const file of ["shardJobPorts.ts", "shardJobProjection.ts"]) {
      const text = readFileSync(
        resolve(__dirname, "../src/data", file),
        "utf8",
      );
      expect(text).not.toMatch(/drizzle-orm/);
      expect(text).not.toMatch(/D1Database/);
      expect(text).not.toMatch(/env\.AGENT_DB/);
      expect(text).not.toMatch(/SELECT|INSERT INTO/);
    }
  });

  it("no projection writer accepts auth material of any kind", () => {
    const text = readFileSync(
      resolve(__dirname, "../src/data/shardJobPorts.ts"),
      "utf8",
    );
    expect(text).not.toMatch(/session|credential/i);
  });

  it("domain modules never import drizzle-orm", () => {
    for (const file of [
      "../src/agents/scheduled-agent.ts",
      "../src/mcps/openaimp/goalChainCommands.ts",
      "../src/agents/orchestrator/shardJobReconcile.ts",
    ]) {
      const text = readFileSync(resolve(__dirname, file), "utf8");
      expect(text).not.toMatch(/drizzle-orm/);
    }
  });
});

describe("executor capture via runChain (#1676)", () => {
  it("onLegOutcome receives completed + submitted legs, never skipped/unimplemented", async () => {
    const { compileGoal } = await import("../src/orchestrate");
    const { runChain } = await import("../src/mcps/openaimp/goalChainCommands");
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
      budgetCapCents: 10000,
    });
    expect(chain).not.toBeNull();
    const seen: any[] = [];
    const executeLeg = async (step: any) => {
      if (step.stage === "serve") {
        return {
          chainLegOutcome: "submitted",
          jobId: "rails-1",
          detail: "Submitted to the rails.",
          submission: { capability: "nlq.execute", payload: {} },
        };
      }
      return {
        chainId: "c1",
        shardJobIds: [`chain-exec:c1:${step.stage}:${step.id}`],
        result: { ok: true },
      };
    };
    const out = await runChain(chain!, {
      executeLeg,
      budgetCheck: async () => true,
      onLegOutcome: (leg: any) => {
        seen.push(leg);
      },
    });
    expect(out.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((l) => ["completed", "submitted"].includes(l.status))).toBe(true);
    expect(seen.some((l) => l.status === "submitted")).toBe(true);
    // Projecting exactly what the callback saw yields the rows.
    const store = new InMemoryShardJobAdapter();
    await projectLegOutcomes({
      store,
      tenantId: "primary",
      workspaceId: "primary",
      chainId: "c1",
      legs: seen,
      nowMs: 5000,
      writer: "scheduled-agent:test",
    });
    const jobs = await store.listJobsForChain("primary", "c1");
    expect(jobs.some((j) => j.jobKey === "rails-1" && j.status === "submitted")).toBe(true);
    expect(jobs.some((j) => j.jobKey.startsWith("chain-exec:") && j.status === "completed")).toBe(true);
  });

  it("a throwing callback never fails the run; a failed leg is reported, later legs are not", async () => {
    const { compileGoal } = await import("../src/orchestrate");
    const { runChain } = await import("../src/mcps/openaimp/goalChainCommands");
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
      budgetCapCents: 10000,
    });
    const seen: any[] = [];
    const out = await runChain(chain!, {
      executeLeg: async () => {
        throw new Error("boom");
      },
      budgetCheck: async () => true,
      onLegOutcome: (leg: any) => {
        seen.push(leg);
        throw new Error("projector down");
      },
    });
    expect(out.ok).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe("failed");
  });
});
