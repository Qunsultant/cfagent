import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  AiSearchInstanceService,
  mapAiSearchChunks,
  AiSearchMappingError,
} from "../src/services/aiSearch";
import {
  KNOWLEDGE_ERROR_CATALOG,
  KnowledgeErrorCode,
} from "../src/aspects/errorCodes";
import {
  putKnowledgeDoc,
  sha256Hex,
  isKnowledgeServingEnabled,
  parseKnowledgeBucketKey,
  servedFileLinkFor,
  verifySeedManifest,
} from "../src/services/knowledgeCorpus";
import { handleKnowledgeCorpusRoutes } from "../src/agents/routes/knowledgeCorpus";
import { createMAS } from "../src/agents/mas";

/**
 * #1169 (S2, flag-gated): index + serving behind KNOWLEDGE_SERVING_ENABLED.
 *
 * FLAG RULE (mirrors the IAAA_WIRING_ENABLED idiom in src/types.ts):
 * absent (or anything other than "1"/"true"/"on", case-insensitive) = OFF.
 * Flag-OFF behavior is EXACTLY today's behavior — the flag-OFF golden pins
 * below assert today's mapping verbatim, and the flag-OFF route pin asserts
 * fall-through (null). Flag-ON enables: the two aiSearch.ts mapping fixes,
 * the authenticated GET /knowledge/file serving route, and provenance.
 *
 * PROBE-DEPENDENT (read twice): the mapping pins assume the live-probe
 * chunk shape documented below. The real chunk shape is UNKNOWN until the
 * owner-dashboard Step 0 probe runs. If the probe chunk shape differs,
 * the mapping code + these pins MUST be adjusted before S2 closes.
 * Presenting probe-unverified mapping as proven is a report failure.
 * Assumed chunk shape (same endpoint both surfaces POST to):
 *   { key?: string; url?: string; score?: number; snippet?: string;
 *     item?: { id?: string;
 *              metadata?: { title?: string; description?: string;
 *                           category?: string } } }
 * S3 UPDATE (2026-11-04, user directive — fallback removal ahead of
 * the content probe): the fallback S2 did not touch (the
 * FINANCIAL_KNOWLEDGE_BASE constant + branch in aiSearch.ts) is
 * REMOVED by S3. The pins below that asserted the fallback verbatim
 * were adapted in place to the honest degraded contract (zero
 * results + an in-band `degraded` reason) at equal or greater
 * strength, and the S3 describe at the end of this file pins the
 * full failure matrix. G1 (two hardcoded score: 1.0 in
 * src/mcps/openaimp/commands.ts:120 and :150) is
 * untouched by S2 and named for S3.
 *
 * #3342 UPDATE (2026-11-06): the service's REST transport is
 * retired — AiSearchInstanceService is a deprecated shim that
 * never fetches, AI_SEARCH_ENDPOINT is deleted, and every consumer
 * reads the namespace binding. The pins that asserted the
 * transport (fetch URL/mechanics, fetch-through-service goldens,
 * the fetch failure matrix, the #3322 alias identity) were adapted
 * or retired in place, each marked inline; the mapping pins
 * (pure mapAiSearchChunks) and the corpus serving/seed pins are
 * untouched, and the migration contract is pinned in
 * tests/ai_search_rest_migration_p3342.test.ts.
 *
 * CROSS-CUTTING (user directive 2026-10-25, agentic-SaaS aspects):
 * - Typed errors: AiSearchMappingError (extends the aspects
 *   catalog's KnowledgeError) for malformed flag-ON chunks; the
 *   service rethrows it instead of returning a degraded response
 *   (visible failure, never stub substitution). Flag-OFF never
 *   throws (the lenient mapping is unchanged).
 * - Externalized messages: S2's new route/mapping messages live in
 *   KNOWLEDGE_ERROR_CATALOG (src/aspects/errorCodes.ts), reusing the
 *   ETradeError idiom; the shared 401 body is deliberately NOT
 *   forked into the catalog (it belongs to unauthenticatedResponse).
 * - Logs: console-stream idiom (loggingAspect.ts) with bracket
 *   prefixes; counts/statuses/codes only — never logins, keys,
 *   bytes, or full hashes (12-char prefixes at most).
 * - Config: the flag (Env) is S2's only knob; serving headers mirror
 *   GET /screener/report.pdf; the /api link prefix mirrors reportUrl.
 * - Transactions: S2's new code performs NO multi-write (GET is
 *   read-only; mapping/provenance/seed-verify are pure) — see report.
 * - Cloud: only existing seams (knowledgeCorpus, reportBlobStore,
 *   aspects); no new binding, no wrangler change, no CF API import.
 *
 * Fixture bytes are small synthetic markers, NOT corpus content.
 */

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

function makeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; options?: Record<string, unknown> }>();
  const bucket = {
    async put(key: string, value: Uint8Array, options?: Record<string, unknown>) {
      objects.set(key, { bytes: value, options });
    },
    async get(key: string) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        customMetadata: (obj.options?.customMetadata ?? {}) as Record<string, string>,
        async arrayBuffer() {
          return obj.bytes.buffer as ArrayBuffer;
        },
      };
    },
  } as unknown as R2Bucket;
  return { bucket, objects };
}

const LOGIN = "test-login";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const CORPUS_KEY = `knowledge/broker_rules/${SHA_A}`;
const BYTES = new Uint8Array([0x6b, 0x6e, 0x6f, 0x77, 0x2d, 0x64, 0x6f, 0x63]); // "know-doc"

const SCORED_CAT = {
  key: CORPUS_KEY,
  url: "https://example.com/doc",
  score: 0.73,
  snippet: "snip",
  item: { id: "doc-1", metadata: { title: "Doc One", description: "desc", category: "broker_rules" } },
};
const SCORELESS = {
  key: CORPUS_KEY,
  snippet: "snip",
  item: { id: "doc-2", metadata: { title: "Doc Two", description: "desc", category: "sec_filing" } },
};
const ZERO_SCORE = {
  key: CORPUS_KEY,
  score: 0,
  snippet: "snip",
  item: { id: "doc-3", metadata: { title: "Doc Three", description: "desc", category: "sec_filing" } },
};
const UNCAT = {
  key: CORPUS_KEY,
  score: 0.61,
  snippet: "snip",
  item: { id: "doc-4", metadata: { title: "Doc Four", description: "desc" } },
};
const NON_CORPUS = {
  key: "reports/abc123",
  score: 0.55,
  snippet: "snip",
  item: { id: "doc-5", metadata: { title: "Doc Five", description: "desc", category: "sec_filing" } },
};
const NO_KEY = {
  score: 0.5,
  snippet: "snip",
  item: { id: "doc-6", metadata: { title: "Doc Six", description: "desc", category: "sec_filing" } },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("#3322 broker-neutral service name (alias retired by #3342)", () => {
  it("the ETradeAISearchService alias is gone; AiSearchInstanceService remains as the deprecated shim", () => {
    // #3322 renamed the class and kept the old name one step as a
    // compatibility alias; #3342 retires the alias with the REST
    // transport it served (the issue's own sequencing). The class
    // itself stays importable as the deprecated shim whose
    // deprecation names its successor (gitops §22 / Policy Gate
    // check (j) are phrase-mechanical, so the pin reads the source).
    const source = readFileSync(
      new URL("../src/services/aiSearch.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toContain("ETradeAISearchService");
    expect(source).toContain("AiSearchInstanceService");
    expect(source).toContain("@deprecated");
    expect(source).toContain("superseded by");
  });
});

describe("#1169 S2 serving flag", () => {
  it("is on for 1/true/on (case-insensitive, trimmed) and off otherwise", () => {
    expect(isKnowledgeServingEnabled({ KNOWLEDGE_SERVING_ENABLED: "1" })).toBe(true);
    expect(isKnowledgeServingEnabled({ KNOWLEDGE_SERVING_ENABLED: "true" })).toBe(true);
    expect(isKnowledgeServingEnabled({ KNOWLEDGE_SERVING_ENABLED: "on" })).toBe(true);
    expect(isKnowledgeServingEnabled({ KNOWLEDGE_SERVING_ENABLED: "  TRUE  " })).toBe(true);
    expect(isKnowledgeServingEnabled({})).toBe(false);
    expect(isKnowledgeServingEnabled(undefined)).toBe(false);
    expect(isKnowledgeServingEnabled(null)).toBe(false);
    expect(isKnowledgeServingEnabled({ KNOWLEDGE_SERVING_ENABLED: "0" })).toBe(false);
    expect(isKnowledgeServingEnabled({ KNOWLEDGE_SERVING_ENABLED: "false" })).toBe(false);
    expect(isKnowledgeServingEnabled({ KNOWLEDGE_SERVING_ENABLED: "" })).toBe(false);
  });

  it("parses knowledge/ bucket keys and rejects everything else", () => {
    expect(parseKnowledgeBucketKey(CORPUS_KEY)).toEqual({ category: "broker_rules", sha256: SHA_A });
    expect(parseKnowledgeBucketKey("reports/abc123")).toBeNull();
    expect(parseKnowledgeBucketKey("knowledge/broker_rules/nothex")).toBeNull();
    expect(parseKnowledgeBucketKey("knowledge/nope/" + SHA_A)).toBeNull();
    expect(parseKnowledgeBucketKey("knowledge/broker_rules/" + SHA_A + "/extra")).toBeNull();
    expect(parseKnowledgeBucketKey(undefined)).toBeNull();
    expect(parseKnowledgeBucketKey(42)).toBeNull();
  });

  it("builds served-file links only for corpus keys", () => {
    expect(servedFileLinkFor(CORPUS_KEY)).toBe(
      `/api/knowledge/file?key=${encodeURIComponent(CORPUS_KEY)}`
    );
    expect(servedFileLinkFor("reports/abc123")).toBeUndefined();
    expect(servedFileLinkFor(undefined)).toBeUndefined();
  });
});

describe("#1169 S2 mapping — PROBE-DEPENDENT (see file header)", () => {
  it("flag-OFF reproduces today's mapping verbatim (golden)", () => {
    const out = mapAiSearchChunks(
      [SCORED_CAT, SCORELESS, ZERO_SCORE, UNCAT, NON_CORPUS, NO_KEY],
      false
    );
    expect(out).toEqual([
      { id: "doc-1", title: "Doc One", snippet: "snip", url: "https://example.com/doc", score: 0.73, category: "sec_filing" },
      { id: "doc-2", title: "Doc Two", snippet: "snip", url: CORPUS_KEY, score: 0.9, category: "sec_filing" },
      { id: "doc-3", title: "Doc Three", snippet: "snip", url: CORPUS_KEY, score: 0.9, category: "sec_filing" },
      { id: "doc-4", title: "Doc Four", snippet: "snip", url: CORPUS_KEY, score: 0.61, category: "sec_filing" },
      { id: "doc-5", title: "Doc Five", snippet: "snip", url: "reports/abc123", score: 0.55, category: "sec_filing" },
      { id: "doc-6", title: "Doc Six", snippet: "snip", url: undefined, score: 0.5, category: "sec_filing" },
    ]);
    for (const r of out) {
      expect(r).not.toHaveProperty("bucketKey");
      expect(r).not.toHaveProperty("servedFileLink");
      expect(r).not.toHaveProperty("indexingState");
    }
  });

  it("flag-ON preserves the true score and true category + provenance", () => {
    const [r] = mapAiSearchChunks([SCORED_CAT], true);
    expect(r.score).toBe(0.73);
    expect(r.category).toBe("broker_rules");
    expect(r.bucketKey).toBe(CORPUS_KEY);
    expect(r.servedFileLink).toBe(`/api/knowledge/file?key=${encodeURIComponent(CORPUS_KEY)}`);
    expect(r.indexingState).toBe("indexed");
  });

  it("flag-ON never defaults a missing score to 0.9 (undefined or zero stay true)", () => {
    const [scoreless, zero] = mapAiSearchChunks([SCORELESS, ZERO_SCORE], true);
    expect(scoreless.score).toBeUndefined();
    expect(zero.score).toBe(0);
  });

  it("flag-ON never forces sec_filing on an uncategorized chunk", () => {
    const [r] = mapAiSearchChunks([UNCAT], true);
    expect(r.category).toBeUndefined();
    expect(r.score).toBe(0.61);
  });

  it("flag-ON attaches a bucket key but no served link for non-corpus keys", () => {
    const [r] = mapAiSearchChunks([NON_CORPUS], true);
    expect(r.bucketKey).toBe("reports/abc123");
    expect(r.servedFileLink).toBeUndefined();
    expect(r.indexingState).toBe("indexed");
  });

  it("flag-ON with no key attaches neither bucket key nor served link", () => {
    const [r] = mapAiSearchChunks([NO_KEY], true);
    expect(r).not.toHaveProperty("bucketKey");
    expect(r).not.toHaveProperty("servedFileLink");
    expect(r.indexingState).toBe("indexed");
  });
});

function stubUpstreamFetch(chunks: unknown[], ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => ({ success: ok, result: { chunks } }),
  }));
}

describe("#1169 S2 service mapping (retired transport — #3342)", () => {
  // Retired by #3342: the two fetch-through-service golden tests
  // that lived here (flag-OFF deep-equals, flag-ON provenance)
  // pinned the service's REST transport end-to-end. The transport
  // is gone; the MAPPING they verified is pinned unchanged by the
  // pure mapAiSearchChunks describes above (flag-OFF golden,
  // flag-ON score/category/provenance), which never needed the
  // fetch. What remains of the service contract is the shim's
  // degraded answer, pinned by the two tests below and by
  // tests/ai_search_rest_migration_p3342.test.ts.

  it("flag-ON with no endpoint returns the degraded contract (S3: fallback removed)", async () => {
    // Adapted by #1169 S3 (user directive 2026-11-04): this pin
    // asserted the fallback verbatim; the fallback is removed, so
    // the pin now asserts the honest degraded contract at greater
    // strength (reason + zero results + honest provider). Against
    // the #3342 shim this is also the ONLY answer the class gives.
    const svc = new AiSearchInstanceService({ KNOWLEDGE_SERVING_ENABLED: "1" } as any);
    const res = await svc.searchFinancialDocs("nvidia 10k", 5);
    expect(res.provider).toBe("cloudflare_ai_search");
    expect(res.degraded).toBe("endpoint_not_configured");
    expect(res.results).toEqual([]);
    expect(res.totalMatches).toBe(0);
  });

  it("endpoint configured + fetch stubbed: still endpoint_not_configured, fetch never called (transport retired)", async () => {
    // Adapted by #3342 (was: "flag-ON with a failed endpoint
    // returns upstream_http_error"). There is no endpoint leg left
    // to fail: the shim ignores the legacy var entirely, so even a
    // stubbed 502 upstream is never consulted.
    const fetchMock = stubUpstreamFetch([], false, 502);
    vi.stubGlobal("fetch", fetchMock);
    const svc = new AiSearchInstanceService({
      AI_SEARCH_ENDPOINT: "https://search.example.test",
      KNOWLEDGE_SERVING_ENABLED: "1",
    } as any);
    const res = await svc.searchFinancialDocs("nvidia 10k", 5);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.provider).toBe("cloudflare_ai_search");
    expect(res.degraded).toBe("endpoint_not_configured");
    expect(res.results).toEqual([]);
    expect(res.totalMatches).toBe(0);
  });
});

// Retired by #3342: the "#1169 searchFinancialDocs primary search
// path" describe pinned the retired transport's fetch mechanics
// (URL ends in /search, trailing-slash normalization, success
// mapping through the fetch). The URL pins have no post-retirement
// equivalent — there is no fetch — and the success mapping is
// pinned by the pure mapAiSearchChunks describes above. The
// fetch-never-called half of the contract is pinned by the
// retired-transport test directly above.

describe("#1169 S2 serving route GET /knowledge/file", () => {
  let storage: ReturnType<typeof makeStorage>;
  let b: ReturnType<typeof makeBucket>;
  let hash: string;

  beforeEach(async () => {
    storage = makeStorage();
    b = makeBucket();
    hash = await sha256Hex(BYTES);
    await putKnowledgeDoc(
      { REPORTS_BUCKET: b.bucket },
      storage,
      LOGIN,
      { title: "Seed Doc", category: "broker_rules", sourceUrl: "https://example.com/doc", bytes: BYTES, contentType: "text/html", fileName: "seed-doc.html" }
    );
  });

  const getFile = (
    key: string | null,
    opts: { login?: string; flag?: string } = {}
  ) => {
    const u = new URL("https://example.com/api/knowledge/file");
    if (key !== null) u.searchParams.set("key", key);
    return handleKnowledgeCorpusRoutes(
      new Request(u.toString(), { method: "GET" }),
      u,
      "/api/knowledge/file",
      "sess-1",
      {
        env: {
          REPORTS_BUCKET: b.bucket,
          ...(opts.flag !== undefined ? { KNOWLEDGE_SERVING_ENABLED: opts.flag } : {}),
        } as any,
        storage,
        userLogin: opts.login ?? LOGIN,
      }
    );
  };

  it("flag-OFF falls through (null) — today's behavior, no such route", async () => {
    const res = await getFile(`knowledge/broker_rules/${hash}`, { login: LOGIN });
    expect(res).toBeNull();
  });

  it("flag-ON without login returns the shared 401", async () => {
    const res = await getFile(`knowledge/broker_rules/${hash}`, { login: "", flag: "1" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({
      success: false,
      error: "An authenticated E*TRADE account is required.",
    });
  });

  it("flag-ON serves exact R2 bytes with content headers", async () => {
    const res = await getFile(`knowledge/broker_rules/${hash}`, { flag: "1" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(BYTES);
    expect(res!.headers.get("Content-Type")).toBe("text/html");
    expect(res!.headers.get("Content-Disposition")).toBe('attachment; filename="seed-doc.html"');
    expect(res!.headers.get("Content-Length")).toBe(String(BYTES.length));
  });

  it("flag-ON returns 404 for an unknown key", async () => {
    const res = await getFile(`knowledge/broker_rules/${SHA_B}`, { flag: "1" });
    expect(res!.status).toBe(404);
  });

  it("flag-ON returns 404 for tampered bytes (hash-verified refusal)", async () => {
    b.objects.set(`knowledge/broker_rules/${hash}`, {
      bytes: new Uint8Array([0x00]),
      options: {},
    });
    const res = await getFile(`knowledge/broker_rules/${hash}`, { flag: "1" });
    expect(res!.status).toBe(404);
  });

  it("flag-ON returns 400 for a malformed key, a non-corpus key, and a missing key", async () => {
    expect((await getFile("knowledge/broker_rules/nothex", { flag: "1" }))!.status).toBe(400);
    expect((await getFile("reports/abc123", { flag: "1" }))!.status).toBe(400);
    expect((await getFile(null, { flag: "1" }))!.status).toBe(400);
  });

  it("POST /knowledge/corpus still works (S1 route untouched by S2)", async () => {
    let binary = "";
    for (const byte of BYTES) binary += String.fromCharCode(byte);
    const body = {
      title: "Second Doc",
      category: "sec_filing",
      sourceUrl: "https://example.com/second",
      contentBase64: btoa(binary),
    };
    const u = new URL("https://example.com/api/knowledge/corpus");
    const res = await handleKnowledgeCorpusRoutes(
      new Request(u.toString(), { method: "POST", body: JSON.stringify(body) }),
      u,
      "/api/knowledge/corpus",
      "sess-1",
      { env: { REPORTS_BUCKET: b.bucket } as any, storage, userLogin: LOGIN }
    );
    expect(res!.status).toBe(201);
  });
});

describe("#1169 S2 MAS provenance (flag-gated)", () => {
  // #3342: the tool's index leg reads the namespace binding. The
  // fake binding serves REST-shaped chunks (the binding adaptation
  // passes them through unchanged) or throws the way an unavailable
  // instance surfaces through the binding RPC. The provenance and
  // failure-shape assertions below are unchanged from the fetch era.
  const masEnv = (
    flag: string | undefined,
    behaviour: { chunks: unknown[] } | { throwMessage: string }
  ) => ({
    AI_SEARCH_INSTANCE: "screener-search",
    AI_SEARCH: {
      get: (_name: string) => ({
        search: async () => {
          if ("throwMessage" in behaviour) throw new Error(behaviour.throwMessage);
          return { chunks: behaviour.chunks };
        },
      }),
    },
    ...(flag !== undefined ? { KNOWLEDGE_SERVING_ENABLED: flag } : {}),
  });
  const masOpts = (env: unknown, sessionId: string) => ({
    env: env as any,
    sessionId,
    requestId: "req-1",
    sql: { exec: () => [] as unknown as Iterable<unknown> },
    audit: () => {},
  });

  it("flag-OFF passes upstream chunks through verbatim (today's shape)", async () => {
    const mas: any = createMAS(masOpts(masEnv(undefined, { chunks: [SCORED_CAT] }), "sess-off-1"));
    const res = await mas.searchKnowledge.execute({ query: "broker rules" });
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0]).toEqual(SCORED_CAT);
    expect(res.chunks[0]).not.toHaveProperty("bucketKey");
    expect(res.chunks[0]).not.toHaveProperty("servedFileLink");
  });

  it("flag-ON attaches provenance to corpus-keyed chunks, leaves report chunks alone", async () => {
    const mas: any = createMAS(masOpts(masEnv("1", { chunks: [SCORED_CAT, NON_CORPUS] }), "sess-on-1"));
    const res = await mas.searchKnowledge.execute({ query: "broker rules" });
    expect(res.chunks).toHaveLength(2);
    const [corpus, other] = res.chunks;
    expect(corpus.bucketKey).toBe(CORPUS_KEY);
    expect(corpus.servedFileLink).toBe(`/api/knowledge/file?key=${encodeURIComponent(CORPUS_KEY)}`);
    expect(corpus.indexingState).toBe("indexed");
    expect(corpus.score).toBe(0.73);
    expect(other.bucketKey).toBe("reports/abc123");
    expect(other.servedFileLink).toBeUndefined();
    expect(other.indexingState).toBe("indexed");
  });

  it("flag-ON keeps honest failure paths unchanged", async () => {
    const mas: any = createMAS(masOpts(masEnv("1", { throwMessage: "upstream 502" }), "sess-on-2"));
    const res = await mas.searchKnowledge.execute({ query: "broker rules" });
    // Today's shape for upstream-failure + zero reports is
    // { error, query } with no chunks field at all — the pin
    // asserts that shape, not a chunks: []. (#3342: the binding
    // failure detail stands where the HTTP status stood; the
    // fixture message carries the 502 so the assertion is the
    // fetch-era one verbatim.)
    expect(res.error).toMatch(/502/);
    expect(res).not.toHaveProperty("resultsFound");
  });
});

describe("#1169 S2 seed verification (manifest hash-check, stored != indexed)", () => {
  const entries = [
    { title: "FINRA 4210", category: "broker_rules", sha256: SHA_A, fetchStatus: "verified" },
    { title: "OCC Guide", category: "options_disclosure", sha256: SHA_B, fetchStatus: "verified" },
    { title: "NVIDIA 10-K", category: "sec_filing", sha256: null, fetchStatus: "blocked-by-source-bot-gate" },
  ];
  const stored = new Map([
    [`knowledge:broker_rules:${SHA_A}`, { contentHash: SHA_A }],
    [`knowledge:options_disclosure:${SHA_B}`, { contentHash: "c".repeat(64) }],
  ]);

  it("reports match / mismatch / missing distinctly", () => {
    const report = verifySeedManifest(entries as any, stored as any);
    expect(report.results).toEqual([
      expect.objectContaining({ title: "FINRA 4210", status: "match" }),
      expect.objectContaining({ title: "OCC Guide", status: "mismatch" }),
      expect.objectContaining({ title: "NVIDIA 10-K", status: "skipped-not-seeded" }),
    ]);
    expect(report.allMatch).toBe(false);
  });

  it("a fully matching set reports allMatch true", () => {
    const ok = verifySeedManifest(entries.slice(0, 1) as any, stored as any);
    expect(ok.allMatch).toBe(true);
  });

  it("never claims index confirmation: stored is not indexed", () => {
    const report = verifySeedManifest(entries.slice(0, 1) as any, stored as any);
    expect(report.indexConfirmed).toBe(false);
    expect(report.indexNote).toMatch(/probe/i);
  });
});

describe("#1169 S2 indexing-state honesty", () => {
  it("flag-ON index results carry indexingState indexed (index-returned means indexed)", () => {
    const [r] = mapAiSearchChunks([SCORED_CAT], true);
    expect(r.indexingState).toBe("indexed");
  });

  it("flag-OFF results carry no indexing claim at all", () => {
    const [r] = mapAiSearchChunks([SCORED_CAT], false);
    expect(r).not.toHaveProperty("indexingState");
  });
});

describe("#1169 S2 cross-cutting: mapping validation fails visibly (never defaults)", () => {
  // Flag-ON: a PRESENT-but-wrong-typed field throws a typed error
  // naming the chunk index and field. Absent fields stay absent
  // (covered by the earlier mapping pins) — only malformation throws.
  it("flag-ON throws AiSearchMappingError for a non-object chunk", () => {
    expect(() => mapAiSearchChunks(["not-an-object" as any], true)).toThrowError(AiSearchMappingError);
    try {
      mapAiSearchChunks(["not-an-object" as any], true);
    } catch (err: any) {
      expect(err.chunkIndex).toBe(0);
      expect(err.field).toBe("chunk");
      expect(err.code).toBe(KnowledgeErrorCode.MAPPING_INVALID_CHUNK);
    }
  });

  it("flag-ON throws naming the field for wrong-typed score / category / key", () => {
    expect(() => mapAiSearchChunks([{ ...SCORED_CAT, score: "high" } as any], true)).toThrowError(/score/);
    expect(() => mapAiSearchChunks([{ ...SCORED_CAT, key: 42 } as any], true)).toThrowError(/key/);
    expect(() =>
      mapAiSearchChunks([{ key: "knowledge/broker_rules/" + "a".repeat(64), item: { id: "d", metadata: { title: "T", category: 7 } } } as any], true)
    ).toThrowError(/category/);
    expect(() =>
      mapAiSearchChunks([{ key: "knowledge/broker_rules/" + "a".repeat(64), item: "oops" } as any], true)
    ).toThrowError(/item/);
  });

  it("flag-OFF never throws on the same malformed inputs (today's lenient mapping)", () => {
    expect(() => mapAiSearchChunks(["not-an-object" as any], false)).not.toThrow();
    expect(() => mapAiSearchChunks([{ ...SCORED_CAT, score: "high" } as any], false)).not.toThrow();
    // Lenient flag-OFF behavior is verbatim: a truthy string score
    // passes through the old `||` mapping (documented, not fixed —
    // flag-OFF is exactly today's behavior).
    const [r] = mapAiSearchChunks([{ ...SCORED_CAT, score: "high" } as any], false);
    expect((r as any).score).toBe("high");
  });

  // Retired by #3342: "flag-ON service rethrows instead of
  // degrading" pinned that a mapping error on the fetch path
  // rejects rather than resolving as stub/degraded output. The
  // fetch path is gone; the no-silent-substitution property now
  // lives in the mapping itself (the two pure pins directly above:
  // flag-ON throws AiSearchMappingError naming index + field) and
  // in the binding consumers' typed outcomes (a failed binding
  // search surfaces as search_failed / all_paths_failed, never as
  // fabricated rows — pinned in
  // tests/ai_search_rest_migration_p3342.test.ts).
  //
  // Retired by #3342: "flag-OFF service returns the degraded
  // contract on endpoint failure" — the endpoint-failure case has
  // no post-retirement equivalent; the shim's flag-independent
  // degraded answer (endpoint configured or not, fetch never
  // consulted) is pinned by the retired-transport test in the
  // service-mapping describe above.
});

describe("#1169 S2 cross-cutting: externalized catalog + route logs", () => {
  it("route 400/404 bodies equal the catalog defaultMessages (no inline literals)", async () => {
    const bucket = makeBucket();
    const storage = makeStorage();
    const call = async (key: string | null) => {
      const u = new URL("https://example.com/api/knowledge/file");
      if (key !== null) u.searchParams.set("key", key);
      return handleKnowledgeCorpusRoutes(
        new Request(u.toString(), { method: "GET" }), u, "/api/knowledge/file", "sess-cat",
        { env: { REPORTS_BUCKET: bucket, KNOWLEDGE_SERVING_ENABLED: "1" } as any, storage, userLogin: "u" }
      );
    };
    const missing = await call(null);
    expect(missing!.status).toBe(400);
    expect((await missing!.json() as any).error).toBe(
      KNOWLEDGE_ERROR_CATALOG[KnowledgeErrorCode.SERVING_KEY_REQUIRED].defaultMessage
    );
    const malformed = await call("reports/abc123");
    expect(malformed!.status).toBe(400);
    expect((await malformed!.json() as any).error).toBe(
      KNOWLEDGE_ERROR_CATALOG[KnowledgeErrorCode.SERVING_KEY_INVALID].defaultMessage
    );
    const unknown = await call(`knowledge/broker_rules/${"c".repeat(64)}`);
    expect(unknown!.status).toBe(404);
    expect((await unknown!.json() as any).error).toBe(
      KNOWLEDGE_ERROR_CATALOG[KnowledgeErrorCode.SERVING_NOT_FOUND].defaultMessage
    );
  });

  it("route 500 body equals the catalog message when the bucket is unbound", async () => {
    const u = new URL("https://example.com/api/knowledge/file?key=" + encodeURIComponent(`knowledge/broker_rules/${"d".repeat(64)}`));
    // No REPORTS_BUCKET + a meta row present => getKnowledgeDoc
    // throws => the route's 500 path (storage holds the meta row).
    const storage = makeStorage();
    await storage.put(`knowledge:broker_rules:${"d".repeat(64)}`, {
      r2Key: `knowledge/broker_rules/${"d".repeat(64)}`, contentHash: "d".repeat(64),
      title: "T", category: "broker_rules", sourceUrl: "https://example.com", contentType: "text/html", fileName: "t.html",
    });
    const res = await handleKnowledgeCorpusRoutes(
      new Request(u.toString(), { method: "GET" }), u, "/api/knowledge/file", "sess-500",
      { env: { KNOWLEDGE_SERVING_ENABLED: "1" } as any, storage, userLogin: "u" }
    );
    expect(res!.status).toBe(500);
    expect((await res!.json() as any).error).toBe(
      KNOWLEDGE_ERROR_CATALOG[KnowledgeErrorCode.SERVING_FAILED].defaultMessage
    );
  });

  it("serving logs carry status + code, never the login or the full key", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const bucket = makeBucket();
      const storage = makeStorage();
      const u = new URL("https://example.com/api/knowledge/file?key=" + encodeURIComponent("reports/abc123"));
      await handleKnowledgeCorpusRoutes(
        new Request(u.toString(), { method: "GET" }), u, "/api/knowledge/file", "sess-log",
        { env: { REPORTS_BUCKET: bucket, KNOWLEDGE_SERVING_ENABLED: "1" } as any, storage, userLogin: "some-login-value" }
      );
      const lines = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("[knowledgeServing]") && l.includes("status=400"))).toBe(true);
      expect(lines.some((l) => l.includes("some-login-value") || l.includes("reports/abc123"))).toBe(false);
      expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining("some-login-value"));
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("seed hash-check logs pass and fail lines (no bytes, no full hashes)", () => {
    // #3515 S3: the seed hash-check lines now travel as structured
    // knowledgeCorpus.seed_hash_check_* events (match/mismatch at their
    // own levels, summary at info) on the console-info JSON fallback,
    // not console.info/console.warn text lines.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const stored = new Map([
        [`knowledge:broker_rules:${"a".repeat(64)}`, { contentHash: "a".repeat(64) }],
        [`knowledge:options_disclosure:${"b".repeat(64)}`, { contentHash: "x".repeat(64) }],
      ]);
      verifySeedManifest(
        [
          { title: "Good Doc", category: "broker_rules", sha256: "a".repeat(64), fetchStatus: "verified" },
          { title: "Bad Doc", category: "options_disclosure", sha256: "b".repeat(64), fetchStatus: "verified" },
        ] as any,
        stored as any
      );
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
      const match = events.find((e) => e.operation === "knowledgeCorpus.seed_hash_check_match");
      expect(match).toBeDefined();
      expect(match?.level).toBe("info");
      expect(match?.fields.status).toBe("match");
      expect(String(match?.fields.message ?? "")).toContain("[knowledgeSeed]");
      const summary = events.find((e) => e.operation === "knowledgeCorpus.seed_hash_check_summary");
      expect(summary).toBeDefined();
      expect(summary?.level).toBe("info");
      expect(summary?.fields.allMatch).toBe(false);
      const mismatch = events.find((e) => e.operation === "knowledgeCorpus.seed_hash_check_mismatch");
      expect(mismatch).toBeDefined();
      expect(mismatch?.level).toBe("warn");
      expect(mismatch?.fields.status).toBe("mismatch");
      expect(String(mismatch?.fields.message ?? "")).toContain("[knowledgeSeed]");
      const all = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(all).not.toContain("a".repeat(64));
      expect(all).not.toContain("b".repeat(64));
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe("#1169 S3: honest degraded contract — the built-in fallback corpus is removed", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ENDPOINT = "https://search.example.test";

  it("endpoint unset -> degraded endpoint_not_configured, zero results, no stub rows", async () => {
    const svc = new AiSearchInstanceService({} as any);
    const res = await svc.searchFinancialDocs("pattern day trader");
    expect(res.degraded).toBe("endpoint_not_configured");
    expect(res.results).toEqual([]);
    expect(res.totalMatches).toBe(0);
    expect(res.provider).toBe("cloudflare_ai_search");
    expect(res.provider).not.toBe("semantic_cache");
  });

  it("endpoint set + fetch stubbed to throw -> STILL endpoint_not_configured, fetch never called (#3342 transport retired)", async () => {
    // Replaces the five fetch-failure cases that lived here
    // (fetch throws -> upstream_unreachable; HTTP 500 ->
    // upstream_http_error; non-JSON body / JSON without success /
    // JSON with no chunks array -> upstream_invalid_response):
    // those degraded reasons classified failures of a transport
    // that no longer exists. The shim never fetches, so every one
    // of those worlds now yields the single honest answer for a
    // retired path — endpoint_not_configured — and the fetch spy
    // proves the transport is really gone. The reason vocabulary
    // itself survives on the agent-shaped surfaces
    // (aiSearchAgentResultToQueryResponse maps runner outcomes
    // onto it; pinned in
    // tests/ai_search_rest_migration_p3342.test.ts).
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new AiSearchInstanceService({ AI_SEARCH_ENDPOINT: ENDPOINT } as any);
    const res = await svc.searchFinancialDocs("margin rules");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.degraded).toBe("endpoint_not_configured");
    expect(res.results).toEqual([]);
    expect(res.totalMatches).toBe(0);
    expect(res.provider).not.toBe("semantic_cache");
  });

  // Retired by #3342: the two success-path cases that lived here
  // ("/search success with chunks: [] -> ok, NOT degraded" and
  // "/search success with chunks -> mapped live results") pinned
  // the retired transport's served answers. Their contracts live
  // on at the surviving surfaces: served-empty stays ok (pinned
  // for the namespace leg in
  // tests/a2a_aisearch_dispatch_p2223.test.ts) and the chunk
  // mapping is pinned by the pure mapAiSearchChunks describes
  // above.
});
