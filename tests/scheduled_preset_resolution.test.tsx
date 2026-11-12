/**
 * Issue #1499 (#940-E): scheduled runs reference presetId, resolved at
 * RUN time.
 *
 * - resolvePresetFilter: user-scoped lookup (another user's id reads as
 *   missing), unreadable JSON, strict revalidation of stored criteria,
 *   both asset classes.
 * - Server builder: buildSchedulePayload arms presetId onto a
 *   market-screen schedule (the strict schedule schema accepts it).
 * - Client builder: a chosen preset replaces the custom thresholds in
 *   the submitted payload — never merged, never frozen alongside.
 * - Service hook: autonomousMarketScreen resolves the preset before any
 *   broker work; a missing/foreign/wrong-asset-class preset fails the
 *   run loudly through the service's failure contract (no runScreen
 *   call, no silent unfiltered run); a good preset's criteria reach
 *   runScreen as the run's filters.
 * - Source pins: the scheduled callback's payload type carries presetId,
 *   and the schedule form modal owns the preset picker.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolvePresetFilter } from "../src/services/screenerPresetResolution";
import {
  buildSchedulePayload,
  marketScreenScheduleCriteriaSchema,
} from "../src/trading/screeningSchemas";
import { buildScheduleSubmission } from "../src/client/scheduledOptionsManager/payloadBuilders";
import type { ScheduleFormState } from "../src/client/scheduledOptionsManager/types";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";

function fakePresetSql(
  rows: Record<string, { asset_class: string; criteria_json: string }>
) {
  return {
    exec: (_query: string, ...params: unknown[]) => {
      const [id, userLogin] = params as string[];
      const row = rows[`${id}:${userLogin}`];
      return row ? [row] : [];
    },
  };
}

const STOCK_ROW = {
  asset_class: "stocks",
  criteria_json: JSON.stringify({ minRsi: 30, maxRsi: 70 }),
};
const OPTIONS_ROW = {
  asset_class: "options",
  criteria_json: JSON.stringify({ contractType: "CALL", minDelta: 0.2 }),
};

describe("Issue #1499 — resolvePresetFilter", () => {
  it("returns the parser-normalized criteria for the caller's own preset", () => {
    const sql = fakePresetSql({ "p1:alice": STOCK_ROW });
    expect(resolvePresetFilter(sql as any, "alice", "p1")).toEqual({
      ok: true,
      assetClass: "stocks",
      criteria: { minRsi: 30, maxRsi: 70 },
    });
    const options = fakePresetSql({ "p2:alice": OPTIONS_ROW });
    expect(resolvePresetFilter(options as any, "alice", "p2")).toEqual({
      ok: true,
      assetClass: "options",
      criteria: { contractType: "CALL", minDelta: 0.2 },
    });
  });

  it("a missing id and another user's id both read as 'Preset not found.'", () => {
    const sql = fakePresetSql({ "p1:alice": STOCK_ROW });
    expect(resolvePresetFilter(sql as any, "alice", "nope")).toEqual({
      ok: false,
      error: "Preset not found.",
    });
    expect(resolvePresetFilter(sql as any, "bob", "p1")).toEqual({
      ok: false,
      error: "Preset not found.",
    });
  });

  it("unreadable JSON and criteria the strict parser rejects both fail loudly", () => {
    const badJson = fakePresetSql({
      "p1:alice": { asset_class: "stocks", criteria_json: "{not json" },
    });
    expect(resolvePresetFilter(badJson as any, "alice", "p1")).toEqual({
      ok: false,
      error: "Preset criteria are unreadable.",
    });
    const badCriteria = fakePresetSql({
      "p1:alice": {
        asset_class: "stocks",
        criteria_json: JSON.stringify({ minRsi: 30, deltaMin: 0.2 }),
      },
    });
    const resolved = resolvePresetFilter(badCriteria as any, "alice", "p1");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain("deltaMin");
  });

  it("a row with an unknown asset class fails, and a throwing store fails", () => {
    const weird = fakePresetSql({
      "p1:alice": { asset_class: "bonds", criteria_json: "{}" },
    });
    expect(resolvePresetFilter(weird as any, "alice", "p1")).toEqual({
      ok: false,
      error: "Preset has an unknown asset class.",
    });
    const throwing = { exec: () => { throw new Error("boom"); } };
    expect(resolvePresetFilter(throwing as any, "alice", "p1")).toEqual({
      ok: false,
      error: "Failed to load preset.",
    });
  });
});

describe("Issue #1499 — schedule payload carries presetId", () => {
  it("the market-screen schedule schema accepts presetId", () => {
    const parsed = marketScreenScheduleCriteriaSchema.safeParse({
      universe: "NASDAQ100",
      presetId: "p1",
    });
    expect(parsed.success).toBe(true);
  });

  it("buildSchedulePayload arms presetId onto the schedule payload", () => {
    const built = buildSchedulePayload(
      "autonomousMarketScreen",
      { universe: "NASDAQ100", presetId: "p1" },
      { userLogin: "alice", environment: "TEST", trigger: "scheduled" }
    );
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.value.presetId).toBe("p1");
  });

  it("buildScheduleSubmission sends presetId INSTEAD of the custom thresholds", () => {
    const form = {
      jobType: "marketScreen",
      targetSymbols: "",
      maxItems: 100,
      targetUniverse: "NASDAQ100",
      sector: "Technology",
      minPrice: "10",
      maxPrice: "500",
      minMarketCap: "",
      maxPe: "",
      trendFilter: "",
      presetId: "p1",
      scheduleType: "interval",
      intervalSeconds: 3600,
      cronExpression: "",
      delaySeconds: 1800,
      scheduledDate: "",
      thesis: "bullish",
      riskProfile: "balanced",
      pushToSlack: false,
      slackChannel: "",
      emailTo: "",
      webhookUrl: "",
      discoveryRequests: [],
      discoveryInputModel: "saved-request",
      derivedSource: "symbols",
      derivedSymbolsText: "",
      derivedWatchlistName: "",
      derivedProfileId: "",
      noViewDraft: {},
      environment: "TEST",
    } as unknown as ScheduleFormState;
    const built = buildScheduleSubmission(form);
    expect("requestBody" in built).toBe(true);
    if ("requestBody" in built) {
      expect(built.requestBody.payload.presetId).toBe("p1");
      expect(built.requestBody.payload).not.toHaveProperty("filters");
    }
  });
});

describe("Issue #1499 — service hook resolves presetId at run time", () => {
  // Issue #4278: the screen runs through the one engine seam, not the
  // agent's runScreen. The seam fake delegates to the stub agent's
  // runScreen: it flattens the seam input back into the runScreen
  // request and returns the stub's result as the engine run's one
  // shard. The seam itself is pinned in
  // tests/stock_entry_routing_4278.test.ts.
  const delegateSeamFake = (runScreen: (req: any) => Promise<any>) => async (input: any) => {
    const flat = {
      trigger: input.spec.trigger,
      sector: input.commandOverrides?.sector ?? input.spec.filters?.sector,
      universe: input.spec.universe,
      maxSymbols: input.commandOverrides?.maxSymbols,
      filters: input.spec.filters,
      userLogin: input.userLogin,
      environment: input.environment,
      portfolioContext: input.portfolioContext,
      provider: input.commandOverrides?.provider ?? input.spec.provider,
      broker: input.commandOverrides?.broker,
      ...(input.commandOverrides?.mode
        ? { mode: input.commandOverrides.mode, modeSource: input.commandOverrides.modeSource }
        : {}),
    };
    const result = await runScreen(flat);
    return {
      results: [result],
      collation: null,
      jobId: input.spec?.jobId ?? "test-job",
      workflowId: "wf-1",
    };
  };

  const mockRunScreen = vi.fn();
  let env: any;
  const sessionId = "preset_resolution_trader";

  beforeEach(() => {
    vi.restoreAllMocks();
    mockRunScreen.mockReset();
    mockRunScreen.mockResolvedValue({
      success: true,
      sector: "Technology",
      universe: "NASDAQ100",
      totalScanned: 10,
      matchedCount: 1,
      opportunities: [{ symbol: "NVDA" }],
      allStocks: [],
      expectedCount: 10,
    });
    env = {
      APP_ENV: "TEST",
      APP_BASE_URL: "https://agent.openaimp.com",
      ETRADE_ENVIRONMENT: "sandbox",
      SCREENER_AGENT: {
        idFromName: () => "mock-screener",
        get: () => ({ runScreen: mockRunScreen }),
      },
    };
  });

  function makeService(sql: unknown) {
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema(sessionId);
    const service = new ScheduledTasksService(env, orm, sessionId, undefined, undefined, undefined, undefined, undefined, { sql } as any);
    (service as any).runStockScreenViaEngine = delegateSeamFake(mockRunScreen);
    return service;
  }

  it("a stocks preset's criteria reach runScreen as the run's filters", async () => {
    const service = makeService(fakePresetSql({ "p1:preset_resolution_trader": STOCK_ROW }));
    await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      presetId: "p1",
    });
    expect(mockRunScreen).toHaveBeenCalledTimes(1);
    expect(mockRunScreen.mock.calls[0][0].filters).toEqual({ minRsi: 30, maxRsi: 70 });
  });

  it("a missing preset fails the run loudly and never calls runScreen", async () => {
    const service = makeService(fakePresetSql({}));
    const res = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      presetId: "gone",
    });
    expect(mockRunScreen).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.error).toContain("Preset not found.");
  });

  it("an options preset on a stock screen fails loudly with the mismatch", async () => {
    const service = makeService(fakePresetSql({ "p2:preset_resolution_trader": OPTIONS_ROW }));
    const res = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      presetId: "p2",
    });
    expect(mockRunScreen).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.error).toContain("options preset");
  });

  it("without a sql host the run fails instead of running unfiltered", async () => {
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema(sessionId);
    const service = new ScheduledTasksService(env, orm, sessionId);
    const res = await service.autonomousMarketScreen({
      universe: "NASDAQ100",
      presetId: "p1",
    });
    expect(mockRunScreen).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.error).toContain("unavailable");
  });
});

describe("Issue #1499 — source pins", () => {
  it("the scheduled callback's payload type carries presetId", () => {
    const source = readFileSync("src/agents/orchestrator/scheduledCallbacks.ts", "utf8");
    expect(source).toContain("presetId?: string;");
  });

  it("the schedule form modal owns the preset picker", () => {
    const modal = readFileSync("src/client/scheduledOptionsManager/ScheduleFormModal.tsx", "utf8");
    expect(modal).toContain("sched-preset");
    expect(modal).toContain("listPresets");
    const manager = readFileSync("src/client/ScheduledOptionsManager.tsx", "utf8");
    expect(manager).toContain("presetId={presetId}");
    expect(manager).toContain("setPresetId={setPresetId}");
  });
});
