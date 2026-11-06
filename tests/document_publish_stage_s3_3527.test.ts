/**
 * Issue #3527 S3 — the corpus publishes through the stage.
 *
 * S1/S2 put the reports' publish legs behind publishDocument
 * (src/services/documentPublish.ts). The corpus still fired its
 * AI Search items leg (#3345) by calling the hook
 * (indexCorpusDocInAiSearch) directly from its two call sites.
 * S3 adds the corpus member to the stage's document union and
 * routes both call sites through the stage, composing the
 * EXISTING hook as the stage's corpus ai-search executor.
 *
 * Part A — CHARACTERIZATION (green BEFORE and AFTER S3; these
 * pin the call sites' observable behaviour so the migration
 * is proven behaviour-preserving):
 *  A1. Upload route (POST /knowledge/corpus):
 *      - flag OFF -> 201 + indexing.state "not-configured",
 *        ZERO uploads;
 *      - flag key ABSENT from env -> same not-configured;
 *      - flag ON + binding ok -> 201 + indexing.state
 *        "indexed", exactly one upload under
 *        corpus:<bucketKey> with the corpus metadata, and the
 *        rest of the response body is the stored meta +
 *        idempotent flag, unchanged;
 *      - flag ON + binding absent -> "not-configured";
 *      - flag ON + upload throws -> STILL 201 (the hook never
 *        fails the write) + indexing.state "failed";
 *      - hash-idempotent replay -> 200 + idempotent:true, and
 *        the indexing leg fires again (state per flag) — the
 *        replay re-upload is the self-healing semantics.
 *  A2. Sync backfill leg (runCorpusAiSearchIndexBackfill —
 *      the function the corpus-sync route injects):
 *      - flag ON: present + hash-verified items indexed
 *        (manifest ∪ bucket-listed), missing -> failed /
 *        "missing", hash-mismatched -> failed / "mismatched"
 *        and NOT uploaded; counts match the items;
 *      - flag OFF: present items not-configured, ZERO uploads,
 *        missing/mismatched still failed with their reasons;
 *      - flag ON + upload throws for a present item -> that
 *        item failed with reason "upload_failed", counts
 *        reflect it, the leg never throws;
 *      - no bucket -> manifest candidates failed /
 *        "bucket-unavailable", nothing fabricated.
 *
 * Part B — STAGE CONTRACT (RED before S3: the stage's document
 * union has no corpus member, so a corpus document is published
 * as if it were a report and every assertion below fails):
 *  - a corpus document with default targets yields exactly
 *    ONE handle (ai-search) and the aggregate outcome carries
 *    kind "corpus" + the document id (the bucket key);
 *  - the stage's corpus executor is the injected hook: it is
 *    invoked with (env, { meta, bytes }) — the exact inputs
 *    the call sites pass the hook today;
 *  - outcome mapping is the hook's own state vocabulary,
 *    mapped 1:1 without loss: ok -> published;
 *    state "not-configured" (code "disabled" when the flag is
 *    off, code "not_configured" when the binding is absent)
 *    -> not_configured with the code carried verbatim;
 *    state "failed" -> failed with the executor's stable code
 *    AND error carried verbatim ("upload_failed",
 *    "invalid_input");
 *  - a rejecting executor double -> failed / "upload_failed";
 *    the stage never throws;
 *  - requesting report-only targets for a corpus document
 *    (r2-body, vectorize) settles them `not_attempted` — no
 *    corpus executor exists for them and none is invoked —
 *    while ai-search still runs; handles stay in canonical
 *    order;
 *  - REAL-executor equivalence: with no injected executor,
 *    a corpus publish through the stage performs exactly the
 *    upload a direct hook call performs (same document id,
 *    same content bytes, same metadata), and the stage status
 *    is the hook's state (published == "indexed").
 *
 * The corpus R2 write is deliberately NOT a stage target:
 * putKnowledgeDoc IS the corpus document store's put (it
 * computes the content-hash identity from the bytes, writes
 * them under knowledge/<category>/<sha256>, and records the
 * metadata — the document does not exist before the write,
 * and the write may fail the caller). See the S3 entry in
 * documentPublish.ts for the full reasoning; Part A pins the
 * write's behaviour through the route, unchanged.
 *
 * Doubles mirror tests/corpus_ai_search_indexing_p3345.test.ts.
 *
 * #CDO-mha7
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  publishDocument,
  type CorpusPublishDocument,
  type PublishDeps,
  type PublishTargetOutcome,
} from "../src/services/documentPublish";
import {
  indexCorpusDocInAiSearch,
  runCorpusAiSearchIndexBackfill,
  type CorpusAiSearchIndexOutcome,
} from "../src/services/corpusAiSearchIndex";
import {
  sha256Hex,
  type KnowledgeDocMeta,
} from "../src/services/knowledgeCorpus";
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

// ---------------------------------------------------------------------
// Part A1 — upload route characterization
// ---------------------------------------------------------------------

describe("A1. upload route characterization (#3527 S3)", () => {
  async function callUpload(
    env: Record<string, unknown>,
    storage = makeStorage()
  ) {
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
      { env, storage, userLogin: "tester" } as any
    );
  }

  it("flag OFF -> 201, indexing.state not-configured, ZERO uploads, meta body unchanged", async () => {
    const { bucket } = makeBucket();
    const { uploads, binding } = fakeNamespace();
    const res = await callUpload({
      REPORTS_BUCKET: bucket,
      AI_SEARCH: binding,
      AI_SEARCH_INSTANCE: INSTANCE,
    });
    expect(res!.status).toBe(201);
    const body = (await res!.json()) as Record<string, any>;
    const sha = await sha256Hex(HTML_BYTES);
    expect(body.success).toBe(true);
    expect(body.idempotent).toBe(false);
    expect(body.contentHash).toBe(sha);
    expect(body.r2Key).toBe(`knowledge/broker_rules/${sha}`);
    expect(body.title).toBe("FINRA Rule 4210 — Margin Requirements");
    expect(body.indexing).toEqual({ state: "not-configured" });
    expect(uploads).toHaveLength(0);
  });

  it("flag ON + binding ok -> 201, indexing.state indexed, one upload with corpus doc id + metadata", async () => {
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
    expect(uploads[0].metadata).toMatchObject({
      kind: "corpus",
      key: `knowledge/broker_rules/${sha}`,
      sha256: sha,
      title: "FINRA Rule 4210 — Margin Requirements",
      category: "broker_rules",
    });
    expect(uploads[0].content).toContain("Margin Requirements");
    expect(uploads[0].content).not.toContain("<html");
  });

  it("flag ON + binding absent -> 201, indexing.state not-configured", async () => {
    const { bucket } = makeBucket();
    const res = await callUpload({
      REPORTS_BUCKET: bucket,
      [FLAG]: "true",
    });
    expect(res!.status).toBe(201);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.indexing).toEqual({ state: "not-configured" });
  });

  it("flag ON + upload throws -> STILL 201 (the write never fails), indexing.state failed", async () => {
    const { bucket } = makeBucket();
    const { uploads, binding } = fakeNamespace({ failUpload: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await callUpload({
      REPORTS_BUCKET: bucket,
      AI_SEARCH: binding,
      AI_SEARCH_INSTANCE: INSTANCE,
      [FLAG]: "on",
    });
    expect(res!.status).toBe(201);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.indexing).toEqual({ state: "failed" });
    expect(uploads).toHaveLength(1);
  });

  it("idempotent replay -> 200 + idempotent:true, indexing leg fires again with the flag ON", async () => {
    const { bucket } = makeBucket();
    const { uploads, binding } = fakeNamespace();
    const storage = makeStorage();
    const env = {
      REPORTS_BUCKET: bucket,
      AI_SEARCH: binding,
      AI_SEARCH_INSTANCE: INSTANCE,
      [FLAG]: "1",
    };
    const first = await callUpload(env, storage);
    expect(first!.status).toBe(201);
    const second = await callUpload(env, storage);
    expect(second!.status).toBe(200);
    const body = (await second!.json()) as Record<string, any>;
    expect(body.idempotent).toBe(true);
    expect(body.indexing).toEqual({ state: "indexed" });
    // The replay re-uploads the SAME document id (self-healing).
    expect(uploads).toHaveLength(2);
    expect(uploads[1].name).toBe(uploads[0].name);
  });
});

// ---------------------------------------------------------------------
// Part A2 — sync backfill leg characterization
// ---------------------------------------------------------------------

describe("A2. sync backfill leg characterization (#3527 S3)", () => {
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

  it("flag ON: verified items indexed, missing/mismatched failed with reasons, counts exact", async () => {
    const { metaA, metaB, metaC, metaD, manifest, records, bucket } = await fixture();
    const { uploads, binding } = fakeNamespace();
    const out = await runCorpusAiSearchIndexBackfill(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: INSTANCE, [FLAG]: "1" },
      { manifest, recordStore: stubRecordStore(records), bucket: bucket as any }
    );
    const byKey = new Map(out.items.map((i) => [i.bucketKey, i]));
    expect(byKey.get(metaA.r2Key)?.state).toBe("indexed");
    expect(byKey.get(metaA.r2Key)?.docId).toBe(`corpus:${metaA.r2Key}`);
    expect(byKey.get(metaB.r2Key)?.state).toBe("indexed");
    expect(byKey.get(metaC.r2Key)?.state).toBe("failed");
    expect(byKey.get(metaC.r2Key)?.reason).toBe("missing");
    expect(byKey.get(metaD.r2Key)?.state).toBe("failed");
    expect(byKey.get(metaD.r2Key)?.reason).toBe("mismatched");
    expect(out.indexed).toBe(2);
    expect(out.failed).toBe(2);
    expect(out.notConfigured).toBe(0);
    expect(uploads.map((u) => u.name).sort()).toEqual(
      [`corpus:${metaA.r2Key}`, `corpus:${metaB.r2Key}`].sort()
    );
  });

  it("flag OFF: present items not-configured, ZERO uploads, failure reasons unchanged, counts exact", async () => {
    const { metaA, metaB, metaC, metaD, manifest, records, bucket } = await fixture();
    const { uploads, binding } = fakeNamespace();
    const out = await runCorpusAiSearchIndexBackfill(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: INSTANCE },
      { manifest, recordStore: stubRecordStore(records), bucket: bucket as any }
    );
    const byKey = new Map(out.items.map((i) => [i.bucketKey, i]));
    expect(byKey.get(metaA.r2Key)?.state).toBe("not-configured");
    expect(byKey.get(metaB.r2Key)?.state).toBe("not-configured");
    expect(byKey.get(metaA.r2Key)?.reason).toBeUndefined();
    expect(byKey.get(metaC.r2Key)?.state).toBe("failed");
    expect(byKey.get(metaC.r2Key)?.reason).toBe("missing");
    expect(byKey.get(metaD.r2Key)?.reason).toBe("mismatched");
    expect(out.indexed).toBe(0);
    expect(out.notConfigured).toBe(2);
    expect(out.failed).toBe(2);
    expect(uploads).toHaveLength(0);
  });

  it("flag ON + upload throws: the present item is failed with reason upload_failed, leg never throws", async () => {
    const { metaA, manifest, records, bucket } = await fixture();
    const { binding } = fakeNamespace({ failUpload: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const singleManifest = manifest.filter((m) => m.sha256 === metaA.contentHash);
    const singleRecords = {
      [`knowledge:broker_rules:${metaA.contentHash}`]: records[`knowledge:broker_rules:${metaA.contentHash}`],
    };
    const out = await runCorpusAiSearchIndexBackfill(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: INSTANCE, [FLAG]: "1" },
      {
        manifest: singleManifest,
        recordStore: stubRecordStore(singleRecords),
        bucket: stubBlobStore([{ key: metaA.r2Key, bytes: bytesA }]) as any,
      }
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0].state).toBe("failed");
    expect(out.items[0].reason).toBe("upload_failed");
    expect(out.failed).toBe(1);
    expect(out.indexed).toBe(0);
    void bucket;
  });

  it("no bucket: manifest candidates failed / bucket-unavailable, nothing fabricated", async () => {
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

// ---------------------------------------------------------------------
// Part B — stage contract for corpus documents
// ---------------------------------------------------------------------

describe("B. publish stage corpus contract (#3527 S3)", () => {
  async function corpusDoc(): Promise<CorpusPublishDocument> {
    const meta = await finraMeta();
    return {
      kind: "corpus",
      documentId: meta.r2Key,
      meta,
      bytes: HTML_BYTES,
    };
  }

  function targetOf(
    outcomes: PublishTargetOutcome[],
    target: string
  ): PublishTargetOutcome {
    const found = outcomes.find((t) => t.target === target);
    if (!found) throw new Error(`no outcome for target ${target}`);
    return found;
  }

  function depsReturning(
    outcome: Partial<CorpusAiSearchIndexOutcome> & { ok: boolean }
  ): { deps: PublishDeps; calls: Array<{ meta: KnowledgeDocMeta; bytes: Uint8Array }> } {
    const calls: Array<{ meta: KnowledgeDocMeta; bytes: Uint8Array }> = [];
    const deps: PublishDeps = {
      indexCorpusDocInAiSearch: async (_env, doc) => {
        calls.push(doc);
        return {
          state: outcome.ok ? "indexed" : "failed",
          correlationId: "corr-s3",
          ...outcome,
        } as CorpusAiSearchIndexOutcome;
      },
    };
    return { deps, calls };
  }

  it("default targets for a corpus document: exactly the ai-search handle; aggregate carries kind + document id", async () => {
    const doc = await corpusDoc();
    const { deps } = depsReturning({ ok: true });
    const handle = publishDocument({} as any, doc, deps);
    expect(handle.targets.map((t) => t.target)).toEqual(["ai-search"]);
    const aggregate = await handle.settled;
    expect(aggregate.kind).toBe("corpus");
    expect(aggregate.documentId).toBe(doc.meta.r2Key);
    expect(aggregate.targets).toHaveLength(1);
    expect(targetOf(aggregate.targets, "ai-search").status).toBe("published");
  });

  it("the stage invokes the corpus executor with (env, { meta, bytes }) verbatim", async () => {
    const doc = await corpusDoc();
    const { deps, calls } = depsReturning({ ok: true });
    const env = { AI_SEARCH_INSTANCE: INSTANCE } as any;
    const handle = publishDocument(env, doc, deps, { targets: ["ai-search"] });
    await handle.settled;
    expect(calls).toHaveLength(1);
    expect(calls[0].meta).toBe(doc.meta);
    expect(calls[0].bytes).toBe(doc.bytes);
  });

  it("hook ok -> published", async () => {
    const doc = await corpusDoc();
    const { deps } = depsReturning({ ok: true });
    const outcome = await publishDocument({} as any, doc, deps).settled;
    expect(targetOf(outcome.targets, "ai-search")).toEqual({
      target: "ai-search",
      status: "published",
    });
  });

  it('hook state "not-configured" with code "disabled" (flag off) -> not_configured, code carried', async () => {
    const doc = await corpusDoc();
    const { deps, calls } = depsReturning({ ok: false, code: "disabled", state: "not-configured" });
    const outcome = await publishDocument({} as any, doc, deps).settled;
    // The injected executor MUST be the one that produced the
    // outcome (pre-S3 the stage ignored it and the report hook's
    // own "disabled" coincidentally matched — calls proves it).
    expect(calls).toHaveLength(1);
    expect(targetOf(outcome.targets, "ai-search")).toEqual({
      target: "ai-search",
      status: "not_configured",
      code: "disabled",
    });
  });

  it('hook state "not-configured" with code "not_configured" (binding absent) -> not_configured, code carried verbatim', async () => {
    const doc = await corpusDoc();
    const { deps, calls } = depsReturning({ ok: false, code: "not_configured", state: "not-configured" });
    const outcome = await publishDocument({} as any, doc, deps).settled;
    expect(calls).toHaveLength(1);
    expect(targetOf(outcome.targets, "ai-search")).toEqual({
      target: "ai-search",
      status: "not_configured",
      code: "not_configured",
    });
  });

  it('hook state "failed" -> failed with the executor code AND error carried verbatim', async () => {
    const doc = await corpusDoc();
    const { deps } = depsReturning({
      ok: false,
      code: "invalid_input",
      state: "failed",
      error: "Corpus document key is not a servable corpus key.",
    });
    const outcome = await publishDocument({} as any, doc, deps).settled;
    expect(targetOf(outcome.targets, "ai-search")).toEqual({
      target: "ai-search",
      status: "failed",
      code: "invalid_input",
      error: "Corpus document key is not a servable corpus key.",
    });
  });

  it("a rejecting corpus executor -> failed / upload_failed; the stage never throws", async () => {
    const doc = await corpusDoc();
    const deps: PublishDeps = {
      indexCorpusDocInAiSearch: async () => {
        throw new Error("executor exploded");
      },
    };
    const outcome = await publishDocument({} as any, doc, deps).settled;
    expect(targetOf(outcome.targets, "ai-search")).toEqual({
      target: "ai-search",
      status: "failed",
      code: "upload_failed",
    });
  });

  it("report-only targets requested for a corpus document settle not_attempted; ai-search still runs; canonical order holds", async () => {
    const doc = await corpusDoc();
    const { deps } = depsReturning({ ok: true });
    const handle = publishDocument({} as any, doc, deps, {
      targets: ["ai-search", "vectorize", "r2-body"],
    });
    expect(handle.targets.map((t) => t.target)).toEqual([
      "r2-body",
      "vectorize",
      "ai-search",
    ]);
    const outcome = await handle.settled;
    expect(targetOf(outcome.targets, "r2-body").status).toBe("not_attempted");
    expect(targetOf(outcome.targets, "vectorize").status).toBe("not_attempted");
    expect(targetOf(outcome.targets, "ai-search").status).toBe("published");
  });

  it("REAL-executor equivalence: the stage performs exactly the upload a direct hook call performs", async () => {
    const doc = await corpusDoc();
    const viaStage = fakeNamespace();
    const stageEnv = {
      AI_SEARCH: viaStage.binding as any,
      AI_SEARCH_INSTANCE: INSTANCE,
      [FLAG]: "1",
    };
    const outcome = await publishDocument(stageEnv as any, doc).settled;
    expect(targetOf(outcome.targets, "ai-search").status).toBe("published");

    const direct = fakeNamespace();
    const hookOutcome = await indexCorpusDocInAiSearch(
      {
        AI_SEARCH: direct.binding as any,
        AI_SEARCH_INSTANCE: INSTANCE,
        [FLAG]: "1",
      },
      { meta: doc.meta, bytes: doc.bytes }
    );
    expect(hookOutcome.state).toBe("indexed");
    expect(viaStage.uploads).toHaveLength(1);
    expect(direct.uploads).toHaveLength(1);
    expect(viaStage.uploads[0].name).toBe(direct.uploads[0].name);
    expect(viaStage.uploads[0].content).toBe(direct.uploads[0].content);
    expect(viaStage.uploads[0].metadata).toEqual(direct.uploads[0].metadata);
  });
});
