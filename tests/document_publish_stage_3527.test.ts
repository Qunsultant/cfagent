// @vitest-environment node
/**
 * Issue #3527 S1 — NEW CONTRACT pins for the publish stage core
 * (src/services/documentPublish.ts). The stage composes the two
 * EXISTING report index executors — indexCanonicalReport
 * (Vectorize) and indexCanonicalReportInAiSearch (AI Search
 * items, #2246) — behind one publishDocument operation. These
 * pins were RED before the stage existed (module absent) and
 * pin:
 *
 *  A. Vectorize target: the stage precomputes attempted-ness
 *     exactly as the store seam did (bindings present + source
 *     not excluded) because the executor's boolean conflates
 *     not-attempted with failed; not-attempted NEVER invokes
 *     the executor; executor true -> published, false -> failed,
 *     rejection -> failed, synchronous throw -> failed (the
 *     stage never throws, across any boundary).
 *  B. AI Search target: the hook owns its enablement gate; the
 *     stage maps its outcome vocabulary without loss —
 *     ok -> published; code "disabled" -> not_configured
 *     (carrying the code); any other code -> failed (carrying
 *     the executor's stable code verbatim, including its own
 *     "not_configured" token when the flag is ON but the
 *     binding is absent); a rejecting hook -> failed with
 *     code "upload_failed" (the token the seam's rejection
 *     handler has always recorded).
 *  C. Handle shape: publishDocument returns synchronously with
 *     one settle handle per target in declaration order
 *     (vectorize, ai-search); each target settles independently
 *     (the seam records each leg as IT settles); the aggregate
 *     settles when all targets have, and never rejects.
 *  D. Payload equivalence through the REAL executors: the
 *     vector upsert (id `report:<id>`, metadata) and the items
 *     upload (id, title + buildCanonicalIndexText content,
 *     provenance metadata) are byte-identical to what the
 *     pre-stage legs produced at the seams.
 *
 * #CDO-mha7
 */
import { describe, expect, it, vi } from "vitest";

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
  publishDocument,
  type PublishDeps,
  type PublishDocumentInput,
  type PublishTargetOutcome,
} from "../src/services/documentPublish";
import type { CanonicalReportForIndex } from "../src/services/reportSemanticIndex";
import type {
  CanonicalReportForAiSearchIndex,
  ReportAiSearchIndexOutcome,
} from "../src/services/reportAiSearchIndex";

const DOC: PublishDocumentInput = {
  kind: "report",
  documentId: "rep-3527-1",
  title: "Fan-out contract report",
  source: "screener",
  summary: "Scanned 10 symbols, 2 matched.",
  body: JSON.stringify({
    opportunities: [{ symbol: "NVDA", structure: "call spread" }],
  }),
  bodyR2Key: null,
  runId: "screener:2026-11-06T00:00:00Z",
  ownerLogin: "tenant@example.com",
  storedAt: "2026-11-06T00:00:00.000Z",
};

const EXPECTED_VECTORIZE_PAYLOAD: CanonicalReportForIndex = {
  reportId: "rep-3527-1",
  title: "Fan-out contract report",
  source: "screener",
  summary: "Scanned 10 symbols, 2 matched.",
  body: DOC.body,
  bodyR2Key: null,
};

const EXPECTED_AI_PAYLOAD: CanonicalReportForAiSearchIndex = {
  ...EXPECTED_VECTORIZE_PAYLOAD,
  runId: "screener:2026-11-06T00:00:00Z",
  ownerLogin: "tenant@example.com",
  storedAt: "2026-11-06T00:00:00.000Z",
};

const FULL_ENV = {
  AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
  VECTOR_MEMORY: { upsert: async () => {} },
} as never;

function targetOf(
  outcomes: PublishTargetOutcome[],
  target: string,
): PublishTargetOutcome {
  const found = outcomes.find((t) => t.target === target);
  if (!found) throw new Error(`no outcome for target ${target}`);
  return found;
}

describe("3527 S1 stage: vectorize target outcome mapping", () => {
  it("executor true -> published, with the exact pre-stage executor payload", async () => {
    const seen: Array<{ env: unknown; report: CanonicalReportForIndex }> = [];
    const deps: PublishDeps = {
      indexCanonicalReport: async (env, report) => {
        seen.push({ env, report });
        return true;
      },
      indexCanonicalReportInAiSearch: async () => ({
        ok: false,
        code: "disabled",
        correlationId: "c-1",
      }),
    };
    const outcome = await publishDocument(FULL_ENV, DOC, deps).settled;
    expect(targetOf(outcome.targets, "vectorize")).toEqual({
      target: "vectorize",
      status: "published",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].report).toEqual(EXPECTED_VECTORIZE_PAYLOAD);
    expect(seen[0].env).toBe(FULL_ENV);
  });

  it("executor false -> failed", async () => {
    const deps: PublishDeps = {
      indexCanonicalReport: async () => false,
      indexCanonicalReportInAiSearch: async () => ({
        ok: false,
        code: "disabled",
        correlationId: "c-1",
      }),
    };
    const outcome = await publishDocument(FULL_ENV, DOC, deps).settled;
    expect(targetOf(outcome.targets, "vectorize")).toEqual({
      target: "vectorize",
      status: "failed",
    });
  });

  it("executor rejection -> failed, and the stage does not throw", async () => {
    const deps: PublishDeps = {
      indexCanonicalReport: async () => {
        throw new Error("vectorize boom");
      },
      indexCanonicalReportInAiSearch: async () => ({
        ok: false,
        code: "disabled",
        correlationId: "c-1",
      }),
    };
    const outcome = await publishDocument(FULL_ENV, DOC, deps).settled;
    expect(targetOf(outcome.targets, "vectorize").status).toBe("failed");
  });

  it("executor synchronous throw -> failed, publishDocument itself never throws", async () => {
    const deps: PublishDeps = {
      indexCanonicalReport: (() => {
        throw new Error("sync boom");
      }) as never,
      indexCanonicalReportInAiSearch: async () => ({
        ok: false,
        code: "disabled",
        correlationId: "c-1",
      }),
    };
    let handle!: ReturnType<typeof publishDocument>;
    expect(() => {
      handle = publishDocument(FULL_ENV, DOC, deps);
    }).not.toThrow();
    const outcome = await handle.settled;
    expect(targetOf(outcome.targets, "vectorize").status).toBe("failed");
  });

  it("bindings absent -> not_attempted and the executor is never invoked", async () => {
    const spy = vi.fn(async () => true);
    const deps: PublishDeps = {
      indexCanonicalReport: spy as never,
      indexCanonicalReportInAiSearch: async () => ({
        ok: false,
        code: "disabled",
        correlationId: "c-1",
      }),
    };
    for (const env of [
      undefined,
      {} as never,
      { AI: { run: async () => ({ data: [[0.1, 0.2]] }) } } as never,
      { VECTOR_MEMORY: { upsert: async () => {} } } as never,
    ]) {
      const outcome = await publishDocument(env, DOC, deps).settled;
      expect(targetOf(outcome.targets, "vectorize")).toEqual({
        target: "vectorize",
        status: "not_attempted",
      });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("excluded source -> not_attempted and the executor is never invoked", async () => {
    const spy = vi.fn(async () => true);
    const deps: PublishDeps = {
      indexCanonicalReport: spy as never,
      indexCanonicalReportInAiSearch: async () => ({
        ok: false,
        code: "disabled",
        correlationId: "c-1",
      }),
    };
    const outcome = await publishDocument(
      FULL_ENV,
      { ...DOC, source: "retention" },
      deps,
    ).settled;
    expect(targetOf(outcome.targets, "vectorize").status).toBe("not_attempted");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("3527 S1 stage: ai-search target outcome mapping", () => {
  const vecOk: PublishDeps["indexCanonicalReport"] = async () => true;

  it("hook ok -> published, with the exact pre-stage hook payload (provenance carried)", async () => {
    const seen: Array<{ env: unknown; report: CanonicalReportForAiSearchIndex }> =
      [];
    const deps: PublishDeps = {
      indexCanonicalReport: vecOk,
      indexCanonicalReportInAiSearch: async (env, report) => {
        seen.push({ env, report });
        return { ok: true, path: "namespace", correlationId: "c-2" };
      },
    };
    const outcome = await publishDocument(FULL_ENV, DOC, deps).settled;
    expect(targetOf(outcome.targets, "ai-search")).toEqual({
      target: "ai-search",
      status: "published",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].report).toEqual(EXPECTED_AI_PAYLOAD);
    expect(seen[0].env).toBe(FULL_ENV);
  });

  it("hook disabled -> not_configured carrying the disabled code", async () => {
    const deps: PublishDeps = {
      indexCanonicalReport: vecOk,
      indexCanonicalReportInAiSearch: async () => ({
        ok: false,
        code: "disabled",
        correlationId: "c-3",
      }),
    };
    const outcome = await publishDocument(FULL_ENV, DOC, deps).settled;
    expect(targetOf(outcome.targets, "ai-search")).toEqual({
      target: "ai-search",
      status: "not_configured",
      code: "disabled",
    });
  });

  it("hook not_configured (flag on, binding absent) -> failed carrying the executor code verbatim", async () => {
    const deps: PublishDeps = {
      indexCanonicalReport: vecOk,
      indexCanonicalReportInAiSearch: async () =>
        ({
          ok: false,
          code: "not_configured",
          correlationId: "c-4",
          error: "not configured",
        }) as ReportAiSearchIndexOutcome,
    };
    const outcome = await publishDocument(FULL_ENV, DOC, deps).settled;
    expect(targetOf(outcome.targets, "ai-search")).toEqual({
      target: "ai-search",
      status: "failed",
      code: "not_configured",
    });
  });

  it("hook upload_failed / invalid_input -> failed carrying the code", async () => {
    for (const code of ["upload_failed", "invalid_input"] as const) {
      const deps: PublishDeps = {
        indexCanonicalReport: vecOk,
        indexCanonicalReportInAiSearch: async () =>
          ({
            ok: false,
            code,
            correlationId: "c-5",
          }) as ReportAiSearchIndexOutcome,
      };
      const outcome = await publishDocument(FULL_ENV, DOC, deps).settled;
      expect(targetOf(outcome.targets, "ai-search")).toEqual({
        target: "ai-search",
        status: "failed",
        code,
      });
    }
  });

  it("hook rejection -> failed with code upload_failed, never a throw across the boundary", async () => {
    const deps: PublishDeps = {
      indexCanonicalReport: vecOk,
      indexCanonicalReportInAiSearch: async () => {
        throw new Error("hook boom");
      },
    };
    const outcome = await publishDocument(FULL_ENV, DOC, deps).settled;
    expect(targetOf(outcome.targets, "ai-search")).toEqual({
      target: "ai-search",
      status: "failed",
      code: "upload_failed",
    });
  });

  it("doc without provenance -> the hook payload carries the fields as absent (no fabrication)", async () => {
    const seen: CanonicalReportForAiSearchIndex[] = [];
    const deps: PublishDeps = {
      indexCanonicalReport: vecOk,
      indexCanonicalReportInAiSearch: async (_env, report) => {
        seen.push(report);
        return { ok: false, code: "disabled", correlationId: "c-6" };
      },
    };
    const bare: PublishDocumentInput = {
      kind: "report",
      documentId: "rep-3527-2",
      title: "Bare",
      source: "screener",
      summary: "s",
      body: "{}",
      bodyR2Key: "reports/rep-3527-2.json",
    };
    await publishDocument(FULL_ENV, bare, deps).settled;
    expect(seen).toHaveLength(1);
    expect(seen[0].reportId).toBe("rep-3527-2");
    expect(seen[0].bodyR2Key).toBe("reports/rep-3527-2.json");
    expect(seen[0].runId).toBeUndefined();
    expect(seen[0].ownerLogin).toBeUndefined();
    expect(seen[0].storedAt).toBeUndefined();
  });
});

describe("3527 S1 stage: handle shape and settle independence", () => {
  it("returns synchronously with per-target handles in declaration order; the aggregate echoes kind + documentId", async () => {
    const deps: PublishDeps = {
      indexCanonicalReport: async () => true,
      indexCanonicalReportInAiSearch: async () => ({
        ok: true,
        path: "namespace",
        correlationId: "c-7",
      }),
    };
    const handle = publishDocument(FULL_ENV, DOC, deps);
    expect(handle.targets.map((t) => t.target)).toEqual([
      "vectorize",
      "ai-search",
    ]);
    const outcome = await handle.settled;
    expect(outcome.kind).toBe("report");
    expect(outcome.documentId).toBe("rep-3527-1");
    expect(outcome.targets.map((t) => t.target)).toEqual([
      "vectorize",
      "ai-search",
    ]);
  });

  it("each target settles independently (a slow vectorize leg does not hold the ai-search outcome)", async () => {
    let releaseVectorize!: (ok: boolean) => void;
    const gate = new Promise<boolean>((r) => {
      releaseVectorize = r;
    });
    const deps: PublishDeps = {
      indexCanonicalReport: () => gate,
      indexCanonicalReportInAiSearch: async () => ({
        ok: true,
        path: "namespace",
        correlationId: "c-8",
      }),
    };
    const handle = publishDocument(FULL_ENV, DOC, deps);
    const aiOutcome = await handle.targets[1].settled;
    expect(aiOutcome.status).toBe("published");
    let vectorizeSettled = false;
    void handle.targets[0].settled.then(() => {
      vectorizeSettled = true;
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(vectorizeSettled).toBe(false);
    releaseVectorize(true);
    const vecOutcome = await handle.targets[0].settled;
    expect(vecOutcome.status).toBe("published");
    await handle.settled;
  });
});

describe("3527 S1 stage: payload equivalence through the real executors", () => {
  function fakeVector() {
    const upserts: Array<{
      id: string;
      values: number[];
      metadata: Record<string, unknown>;
    }> = [];
    return {
      upserts,
      env: {
        AI: { run: async () => ({ data: [[0.5, 0.25]] }) },
        VECTOR_MEMORY: {
          upsert: async (vectors: typeof upserts) => {
            upserts.push(...vectors);
          },
        },
      },
    };
  }

  function fakeNamespace() {
    const uploads: Array<{
      name: string;
      content: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const instance = {
      items: {
        upload: async (
          name: string,
          content: string,
          options?: { metadata?: Record<string, unknown> },
        ) => {
          uploads.push({ name, content, metadata: options?.metadata });
          return { id: "item-1", key: name, status: "queued" };
        },
      },
    };
    return { uploads, binding: { get: (_name: string) => instance } };
  }

  it("options_research doc: upsert id/metadata and upload id/content/metadata identical to the pre-stage legs", async () => {
    const vec = fakeVector();
    const ns = fakeNamespace();
    const doc: PublishDocumentInput = {
      kind: "report",
      documentId: "rep-3527-3",
      title: "Weekly options research",
      source: "options_research",
      summary: "Two ideas.",
      body: JSON.stringify({
        ideas: [
          {
            symbol: "NVDA",
            outlook: "bullish",
            structure: "call spread",
            thesis: "AI capex",
          },
        ],
      }),
      bodyR2Key: null,
      runId: "run-3527",
      ownerLogin: "tenant@example.com",
      storedAt: "2026-11-06T00:00:00.000Z",
    };
    const env = {
      ...vec.env,
      AI_SEARCH: ns.binding,
      AI_SEARCH_INSTANCE: "test-instance",
      AI_SEARCH_REPORT_INDEXING_ENABLED: "true",
    } as never;
    const outcome = await publishDocument(env, doc).settled;
    expect(targetOf(outcome.targets, "vectorize").status).toBe("published");
    expect(targetOf(outcome.targets, "ai-search").status).toBe("published");

    expect(vec.upserts).toHaveLength(1);
    expect(vec.upserts[0].id).toBe("report:rep-3527-3");
    expect(vec.upserts[0].metadata).toEqual({
      kind: "report",
      reportId: "rep-3527-3",
      title: "Weekly options research",
      source: "options_research",
    });

    expect(ns.uploads).toHaveLength(1);
    expect(ns.uploads[0].name).toBe("report:rep-3527-3");
    // content = title + "\n" + buildCanonicalIndexText output; for
    // options_research that text is summary + the ideas lines.
    expect(ns.uploads[0].content).toBe(
      "Weekly options research\nTwo ideas.\nNVDA bullish call spread: AI capex",
    );
    expect(ns.uploads[0].metadata).toEqual({
      kind: "report",
      reportId: "rep-3527-3",
      source: "options_research",
      runId: "run-3527",
      ownerLogin: "tenant@example.com",
      storedAt: "2026-11-06T00:00:00.000Z",
    });
  });

  it("empty env: vectorize not_attempted, ai-search not_configured, zero executor side effects", async () => {
    const outcome = await publishDocument({} as never, DOC).settled;
    expect(targetOf(outcome.targets, "vectorize").status).toBe("not_attempted");
    expect(targetOf(outcome.targets, "ai-search")).toEqual({
      target: "ai-search",
      status: "not_configured",
      code: "disabled",
    });
  });

  it("flag ON but the namespace binding absent: ai-search failed with the executor's not_configured code", async () => {
    const outcome = await publishDocument(
      { AI_SEARCH_REPORT_INDEXING_ENABLED: "true" } as never,
      DOC,
    ).settled;
    expect(targetOf(outcome.targets, "ai-search")).toEqual({
      target: "ai-search",
      status: "failed",
      code: "not_configured",
    });
  });
});
