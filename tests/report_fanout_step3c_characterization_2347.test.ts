// @vitest-environment node
/**
 * Issue #2347 (#1976 step 3c, ADR 0022 D-C.3 / D-F2) —
 * CHARACTERIZATION pins for the canonical report fan-out
 * (src/services/scheduledReports.ts), written against the
 * UNMODIFIED code before the fan-out contract change. They pin
 * the as-found behaviour of BOTH store seams:
 *
 *  - sync seam (storeReportAtGeneration): inline row, NULL
 *    body_r2_key, generation-id dedupe, owner refusal, the
 *    Vectorize leg fires only when env bindings are present,
 *    the AI Search leg fires only when #2246's flag is on;
 *  - R2 seam (storeReportAtGenerationWithR2): the body put
 *    happens BEFORE the row insert that references its key,
 *    a failed put falls back to the exact inline shape (a
 *    report is never lost to the storage flip), an unbound
 *    bucket is the plain inline write, dedupe never rewrites
 *    the R2 object;
 *  - a failing index leg (as-found): the store still succeeds
 *    and the row stays intact — the failure is recorded
 *    NOWHERE on the row (that gap is what the new-contract
 *    pins in report_fanout_step3c_contract_2347.test.ts close).
 *
 * Issue #6101 (step 8): the seams write/read D1 agent_reports
 * now — the DO mas_reports table is frozen at cutover and
 * receives no new writes. "Exactly one row" is pinned as
 * exactly one report id through the D1 readers, and a failing
 * Vectorize leg leaves fanoutOutcome NULL on the read-back
 * (TRUE BY DESIGN now: D1 carries no fan-out column — the
 * named loss). The third seam (persistScheduledReportSql) is
 * DELETED, so its "divergent seam" describe block was deleted
 * with it (3 tests: inline row with generation_id + user_login,
 * no-dedupe two rows, null on a broken store).
 *
 * DOUBLES: shared MockD1Database over node:sqlite.
 *
 * #CDO-mha7
 */
import { describe, expect, it, vi } from "vitest";

// The AI Search leg pulls the Think-coupled module graph; mock
// only that adapter (the #2246 test precedent).
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
  listScheduledReports,
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
  type ScheduledReportInput,
} from "../src/services/scheduledReports";
import { MockD1Database } from "./mock-d1";

type D1Database = any;

function d1Env() {
  const mock = new MockD1Database();
  const env = { AGENT_DB: mock as unknown as D1Database, IAAA_TENANT_ID: "tenant-2347" };
  return { mock, env };
}

/** Distinct D1 report ids visible through the Reports-route list. */
async function reportIds(env: { AGENT_DB: D1Database }): Promise<string[]> {
  const hits = await listScheduledReports(env, { limit: 100 });
  return [...new Set(hits.map((h) => h.id))];
}

const flush = async () => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

function input(over: Partial<ScheduledReportInput> = {}): ScheduledReportInput {
  return {
    runId: "screener:2026-10-29T00:00:00Z",
    generationId: "gen-3c-char",
    title: "Fan-out characterization report",
    source: "screener",
    summary: "Scanned 10 symbols, 2 matched.",
    body: { opportunities: [{ symbol: "NVDA", structure: "call spread" }] },
    createdAt: "2026-10-29T00:00:00.000Z",
    userLogin: "tenant@example.com",
    ...over,
  };
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

function makeBucket(opts: { failPut?: boolean; onPut?: () => void } = {}) {
  const objects = new Map<string, string>();
  return {
    objects,
    bucket: {
      put: async (key: string, value: string) => {
        opts.onPut?.();
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

describe("3c characterization: sync seam (storeReportAtGeneration)", () => {
  it("fresh store writes one inline row (body inline, bodyR2Key null)", async () => {
    const { env } = d1Env();
    const stored = await storeReportAtGeneration(input(), env);
    expect(stored?.created).toBe(true);
    expect(await reportIds(env)).toHaveLength(1);
    const hit = await getCanonicalReport(env, stored!.reportId);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe(stored!.reportId);
    expect(hit!.bodyR2Key).toBeNull();
    expect(JSON.parse(String(hit!.body))).toEqual({
      opportunities: [{ symbol: "NVDA", structure: "call spread" }],
    });
    expect(hit!.generationId).toBe("gen-3c-char");
    expect(hit!.userLogin).toBe("tenant@example.com");
  });

  it("redelivery dedupes on (generation_id, owner): created:false, one row", async () => {
    const { env } = d1Env();
    const first = await storeReportAtGeneration(input(), env);
    const second = await storeReportAtGeneration(input(), env);
    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first!.reportId);
    expect(await reportIds(env)).toHaveLength(1);
  });

  it("ownerless input is refused (null, no row) on every seam", async () => {
    const { env } = d1Env();
    const noOwner = input({ userLogin: "" });
    expect(await storeReportAtGeneration(noOwner, env)).toBeNull();
    expect(await storeReportAtGenerationWithR2(env, noOwner)).toBeNull();
    expect(await reportIds(env)).toHaveLength(0);
  });

  it("without env bindings the Vectorize leg does not fire", async () => {
    const { env } = d1Env();
    const { upserts } = makeVectorEnv();
    const stored = await storeReportAtGeneration(input(), env);
    expect(stored?.created).toBe(true);
    await flush();
    expect(upserts).toHaveLength(0);
  });

  it("with env bindings the Vectorize leg upserts report:<id> once", async () => {
    const { env } = d1Env();
    const { env: vecEnv, upserts } = makeVectorEnv();
    const stored = await storeReportAtGeneration(input(), { ...env, ...vecEnv });
    await flush();
    expect(upserts).toHaveLength(1);
    expect(upserts[0].id).toBe(`report:${stored!.reportId}`);
  });

  it("a failing Vectorize leg leaves the stored row intact (failure recorded nowhere on the row — fanoutOutcome null by design)", async () => {
    const { env } = d1Env();
    const { env: vecEnv } = makeVectorEnv({ failUpsert: true });
    const stored = await storeReportAtGeneration(input(), { ...env, ...vecEnv });
    expect(stored?.created).toBe(true);
    await flush();
    const hit = await getCanonicalReport(env, stored!.reportId);
    expect(hit?.title).toBe("Fan-out characterization report");
    expect(hit?.body).toContain("NVDA");
    // D1 carries no fan-out column: the failure is recorded nowhere
    // on the row — true by design on the D1 seam (#6101 step 8).
    expect(hit?.fanoutOutcome).toBeNull();
  });

  it("AI Search leg: flag OFF makes zero instance uploads; flag ON uploads once", async () => {
    const { env: envOff } = d1Env();
    // Phase 3 (#6550): AI_SEARCH_REPORT_INDEXING_ENABLED lives in
    // environment.config.json (ON in production), so a bare env no
    // longer means the flag is off.
    const off = makeAiSearchEnv({ flag: "0" });
    await storeReportAtGeneration(input(), { ...envOff, ...off.env });
    await flush();
    expect(off.uploads).toHaveLength(0);

    const { env: envOn } = d1Env();
    const on = makeAiSearchEnv({ flag: "true" });
    const stored = await storeReportAtGeneration(input(), { ...envOn, ...on.env });
    await flush();
    expect(on.uploads).toHaveLength(1);
    expect(on.uploads[0].name).toBe(`report:${stored!.reportId}`);
  });
});

describe("3c characterization: R2 seam (storeReportAtGenerationWithR2)", () => {
  it("ordering: the R2 put happens BEFORE the row insert that references its key", async () => {
    const { mock, env: baseEnv } = d1Env();
    let rowsAtPutTime = -1;
    const { bucket, objects } = makeBucket({
      onPut: () => {
        rowsAtPutTime = Number(
          (
            mock.sqlite
              .prepare("SELECT COUNT(*) AS c FROM agent_reports")
              .get() as { c: number }
          ).c,
        );
      },
    });
    const env = { ...baseEnv, REPORTS_BUCKET: bucket };
    const stored = await storeReportAtGenerationWithR2(env, input());
    expect(stored?.created).toBe(true);
    expect(rowsAtPutTime).toBe(0);
    expect(await reportIds(env)).toHaveLength(1);
    const hit = await getCanonicalReport(env, stored!.reportId);
    expect(hit!.body).toBe("");
    expect(hit!.bodyR2Key).toBe(`reports/${stored!.reportId}.json`);
    expect(objects.get(`reports/${stored!.reportId}.json`)).toContain("NVDA");
  });

  it("a failed R2 put falls back to the inline shape (report never lost)", async () => {
    const { env: baseEnv } = d1Env();
    const { bucket } = makeBucket({ failPut: true });
    const env = { ...baseEnv, REPORTS_BUCKET: bucket };
    const stored = await storeReportAtGenerationWithR2(env, input());
    expect(stored?.created).toBe(true);
    expect(await reportIds(env)).toHaveLength(1);
    const hit = await getCanonicalReport(env, stored!.reportId);
    expect(hit!.bodyR2Key).toBeNull();
    expect(String(hit!.body)).toContain("NVDA");
  });

  it("an unbound bucket is the plain inline write", async () => {
    const { env } = d1Env();
    const stored = await storeReportAtGenerationWithR2(env, input());
    expect(stored?.created).toBe(true);
    const hit = await getCanonicalReport(env, stored!.reportId);
    expect(hit!.bodyR2Key).toBeNull();
    expect(String(hit!.body)).toContain("NVDA");
  });

  it("dedupe never rewrites the R2 object and never duplicates the row", async () => {
    const { env: baseEnv } = d1Env();
    const { bucket, objects } = makeBucket();
    const env = { ...baseEnv, REPORTS_BUCKET: bucket };
    const first = await storeReportAtGenerationWithR2(env, input());
    const second = await storeReportAtGenerationWithR2(env, input({ body: { changed: true } }));
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first!.reportId);
    expect(await reportIds(env)).toHaveLength(1);
    expect(objects.get(`reports/${first!.reportId}.json`)).toContain("NVDA");
  });
});
