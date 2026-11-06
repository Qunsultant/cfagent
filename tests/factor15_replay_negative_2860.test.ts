/**
 * Issue #2860 (15-factor re-audit, Factor 15 AuthN/AuthZ) — negative
 * tests for workflow-tenant mismatch and cross-owner replay, on BOTH
 * surfaces: the replay API (POST /api/reports/replay) and the MCP
 * replay path (get_report_asset / list_report_assets through the
 * per-user ReportAssetAgent door), plus the workflow read-back the
 * mesh screen door replays a run from (readJobHistory).
 *
 * What already existed: cross-owner report-read denial is
 * negative-tested (tests/scheduled_report_by_id.test.ts). What was
 * missing (the re-audit's remaining Factor 15 gap): no negative
 * test for workflow tenant mismatch or cross-owner replay.
 *
 * Seams probed:
 *  - Replay API: the row lookup (getScheduledReportById /
 *    getScheduledReportByRunId / listScheduledReports, owner-scoped
 *    #584 EP-003) is the enforcement point; buildReplayFromRecord
 *    itself carries userLogin only as a record field ("owner scoping
 *    is enforced by the row lookup, not here").
 *  - MCP replay path: per-user ReportAssetAgent instances
 *    (assets:<login>); another user's key must resolve on the
 *    CALLER's instance and miss there, never on the owner's.
 *  - Workflow read-back: readJobHistory(env, tenantId, chainId)
 *    filters by tenant at the D1 adapter (eq tenantId) — a chain
 *    recorded under tenant A must not read back under tenant B.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MockSqlStorage } from "./mock-sql";
import {
  ensureScheduledReportsTable,
  storeReportAtGeneration,
} from "../src/services/scheduledReports";
import {
  handleReportsRoutes,
  type ReportsRouteContext,
} from "../src/agents/routes/reports";
import {
  MeshDoorError,
  getReportAssetViaDoor,
  listReportAssetsViaDoor,
} from "../src/agents/orchestrator/meshDoors";
import type { ReportAssetMeta } from "../src/agents/report-asset-agent";
import { readJobHistory } from "../src/data/createShardJobPorts";
import {
  createD1ShardJobDb,
  D1ShardJobAdapter,
  ensureShardJobSchema,
} from "../src/data/d1ShardJobAdapter";

const SCREENER_BODY = {
  timestamp: "2026-10-30T09:30:00.000Z",
  universe: "TECH",
  sector: "ALL",
  provider: "etrade",
  trigger: "manual",
  success: true,
  totalScanned: 2,
  matchedCount: 1,
  criteria: { sector: "ALL", minPrice: 5 },
  opportunities: [{ symbol: "AAPL" }],
  allStocks: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
  pdfKey: "reports/a.pdf",
};

function seedReports() {
  const sql = new MockSqlStorage();
  ensureScheduledReportsTable(sql as any);
  const aliceId = storeReportAtGeneration(
    sql as any,
    {
      runId: "screener:alice-1",
      title: "Alice screen",
      source: "screener",
      summary: "alice run",
      body: SCREENER_BODY,
      userLogin: "alice",
      createdAt: "2026-10-30T09:30:00.000Z",
    } as any,
  )!.reportId;
  const bobId = storeReportAtGeneration(
    sql as any,
    {
      runId: "screener:bob-1",
      title: "Bob screen",
      source: "screener",
      summary: "bob run",
      body: SCREENER_BODY,
      userLogin: "bob",
      createdAt: "2026-10-30T09:31:00.000Z",
    } as any,
  )!.reportId;
  const bobResearchId = storeReportAtGeneration(
    sql as any,
    {
      runId: "research:bob-1",
      title: "Bob research",
      source: "research_report",
      summary: "bob research",
      body: { symbol: "MSFT", ideas: ["buy MSFT"] },
      userLogin: "bob",
      createdAt: "2026-10-30T09:32:00.000Z",
    } as any,
  )!.reportId;
  return { sql, aliceId, bobId, bobResearchId };
}

function replayCtx(sql: MockSqlStorage): ReportsRouteContext {
  return {
    ensureTables: () => sql as any,
    env: {},
    getScreenerAgent: () => ({ getHistory: async () => [] }) as any,
    getScreenerExecutionContext: async () => undefined,
    getReportDispatchHitl: () => false,
    setReportDispatchHitl: vi.fn(),
    getReportConfirmation: vi.fn(() => null),
    decideReportConfirmation: vi.fn(),
    createReportConfirmation: vi.fn(() => "conf-1"),
    confirmationDeliveryMeta: vi.fn(() => ({})),
    deliverStoredReportEmail: vi.fn(async () => "sent" as const),
    deliverStoredReportWebhook: vi.fn(async () => ({ outcome: "sent" as const, result: { success: true, status: 200 } })),
    sendReportEmail: vi.fn(async () => true),
    sendReportWebhook: vi.fn(async () => ({ success: true, status: 200 })),
    storeResearchReportCanonicalAsync: vi.fn(async () => ({ reportId: "r1", generationId: "g1" })),
    audit: vi.fn(),
    reportConfirmationTtlMs: () => 24 * 60 * 60 * 1000,
  } as unknown as ReportsRouteContext;
}

function replayReq(login: string | null, body: unknown) {
  return new Request("https://agent.internal/api/reports/replay", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(login ? { "x-user-login": login } : {}),
    },
  });
}

async function postReplay(sql: MockSqlStorage, login: string | null, body: unknown) {
  const res = (await handleReportsRoutes(
    replayReq(login, body),
    new URL("https://agent.internal/api/reports/replay"),
    "/api/reports/replay",
    "sess",
    replayCtx(sql),
  ))!;
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe("cross-owner replay refused on the replay API (#2860 Factor 15)", () => {
  it("refuses another owner's report by reportId (404, never the envelope)", async () => {
    const { sql, bobId } = seedReports();
    const { status, json } = await postReplay(sql, "alice", { reportId: bobId });
    expect(status).toBe(404);
    expect(json.error).toMatch(/not owned|not found/i);
    expect(json).not.toHaveProperty("replay");
  });

  it("refuses another owner's run by runId (404)", async () => {
    const { sql } = seedReports();
    const { status, json } = await postReplay(sql, "alice", { runId: "screener:bob-1" });
    expect(status).toBe(404);
    expect(json).not.toHaveProperty("replay");
  });

  it("refuses another owner's research report by symbol (404)", async () => {
    const { sql } = seedReports();
    const { status, json } = await postReplay(sql, "alice", { symbol: "MSFT" });
    expect(status).toBe(404);
    expect(json).not.toHaveProperty("replay");
  });

  it("replays the caller's own report by reportId (200, replay provenance)", async () => {
    const { sql, aliceId } = seedReports();
    const { status, json } = await postReplay(sql, "alice", { reportId: aliceId });
    expect(status).toBe(200);
    expect(json.replay.kind).toBe("replay");
    expect(json.replay.originalRunId).toBe("screener:alice-1");
    expect(json.replay.charged).toBe(false);
    expect(json.replay.liveFetch).toBe(false);
  });

  it("replays the caller's own run by runId (200)", async () => {
    const { sql } = seedReports();
    const { status, json } = await postReplay(sql, "alice", { runId: "screener:alice-1" });
    expect(status).toBe(200);
    expect(json.replay.originalRunId).toBe("screener:alice-1");
  });

  it("refuses an unauthenticated replay (401) — no anonymous owner to scope by", async () => {
    const { sql, aliceId } = seedReports();
    const { status } = await postReplay(sql, null, { reportId: aliceId });
    expect(status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// MCP replay path: per-user ReportAssetAgent instances
// ---------------------------------------------------------------------------

const BOB_KEY = "report:pdf:screener:bob-1";
const ALICE_KEY = "report:pdf:screener:alice-1";
const BOB_BYTES = new Uint8Array([37, 80, 68, 70, 45, 66]); // "%PDF-B"
const ALICE_BYTES = new Uint8Array([37, 80, 68, 70, 45, 65]); // "%PDF-A"

function makePerInstanceReportStub() {
  const instances = new Map<string, { metas: ReportAssetMeta[]; bytes: Map<string, Uint8Array> }>();
  const instance = (name: string) => {
    let inst = instances.get(name);
    if (!inst) {
      inst = { metas: [], bytes: new Map() };
      instances.set(name, inst);
    }
    return inst;
  };
  const seed = (name: string, key: string, fileName: string, bytes: Uint8Array) => {
    const inst = instance(name);
    inst.metas.push({ key, fileName, storedAt: "2026-10-30T10:00:00.000Z" });
    inst.bytes.set(key, bytes);
  };
  seed("assets:bob", BOB_KEY, "bob-report.pdf", BOB_BYTES);
  seed("assets:alice", ALICE_KEY, "alice-report.pdf", ALICE_BYTES);
  return {
    seen: [] as string[],
    namespace: {
      idFromName: (name: string) => {
        return name;
      },
      get: (id: unknown) => {
        const name = String(id);
        const inst = instance(name);
        return {
          async listAssets(limit = 50): Promise<ReportAssetMeta[]> {
            return inst.metas.slice(0, limit).map((m) => ({ ...m }));
          },
          async getAsset(key: string) {
            const bytes = inst.bytes.get(key);
            if (!bytes) return null;
            const meta = inst.metas.find((m) => m.key === key)!;
            return { bytes, fileName: meta.fileName };
          },
        };
      },
    },
  };
}

describe("cross-owner replay refused on the MCP replay path (#2860 Factor 15)", () => {
  let env: any;
  let seen: string[];

  beforeEach(() => {
    const stub = makePerInstanceReportStub();
    seen = stub.seen;
    env = {
      REPORT_ASSET_AGENT: {
        idFromName: (name: string) => {
          seen.push(name);
          return stub.namespace.idFromName(name);
        },
        get: stub.namespace.get,
      },
      SERVICE_USER_LOGIN: "svc-background",
    };
  });

  it("refuses another owner's asset by key (asset_not_found — resolved on the caller's instance, never the owner's)", async () => {
    await expect(getReportAssetViaDoor(env, "alice", BOB_KEY)).rejects.toMatchObject({
      code: "asset_not_found",
    });
    expect(seen).toEqual(["assets:alice"]);
  });

  it("returns the caller's own asset by key", async () => {
    const result = await getReportAssetViaDoor(env, "alice", ALICE_KEY);
    expect(result.fileName).toBe("alice-report.pdf");
    expect(result.byteLength).toBe(ALICE_BYTES.length);
    expect(seen).toEqual(["assets:alice"]);
  });

  it("lists only the caller's own assets (no cross-owner keys leak through list)", async () => {
    const { assets } = await listReportAssetsViaDoor(env, "alice");
    expect(assets.map((a) => a.key)).toEqual([ALICE_KEY]);
  });

  it("refuses without an acting identity (fail-closed before any stub resolves)", async () => {
    await expect(getReportAssetViaDoor(env, undefined, ALICE_KEY)).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Workflow-tenant mismatch: the workflow read-back surface
// ---------------------------------------------------------------------------

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid }, results: [] };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db.prepare(sql).all(...(params as any[])).map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

describe("workflow-tenant mismatch refused on the workflow read-back (#2860 Factor 15)", () => {
  it("a chain recorded under tenant A does not read back under tenant B", async () => {
    const mock = new MockD1Database();
    const db = createD1ShardJobDb(mock as unknown as never);
    await ensureShardJobSchema(db);
    const adapter = new D1ShardJobAdapter(db);
    await adapter.recordJob({
      tenantId: "tenant-a",
      workspaceId: "ws-a",
      chainId: "chain-1",
      jobKey: "job-1",
      version: 1,
      status: "completed",
      stage: "serve",
      capabilityId: "screen",
      detail: "",
      resultJson: JSON.stringify({ ok: true }),
      createdAtMs: 1_000_000,
      updatedAtMs: 1_000_001,
      provenanceWriter: "test",
      provenanceSourceDo: "ScreenerAgent",
      provenanceSourceVersion: "1",
      workflowRunId: null,
    } as any);
    const env = { AGENT_DB: mock };
    const underA = await readJobHistory(env as any, "tenant-a", "chain-1");
    expect(underA).not.toBeNull();
    expect(underA).toHaveLength(1);
    expect(underA![0].chainId).toBe("chain-1");
    const underB = await readJobHistory(env as any, "tenant-b", "chain-1");
    expect(underB).toEqual([]);
  });

  it("an unbound store reads nothing (null — the door treats it as no history, never another tenant's)", async () => {
    expect(await readJobHistory({} as any, "tenant-a", "chain-1")).toBeNull();
  });
});
