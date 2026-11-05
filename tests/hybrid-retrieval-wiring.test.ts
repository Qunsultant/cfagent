// @vitest-environment node
/**
 * Issue #1740 ([AGENTIC] Hybrid RAG) — TDD red-first.
 *
 * Wiring pins (behavior-preserving by construction):
 *  - The memory_search route expands graph context additively:
 *    response gains `graph` + `graphDegraded`, `chunks` unchanged.
 *  - The actor turn grounding appends a graph section ONLY when
 *    expansion yields rows; empty/unbound/error means byte-identical
 *    prior behavior.
 *  - The populate route is platform-admin-only (seed-route pattern),
 *    idempotent, and catalogued (IAAA catalog source pin).
 *  - Retrieval events are CloudEvents v1.0 via #1739's envelope:
 *    specversion/id/source/type/time/data required, id unique,
 *    data carries counts only (no query text, no PII).
 *  - Retention is decided up front (R8): the new tables are KEEP
 *    in the storage-retention record, and the purge allowlist is
 *    untouched (still shard-jobs only).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InMemoryMarketGraphAdapter } from "../src/retrieval/inMemoryMarketGraphAdapter";
import {
  expandGraphContext,
  formatGraphContext,
  toRetrievalCompletedEnvelope,
} from "../src/retrieval/hybridRetrieval";
import { handlePopulateMarketGraphRoute } from "../src/retrieval/populateMarketGraphRoute";
import { API_ENDPOINT_CATALOG } from "../src/client/iaaaEndpointCatalog";
import { RETENTION_PURGE_TABLES } from "../src/data/retentionPorts";

function src(rel: string): string {
  return readFileSync(resolve(__dirname, "..", "src", rel), "utf8");
}

describe("graph expansion helper", () => {
  async function seeded() {
    const store = new InMemoryMarketGraphAdapter();
    await store.upsertNodes([
      { tenantId: "primary", nodeType: "symbol", nodeKey: "NVDA", label: "NVIDIA" },
      { tenantId: "primary", nodeType: "symbol", nodeKey: "AMD", label: "AMD" },
      { tenantId: "primary", nodeType: "sector", nodeKey: "Semiconductors", label: "Semiconductors" },
    ]);
    await store.upsertEdges([
      { tenantId: "primary", fromType: "symbol", fromKey: "NVDA", relation: "in_sector", toType: "sector", toKey: "Semiconductors", weight: 1, provenance: "test" },
      { tenantId: "primary", fromType: "symbol", fromKey: "NVDA", relation: "peer_of", toType: "symbol", toKey: "AMD", weight: 0.5, provenance: "test" },
    ]);
    return store;
  }

  it("expands query + dense-text symbols, capped and ordered", async () => {
    const store = await seeded();
    const out = await expandGraphContext(
      store,
      "primary",
      "NVDA outlook",
      ["AMD ships new chips"],
      { graphTopK: 10 },
    );
    expect(out.degraded).toBe(false);
    expect(out.rows.map((r) => r.node.nodeKey)).toEqual([
      "Semiconductors",
      "AMD",
    ]);
  });

  it("empty expansion formats to an empty string (no prompt change)", async () => {
    const store = new InMemoryMarketGraphAdapter();
    const out = await expandGraphContext(store, "primary", "NVDA", [], {});
    expect(out.rows).toEqual([]);
    expect(formatGraphContext(out.rows)).toBe("");
  });

  it("formats non-empty rows as a stable context block", async () => {
    const store = await seeded();
    const out = await expandGraphContext(store, "primary", "NVDA", [], {});
    const text = formatGraphContext(out.rows);
    expect(text).toContain("Related market context");
    expect(text).toContain("Semiconductors");
    expect(text).toContain("AMD");
  });

  it("graph failure degrades (rows [], degraded true), never throws", async () => {
    const failing = {
      adjacent: async () => {
        throw new Error("boom");
      },
      resolveSymbols: async () => {
        throw new Error("boom");
      },
      upsertNodes: async () => {},
      upsertEdges: async () => {},
    };
    const out = await expandGraphContext(failing, "primary", "NVDA", [], {});
    expect(out).toEqual({ rows: [], degraded: true, graphError: "boom" });
  });
});

describe("retrieval.completed CloudEvents envelope (#1739 envelope, reused)", () => {
  it("carries required CloudEvents attributes and counts-only data", () => {
    const a = toRetrievalCompletedEnvelope({ denseCount: 3, graphCount: 2, degraded: false });
    const b = toRetrievalCompletedEnvelope({ denseCount: 3, graphCount: 2, degraded: false });
    expect(a.specversion).toBe("1.0");
    expect(a.source).toBe("retrieval/hybrid");
    expect(a.type).toBe("retrieval.completed");
    expect(typeof a.time).toBe("string");
    expect(a.data).toEqual({ denseCount: 3, graphCount: 2, degraded: false });
    // id is the idempotency key: unique per retrieval.
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
    expect(JSON.stringify(a.data)).not.toMatch(/NVDA|outlook/);
  });
});

describe("populate route (seed-route pattern, platform-admin only)", () => {
  it("refuses non-admin, wrong method, and missing session; allows admin", async () => {
    const run = async () => ({ nodes: 1, edges: 1, symbols: 1 });
    const base = { session: { internalUserId: "u1" } as any, tenantId: "primary", runPopulate: run };
    const denied = await handlePopulateMarketGraphRoute({
      ...base,
      method: "POST",
      isPlatformAdmin: false,
    });
    expect(denied.status).toBe(403);
    const wrongMethod = await handlePopulateMarketGraphRoute({
      ...base,
      method: "GET",
      isPlatformAdmin: true,
    });
    expect(wrongMethod.status).toBe(405);
    const noSession = await handlePopulateMarketGraphRoute({
      session: null,
      method: "POST",
      isPlatformAdmin: false,
      tenantId: "primary",
      runPopulate: run,
    });
    expect(noSession.status).toBe(401);
    const ok = await handlePopulateMarketGraphRoute({
      ...base,
      method: "POST",
      isPlatformAdmin: true,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, nodes: 1, edges: 1 });
  });
});

describe("wiring source pins + retention decision (R8)", () => {
  it("memory_search route expands graph context additively", () => {
    // Slice 6 of Qunsultant/cfagent#2902 (2026-11-05): the memory_search
    // route moved from src/server.ts to src/server/routes/messaging.ts;
    // the entry surface is server.ts + routes/*.ts, so the pin reads
    // both files.
    const server = src("server.ts") + src("server/routes/messaging.ts");
    expect(server).toMatch(/expandGraphContext/);
    expect(server).toMatch(/graphDegraded/);
  });

  it("turn grounding appends the graph section only when rows exist", () => {
    const helpers = src("agents/orchestrator/chatTurnHelpers.ts");
    expect(helpers).toMatch(/expandGraphContext/);
    expect(helpers).toMatch(/formatGraphContext/);
    // The section literal lives in the formatter, not the caller.
    expect(src("retrieval/hybridRetrieval.ts")).toMatch(/Related market context/);
  });

  it("populate route is catalogued (IAAA catalog source pin)", () => {
    const entry = API_ENDPOINT_CATALOG.find(
      (e) => e.path === "/api/retrieval/populate-market-graph",
    );
    expect(entry).toBeDefined();
    expect(entry?.method).toBe("POST");
    expect(entry?.auth).toBe("platform-admin");
  });

  it("new tables are KEEP in the retention record; purge allowlist untouched", () => {
    const retention = src("security/storageRetention.ts");
    expect(retention).toMatch(/agent_market_nodes.*KEEP/s);
    expect(retention).toMatch(/agent_market_edges.*KEEP/s);
    expect(RETENTION_PURGE_TABLES).toEqual(["agent_shard_jobs"]);
  });

  it("boundary: retrieval code does not touch KNOWLEDGE_MODE/MEMORY_READ_MODE surfaces", () => {
    // Strip doc comments: the boundary is documented in prose, but
    // no CODE may read or switch those surfaces.
    const code = (rel: string) =>
      src(rel).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code("retrieval/retrievalPorts.ts")).not.toMatch(
      /KNOWLEDGE_MODE|MEMORY_READ_MODE/,
    );
    expect(code("retrieval/hybridRetrieval.ts")).not.toMatch(
      /KNOWLEDGE_MODE|MEMORY_READ_MODE/,
    );
  });
});
