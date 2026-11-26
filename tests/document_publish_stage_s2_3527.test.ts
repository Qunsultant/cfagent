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
 *  - fresh WithR2 store: the store-result fanout byte-identical
 *    (stored_r2 / r2 / STORED) — the ROW carries no fan-out
 *    outcome anymore (D1 carries no fan-out column, #6101
 *    named loss: read-back fanoutOutcome is null); the row
 *    carries the pointer and an empty inline body, exactly
 *    one put with identical key/bytes/contentType, and the
 *    put still PRECEDES the insert (a row never claims a body
 *    it does not have);
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
 * DOUBLES: MockD1Database (node:sqlite-backed D1, #6101 step 8),
 * recording fake R2 buckets.
 *
 * #CDO-mha7
 */
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
import { MockD1Database } from "./mock-d1";
import {
  getCanonicalReport,
  listScheduledReports,
  reportBodyR2Key as seamReportBodyR2Key,
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
  type ScheduledReportInput,
} from "../src/services/scheduledReports";
import { DataFoundationCode } from "../src/aspects/errorCodes";

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

type D1Database = any;

/** Fresh D1 env per test (#6101 step 8: the seam reads/writes D1). */
function d1Env(extra: Record<string, unknown> = {}) {
  const mock = new MockD1Database();
  const env = {
    AGENT_DB: mock as unknown as D1Database,
    IAAA_TENANT_ID: "tenant-3527-s2",
    ...extra,
  };
  return { mock, env };
}

/**
 * A D1 stand-in whose agent_reports INSERT throws — the #6101
 * replacement for the old fake-sql failInserts flag (put succeeds,
 * INSERT fails: null result, no row, the object strands).
 */
function failingInsertD1Env(extra: Record<string, unknown> = {}) {
  const mock = new MockD1Database();
  const broken = {
    sqlite: mock.sqlite,
    prepare(sql: string) {
      if (/^\s*INSERT\s+INTO\s+["`]?agent_reports/i.test(sql)) {
        throw new Error("simulated insert failure");
      }
      return mock.prepare(sql);
    },
    batch: (stmts: any[]) => mock.batch(stmts),
  };
  const env = {
    AGENT_DB: broken as unknown as D1Database,
    IAAA_TENANT_ID: "tenant-3527-s2",
    ...extra,
  };
  return { mock, env };
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

async function rowCount(env: Record<string, unknown>): Promise<number> {
  return (await listScheduledReports(env as never)).length;
}

describe("3527 S2 seam equivalence: the WithR2 body leg", () => {
  it("fresh store: identical put + byte-identical fanout + pointer row", async () => {
    const { calls, objects, bucket } = makeRecordingBucket();
    // Phase 3 (#6550): AI_SEARCH_REPORT_INDEXING_ENABLED lives in
    // environment.config.json (ON in production), so a bare env no
    // longer means the report leg is off — it would attempt (and
    // record) an index instead of "not_attempted"/"disabled".
    const { env } = d1Env({ REPORTS_BUCKET: bucket, AI_SEARCH_REPORT_INDEXING_ENABLED: "0" });
    const stored = await storeReportAtGenerationWithR2(env as never, input());
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
    const hit = await getCanonicalReport(env as never, stored!.reportId);
    expect(hit?.bodyR2Key).toBe(key);
    await flush();
    // #6101 step 8 (named loss): D1 agent_reports carries no fan-out
    // column, so the read-back outcome is ALWAYS null — the store
    // result above still carries the outcome as known at return time.
    expect(hit?.fanoutOutcome).toBeNull();
  });

  it("ordering: the put still precedes the row insert", async () => {
    const { env } = d1Env();
    const objects = new Map<string, string>();
    let rowsAtPutTime = -1;
    const bucket = {
      put: async (key: string, value: unknown) => {
        rowsAtPutTime = await rowCount(env);
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
      { ...env, REPORTS_BUCKET: bucket } as never,
      input(),
    );
    expect(stored?.created).toBe(true);
    expect(rowsAtPutTime).toBe(0);
    expect(await rowCount(env)).toBe(1);
  });

  it("put failure: recorded inline fallback + the seam's exact log line + the row complete inline", async () => {
    const { objects, bucket } = makeRecordingBucket({ failPut: true });
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    // #3515 S3: the seam's log line now travels as a structured
    // storeReportAtGenerationWithR2.r2_body_put_failed event (level error)
    // on the console-info JSON fallback, not a console.error line. The pin
    // is unchanged in substance: the event's message field must carry the
    // exact same line, verbatim.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const stored = await storeReportAtGenerationWithR2(env as never, input());
      expect(stored?.created).toBe(true);
      expect(stored?.fanout).toEqual({
        outcome: "stored_inline_fallback",
        code: DataFoundationCode.REPORT_FANOUT_DEGRADED,
        body: "inline_fallback",
        vectorize: "not_attempted",
        aiSearch: "pending",
      });
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
      const putFailed = events.find(
        (e) => e.operation === "storeReportAtGenerationWithR2.r2_body_put_failed",
      );
      expect(putFailed).toBeDefined();
      expect(putFailed?.level).toBe("error");
      expect(putFailed?.fields.message).toBe(
        `[scheduledReports] storeReportAtGenerationWithR2: R2 body put failed for report ${stored!.reportId}; storing inline instead: r2 put boom`,
      );
      expect(putFailed?.fields.reportId).toBe(stored!.reportId);
      expect(putFailed?.fields.error).toBe("r2 put boom");
      await flush();
      // #6101 step 8 (named loss): the fallback outcome lives on the
      // store result above, not on the row — the D1 read is null.
      const hit = await getCanonicalReport(env as never, stored!.reportId);
      expect(hit?.fanoutOutcome).toBeNull();
      expect(hit?.bodyR2Key).toBeNull();
      expect(hit?.body).toContain("NVDA");
      expect(objects.size).toBe(0);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("bucket unbound: plain inline store — not the fallback, not degraded", async () => {
    const { env } = d1Env();
    const stored = await storeReportAtGenerationWithR2(env as never, input());
    expect(stored?.fanout).toEqual({
      outcome: "stored_inline",
      code: DataFoundationCode.REPORT_FANOUT_STORED,
      body: "inline",
      vectorize: "not_attempted",
      aiSearch: "pending",
    });
    const hit = await getCanonicalReport(env as never, stored!.reportId);
    expect(hit?.bodyR2Key).toBeNull();
    expect(hit?.body).toContain("NVDA");
  });

  it("the non-R2 seam never puts, even with a bucket in its env (it did not request the body leg)", async () => {
    const { calls, bucket } = makeRecordingBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    const stored = await storeReportAtGeneration(input(), env as never);
    expect(stored?.fanout.outcome).toBe("stored_inline");
    expect(stored?.fanout.body).toBe("inline");
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("dedupe never rewrites the R2 object; the deduped outcome still names body r2", async () => {
    const { calls, bucket } = makeRecordingBucket();
    const { env } = d1Env({ REPORTS_BUCKET: bucket });
    const first = await storeReportAtGenerationWithR2(env as never, input());
    const second = await storeReportAtGenerationWithR2(env as never, input());
    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(second?.fanout.outcome).toBe("deduped");
    expect(second?.fanout.body).toBe("r2");
    await flush();
    expect(calls).toHaveLength(1);
    expect(await rowCount(env)).toBe(1);
  });

  it("put succeeds, INSERT fails: null result, no row, the object strands (today's behaviour, pinned)", async () => {
    const { objects, bucket } = makeRecordingBucket();
    const { env } = failingInsertD1Env({ REPORTS_BUCKET: bucket });
    // #3515 S3: the failure now travels as a structured
    // storeReportAtGenerationWithR2.failed event (level error) on the
    // console-info JSON fallback, not a console.error line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const stored = await storeReportAtGenerationWithR2(env as never, input());
      expect(stored).toBeNull();
      expect(await rowCount(env)).toBe(0);
      expect(objects.size).toBe(1);
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
      const failed = events.find((e) => e.operation === "storeReportAtGenerationWithR2.failed");
      expect(failed).toBeDefined();
      expect(failed?.level).toBe("error");
      expect(failed?.fields.code).toBe(DataFoundationCode.REPORT_FANOUT_FAILED);
      expect(String(failed?.fields.message ?? "")).toContain(DataFoundationCode.REPORT_FANOUT_FAILED);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("index legs are untouched by the migration: vectorize indexes the R2-bodied row after settle", async () => {
    const { bucket } = makeRecordingBucket();
    const upserts: Array<{ id: string }> = [];
    const { env } = d1Env({
      REPORTS_BUCKET: bucket,
      AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
      // Phase 3 (#6550): AI_SEARCH_REPORT_INDEXING_ENABLED lives in
      // environment.config.json (ON in production); with the leg
      // attempting (and failing, no AI_SEARCH binding here) the
      // fanout code degrades instead of staying STORED. This test
      // pins the vectorize leg, so the report leg stays off.
      AI_SEARCH_REPORT_INDEXING_ENABLED: "0",
      VECTOR_MEMORY: {
        upsert: async (vectors: Array<{ id: string }>) => {
          upserts.push(...vectors);
        },
      },
    });
    const stored = await storeReportAtGenerationWithR2(env as never, input());
    await flush();
    expect(upserts).toHaveLength(1);
    // #6101 step 8 (named loss): the settled vectorize outcome is no
    // longer recorded on the row — the D1 read is null; the row still
    // carries the R2 pointer and the leg still ran (upsert above).
    const hit = await getCanonicalReport(env as never, stored!.reportId);
    expect(hit?.bodyR2Key).toBe(`reports/${stored!.reportId}.json`);
    expect(hit?.fanoutOutcome).toBeNull();
  });
});
