// @vitest-environment node
/**
 * Issue #3940 (#3550 precondition (a)) — the tenant-aware canonical leg:
 * the generate stage resolves the report-owning tenant and writes the
 * canonical copy through the orchestrator door, in BOTH residencies
 * (workflow + host). The leg records wired (never not_wired) when a
 * tenant resolves; an unconfigured tenant records not_wired with the
 * named reason — never a silent skip, never a default owner, never a
 * write into the pipeline host's own store (where no Reports view reads).
 */
import { describe, expect, it } from "vitest";
import {
  GENERATE_GAP_CODES,
  buildGenerateJobRegistry,
  createTenantAwareCanonicalReportStore,
  GenerateJobRegistry,
  runGenerateJob,
  type GenerateJobDefinition,
} from "../src/services/generateJobs";
import { generateStepDepsForScheduledAgent } from "../src/agents/scheduledTasksPipeline";
import { generateStepDepsForWorkflow } from "../src/workflows/jobPipelineWorkflow";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import type { AnalyzedDatasetStoreInput } from "../src/data/analyzedDatasetPorts";
import {
  storeReportAtGeneration,
  type CanonicalStoreResult,
  type ScheduledReportInput,
} from "../src/services/scheduledReports";
import { createCanonicalReportStorePorts } from "../src/data/createCanonicalReportStorePorts";
import type { DataProviderId, IndexId } from "../src/trading";
import { MockSqlStorage } from "./mock-sql";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ANALYZE_JOB = "yahoo-nasdaq100-quotes-enrich-analyze";
const JOB = `${ANALYZE_JOB}-generate`;

function def(overrides: Partial<GenerateJobDefinition> = {}): GenerateJobDefinition {
  return {
    id: JOB,
    analyzeJobId: ANALYZE_JOB,
    enrichJobId: "yahoo-nasdaq100-quotes-enrich",
    feedJobId: "yahoo-nasdaq100-quotes",
    sourceId: "yahoo" as DataProviderId,
    dataset: "quotes",
    universe: { kind: "index", index: "nasdaq100" as IndexId, label: "Nasdaq-100" },
    reports: ["analysis"],
    formats: ["json"],
    cadenceMinutes: 60,
    staleAfterMinutes: 180,
    ...overrides,
  };
}

function analyzedInput(
  runId: string,
  atMs: number,
): AnalyzedDatasetStoreInput {
  return {
    jobId: ANALYZE_JOB,
    enrichJobId: "yahoo-nasdaq100-quotes-enrich",
    feedJobId: "yahoo-nasdaq100-quotes",
    sourceId: "yahoo" as DataProviderId,
    dataset: "quotes",
    universe: {
      kind: "index",
      index: "nasdaq100",
      label: "Nasdaq-100",
      snapshotDate: "2026-11-02",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      size: 1,
    },
    inputArtifactId: `enriched-${runId}`,
    inputRunId: `enrich-${runId}`,
    inputAsOf: iso(atMs - 3600_000),
    ruleSets: ["momentum"],
    gaps: [],
    ruleCoverage: { momentum: { evaluated: 1, unavailable: 0 } },
    summary: {
      symbols: 1,
      advancers: 1,
      decliners: 0,
      flat: 0,
      meanMomentum: 1.4,
      meanCompositeScore: 8.5,
      topByComposite: [{ symbol: "AAPL", score: 40 }],
      bottomByComposite: [{ symbol: "AAPL", score: 40 }],
    },
    rows: [
      {
        symbol: "AAPL",
        lastPrice: 110,
        signals: { momentum: "strong_up" },
        scores: { momentum: 50 },
        compositeScore: 40,
        unavailable: [],
      },
    ],
    run: {
      runId,
      trigger: "manual",
      startedAt: iso(atMs),
      finishedAt: iso(atMs + 1000),
      status: "completed",
      requested: 1,
      received: 1,
      failed: 0,
      codedError: null,
      errorMessage: null,
    },
    nowIso: iso(atMs),
  };
}

function registryWith(d: GenerateJobDefinition): GenerateJobRegistry {
  const registry = new GenerateJobRegistry();
  registry.register(d);
  return registry;
}

async function seededStores() {
  const analyzedStore = new InMemoryAnalyzedDatasetStore();
  const generatedStore = new InMemoryGeneratedDatasetStore();
  await analyzedStore.store(analyzedInput("analyze-1", T0));
  return { analyzedStore, generatedStore };
}

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

describe("the tenant-aware canonical leg (#3940)", () => {
  it("stores under the job's configured owner through the door", async () => {
    const sql = new MockSqlStorage();
    const { analyzedStore, generatedStore } = await seededStores();
    const { calls, seam } = doorSeam(sql);
    const result = await runGenerateJob(
      registryWith(def({ reportOwnerLogin: "octocat" })),
      { analyzedStore, generatedStore, canonicalReportStore: seam },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("completed");
    expect(result.canonical).toEqual({ analysis: "stored" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userLogin).toBe("octocat");
    expect(calls[0]?.source).toBe("pipeline_generate");
    expect(calls[0]?.generationId).toMatch(
      /^pipeline-generate:yahoo-nasdaq100-quotes-enrich-analyze-generate:/,
    );
    // The canonical row lands in mas_reports under the job's
    // owner, and the Reports-surface read sees it there.
    const ports = createCanonicalReportStorePorts(sql as never);
    const rows = ports.read.listRows("octocat", undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("pipeline_generate");
    expect(ports.read.listRows("someone-else", undefined, 10)).toHaveLength(0);
    const artifact = await generatedStore.latestUsable(JOB);
    expect(artifact?.reports[0]?.canonical).toMatchObject({
      status: "stored",
      reportId: rows[0]?.id,
    });
    expect(artifact?.summary.canonicalStored).toBe(1);
  });

  it("the job's configured owner wins over the seam's bound owner", async () => {
    const sql = new MockSqlStorage();
    const { analyzedStore, generatedStore } = await seededStores();
    const { calls, seam } = doorSeam(sql, "service-user");
    const result = await runGenerateJob(
      registryWith(def({ reportOwnerLogin: "octocat" })),
      { analyzedStore, generatedStore, canonicalReportStore: seam },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000 },
    );
    expect(result.canonical).toEqual({ analysis: "stored" });
    expect(calls[0]?.userLogin).toBe("octocat");
  });

  it("falls back to the seam's bound owner when the job names none", async () => {
    const sql = new MockSqlStorage();
    const { analyzedStore, generatedStore } = await seededStores();
    const { calls, seam } = doorSeam(sql, "service-user");
    const result = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore, canonicalReportStore: seam },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000 },
    );
    expect(result.canonical).toEqual({ analysis: "stored" });
    expect(calls[0]?.userLogin).toBe("service-user");
  });

  it("no resolvable owner records not_wired with the named reason — run still completes", async () => {
    const sql = new MockSqlStorage();
    const { analyzedStore, generatedStore } = await seededStores();
    const { calls, seam } = doorSeam(sql);
    const result = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore, canonicalReportStore: seam },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("completed");
    expect(result.canonical).toEqual({ analysis: "not_wired" });
    expect(calls).toHaveLength(0);
    const artifact = await generatedStore.latestUsable(JOB);
    expect(artifact?.reports[0]?.canonical).toMatchObject({
      status: "not_wired",
      reason: GENERATE_GAP_CODES.canonicalOwnerUnconfigured,
    });
    expect(artifact?.summary.canonicalNotWired).toBe(1);
  });

  it("a re-run over the same persisted input dedupes through the door", async () => {
    const sql = new MockSqlStorage();
    const { analyzedStore, generatedStore } = await seededStores();
    const { seam } = doorSeam(sql, "octocat");
    const first = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore, canonicalReportStore: seam },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000 },
    );
    expect(first.canonical).toEqual({ analysis: "stored" });
    const second = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore, canonicalReportStore: seam },
      JOB,
      { runId: "gen-2", nowMs: T0 + 120_000 },
    );
    expect(second.canonical).toEqual({ analysis: "deduped" });
    const ports = createCanonicalReportStorePorts(sql as never);
    expect(ports.read.listRows("octocat", undefined, 10)).toHaveLength(1);
  });

  it("the registry resolves the owner from the per-job knob", () => {
    const registry = buildGenerateJobRegistry({
      GENERATE_JOB_YAHOO_NASDAQ100_QUOTES_ENRICH_ANALYZE_GENERATE_REPORT_OWNER_LOGIN:
        "octocat",
    });
    expect(registry.get(JOB)?.reportOwnerLogin).toBe("octocat");
    expect(buildGenerateJobRegistry({}).get(JOB)?.reportOwnerLogin).toBeUndefined();
  });
});

describe("the tenant-aware leg wiring (#3940)", () => {
  function fakeDoor() {
    const calls: ScheduledReportInput[] = [];
    return {
      calls,
      door: {
        recordPipelineGenerateReport: async (
          input: ScheduledReportInput,
        ): Promise<CanonicalStoreResult | null> => {
          calls.push(input);
          return {
            reportId: "rep-1",
            created: true,
            fanout: { code: "ok" } as CanonicalStoreResult["fanout"],
          };
        },
      },
    };
  }

  function fakeNamespace(door: unknown) {
    return {
      idFromName: (name: string) => name,
      get: () => door,
    };
  }

  it("the host wiring returns the tenant-aware leg (never null)", async () => {
    const { calls, door } = fakeDoor();
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
    const stored = await deps.canonicalReportStore?.store({
      runId: "gen-1",
      generationId: "pipeline-generate:test:artifact-1",
      userLogin: "octocat",
      title: "t",
      source: "pipeline_generate",
      summary: "s",
      body: { kind: "analysis" },
      createdAt: iso(T0),
    });
    expect(stored?.reportId).toBe("rep-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userLogin).toBe("octocat");
  });

  it("the workflow wiring returns the tenant-aware leg (never null)", async () => {
    const { calls, door } = fakeDoor();
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
    const stored = await deps.canonicalReportStore?.store({
      runId: "gen-1",
      generationId: "pipeline-generate:test:artifact-1",
      userLogin: "octocat",
      title: "t",
      source: "pipeline_generate",
      summary: "s",
      body: { kind: "analysis" },
      createdAt: iso(T0),
    });
    expect(stored?.reportId).toBe("rep-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userLogin).toBe("octocat");
  });
});
