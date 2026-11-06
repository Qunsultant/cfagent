/** @vitest-environment jsdom */
/**
 * Issue #1169 S4-4 pins: schedulable corpus sync + downloadable export.
 *
 * - Integrity leg: stubbed manifest / DO-record store / R2 bucket —
 *   missing, mismatched, extra, checkedAt, and the honest no-bucket
 *   report are all asserted exactly.
 * - Weekly guard: fires at/after 7 days (or never fired), never
 *   before; an unparseable marker self-heals by firing.
 * - Backfill: the shared page fn (extracted from the route) counts
 *   and paginates; the route handler still calls the shared fn
 *   (source pin — the existing backfill route pins in
 *   report_index_coverage_p1169 stay green beside it). (Issue
 *   #3527 S4 update: the full sweep used to also ride this sync
 *   as an injected leg; it was unbundled to the reports workflow —
 *   the sweep test below now imports it from reportSemanticIndex
 *   and the sync-shape assertions pin its ABSENCE here. The
 *   invariant — every leg's outcome is surfaced honestly — is
 *   preserved for the two corpus legs that remain and for the
 *   sweep at its new home, tests/publish_stage_s4_3527.test.ts.)
 * - Route: GET /knowledge/integrity 401s without login (shared
 *   unauthenticatedResponse) and 200s with the integrity JSON shape
 *   when logged in — with NO flag check (flag-off env still 200s).
 * - Download button: SearchAgentTab renders it disabled with no
 *   results yet (component pin, jsdom + real React render).
 *
 * Red honesty: on the pristine tree this file fails at COLLECTION
 * (src/services/corpusSync.ts does not exist), the integrity route
 * returns null (no such branch), and no tab renders a Download
 * button — all three verified firsthand before implementation.
 */
import { describe, it, expect } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import {
  CORPUS_SYNC_LAST_RUN_KEY,
  CORPUS_SYNC_INTERVAL_MS,
  shouldFireCorpusSyncTick,
  runCorpusIntegrityCheck,
  runCorpusSync,
} from "../src/services/corpusSync";
import { sha256Hex } from "../src/services/knowledgeCorpus";
import { handleKnowledgeCorpusRoutes } from "../src/agents/routes/knowledgeCorpus";
import {
  runCanonicalIndexBackfillAll,
  runCanonicalIndexBackfillPage,
} from "../src/services/reportSemanticIndex";
import { SearchAgentTab } from "../src/client/search/tabs/SearchAgentTab";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

function stubBucket(
  pages: Array<Array<{ key: string; bytes: Uint8Array }>>
) {
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
 * Issue #1777 (Adapter S3): the BlobStore-shaped double for DIRECT
 * integrity/sync tests — the dep now takes a BlobStore. Route tests
 * below keep stubBucket as REPORTS_BUCKET, because production envs
 * carry a real R2Bucket and the route wraps it via createBlobStore.
 * Test titles and expectations are unchanged.
 */
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

describe("corpus integrity (S4-4)", () => {
  it("reports missing, mismatched, and extra keys exactly, and skips unseeded entries", async () => {
    const bytesOk = enc.encode("corpus bytes ok");
    const bytesTampered = enc.encode("corpus bytes tampered");
    const hOk = await sha256Hex(bytesOk);
    const hTamperedKey = await sha256Hex(enc.encode("original bytes"));
    const hMissing = await sha256Hex(enc.encode("never stored"));
    const hOrphan = await sha256Hex(enc.encode("record without object"));
    const hExtra = await sha256Hex(enc.encode("object without record"));
    const manifest = [
      { title: "ok doc", category: "options_disclosure", sha256: hOk, fetchStatus: "verified" },
      { title: "missing doc", category: "broker_rules", sha256: hMissing, fetchStatus: "verified" },
      { title: "orphaned record doc", category: "market_education", sha256: hOrphan, fetchStatus: "verified" },
      { title: "skipped doc", category: "sec_filing", sha256: null, fetchStatus: "blocked-by-source-bot-gate" },
    ];
    const records: Record<string, { contentHash: string }> = {
      [`knowledge:options_disclosure:${hOk}`]: { contentHash: hOk },
      [`knowledge:broker_rules:${hTamperedKey}`]: { contentHash: hTamperedKey },
      [`knowledge:market_education:${hOrphan}`]: { contentHash: hOrphan },
    };
    const bucket = stubBlobStore([
      [
        { key: `knowledge/options_disclosure/${hOk}`, bytes: bytesOk },
        { key: `knowledge/broker_rules/${hTamperedKey}`, bytes: bytesTampered },
      ],
      [
        { key: `knowledge/market_education/${hExtra}`, bytes: bytesOk },
        { key: "knowledge/junk", bytes: bytesOk },
      ],
    ]);
    const report = await runCorpusIntegrityCheck({
      manifest,
      recordStore: stubStore(records),
      bucket,
    });
    expect(report.ok).toBe(false);
    expect([...report.missing].sort()).toEqual(
      [`knowledge/broker_rules/${hMissing}`, `knowledge/market_education/${hOrphan}`].sort()
    );
    expect(report.mismatched).toEqual([`knowledge/broker_rules/${hTamperedKey}`]);
    expect([...report.extra].sort()).toEqual(
      [`knowledge/market_education/${hExtra}`, "knowledge/junk"].sort()
    );
    expect(typeof report.checkedAt).toBe("string");
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
    expect(report.reason).toBeUndefined();
  });

  it("reports ok when manifest, records, and objects all agree", async () => {
    const bytes = enc.encode("agreeing bytes");
    const h = await sha256Hex(bytes);
    const report = await runCorpusIntegrityCheck({
      manifest: [{ title: "doc", category: "options_disclosure", sha256: h, fetchStatus: "verified" }],
      recordStore: stubStore({ [`knowledge:options_disclosure:${h}`]: { contentHash: h } }),
      bucket: stubBlobStore([[{ key: `knowledge/options_disclosure/${h}`, bytes }]]),
    });
    // #1169 knowledge UI (disclosed §7 pin update): the report
    // gains the additive `entries` array; all old fields unchanged.
    expect(report).toEqual({
      ok: true,
      missing: [],
      mismatched: [],
      extra: [],
      checkedAt: report.checkedAt,
      entries: [
        { title: "doc", category: "options_disclosure", bucketKey: `knowledge/options_disclosure/${h}`, status: "present" },
      ],
    });
  });

  it("reports honestly (ok:false + reason, never fabricated lists) when the bucket is unbound", async () => {
    const report = await runCorpusIntegrityCheck({
      manifest: [{ title: "doc", category: "options_disclosure", sha256: "ab".repeat(32), fetchStatus: "verified" }],
      recordStore: stubStore({}),
      bucket: null,
    });
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([]);
    expect(report.mismatched).toEqual([]);
    expect(report.extra).toEqual([]);
    expect(typeof report.reason).toBe("string");
    expect((report.reason as string).length).toBeGreaterThan(0);
  });
});

describe("weekly corpus-sync guard (S4-4)", () => {
  it("fires when never fired, at exactly 7 days, and after 7 days", () => {
    const now = new Date("2026-10-28T12:00:00.000Z");
    expect(shouldFireCorpusSyncTick(now, null)).toEqual({ fire: true });
    expect(CORPUS_SYNC_LAST_RUN_KEY).toBe("corpus_sync_last_run");
    expect(CORPUS_SYNC_INTERVAL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const exactly7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldFireCorpusSyncTick(now, exactly7d)).toEqual({ fire: true });
    const eightDays = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldFireCorpusSyncTick(now, eightDays)).toEqual({ fire: true });
  });

  it("does not fire before 7 days, and self-heals on an unparseable marker", () => {
    const now = new Date("2026-10-28T12:00:00.000Z");
    const sixDays = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const d = shouldFireCorpusSyncTick(now, sixDays);
    expect(d.fire).toBe(false);
    if (!d.fire) expect(d.reason).toBe("too-soon");
    expect(shouldFireCorpusSyncTick(now, "not-a-date")).toEqual({ fire: true });
  });
});

describe("shared index backfill (S4-4 extraction)", () => {
  function stubSql(rows: Array<Record<string, unknown>>) {
    return {
      exec(query: string, ...args: unknown[]) {
        if (!String(query).includes("FROM mas_reports")) return [];
        const limit = typeof args[0] === "number" ? args[0] : 100;
        const offset = typeof args[1] === "number" ? args[1] : 0;
        return rows.slice(offset, offset + limit);
      },
    } as any;
  }

  const stubEnv = {
    AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
    VECTOR_MEMORY: { upsert: async () => {} },
  };

  it("counts upserted/skippedRetention/rows and paginates identically to the old inline route", async () => {
    const rows = [
      { id: "r1", title: "t1", source: "research_report", summary: "s", body: "", body_r2_key: null },
      { id: "r2", title: "t2", source: "retention", summary: "", body: "", body_r2_key: null },
    ];
    const page = await runCanonicalIndexBackfillPage(stubEnv, stubSql(rows), { limit: 2, offset: 0 });
    expect(page).toEqual({ upserted: 1, skippedRetention: 1, rows: 2, nextOffset: 2 });
    const tail = await runCanonicalIndexBackfillPage(stubEnv, stubSql(rows), { limit: 100, offset: 0 });
    expect(tail.nextOffset).toBeNull();
  });

  it("the full sweep loops pages and totals them", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `r${i}`,
      title: `t${i}`,
      source: i % 10 === 9 ? "retention" : "research_report",
      summary: "s",
      body: "",
      body_r2_key: null,
    }));
    const out = await runCanonicalIndexBackfillAll(stubEnv, stubSql(rows));
    expect(out).toEqual({
      upserted: 225,
      skippedRetention: 25,
      rows: 250,
      pages: 3,
      complete: true,
    });
  });

  it("the reports route handler still calls the shared page fn (source pin)", () => {
    const src = readFileSync("src/agents/routes/reports.ts", "utf8");
    expect(src).toContain("runCanonicalIndexBackfillPage(");
    expect(src).toContain("/trading/reports/index-backfill");
  });

  it("the sync result carries no reports-backfill leg after the #3527 S4 unbundle; completed semantics unchanged", async () => {
    // Disclosed §7 adaptation (#3527 S4): this pin used to assert
    // the injected reports-backfill leg's outcome surfaced on the
    // sync result. The leg left the bundle (its outcome now
    // surfaces from the sweep's own route — pinned in
    // publish_stage_s4_3527.test.ts); what remains invariant here
    // is the absence of the leg and the `completed` semantics.
    const result = await runCorpusSync({
      manifest: [],
      recordStore: stubStore({}),
      bucket: stubBlobStore([[]]),
    });
    expect("backfill" in result).toBe(false);
    expect(result.completed).toBe(true);
    const bucketMissing = await runCorpusSync({
      manifest: [],
      recordStore: stubStore({}),
      bucket: null,
    });
    expect("backfill" in bucketMissing).toBe(false);
    expect(bucketMissing.completed).toBe(false);
    expect(bucketMissing.integrity.ok).toBe(false);
  });
});

describe("GET /knowledge/integrity route (S4-4)", () => {
  it("401s without login via the shared unauthenticatedResponse", async () => {
    const res = await handleKnowledgeCorpusRoutes(
      new Request("https://agent.internal/api/knowledge/integrity"),
      new URL("https://agent.internal/api/knowledge/integrity"),
      "/api/knowledge/integrity",
      "s1",
      { env: {}, storage: stubStore({}), userLogin: "" } as any
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({
      success: false,
      error: "An authenticated E*TRADE account is required.",
    });
  });

  it("200s with the integrity JSON shape when logged in, with NO flag check", async () => {
    const res = await handleKnowledgeCorpusRoutes(
      new Request("https://agent.internal/api/knowledge/integrity"),
      new URL("https://agent.internal/api/knowledge/integrity"),
      "/api/knowledge/integrity",
      "s1",
      {
        // Deliberately NO KNOWLEDGE_SERVING_ENABLED: integrity is an
        // audit read, not serving, so the flag must not gate it.
        env: { REPORTS_BUCKET: stubBucket([[]]) },
        storage: stubStore({}),
        userLogin: "tester",
      } as any
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(typeof body.ok).toBe("boolean");
    expect(Array.isArray(body.missing)).toBe(true);
    expect(Array.isArray(body.mismatched)).toBe(true);
    expect(Array.isArray(body.extra)).toBe(true);
    expect(typeof body.checkedAt).toBe("string");
    // Empty stub store vs the real seed manifest: the three verified
    // entries are missing, so the honest report is ok:false.
    expect(body.ok).toBe(false);
  });
});

describe("POST /knowledge/corpus-sync branch (S4-4)", () => {
  function stubSyncSql() {
    let marker: string | null = null;
    return {
      getMarker: () => marker,
      exec(query: string, ...args: unknown[]) {
        const q = String(query);
        if (q.includes("CREATE TABLE")) return [];
        if (q.startsWith("SELECT value FROM mas_settings")) {
          return marker === null ? [] : [{ value: marker }];
        }
        if (q.startsWith("DELETE FROM mas_settings")) {
          marker = null;
          return [];
        }
        if (q.startsWith("INSERT INTO mas_settings")) {
          marker = typeof args[1] === "string" ? args[1] : null;
          return [];
        }
        if (q.includes("FROM mas_reports")) return [];
        return [];
      },
    } as any;
  }

  async function callSync(ctx: Record<string, unknown>) {
    return handleKnowledgeCorpusRoutes(
      new Request("https://agent.internal/knowledge/corpus-sync", { method: "POST" }),
      new URL("https://agent.internal/knowledge/corpus-sync"),
      "/knowledge/corpus-sync",
      "s1",
      ctx as any
    );
  }

  it("fires, writes the marker on a completed run, and skips while too soon", async () => {
    const sql = stubSyncSql();
    const ctx = {
      env: { REPORTS_BUCKET: stubBucket([[]]) },
      storage: stubStore({}),
      userLogin: "tester",
      sql,
    };
    const first = await callSync(ctx);
    expect(first!.status).toBe(200);
    const firstBody = (await first!.json()) as Record<string, any>;
    // The check EXECUTED (no reason) even though findings exist:
    // the three verified manifest entries are missing from the
    // empty store, so ok is false but completed is true — findings
    // are not failures, and the marker advances.
    expect(firstBody.completed).toBe(true);
    expect(firstBody.integrity.ok).toBe(false);
    expect(firstBody.integrity.missing).toHaveLength(3);
    // Issue #3527 S4: no reports-backfill accounting rides the
    // corpus-sync response anymore (the sweep answers from its
    // own route); the field is absent, not zeroed.
    expect("backfill" in firstBody).toBe(false);
    expect(sql.getMarker()).not.toBeNull();
    const second = await callSync(ctx);
    const secondBody = (await second!.json()) as Record<string, any>;
    expect(secondBody.skipped).toBe(true);
    expect(secondBody.reason).toBe("too-soon");
  });

  it("does NOT write the marker when the run could not check (no bucket)", async () => {
    const sql = stubSyncSql();
    const res = await callSync({
      env: {},
      storage: stubStore({}),
      userLogin: "tester",
      sql,
    });
    const body = (await res!.json()) as Record<string, any>;
    expect(body.completed).toBe(false);
    expect(body.integrity.ok).toBe(false);
    expect(typeof body.integrity.reason).toBe("string");
    expect(sql.getMarker()).toBeNull();
  });

  it("401s without login and skips honestly without sql", async () => {
    const anon = await callSync({
      env: {},
      storage: stubStore({}),
      userLogin: "",
      sql: stubSyncSql(),
    });
    expect(anon!.status).toBe(401);
    const noSql = await callSync({
      env: {},
      storage: stubStore({}),
      userLogin: "tester",
    });
    const body = (await noSql!.json()) as Record<string, any>;
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("report-store-unavailable");
  });
});

describe("search-tab Download button (S4-4)", () => {
  it("SearchAgentTab renders a Download button disabled with no results yet", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | null = null;
    try {
      await act(async () => {
        root = createRoot(container);
        root.render(React.createElement(SearchAgentTab, {}));
      });
      const buttons = Array.from(container.querySelectorAll("button"));
      const download = buttons.find((b) => b.textContent === "Download results (JSON)");
      expect(download).toBeTruthy();
      expect((download as HTMLButtonElement).disabled).toBe(true);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
  });
});
