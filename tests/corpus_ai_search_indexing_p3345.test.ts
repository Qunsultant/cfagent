/**
 * Issue #3345 — corpus items-API bridge (the S4-5 corpus bridge,
 * pulled forward): corpus documents are indexed into the AI Search
 * instance through the namespace binding's items API, reusing the
 * #2246 upload executor, so knowledge searches can return the
 * curated corpus with provenance.
 *
 * Pins:
 *  A. Flag reader (isAiSearchCorpusIndexingEnabled): the S2 idiom —
 *     "1"/"true"/"on" (case-insensitive, trimmed) = ON; absence or
 *     anything else = OFF. The var is deliberately NOT in
 *     wrangler.jsonc (absence = off).
 *  B. Document-id helpers: the corpus document id is
 *     `corpus:<bucketKey>`; the bucket key round-trips back out of
 *     an index key; non-corpus keys and malformed remainders yield
 *     null (never a guessed key).
 *  C. Indexing hook (indexCorpusDocInAiSearch), mirroring the
 *     report hook's never-throws discipline:
 *     - flag OFF -> state "not-configured" (code "disabled"), ZERO
 *       uploads, no throw;
 *     - flag ON + configured -> exactly one upload under the
 *       corpus document id, metadata {kind "corpus", key, sha256,
 *       storedAt, title, category, sourceUrl}, content = title +
 *       text derived from the served bytes (HTML stripped);
 *     - flag ON + binding absent -> state "not-configured"
 *       (code "not_configured"), no throw;
 *     - flag ON + upload throws -> state "failed"
 *       (code "upload_failed"), failure logged with the stable
 *       event code, document content NEVER logged;
 *     - re-indexing the same document re-uploads the SAME document
 *       id (the executor upserts by id — a changed document
 *       replaces its item; an unchanged one is a same-id
 *       overwrite, the report leg's redelivery semantics);
 *     - text derivation: HTML is stripped to text, plain text
 *       passes through, non-text bytes (the OCC PDF) contribute
 *       their title/source lines only — no lossy binary garbage.
 *  D. Sync backfill (runCorpusAiSearchIndexBackfill): the canonical
 *     corpus (seed-manifest documents ∪ listed knowledge/ items
 *     with records) is enumerated; present + hash-verified items
 *     are uploaded and reported "indexed"; missing items report
 *     "failed" (reason "missing"), hash-mismatched items report
 *     "failed" (reason "mismatched") and are NOT uploaded; with the
 *     flag off, present items report "not-configured" and nothing
 *     is uploaded; a re-run re-uploads the same document ids.
 *  E. Sync wiring (runCorpusSync): an injected corpusIndex leg's
 *     outcome is surfaced on the result; without the leg the
 *     result reports it skipped honestly; a throwing leg is
 *     surfaced as an honest failure outcome, never a throw.
 *  F. Routes: POST /knowledge/corpus fires the hook and reports
 *     `indexing.state` in the response (201 + "indexed" with the
 *     flag on; 201 + "not-configured" with it off, zero uploads);
 *     POST /knowledge/corpus-sync gains per-item indexing state in
 *     its response (`corpusIndex.items`).
 *
 * Red honesty: on the pristine tree this file fails at COLLECTION
 * (src/services/corpusAiSearchIndex.ts does not exist, and the new
 * exports do not exist) — verified firsthand before implementation.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isAiSearchCorpusIndexingEnabled,
} from "../src/agents/aiSearchPaths";
import {
  sha256Hex,
  AI_SEARCH_CORPUS_DOCUMENT_PREFIX,
  corpusIndexDocumentId,
  corpusBucketKeyFromIndexKey,
  type KnowledgeDocMeta,
} from "../src/services/knowledgeCorpus";
import {
  indexCorpusDocInAiSearch,
  runCorpusAiSearchIndexBackfill,
  deriveCorpusIndexText,
  AI_SEARCH_CORPUS_INDEX_FAILED,
} from "../src/services/corpusAiSearchIndex";
import { runCorpusSync } from "../src/services/corpusSync";
import { handleKnowledgeCorpusRoutes } from "../src/agents/routes/knowledgeCorpus";

afterEach(() => {
  vi.restoreAllMocks();
});

const enc = new TextEncoder();
const FLAG = "AI_SEARCH_CORPUS_INDEXING_ENABLED";
const INSTANCE = "screener-search";

type UploadCall = {
  name: string;
  content: string;
  metadata?: Record<string, unknown>;
};

/** Fake ai_search_namespaces binding whose instance records uploads. */
function fakeNamespace(opts: { failUpload?: boolean } = {}) {
  const uploads: UploadCall[] = [];
  const instance = {
    items: {
      upload: async (
        name: string,
        content: string,
        options?: { metadata?: Record<string, unknown> }
      ) => {
        uploads.push({ name, content, metadata: options?.metadata });
        if (opts.failUpload) throw new Error("instance items API unavailable");
        return { id: "item-1", key: name, status: "queued" };
      },
    },
  };
  return { uploads, binding: { get: (_name: string) => instance } };
}

const HTML_BYTES = enc.encode(
  "<html><head><style>.x{color:red}</style><script>track()</script></head>" +
    "<body><h1>Margin Requirements</h1><p>Rule 4210 &amp; the margin account.</p></body></html>"
);

async function finraMeta(bytes: Uint8Array = HTML_BYTES): Promise<KnowledgeDocMeta> {
  const sha = await sha256Hex(bytes);
  return {
    title: "FINRA Rule 4210 — Margin Requirements",
    category: "broker_rules",
    sourceUrl: "https://www.finra.org/rules-guidance/rulebooks/finra-rules/4210",
    ingestedAt: "2026-10-25T00:00:00.000Z",
    contentHash: sha,
    r2Key: `knowledge/broker_rules/${sha}`,
    fileName: "finra-rule-4210.html",
    contentType: "text/html",
  };
}

describe("A. flag reader (#3345)", () => {
  it("absent / empty / off values are OFF", () => {
    expect(isAiSearchCorpusIndexingEnabled({})).toBe(false);
    expect(isAiSearchCorpusIndexingEnabled({ [FLAG]: "" })).toBe(false);
    expect(isAiSearchCorpusIndexingEnabled({ [FLAG]: "0" })).toBe(false);
    expect(isAiSearchCorpusIndexingEnabled({ [FLAG]: "false" })).toBe(false);
    expect(isAiSearchCorpusIndexingEnabled({ [FLAG]: "off" })).toBe(false);
    expect(isAiSearchCorpusIndexingEnabled(null)).toBe(false);
    expect(isAiSearchCorpusIndexingEnabled(undefined)).toBe(false);
  });

  it('"1" / "true" / "on" (case-insensitive, trimmed) are ON', () => {
    expect(isAiSearchCorpusIndexingEnabled({ [FLAG]: "1" })).toBe(true);
    expect(isAiSearchCorpusIndexingEnabled({ [FLAG]: "true" })).toBe(true);
    expect(isAiSearchCorpusIndexingEnabled({ [FLAG]: "on" })).toBe(true);
    expect(isAiSearchCorpusIndexingEnabled({ [FLAG]: " TRUE " })).toBe(true);
    expect(isAiSearchCorpusIndexingEnabled({ [FLAG]: "On" })).toBe(true);
  });
});

describe("B. corpus document-id helpers (#3345)", () => {
  const sha = "c002adede1067c036a9c45e0321cfc0adf30b93fb79c5a55dadf1fc024adbd6c";
  const bucketKey = `knowledge/broker_rules/${sha}`;

  it("the document id is the corpus prefix + the bucket key", () => {
    expect(AI_SEARCH_CORPUS_DOCUMENT_PREFIX).toBe("corpus:");
    expect(corpusIndexDocumentId(bucketKey)).toBe(`corpus:${bucketKey}`);
  });

  it("the bucket key round-trips out of an index key", () => {
    expect(corpusBucketKeyFromIndexKey(`corpus:${bucketKey}`)).toBe(bucketKey);
  });

  it("non-corpus keys and malformed remainders yield null", () => {
    expect(corpusBucketKeyFromIndexKey(bucketKey)).toBeNull();
    expect(corpusBucketKeyFromIndexKey("report:rpt-1")).toBeNull();
    expect(corpusBucketKeyFromIndexKey("corpus:not-a-corpus-key")).toBeNull();
    expect(corpusBucketKeyFromIndexKey("corpus:knowledge/broker_rules/nothex")).toBeNull();
    expect(corpusBucketKeyFromIndexKey("")).toBeNull();
    expect(corpusIndexDocumentId("report:rpt-1")).toBeNull();
    expect(corpusIndexDocumentId("knowledge/unknown_category/" + sha)).toBeNull();
  });
});

describe("C. corpus indexing hook (#3345)", () => {
  it("flag OFF -> not-configured (disabled), ZERO uploads, no throw", async () => {
    const { uploads, binding } = fakeNamespace();
    const meta = await finraMeta();
    const outcome = await indexCorpusDocInAiSearch(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: INSTANCE },
      { meta, bytes: HTML_BYTES }
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("disabled");
    expect(outcome.state).toBe("not-configured");
    expect(uploads).toHaveLength(0);
  });

  it("flag ON + configured -> one upload, corpus document id, provenance metadata, derived text", async () => {
    const { uploads, binding } = fakeNamespace();
    const meta = await finraMeta();
    const outcome = await indexCorpusDocInAiSearch(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: INSTANCE, [FLAG]: "1" },
      { meta, bytes: HTML_BYTES }
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.state).toBe("indexed");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].name).toBe(`corpus:knowledge/broker_rules/${meta.contentHash}`);
    expect(uploads[0].metadata).toEqual({
      kind: "corpus",
      key: `knowledge/broker_rules/${meta.contentHash}`,
      sha256: meta.contentHash,
      storedAt: meta.ingestedAt,
      title: meta.title,
      category: "broker_rules",
      sourceUrl: meta.sourceUrl,
    });
    // Content = title + text derived from the served bytes, HTML stripped.
    expect(uploads[0].content).toContain("FINRA Rule 4210 — Margin Requirements");
    expect(uploads[0].content).toContain("Margin Requirements");
    expect(uploads[0].content).toContain("Rule 4210 & the margin account.");
    expect(uploads[0].content).not.toContain("<html");
    expect(uploads[0].content).not.toContain("track()");
  });

  it("derived text decodes entities in a single pass and strips malformed script closers (CodeQL #33/#34)", async () => {
    const { uploads, binding } = fakeNamespace();
    const bytes = enc.encode(
      "<html><body><script>secretScriptBody()</script foo>" +
        "<p>Escapes shown as &amp;lt;tag&amp;gt; stay escaped once.</p></body></html>"
    );
    const meta = await finraMeta(bytes);
    const outcome = await indexCorpusDocInAiSearch(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: INSTANCE, [FLAG]: "1" },
      { meta, bytes }
    );
    expect(outcome.ok).toBe(true);
    expect(uploads).toHaveLength(1);
    // Single-pass decoding: the source literal "&lt;" is text, not a tag.
    expect(uploads[0].content).toContain("shown as &lt;tag&gt; stay escaped once.");
    // A script closed by a malformed tag is still script, not document text.
    expect(uploads[0].content).not.toContain("secretScriptBody");
  });

  it("flag ON + binding absent -> not-configured, no throw, no upload", async () => {
    const meta = await finraMeta();
    const outcome = await indexCorpusDocInAiSearch(
      { [FLAG]: "true" },
      { meta, bytes: HTML_BYTES }
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("not_configured");
    expect(outcome.state).toBe("not-configured");
  });

  it("flag ON + upload throws -> failed state, logged with the stable code, content never logged", async () => {
    // #3515 S3: the failure now travels as a structured
    // indexCorpusDocInAiSearch.upload_failed event (level warn) on the
    // console-info JSON fallback, not a console.warn line. (The throw is
    // caught inside runAiSearchIndexUpload, which returns
    // { ok: false, code: "upload_failed" }, so the upload_failed branch
    // fires — not upload_threw.)
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { binding } = fakeNamespace({ failUpload: true });
    const meta = await finraMeta();
    const outcome = await indexCorpusDocInAiSearch(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: INSTANCE, [FLAG]: "on" },
      { meta, bytes: HTML_BYTES }
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("upload_failed");
    expect(outcome.state).toBe("failed");
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
    const failed = events.find((e) => e.operation === "indexCorpusDocInAiSearch.upload_failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("warn");
    expect(failed?.fields.eventCode).toBe(AI_SEARCH_CORPUS_INDEX_FAILED);
    expect(failed?.fields.code).toBe("upload_failed");
    expect(String(failed?.fields.message ?? "")).toContain(AI_SEARCH_CORPUS_INDEX_FAILED);
    expect(String(failed?.fields.message ?? "")).toContain("upload_failed");
    expect(String(failed?.fields.message ?? "")).not.toContain("margin account");
    expect(String(failed?.fields.error ?? "")).not.toContain("margin account");
  });

  it("re-indexing the same document re-uploads the SAME document id (upsert semantics)", async () => {
    const { uploads, binding } = fakeNamespace();
    const env = { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: INSTANCE, [FLAG]: "1" };
    const meta = await finraMeta();
    await indexCorpusDocInAiSearch(env, { meta, bytes: HTML_BYTES });
    await indexCorpusDocInAiSearch(env, { meta, bytes: HTML_BYTES });
    expect(uploads).toHaveLength(2);
    expect(uploads[1].name).toBe(uploads[0].name);
    expect(uploads[1].content).toBe(uploads[0].content);
    expect(uploads[1].metadata).toEqual(uploads[0].metadata);
  });
});

describe("C2. index-text derivation (#3345)", () => {
  it("plain text passes through under the title", async () => {
    const meta = await finraMeta(enc.encode("plain body text"));
    const text = deriveCorpusIndexText({ ...meta, contentType: "text/plain" }, enc.encode("plain body text"));
    expect(text).toContain(meta.title);
    expect(text).toContain("plain body text");
  });

  it("non-text bytes (PDF) contribute title/source lines only — no lossy garbage", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0xff, 0xfe, 0x00, 0x9d]);
    const meta = await finraMeta(pdfBytes);
    const text = deriveCorpusIndexText(
      { ...meta, contentType: "application/pdf" },
      pdfBytes
    );
    expect(text).toContain(meta.title);
    expect(text).toContain(meta.sourceUrl);
    expect(text).not.toContain("�");
  });
});

/** BlobStore-shaped double (the corpusSync test's shape). */
function stubBlobStore(objects: Array<{ key: string; bytes: Uint8Array }>) {
  return {
    async list() {
      return { keys: objects.map((o) => o.key), truncated: false, cursor: undefined };
    },
    async get(key: string) {
      const found = objects.find((o) => o.key === key);
      return found ? { bytes: found.bytes } : null;
    },
  };
}

function stubRecordStore(records: Record<string, KnowledgeDocMeta>) {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return records[key] as T | undefined;
    },
    async put(): Promise<void> {
      throw new Error("stub store is read-only");
    },
  };
}

async function metaFor(
  title: string,
  category: KnowledgeDocMeta["category"],
  bytes: Uint8Array,
  contentType = "text/html"
): Promise<KnowledgeDocMeta> {
  const sha = await sha256Hex(bytes);
  return {
    title,
    category,
    sourceUrl: "https://example.com/doc",
    ingestedAt: "2026-10-25T00:00:00.000Z",
    contentHash: sha,
    r2Key: `knowledge/${category}/${sha}`,
    fileName: "doc.html",
    contentType,
  };
}

describe("D. sync backfill leg (#3345)", () => {
  const bytesA = enc.encode("<html><body><p>Alpha corpus text</p></body></html>");
  const bytesB = enc.encode("<html><body><p>Beta corpus text</p></body></html>");
  const bytesD = enc.encode("<html><body><p>Delta original</p></body></html>");
  const bytesTampered = enc.encode("<html><body><p>Delta TAMPERED</p></body></html>");

  async function fixture() {
    const metaA = await metaFor("Alpha doc", "broker_rules", bytesA);
    const metaB = await metaFor("Beta doc", "market_education", bytesB);
    const metaC = await metaFor("Gamma doc (missing)", "options_disclosure", enc.encode("gamma"));
    const metaD = await metaFor("Delta doc (tampered)", "sec_filing", bytesD);
    const manifest = [
      { title: metaA.title, category: metaA.category, sha256: metaA.contentHash, fetchStatus: "verified" },
      { title: metaC.title, category: metaC.category, sha256: metaC.contentHash, fetchStatus: "verified" },
      { title: metaD.title, category: metaD.category, sha256: metaD.contentHash, fetchStatus: "verified" },
      { title: "Unseeded doc", category: "sec_filing", sha256: null, fetchStatus: "blocked-by-source-bot-gate" },
    ];
    const records: Record<string, KnowledgeDocMeta> = {
      [`knowledge:broker_rules:${metaA.contentHash}`]: metaA,
      [`knowledge:market_education:${metaB.contentHash}`]: metaB,
      [`knowledge:sec_filing:${metaD.contentHash}`]: metaD,
    };
    const bucket = stubBlobStore([
      { key: metaA.r2Key, bytes: bytesA },
      { key: metaB.r2Key, bytes: bytesB },
      { key: metaD.r2Key, bytes: bytesTampered },
    ]);
    return { metaA, metaB, metaC, metaD, manifest, records, bucket };
  }

  it("indexes present hash-verified items (manifest ∪ listed), reports missing/mismatched as failed", async () => {
    const { metaA, metaB, metaC, metaD, manifest, records, bucket } = await fixture();
    const { uploads, binding } = fakeNamespace();
    const out = await runCorpusAiSearchIndexBackfill(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: INSTANCE, [FLAG]: "1" },
      { manifest, recordStore: stubRecordStore(records), bucket: bucket as any }
    );
    const byKey = new Map(out.items.map((i) => [i.bucketKey, i]));
    expect(byKey.get(metaA.r2Key)?.state).toBe("indexed");
    expect(byKey.get(metaA.r2Key)?.docId).toBe(`corpus:${metaA.r2Key}`);
    // Beta is NOT in the manifest — a listed knowledge/ item with a
    // record is part of the canonical corpus for indexing.
    expect(byKey.get(metaB.r2Key)?.state).toBe("indexed");
    expect(byKey.get(metaC.r2Key)?.state).toBe("failed");
    expect(byKey.get(metaC.r2Key)?.reason).toBe("missing");
    expect(byKey.get(metaD.r2Key)?.state).toBe("failed");
    expect(byKey.get(metaD.r2Key)?.reason).toBe("mismatched");
    expect(out.indexed).toBe(2);
    expect(out.failed).toBe(2);
    expect(out.notConfigured).toBe(0);
    // Exactly the two present, verified documents were uploaded.
    expect(uploads.map((u) => u.name).sort()).toEqual(
      [`corpus:${metaA.r2Key}`, `corpus:${metaB.r2Key}`].sort()
    );
  });

  it("flag OFF -> present items not-configured, ZERO uploads; missing/mismatched still reported failed", async () => {
    const { metaA, metaC, manifest, records, bucket } = await fixture();
    const { uploads, binding } = fakeNamespace();
    const out = await runCorpusAiSearchIndexBackfill(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: INSTANCE },
      { manifest, recordStore: stubRecordStore(records), bucket: bucket as any }
    );
    const byKey = new Map(out.items.map((i) => [i.bucketKey, i]));
    expect(byKey.get(metaA.r2Key)?.state).toBe("not-configured");
    expect(byKey.get(metaC.r2Key)?.state).toBe("failed");
    expect(byKey.get(metaC.r2Key)?.reason).toBe("missing");
    expect(uploads).toHaveLength(0);
  });

  it("re-running the backfill re-uploads the same document ids (idempotent)", async () => {
    const { manifest, records, bucket } = await fixture();
    const { uploads, binding } = fakeNamespace();
    const env = { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: INSTANCE, [FLAG]: "1" };
    const deps = { manifest, recordStore: stubRecordStore(records), bucket: bucket as any };
    await runCorpusAiSearchIndexBackfill(env, deps);
    const firstRun = uploads.map((u) => u.name).sort();
    await runCorpusAiSearchIndexBackfill(env, deps);
    expect(uploads).toHaveLength(firstRun.length * 2);
    expect(uploads.slice(firstRun.length).map((u) => u.name).sort()).toEqual(firstRun);
  });

  it("no bucket -> manifest candidates report failed (bucket-unavailable), nothing fabricated", async () => {
    const { manifest, records } = await fixture();
    const { binding } = fakeNamespace();
    const out = await runCorpusAiSearchIndexBackfill(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: INSTANCE, [FLAG]: "1" },
      { manifest, recordStore: stubRecordStore(records), bucket: null }
    );
    expect(out.items.length).toBeGreaterThan(0);
    for (const item of out.items) {
      expect(item.state).toBe("failed");
      expect(item.reason).toBe("bucket-unavailable");
    }
    expect(out.indexed).toBe(0);
  });
});

describe("E. sync wiring (#3345)", () => {
  // Issue #3527 S4: baseDeps used to carry a stub `backfill` dep
  // (the reports sweep that rode the sync). The leg was unbundled
  // to the reports workflow, so the dep no longer exists; these
  // tests were always about the corpusIndex leg only.
  const baseDeps = {
    manifest: [],
    recordStore: stubRecordStore({}),
    bucket: stubBlobStore([]) as any,
  };

  it("an injected corpusIndex leg's outcome is surfaced on the sync result", async () => {
    const leg = {
      items: [
        { bucketKey: "knowledge/broker_rules/abc", docId: "corpus:knowledge/broker_rules/abc", sha256: "abc", state: "indexed" as const },
      ],
      indexed: 1,
      notConfigured: 0,
      failed: 0,
    };
    const result = await runCorpusSync({ ...baseDeps, corpusIndex: async () => leg });
    expect(result.corpusIndex).toEqual(leg);
  });

  it("without the leg, the sync result reports it skipped honestly", async () => {
    const result = await runCorpusSync({ ...baseDeps });
    expect(result.corpusIndex.skipped).toBe(true);
    expect(typeof result.corpusIndex.reason).toBe("string");
    expect(result.corpusIndex.items).toEqual([]);
  });

  it("a throwing leg is surfaced as an honest failure outcome, never a throw", async () => {
    const result = await runCorpusSync({
      ...baseDeps,
      corpusIndex: async () => {
        throw new Error("leg exploded");
      },
    });
    expect(result.completed).toBe(true);
    expect(result.corpusIndex.items).toEqual([]);
    expect(typeof result.corpusIndex.reason).toBe("string");
    expect(result.corpusIndex.reason).toContain("leg exploded");
  });
});

/** DO-record storage double (the r2 corpus test's shape). */
function makeStorage() {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
  };
}

/** R2 bucket double (the r2 corpus test's shape). */
function makeBucket() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, value: Uint8Array) {
      objects.set(key, value);
    },
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        customMetadata: {},
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        },
      };
    },
    async list() {
      return { objects: [...objects.keys()].map((key) => ({ key })), truncated: false };
    },
  } as unknown as R2Bucket;
  return { bucket, objects };
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe("F. routes (#3345)", () => {
  async function callUpload(env: Record<string, unknown>) {
    return handleKnowledgeCorpusRoutes(
      new Request("https://agent.internal/knowledge/corpus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "FINRA Rule 4210 — Margin Requirements",
          category: "broker_rules",
          sourceUrl: "https://www.finra.org/rules-guidance/rulebooks/finra-rules/4210",
          contentType: "text/html",
          contentBase64: b64(HTML_BYTES),
        }),
      }),
      new URL("https://agent.internal/knowledge/corpus"),
      "/knowledge/corpus",
      "s1",
      { env, storage: makeStorage(), userLogin: "tester" } as any
    );
  }

  it("POST /knowledge/corpus with the flag ON -> 201, indexing.state indexed, one corpus upload", async () => {
    const { bucket } = makeBucket();
    const { uploads, binding } = fakeNamespace();
    const res = await callUpload({
      REPORTS_BUCKET: bucket,
      AI_SEARCH: binding,
      AI_SEARCH_INSTANCE: INSTANCE,
      [FLAG]: "1",
    });
    expect(res!.status).toBe(201);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.indexing).toEqual({ state: "indexed" });
    const sha = await sha256Hex(HTML_BYTES);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].name).toBe(`corpus:knowledge/broker_rules/${sha}`);
    expect(uploads[0].metadata).toMatchObject({ kind: "corpus", sha256: sha });
  });

  it("POST /knowledge/corpus with the flag OFF -> 201, indexing.state not-configured, ZERO uploads", async () => {
    const { bucket } = makeBucket();
    const { uploads, binding } = fakeNamespace();
    const res = await callUpload({
      REPORTS_BUCKET: bucket,
      AI_SEARCH: binding,
      AI_SEARCH_INSTANCE: INSTANCE,
    });
    expect(res!.status).toBe(201);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.indexing).toEqual({ state: "not-configured" });
    expect(uploads).toHaveLength(0);
  });

  it("POST /knowledge/corpus-sync -> response carries per-item indexing state", async () => {
    const { bucket } = makeBucket();
    const { uploads, binding } = fakeNamespace();
    const sql = {
      exec(query: string, ...args: unknown[]) {
        const q = String(query);
        if (q.includes("CREATE TABLE")) return [];
        if (q.startsWith("SELECT value FROM mas_settings")) return [];
        if (q.startsWith("DELETE FROM mas_settings")) return [];
        if (q.startsWith("INSERT INTO mas_settings")) return [];
        if (q.includes("FROM mas_reports")) return [];
        return [];
      },
    } as any;
    const res = await handleKnowledgeCorpusRoutes(
      new Request("https://agent.internal/knowledge/corpus-sync", { method: "POST" }),
      new URL("https://agent.internal/knowledge/corpus-sync"),
      "/knowledge/corpus-sync",
      "s1",
      {
        env: {
          REPORTS_BUCKET: bucket,
          AI_SEARCH: binding,
          AI_SEARCH_INSTANCE: INSTANCE,
          [FLAG]: "1",
        },
        storage: makeStorage(),
        userLogin: "tester",
        sql,
      } as any
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.corpusIndex).toBeTruthy();
    // The real seed manifest has three hashed (verified) entries;
    // the stub bucket is empty, so each is honestly failed/missing
    // and nothing was uploaded.
    expect(body.corpusIndex.items).toHaveLength(3);
    for (const item of body.corpusIndex.items) {
      expect(item.state).toBe("failed");
      expect(item.reason).toBe("missing");
      expect(typeof item.docId).toBe("string");
      expect(item.docId.startsWith("corpus:")).toBe(true);
    }
    expect(uploads).toHaveLength(0);
  });
});
