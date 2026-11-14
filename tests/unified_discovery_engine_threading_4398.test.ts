/**
 * Issue #4398 (sub-issue of #4276) — the unified discovery action
 * threads engine stores, the #4276 pattern: when the host wires the
 * discovery SQL seam, the unified action's discovery run carries
 * engine stores built over that handle, so its panel expressions are
 * engine jobs with durable run records addressable by per-stage
 * control. The threading machinery (DiscoveryRunRequest.engineStores,
 * runPipeline's 6th argument, the strategy job identity) is #4276's;
 * this slice adds only the unified call site.
 *
 * The discovery service module is mocked at the factory seam only:
 * createDiscoveryService returns a fake whose run() captures the
 * request and returns a canned outcome. The engine stores in the
 * captured request are REAL (optionsEngineStoresFromSql over a
 * node:sqlite handle), and the test proves they are SQL-backed over
 * that handle by round-tripping an artifact through a second stores
 * object built over the same handle. Discovery semantics are pinned
 * by the outcome assembly passing through unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "../src/orm";
// Importing the trading barrel registers the broker platforms
// (src/trading/index.ts side effects) the unified action resolves.
import "../src/trading";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { optionsEngineStoresFromSql } from "../src/workflows/optionsScreenEngine";
import type {
  DiscoveryRunOutcome,
  DiscoveryRunRequest,
} from "../src/services/discoveryService";

const { mockRun, mockCreateDiscoveryService } = vi.hoisted(() => ({
  mockRun: vi.fn(),
  mockCreateDiscoveryService: vi.fn(),
}));
// Issue #3460 slice 3 idiom (tests/discovery_service.test.ts): the
// unified service reads the broker through the presence-aware seam
// (no default); these tests drive the E*TRADE path explicitly.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    readTenantBrokerSelection: async () => ({
      status: "ok",
      brokerId: "etrade",
    }),
  };
});
vi.mock("../src/services/discoveryService", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/discoveryService")>();
  return { ...actual, createDiscoveryService: mockCreateDiscoveryService };
});

/** The node:sqlite DO-storage double (tests/strategy_entry_routing_4273 idiom). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

function cannedOutcome(runId: string): DiscoveryRunOutcome {
  return {
    run: {
      id: runId,
      counts: { considered: 1, setups: 1, abstentions: 0, prescreenedOut: 0, errors: 0 },
      items: [
        {
          kind: "setup",
          symbol: "THRD",
          thesis: "bullish",
          ruleId: "trend-up",
          discoveryScore: 72,
          gateBucket: "fit",
          evidence: "trend",
          targetPrice: 140,
          targetDate: "2026-12-18",
        },
      ],
    } as DiscoveryRunOutcome["run"],
    deltas: [],
    errors: [],
  };
}

describe("unified discovery engine threading (#4398)", () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockCreateDiscoveryService.mockReset();
    mockCreateDiscoveryService.mockImplementation(() => ({ run: mockRun }));
    mockRun.mockImplementation(async () => cannedOutcome("run-unified-4398"));
  });

  it("threads engine stores built over discoverySql into the discovery run request", async () => {
    const sql = new SqliteTestStorage();
    const service = new UnifiedOptionsService(
      {} as never,
      "unified_thread_tester",
      undefined,
      undefined,
      undefined,
      undefined,
      sql as unknown as SqlStorage,
    );
    const res = await service.execute({ action: "discovery", symbols: ["THRD"] });
    expect(res.success).toBe(true);
    expect(mockRun).toHaveBeenCalledTimes(1);
    const request = mockRun.mock.calls[0][0] as DiscoveryRunRequest;
    expect(request.engineStores).toBeDefined();
    expect(request.engineStores?.stores).toBeDefined();
    expect(request.engineStores?.runRecorder).toBeDefined();

    // The threaded stores are SQL-backed over THIS handle: an
    // artifact written through the captured stores reads back
    // through a fresh stores object over the same handle.
    await request.engineStores!.stores.artifacts.putArtifact("probe-run", "probe", { ok: true });
    const fresh = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    await expect(
      fresh.stores.artifacts.getArtifact("probe-run", "probe"),
    ).resolves.toEqual({ ok: true });
  });

  it("the discovery outcome assembly is unchanged (run, deltas, errors, summary)", async () => {
    const sql = new SqliteTestStorage();
    const service = new UnifiedOptionsService(
      {} as never,
      "unified_assembly_tester",
      undefined,
      undefined,
      undefined,
      undefined,
      sql as unknown as SqlStorage,
    );
    const res = await service.execute({ action: "discovery", symbols: ["ASMB"] });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      run: expect.objectContaining({ id: "run-unified-4398" }),
      deltas: [],
      errors: [],
    });
    expect(res.summary).toContain("Discovery run over 1 name: 1 setup");
  });

  it("fails honestly when the discovery SQL seam is not wired", async () => {
    const service = new UnifiedOptionsService({} as never, "unified_unwired_tester");
    const res = await service.execute({ action: "discovery", symbols: ["SPY"] });
    expect(res.success).toBe(false);
    expect(res.summary).toContain("isn't wired");
    expect(mockCreateDiscoveryService).not.toHaveBeenCalled();
  });
});
