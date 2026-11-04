import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ETradeAISearchService,
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
 * The fallback (FINANCIAL_KNOWLEDGE_BASE constant + branch, aiSearch.ts
 * :32-~73 / :129-150) is NOT touched by S2: flag-ON with no endpoint or
 * a failed endpoint still returns the fallback verbatim (pinned below).
 * G1 (two hardcoded score: 1.0 in src/mcps/openaimp/commands.ts:120 and :150) is
 * untouched by S2 and named for S3.
 *
 * CROSS-CUTTING (user directive 2026-10-25, agentic-SaaS aspects):
 * - Typed errors: AiSearchMappingError (extends the aspects
 *   catalog's KnowledgeError) for malformed flag-ON chunks; the
 *   service rethrows it PAST the fallback (visible failure, never
 *   stub substitution). Flag-OFF never throws (today's behavior).
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

describe("#1169 S2 service mapping (flag-gated, endpoint stubbed)", () => {
  it("flag-OFF service response deep-equals today's mapping (golden)", async () => {
    vi.stubGlobal("fetch", stubUpstreamFetch([SCORED_CAT, SCORELESS]));
    const svc = new ETradeAISearchService({ AI_SEARCH_ENDPOINT: "https://search.example.test" } as any);
    const res = await svc.searchFinancialDocs("broker rules", 5);
    expect(res.provider).toBe("cloudflare_ai_search");
    expect(res.results).toEqual([
      { id: "doc-1", title: "Doc One", snippet: "snip", url: "https://example.com/doc", score: 0.73, category: "sec_filing" },
      { id: "doc-2", title: "Doc Two", snippet: "snip", url: CORPUS_KEY, score: 0.9, category: "sec_filing" },
    ]);
  });

  it("flag-ON service response carries true score/category + provenance", async () => {
    vi.stubGlobal("fetch", stubUpstreamFetch([SCORED_CAT]));
    const svc = new ETradeAISearchService({
      AI_SEARCH_ENDPOINT: "https://search.example.test",
      KNOWLEDGE_SERVING_ENABLED: "1",
    } as any);
    const res = await svc.searchFinancialDocs("broker rules", 5);
    expect(res.results).toEqual([
      {
        id: "doc-1",
        title: "Doc One",
        snippet: "snip",
        url: "https://example.com/doc",
        score: 0.73,
        category: "broker_rules",
        bucketKey: CORPUS_KEY,
        servedFileLink: `/api/knowledge/file?key=${encodeURIComponent(CORPUS_KEY)}`,
        indexingState: "indexed",
      },
    ]);
  });

  it("flag-ON with no endpoint still returns the fallback verbatim (S3 owns it)", async () => {
    const svc = new ETradeAISearchService({ KNOWLEDGE_SERVING_ENABLED: "1" } as any);
    const res = await svc.searchFinancialDocs("nvidia 10k", 5);
    expect(res.provider).toBe("semantic_cache");
    expect(res.results.length).toBe(5);
    expect(res.results[0].id).toBe("sec_nvda_10k_2025");
  });

  it("flag-ON with a failed endpoint still returns the fallback verbatim", async () => {
    vi.stubGlobal("fetch", stubUpstreamFetch([], false, 502));
    const svc = new ETradeAISearchService({
      AI_SEARCH_ENDPOINT: "https://search.example.test",
      KNOWLEDGE_SERVING_ENABLED: "1",
    } as any);
    const res = await svc.searchFinancialDocs("nvidia 10k", 5);
    expect(res.provider).toBe("semantic_cache");
  });
});

describe("#1169 searchFinancialDocs primary search path", () => {
  it("calls the primary fetch with a URL ending in /search", async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { chunks: [SCORED_CAT] } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const svc = new ETradeAISearchService({ AI_SEARCH_ENDPOINT: "https://search.example.test" } as any);

    await svc.searchFinancialDocs("broker rules", 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://search.example.test/search");
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/search$/);
  });

  it("uses cloudflare_ai_search and mapped results when /search succeeds, not the fallback", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.endsWith("/search")) {
        return {
          ok: false,
          status: 302,
          json: async () => {
            throw new SyntaxError("Unexpected end of JSON input");
          },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { chunks: [SCORED_CAT] } }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new ETradeAISearchService({ AI_SEARCH_ENDPOINT: "https://search.example.test" } as any);

    const res = await svc.searchFinancialDocs("broker rules", 5);

    expect(res.provider).toBe("cloudflare_ai_search");
    expect(res.provider).not.toBe("semantic_cache");
    expect(res.totalMatches).toBe(1);
    expect(res.results).toEqual([
      { id: "doc-1", title: "Doc One", snippet: "snip", url: "https://example.com/doc", score: 0.73, category: "sec_filing" },
    ]);
  });

  it("normalizes a trailing slash so the URL has exactly one /search suffix", async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { chunks: [SCORED_CAT] } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const svc = new ETradeAISearchService({ AI_SEARCH_ENDPOINT: "https://search.example.test/" } as any);

    await svc.searchFinancialDocs("broker rules", 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://search.example.test/search");
    expect(fetchMock.mock.calls[0][0]).not.toContain(".test//search");
  });
});

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
  const masEnv = (flag?: string) => ({
    AI_SEARCH_ENDPOINT: "https://search.example.test",
    ...(flag !== undefined ? { KNOWLEDGE_SERVING_ENABLED: flag } : {}),
  });
  const masOpts = (flag: string | undefined, sessionId: string) => ({
    env: masEnv(flag) as any,
    sessionId,
    requestId: "req-1",
    sql: { exec: () => [] as unknown as Iterable<unknown> },
    audit: () => {},
  });

  it("flag-OFF passes upstream chunks through verbatim (today's shape)", async () => {
    vi.stubGlobal("fetch", stubUpstreamFetch([SCORED_CAT]));
    const mas: any = createMAS(masOpts(undefined, "sess-off-1"));
    const res = await mas.searchKnowledge.execute({ query: "broker rules" });
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0]).toEqual(SCORED_CAT);
    expect(res.chunks[0]).not.toHaveProperty("bucketKey");
    expect(res.chunks[0]).not.toHaveProperty("servedFileLink");
  });

  it("flag-ON attaches provenance to corpus-keyed chunks, leaves report chunks alone", async () => {
    vi.stubGlobal("fetch", stubUpstreamFetch([SCORED_CAT, NON_CORPUS]));
    const mas: any = createMAS(masOpts("1", "sess-on-1"));
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
    vi.stubGlobal("fetch", stubUpstreamFetch([], false, 502));
    const mas: any = createMAS(masOpts("1", "sess-on-2"));
    const res = await mas.searchKnowledge.execute({ query: "broker rules" });
    // Today's shape for non-ok + zero reports is { error, query } with no
    // chunks field at all — the pin asserts that shape, not a chunks: [].
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

  it("flag-ON service rethrows past the fallback (no stub substitution)", async () => {
    vi.stubGlobal("fetch", stubUpstreamFetch([
      { key: "knowledge/broker_rules/" + "a".repeat(64), score: "high", item: { id: "d1", metadata: { title: "T", category: "broker_rules" } } },
    ] as any));
    const svc = new ETradeAISearchService({ AI_SEARCH_ENDPOINT: "https://x.test", KNOWLEDGE_SERVING_ENABLED: "1" } as any);
    await expect(svc.searchFinancialDocs("broker rules", 5)).rejects.toThrowError(AiSearchMappingError);
    // The rejection is the proof: had the error fallen through to
    // the fallback, the promise would have RESOLVED with
    // provider "semantic_cache" instead of rejecting.
  });

  it("flag-OFF service still falls back on endpoint failure (behavior unchanged)", async () => {
    vi.stubGlobal("fetch", stubUpstreamFetch([], false, 502));
    const svc = new ETradeAISearchService({ AI_SEARCH_ENDPOINT: "https://x.test" } as any);
    const res = await svc.searchFinancialDocs("broker rules", 5);
    expect(res.provider).toBe("semantic_cache");
  });
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
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
      const infoLines = infoSpy.mock.calls.map((c) => String(c[0]));
      const warnLines = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(infoLines.some((l) => l.includes("[knowledgeSeed]") && l.includes("status=match"))).toBe(true);
      expect(infoLines.some((l) => l.includes("summary") && l.includes("allMatch=false"))).toBe(true);
      expect(warnLines.some((l) => l.includes("[knowledgeSeed]") && l.includes("status=mismatch"))).toBe(true);
      const all = [...infoLines, ...warnLines].join("\n");
      expect(all).not.toContain("a".repeat(64));
      expect(all).not.toContain("b".repeat(64));
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
