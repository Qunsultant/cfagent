// @vitest-environment node
/**
 * Issue #2347 (#1976 step 3c, ADR 0022 D-C.3 / D-F2) — NEW
 * CONTRACT pins for the canonical report fan-out. Unlike the
 * characterization file (as-found behaviour, green before and
 * after), these pins encode the DISCLOSED behaviour changes
 * and were RED against the pre-change code:
 *
 *  1. Recorded outcomes: every store through the one seam
 *     records a CanonicalReportFanoutOutcome on the report
 *     record (fanout_outcome) with a catalogued code
 *     (DataFoundationCode REPORT_FANOUT_STORED / _DEGRADED);
 *     the store result surfaces the outcome too.
 *  2. Per-leg fault injection: R2 put throws -> body
 *     inline_fallback + DEGRADED, row complete inline;
 *     Vectorize throws -> vectorize "failed" + DEGRADED, row
 *     intact; AI Search upload throws -> aiSearch "failed"
 *     with aiSearchCode "upload_failed" + DEGRADED; row
 *     INSERT throws -> null result, no row, no outcome record
 *     (the REPORT_FANOUT_FAILED member: nothing to record on).
 *  3. Not-attempted is distinguished from failed: no bindings
 *     -> vectorize "not_attempted"; #2246 flag OFF -> aiSearch
 *     "not_attempted" AND zero instance calls (flag discipline
 *     preserved exactly); flag ON + configured -> "indexed".
 *  4. Ordering: the R2 put still precedes the insert, and the
 *     recorded outcome at insert time already names the body
 *     leg (stored_r2 / body "r2") — a row never claims a body
 *     it does not have: a failed put records inline_fallback
 *     with the body inline, never stored_r2.
 *  5. Seam parity (the retired divergent seam): exactly ONE
 *     INSERT INTO mas_reports exists in src/ (the shared
 *     insertScheduledReportRow, carrying body_r2_key +
 *     fanout_outcome); persistScheduledReportSql delegates to
 *     the canonical seam (deprecated, successor named) — its
 *     callers now get dedupe + the recorded outcome.
 *  6. Dedupe outcome: a redelivery records outcome "deduped"
 *     and re-fires the legs (their settled statuses land on
 *     the record).
 *
 * DOUBLES: node:sqlite-backed SqlStorage (real semantics).
 *
 * #CDO-mha7
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/actors/thinkAdapter", () => ({
  PortThink: class MockPortThink {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import {
  getCanonicalReport,
  getCanonicalReportFanoutOutcome,
  persistScheduledReportSql,
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
  type ScheduledReportInput,
} from "../src/services/scheduledReports";
import { DataFoundationCode } from "../src/aspects/errorCodes";
import type { SqlStorage } from "../src/orm";

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  failInserts = false;
  exec(query: string, ...params: unknown[]): unknown[] {
    if (this.failInserts && /^\s*INSERT\s+INTO\s+mas_reports/i.test(query)) {
      throw new Error("simulated insert failure");
    }
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

const flush = async () => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

function input(over: Partial<ScheduledReportInput> = {}): ScheduledReportInput {
  return {
    runId: "screener:2026-10-29T01:00:00Z",
    generationId: "gen-3c-contract",
    title: "Fan-out contract report",
    source: "screener",
    summary: "Scanned 10 symbols, 2 matched.",
    body: { opportunities: [{ symbol: "NVDA", structure: "call spread" }] },
    createdAt: "2026-10-29T01:00:00.000Z",
    userLogin: "tenant@example.com",
    ...over,
  };
}

function rowCount(sql: SqliteTestStorage): number {
  return (sql.exec(`SELECT id FROM mas_reports`) as unknown[]).length;
}

function makeVectorEnv(opts: { failUpsert?: boolean } = {}) {
  const upserts: Array<{ id: string }> = [];
  return {
    upserts,
    env: {
      AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
      VECTOR_MEMORY: {
        upsert: async (vectors: Array<{ id: string }>) => {
          if (opts.failUpsert) throw new Error("vectorize upsert boom");
          upserts.push(...vectors);
        },
      },
    },
  };
}

function makeAiSearchEnv(opts: { flag?: string; failUpload?: boolean } = {}) {
  const uploads: Array<{ name: string }> = [];
  const instance = {
    items: {
      upload: async (name: string) => {
        uploads.push({ name });
        if (opts.failUpload) throw new Error("instance items API unavailable");
        return { id: "item-1", key: name, status: "queued" };
      },
    },
  };
  return {
    uploads,
    env: {
      AI_SEARCH: { get: (_name: string) => instance },
      AI_SEARCH_INSTANCE: "test-instance",
      ...(opts.flag ? { AI_SEARCH_REPORT_INDEXING_ENABLED: opts.flag } : {}),
    } as Record<string, unknown>,
  };
}

function makeBucket(opts: { failPut?: boolean } = {}) {
  const objects = new Map<string, string>();
  return {
    objects,
    bucket: {
      put: async (key: string, value: string) => {
        if (opts.failPut) throw new Error("r2 put boom");
        objects.set(key, String(value));
      },
      get: async (key: string) => {
        const v = objects.get(key);
        return v === undefined ? null : { text: async () => v };
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    },
  };
}

describe("3c contract: recorded outcomes on the successful path", () => {
  it("sync seam, no env: stored_inline / STORED, both legs not_attempted (aiSearch after settle)", async () => {
    const sql = new SqliteTestStorage();
    const stored = storeReportAtGeneration(sql as unknown as SqlStorage, input());
    expect(stored?.fanout.outcome).toBe("stored_inline");
    expect(stored?.fanout.body).toBe("inline");
    expect(stored?.fanout.vectorize).toBe("not_attempted");
    await flush();
    const recorded = getCanonicalReportFanoutOutcome(
      sql as unknown as SqlStorage,
      stored!.reportId,
    );
    expect(recorded).toEqual({
      outcome: "stored_inline",
      code: DataFoundationCode.REPORT_FANOUT_STORED,
      body: "inline",
      vectorize: "not_attempted",
      aiSearch: "not_attempted",
      aiSearchCode: "disabled",
    });
    const hit = getCanonicalReport(sql as unknown as SqlStorage, stored!.reportId);
    expect(hit?.fanoutOutcome).toEqual(recorded);
  });

  it("R2 seam: stored_r2 / body r2 recorded; Vectorize indexed after settle", async () => {
    const sql = new SqliteTestStorage();
    const { bucket } = makeBucket();
    const { env, upserts } = makeVectorEnv();
    const stored = await storeReportAtGenerationWithR2(
      sql as unknown as SqlStorage,
      { REPORTS_BUCKET: bucket, ...env } as never,
      input(),
    );
    expect(stored?.fanout.outcome).toBe("stored_r2");
    expect(stored?.fanout.code).toBe(DataFoundationCode.REPORT_FANOUT_STORED);
    await flush();
    expect(upserts).toHaveLength(1);
    const recorded = getCanonicalReportFanoutOutcome(
      sql as unknown as SqlStorage,
      stored!.reportId,
    );
    expect(recorded?.body).toBe("r2");
    expect(recorded?.vectorize).toBe("indexed");
    expect(recorded?.code).toBe(DataFoundationCode.REPORT_FANOUT_STORED);
  });

  it("AI Search flag ON + configured: aiSearch indexed after settle", async () => {
    const sql = new SqliteTestStorage();
    const ai = makeAiSearchEnv({ flag: "true" });
    const stored = storeReportAtGeneration(
      sql as unknown as SqlStorage,
      input(),
      ai.env as never,
    );
    await flush();
    expect(ai.uploads).toHaveLength(1);
    const recorded = getCanonicalReportFanoutOutcome(
      sql as unknown as SqlStorage,
      stored!.reportId,
    );
    expect(recorded?.aiSearch).toBe("indexed");
    expect(recorded?.code).toBe(DataFoundationCode.REPORT_FANOUT_STORED);
  });
});

describe("3c contract: per-leg fault injection produces the declared recorded outcome", () => {
  it("R2 put throws -> stored_inline_fallback + DEGRADED, body complete inline, never stored_r2", async () => {
    const sql = new SqliteTestStorage();
    const { bucket } = makeBucket({ failPut: true });
    const stored = await storeReportAtGenerationWithR2(
      sql as unknown as SqlStorage,
      { REPORTS_BUCKET: bucket } as never,
      input(),
    );
    expect(stored?.created).toBe(true);
    expect(stored?.fanout.outcome).toBe("stored_inline_fallback");
    expect(stored?.fanout.body).toBe("inline_fallback");
    expect(stored?.fanout.code).toBe(DataFoundationCode.REPORT_FANOUT_DEGRADED);
    await flush();
    const recorded = getCanonicalReportFanoutOutcome(
      sql as unknown as SqlStorage,
      stored!.reportId,
    );
    expect(recorded?.outcome).toBe("stored_inline_fallback");
    expect(recorded?.code).toBe(DataFoundationCode.REPORT_FANOUT_DEGRADED);
    const hit = getCanonicalReport(sql as unknown as SqlStorage, stored!.reportId);
    expect(hit?.bodyR2Key).toBeNull();
    expect(hit?.body).toContain("NVDA");
  });

  it("Vectorize throws -> vectorize failed + DEGRADED, row intact", async () => {
    const sql = new SqliteTestStorage();
    const { env } = makeVectorEnv({ failUpsert: true });
    const stored = storeReportAtGeneration(
      sql as unknown as SqlStorage,
      input(),
      env as never,
    );
    expect(stored?.created).toBe(true);
    await flush();
    const recorded = getCanonicalReportFanoutOutcome(
      sql as unknown as SqlStorage,
      stored!.reportId,
    );
    expect(recorded?.vectorize).toBe("failed");
    expect(recorded?.code).toBe(DataFoundationCode.REPORT_FANOUT_DEGRADED);
    expect(getCanonicalReport(sql as unknown as SqlStorage, stored!.reportId)?.body).toContain("NVDA");
  });

  it("AI Search upload throws -> aiSearch failed with aiSearchCode upload_failed + DEGRADED", async () => {
    const sql = new SqliteTestStorage();
    const ai = makeAiSearchEnv({ flag: "on", failUpload: true });
    const stored = storeReportAtGeneration(
      sql as unknown as SqlStorage,
      input(),
      ai.env as never,
    );
    await flush();
    const recorded = getCanonicalReportFanoutOutcome(
      sql as unknown as SqlStorage,
      stored!.reportId,
    );
    expect(recorded?.aiSearch).toBe("failed");
    expect(recorded?.aiSearchCode).toBe("upload_failed");
    expect(recorded?.code).toBe(DataFoundationCode.REPORT_FANOUT_DEGRADED);
  });

  it("AI Search flag ON but instance unconfigured -> aiSearch failed (not_configured), never a fabricated indexed", async () => {
    const sql = new SqliteTestStorage();
    const stored = storeReportAtGeneration(
      sql as unknown as SqlStorage,
      input(),
      { AI_SEARCH_REPORT_INDEXING_ENABLED: "true" } as never,
    );
    await flush();
    const recorded = getCanonicalReportFanoutOutcome(
      sql as unknown as SqlStorage,
      stored!.reportId,
    );
    expect(recorded?.aiSearch).toBe("failed");
    expect(recorded?.aiSearchCode).toBe("not_configured");
    expect(recorded?.code).toBe(DataFoundationCode.REPORT_FANOUT_DEGRADED);
  });

  it("row INSERT throws -> null result, no row, no outcome record (REPORT_FANOUT_FAILED member)", async () => {
    const sql = new SqliteTestStorage();
    sql.failInserts = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stored = storeReportAtGeneration(sql as unknown as SqlStorage, input());
      expect(stored).toBeNull();
      expect(rowCount(sql)).toBe(0);
      const logged = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(logged).toContain(DataFoundationCode.REPORT_FANOUT_FAILED);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("flag OFF: zero instance calls AND aiSearch recorded not_attempted (not failed)", async () => {
    const sql = new SqliteTestStorage();
    const ai = makeAiSearchEnv(); // no flag -> OFF
    const stored = storeReportAtGeneration(
      sql as unknown as SqlStorage,
      input(),
      ai.env as never,
    );
    await flush();
    expect(ai.uploads).toHaveLength(0);
    const recorded = getCanonicalReportFanoutOutcome(
      sql as unknown as SqlStorage,
      stored!.reportId,
    );
    expect(recorded?.aiSearch).toBe("not_attempted");
    expect(recorded?.code).toBe(DataFoundationCode.REPORT_FANOUT_STORED);
  });
});

describe("3c contract: dedupe + the retired divergent seam", () => {
  it("redelivery records outcome deduped and the re-fired legs settle on the record", async () => {
    const sql = new SqliteTestStorage();
    const { env, upserts } = makeVectorEnv();
    const first = storeReportAtGeneration(
      sql as unknown as SqlStorage,
      input(),
      env as never,
    );
    await flush();
    const second = storeReportAtGeneration(
      sql as unknown as SqlStorage,
      input(),
      env as never,
    );
    expect(second?.created).toBe(false);
    expect(second?.fanout.outcome).toBe("deduped");
    await flush();
    expect(rowCount(sql)).toBe(1);
    expect(upserts).toHaveLength(2); // legs re-fired on redelivery
    const recorded = getCanonicalReportFanoutOutcome(
      sql as unknown as SqlStorage,
      first!.reportId,
    );
    expect(recorded?.outcome).toBe("deduped");
    expect(recorded?.vectorize).toBe("indexed");
  });

  it("persistScheduledReportSql now dedupes and records the full-contract outcome", async () => {
    const sql = new SqliteTestStorage();
    const a = persistScheduledReportSql(sql as unknown as SqlStorage, input());
    const b = persistScheduledReportSql(sql as unknown as SqlStorage, input());
    expect(a).toBeTruthy();
    expect(b).toBe(a); // deduped through the canonical seam
    expect(rowCount(sql)).toBe(1);
    await flush();
    const recorded = getCanonicalReportFanoutOutcome(sql as unknown as SqlStorage, a!);
    expect(recorded?.outcome).toBe("deduped");
    expect(recorded?.body).toBe("inline");
    expect(recorded?.vectorize).toBe("not_attempted");
    expect(recorded?.aiSearch).toBe("not_attempted");
  });

  it("persistScheduledReportSql first store records stored_inline (not the old silent lesser shape)", async () => {
    const sql = new SqliteTestStorage();
    const id = persistScheduledReportSql(
      sql as unknown as SqlStorage,
      input({ generationId: undefined }),
    );
    expect(id).toBeTruthy();
    await flush();
    const recorded = getCanonicalReportFanoutOutcome(sql as unknown as SqlStorage, id!);
    expect(recorded?.outcome).toBe("stored_inline");
    expect(recorded?.code).toBe(DataFoundationCode.REPORT_FANOUT_STORED);
  });
});

describe("3c contract: seam-parity source pins", () => {
  const scheduledSrc = readFileSync("src/services/scheduledReports.ts", "utf8");

  it("exactly one INSERT INTO mas_reports exists in src/, in the shared insert helper, carrying body_r2_key + fanout_outcome", () => {
    // ADAPTED for #2359 (#1976 step 4d, §7 — in-file
    // justification): the seam's statements moved behind the
    // canonical-report WRITE port, completing this contract's
    // deferred half. The invariant this pin exists for is
    // unchanged — exactly ONE INSERT INTO mas_reports in src/,
    // in the ONE shared insert path, carrying body_r2_key +
    // fanout_outcome — its home is now the write port's DO
    // adapter (insertRow), and the seam itself holds none.
    const adapterSrc = readFileSync(
      "src/data/doSqliteCanonicalReportStoreAdapter.ts",
      "utf8"
    );
    const files = [
      "src/services/scheduledReports.ts",
      "src/data/ormFacade.ts",
      "src/data/doSqliteOrmAdapters.ts",
      "src/data/ormRepositoryCore.ts",
      "src/data/doSqliteCanonicalReportStoreAdapter.ts",
    ];
    let total = 0;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      total += (text.match(/INSERT INTO (?:\$\{TABLE\}|\$\{SCHEDULED_REPORTS_TABLE\}|mas_reports)/g) ?? []).length;
    }
    expect(total).toBe(1);
    expect(
      (scheduledSrc.match(/INSERT INTO \$\{SCHEDULED_REPORTS_TABLE\}/g) ?? []).length,
    ).toBe(0);
    const insertStart = adapterSrc.indexOf("INSERT INTO ${TABLE}");
    expect(insertStart).toBeGreaterThan(-1);
    const insertText = adapterSrc.slice(insertStart, insertStart + 400);
    expect(insertText).toContain("body_r2_key");
    expect(insertText).toContain("fanout_outcome");
  });

  it("persistScheduledReportSql delegates to the seam and is deprecated with its successor named", () => {
    const start = scheduledSrc.indexOf("export function persistScheduledReportSql");
    expect(start).toBeGreaterThan(-1);
    const body = scheduledSrc.slice(start, start + 900);
    expect(body).toContain("storeReportAtGeneration(sql, input)");
    expect(body).not.toContain("INSERT INTO");
    const docStart = scheduledSrc.lastIndexOf("/**", start);
    const doc = scheduledSrc.slice(docStart, start);
    expect(doc).toContain("@deprecated");
    expect(doc).toContain("storeReportAtGeneration");
  });

  it("no index leg is fired with a discarded (bare void) result anymore", () => {
    // ADAPTED for #3527 S1 (§7 — in-file justification): the
    // leg invocations moved out of the seam into the publish
    // stage (src/services/documentPublish.ts); the seam's
    // fireFanoutIndexLegs now delegates to publishDocument and
    // records from the stage's per-target settled outcomes.
    // The invariant this pin exists for is unchanged — every
    // leg invocation's result is consumed by a recording path
    // and none is discarded — asserted at its new homes: the
    // seam holds NO leg invocation at all, the stage turns
    // every invocation into a settled outcome, and the seam
    // records those outcomes via recordFanoutLegOutcome.
    const stageSrc = readFileSync("src/services/documentPublish.ts", "utf8");
    expect(scheduledSrc).not.toMatch(/void indexCanonicalReport/);
    expect(scheduledSrc).not.toContain("indexCanonicalReport(");
    expect(scheduledSrc).not.toContain("indexCanonicalReportInAiSearch(");
    expect(scheduledSrc).toContain("publishDocument(");
    expect(scheduledSrc).toContain("fireFanoutIndexLegs(");
    expect(scheduledSrc).toContain("recordFanoutLegOutcome(");
    // The stage discards nothing either: no bare-void call
    // expression exists in it, and both default executors are
    // wired as the stage's legs.
    expect(stageSrc).not.toMatch(/void\s+\w+\(/);
    expect(stageSrc).toContain("indexCanonicalReport");
    expect(stageSrc).toContain("indexCanonicalReportInAiSearch");
  });

  it("the outcome codes live in the catalog, not as inline strings in the seam", () => {
    const catalog = readFileSync("src/aspects/errorCodes.ts", "utf8");
    expect(catalog).toContain("REPORT_FANOUT_STORED");
    expect(catalog).toContain("REPORT_FANOUT_DEGRADED");
    expect(catalog).toContain("REPORT_FANOUT_FAILED");
    expect(scheduledSrc).not.toContain('"DATA_REPORT_FANOUT');
  });
});
