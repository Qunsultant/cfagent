/**
 * Issue #3345 — search-side discipline for corpus items-API items.
 *
 * Corpus documents indexed through the items API (corpus bridge)
 * surface in the instance with chunk keys carrying the corpus
 * document id (`corpus:<bucketKey>`) and metadata kind "corpus".
 * Pins:
 *
 *  - Provenance rendering: the shared chunk mapping
 *    (mapAiSearchChunks, flag ON) resolves a corpus document id
 *    back to the servable bucket key, so the result carries
 *    bucketKey + servedFileLink + indexingState exactly like an
 *    R2-source corpus result does today; the MAS provenance
 *    attacher (attachCorpusProvenance) does the same for raw
 *    chunks. Flag OFF keeps the legacy mapping verbatim (no
 *    provenance fields at all).
 *  - Login discipline: corpus items are platform knowledge. The
 *    AiSearchAgent's report filter must NOT withhold a kind
 *    "corpus" result — not for an anonymous caller, not for a
 *    non-owner login — while a kind "report" result in the SAME
 *    answer stays withheld for anyone but its owner. (The
 *    not-withheld half already holds on the base tree: it is a
 *    regression pin. The provenance half is red on the base: the
 *    mapping keeps the `corpus:`-prefixed key and renders no
 *    served-file link.)
 */
import { describe, it, expect } from "vitest";
import { mapAiSearchChunks } from "../src/services/aiSearch";
import { attachCorpusProvenance } from "../src/services/knowledgeCorpus";
import { runAiSearchPaths } from "../src/agents/aiSearchPaths";

const SHA = "8325c286c06acdd7ac871874c9b071a123bac83a5baf678bc79bb19cd20e6a49";
const BUCKET_KEY = `knowledge/options_disclosure/${SHA}`;
const DOC_ID = `corpus:${BUCKET_KEY}`;

const CORPUS_CHUNK = {
  id: "cc1",
  type: "text",
  score: 0.82,
  // The shape mapAiSearchChunks consumes: REST chunks carry the
  // item key at top level; binding chunks carry it at item.key and
  // adaptAiSearchChunks lifts it to the same place.
  key: DOC_ID,
  text: "Characteristics and Risks of Standardized Options — the options disclosure document.",
  item: {
    key: DOC_ID,
    metadata: {
      title: "Characteristics and Risks of Standardized Options",
      kind: "corpus",
      key: BUCKET_KEY,
      sha256: SHA,
      category: "options_disclosure",
    },
  },
};

const REPORT_CHUNK = {
  id: "cc2",
  type: "text",
  score: 0.9,
  text: "Screen results: AAPL call spread matched.",
  item: {
    key: "report:rpt-1",
    metadata: {
      title: "Market screen — ALL",
      kind: "report",
      reportId: "rpt-1",
      ownerLogin: "alice",
    },
  },
};

describe("chunk mapping renders corpus provenance (#3345)", () => {
  it("flag ON: a corpus document-id key resolves to bucketKey + servedFileLink + indexed state", () => {
    const [item] = mapAiSearchChunks([CORPUS_CHUNK], true);
    expect(item.bucketKey).toBe(BUCKET_KEY);
    expect(item.servedFileLink).toBe(`/api/knowledge/file?key=${encodeURIComponent(BUCKET_KEY)}`);
    expect(item.indexingState).toBe("indexed");
    expect(item.title).toBe("Characteristics and Risks of Standardized Options");
    expect(item.category).toBe("options_disclosure");
  });

  it("flag ON: a plain R2 corpus key still renders as before (regression)", () => {
    const r2Chunk = {
      ...CORPUS_CHUNK,
      key: BUCKET_KEY,
      item: { ...CORPUS_CHUNK.item, key: BUCKET_KEY },
    };
    const [item] = mapAiSearchChunks([r2Chunk], true);
    expect(item.bucketKey).toBe(BUCKET_KEY);
    expect(item.servedFileLink).toBe(`/api/knowledge/file?key=${encodeURIComponent(BUCKET_KEY)}`);
  });

  it("flag OFF: the legacy mapping is verbatim — no provenance fields (regression)", () => {
    const [item] = mapAiSearchChunks([CORPUS_CHUNK], false);
    expect(item.bucketKey).toBeUndefined();
    expect(item.servedFileLink).toBeUndefined();
    expect(item.indexingState).toBeUndefined();
  });

  it("attachCorpusProvenance resolves a corpus document id to the servable key", () => {
    const out = attachCorpusProvenance({ key: DOC_ID, snippet: "…" }) as Record<string, unknown>;
    expect(out.bucketKey).toBe(BUCKET_KEY);
    expect(out.servedFileLink).toBe(`/api/knowledge/file?key=${encodeURIComponent(BUCKET_KEY)}`);
    expect(out.indexingState).toBe("indexed");
  });
});

describe("agent search: corpus items are platform knowledge (#3345)", () => {
  function namespaceEnv(chunks: unknown[]) {
    return {
      AI_SEARCH: {
        get: () => ({
          search: async () => ({ search_query: "q", chunks }),
        }),
      },
      AI_SEARCH_INSTANCE: "screener-search",
      KNOWLEDGE_SERVING_ENABLED: "1",
    } as any;
  }

  it("no callerLogin -> corpus served with provenance, report withheld", async () => {
    const result = await runAiSearchPaths(
      namespaceEnv([CORPUS_CHUNK, REPORT_CHUNK]),
      "standardized options"
    );
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results![0].bucketKey).toBe(BUCKET_KEY);
    expect(result.results![0].servedFileLink).toBe(
      `/api/knowledge/file?key=${encodeURIComponent(BUCKET_KEY)}`
    );
    expect(result.degraded ?? "").toContain("withheld");
  });

  it("non-owner callerLogin -> corpus still served, report still withheld", async () => {
    const result = await runAiSearchPaths(
      namespaceEnv([CORPUS_CHUNK, REPORT_CHUNK]),
      "standardized options",
      { callerLogin: "bob" }
    );
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results![0].bucketKey).toBe(BUCKET_KEY);
    expect(result.degraded ?? "").toContain("withheld");
  });

  it("owner callerLogin -> corpus AND report both served, no withholding note", async () => {
    const result = await runAiSearchPaths(
      namespaceEnv([CORPUS_CHUNK, REPORT_CHUNK]),
      "standardized options",
      { callerLogin: "alice" }
    );
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.degraded ?? "").not.toContain("withheld");
  });
});
