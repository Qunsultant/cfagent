// @vitest-environment node
/**
 * Issue #2347 (#1976 step 3c, ADR 0022 D-C.3 / D-F2) —
 * CHARACTERIZATION pins for the canonical report fan-out
 * (src/services/scheduledReports.ts), written against the
 * UNMODIFIED code before the fan-out contract change. They pin
 * the as-found behaviour of BOTH store seams plus the divergent
 * third seam (persistScheduledReportSql):
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
 *    pins in report_fanout_step3c_contract_2347.test.ts close);
 *  - persistScheduledReportSql (as-found divergence): its own
 *    INSERT populates generation_id + user_login but NOT
 *    body_r2_key, fires no index legs (it takes no env), and
 *    does not dedupe on generation id.
 *
 * These pins must be green before the change and green after
 * it — the contract slice records outcomes and retires the
 * divergent seam INTO the canonical seam without changing
 * the successful-path behaviour pinned here (the retired
 * seam's own divergence pins live in the contract file,
 * because that behaviour intentionally changes).
 *
 * DOUBLES: node:sqlite-backed SqlStorage (real SQLite
 * semantics, the step-3a/3b characterization precedent).
 *
 * #CDO-mha7
 */
import { DatabaseSync } from "node:sqlite";
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
  ensureScheduledReportsTable,
  getCanonicalReport,
  persistScheduledReportSql,
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
  type ScheduledReportInput,
} from "../src/services/scheduledReports";
import type { SqlStorage } from "../src/orm";

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
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

function rows(sql: SqliteTestStorage): Array<Record<string, unknown>> {
  return sql.exec(`SELECT * FROM mas_reports`) as Array<Record<string, unknown>>;
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
  it("fresh store writes one inline row (body inline, body_r2_key NULL)", () => {
    const sql = new SqliteTestStorage();
    const stored = storeReportAtGeneration(sql as unknown as SqlStorage, input());
    expect(stored?.created).toBe(true);
    const all = rows(sql);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(stored!.reportId);
    expect(all[0].body_r2_key).toBeNull();
    expect(JSON.parse(String(all[0].body))).toEqual({
      opportunities: [{ symbol: "NVDA", structure: "call spread" }],
    });
    expect(all[0].generation_id).toBe("gen-3c-char");
    expect(all[0].user_login).toBe("tenant@example.com");
  });

  it("redelivery dedupes on (generation_id, owner): created:false, one row", () => {
    const sql = new SqliteTestStorage();
    const first = storeReportAtGeneration(sql as unknown as SqlStorage, input());
    const second = storeReportAtGeneration(sql as unknown as SqlStorage, input());
    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first!.reportId);
    expect(rows(sql)).toHaveLength(1);
  });

  it("ownerless input is refused (null, no row) on every seam", async () => {
    const sql = new SqliteTestStorage();
    ensureScheduledReportsTable(sql as unknown as SqlStorage);
    const noOwner = input({ userLogin: "" });
    expect(storeReportAtGeneration(sql as unknown as SqlStorage, noOwner)).toBeNull();
    await expect(
      storeReportAtGenerationWithR2(sql as unknown as SqlStorage, {}, noOwner),
    ).resolves.toBeNull();
    expect(persistScheduledReportSql(sql as unknown as SqlStorage, noOwner)).toBeNull();
    expect(rows(sql)).toHaveLength(0);
  });

  it("without env bindings the Vectorize leg does not fire", async () => {
    const sql = new SqliteTestStorage();
    const { env, upserts } = makeVectorEnv();
    const stored = storeReportAtGeneration(sql as unknown as SqlStorage, input());
    expect(stored?.created).toBe(true);
    await flush();
    expect(upserts).toHaveLength(0);
    void env;
  });

  it("with env bindings the Vectorize leg upserts report:<id> once", async () => {
    const sql = new SqliteTestStorage();
    const { env, upserts } = makeVectorEnv();
    const stored = storeReportAtGeneration(
      sql as unknown as SqlStorage,
      input(),
      env as never,
    );
    await flush();
    expect(upserts).toHaveLength(1);
    expect(upserts[0].id).toBe(`report:${stored!.reportId}`);
  });

  it("a failing Vectorize leg leaves the stored row intact (as-found: failure recorded nowhere on the row)", async () => {
    const sql = new SqliteTestStorage();
    const { env } = makeVectorEnv({ failUpsert: true });
    const stored = storeReportAtGeneration(
      sql as unknown as SqlStorage,
      input(),
      env as never,
    );
    expect(stored?.created).toBe(true);
    await flush();
    const hit = getCanonicalReport(sql as unknown as SqlStorage, stored!.reportId);
    expect(hit?.title).toBe("Fan-out characterization report");
    expect(hit?.body).toContain("NVDA");
  });

  it("AI Search leg: flag OFF makes zero instance uploads; flag ON uploads once", async () => {
    const sqlOff = new SqliteTestStorage();
    // Phase 3 (#6550): AI_SEARCH_REPORT_INDEXING_ENABLED lives in
    // environment.config.json (ON in production), so a bare env no
    // longer means the flag is off.
    const off = makeAiSearchEnv({ flag: "0" });
    storeReportAtGeneration(sqlOff as unknown as SqlStorage, input(), off.env as never);
    await flush();
    expect(off.uploads).toHaveLength(0);

    const sqlOn = new SqliteTestStorage();
    const on = makeAiSearchEnv({ flag: "true" });
    const stored = storeReportAtGeneration(
      sqlOn as unknown as SqlStorage,
      input(),
      on.env as never,
    );
    await flush();
    expect(on.uploads).toHaveLength(1);
    expect(on.uploads[0].name).toBe(`report:${stored!.reportId}`);
  });
});

describe("3c characterization: R2 seam (storeReportAtGenerationWithR2)", () => {
  it("ordering: the R2 put happens BEFORE the row insert that references its key", async () => {
    const sql = new SqliteTestStorage();
    let rowsAtPutTime = -1;
    const { bucket, objects } = makeBucket({
      onPut: () => {
        rowsAtPutTime = rows(sql).length;
      },
    });
    const stored = await storeReportAtGenerationWithR2(
      sql as unknown as SqlStorage,
      { REPORTS_BUCKET: bucket } as never,
      input(),
    );
    expect(stored?.created).toBe(true);
    expect(rowsAtPutTime).toBe(0);
    const all = rows(sql);
    expect(all).toHaveLength(1);
    expect(all[0].body).toBe("");
    expect(all[0].body_r2_key).toBe(`reports/${stored!.reportId}.json`);
    expect(objects.get(`reports/${stored!.reportId}.json`)).toContain("NVDA");
  });

  it("a failed R2 put falls back to the inline shape (report never lost)", async () => {
    const sql = new SqliteTestStorage();
    const { bucket } = makeBucket({ failPut: true });
    const stored = await storeReportAtGenerationWithR2(
      sql as unknown as SqlStorage,
      { REPORTS_BUCKET: bucket } as never,
      input(),
    );
    expect(stored?.created).toBe(true);
    const all = rows(sql);
    expect(all).toHaveLength(1);
    expect(all[0].body_r2_key).toBeNull();
    expect(String(all[0].body)).toContain("NVDA");
  });

  it("an unbound bucket is the plain inline write", async () => {
    const sql = new SqliteTestStorage();
    const stored = await storeReportAtGenerationWithR2(
      sql as unknown as SqlStorage,
      {} as never,
      input(),
    );
    expect(stored?.created).toBe(true);
    expect(rows(sql)[0].body_r2_key).toBeNull();
    expect(String(rows(sql)[0].body)).toContain("NVDA");
  });

  it("dedupe never rewrites the R2 object and never duplicates the row", async () => {
    const sql = new SqliteTestStorage();
    const { bucket, objects } = makeBucket();
    const first = await storeReportAtGenerationWithR2(
      sql as unknown as SqlStorage,
      { REPORTS_BUCKET: bucket } as never,
      input(),
    );
    const second = await storeReportAtGenerationWithR2(
      sql as unknown as SqlStorage,
      { REPORTS_BUCKET: bucket } as never,
      input({ body: { changed: true } }),
    );
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first!.reportId);
    expect(rows(sql)).toHaveLength(1);
    expect(objects.get(`reports/${first!.reportId}.json`)).toContain("NVDA");
  });
});

describe("3c characterization: divergent seam (persistScheduledReportSql, as-found)", () => {
  it("writes an inline row with generation_id + user_login but body_r2_key NULL", () => {
    const sql = new SqliteTestStorage();
    const id = persistScheduledReportSql(sql as unknown as SqlStorage, input());
    expect(id).toBeTruthy();
    const all = rows(sql);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(id);
    expect(all[0].generation_id).toBe("gen-3c-char");
    expect(all[0].user_login).toBe("tenant@example.com");
    // The divergence: no body_r2_key value, ever, on this seam.
    expect(all[0].body_r2_key).toBeNull();
    expect(String(all[0].body)).toContain("NVDA");
  });

  it("does not dedupe: two calls without a generation id write two rows", () => {
    const sql = new SqliteTestStorage();
    const a = persistScheduledReportSql(
      sql as unknown as SqlStorage,
      input({ generationId: undefined }),
    );
    const b = persistScheduledReportSql(
      sql as unknown as SqlStorage,
      input({ generationId: undefined }),
    );
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    expect(rows(sql)).toHaveLength(2);
  });

  it("returns null (never throws) on a broken store", () => {
    const broken = {
      exec: () => {
        throw new Error("boom");
      },
    } as unknown as SqlStorage;
    expect(persistScheduledReportSql(broken, input())).toBeNull();
  });
});
