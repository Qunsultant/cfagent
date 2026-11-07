/**
 * Issue #3527 S5 — registration + surfacing for the two tick jobs
 * that S1–S4 left unobserved: the corpus sync and the reports
 * canonical-index sweep.
 *
 * Before S5 (characterization): the closed ScheduledJobId
 * vocabulary named only reflection/research/adaptation, neither
 * dispatch path was observed, neither rider was wrapped in
 * observeTickDispatch, and a run of either job — fired, skipped,
 * or failed — left NO record in the system: no
 * `scheduled_job.outcome` row in mas_events, no `mas_job_outcomes`
 * run row. The pins below assert the registered state:
 *
 * - the vocabulary and dispatch-path set grow by exactly the two
 *   jobs (the invariant is a closed, exact set — extended, not
 *   loosened);
 * - both queue.ts riders dispatch through observeTickDispatch
 *   under the new ids (a rejected dispatch now records a failure
 *   like the sibling jobs);
 * - each route records its summary outcome in the single
 *   mas_events sink from inside the route (the #2037 idiom):
 *   ran / skipped (guard reason) / failed (stable code);
 * - each ACTUAL run also records a mas_job_outcomes detail row
 *   (#1333) under a new kind ("corpus" / "reports") with the
 *   job's own per-item detail in deliveryStates (corpus:
 *   per-document integrity + index states by bucket key; sweep:
 *   page totals). A guard-skipped tick records NO run row —
 *   dispatch record only, the distinction the jobs' idiom draws;
 * - manual route invocations record with trigger "manual",
 *   background dispatches with "scheduled" (actor attribution);
 * - recording NEVER changes a route response: the S4 response
 *   shapes are pinned byte-for-byte in the characterization
 *   tests, and a context without an ORM degrades to no records,
 *   not to an error.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  SCHEDULED_JOB_OUTCOME_TYPE,
  buildScheduledJobOutcomePayload,
  isScheduledJobDispatchPath,
  isScheduledJobId,
  recordScheduledJobOutcome,
  type ScheduledJobOutcomeInput,
  type ScheduledJobOutcomeStore,
} from "../src/observability/scheduledJobOutcomes";
import { handleKnowledgeCorpusRoutes } from "../src/agents/routes/knowledgeCorpus";
import { handleReportsRoutes } from "../src/agents/routes/reports";
import {
  listJobOutcomes,
  recordJobOutcome,
} from "../src/services/jobOutcomes";
import { MockSqlStorage } from "./mock-sql";

const TRACE_ID = "0123456789abcdef0123456789abcdef";

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

/** mas_events stub behind the ORM events port shape the sink uses. */
function stubOrmEvents() {
  const created: Array<Record<string, any>> = [];
  return {
    created,
    outcomePayloads() {
      return created
        .filter((r) => r.type === SCHEDULED_JOB_OUTCOME_TYPE)
        .map((r) => r.payload as Record<string, any>);
    },
    events: {
      create: (row: Record<string, any>) => {
        created.push(row);
      },
      findMany: (options: { limit?: number }) =>
        [...created].reverse().slice(0, options.limit ?? created.length),
    },
  };
}

const JOB_OUTCOME_COLUMNS = [
  "id", "kind", "trigger", "status", "scanned", "matched", "coded_error",
  "report_url", "pdf_key", "xlsx_key", "csv_key", "delivery_json",
  "origin", "created_at",
] as const;

/**
 * Sql fake in the corpus_sync_p1169 / publish_stage_s4 style,
 * extended with a column-mapped mas_job_outcomes table so the
 * REAL #1333 adapter round-trips through it.
 */
function stubSql(options: { reportRows?: Array<Record<string, unknown>>; failReports?: boolean } = {}) {
  const settings = new Map<string, string>();
  const jobOutcomeRows = new Map<string, Record<string, unknown>>();
  const exec = (query: string, ...args: unknown[]) => {
    const q = String(query);
    if (q.includes("CREATE TABLE") || q.includes("CREATE INDEX")) return [];
    if (q.startsWith("SELECT value FROM mas_settings")) {
      const v = settings.get(String(args[0]));
      return v === undefined ? [] : [{ value: v }];
    }
    if (q.startsWith("DELETE FROM mas_settings")) {
      settings.delete(String(args[0]));
      return [];
    }
    if (q.startsWith("INSERT INTO mas_settings")) {
      settings.set(String(args[0]), String(args[1]));
      return [];
    }
    if (q.includes("mas_job_outcomes_meta")) {
      if (q.startsWith("SELECT")) return [];
      return [];
    }
    if (q.startsWith("INSERT OR REPLACE INTO mas_job_outcomes")) {
      const row: Record<string, unknown> = {};
      JOB_OUTCOME_COLUMNS.forEach((col, i) => {
        row[col] = args[i] ?? null;
      });
      jobOutcomeRows.set(String(args[0]), row);
      return [];
    }
    if (q.includes("FROM mas_job_outcomes")) {
      if (q.includes("COUNT(*)")) return [{ count: jobOutcomeRows.size }];
      if (q.includes("WHERE id = ?")) {
        const row = jobOutcomeRows.get(String(args[0]));
        return row ? [row] : [];
      }
      if (q.startsWith("DELETE")) return [];
      const rows = [...jobOutcomeRows.values()].sort((a, b) =>
        String(a.created_at) < String(b.created_at) ? 1 : -1
      );
      const limit = typeof args[args.length - 1] === "number" ? (args[args.length - 1] as number) : rows.length;
      return rows.slice(0, limit);
    }
    if (q.includes("FROM mas_reports")) {
      if (options.failReports) throw new Error("store gone");
      const rows = options.reportRows ?? [];
      const limit = typeof args[0] === "number" ? args[0] : 100;
      const offset = typeof args[1] === "number" ? args[1] : 0;
      return rows.slice(offset, offset + limit);
    }
    return [];
  };
  return { settings, jobOutcomeRows, exec: exec as any };
}

function stubRecordStore(records: Record<string, { contentHash: string }> = {}) {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return records[key] as T | undefined;
    },
    async put(): Promise<void> {
      throw new Error("stub store is read-only");
    },
  };
}

function stubR2Bucket(pages: Array<Array<{ key: string; bytes: Uint8Array }>>) {
  const flat = pages.flat();
  return {
    async list(options?: { prefix?: string; cursor?: string }) {
      const idx = options?.cursor ? Number(options.cursor) : 0;
      const page = pages[idx] ?? [];
      return {
        objects: page.map((o) => ({ key: o.key })),
        truncated: idx + 1 < pages.length,
        cursor: idx + 1 < pages.length ? String(idx + 1) : undefined,
      };
    },
    async get(key: string) {
      const found = flat.find((o) => o.key === key);
      if (!found) return null;
      return {
        async arrayBuffer() {
          return found.bytes.buffer.slice(
            found.bytes.byteOffset,
            found.bytes.byteOffset + found.bytes.byteLength
          ) as ArrayBuffer;
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* A. Registration: vocabulary, dispatch paths, tick wrap              */
/* ------------------------------------------------------------------ */

describe("A. registration (#3527 S5)", () => {
  it("the closed vocabulary names exactly the five tick jobs", () => {
    for (const job of ["reflection", "research", "adaptation", "corpus-sync", "reports-index-backfill"]) {
      expect(isScheduledJobId(job)).toBe(true);
    }
    expect(isScheduledJobId("digest")).toBe(false);
    expect(isScheduledJobId("corpus")).toBe(false);
    expect(isScheduledJobId("")).toBe(false);
  });

  it("both new dispatch paths are observed (POST only)", () => {
    expect(isScheduledJobDispatchPath("/knowledge/corpus-sync", "POST")).toBe(true);
    expect(isScheduledJobDispatchPath("/trading/reports/index-backfill-sweep", "POST")).toBe(true);
    expect(isScheduledJobDispatchPath("/knowledge/corpus-sync", "GET")).toBe(false);
    expect(isScheduledJobDispatchPath("/trading/reports/index-backfill-sweep", "GET")).toBe(false);
    // The paged manual backfill route is NOT a scheduled dispatch.
    expect(isScheduledJobDispatchPath("/trading/reports/index-backfill", "POST")).toBe(false);
  });

  it("payloads build for the new jobs with the tick linkage default", () => {
    const payload = buildScheduledJobOutcomePayload({
      job: "corpus-sync",
      outcome: "skipped",
      traceId: TRACE_ID,
      reason: "too-soon",
    });
    expect(payload.job).toBe("corpus-sync");
    expect(payload.outcome).toBe("skipped");
    expect(payload.reason).toBe("too-soon");
    expect(payload.traceId).toBe(TRACE_ID);
    expect(payload.linkage.trigger).toBe("worker-cron");
  });

  it("failure streaks + alerts extend to a new job unchanged", async () => {
    const rows: Array<{ job: string; outcome: string; createdAt: string }> = [];
    let seq = 0;
    const store: ScheduledJobOutcomeStore = {
      writeOutcome(input: ScheduledJobOutcomeInput) {
        seq += 1;
        rows.push({
          job: input.job,
          outcome: input.outcome,
          createdAt: `2026-11-06T00:00:${String(seq).padStart(2, "0")}.000Z`,
        });
      },
      recentOutcomes: () => [...rows],
    };
    const alert = vi.fn(async () => {});
    let last;
    for (let i = 0; i < 3; i += 1) {
      last = await recordScheduledJobOutcome(
        { store, alert, threshold: 3 },
        { job: "reports-index-backfill", outcome: "failed", traceId: TRACE_ID, errorCode: "reports_index_backfill_failed" }
      );
    }
    expect(last).toEqual({ recorded: true, streak: 3, alerted: true });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String(alert.mock.calls[0][0])).toContain("reports-index-backfill");
  });

  it("queue.ts wraps BOTH riders in observeTickDispatch under the new ids, corpus before sweep", () => {
    const queueSrc = readFileSync("src/server/routes/queue.ts", "utf8");
    expect(queueSrc).toMatch(/observeTickDispatch\(\s*"corpus-sync",/);
    expect(queueSrc).toMatch(/observeTickDispatch\(\s*"reports-index-backfill",/);
    expect(queueSrc.indexOf('"corpus-sync"')).toBeLessThan(
      queueSrc.indexOf('"reports-index-backfill"')
    );
  });
});

/* ------------------------------------------------------------------ */
/* B. Corpus sync route recording                                      */
/* ------------------------------------------------------------------ */

describe("B. corpus sync route recording (#3527 S5)", () => {
  const SERVICE_LOGIN = "svc-bot";

  function corpusCtx(overrides: Record<string, unknown> = {}) {
    const orm = stubOrmEvents();
    const sql = stubSql();
    const ctx = {
      env: { REPORTS_BUCKET: stubR2Bucket([[]]), SERVICE_USER_LOGIN: SERVICE_LOGIN },
      storage: stubRecordStore({}),
      userLogin: SERVICE_LOGIN,
      sql,
      getOrm: () => ({ events: orm.events }),
      ...overrides,
    };
    return { ctx, orm, sql };
  }

  function callSync(ctx: Record<string, unknown>, headers: Record<string, string> = {}) {
    return handleKnowledgeCorpusRoutes(
      new Request("https://agent.internal/knowledge/corpus-sync", { method: "POST", headers }),
      new URL("https://agent.internal/knowledge/corpus-sync"),
      "/knowledge/corpus-sync",
      "s1",
      ctx as any
    );
  }

  const backgroundHeaders = {
    "x-user-login": SERVICE_LOGIN,
    "x-actor-kind": "background",
  };

  it("characterization: the fired response shape is exactly the S4 shape", async () => {
    // No getOrm in ctx — today's context shape. This pin passes
    // before and after S5: registration must not change the
    // response the Corpus tab renders.
    const sql = stubSql();
    const res = await callSync({
      env: { REPORTS_BUCKET: stubR2Bucket([[]]) },
      storage: stubRecordStore({}),
      userLogin: "tester",
      sql,
    });
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["completed", "corpusIndex", "integrity", "ranAt", "success"].sort()
    );
    expect(body.success).toBe(true);
    expect(body.completed).toBe(true);
  });

  it("a fired run records the summary outcome AND the per-item run row (scheduled trigger)", async () => {
    const { ctx, orm, sql } = corpusCtx();
    const res = await callSync(ctx, backgroundHeaders);
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.completed).toBe(true);

    const outcomes = orm.outcomePayloads();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].job).toBe("corpus-sync");
    expect(outcomes[0].outcome).toBe("ran");

    const runs = listJobOutcomes(sql as any, 10);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.id).toBe(`corpus-sync:${body.ranAt}`);
    expect(run.kind).toBe("corpus");
    expect(run.origin).toBe("corpus-sync");
    expect(run.trigger).toBe("scheduled");
    expect(run.createdAt).toBe(body.ranAt);
    // The real seed manifest against an empty store/bucket: the
    // three hashed seeds are missing and one entry is not
    // ingested — findings make the run partial, never completed.
    expect(run.status).toBe("partial");
    expect(run.scanned).toBe(body.integrity.entries.length);
    expect(run.matched).toBe(
      body.integrity.entries.filter((e: any) => e.status === "present").length
    );
    for (const entry of body.integrity.entries) {
      if (entry.bucketKey) {
        expect(run.deliveryStates[`integrity:${entry.bucketKey}`]).toBe(entry.status);
      }
    }
    const manifestKeys = Object.keys(run.deliveryStates).filter((k) =>
      k.startsWith("integrity:manifest:")
    );
    expect(manifestKeys).toHaveLength(1);
    expect(run.deliveryStates[manifestKeys[0]]).toBe("not-ingested");
    // Per-item index states ride the same row, keyed by bucket key.
    for (const item of body.corpusIndex.items) {
      expect(run.deliveryStates[`index:${item.bucketKey}`]).toContain(item.state);
    }
  });

  it("a manual invocation records trigger manual", async () => {
    const { ctx, sql } = corpusCtx({ userLogin: "alice" });
    const res = await callSync(ctx, { "x-user-login": "alice" });
    expect(res!.status).toBe(200);
    const runs = listJobOutcomes(sql as any, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("manual");
  });

  it("a guard-skipped tick records the skip outcome and NO run row", async () => {
    const { ctx, orm, sql } = corpusCtx();
    const first = await callSync(ctx, backgroundHeaders);
    expect(first!.status).toBe(200);
    const second = await callSync(ctx, backgroundHeaders);
    const secondBody = (await second!.json()) as Record<string, any>;
    expect(secondBody.skipped).toBe(true);
    expect(secondBody.reason).toBe("too-soon");

    const outcomes = orm.outcomePayloads();
    expect(outcomes.map((o) => o.outcome)).toEqual(["ran", "skipped"]);
    expect(outcomes[1].job).toBe("corpus-sync");
    expect(outcomes[1].reason).toBe("too-soon");
    expect(listJobOutcomes(sql as any, 10)).toHaveLength(1);
  });

  it("a run whose integrity leg cannot execute records failed + the stable code in both stores", async () => {
    const { ctx, orm, sql } = corpusCtx({
      env: { SERVICE_USER_LOGIN: SERVICE_LOGIN },
    });
    const res = await callSync(ctx, backgroundHeaders);
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.completed).toBe(false);

    const outcomes = orm.outcomePayloads();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].outcome).toBe("failed");
    expect(outcomes[0].errorCode).toBe("corpus_sync_incomplete");

    const runs = listJobOutcomes(sql as any, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].codedError).toBe("corpus_sync_incomplete");
  });

  it("a context without an ORM records nothing and still answers (never-fail invariant)", async () => {
    const sql = stubSql();
    const res = await callSync(
      {
        env: { REPORTS_BUCKET: stubR2Bucket([[]]) },
        storage: stubRecordStore({}),
        userLogin: "tester",
        sql,
      },
      backgroundHeaders
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    // The detail row needs only sql, which IS present.
    expect(listJobOutcomes(sql as any, 10)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* C. Reports sweep route recording                                    */
/* ------------------------------------------------------------------ */

describe("C. reports sweep route recording (#3527 S5)", () => {
  const reportRows = [
    { id: "r1", title: "t1", source: "research_report", summary: "s", body: "", body_r2_key: null },
    { id: "r2", title: "t2", source: "retention", summary: "", body: "", body_r2_key: null },
    { id: "r3", title: "t3", source: "screener", summary: "s", body: "", body_r2_key: null },
  ];
  const stubIndexEnv = {
    AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
    VECTOR_MEMORY: { upsert: async () => {} },
  };

  function callSweep(ctx: Record<string, unknown>, headers: Record<string, string> = { "x-user-login": "tester" }) {
    return handleReportsRoutes(
      new Request("https://agent.internal/trading/reports/index-backfill-sweep", {
        method: "POST",
        headers,
      }),
      new URL("https://agent.internal/trading/reports/index-backfill-sweep"),
      "/trading/reports/index-backfill-sweep",
      "sess",
      ctx as any
    );
  }

  it("characterization: the fired response shape is exactly the S4 shape", async () => {
    const sql = stubSql({ reportRows });
    const res = await callSweep({ ensureTables: () => sql, env: stubIndexEnv });
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.upserted).toBe(2);
    expect(body.skippedRetention).toBe(1);
    expect(body.rows).toBe(3);
    expect(body.pages).toBe(1);
    expect(body.complete).toBe(true);
    expect(typeof body.ranAt).toBe("string");
  });

  it("a fired sweep records the summary outcome AND the totals run row", async () => {
    const orm = stubOrmEvents();
    const sql = stubSql({ reportRows });
    const res = await callSweep({
      ensureTables: () => sql,
      env: { ...stubIndexEnv, SERVICE_USER_LOGIN: "svc-bot" },
      getOrm: () => ({ events: orm.events }),
    }, { "x-user-login": "svc-bot", "x-actor-kind": "background" });
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, any>;

    const outcomes = orm.outcomePayloads();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].job).toBe("reports-index-backfill");
    expect(outcomes[0].outcome).toBe("ran");

    const runs = listJobOutcomes(sql as any, 10);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.id).toBe(`reports-index-backfill:${body.ranAt}`);
    expect(run.kind).toBe("reports");
    expect(run.origin).toBe("reports-index-backfill");
    expect(run.trigger).toBe("scheduled");
    expect(run.status).toBe("completed");
    expect(run.scanned).toBe(3);
    expect(run.matched).toBe(2);
    expect(run.deliveryStates).toEqual({
      pages: "1",
      upserted: "2",
      skippedRetention: "1",
    });
    expect(run.createdAt).toBe(body.ranAt);
  });

  it("a guard-skipped sweep records the skip outcome and NO run row", async () => {
    const orm = stubOrmEvents();
    const sql = stubSql({ reportRows });
    const ctx = {
      ensureTables: () => sql,
      env: stubIndexEnv,
      getOrm: () => ({ events: orm.events }),
    };
    const first = await callSweep(ctx);
    expect(first!.status).toBe(200);
    const second = await callSweep(ctx);
    const secondBody = (await second!.json()) as Record<string, any>;
    expect(secondBody.skipped).toBe(true);
    expect(secondBody.reason).toBe("too-soon");

    const outcomes = orm.outcomePayloads();
    expect(outcomes.map((o) => o.outcome)).toEqual(["ran", "skipped"]);
    expect(outcomes[1].job).toBe("reports-index-backfill");
    expect(outcomes[1].reason).toBe("too-soon");
    expect(listJobOutcomes(sql as any, 10)).toHaveLength(1);
  });

  it("a throwing sweep records failed in both stores and still answers 500 with no marker", async () => {
    const orm = stubOrmEvents();
    const sql = stubSql({ reportRows, failReports: true });
    const res = await callSweep({
      ensureTables: () => sql,
      env: stubIndexEnv,
      getOrm: () => ({ events: orm.events }),
    });
    expect(res!.status).toBe(500);
    expect(sql.settings.has("reports_index_backfill_last_run")).toBe(false);

    const outcomes = orm.outcomePayloads();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].job).toBe("reports-index-backfill");
    expect(outcomes[0].outcome).toBe("failed");
    expect(outcomes[0].errorCode).toBe("reports_index_backfill_failed");

    const runs = listJobOutcomes(sql as any, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].codedError).toBe("reports_index_backfill_failed");
  });
});

/* ------------------------------------------------------------------ */
/* D. Job-outcome kinds + feed labels                                  */
/* ------------------------------------------------------------------ */

describe("D. job-outcome kind extension (#3527 S5)", () => {
  it("the #1333 sink round-trips the two new kinds", () => {
    const sql = new MockSqlStorage();
    recordJobOutcome(sql as any, {
      id: "corpus-sync:2026-11-06T00:00:00.000Z",
      kind: "corpus" as any,
      trigger: "scheduled",
      status: "partial",
      origin: "corpus-sync",
    });
    recordJobOutcome(sql as any, {
      id: "reports-index-backfill:2026-11-06T00:00:00.000Z",
      kind: "reports" as any,
      trigger: "scheduled",
      status: "completed",
      origin: "reports-index-backfill",
    });
    const rows = listJobOutcomes(sql as any, 10);
    expect(rows.map((r) => r.kind).sort()).toEqual(["corpus", "reports"]);
  });

  it("the Autopilot job feed labels the new kinds", () => {
    const src = readFileSync("src/client/components/AutopilotControlCenter.tsx", "utf8");
    expect(src).toContain('corpus: "Corpus Sync"');
    expect(src).toContain('reports: "Reports Index"');
  });
});
