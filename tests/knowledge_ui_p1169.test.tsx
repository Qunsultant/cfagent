/** @vitest-environment jsdom */
/**
 * Issue #1169 knowledge-UI pins: the Corpus SearchHub tab (the panel
 * the S4 survey deferred as its own slice) plus the additive
 * per-entry manifest status on the integrity report.
 *
 * - The integrity report gains an additive `entries` array (one
 *   object per manifest entry: title, category, bucketKey, status).
 *   Old fields keep their exact meaning and shape — the S4-4 pins
 *   still validate beside the new ones (one S4-4 exact-shape pin
 *   gains the expected `entries` value as a disclosed §7 update).
 * - Per-entry status: present / missing / mismatched from the same
 *   check the report already runs; `not-ingested` for manifest rows
 *   with no recorded hash (e.g. the NVIDIA row, fetch blocked) —
 *   they were never ingested, so there is nothing to check, and
 *   forcing them into `missing` would misstate the check.
 *   Mismatched wins over missing when both apply (a record that
 *   disagrees with the manifest is wrong even if its object is
 *   also gone; re-ingest fixes both).
 * - On paths where the check could not run (no bucket, throw),
 *   entries is [] with the reason — the same empty-lists
 *   convention as the existing fields, never fabricated findings.
 * - Sync trigger: the too-soon skip shape is returned honestly.
 * - Upload: validation errors surface as 400s without touching
 *   the store.
 * - Corpus tab: renders in the hub tab list (label "Corpus") and
 *   its Download button is disabled until a report loads.
 *
 * Red honesty: on the pristine tree this file fails at COLLECTION
 * (CorpusTab does not exist) and the `entries` assertions fail
 * (the report has no such field) — both verified firsthand before
 * implementation.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { runCorpusIntegrityCheck } from "../src/services/corpusSync";
import { sha256Hex, KNOWLEDGE_CATEGORIES } from "../src/services/knowledgeCorpus";
import { handleKnowledgeCorpusRoutes } from "../src/agents/routes/knowledgeCorpus";
import { SearchHub, SEARCH_HUB_TABS } from "../src/client/search/SearchHub";
import { CorpusTab } from "../src/client/search/tabs/CorpusTab";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const enc = new TextEncoder();

function stubStore(records: Record<string, { contentHash: string }>) {
  const puts: Array<{ key: string }> = [];
  return {
    puts,
    async get<T>(key: string): Promise<T | undefined> {
      return records[key] as T | undefined;
    },
    async put(key: string): Promise<void> {
      puts.push({ key });
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
 * Issue #1777 (Adapter S3): BlobStore-shaped double for the DIRECT
 * integrity test below; route tests keep stubBucket as
 * REPORTS_BUCKET (production envs carry a real R2Bucket).
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

function stubSyncSql(initialMarker: string | null) {
  let marker: string | null = initialMarker;
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

let container: HTMLDivElement;
let root: Root | null = null;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  await flush();
}

function text() {
  return container.textContent || "";
}

function stubFetch(handler: (url: string, init?: any) => any) {
  (globalThis as any).fetch = vi.fn(async (url: string, init?: any) => handler(url, init));
}

const okJson = (body: any) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  vi.unstubAllGlobals();
  window.history.pushState(null, "/");
});

describe("integrity report additive entries (knowledge UI)", () => {
  it("keeps every old field and adds one entry per manifest entry", async () => {
    const bytesOk = enc.encode("entry bytes ok");
    const bytesTampered = enc.encode("entry bytes tampered");
    const hOk = await sha256Hex(bytesOk);
    const hTamperedKey = await sha256Hex(enc.encode("entry original"));
    const hMissing = await sha256Hex(enc.encode("entry never stored"));
    const manifest = [
      { title: "ok doc", category: "options_disclosure", sha256: hOk, fetchStatus: "verified" },
      { title: "missing doc", category: "broker_rules", sha256: hMissing, fetchStatus: "verified" },
      { title: "tampered doc", category: "market_education", sha256: hTamperedKey, fetchStatus: "verified" },
      { title: "blocked doc", category: "sec_filing", sha256: null, fetchStatus: "blocked-by-source-bot-gate" },
    ];
    const report = await runCorpusIntegrityCheck({
      manifest,
      recordStore: stubStore({
        [`knowledge:options_disclosure:${hOk}`]: { contentHash: hOk },
        [`knowledge:market_education:${hTamperedKey}`]: { contentHash: hTamperedKey },
      }),
      bucket: stubBlobStore([
        [
          { key: `knowledge/options_disclosure/${hOk}`, bytes: bytesOk },
          { key: `knowledge/market_education/${hTamperedKey}`, bytes: bytesTampered },
        ],
      ]),
    });
    // Old fields unchanged in meaning and shape.
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([`knowledge/broker_rules/${hMissing}`]);
    expect(report.mismatched).toEqual([`knowledge/market_education/${hTamperedKey}`]);
    expect(report.extra).toEqual([]);
    expect(typeof report.checkedAt).toBe("string");
    expect(report.reason).toBeUndefined();
    // Additive entries: one per manifest entry, in manifest order.
    expect(report.entries).toEqual([
      { title: "ok doc", category: "options_disclosure", bucketKey: `knowledge/options_disclosure/${hOk}`, status: "present" },
      { title: "missing doc", category: "broker_rules", bucketKey: `knowledge/broker_rules/${hMissing}`, status: "missing" },
      { title: "tampered doc", category: "market_education", bucketKey: `knowledge/market_education/${hTamperedKey}`, status: "mismatched" },
      { title: "blocked doc", category: "sec_filing", bucketKey: null, status: "not-ingested" },
    ]);
  });

  it("reports entries [] with the reason when the check could not run", async () => {
    const report = await runCorpusIntegrityCheck({
      manifest: [{ title: "doc", category: "options_disclosure", sha256: "ab".repeat(32), fetchStatus: "verified" }],
      recordStore: stubStore({}),
      bucket: null,
    });
    expect(report.ok).toBe(false);
    expect(typeof report.reason).toBe("string");
    expect(report.entries).toEqual([]);
  });
});

describe("sync trigger skip shape (knowledge UI)", () => {
  it("returns the too-soon skip honestly when the guard says too-soon", async () => {
    const res = await handleKnowledgeCorpusRoutes(
      new Request("https://agent.internal/knowledge/corpus-sync", { method: "POST" }),
      new URL("https://agent.internal/knowledge/corpus-sync"),
      "/knowledge/corpus-sync",
      "s1",
      {
        env: { REPORTS_BUCKET: stubBucket([[]]) },
        storage: stubStore({}),
        userLogin: "tester",
        sql: stubSyncSql(new Date().toISOString()),
      } as any
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("too-soon");
    expect(typeof body.lastFiredAt).toBe("string");
  });
});

describe("upload validation errors (knowledge UI)", () => {
  async function callUpload(body: unknown, store: ReturnType<typeof stubStore>) {
    return handleKnowledgeCorpusRoutes(
      new Request("https://agent.internal/knowledge/corpus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      new URL("https://agent.internal/knowledge/corpus"),
      "/knowledge/corpus",
      "s1",
      { env: {}, storage: store, userLogin: "tester" } as any
    );
  }

  it("400s on a missing title without touching the store", async () => {
    const store = stubStore({});
    const res = await callUpload(
      { category: "options_disclosure", sourceUrl: "https://example.com/doc.pdf", contentBase64: "aGVsbG8=" },
      store
    );
    expect(res!.status).toBe(400);
    expect(store.puts).toEqual([]);
  });

  it("400s on undecodable base64 without touching the store", async () => {
    const store = stubStore({});
    const res = await callUpload(
      { title: "doc", category: "options_disclosure", sourceUrl: "https://example.com/doc.pdf", contentBase64: "!!!not-base64!!!" },
      store
    );
    expect(res!.status).toBe(400);
    expect(store.puts).toEqual([]);
  });
});

describe("Corpus tab (knowledge UI)", () => {
  it("is registered in the hub tab list as corpus", () => {
    expect([...SEARCH_HUB_TABS]).toContain("corpus");
  });

  it("renders in the hub tab list with label Corpus", async () => {
    stubFetch((url) => {
      if (url === "/api/knowledge/integrity") {
        return okJson({ ok: true, missing: [], mismatched: [], extra: [], checkedAt: "2026-10-28T00:00:00.000Z", entries: [] });
      }
      return okJson({});
    });
    window.history.pushState(null, "", "/?tab=search&view=corpus");
    await render(<SearchHub />);
    expect(text()).toContain("Corpus");
  });

  it("Download button is disabled until a report loads", async () => {
    stubFetch(() => new Promise(() => {}));
    await render(<CorpusTab />);
    const buttons = Array.from(container.querySelectorAll("button"));
    const download = buttons.find((b) => (b.textContent || "").includes("Download report"));
    expect(download).toBeDefined();
    expect(download!.disabled).toBe(true);
  });

  it("category select offers exactly the service's KnowledgeCategory values", async () => {
    stubFetch(() => new Promise(() => {}));
    await render(<CorpusTab />);
    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    const values = Array.from(select!.querySelectorAll("option")).map((o) => o.value);
    expect(values).toEqual([...KNOWLEDGE_CATEGORIES]);
    // The file picker is the ui FileInput primitive, not a raw
    // control (the #1580 freeze gate forbids raw controls outside
    // components/ui); it still renders a native file input.
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
  });

  it("Download button enables and the report renders once loaded", async () => {
    const report = {
      ok: false,
      missing: ["knowledge/broker_rules/abc"],
      mismatched: [],
      extra: [],
      checkedAt: "2026-10-28T00:00:00.000Z",
      entries: [
        { title: "ok doc", category: "options_disclosure", bucketKey: "knowledge/options_disclosure/def", status: "present" },
        { title: "missing doc", category: "broker_rules", bucketKey: "knowledge/broker_rules/abc", status: "missing" },
      ],
    };
    stubFetch((url) => {
      if (url === "/api/knowledge/integrity") return okJson(report);
      return okJson({});
    });
    await render(<CorpusTab />);
    expect(text()).toContain("ok doc");
    expect(text()).toContain("missing doc");
    const buttons = Array.from(container.querySelectorAll("button"));
    const download = buttons.find((b) => (b.textContent || "").includes("Download report"));
    expect(download).toBeDefined();
    expect(download!.disabled).toBe(false);
  });
});
