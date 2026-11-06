/**
 * Issue #3527 S4 pins: unbundle the corpus sync.
 *
 * Characterization (values carried verbatim from the pre-split
 * bundle, pinned by corpus_sync_p1169 / corpus_ai_search_indexing_
 * p3345 before this slice): for identical fixtures the corpus legs'
 * outcomes are byte-identical post-split — integrity report fields,
 * corpusIndex outcome passthrough, `completed` semantics (integrity
 * executed), and the corpus marker discipline in the route.
 *
 * New shape pinned here:
 *  A. runCorpusSync's result is exactly {integrity, corpusIndex,
 *     completed, ranAt} — no reports-backfill leg, no `backfill` key
 *     on the sync result or the corpus-sync route response.
 *  B. The reports canonical-index sweep lives in the reports
 *     workflow: runCanonicalIndexBackfillAll is exported from
 *     reportSemanticIndex.ts (same totals as the S4-4 pin), with its
 *     own weekly guard + durable marker key
 *     (reports_index_backfill_last_run) in reportSemanticIndex.ts.
 *  C. Its own trigger: POST /trading/reports/index-backfill-sweep
 *     (session-gated like the paged route) decides fire/no-fire from
 *     its own marker, writes the marker only on a completed sweep,
 *     and answers 500 without a marker write when the sweep throws;
 *     the 30-minute tick dispatches it from queue.ts beside (after)
 *     the corpus rider.
 *  D. CorpusTab no longer models or renders a reports-backfill
 *     field — the tab renders what the sync actually did.
 *
 * Red honesty: on the pre-split tree this file fails — the sync
 * result and route response carry `backfill`, reportSemanticIndex
 * exports no sweep/guard, the sweep route does not exist, and
 * CorpusTab still contains "backfill". The corpus-outcome value
 * assertions themselves already hold pre-split (that is the point
 * of characterization); they are re-pinned here so the post-split
 * run proves the values did not move.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  runCorpusIntegrityCheck,
  runCorpusSync,
} from "../src/services/corpusSync";
import {
  runCanonicalIndexBackfillAll,
  shouldFireReportsIndexBackfillTick,
  REPORTS_INDEX_BACKFILL_LAST_RUN_KEY,
  REPORTS_INDEX_BACKFILL_INTERVAL_MS,
} from "../src/services/reportSemanticIndex";
import { sha256Hex } from "../src/services/knowledgeCorpus";
import { handleKnowledgeCorpusRoutes } from "../src/agents/routes/knowledgeCorpus";
import { handleReportsRoutes } from "../src/agents/routes/reports";

const enc = new TextEncoder();

function stubStore(records: Record<string, { contentHash: string }>) {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return records[key] as T | undefined;
    },
    async put(): Promise<void> {
      throw new Error("stub store is read-only");
    },
  };
}

/** BlobStore-shaped double (same idiom as corpus_sync_p1169). */
function stubBlobStore(
  pages: Array<Array<{ key: string; bytes: Uint8Array }>>
) {
  const flat = pages.flat();
  return {
    async list(options?: { prefix?: string; cursor?: string }) {
      const idx = options?.cursor ? Number(options.cursor) : 0;
      const page = pages[idx] ?? [];
      return {
        keys: page.map((o) => o.key),
        truncated: idx + 1 < pages.length,
        cursor: idx + 1 < pages.length ? String(idx + 1) : undefined,
      };
    },
    async get(key: string) {
      const found = flat.find((o) => o.key === key);
      if (!found) return null;
      return { bytes: found.bytes };
    },
  };
}

/** R2Bucket-shaped double for route tests (the route wraps it). */
function stubBucket(pages: Array<Array<{ key: string; bytes: Uint8Array }>>) {
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

/**
 * Combined sql double: a key-aware mas_settings map (the
 * settingRead/WriteFromSql idiom: SELECT/DELETE by key, INSERT
 * (key, value, updated_at)) plus mas_reports row slicing for the
 * backfill read port (limit/offset args, corpus_sync_p1169 idiom).
 */
function stubSqlWithSettings(rows: Array<Record<string, unknown>>) {
  const settings = new Map<string, string>();
  const sql = {
    settings,
    exec(query: string, ...args: unknown[]) {
      const q = String(query);
      if (q.includes("CREATE")) return [];
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
      if (q.includes("FROM mas_reports")) {
        const limit = typeof args[0] === "number" ? args[0] : 100;
        const offset = typeof args[1] === "number" ? args[1] : 0;
        return rows.slice(offset, offset + limit);
      }
      return [];
    },
  };
  return sql as any;
}

const stubIndexEnv = {
  AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
  VECTOR_MEMORY: { upsert: async () => {} },
};

const LEG_FIXTURE = {
  items: [
    {
      bucketKey: "knowledge/broker_rules/abc",
      docId: "corpus:knowledge/broker_rules/abc",
      sha256: "abc",
      state: "indexed" as const,
    },
  ],
  indexed: 1,
  notConfigured: 0,
  failed: 0,
};

describe("A. corpus sync post-split shape (#3527 S4)", () => {
  it("corpus legs' outcomes are byte-identical and the result carries no reports leg", async () => {
    const bytes = enc.encode("agreeing bytes");
    const h = await sha256Hex(bytes);
    const deps = {
      manifest: [
        { title: "doc", category: "options_disclosure", sha256: h, fetchStatus: "verified" },
      ],
      recordStore: stubStore({
        [`knowledge:options_disclosure:${h}`]: { contentHash: h },
      }),
      bucket: stubBlobStore([
        [{ key: `knowledge/options_disclosure/${h}`, bytes }],
      ]),
    };
    const direct = await runCorpusIntegrityCheck(deps);
    const result = await runCorpusSync({
      ...deps,
      corpusIndex: async () => LEG_FIXTURE as any,
    });
    expect(Object.keys(result).sort()).toEqual([
      "completed",
      "corpusIndex",
      "integrity",
      "ranAt",
    ]);
    expect("backfill" in result).toBe(false);
    // Byte-identical corpus outcomes (checkedAt is the run's own
    // timestamp in both calls, so it is pinned by value from the
    // direct run only where deterministic: the deterministic
    // fields must match exactly).
    expect(result.integrity).toEqual({ ...direct, checkedAt: result.integrity.checkedAt });
    expect(result.corpusIndex).toEqual(LEG_FIXTURE);
    expect(result.completed).toBe(true);
  });

  it("no bucket: completed stays false and the corpusIndex outcome still surfaces", async () => {
    const result = await runCorpusSync({
      manifest: [],
      recordStore: stubStore({}),
      bucket: null,
      corpusIndex: async () => LEG_FIXTURE as any,
    });
    expect(result.completed).toBe(false);
    expect(result.integrity.ok).toBe(false);
    expect(typeof result.integrity.reason).toBe("string");
    expect(result.corpusIndex).toEqual(LEG_FIXTURE);
  });

  it("route: fires, writes the corpus marker, response carries no backfill field", async () => {
    const sql = stubSqlWithSettings([]);
    const ctx = {
      env: { REPORTS_BUCKET: stubBucket([[]]) },
      storage: stubStore({}),
      userLogin: "tester",
      sql,
    };
    const callSync = () =>
      handleKnowledgeCorpusRoutes(
        new Request("https://agent.internal/knowledge/corpus-sync", { method: "POST" }),
        new URL("https://agent.internal/knowledge/corpus-sync"),
        "/knowledge/corpus-sync",
        "s1",
        ctx as any
      );
    const first = await callSync();
    expect(first!.status).toBe(200);
    const body = (await first!.json()) as Record<string, any>;
    expect("backfill" in body).toBe(false);
    expect(body.completed).toBe(true);
    expect(body.integrity.ok).toBe(false);
    expect(body.integrity.missing).toHaveLength(3);
    expect(sql.settings.get("corpus_sync_last_run")).toBe(body.ranAt);
    const second = await callSync();
    const secondBody = (await second!.json()) as Record<string, any>;
    expect(secondBody.skipped).toBe(true);
    expect(secondBody.reason).toBe("too-soon");
  });
});

describe("B. reports sweep home + weekly guard (#3527 S4)", () => {
  function stubRowsSql(rows: Array<Record<string, unknown>>) {
    return {
      exec(query: string, ...args: unknown[]) {
        if (!String(query).includes("FROM mas_reports")) return [];
        const limit = typeof args[0] === "number" ? args[0] : 100;
        const offset = typeof args[1] === "number" ? args[1] : 0;
        return rows.slice(offset, offset + limit);
      },
    } as any;
  }

  it("the full sweep loops pages and totals them (S4-4 values, new home)", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `r${i}`,
      title: `t${i}`,
      source: i % 10 === 9 ? "retention" : "research_report",
      summary: "s",
      body: "",
      body_r2_key: null,
    }));
    const out = await runCanonicalIndexBackfillAll(stubIndexEnv, stubRowsSql(rows));
    expect(out).toEqual({
      upserted: 225,
      skippedRetention: 25,
      rows: 250,
      pages: 3,
      complete: true,
    });
  });

  it("guard: own marker key, 7-day interval, corpus-guard semantics", () => {
    expect(REPORTS_INDEX_BACKFILL_LAST_RUN_KEY).toBe("reports_index_backfill_last_run");
    expect(REPORTS_INDEX_BACKFILL_INTERVAL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const now = new Date("2026-11-06T12:00:00.000Z");
    expect(shouldFireReportsIndexBackfillTick(now, null)).toEqual({ fire: true });
    const exactly7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldFireReportsIndexBackfillTick(now, exactly7d)).toEqual({ fire: true });
    const eightDays = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldFireReportsIndexBackfillTick(now, eightDays)).toEqual({ fire: true });
    const sixDays = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const d = shouldFireReportsIndexBackfillTick(now, sixDays);
    expect(d.fire).toBe(false);
    if (!d.fire) {
      expect(d.reason).toBe("too-soon");
      expect(d.lastFiredAt).toBe(sixDays);
    }
    expect(shouldFireReportsIndexBackfillTick(now, "not-a-date")).toEqual({ fire: true });
  });

  it("source pins: the reports leg has left the corpus module and route", () => {
    // Code shapes, not prose: the module header legitimately
    // names where the leg went (provenance), so the pins assert
    // the import, the call, and the dep field are gone.
    const corpusSyncSrc = readFileSync("src/services/corpusSync.ts", "utf8");
    expect(corpusSyncSrc).not.toContain("from \"./reportSemanticIndex\"");
    expect(corpusSyncSrc).not.toContain("runCanonicalIndexBackfillPage(");
    expect(corpusSyncSrc).not.toContain("backfill?:");
    expect(corpusSyncSrc).not.toContain("backfill:");
    const routeSrc = readFileSync("src/agents/routes/knowledgeCorpus.ts", "utf8");
    expect(routeSrc).not.toContain("runCanonicalIndexBackfillAll");
    const queueSrc = readFileSync("src/server/routes/queue.ts", "utf8");
    const sweepAt = queueSrc.indexOf("/trading/reports/index-backfill-sweep");
    const corpusAt = queueSrc.indexOf("/knowledge/corpus-sync");
    expect(corpusAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeGreaterThan(corpusAt);
    const reportsSrc = readFileSync("src/agents/routes/reports.ts", "utf8");
    expect(reportsSrc).toContain("/trading/reports/index-backfill-sweep");
  });
});

describe("C. sweep route behaviour (#3527 S4)", () => {
  const rows = [
    { id: "r1", title: "t1", source: "research_report", summary: "s", body: "", body_r2_key: null },
    { id: "r2", title: "t2", source: "retention", summary: "", body: "", body_r2_key: null },
    { id: "r3", title: "t3", source: "screener", summary: "s", body: "", body_r2_key: null },
  ];

  function callSweep(sql: any, login: string | null) {
    return handleReportsRoutes(
      new Request("https://agent.internal/trading/reports/index-backfill-sweep", {
        method: "POST",
        headers: login ? { "x-user-login": login } : {},
      }),
      new URL("https://agent.internal/trading/reports/index-backfill-sweep"),
      "/trading/reports/index-backfill-sweep",
      "sess",
      { ensureTables: () => sql, env: stubIndexEnv } as any
    );
  }

  it("401s without login via the shared unauthenticatedResponse", async () => {
    const res = await callSweep(stubSqlWithSettings(rows), null);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("fires with no marker, returns the sweep outcome, writes ONLY its own marker", async () => {
    const sql = stubSqlWithSettings(rows);
    const res = await callSweep(sql, "tester");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.upserted).toBe(2);
    expect(body.skippedRetention).toBe(1);
    expect(body.rows).toBe(3);
    expect(body.pages).toBe(1);
    expect(body.complete).toBe(true);
    expect(typeof body.ranAt).toBe("string");
    expect(sql.settings.get("reports_index_backfill_last_run")).toBe(body.ranAt);
    expect(sql.settings.has("corpus_sync_last_run")).toBe(false);
  });

  it("skips too-soon on its own marker and fires again after 7 days", async () => {
    const sql = stubSqlWithSettings(rows);
    const first = await callSweep(sql, "tester");
    expect(first!.status).toBe(200);
    const second = await callSweep(sql, "tester");
    const secondBody = (await second!.json()) as Record<string, any>;
    expect(secondBody.success).toBe(true);
    expect(secondBody.skipped).toBe(true);
    expect(secondBody.reason).toBe("too-soon");
    expect(secondBody.lastFiredAt).toBe(
      sql.settings.get("reports_index_backfill_last_run")
    );
    // Age the marker past the interval: fires again.
    const aged = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    sql.settings.set("reports_index_backfill_last_run", aged);
    const third = await callSweep(sql, "tester");
    const thirdBody = (await third!.json()) as Record<string, any>;
    expect(thirdBody.skipped).toBeUndefined();
    expect(thirdBody.complete).toBe(true);
  });

  it("a throwing sweep answers 500 and writes no marker (next tick retries)", async () => {
    const settings = new Map<string, string>();
    const sql = {
      settings,
      exec(query: string, ...args: unknown[]) {
        const q = String(query);
        if (q.includes("CREATE")) return [];
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
        if (q.includes("FROM mas_reports")) throw new Error("store gone");
        return [];
      },
    } as any;
    const res = await callSweep(sql, "tester");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
    const body = (await res!.json()) as Record<string, any>;
    expect(typeof body.error).toBe("string");
    expect(settings.has("reports_index_backfill_last_run")).toBe(false);
  });
});

describe("D. CorpusTab shape (#3527 S4)", () => {
  it("the tab models and renders no reports-backfill field", () => {
    const tabSrc = readFileSync("src/client/search/tabs/CorpusTab.tsx", "utf8");
    expect(tabSrc).not.toContain("backfill");
  });
});
