/**
 * Issue #2246 — report indexing into the AI Search instance,
 * feature-flagged OFF by default (AI_SEARCH_REPORT_INDEXING_ENABLED).
 *
 * Pins:
 *  A. Flag reader (isAiSearchReportIndexingEnabled): the S2 idiom —
 *     "1"/"true"/"on" (case-insensitive, trimmed) = ON; absence or
 *     anything else = OFF.
 *  B. Upload executor (runAiSearchIndexUpload): configured fake ->
 *     exactly one items.upload under the document id with content +
 *     metadata verbatim; unconfigured -> typed not_configured, never
 *     a throw, never a fabricated success; upload throw / instance
 *     without an items API -> upload_failed; empty id/content ->
 *     invalid_input.
 *  C. Pipeline hook at the canonical store seams
 *     (storeReportAtGeneration / storeReportAtGenerationWithR2,
 *     riding beside S4-1's indexCanonicalReport):
 *     - flag OFF -> store succeeds, ZERO uploads (provably inert);
 *     - flag ON + configured -> exactly one upload per store, item
 *       name = the report's document id (`report:<reportId>`, the
 *       Vectorize leg's convention), metadata carries kind "report",
 *       reportId, ownerLogin, runId, source, storedAt; content
 *       carries title + the canonical index text;
 *     - flag ON + unconfigured -> store succeeds, degraded outcome
 *       recorded via console.warn with the stable event code
 *       `ai_search_report_index_failed` + outcome code
 *       `not_configured`;
 *     - flag ON + upload throws -> store succeeds, failure recorded
 *       with code `upload_failed`;
 *     - redelivery (same generationId) re-uploads the same document
 *       id (idempotent upsert, mirroring the Vectorize leg);
 *     - retention rows are never uploaded (mirrors
 *       INDEX_EXCLUDED_SOURCES).
 *  D. Agent door: AiSearchAgent.indexDocument delegates to the
 *     executor (configured fake -> upload; unconfigured -> typed
 *     not_configured, no throw).
 *  E. Search-side login discipline (runAiSearchPaths): report-type
 *     results (item key `report:<id>`, or chunk metadata
 *     kind:"report") are served ONLY when the search carries a
 *     callerLogin equal to the item's ownerLogin metadata; no
 *     callerLogin -> withheld; mismatched login -> withheld; owner
 *     unproven (key-only identification, e.g. the REST path where
 *     chunk metadata does not survive mapping) -> withheld even
 *     with a callerLogin. Withholding is surfaced in the result's
 *     `degraded` note; a clean knowledge-only answer carries no
 *     withholding note.
 *
 * The store hook is fire-and-forget (`void`, mirroring S4-1), so
 * seam tests flush microtasks before asserting uploads.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Mock the Think-coupled module only (the research-agent-think-turn
// pattern): the class graph pulls `cloudflare:` imports the node
// loader cannot resolve. Everything else here is real.
vi.mock("../src/actors/thinkAdapter", () => ({
  PortThink: class MockPortThink {
    ctx: any;
    env: any;
    portHooks: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { MockSqlStorage } from "./mock-sql";
import {
  runAiSearchIndexUpload,
  runAiSearchPaths,
  isAiSearchReportIndexingEnabled,
  type AiSearchAgentDeps,
} from "../src/agents/aiSearchPaths";
import { indexCanonicalReportInAiSearch } from "../src/services/reportAiSearchIndex";
import {
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
} from "../src/services/scheduledReports";
import { AiSearchAgent } from "../src/agents/aiSearchAgent";

const flush = async () => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

afterEach(() => {
  vi.restoreAllMocks();
});

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

const FLAG = "AI_SEARCH_REPORT_INDEXING_ENABLED";

describe("A. flag reader (#2246)", () => {
  it("absent / empty / off values are OFF", () => {
    expect(isAiSearchReportIndexingEnabled({})).toBe(false);
    expect(isAiSearchReportIndexingEnabled({ [FLAG]: "" })).toBe(false);
    expect(isAiSearchReportIndexingEnabled({ [FLAG]: "0" })).toBe(false);
    expect(isAiSearchReportIndexingEnabled({ [FLAG]: "false" })).toBe(false);
    expect(isAiSearchReportIndexingEnabled({ [FLAG]: "off" })).toBe(false);
    expect(isAiSearchReportIndexingEnabled(null)).toBe(false);
    expect(isAiSearchReportIndexingEnabled(undefined)).toBe(false);
  });

  it('"1" / "true" / "on" (case-insensitive, trimmed) are ON', () => {
    expect(isAiSearchReportIndexingEnabled({ [FLAG]: "1" })).toBe(true);
    expect(isAiSearchReportIndexingEnabled({ [FLAG]: "true" })).toBe(true);
    expect(isAiSearchReportIndexingEnabled({ [FLAG]: "on" })).toBe(true);
    expect(isAiSearchReportIndexingEnabled({ [FLAG]: " TRUE " })).toBe(true);
    expect(isAiSearchReportIndexingEnabled({ [FLAG]: "On" })).toBe(true);
  });
});

describe("B. upload executor (#2246)", () => {
  const doc = {
    id: "report:rpt-1",
    content: "Market screen — ALL\nScanned 10 symbols, 2 matched.",
    metadata: { kind: "report", reportId: "rpt-1", ownerLogin: "alice" },
  };

  it("configured fake -> exactly one upload, id/content/metadata verbatim", async () => {
    const { uploads, binding } = fakeNamespace();
    const outcome = await runAiSearchIndexUpload(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: "cfagent-kb" },
      doc
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.path).toBe("namespace");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].name).toBe("report:rpt-1");
    expect(uploads[0].content).toBe(doc.content);
    expect(uploads[0].metadata).toEqual(doc.metadata);
  });

  it("unconfigured (no binding / no instance name) -> not_configured, no throw", async () => {
    const noBinding = await runAiSearchIndexUpload({ AI_SEARCH_INSTANCE: "x" }, doc);
    expect(noBinding.ok).toBe(false);
    expect(noBinding.code).toBe("not_configured");
    expect(noBinding.errorToken).toBeTruthy();

    const { uploads, binding } = fakeNamespace();
    const noInstance = await runAiSearchIndexUpload({ AI_SEARCH: binding as any }, doc);
    expect(noInstance.ok).toBe(false);
    expect(noInstance.code).toBe("not_configured");
    expect(uploads).toHaveLength(0);
  });

  it("upload throws -> upload_failed, never a throw across the boundary", async () => {
    const { binding } = fakeNamespace({ failUpload: true });
    const outcome = await runAiSearchIndexUpload(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: "cfagent-kb" },
      doc
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("upload_failed");
    expect(outcome.error).toContain("instance items API unavailable");
  });

  it("instance without an items API -> upload_failed", async () => {
    const binding = { get: () => ({ search: async () => ({ chunks: [] }) }) };
    const outcome = await runAiSearchIndexUpload(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: "cfagent-kb" },
      doc
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("upload_failed");
  });

  it("empty id or content -> invalid_input, zero uploads", async () => {
    const { uploads, binding } = fakeNamespace();
    const env = { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: "cfagent-kb" };
    expect((await runAiSearchIndexUpload(env, { ...doc, id: "  " })).code).toBe(
      "invalid_input"
    );
    expect((await runAiSearchIndexUpload(env, { ...doc, content: "" })).code).toBe(
      "invalid_input"
    );
    expect(uploads).toHaveLength(0);
  });
});

describe("C. pipeline hook at the store seams (#2246)", () => {
  const CREATED = "2026-10-29T05:00:00.000Z";
  function reportInput(overrides: Record<string, unknown> = {}) {
    return {
      runId: "run-2246-1",
      generationId: "gen-2246-1",
      title: "Market screen — ALL",
      source: "screener",
      userLogin: "alice",
      summary: "Scanned 10 symbols, 2 matched.",
      body: {
        opportunities: [{ symbol: "AAPL", structure: "call spread" }],
      },
      createdAt: CREATED,
      ...overrides,
    } as any;
  }

  it("flag OFF -> store succeeds, ZERO uploads (provably inert)", async () => {
    const sql = new MockSqlStorage();
    const { uploads, binding } = fakeNamespace();
    const env = {
      AI_SEARCH: binding,
      AI_SEARCH_INSTANCE: "cfagent-kb",
      // no flag: OFF by default
    } as any;
    const stored = storeReportAtGeneration(sql, reportInput(), env);
    expect(stored?.reportId).toBeTruthy();
    await flush();
    expect(uploads).toHaveLength(0);
  });

  it("flag ON + configured -> exactly one upload with document id + metadata", async () => {
    const sql = new MockSqlStorage();
    const { uploads, binding } = fakeNamespace();
    const env = {
      AI_SEARCH: binding,
      AI_SEARCH_INSTANCE: "cfagent-kb",
      [FLAG]: "1",
    } as any;
    const stored = storeReportAtGeneration(sql, reportInput(), env);
    expect(stored?.reportId).toBeTruthy();
    await flush();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].name).toBe(`report:${stored!.reportId}`);
    expect(uploads[0].metadata).toMatchObject({
      kind: "report",
      reportId: stored!.reportId,
      ownerLogin: "alice",
      runId: "run-2246-1",
      source: "screener",
      storedAt: CREATED,
    });
    expect(uploads[0].content).toContain("Market screen — ALL");
    expect(uploads[0].content).toContain("Scanned 10 symbols, 2 matched.");
  });

  it("flag ON + unconfigured -> store succeeds, degraded outcome recorded with stable code", async () => {
    const sql = new MockSqlStorage();
    // #3515 S3: the failure now travels as a structured
    // report_ai_search.index_failed event (level warn) on the console-info
    // JSON fallback, not a console.warn line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const env = { [FLAG]: "true" } as any; // no AI_SEARCH binding at all
    const stored = storeReportAtGeneration(sql, reportInput(), env);
    expect(stored?.reportId).toBeTruthy();
    await flush();
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
    const failed = events.find((e) => e.operation === "report_ai_search.index_failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("warn");
    expect(failed?.fields.code).toBe("not_configured");
    expect(failed?.fields.reportId).toBe(stored!.reportId);
    expect(String(failed?.fields.message ?? "")).toContain("ai_search_report_index_failed");
    expect(String(failed?.fields.message ?? "")).toContain("not_configured");
    expect(String(failed?.fields.message ?? "")).toContain(stored!.reportId);
    // No report content in the log record.
    expect(String(failed?.fields.message ?? "")).not.toContain("Scanned 10 symbols");
    expect(String(failed?.fields.error ?? "")).not.toContain("Scanned 10 symbols");
  });

  it("flag ON + upload throws -> store succeeds, failure recorded as upload_failed", async () => {
    const sql = new MockSqlStorage();
    // #3515 S3: the failure now travels as a structured
    // report_ai_search.index_failed event (level warn) on the console-info
    // JSON fallback, not a console.warn line. (The throw is caught inside
    // runAiSearchIndexUpload, which returns { ok: false, code:
    // "upload_failed" }.)
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { binding } = fakeNamespace({ failUpload: true });
    const env = {
      AI_SEARCH: binding,
      AI_SEARCH_INSTANCE: "cfagent-kb",
      [FLAG]: "on",
    } as any;
    const stored = storeReportAtGeneration(sql, reportInput(), env);
    expect(stored?.reportId).toBeTruthy();
    await flush();
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
    const failed = events.find((e) => e.operation === "report_ai_search.index_failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("warn");
    expect(failed?.fields.code).toBe("upload_failed");
    expect(failed?.fields.reportId).toBe(stored!.reportId);
    expect(String(failed?.fields.message ?? "")).toContain("ai_search_report_index_failed");
    expect(String(failed?.fields.message ?? "")).toContain("upload_failed");
  });

  it("WithR2 seam, flag ON -> exactly one upload", async () => {
    const sql = new MockSqlStorage();
    const { uploads, binding } = fakeNamespace();
    const env = {
      AI_SEARCH: binding,
      AI_SEARCH_INSTANCE: "cfagent-kb",
      [FLAG]: "1",
    } as any;
    const stored = await storeReportAtGenerationWithR2(sql, env, reportInput());
    expect(stored?.reportId).toBeTruthy();
    await flush();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].name).toBe(`report:${stored!.reportId}`);
  });

  it("redelivery re-uploads the SAME document id (idempotent upsert)", async () => {
    const sql = new MockSqlStorage();
    const { uploads, binding } = fakeNamespace();
    const env = {
      AI_SEARCH: binding,
      AI_SEARCH_INSTANCE: "cfagent-kb",
      [FLAG]: "1",
    } as any;
    const first = storeReportAtGeneration(sql, reportInput(), env);
    await flush();
    const second = storeReportAtGeneration(sql, reportInput(), env);
    expect(second?.reportId).toBe(first?.reportId);
    expect(second?.created).toBe(false);
    await flush();
    expect(uploads).toHaveLength(2);
    expect(uploads[1].name).toBe(uploads[0].name);
    expect(uploads[1].metadata).toMatchObject({
      kind: "report",
      reportId: first!.reportId,
      ownerLogin: "alice",
    });
  });

  it("retention rows are never uploaded", async () => {
    const sql = new MockSqlStorage();
    const { uploads, binding } = fakeNamespace();
    const env = {
      AI_SEARCH: binding,
      AI_SEARCH_INSTANCE: "cfagent-kb",
      [FLAG]: "1",
    } as any;
    const stored = storeReportAtGeneration(
      sql,
      reportInput({ source: "retention", generationId: "gen-2246-ret" }),
      env
    );
    expect(stored?.reportId).toBeTruthy();
    await flush();
    expect(uploads).toHaveLength(0);
  });

  it("hook direct: flag OFF -> disabled outcome, zero uploads", async () => {
    const { uploads, binding } = fakeNamespace();
    const outcome = await indexCanonicalReportInAiSearch(
      { AI_SEARCH: binding as any, AI_SEARCH_INSTANCE: "cfagent-kb" } as any,
      {
        reportId: "rpt-direct",
        title: "T",
        source: "screener",
        summary: "S",
        body: "",
        runId: "run-1",
        ownerLogin: "alice",
      }
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("disabled");
    expect(uploads).toHaveLength(0);
  });
});

describe("D. agent door (#2246)", () => {
  const ctx: any = {
    storage: {
      get: async () => null,
      put: async () => {},
      sql: { exec: () => [] as unknown[] },
    },
  };

  it("indexDocument delegates to the executor (configured -> upload)", async () => {
    const { uploads, binding } = fakeNamespace();
    const agent = new AiSearchAgent(ctx, {
      AI_SEARCH: binding,
      AI_SEARCH_INSTANCE: "cfagent-kb",
    } as any);
    const outcome = await agent.indexDocument({
      id: "report:rpt-9",
      content: "Some report text",
      metadata: { kind: "report", reportId: "rpt-9", ownerLogin: "alice" },
    });
    expect(outcome.ok).toBe(true);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].name).toBe("report:rpt-9");
  });

  it("indexDocument unconfigured -> typed not_configured, no throw", async () => {
    const agent = new AiSearchAgent(ctx, {} as any);
    const outcome = await agent.indexDocument({
      id: "report:rpt-9",
      content: "Some report text",
      metadata: { kind: "report" },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("not_configured");
  });
});

describe("E. search-side login discipline (#2246)", () => {
  const KNOWLEDGE_CHUNK = {
    id: "c1",
    type: "text",
    score: 0.7,
    text: "FINRA Rule 4210 margin requirements.",
    item: {
      key: "knowledge/broker_rules/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      metadata: { title: "FINRA Rule 4210", category: "broker_rules" },
    },
  };
  const REPORT_CHUNK = {
    id: "c2",
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

  function namespaceEnv(chunks: unknown[]) {
    return {
      AI_SEARCH: {
        get: () => ({
          search: async () => ({ search_query: "q", chunks }),
        }),
      },
      AI_SEARCH_INSTANCE: "cfagent-kb",
    } as any;
  }

  it("no callerLogin -> report-type result withheld, knowledge served, note recorded", async () => {
    const result = await runAiSearchPaths(
      namespaceEnv([KNOWLEDGE_CHUNK, REPORT_CHUNK]),
      "margin rules"
    );
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results![0].source).toContain("knowledge/broker_rules/");
    expect(result.degraded ?? "").toContain("withheld");
  });

  it("callerLogin == ownerLogin -> report-type result served", async () => {
    const result = await runAiSearchPaths(
      namespaceEnv([KNOWLEDGE_CHUNK, REPORT_CHUNK]),
      "margin rules",
      { callerLogin: "alice" }
    );
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.degraded ?? "").not.toContain("withheld");
  });

  it("callerLogin != ownerLogin -> report-type result withheld", async () => {
    const result = await runAiSearchPaths(
      namespaceEnv([KNOWLEDGE_CHUNK, REPORT_CHUNK]),
      "margin rules",
      { callerLogin: "bob" }
    );
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.degraded ?? "").toContain("withheld");
  });

  it("key-only report identification (no owner metadata) -> withheld even for a callerLogin", async () => {
    const keyOnly = {
      id: "c3",
      type: "text",
      score: 0.8,
      text: "Another screen result.",
      item: { key: "report:rpt-2", metadata: { title: "Screen" } },
    };
    const result = await runAiSearchPaths(namespaceEnv([keyOnly]), "screens", {
      callerLogin: "alice",
    });
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(0);
    expect(result.degraded ?? "").toContain("withheld");
  });

  // Retired by #3342 with the REST path itself: this test pinned
  // that a report-type item identified only by its key (owner
  // unprovable through the REST mapping) is withheld even for its
  // owner. The identical safe default on the surviving paths is
  // pinned by the test directly above ("key-only report
  // identification (no owner metadata) -> withheld even for a
  // callerLogin"), and the endpoint-only environment now
  // configuring nothing is pinned in
  // tests/ai_search_rest_migration_p3342.test.ts.

  it("clean knowledge-only answer carries no withholding note", async () => {
    const result = await runAiSearchPaths(namespaceEnv([KNOWLEDGE_CHUNK]), "margin");
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.degraded).toBeUndefined();
  });
});
