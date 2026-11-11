// @vitest-environment node
/**
 * Issue #4060 (#3551 slice 1) — the options canonical leg: the
 * options persistCanonicalResults stage writes its canonical row
 * through the engine's tenant-aware leg
 * (createTenantAwareCanonicalReportStore, #3940) in BOTH residencies
 * (workflow + host). The leg records wired (never not_wired) for an
 * options report; the UnifiedOptionsRunRecord shape and the manual
 * record builder's generation-id scheme map onto the leg's input;
 * the goal leg's omitted-canonical case is an honest no-write with
 * its coded reason, identical in both residencies.
 */
import { describe, expect, it } from "vitest";
import {
  createTenantAwareCanonicalReportStore,
  type CanonicalReportStoreSeam,
} from "../src/services/generateJobs";
import { generateStepDepsForScheduledAgent } from "../src/agents/scheduledTasksPipeline";
import { generateStepDepsForWorkflow } from "../src/workflows/jobPipelineWorkflow";
import {
  storeReportAtGeneration,
  type CanonicalStoreResult,
  type ScheduledReportInput,
} from "../src/services/scheduledReports";
import { createCanonicalReportStorePorts } from "../src/data/createCanonicalReportStorePorts";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import {
  createOptionsScreenPorts,
  optionsArtifactKey,
  type OptionsStageStorage,
} from "../src/workflows/optionsScreenPorts";
import {
  createManualOptionsCanonicalLeg,
  OPTIONS_CANONICAL_LEG_REASONS,
  recordUnifiedOptionsRunThroughLeg,
} from "../src/workflows/optionsCanonicalLeg";
import type { UnifiedOptionsRunRecord } from "../src/services/optionsServeRecord";
import type { PlannerInput } from "../src/workflows/blocks/plannerPort";
import { MockSqlStorage } from "./mock-sql";

const OWNER = "owner@example.com";
const FILTER = { underlyingSymbols: ["AAPL"] };

function memoryStorage(): OptionsStageStorage & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    put: async (key, value) => {
      map.set(key, value);
    },
    get: async (key) => map.get(key) as never,
    keys: () => [...map.keys()],
  };
}

function request(runId: string): PlannerInput {
  return {
    assetClass: "options",
    runIdentity: { runId },
    trigger: "manual",
    classInput: { request: { filter: FILTER } },
  } as PlannerInput;
}

async function seedScreen(storage: OptionsStageStorage, runId: string): Promise<void> {
  await storage.put(optionsArtifactKey(runId, "screen"), {
    terminal: "completed",
    result: {
      filterSummary: "1 match across 1 underlying",
      matchedCount: 1,
      totalUnderlyingsScanned: 1,
    },
  });
}

function persistInput(runId: string, userLogin = OWNER) {
  return {
    runId,
    userLogin,
    stageId: "persistCanonicalResults",
    artifactKeys: [] as string[],
    request: request(runId),
  };
}

type PersistOutput = {
  terminal: string;
  created: boolean;
  reportId: string | null;
  record: UnifiedOptionsRunRecord;
  canonicalLeg: { status: string; reason?: string };
};

/** A door-bound seam whose record call writes through the REAL
 *  canonical seam (storeReportAtGeneration) over in-memory sql —
 *  the door's own storage, as the orchestrator door provides it. */
function doorSeam(sql: MockSqlStorage, ownerLogin?: string) {
  const calls: ScheduledReportInput[] = [];
  const record = async (
    input: ScheduledReportInput,
  ): Promise<CanonicalStoreResult | null> => {
    calls.push(input);
    return storeReportAtGeneration(sql as never, input);
  };
  const seam = createTenantAwareCanonicalReportStore({
    ...(ownerLogin !== undefined ? { ownerLogin } : {}),
    record,
  });
  return { calls, seam };
}

function fakeNamespace(door: unknown) {
  return {
    idFromName: (name: string) => name,
    get: () => door,
  };
}

/** A fake orchestrator door whose record writes through the REAL
 *  canonical seam over the given sql — the row lands where the
 *  Reports-surface read looks for it. */
function doorOverSql(sql: MockSqlStorage) {
  const calls: ScheduledReportInput[] = [];
  const door = {
    recordPipelineGenerateReport: async (
      input: ScheduledReportInput,
    ): Promise<CanonicalStoreResult | null> => {
      calls.push(input);
      return storeReportAtGeneration(sql as never, input);
    },
  };
  return { calls, door };
}

function portsWithLeg(
  storage: OptionsStageStorage,
  canonicalLeg: CanonicalReportStoreSeam,
  extra: Record<string, unknown> = {},
) {
  return createOptionsScreenPorts({
    screener: new DynamicOptionsScreener(),
    storage,
    canonicalLeg,
    shapeReport: async () => ({}),
    deliver: async () => ({}),
    ...extra,
  });
}

describe("the options canonical leg (#4060)", () => {
  it("writes through the leg and the Reports read sees it", async () => {
    const sql = new MockSqlStorage();
    const { calls, seam } = doorSeam(sql, "service-user");
    const storage = memoryStorage();
    const ports = portsWithLeg(storage, seam);
    await seedScreen(storage, "run-leg-1");
    const out = (await ports["persistCanonicalResults"].execute(
      persistInput("run-leg-1"),
    )) as PersistOutput;
    expect(out.terminal).toBe("completed");
    expect(out.created).toBe(true);
    expect(out.reportId).toBeTruthy();
    expect(out.canonicalLeg).toEqual({ status: "wired" });
    expect(calls).toHaveLength(1);
    // The run's owner wins over the seam's bound owner.
    expect(calls[0]?.userLogin).toBe(OWNER);
    expect(calls[0]?.source).toBe("options-screen-workflow");
    // The generation-id scheme maps onto the leg's input: the run
    // id IS the generation id.
    expect(calls[0]?.generationId).toBe("run-leg-1");
    expect((calls[0]?.body as { trigger?: string } | undefined)?.trigger).toBe("manual");
    // The canonical row lands in mas_reports and the
    // Reports-surface read sees it there, owner-scoped.
    const read = createCanonicalReportStorePorts(sql as never).read;
    const rows = read.listRows(OWNER, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(out.reportId);
    expect(rows[0]?.run_id).toBe("run-leg-1");
    expect(rows[0]?.source).toBe("options-screen-workflow");
    expect(read.listRows("someone-else", undefined, 10)).toHaveLength(0);
  });

  it("the host residency wiring returns the same leg (never null)", async () => {
    const sql = new MockSqlStorage();
    const { calls, door } = doorOverSql(sql);
    const ctx = {
      env: {
        ORCHESTRATOR_AGENT: fakeNamespace(door),
        SERVICE_USER_LOGIN: "service-user",
      },
      agentCtx: { storage: { sql: new MockSqlStorage() } },
    };
    const deps = generateStepDepsForScheduledAgent(ctx as never);
    expect(deps.canonicalReportStore).not.toBeNull();
    expect(deps.canonicalReportStore?.ownerLogin).toBe("service-user");
    const storage = memoryStorage();
    const ports = portsWithLeg(storage, deps.canonicalReportStore as CanonicalReportStoreSeam);
    await seedScreen(storage, "run-leg-host");
    const out = (await ports["persistCanonicalResults"].execute(
      persistInput("run-leg-host"),
    )) as PersistOutput;
    expect(out.created).toBe(true);
    expect(out.canonicalLeg).toEqual({ status: "wired" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userLogin).toBe(OWNER);
    const rows = createCanonicalReportStorePorts(sql as never).read.listRows(OWNER, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(out.reportId);
  });

  it("the workflow residency wiring returns the same leg (never null)", async () => {
    const sql = new MockSqlStorage();
    const { calls, door } = doorOverSql(sql);
    const env = {
      ORCHESTRATOR_AGENT: fakeNamespace(door),
      SERVICE_USER_LOGIN: "service-user",
    };
    const stores = {
      definitions: { getDefinition: async () => undefined },
    };
    const deps = generateStepDepsForWorkflow(env as never, stores as never);
    expect(deps.canonicalReportStore).not.toBeNull();
    expect(deps.canonicalReportStore?.ownerLogin).toBe("service-user");
    const storage = memoryStorage();
    const ports = portsWithLeg(storage, deps.canonicalReportStore as CanonicalReportStoreSeam);
    await seedScreen(storage, "run-leg-workflow");
    const out = (await ports["persistCanonicalResults"].execute(
      persistInput("run-leg-workflow"),
    )) as PersistOutput;
    expect(out.created).toBe(true);
    expect(out.canonicalLeg).toEqual({ status: "wired" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userLogin).toBe(OWNER);
    const rows = createCanonicalReportStorePorts(sql as never).read.listRows(OWNER, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(out.reportId);
  });

  it("a re-run over the same runId dedupes through the leg", async () => {
    const sql = new MockSqlStorage();
    const { seam } = doorSeam(sql, "service-user");
    const storage = memoryStorage();
    const ports = portsWithLeg(storage, seam);
    await seedScreen(storage, "run-leg-2");
    const first = (await ports["persistCanonicalResults"].execute(
      persistInput("run-leg-2"),
    )) as PersistOutput;
    const second = (await ports["persistCanonicalResults"].execute(
      persistInput("run-leg-2"),
    )) as PersistOutput;
    expect(first.created).toBe(true);
    expect(first.canonicalLeg).toEqual({ status: "wired" });
    expect(second.created).toBe(false);
    expect(second.canonicalLeg).toEqual({ status: "wired" });
    expect(second.reportId).toBe(first.reportId);
    const rows = createCanonicalReportStorePorts(sql as never).read.listRows(OWNER, undefined, 10);
    expect(rows).toHaveLength(1);
  });

  it("the manual record builder's shape maps onto the leg's input", async () => {
    const sql = new MockSqlStorage();
    const { calls, seam } = doorSeam(sql, "service-user");
    const storage = memoryStorage();
    const ports = portsWithLeg(storage, seam, {
      record: async ({ runId, userLogin }: { runId: string; userLogin: string }) => ({
        runId,
        generationId: runId,
        title: "Options contract screen — AAPL",
        source: "options_scanner",
        summary: "1 underlyings scanned, 0 contracts evaluated, 1 matched.",
        trigger: "manual",
        userLogin,
        filter: FILTER,
        result: { matchedCount: 1 },
        provenance: { dataProviderId: "etrade", brokerId: "etrade" },
      }),
    });
    await seedScreen(storage, "run-leg-3");
    const out = (await ports["persistCanonicalResults"].execute(
      persistInput("run-leg-3"),
    )) as PersistOutput;
    expect(out.created).toBe(true);
    expect(out.canonicalLeg).toEqual({ status: "wired" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.title).toBe("Options contract screen — AAPL");
    expect(calls[0]?.source).toBe("options_scanner");
    expect(calls[0]?.generationId).toBe("run-leg-3");
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body["filter"]).toEqual(FILTER);
    expect(body["result"]).toEqual({ matchedCount: 1 });
    expect(body["provenance"]).toEqual({ dataProviderId: "etrade", brokerId: "etrade" });
    const rows = createCanonicalReportStorePorts(sql as never).read.listRows(OWNER, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("options_scanner");
  });

  it("a leg refusal records failed with the coded reason — run still completes", async () => {
    const storage = memoryStorage();
    const seam = createTenantAwareCanonicalReportStore({
      ownerLogin: "service-user",
      record: async () => null,
    });
    const ports = portsWithLeg(storage, seam);
    await seedScreen(storage, "run-leg-4");
    const out = (await ports["persistCanonicalResults"].execute(
      persistInput("run-leg-4"),
    )) as PersistOutput;
    expect(out.terminal).toBe("completed");
    expect(out.created).toBe(false);
    expect(out.reportId).toBeNull();
    expect(out.canonicalLeg).toEqual({
      status: "failed",
      reason: OPTIONS_CANONICAL_LEG_REASONS.storeRefused,
    });
  });

  it("a leg throw records failed with the coded reason — run still completes", async () => {
    const storage = memoryStorage();
    const seam = createTenantAwareCanonicalReportStore({
      ownerLogin: "service-user",
      record: async () => {
        throw new Error("door down");
      },
    });
    const ports = portsWithLeg(storage, seam);
    await seedScreen(storage, "run-leg-5");
    const out = (await ports["persistCanonicalResults"].execute(
      persistInput("run-leg-5"),
    )) as PersistOutput;
    expect(out.terminal).toBe("completed");
    expect(out.created).toBe(false);
    expect(out.reportId).toBeNull();
    expect(out.canonicalLeg).toEqual({
      status: "failed",
      reason: OPTIONS_CANONICAL_LEG_REASONS.storeThrew,
    });
  });

  it("no leg and no store is the goal leg's honest omission", async () => {
    const storage = memoryStorage();
    const ports = createOptionsScreenPorts({
      screener: new DynamicOptionsScreener(),
      storage,
      shapeReport: async () => ({}),
      deliver: async () => ({}),
    });
    await seedScreen(storage, "run-leg-6");
    const out = (await ports["persistCanonicalResults"].execute(
      persistInput("run-leg-6"),
    )) as PersistOutput;
    expect(out.terminal).toBe("completed");
    expect(out.created).toBe(false);
    expect(out.reportId).toBeNull();
    expect(out.canonicalLeg).toEqual({
      status: "omitted",
      reason: OPTIONS_CANONICAL_LEG_REASONS.omittedGoalLeg,
    });
  });

  it("the legacy direct store still writes, labeled direct", async () => {
    const storage = memoryStorage();
    const recorded: Array<Record<string, unknown>> = [];
    const ports = createOptionsScreenPorts({
      screener: new DynamicOptionsScreener(),
      storage,
      canonical: {
        storeCanonicalReport: (input: Record<string, unknown>) => {
          recorded.push(input);
          return { reportId: "r-direct", created: true };
        },
      },
      shapeReport: async () => ({}),
      deliver: async () => ({}),
    });
    await seedScreen(storage, "run-leg-7");
    const out = (await ports["persistCanonicalResults"].execute(
      persistInput("run-leg-7"),
    )) as PersistOutput;
    expect(out.terminal).toBe("completed");
    expect(out.created).toBe(true);
    expect(out.reportId).toBe("r-direct");
    expect(out.canonicalLeg).toEqual({ status: "direct" });
    expect(recorded).toHaveLength(1);
  });

  it("the leg wins when both are bound — the direct store is never called", async () => {
    const sql = new MockSqlStorage();
    const { seam } = doorSeam(sql, "service-user");
    const storage = memoryStorage();
    let directCalls = 0;
    const ports = createOptionsScreenPorts({
      screener: new DynamicOptionsScreener(),
      storage,
      canonicalLeg: seam,
      canonical: {
        storeCanonicalReport: () => {
          directCalls += 1;
          return { reportId: "r-direct", created: true };
        },
      },
      shapeReport: async () => ({}),
      deliver: async () => ({}),
    });
    await seedScreen(storage, "run-leg-8");
    const out = (await ports["persistCanonicalResults"].execute(
      persistInput("run-leg-8"),
    )) as PersistOutput;
    expect(out.created).toBe(true);
    expect(out.canonicalLeg).toEqual({ status: "wired" });
    expect(directCalls).toBe(0);
    const rows = createCanonicalReportStorePorts(sql as never).read.listRows(OWNER, undefined, 10);
    expect(rows).toHaveLength(1);
  });

  it("the shapeReport re-record through the leg backfills onto the same row", async () => {
    const sql = new MockSqlStorage();
    const { seam } = doorSeam(sql, "service-user");
    const storage = memoryStorage();
    const ports = portsWithLeg(storage, seam);
    await seedScreen(storage, "run-leg-9");
    const out = (await ports["persistCanonicalResults"].execute(
      persistInput("run-leg-9"),
    )) as PersistOutput;
    expect(out.created).toBe(true);
    // The manual delivery's shapeReport re-record: the same record
    // plus the report keys, same generationId — the seam backfills
    // the missing key/status fields onto the persist row, no second
    // row.
    const reRecorded = await recordUnifiedOptionsRunThroughLeg(seam, {
      ...out.record,
      pdfKey: "pdf-1",
      pdfStatus: "generated",
      xlsxKey: "xlsx-1",
      xlsxStatus: "generated",
      csvKey: "csv-1",
      csvStatus: "generated",
      reportUrl: "/api/options/report.pdf?key=pdf-1",
    });
    expect(reRecorded.status).toBe("wired");
    expect(reRecorded.created).toBe(false);
    expect(reRecorded.reportId).toBe(out.reportId);
    const rows = createCanonicalReportStorePorts(sql as never).read.listRows(OWNER, undefined, 10);
    expect(rows).toHaveLength(1);
    const body = JSON.parse(rows[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body["pdfKey"]).toBe("pdf-1");
    expect(body["pdfStatus"]).toBe("generated");
    expect(body["xlsxKey"]).toBe("xlsx-1");
    expect(body["csvKey"]).toBe("csv-1");
    expect(body["reportUrl"]).toBe("/api/options/report.pdf?key=pdf-1");
    // The first-write fields survive the re-record.
    expect(body["trigger"]).toBe("manual");
  });
});

describe("the manual entry's leg builder (#4060)", () => {
  it("builds the workflow-residency leg (never null)", async () => {
    const calls: ScheduledReportInput[] = [];
    const door = {
      recordPipelineGenerateReport: async (
        input: ScheduledReportInput,
      ): Promise<CanonicalStoreResult | null> => {
        calls.push(input);
        return { reportId: "rep-1", created: true, fanout: { code: "ok" } as CanonicalStoreResult["fanout"] };
      },
    };
    const env = {
      ORCHESTRATOR_AGENT: fakeNamespace(door),
      SERVICE_USER_LOGIN: "service-user",
    };
    const leg = createManualOptionsCanonicalLeg(env as never);
    expect(leg.ownerLogin).toBe("service-user");
    const stored = await leg.store({
      runId: "run-leg-manual",
      generationId: "run-leg-manual",
      userLogin: OWNER,
      title: "Options contract screen — AAPL",
      source: "options_scanner",
      summary: "s",
      body: { trigger: "manual" },
      createdAt: new Date().toISOString(),
    });
    expect(stored?.reportId).toBe("rep-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userLogin).toBe(OWNER);
  });
});
