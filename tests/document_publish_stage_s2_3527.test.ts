// @vitest-environment node
/**
 * Issue #3527 S2 — NEW pins for the publish stage's R2 body
 * leg (src/services/documentPublish.ts) and for the
 * storeReportAtGenerationWithR2 seam delegation. S1 put the
 * two report INDEX legs behind publishDocument; the canonical
 * body put stayed inline in the WithR2 seam, so "which
 * publish happens" was still a property of which store
 * function the caller picked. S2 makes the body put the
 * stage's third target.
 *
 * Part A (stage contract) — RED before S2 (no r2-body target,
 * no target selection existed):
 *  - the r2-body target runs ONLY when requested; the
 *    default call keeps the exact S1 handle shape
 *    (vectorize, ai-search) and never touches a bound bucket;
 *  - requested + bucket bound: one put through the REAL
 *    BlobStore port chain (stage -> createBlobStore -> R2
 *    adapter) with the pre-stage key (`reports/<id>.json`),
 *    the document body bytes verbatim, and httpMetadata
 *    contentType "application/json" — the exact put the seam
 *    performed inline;
 *  - requested + bucket unbound: `not_configured`, the put
 *    executor never invoked (mirrors the Vectorize target's
 *    precomputed attempted-ness — unbound is NOT a failure);
 *  - put throws/rejects: `failed` carrying the error's
 *    message (the seam's recorded-fallback log line quotes
 *    it); the stage never throws;
 *  - the put executor is injectable via deps and receives
 *    (store, key, body) — the store resolved from the env,
 *    the key derived from the document id by the stage's
 *    reportBodyR2Key (whose definition moves here from the
 *    seam; the seam re-exports it);
 *  - handles come back in canonical target order
 *    (r2-body, vectorize, ai-search) regardless of request
 *    order, and each target still settles independently.
 *
 * Part B (seam equivalence) — green before AND after S2;
 * these pin the #2347 observable contract the migration
 * must not move:
 *  - fresh WithR2 store: fanout_outcome byte-identical
 *    (stored_r2 / r2 / STORED), row carries the pointer and
 *    an empty inline body, exactly one put with identical
 *    key/bytes/contentType, and the put still PRECEDES the
 *    insert (a row never claims a body it does not have);
 *  - put failure: stored_inline_fallback / inline_fallback /
 *    DEGRADED, the seam's exact fallback log line, the row
 *    complete inline;
 *  - bucket unbound: plain stored_inline / inline / STORED
 *    (NOT the fallback, NOT degraded);
 *  - the non-R2 seam performs no put even when a bucket is
 *    present in its env (it did not request the body leg);
 *  - dedupe never rewrites the R2 object;
 *  - a put that succeeds while the INSERT fails strands the
 *    object and returns null (today's behaviour — pinned,
 *    not "fixed").
 *
 * DOUBLES: node:sqlite-backed SqlStorage (real semantics),
 * recording fake R2 buckets.
 *
 * #CDO-mha7
 */
import { DatabaseSync } from "node:sqlite";
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
  publishDocument,
  reportBodyR2Key,
  type PublishDeps,
  type PublishDocumentInput,
  type PublishTargetOutcome,
} from "../src/services/documentPublish";
import {
  getCanonicalReport,
  getCanonicalReportFanoutOutcome,
  reportBodyR2Key as seamReportBodyR2Key,
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
  type ScheduledReportInput,
} from "../src/services/scheduledReports";
import { DataFoundationCode } from "../src/aspects/errorCodes";
import type { SqlStorage } from "../src/orm";

const DOC: PublishDocumentInput = {
  kind: "report",
  documentId: "rep-3527-s2-1",
  title: "Publish stage S2 report",
  source: "screener",
  summary: "Scanned 10 symbols, 2 matched.",
  body: JSON.stringify({
    opportunities: [{ symbol: "NVDA", structure: "call spread" }],
  }),
  bodyR2Key: null,
  runId: "screener:2026-11-06T00:00:00Z",
  ownerLogin: "tenant@example.com",
  storedAt: "2026-11-06T00:00:00.000Z",
};

function targetOf(
  outcomes: PublishTargetOutcome[],
  target: string,
): PublishTargetOutcome {
  const found = outcomes.find((t) => t.target === target);
  if (!found) throw new Error(`no outcome for target ${target}`);
  return found;
}

interface PutCall {
  key: string;
  value: string;
  contentType?: string;
}

/** A raw R2Bucket double that records what the BlobStore adapter sends it. */
function makeRecordingBucket(opts: { failPut?: boolean } = {}) {
  const calls: PutCall[] = [];
  const objects = new Map<string, string>();
  const bucket = {
    put: async (
      key: string,
      value: unknown,
      options?: { httpMetadata?: { contentType?: string } },
    ) => {
      calls.push({
        key,
        value: String(value),
        contentType: options?.httpMetadata?.contentType,
      });
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
  };
  return { calls, objects, bucket };
}

describe("3527 S2 stage: r2-body target", () => {
  it("reportBodyR2Key lives in the stage and the seam re-exports the same function", () => {
    expect(reportBodyR2Key("rep-123")).toBe("reports/rep-123.json");
    expect(seamReportBodyR2Key).toBe(reportBodyR2Key);
  });

  it("requested + bucket bound: exactly the pre-stage put (key, bytes, contentType) through the real port chain", async () => {
    const { calls, objects, bucket } = makeRecordingBucket();
    const indexVec = vi.fn(async () => true);
    const indexAi = vi.fn(async () => ({
      ok: false,
      code: "disabled",
      correlationId: "c-s2",
    }));
    const deps: PublishDeps = {
      indexCanonicalReport: indexVec as never,
      indexCanonicalReportInAiSearch: indexAi as never,
    };
    const handle = publishDocument(
      { REPORTS_BUCKET: bucket } as never,
      DOC,
      deps,
      { targets: ["r2-body"] },
    );
    expect(handle.targets.map((t) => t.target)).toEqual(["r2-body"]);
    const outcome = await handle.settled;
    expect(targetOf(outcome.targets, "r2-body")).toEqual({
      target: "r2-body",
      status: "published",
    });
    expect(calls).toEqual([
      {
        key: "reports/rep-3527-s2-1.json",
        value: DOC.body,
        contentType: "application/json",
      },
    ]);
    expect(objects.get("reports/rep-3527-s2-1.json")).toBe(DOC.body);
    // Only the requested target ran.
    expect(indexVec).not.toHaveBeenCalled();
    expect(indexAi).not.toHaveBeenCalled();
  });

  it("not requested (default call): S1 handle shape unchanged and a bound bucket is never touched", async () => {
    const { calls, bucket } = makeRecordingBucket();
    const deps: PublishDeps = {
      indexCanonicalReport: async () => true,
      indexCanonicalReportInAiSearch: async () => ({
        ok: false,
        code: "disabled",
        correlationId: "c-s2",
      }),
    };
    const env = {
      REPORTS_BUCKET: bucket,
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
      VECTOR_MEMORY: { upsert: async () => {} },
    } as never;
    const handle = publishDocument(env, DOC, deps);
    expect(handle.targets.map((t) => t.target)).toEqual([
      "vectorize",
      "ai-search",
    ]);
    const outcome = await handle.settled;
    expect(outcome.targets.map((t) => t.target)).toEqual([
      "vectorize",
      "ai-search",
    ]);
    expect(calls).toHaveLength(0);
  });

  it("requested + bucket unbound: not_configured, the put executor never invoked", async () => {
    const putSpy = vi.fn(
      async (_store: unknown, _key: string, _body: string) => {},
    );
    const deps: PublishDeps = { putReportBody: putSpy as never };
    for (const env of [undefined, {} as never]) {
      const outcome = await publishDocument(env, DOC, deps, {
        targets: ["r2-body"],
      }).settled;
      expect(targetOf(outcome.targets, "r2-body")).toEqual({
        target: "r2-body",
        status: "not_configured",
      });
    }
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("put rejects: failed carrying the error message; the stage never throws", async () => {
    const { bucket } = makeRecordingBucket({ failPut: true });
    let handle!: ReturnType<typeof publishDocument>;
    expect(() => {
      handle = publishDocument({ REPORTS_BUCKET: bucket } as never, DOC, {}, {
        targets: ["r2-body"],
      });
    }).not.toThrow();
    const outcome = await handle.settled;
    expect(targetOf(outcome.targets, "r2-body")).toEqual({
      target: "r2-body",
      status: "failed",
      error: "r2 put boom",
    });
  });

  it("injected put executor receives (store, key, body): key from the document id, the env-resolved store, verbatim bytes", async () => {
    const { calls, bucket } = makeRecordingBucket();
    const seen: Array<{ key: string; body: string }> = [];
    const deps: PublishDeps = {
      putReportBody: async (store, key, body) => {
        seen.push({ key, body });
        await store.put(key, body, { contentType: "application/json" });
      },
    };
    const outcome = await publishDocument(
      { REPORTS_BUCKET: bucket } as never,
      DOC,
      deps,
      { targets: ["r2-body"] },
    ).settled;
    expect(targetOf(outcome.targets, "r2-body").status).toBe("published");
    expect(seen).toEqual([
      { key: "reports/rep-3527-s2-1.json", body: DOC.body },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe("reports/rep-3527-s2-1.json");
  });

  it("injected put executor throws: failed carrying its message", async () => {
    const { bucket } = makeRecordingBucket();
    const deps: PublishDeps = {
      putReportBody: async () => {
        throw new Error("dep boom");
      },
    };
    const outcome = await publishDocument(
      { REPORTS_BUCKET: bucket } as never,
      DOC,
      deps,
      { targets: ["r2-body"] },
    ).settled;
    expect(targetOf(outcome.targets, "r2-body")).toEqual({
      target: "r2-body",
      status: "failed",
      error: "dep boom",
    });
  });

  it("handles return in canonical order regardless of request order, and settle independently", async () => {
    const { bucket } = makeRecordingBucket();
    let releaseVectorize!: (ok: boolean) => void;
    const gate = new Promise<boolean>((r) => {
      releaseVectorize = r;
    });
    const deps: PublishDeps = {
      indexCanonicalReport: () => gate,
      indexCanonicalReportInAiSearch: async () => ({
        ok: true,
        path: "namespace",
        correlationId: "c-s2",
      }),
    };
    const env = {
      REPORTS_BUCKET: bucket,
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
      VECTOR_MEMORY: { upsert: async () => {} },
    } as never;
    const handle = publishDocument(env, DOC, deps, {
      targets: ["ai-search", "r2-body", "vectorize"],
    });
    expect(handle.targets.map((t) => t.target)).toEqual([
      "r2-body",
      "vectorize",
      "ai-search",
    ]);
    // The body leg settles without waiting for the gated vectorize leg.
    const bodyOutcome = await handle.targets[0].settled;
    expect(bodyOutcome.status).toBe("published");
    let vectorizeSettled = false;
    void handle.targets[1].settled.then(() => {
      vectorizeSettled = true;
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(vectorizeSettled).toBe(false);
    releaseVectorize(true);
    const outcome = await handle.settled;
    expect(outcome.targets.map((t) => t.target)).toEqual([
      "r2-body",
      "vectorize",
      "ai-search",
    ]);
    expect(outcome.kind).toBe("report");
    expect(outcome.documentId).toBe("rep-3527-s2-1");
  });
});

/* ------------------------------------------------------------------ */
/* Part B — seam equivalence (green before and after the migration).  */
/* ------------------------------------------------------------------ */

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
    runId: "screener:2026-11-06T01:00:00Z",
    generationId: "gen-s2-equiv",
    title: "Publish stage S2 report",
    source: "screener",
    summary: "Scanned 10 symbols, 2 matched.",
    body: { opportunities: [{ symbol: "NVDA", structure: "call spread" }] },
    createdAt: "2026-11-06T01:00:00.000Z",
    userLogin: "tenant@example.com",
    ...over,
  };
}

function rowCount(sql: SqliteTestStorage): number {
  return (sql.exec(`SELECT id FROM mas_reports`) as unknown[]).length;
}

describe("3527 S2 seam equivalence: the WithR2 body leg", () => {
  it("fresh store: identical put + byte-identical fanout + pointer row", async () => {
    const sql = new SqliteTestStorage();
    const { calls, objects, bucket } = makeRecordingBucket();
    const stored = await storeReportAtGenerationWithR2(
      sql as unknown as SqlStorage,
      { REPORTS_BUCKET: bucket } as never,
      input(),
    );
    expect(stored?.created).toBe(true);
    expect(stored?.fanout).toEqual({
      outcome: "stored_r2",
      code: DataFoundationCode.REPORT_FANOUT_STORED,
      body: "r2",
      vectorize: "not_attempted",
      aiSearch: "pending",
    });
    const key = `reports/${stored!.reportId}.json`;
    expect(calls).toEqual([
      {
        key,
        value: JSON.stringify(input().body),
        contentType: "application/json",
      },
    ]);
    expect(objects.get(key)).toBe(JSON.stringify(input().body));
    const hit = getCanonicalReport(sql as unknown as SqlStorage, stored!.reportId);
    expect(hit?.bodyR2Key).toBe(key);
    await flush();
    const recorded = getCanonicalReportFanoutOutcome(
      sql as unknown as SqlStorage,
      stored!.reportId,
    );
    expect(recorded).toEqual({
      outcome: "stored_r2",
      code: DataFoundationCode.REPORT_FANOUT_STORED,
      body: "r2",
      vectorize: "not_attempted",
      aiSearch: "not_attempted",
      aiSearchCode: "disabled",
    });
  });

  it("ordering: the put still precedes the row insert", async () => {
    const sql = new SqliteTestStorage();
    const objects = new Map<string, string>();
    let rowsAtPutTime = -1;
    const bucket = {
      put: async (key: string, value: unknown) => {
        rowsAtPutTime = rowCount(sql);
        objects.set(key, String(value));
      },
      get: async (key: string) => {
        const v = objects.get(key);
        return v === undefined ? null : { text: async () => v };
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    };
    const stored = await storeReportAtGenerationWithR2(
      sql as unknown as SqlStorage,
      { REPORTS_BUCKET: bucket } as never,
      input(),
    );
    expect(stored?.created).toBe(true);
    expect(rowsAtPutTime).toBe(0);
    expect(rowCount(sql)).toBe(1);
  });

  it("put failure: recorded inline fallback + the seam's exact log line + the row complete inline", async () => {
    const sql = new SqliteTestStorage();
    const { objects, bucket } = makeRecordingBucket({ failPut: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stored = await storeReportAtGenerationWithR2(
        sql as unknown as SqlStorage,
        { REPORTS_BUCKET: bucket } as never,
        input(),
      );
      expect(stored?.created).toBe(true);
      expect(stored?.fanout).toEqual({
        outcome: "stored_inline_fallback",
        code: DataFoundationCode.REPORT_FANOUT_DEGRADED,
        body: "inline_fallback",
        vectorize: "not_attempted",
        aiSearch: "pending",
      });
      const logged = errSpy.mock.calls
        .map((c) => c.map(String).join(" "))
        .join("\n");
      expect(logged).toContain(
        `[scheduledReports] storeReportAtGenerationWithR2: R2 body put failed for report ${stored!.reportId}; storing inline instead: r2 put boom`,
      );
      await flush();
      const recorded = getCanonicalReportFanoutOutcome(
        sql as unknown as SqlStorage,
        stored!.reportId,
      );
      expect(recorded?.outcome).toBe("stored_inline_fallback");
      expect(recorded?.body).toBe("inline_fallback");
      expect(recorded?.code).toBe(DataFoundationCode.REPORT_FANOUT_DEGRADED);
      const hit = getCanonicalReport(
        sql as unknown as SqlStorage,
        stored!.reportId,
      );
      expect(hit?.bodyR2Key).toBeNull();
      expect(hit?.body).toContain("NVDA");
      expect(objects.size).toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("bucket unbound: plain inline store — not the fallback, not degraded", async () => {
    const sql = new SqliteTestStorage();
    const stored = await storeReportAtGenerationWithR2(
      sql as unknown as SqlStorage,
      {} as never,
      input(),
    );
    expect(stored?.fanout).toEqual({
      outcome: "stored_inline",
      code: DataFoundationCode.REPORT_FANOUT_STORED,
      body: "inline",
      vectorize: "not_attempted",
      aiSearch: "pending",
    });
    const hit = getCanonicalReport(sql as unknown as SqlStorage, stored!.reportId);
    expect(hit?.bodyR2Key).toBeNull();
    expect(hit?.body).toContain("NVDA");
  });

  it("the non-R2 seam never puts, even with a bucket in its env (it did not request the body leg)", async () => {
    const sql = new SqliteTestStorage();
    const { calls, bucket } = makeRecordingBucket();
    const stored = storeReportAtGeneration(
      sql as unknown as SqlStorage,
      input(),
      { REPORTS_BUCKET: bucket } as never,
    );
    expect(stored?.fanout.outcome).toBe("stored_inline");
    expect(stored?.fanout.body).toBe("inline");
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("dedupe never rewrites the R2 object; the deduped outcome still names body r2", async () => {
    const sql = new SqliteTestStorage();
    const { calls, bucket } = makeRecordingBucket();
    const env = { REPORTS_BUCKET: bucket } as never;
    const first = await storeReportAtGenerationWithR2(
      sql as unknown as SqlStorage,
      env,
      input(),
    );
    const second = await storeReportAtGenerationWithR2(
      sql as unknown as SqlStorage,
      env,
      input(),
    );
    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(second?.fanout.outcome).toBe("deduped");
    expect(second?.fanout.body).toBe("r2");
    await flush();
    expect(calls).toHaveLength(1);
    expect(rowCount(sql)).toBe(1);
  });

  it("put succeeds, INSERT fails: null result, no row, the object strands (today's behaviour, pinned)", async () => {
    const sql = new SqliteTestStorage();
    sql.failInserts = true;
    const { objects, bucket } = makeRecordingBucket();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stored = await storeReportAtGenerationWithR2(
        sql as unknown as SqlStorage,
        { REPORTS_BUCKET: bucket } as never,
        input(),
      );
      expect(stored).toBeNull();
      expect(rowCount(sql)).toBe(0);
      expect(objects.size).toBe(1);
      const logged = errSpy.mock.calls
        .map((c) => c.map(String).join(" "))
        .join("\n");
      expect(logged).toContain(DataFoundationCode.REPORT_FANOUT_FAILED);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("index legs are untouched by the migration: vectorize indexes the R2-bodied row after settle", async () => {
    const sql = new SqliteTestStorage();
    const { bucket } = makeRecordingBucket();
    const upserts: Array<{ id: string }> = [];
    const env = {
      REPORTS_BUCKET: bucket,
      AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
      VECTOR_MEMORY: {
        upsert: async (vectors: Array<{ id: string }>) => {
          upserts.push(...vectors);
        },
      },
    } as never;
    const stored = await storeReportAtGenerationWithR2(
      sql as unknown as SqlStorage,
      env,
      input(),
    );
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
});
