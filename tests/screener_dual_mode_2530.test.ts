/**
 * Issue #2530 — screener workflows in two modes: deterministic
 * execution (today's behavior, the default for every caller)
 * and a sanctioned non-deterministic mode under design
 * option (a): ONE prompt interpretation step at the head of
 * the parent workflow run produces a DATA artifact (screen
 * criteria), a deterministic validator gates it, and the
 * existing deterministic pipeline executes it. Execution and
 * replay stay deterministic in both modes (§8 doctrine:
 * prompt interprets, deterministic code decides).
 *
 * #4192: the retired child-workflow flow (runParentFlow +
 * ChildWorkflowOps + fake ScreenerWorkflowStep + virtual
 * clock) is gone. The parent-flow suites below drive the
 * engine path instead: the InMemoryWorkflowAdapter over
 * ScreenerWorkflowDeps (the same adapter the anchor file
 * tests/screener_workflows.test.ts proves), with the ND deps
 * (ndModeEnabled / intentInterpreter / auditInterpretation)
 * in deps. Pure-helper suites just re-point their imports
 * at screenerCollation.ts. The door, routes-helper, and
 * golden-pair suites are unchanged in intent — the door and
 * routes seams survive, and the golden pair already drove
 * the adapter.
 *
 * Suites:
 *  - the SCREENER_ND_MODE gate (flag, default OFF, fail-closed);
 *  - the command contract (mode + intent validation);
 *  - the criteria-artifact validator (the deterministic gate);
 *  - the parent flow on the adapter (ND happy path / refusal /
 *    gate refusals; deterministic parity);
 *  - the mesh screen door (mode selection at the seam);
 *  - the API selection helper (routes share it);
 *  - the golden-task pair (same request, both modes).
 */
import { describe, expect, it } from "vitest";
import {
  resolveScreenerNdGate,
  SCREENER_ND_MODE_SWITCH,
} from "../src/config/screenerModes";
import {
  validateScreenCriteriaArtifact,
  type ScreenIntentInterpreter,
  type ScreenInterpretationAuditRecord,
} from "../src/workflows/screenCriteriaArtifact";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import {
  type ScreenerWorkflowDeps,
  type ShardScreenRequest,
  type ShardScreenResult,
} from "../src/workflows/screenerCollation";
import {
  assertWorkflowJobCommand,
  WorkflowError,
  type ParentScreenReportInput,
  type WorkflowJobCommand,
} from "../src/workflows/workflowPorts";

/* ------------------------------------------------------------------ */
/* Factories                                                           */
/* ------------------------------------------------------------------ */

function parentCommand(overrides: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "job-2530",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "alice",
    role: "parent",
    tenantId: "tenant-1",
    shards: [{ shardId: "NASDAQ100", universe: "NASDAQ100" }],
    deliver: true,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* The flag: SCREENER_ND_MODE (default OFF, fail closed)               */
/* ------------------------------------------------------------------ */

describe("SCREENER_ND_MODE gate (#2530)", () => {
  it("is named SCREENER_ND_MODE", () => {
    expect(SCREENER_ND_MODE_SWITCH).toBe("SCREENER_ND_MODE");
  });

  it("defaults OFF when unset or blank", () => {
    expect(resolveScreenerNdGate(undefined)).toEqual({ enabled: false, invalid: false });
    expect(resolveScreenerNdGate(null)).toEqual({ enabled: false, invalid: false });
    expect(resolveScreenerNdGate("")).toEqual({ enabled: false, invalid: false });
    expect(resolveScreenerNdGate("   ")).toEqual({ enabled: false, invalid: false });
  });

  it("enables only on an explicit on (case-insensitive, padded)", () => {
    expect(resolveScreenerNdGate("on")).toEqual({ enabled: true, invalid: false, raw: "on" });
    expect(resolveScreenerNdGate("ON")).toEqual({ enabled: true, invalid: false, raw: "ON" });
    expect(resolveScreenerNdGate(" on ")).toEqual({ enabled: true, invalid: false, raw: " on " });
    expect(resolveScreenerNdGate("off")).toEqual({ enabled: false, invalid: false, raw: "off" });
  });

  it("fails closed to OFF on an unrecognized value (invalid, never on)", () => {
    const resolved = resolveScreenerNdGate("banana");
    expect(resolved.enabled).toBe(false);
    expect(resolved.invalid).toBe(true);
    expect(resolved.raw).toBe("banana");
    expect(resolveScreenerNdGate(42).invalid).toBe(true);
    expect(resolveScreenerNdGate(42).enabled).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The command contract: mode + intent                                 */
/* ------------------------------------------------------------------ */

describe("workflow command mode contract (#2530)", () => {
  it("accepts a command with no mode (deterministic by default)", () => {
    expect(assertWorkflowJobCommand(parentCommand()).screenMode).toBeUndefined();
    expect(
      assertWorkflowJobCommand(parentCommand({ screenMode: "deterministic" })).screenMode,
    ).toBe("deterministic");
  });

  it("accepts a non-deterministic command with a non-blank intent", () => {
    const cmd = assertWorkflowJobCommand(
      parentCommand({
        screenMode: "non-deterministic",
        screenIntent: "large-cap tech names with strong momentum",
      }),
    );
    expect(cmd.screenMode).toBe("non-deterministic");
  });

  it("refuses ND mode without an intent, or with a blank intent", () => {
    expect(() =>
      assertWorkflowJobCommand(parentCommand({ screenMode: "non-deterministic" })),
    ).toThrow(WorkflowError);
    expect(() =>
      assertWorkflowJobCommand(
        parentCommand({ screenMode: "non-deterministic", screenIntent: "   " }),
      ),
    ).toThrow(/screenIntent/);
  });

  it("refuses an intent without ND mode (never silently ignored)", () => {
    expect(() =>
      assertWorkflowJobCommand(parentCommand({ screenIntent: "momentum please" })),
    ).toThrow(/screenIntent/);
    expect(() =>
      assertWorkflowJobCommand(
        parentCommand({ screenMode: "deterministic", screenIntent: "momentum please" }),
      ),
    ).toThrow(/screenIntent/);
  });

  it("refuses an unrecognized mode and an over-long intent", () => {
    expect(() =>
      assertWorkflowJobCommand(
        parentCommand({ screenMode: "hybrid" as WorkflowJobCommand["screenMode"] }),
      ),
    ).toThrow(WorkflowError);
    expect(() =>
      assertWorkflowJobCommand(
        parentCommand({
          screenMode: "non-deterministic",
          screenIntent: "x".repeat(2001),
        }),
      ),
    ).toThrow(/screenIntent/);
  });

  it("refuses ND mode on a goal-screen command (goal runs interpret via their scenario)", () => {
    expect(() =>
      assertWorkflowJobCommand(
        parentCommand({
          screenMode: "non-deterministic",
          screenIntent: "growth names",
          goalScreen: {
            scenario: { goalKind: "growth" },
            scenarioSource: "built",
          } as unknown as WorkflowJobCommand["goalScreen"],
        }),
      ),
    ).toThrow(/goal/i);
  });
});

/* ------------------------------------------------------------------ */
/* The validator: the deterministic gate over the prompt's artifact    */
/* ------------------------------------------------------------------ */

describe("validateScreenCriteriaArtifact (#2530)", () => {
  it("accepts a schema-valid filters artifact and returns the parsed filters", () => {
    const verdict = validateScreenCriteriaArtifact({
      filters: { sector: "Technology", minPrice: 10, gainersOnly: true },
      rationale: "tech momentum",
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.filters).toEqual({ sector: "Technology", minPrice: 10, gainersOnly: true });
      expect(verdict.rationale).toBe("tech momentum");
    }
  });

  it("refuses non-object artifacts (strings, arrays, null) — data only, never code", () => {
    for (const raw of ["minPrice > 10", ["filters"], null, 42, undefined]) {
      const verdict = validateScreenCriteriaArtifact(raw);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reasons.length).toBeGreaterThan(0);
    }
  });

  it("refuses an artifact without a filters object", () => {
    expect(validateScreenCriteriaArtifact({}).ok).toBe(false);
    expect(validateScreenCriteriaArtifact({ rationale: "no criteria" }).ok).toBe(false);
    expect(validateScreenCriteriaArtifact({ filters: "minPrice>10" }).ok).toBe(false);
  });

  it("refuses filter keys outside the existing screen contract (no invented vocabulary)", () => {
    const verdict = validateScreenCriteriaArtifact({
      filters: { minPrice: 10, dropTable: true },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons.join(" ")).toMatch(/filter/i);
  });

  it("refuses incoherent paired bounds", () => {
    for (const filters of [
      { minPrice: 50, maxPrice: 10 },
      { minRsi: 80, maxRsi: 20 },
      { minPercentB: 0.9, maxPercentB: 0.1 },
      { minAtrPct: 5, maxAtrPct: 1 },
    ]) {
      const verdict = validateScreenCriteriaArtifact({ filters });
      expect(verdict.ok, JSON.stringify(filters)).toBe(false);
      if (!verdict.ok) expect(verdict.reasons.join(" ")).toMatch(/exceeds/);
    }
  });

  it("refuses a non-string or over-long rationale (rationale is data, never executed)", () => {
    expect(validateScreenCriteriaArtifact({ filters: {}, rationale: 42 }).ok).toBe(false);
    expect(
      validateScreenCriteriaArtifact({ filters: {}, rationale: "x".repeat(501) }).ok,
    ).toBe(false);
    expect(validateScreenCriteriaArtifact({ filters: {} }).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The parent flow on the adapter: ND head → engine dispatch           */
/*                                                                     */
/* #4192: runParentFlow + ChildWorkflowOps + the fake step + the       */
/* virtual clock are retired. The same intents now drive the           */
/* InMemoryWorkflowAdapter: the ND head (interpret → validate →        */
/* audit) runs as the dispatch's adapter gate, and the screen          */
/* itself executes through the engine's six canned steps. The          */
/* runner is the observation seam now: what the retired flow           */
/* asserted on the fanned-out child commands (merged filters,          */
/* universe, mode) is asserted on the screen request the engine        */
/* hands the runner, and what it asserted on the returned              */
/* collation is asserted on the parent canonical row the               */
/* finalize tail stores (parentStored[0].collation) plus the           */
/* projected rows. A refused dispatch never throws from the            */
/* adapter: infra refusals (gate closed, no interpreter, a             */
/* throwing interpreter) settle as adapter status "errored"; a        */
/* refused ARTIFACT settles as a Failed collation with adapter         */
/* status "complete" and zero shards started.                          */
/* ------------------------------------------------------------------ */

interface AdapterParentHarness {
  audits: ScreenInterpretationAuditRecord[];
  /** The screen requests the engine handed the runner (one per shard that ran). */
  runRequests: ShardScreenRequest[];
  interpretCalls: Array<{ intent: string }>;
  stored: unknown[];
  delivered: unknown[];
  parentStored: ParentScreenReportInput[];
  store: InMemoryShardJobAdapter;
  adapter: InMemoryWorkflowAdapter;
}

function makeAdapterParentHarness(opts: {
  ndModeEnabled?: boolean;
  artifact?: unknown;
  interpreter?: ScreenIntentInterpreter;
} = {}): AdapterParentHarness {
  const audits: ScreenInterpretationAuditRecord[] = [];
  const runRequests: ShardScreenRequest[] = [];
  const interpretCalls: Array<{ intent: string }> = [];
  const stored: unknown[] = [];
  const delivered: unknown[] = [];
  const parentStored: ParentScreenReportInput[] = [];
  const store = new InMemoryShardJobAdapter();
  const interpreter: ScreenIntentInterpreter | undefined =
    opts.interpreter ??
    (opts.artifact !== undefined
      ? {
          interpret: async (input) => {
            interpretCalls.push({ intent: input.intent });
            return opts.artifact;
          },
        }
      : undefined);
  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      runScreen: async (req) => {
        runRequests.push(req);
        const full = {
          marker: "full-result",
          universe: req.universe ?? "NASDAQ100",
        };
        const summary: ShardScreenResult = {
          success: true,
          timestamp: "2026-10-31T12:00:00.000Z",
          universe: req.universe,
          totalScanned: 10,
          expectedCount: 10,
          matchedCount: 2,
          pdfKey: `screener/${req.universe ?? "NASDAQ100"}/report.pdf`,
          trigger: "manual",
          full,
        };
        return summary;
      },
    },
    shardStore: store,
    storeReport: async (payload) => {
      stored.push(payload);
    },
    deliverOutcome: async (payload) => {
      delivered.push(payload);
    },
    storeParentReport: async (input) => {
      parentStored.push(input);
      return { stored: true, reportId: "parent-1" };
    },
    nowMs: () => 1_000_000,
    // The harness models an environment where the flag is ON
    // unless a test closes it explicitly.
    ndModeEnabled: opts.ndModeEnabled ?? true,
    ...(interpreter ? { intentInterpreter: interpreter } : {}),
    auditInterpretation: async (record) => {
      audits.push(record);
    },
  };
  const adapter = new InMemoryWorkflowAdapter(deps);
  return { audits, runRequests, interpretCalls, stored, delivered, parentStored, store, adapter };
}

/** The collation the parent canonical row carries (the door's read-back). */
async function collationFor(store: InMemoryShardJobAdapter, jobId: string) {
  const row = await store.latestJob("tenant-1", jobId, jobId);
  return JSON.parse(row?.resultJson ?? "{}") as Record<string, unknown>;
}

const ND_INTENT = "large-cap tech names with strong momentum and reasonable valuations";

describe("adapter: runParentFlow dual-mode (#2530)", () => {
  it("ND happy path: interprets once, validates, audits, and runs the screen with the merged filters", async () => {
    const h = makeAdapterParentHarness({
      artifact: { filters: { minPrice: 25, sector: "Technology" }, rationale: "tech momentum" },
    });
    const handle = await h.adapter.start(
      parentCommand({
        screenMode: "non-deterministic",
        screenIntent: ND_INTENT,
        filters: { minVolume: 1000 },
      }),
    );
    expect(handle.status).toBe("complete");
    expect(h.interpretCalls).toEqual([{ intent: ND_INTENT }]);
    // The collation is the parent canonical row's payload.
    expect(h.parentStored).toHaveLength(1);
    expect(h.parentStored[0].collation.lifecycle).toBe("ReportGenerated");
    expect(h.parentStored[0].collation.screenMode).toBe("non-deterministic");
    expect((await collationFor(h.store, "job-2530")).lifecycle).toBe("ReportGenerated");
    // The artifact refines the caller's structured filters per field;
    // shards/universe never change. The merged filters reach the
    // screen the engine runs: the adapter's canned analyze step
    // reads them from the job-definition params (ctx.params.filters,
    // merged by the ND head before defineJob), exactly as the
    // production steps do via screenRequestFromParams.
    expect(h.runRequests).toHaveLength(1);
    expect(h.runRequests[0].universe).toBe("NASDAQ100");
    expect(h.runRequests[0].filters).toEqual({
      minVolume: 1000,
      minPrice: 25,
      sector: "Technology",
    });
    // The shard really ran: its full result was stored + delivered.
    expect(h.stored).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
    const rows = await h.store.listJobsForChain("tenant-1", "job-2530");
    expect(rows.map((r) => r.jobKey)).toContain("shard:NASDAQ100");
    // Audit: prompt + artifact + verdict, recorded before execution.
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].intent).toBe(ND_INTENT);
    expect(h.audits[0].validation.ok).toBe(true);
    expect(h.audits[0].artifact).toEqual({
      filters: { minPrice: 25, sector: "Technology" },
      rationale: "tech momentum",
    });
    expect(h.audits[0].effectiveFilters).toEqual({
      minVolume: 1000,
      minPrice: 25,
      sector: "Technology",
    });
  });

  it("ND refusal path: invalid artifact → Failed collation, zero shards started, audit carries the reasons", async () => {
    const h = makeAdapterParentHarness({ artifact: { filters: { dropTable: true } } });
    const handle = await h.adapter.start(
      parentCommand({ screenMode: "non-deterministic", screenIntent: ND_INTENT }),
    );
    // A refused artifact is a business refusal, not an infra
    // error: the adapter settles "complete" with a Failed
    // collation, exactly like the anchor's failed-run tests.
    expect(handle.status).toBe("complete");
    expect(h.parentStored).toHaveLength(1);
    expect(h.parentStored[0].collation.lifecycle).toBe("Failed");
    expect(h.parentStored[0].collation.screenMode).toBe("non-deterministic");
    expect(h.parentStored[0].collation.error).toMatch(/filter/i);
    expect(h.runRequests).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].validation.ok).toBe(false);
    expect(h.audits[0].validation.reasons?.join(" ")).toMatch(/filter/i);
    // The refusal still lands visible rows: the announce row
    // (submitted, keyed by job id) and the failed parent leg
    // (never a shard row — zero shards started).
    const announceRow = await h.store.latestJob("tenant-1", "job-2530", "job-2530");
    expect(announceRow?.status).toBe("submitted");
    expect(JSON.parse(announceRow?.resultJson ?? "{}").jobId).toBe("job-2530");
    const failedParent = await h.store.latestJob("tenant-1", "job-2530", "leg:parent");
    expect(failedParent?.status).toBe("failed");
    expect(JSON.parse(failedParent?.resultJson ?? "{}").detail).toMatch(/Workflow Failed: 0\/1 shards/);
    const rows = await h.store.listJobsForChain("tenant-1", "job-2530");
    expect(rows.map((r) => r.jobKey)).not.toContain("shard:NASDAQ100");
  });

  it("ND with the gate closed refuses before interpreting (direct workflow starts cannot bypass the flag)", async () => {
    const h = makeAdapterParentHarness({ ndModeEnabled: false, artifact: { filters: {} } });
    const handle = await h.adapter.start(
      parentCommand({ screenMode: "non-deterministic", screenIntent: ND_INTENT }),
    );
    // #4192: the dispatch throws before announce, and the
    // adapter records that as "errored" (start never throws
    // for a run failure) — the engine equivalent of the
    // retired flow's /SCREENER_ND_MODE/ rejection.
    expect(handle.status).toBe("errored");
    expect((await h.adapter.status(handle.workflowId))?.status).toBe("errored");
    expect(h.interpretCalls).toHaveLength(0);
    expect(h.runRequests).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
    expect(h.parentStored).toHaveLength(0);
    expect(await h.store.listJobsForChain("tenant-1", "job-2530")).toHaveLength(0);
  });

  it("ND without an interpreter fails closed (no model seam, no run)", async () => {
    const h = makeAdapterParentHarness({ ndModeEnabled: true });
    const handle = await h.adapter.start(
      parentCommand({ screenMode: "non-deterministic", screenIntent: ND_INTENT }),
    );
    expect(handle.status).toBe("errored");
    expect((await h.adapter.status(handle.workflowId))?.status).toBe("errored");
    expect(h.runRequests).toHaveLength(0);
    expect(h.parentStored).toHaveLength(0);
  });

  it("an interpreter that throws is an infrastructure failure (the run errors; nothing executes)", async () => {
    const h = makeAdapterParentHarness({
      interpreter: {
        interpret: async () => {
          throw new Error("model unavailable");
        },
      },
    });
    const handle = await h.adapter.start(
      parentCommand({ screenMode: "non-deterministic", screenIntent: ND_INTENT }),
    );
    expect(handle.status).toBe("errored");
    expect((await h.adapter.status(handle.workflowId))?.status).toBe("errored");
    expect(h.runRequests).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
    expect(h.parentStored).toHaveLength(0);
  });

  it("deterministic parity: no interpretation, no audit, command filters flow verbatim, mode recorded", async () => {
    const h = makeAdapterParentHarness({ artifact: { filters: { minPrice: 999 } } });
    const handle = await h.adapter.start(parentCommand({ filters: { sector: "Energy" } }));
    expect(handle.status).toBe("complete");
    expect(h.parentStored).toHaveLength(1);
    expect(h.parentStored[0].collation.lifecycle).toBe("ReportGenerated");
    expect(h.parentStored[0].collation.screenMode).toBe("deterministic");
    expect(h.interpretCalls).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
    expect(h.runRequests).toHaveLength(1);
    expect(h.runRequests[0].filters).toEqual({ sector: "Energy" });
    expect(h.runRequests[0].universe).toBe("NASDAQ100");
  });
});

/* ------------------------------------------------------------------ */
/* The mesh screen door: mode selection at the seam                    */
/* ------------------------------------------------------------------ */

import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
import {
  runStockScreenViaDoor,
  type MeshScreenDoorContext,
} from "../src/agents/orchestrator/meshScreenDoor";
import type { WorkflowPort } from "../src/workflows/workflowPorts";
import { MockSqlStorage } from "./mock-sql";

interface DoorHarness {
  started: WorkflowJobCommand[];
  ctx: MeshScreenDoorContext;
}

function makeDoorHarness(env: Record<string, unknown>): DoorHarness {
  const started: WorkflowJobCommand[] = [];
  const port: WorkflowPort = {
    start: async (command) => {
      started.push(command);
      return {
        workflowId: `screen-${command.jobId}`,
        jobId: command.jobId,
        status: "running",
        existing: false,
        statusUrl: `/api/jobs/history?chainId=${encodeURIComponent(command.jobId)}`,
      };
    },
    status: async () => ({ status: "complete" }),
  };
  const sql = new MockSqlStorage();
  const ctx: MeshScreenDoorContext = {
    env: env as MeshScreenDoorContext["env"],
    ensureTables: () => sql as never,
    workflowPort: port,
    readWorkflowJobHistory: async (_tenantId, chainId) => [
      {
        jobKey: chainId,
        resultJson: JSON.stringify({
          jobId: chainId,
          workflowId: `screen-${chainId}`,
          lifecycle: "Failed",
          qualified: false,
          coverage: { evaluated: 0, considered: 0, ratio: null },
          shards: [],
          lifecycleTransitions: [],
          stageTransitions: [],
          reportKeys: [],
          storedShards: [],
          deliveredShards: [],
          error: "test collation",
        }),
      } as never,
    ],
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 5_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
  };
  return { started, ctx };
}

describe("mesh screen door mode selection (#2530)", () => {
  it("refuses an ND request while the flag is off — before any workflow start, never a silent downgrade", async () => {
    const h = makeDoorHarness({});
    await expect(
      runStockScreenViaDoor(h.ctx, "alice", {
        screenMode: "non-deterministic",
        screenIntent: ND_INTENT,
      }),
    ).rejects.toMatchObject({ code: "nd_mode_unavailable" });
    expect(h.started).toHaveLength(0);
  });

  it("fails closed on an invalid flag value (still nd_mode_unavailable)", async () => {
    const h = makeDoorHarness({ SCREENER_ND_MODE: "banana" });
    await expect(
      runStockScreenViaDoor(h.ctx, "alice", {
        screenMode: "non-deterministic",
        screenIntent: ND_INTENT,
      }),
    ).rejects.toMatchObject({ code: "nd_mode_unavailable" });
    expect(h.started).toHaveLength(0);
  });

  it("refuses ND mode without an intent (flag on)", async () => {
    const h = makeDoorHarness({ SCREENER_ND_MODE: "on" });
    await expect(
      runStockScreenViaDoor(h.ctx, "alice", { screenMode: "non-deterministic" }),
    ).rejects.toMatchObject({ code: "screen_intent_required" });
    expect(h.started).toHaveLength(0);
  });

  it("refuses an intent supplied without ND mode (never silently ignored)", async () => {
    const h = makeDoorHarness({ SCREENER_ND_MODE: "on" });
    await expect(
      runStockScreenViaDoor(h.ctx, "alice", { screenIntent: ND_INTENT }),
    ).rejects.toMatchObject({ code: "screen_intent_required" });
    expect(h.started).toHaveLength(0);
  });

  it("starts an ND run with the mode + intent on the command when the flag is on", async () => {
    const h = makeDoorHarness({ SCREENER_ND_MODE: "on" });
    await runStockScreenViaDoor(h.ctx, "alice", {
      screenMode: "non-deterministic",
      screenIntent: ND_INTENT,
    });
    expect(h.started).toHaveLength(1);
    expect(h.started[0].screenMode).toBe("non-deterministic");
    expect(h.started[0].screenIntent).toBe(ND_INTENT);
    expect((h.started[0].filters as { universe?: string }).universe).toBe("NASDAQ100");
  });

  it("deterministic requests are unaffected by the flag (off) and carry no mode", async () => {
    const h = makeDoorHarness({});
    await runStockScreenViaDoor(h.ctx, "alice", {});
    expect(h.started).toHaveLength(1);
    expect(h.started[0].screenMode).toBeUndefined();
    expect(h.started[0].screenIntent).toBeUndefined();
  });

  it("door refusals are MeshDoorError instances (the door's coded contract)", async () => {
    const h = makeDoorHarness({});
    const err = await runStockScreenViaDoor(h.ctx, "alice", {
      screenMode: "non-deterministic",
      screenIntent: ND_INTENT,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
  });
});

/* ------------------------------------------------------------------ */
/* The API selection helper + the tryStart backstop                    */
/* ------------------------------------------------------------------ */

import {
  screenModeSelectionFromFields,
  tryStartScreenerWorkflow,
} from "../src/workflows/screenerWorkflowRoutes";

describe("screenModeSelectionFromFields (#2530)", () => {
  it("no mode fields → deterministic default (no command fields)", () => {
    expect(screenModeSelectionFromFields({}, {})).toEqual({ ok: true });
    expect(screenModeSelectionFromFields({}, { screenMode: "deterministic" })).toEqual({ ok: true });
  });

  it("ND + intent + flag on → the selection the command carries", () => {
    expect(
      screenModeSelectionFromFields(
        { SCREENER_ND_MODE: "on" },
        { screenMode: "non-deterministic", screenIntent: "momentum names" },
      ),
    ).toEqual({ ok: true, screenMode: "non-deterministic", screenIntent: "momentum names" });
  });

  it("ND while the flag is off → a refusal naming the switch", () => {
    const sel = screenModeSelectionFromFields(
      {},
      { screenMode: "non-deterministic", screenIntent: "momentum names" },
    );
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.error).toMatch(/SCREENER_ND_MODE/);
  });

  it("ND without an intent, an intent without ND, and an unknown mode all refuse", () => {
    const env = { SCREENER_ND_MODE: "on" };
    expect(screenModeSelectionFromFields(env, { screenMode: "non-deterministic" }).ok).toBe(false);
    expect(screenModeSelectionFromFields(env, { screenIntent: "momentum names" }).ok).toBe(false);
    expect(screenModeSelectionFromFields(env, { screenMode: "hybrid" }).ok).toBe(false);
  });
});

describe("tryStartScreenerWorkflow ND backstop (#2530)", () => {
  it("throws for an ND command while the flag is off (never the null → sync-downgrade path)", async () => {
    const command = parentCommand({
      screenMode: "non-deterministic",
      screenIntent: ND_INTENT,
    });
    await expect(tryStartScreenerWorkflow({} as never, command)).rejects.toThrow(/SCREENER_ND_MODE/);
  });

  it("does not throw for an ND command when the flag is on (port availability decides, as today)", async () => {
    const command = parentCommand({
      screenMode: "non-deterministic",
      screenIntent: ND_INTENT,
    });
    await expect(
      tryStartScreenerWorkflow({ SCREENER_ND_MODE: "on" } as never, command),
    ).resolves.toBeNull();
  });

  it("keeps today's null-fallback for deterministic commands", async () => {
    await expect(tryStartScreenerWorkflow({} as never, parentCommand())).resolves.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The golden-task pair: the same request through both modes           */
/*                                                                     */
/* The drives run the REAL door path into the REAL flows               */
/* (InMemoryWorkflowAdapter over engine deps), with fakes only at      */
/* binding seams — the S18 acceptance rule. The fake interpreter       */
/* sits at the adapter-deps seam, exactly where production wires      */
/* the gateway-backed one.                                             */
/* ------------------------------------------------------------------ */

import {
  goldenTask,
  executeGoldenTasks,
  type GoldenTaskExecution,
} from "../src/services/meshGoldenTasks";
import { InMemoryMeshEvalStore } from "../src/data/inMemoryMeshEvalAdapter";
import { InMemoryMeshTraceStore } from "../src/data/inMemoryMeshTraceAdapter";
import { recordWorkflowTraceHop } from "../src/observability/meshTrace";
import {
  persistScreenerReportCanonical,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";

function goldenScreenFullResult(universe: string) {
  return {
    timestamp: new Date().toISOString(),
    trigger: "manual",
    provider: "etrade",
    universe,
    sector: "Technology",
    success: true,
    totalScanned: 100,
    matchedCount: 2,
    opportunities: [
      { symbol: "NVDA", companyName: "NVIDIA", lastPrice: 190, changePercent: 2.1 },
      { symbol: "AMD", companyName: "AMD", lastPrice: 160, changePercent: 1.2 },
    ],
    allStocks: [
      { symbol: "NVDA", companyName: "NVIDIA", sector: "Technology", lastPrice: 190, changePercent: 2.1, source: "etrade" },
      { symbol: "AMD", companyName: "AMD", sector: "Technology", lastPrice: 160, changePercent: 1.2, source: "etrade" },
    ],
    discoveryMessage: `Discovered listings for ${universe}`,
    filterSummary: "minPrice >= 10",
    rejections: [{ symbol: "XYZ", reason: "below min price" }],
    pdfKey: `screener/${universe}/report.pdf`,
    userLogin: "alice",
  };
}

interface GoldenHarness {
  ctx: MeshScreenDoorContext;
  started: WorkflowJobCommand[];
  interpretCalls: number;
  audits: ScreenInterpretationAuditRecord[];
}

function makeGoldenHarness(ndGateOn: boolean): GoldenHarness {
  const sql = new MockSqlStorage();
  const shardStore = new InMemoryShardJobAdapter();
  const traceStore = new InMemoryMeshTraceStore();
  const started: WorkflowJobCommand[] = [];
  const audits: ScreenInterpretationAuditRecord[] = [];
  const harness: GoldenHarness = {
    ctx: undefined as never,
    started,
    interpretCalls: 0,
    audits,
  };
  const reportCtx = {
    env: {},
    ensureTables: () => sql,
  } as unknown as ReportDispatchContext;
  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      runScreen: async (req) => {
        const full = goldenScreenFullResult(req.universe ?? "NASDAQ100");
        const summary: ShardScreenResult = {
          success: full.success,
          timestamp: full.timestamp,
          universe: full.universe,
          totalScanned: full.totalScanned,
          expectedCount: full.totalScanned,
          matchedCount: full.matchedCount,
          pdfKey: full.pdfKey,
          trigger: "manual",
          full,
        };
        return summary;
      },
    },
    shardStore,
    storeReport: async (payload) => {
      await persistScreenerReportCanonical(
        reportCtx,
        payload as Parameters<typeof persistScreenerReportCanonical>[1],
      );
    },
    deliverOutcome: async () => {},
    nowMs: () => Date.now(),
    traceHop: (command, event) => recordWorkflowTraceHop(traceStore, command, event),
    // Production shape: the interpreter and audit sink are
    // wired whenever their seams exist; the GATE decides
    // admissibility, and deterministic runs never consult
    // either.
    ndModeEnabled: ndGateOn,
    intentInterpreter: {
      interpret: async () => {
        harness.interpretCalls += 1;
        return { filters: { minPrice: 10 }, rationale: "golden pair interpretation" };
      },
    },
    auditInterpretation: async (record) => {
      audits.push(record);
    },
  };
  const adapter = new InMemoryWorkflowAdapter(deps);
  const recordingPort: WorkflowPort = {
    start: async (command) => {
      started.push(command);
      return adapter.start(command);
    },
    status: (workflowId) => adapter.status(workflowId),
  };
  harness.ctx = {
    env: (ndGateOn ? { SCREENER_ND_MODE: "on" } : {}) as MeshScreenDoorContext["env"],
    ensureTables: () => sql as never,
    workflowPort: recordingPort,
    readWorkflowJobHistory: (tenantId, chainId) => shardStore.listJobsForChain(tenantId, chainId),
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 60_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
    traceStore,
  };
  return harness;
}

describe("golden pair: the same screen request through both modes (#2530)", () => {
  it("both golden tasks pass, differing only in mode — interpretation runs exactly once, in ND only", async () => {
    const det = makeGoldenHarness(false);
    const nd = makeGoldenHarness(true);
    const executions: GoldenTaskExecution[] = [
      {
        task: goldenTask("door-chat-screen-run-deterministic")!,
        drive: async () => {
          const result = await runStockScreenViaDoor(det.ctx, "alice", { universe: "NASDAQ100" });
          return {
            outcome: result.success ? ("completed" as const) : ("error" as const),
            detail: result.error,
            facts: {
              workflowStarts: det.started.length,
              screenMode: det.started[0]?.screenMode ?? "deterministic",
              matchedCount: result.matchedCount,
            },
          };
        },
      },
      {
        task: goldenTask("door-chat-screen-run-non-deterministic")!,
        drive: async () => {
          const result = await runStockScreenViaDoor(nd.ctx, "alice", {
            universe: "NASDAQ100",
            screenMode: "non-deterministic",
            screenIntent: ND_INTENT,
          });
          return {
            outcome: result.success ? ("completed" as const) : ("error" as const),
            detail: result.error,
            facts: {
              workflowStarts: nd.started.length,
              screenMode: nd.started[0]?.screenMode ?? "deterministic",
              matchedCount: result.matchedCount,
            },
          };
        },
      },
    ];
    const store = new InMemoryMeshEvalStore();
    const results = await executeGoldenTasks(executions, { store, runId: "mesh-eval:2530-pair" });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.passed, `${r.taskId}: ${r.failures.join("; ")}`).toBe(true);
    }
    // The measured difference: interpretation + audit happen
    // exactly once in ND mode and never in deterministic mode.
    expect(det.interpretCalls).toBe(0);
    expect(det.audits).toHaveLength(0);
    expect(nd.interpretCalls).toBe(1);
    expect(nd.audits).toHaveLength(1);
    expect(nd.audits[0].validation.ok).toBe(true);
  });
});
