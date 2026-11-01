// @vitest-environment node
/**
 * Issue #2409 — Agent Mesh S12 (G6): workflow durability
 * conformance pins for ScreenerScreenWorkflow,
 * TradingTradeWorkflow, and PaymentWorkflow, plus the
 * OrchestratorAgent queued-job recovery pin the S4 matrix
 * disposition depends on.
 *
 * WHAT THE HARNESS SIMULATES — named honestly, per the slice's
 * evidence discipline. The repo's tests run under plain vitest
 * (no workers pool), and all three workflows are thin adapters
 * over pure flow cores driven by fakeable step interfaces (the
 * programme's established test shape). Eviction is therefore
 * simulated at the flow/step seam with a JOURNALING STEP FAKE:
 *
 *   - A durable journal (a Map that survives across
 *     "incarnations" of a run) records each completed step's
 *     result. A resumed incarnation's step call returns the
 *     journaled result WITHOUT re-executing the step body —
 *     the Cloudflare Workflows memoization contract.
 *   - Eviction between steps: the fake throws SimulatedEviction
 *     before a step body runs; the incarnation's promise
 *     rejects and the test starts a fresh incarnation over the
 *     same journal.
 *   - Eviction in the commit window: the step body EXECUTES
 *     (its side effect lands) and the fake throws before the
 *     result is journaled, so the resumed incarnation
 *     re-invokes the step and the underlying writer/core must
 *     dedupe or refuse. This is the real double-charge /
 *     double-execution proof.
 *   - Eviction during a wait: the incarnation's wait promise
 *     is abandoned unsettled (the instance is discarded); the
 *     test records the event as delivered in the journal and a
 *     fresh incarnation's wait returns it. (For the trade
 *     flow this abandon-model is the faithful one: the flow
 *     treats any waitForEvent ERROR as timeout/termination,
 *     so throwing at the wait would simulate expiry, not
 *     eviction.)
 *
 * This simulates instance restart + step-journal replay at the
 * flow seam. It does NOT exercise workerd's actual eviction,
 * and nothing in this file claims otherwise.
 *
 * Fakes live only at the binding/external seams: the screen
 * runner, the store/deliver doors, the child-workflow ops, the
 * broker platform (the repo's claim-then-execute contract
 * double, as in the G4 suite), the payment gate, and the cfpay
 * ledger endpoint. The flows, the real TradingAgent approval
 * door + settle core, the real cfpay ledger client, the real
 * submission seam, and the real async-job recovery module all
 * run unmocked.
 *
 * Existing pins are composed with, not duplicated: duplicate
 * start adoption at the screener WorkflowPort
 * (tests/screener_workflows.test.ts), the ledger client's 409
 * dedupe in isolation (tests/cfpay_ledger.test.ts), and the
 * async-job lifecycle characterization
 * (tests/async_jobs_step4a_characterization_2358.test.ts).
 *
 * Two genuine durability defects were found by these pins and
 * fixed in this slice (classified in the §15 on #2409):
 * (1) the payment submission seam threw on a retried
 * submission instead of adopting the existing instance —
 * create-or-adopt added, mirroring
 * cfWorkflowAdapter.startWorkflowInstance; (2) runShardFlow's
 * store/deliver outcomes lived in step-callback closure
 * state, which durable replay does not restore — a resumed
 * shard reported stored/delivered false for side effects
 * that had already landed — so the steps now RETURN their
 * outcomes, which is what the journal replays.
 *
 * COO surfaces consumed (reuse map: #2225 comment
 * 6517411762): the C3 stageChain retry semantics
 * (#1277/#1316 — retryAsyncJob, exercised across an instance
 * replacement in the orchestrator section, not re-invented)
 * and the #462/#1963 honest-partial contract (the
 * qualified-partial pin in the screener section). The #1972
 * COO operability list (Q2 DLQ, breaker durability,
 * stuck-running alert + runbook) is dispositioned in the
 * §15: this slice's evidence does not touch Q2 or the
 * breaker; a stuck-running READ-PATH reap exists on current
 * main (inside getAsyncJob) while the alert + runbook COO
 * specified still do not.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

// TradingAgent's module graph pulls `cloudflare:` imports the
// node loader cannot resolve — mock the SDK with a plain base
// class (the G4 suite's idiom, tests/mesh_g4_chat_trade_workflow_2375.test.ts).
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});

import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import { TradingAgent } from "../src/agents/trading-agent";
import {
  runTradeApprovalFlow,
  type TradeApprovalStep,
} from "../src/agents/trading-trade-workflow";
import {
  getTradeApprovalStatusViaDoor,
  proposeStockTradeViaDoor,
} from "../src/agents/orchestrator/meshDoors";
import { TradingPlatformRegistry } from "../src/trading";
import { MockSqlStorage } from "./mock-sql";
import {
  runParentFlow,
  runShardFlow,
  type ChildWorkflowOps,
  type ScreenerWorkflowDeps,
  type ScreenerWorkflowStep,
  type ShardScreenResult,
} from "../src/workflows/screenerWorkflowFlow";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import { workflowIdForJob, type WorkflowJobCommand } from "../src/workflows/workflowPorts";
import {
  runPaymentWorkflowFlow,
  type PaymentGate,
  type PaymentWorkflowDeps,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";
import {
  recordCfpayLedgerRow,
  listCfpayLedgerRows,
  buildCfpayChargeTransaction,
  buildCfpayCreditTransaction,
  cfpayLedgerSessionId,
} from "../src/services/cfpayLedger";
import {
  startPaymentWorkflowViaBinding,
  type PaymentWorkflowBinding,
} from "../src/services/paymentWorkflowSubmission";
import type { PaymentWorkflowEventParams } from "../src/workflows/paymentWorkflow";
import type { CommercialAccount } from "../src/services/cfpayMonetization";
import {
  ensureAsyncJobGraphColumns,
  recoverQueuedAsyncJobs,
  retryAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { ensureAsyncJobGateIndexes } from "../src/services/asyncJobGate";
import type { Env, TransactionRecord as CfpayTxRecord } from "../src/types";

/* ------------------------------------------------------------------ */
/* The journaling step fake (eviction simulation)                      */
/* ------------------------------------------------------------------ */

class SimulatedEviction extends Error {
  constructor(readonly stepName: string) {
    super(
      `simulated eviction at step "${stepName}": the workflow instance was discarded; the durable step journal survives`,
    );
    this.name = "SimulatedEviction";
  }
}

interface StepJournal {
  /** Memoized step results, keyed by step name — the durable journal. */
  steps: Map<string, unknown>;
  /** Events delivered to the instance, keyed by wait name. */
  events: Map<string, unknown>;
  /** Observability: every wait an incarnation parked on, in order. */
  parkedWaits: string[];
}

function newJournal(): StepJournal {
  return { steps: new Map(), events: new Map(), parkedWaits: [] };
}

interface EvictionPlan {
  /** Throw SimulatedEviction BEFORE the step body runs (one-shot per name). */
  before: Set<string>;
  /** Run the step body, then throw BEFORE journaling its result (one-shot). */
  after: Set<string>;
  /** Waits that end without an event (timeout/termination model). */
  waitTimeouts: Set<string>;
}

function newPlan(partial: Partial<EvictionPlan> = {}): EvictionPlan {
  return {
    before: partial.before ?? new Set(),
    after: partial.after ?? new Set(),
    waitTimeouts: partial.waitTimeouts ?? new Set(),
  };
}

async function journalDo<T>(
  journal: StepJournal,
  plan: EvictionPlan,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (journal.steps.has(name)) return journal.steps.get(name) as T;
  if (plan.before.delete(name)) throw new SimulatedEviction(name);
  const result = await fn();
  // Commit window: the side effect landed, the memo did not.
  if (plan.after.delete(name)) throw new SimulatedEviction(name);
  journal.steps.set(name, result);
  return result;
}

async function journalWait(
  journal: StepJournal,
  plan: EvictionPlan,
  name: string,
): Promise<{ payload: unknown }> {
  if (journal.events.has(name)) return { payload: journal.events.get(name) };
  if (plan.waitTimeouts.has(name)) {
    throw new Error(`waitForEvent timed out waiting for "${name}"`);
  }
  journal.parkedWaits.push(name);
  // The incarnation is discarded while parked: this promise is
  // abandoned unsettled, exactly like a suspended instance
  // whose memory is dropped. A fresh incarnation re-issues the
  // wait against the journal.
  return new Promise<{ payload: unknown }>(() => {});
}

/** Let a just-started incarnation run until it parks or settles. */
async function flushIncarnation(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function screenerStep(
  journal: StepJournal,
  plan: EvictionPlan,
  advanceClock: (ms: number) => void,
): ScreenerWorkflowStep {
  return {
    do: (name, fn) => journalDo(journal, plan, name, fn),
    sleep: async (name, ms) => {
      await journalDo(journal, plan, name, async () => {
        advanceClock(ms);
      });
    },
  };
}

function paymentStep(journal: StepJournal, plan: EvictionPlan): PaymentWorkflowStep {
  return {
    waitForEvent: (name) => journalWait(journal, plan, name) as never,
    do: (name, fn) => journalDo(journal, plan, name, fn),
  };
}

function tradeStep(journal: StepJournal, plan: EvictionPlan): TradeApprovalStep {
  return {
    waitForEvent: (name) => journalWait(journal, plan, name) as never,
    do: (name, fn) => journalDo(journal, plan, name, fn),
  };
}

/* ------------------------------------------------------------------ */
/* Screener: shard + parent flows                                      */
/* ------------------------------------------------------------------ */

function parentCommand(overrides: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "job-g6-1",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "alice",
    role: "parent",
    tenantId: "tenant-1",
    shards: [
      { shardId: "TECH", universe: "TECH" },
      { shardId: "HEALTH", universe: "HEALTH" },
    ],
    deliver: true,
    pollIntervalMs: 1_000,
    shardTimeoutMs: 600_000,
    ...overrides,
  };
}

function shardCommand(overrides: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    ...parentCommand(),
    role: "shard",
    parentJobId: "job-g6-1",
    shard: { shardId: "TECH", universe: "TECH" },
    shards: [{ shardId: "TECH", universe: "TECH" }],
    jobId: "job-g6-1:shard:TECH",
    ...overrides,
  };
}

interface ScreenerBundle {
  store: InMemoryShardJobAdapter;
  screens: string[];
  storePayloads: unknown[];
  deliveries: unknown[];
  /** The keyed canonical store the store door writes: screener:<timestamp> -> report id. */
  canonical: Map<string, string>;
  deps: ScreenerWorkflowDeps;
  nowMs: () => number;
  advanceClock: (ms: number) => void;
}

function makeScreenerBundle(): ScreenerBundle {
  const store = new InMemoryShardJobAdapter();
  const screens: string[] = [];
  const storePayloads: unknown[] = [];
  const deliveries: unknown[] = [];
  const canonical = new Map<string, string>();
  let now = 1_000_000;
  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      runScreen: async (req) => {
        screens.push(req.universe);
        return {
          success: true,
          timestamp: "2026-10-30T12:00:00.000Z",
          totalScanned: 10,
          expectedCount: 10,
          matchedCount: 2,
          universe: req.universe,
          full: { marker: "full-result", universe: req.universe },
        } as ShardScreenResult;
      },
    },
    shardStore: store,
    // The production store door keys the canonical row by
    // screener:<timestamp> (see ScreenerWorkflowDeps doc): a
    // replayed store overwrites the same row and returns the
    // same report id. This fake models exactly that keying.
    storeReport: async (payload) => {
      storePayloads.push(payload);
      const key = `screener:${(payload as { timestamp?: string }).timestamp ?? "?"}`;
      if (!canonical.has(key)) canonical.set(key, `report-${canonical.size + 1}`);
      return canonical.get(key);
    },
    deliverOutcome: async (payload) => {
      deliveries.push(payload);
    },
    nowMs: () => now,
  };
  return {
    store,
    screens,
    storePayloads,
    deliveries,
    canonical,
    deps,
    nowMs: () => now,
    advanceClock: (ms) => {
      now += ms;
    },
  };
}

describe("G6 screener shard flow — eviction/resume (#2409)", () => {
  it("eviction between steps: the resumed incarnation replays the journal and completes the shard exactly once", async () => {
    const b = makeScreenerBundle();
    const journal = newJournal();
    const plan = newPlan({ before: new Set(["deliver-shard"]) });

    // Incarnation 1: screen + store land, then the instance is
    // discarded just before the deliver step.
    await expect(
      runShardFlow(shardCommand(), screenerStep(journal, plan, b.advanceClock), b.deps),
    ).rejects.toBeInstanceOf(SimulatedEviction);
    expect(b.screens).toEqual(["TECH"]);
    expect(b.storePayloads).toHaveLength(1);
    expect(b.deliveries).toHaveLength(0);

    // Incarnation 2: same journal. Completed steps replay from
    // the journal — the screen is NOT re-run and the report is
    // NOT re-stored; only the remaining steps execute.
    const output = await runShardFlow(
      shardCommand(),
      screenerStep(journal, plan, b.advanceClock),
      b.deps,
    );
    expect(output.success).toBe(true);
    expect(output.stored).toBe(true);
    expect(output.delivered).toBe(true);
    expect(b.screens).toEqual(["TECH"]);
    expect(b.storePayloads).toHaveLength(1);
    expect(b.deliveries).toHaveLength(1);

    const rows = await b.store.listJobsForChain("tenant-1", "job-g6-1");
    expect(rows.find((r) => r.jobKey === "shard:TECH")?.status).toBe("completed");
  });

  it("commit-window eviction at store: the replayed store converges on ONE canonical record (no duplicate report)", async () => {
    const b = makeScreenerBundle();
    const journal = newJournal();
    const plan = newPlan({ after: new Set(["store-shard"]) });

    // Incarnation 1: the store write lands, then the instance
    // is discarded before the step result is journaled.
    await expect(
      runShardFlow(shardCommand(), screenerStep(journal, plan, b.advanceClock), b.deps),
    ).rejects.toBeInstanceOf(SimulatedEviction);
    expect(b.storePayloads).toHaveLength(1);

    // Incarnation 2: the store step is re-invoked (its memo was
    // lost) with the identical payload; the keyed canonical
    // store converges instead of duplicating.
    const output = await runShardFlow(
      shardCommand(),
      screenerStep(journal, plan, b.advanceClock),
      b.deps,
    );
    expect(output.stored).toBe(true);
    expect(output.delivered).toBe(true);
    expect(b.screens).toEqual(["TECH"]); // the screen itself was journaled — never re-run
    expect(b.storePayloads).toHaveLength(2); // the writer WAS re-invoked…
    expect(b.storePayloads[1]).toEqual(b.storePayloads[0]); // …with the identical payload…
    expect(b.canonical.size).toBe(1); // …and exactly one canonical record exists
    expect(b.deliveries).toHaveLength(1); // delivery still happens exactly once
  });
});

describe("G6 screener parent flow — eviction/resume (#2409)", () => {
  it("eviction mid-poll: fan-out is not repeated, shard progress survives, the collation completes", async () => {
    const b = makeScreenerBundle();
    const journal = newJournal();
    const plan = newPlan({ before: new Set(["poll-1"]) });

    // Child ops fake (the binding seam): createChild runs the
    // real shard flow eagerly under its own journal; the child
    // reports "running" on its first status read and its real
    // terminal output afterwards — a child that finishes
    // between two polls.
    let createCount = 0;
    const childOutputs = new Map<string, unknown>();
    const statusReads = new Map<string, number>();
    const childOps: ChildWorkflowOps = {
      createChild: async (cmd) => {
        createCount++;
        const workflowId = `child-${cmd.shard?.shardId ?? "?"}`;
        const out = await runShardFlow(
          cmd,
          screenerStep(newJournal(), newPlan(), b.advanceClock),
          b.deps,
        );
        childOutputs.set(workflowId, out);
        return { workflowId };
      },
      getChildStatus: async (workflowId) => {
        const n = (statusReads.get(workflowId) ?? 0) + 1;
        statusReads.set(workflowId, n);
        if (n === 1) return { status: "running" };
        return { status: "complete", output: childOutputs.get(workflowId) };
      },
    };

    // Incarnation 1: announce + fan-out + first poll land in
    // the journal; the instance is discarded before poll-1.
    await expect(
      runParentFlow(parentCommand(), screenerStep(journal, plan, b.advanceClock), b.deps, childOps),
    ).rejects.toBeInstanceOf(SimulatedEviction);
    expect(createCount).toBe(2);
    expect(b.screens).toEqual(["TECH", "HEALTH"]);

    // Incarnation 2: announce and fan-out replay from the
    // journal — no duplicate children, no re-run screens — and
    // the journaled poll-0 snapshot (children still running)
    // replays before poll-1 observes completion.
    const collation = await runParentFlow(
      parentCommand(),
      screenerStep(journal, plan, b.advanceClock),
      b.deps,
      childOps,
    );
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect(createCount).toBe(2);
    expect(b.screens).toEqual(["TECH", "HEALTH"]);
    expect(b.deliveries).toHaveLength(2); // one delivery per shard, from the single child runs

    // The projection (the /api/jobs/history tracking home)
    // tells the same story: one parent row at its terminal
    // lifecycle, both shard rows completed.
    const rows = await b.store.listJobsForChain("tenant-1", "job-g6-1");
    const parentRow = rows.find((r) => r.jobKey === "job-g6-1");
    expect(parentRow?.status).toBe("completed");
    expect(rows.find((r) => r.jobKey === "shard:TECH")?.status).toBe("completed");
    expect(rows.find((r) => r.jobKey === "shard:HEALTH")?.status).toBe("completed");
  });
});

describe("G6 screener status surface — WorkflowPort + projection (#2409)", () => {
  it("status is truthful at running / terminal-success phases, null for an unknown instance, and the projection matches", async () => {
    const store = new InMemoryShardJobAdapter();
    let releaseScreen: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseScreen = resolve;
    });
    let now = 1_000_000;
    const deps: ScreenerWorkflowDeps = {
      screenRunner: {
        runScreen: async (req) => {
          await gate; // the run stays in flight until the test releases it
          return {
            success: true,
            timestamp: "2026-10-30T12:00:00.000Z",
            totalScanned: 4,
            expectedCount: 4,
            matchedCount: 1,
            universe: req.universe,
            full: { marker: "full-result", universe: req.universe },
          } as ShardScreenResult;
        },
      },
      shardStore: store,
      storeReport: async () => {},
      deliverOutcome: async () => {},
      nowMs: () => now,
    };
    const adapter = new InMemoryWorkflowAdapter(deps);
    const command = parentCommand({
      jobId: "job-g6-status",
      shards: [{ shardId: "TECH", universe: "TECH" }],
    });

    const startPromise = adapter.start(command);
    await flushIncarnation();
    const workflowId = workflowIdForJob("job-g6-status");
    const running = await adapter.status(workflowId);
    expect(running?.status).toBe("running");
    expect(await adapter.status("wf-does-not-exist")).toBeNull();

    releaseScreen!();
    const handle = await startPromise;
    expect(handle.workflowId).toBe(workflowId);
    const complete = await adapter.status(workflowId);
    expect(complete?.status).toBe("complete");

    const rows = await store.listJobsForChain("tenant-1", "job-g6-status");
    expect(rows.find((r) => r.jobKey === "job-g6-status")?.status).toBe("completed");
    expect(rows.find((r) => r.jobKey === "shard:TECH")?.status).toBe("completed");
    void now;
  });

  it("a failed screen is a truthful terminal failure in the projection (failed shard row, no false completion)", async () => {
    const store = new InMemoryShardJobAdapter();
    let now = 1_000_000;
    const deps: ScreenerWorkflowDeps = {
      screenRunner: {
        runScreen: async (req) => ({
          success: false,
          timestamp: "2026-10-30T12:00:00.000Z",
          totalScanned: 0,
          expectedCount: 10,
          matchedCount: 0,
          universe: req.universe,
          error: "provider down",
          full: { marker: "full-result", universe: req.universe },
        }) as ShardScreenResult,
      },
      shardStore: store,
      storeReport: async () => {},
      deliverOutcome: async () => {},
      nowMs: () => now,
    };
    const adapter = new InMemoryWorkflowAdapter(deps);
    const handle = await adapter.start(
      parentCommand({ jobId: "job-g6-fail", shards: [{ shardId: "TECH", universe: "TECH" }] }),
    );
    const status = await adapter.status(handle.workflowId);
    expect(status?.status).toBe("complete"); // the workflow ran to its terminal collation…
    const rows = await store.listJobsForChain("tenant-1", "job-g6-fail");
    // …and the collation it projected is an honest failure, not
    // a success. The projector keys FAILED legs by step
    // (shardJobProjection.jobKeysForOutcome: a failed leg has
    // no job id to key by), so the failure lives at leg:TECH /
    // leg:parent — the parent leg carrying the qualified-
    // partial detail — and no completed shard row exists.
    expect(rows.find((r) => r.jobKey === "leg:TECH")?.status).toBe("failed");
    expect(rows.find((r) => r.jobKey === "leg:parent")?.status).toBe("failed");
    expect(rows.find((r) => r.jobKey === "leg:parent")?.detail).toContain("qualified partial");
    expect(rows.find((r) => r.jobKey === "shard:TECH")).toBeUndefined();
    void now;
  });
});

/* ------------------------------------------------------------------ */
/* Trading: approval wait survival + settle replay refusal             */
/* ------------------------------------------------------------------ */

// The broker seam double, with the production platform contract
// the G4 suite pins: preview drafts an order; executeOrder
// claim-then-executes against the draft's CURRENT state and
// refuses a draft that is no longer previewed.
interface FakeDraft {
  orderId: string;
  symbol: string;
  action: string;
  quantity: number;
  price: number;
  totalValue: number;
  status: string;
}
const tradeLedger = new Map<string, FakeDraft>();
const tradeExecutions: Array<{ orderId: string; authorizerDid: string; decision: string }> = [];
let tradeDraftSeq = 0;

TradingPlatformRegistry.register("fakeg6" as never, () => ({
  platformId: "fakeg6",
  name: "Fake G6 Broker",
  getStatus: async () => ({}),
  getQuote: async () => ({}),
  getAccounts: async () => [],
  getPositions: async () => ({ account: {}, positions: [] }),
  previewOrder: async (params: { symbol: string; action: string; quantity: number }) => {
    const orderId = `ord-g6-${++tradeDraftSeq}`;
    const price = 100;
    tradeLedger.set(orderId, {
      orderId,
      symbol: params.symbol,
      action: params.action,
      quantity: params.quantity,
      price,
      totalValue: price * params.quantity,
      status: "previewed",
    });
    return {
      orderId,
      symbol: params.symbol,
      action: params.action,
      orderAction: params.action,
      orderType: "MARKET",
      quantity: params.quantity,
      estimatedPrice: price,
      estimatedTotal: price * params.quantity,
      estimatedCommission: 0,
      term: "GOOD_FOR_DAY",
      status: "previewed",
      proposerDid: "did:agent:openaimp:trading",
      authorizerDid: "",
      proofSignature: "sig",
      previewMessage: "Preview generated",
    };
  },
  executeOrder: (orderId: string, authorizerDid: string, decision: string) => {
    const rec = tradeLedger.get(orderId);
    if (!rec) {
      throw new Error(
        `Order draft '${orderId}' not found. All orders must be previewed and drafted before execution.`,
      );
    }
    if (rec.status !== "previewed") {
      throw new Error(
        `Order draft '${orderId}' cannot be executed. Current status is '${rec.status}'.`,
      );
    }
    if (decision === "approved") {
      tradeExecutions.push({ orderId, authorizerDid, decision });
      rec.status = "executed";
      return { success: true, status: "executed", orderId, executionId: `exec-${orderId}`, authorizerDid };
    }
    rec.status = "rejected";
    return { success: false, status: "rejected", orderId, executionId: "", authorizerDid };
  },
}) as never);

interface TradeRunRecord {
  state: "running" | "complete" | "errored";
  output?: unknown;
  error?: string;
}

function makeTradingHarness() {
  tradeLedger.clear();
  tradeExecutions.length = 0;
  tradeDraftSeq = 0;
  const runs = new Map<string, TradeRunRecord>();

  const env: Record<string, unknown> = {
    SERVICE_USER_LOGIN: "svc-background",
    TRADING_AGENT_PROVIDERS: "fakeg6",
    TRADING_AGENT_DEFAULT_PROVIDER: "fakeg6",
  };

  // A real TradingAgent over mock DO storage (the G4 idiom):
  // drafts live in the agent's own store, and the flow's
  // settle step reaches them through this binding seam.
  const agent: unknown = Object.create(TradingAgent.prototype);
  const a = agent as { env: unknown; name: string; ctx: unknown };
  a.env = env as Env;
  a.name = "trading:alice";
  a.ctx = {
    id: { toString: () => "trading:alice" },
    storage: {
      sql: new MockSqlStorage(),
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
    },
  };

  env.TRADING_AGENT = {
    idFromName: (name: string) => name,
    get: (_id: unknown) => agent,
  };
  // The instance-status surface S9 wired the chat door to:
  // the binding's own status read over the run registry.
  env.TRADE_WORKFLOW = {
    get: (id: string) => ({
      status: async () => {
        const run = runs.get(id);
        if (!run) throw new Error(`workflow instance ${id} not found`);
        if (run.state === "complete") return { status: "complete", output: run.output };
        if (run.state === "errored") {
          return { status: "errored", error: { name: "Error", message: run.error } };
        }
        return { status: "running" };
      },
    }),
  };
  return { env: env as Env, runs };
}

describe("G6 trading workflow — eviction/resume + status (#2409)", () => {
  it("the approval wait survives instance replacement: parked incarnation, delivered decision, resumed incarnation settles exactly once", async () => {
    const { env, runs } = makeTradingHarness();
    const proposal: unknown = await proposeStockTradeViaDoor(env, "alice", {
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
    });
    const orderId = (proposal as { proposal: { orderId: string } }).proposal.orderId;
    expect(typeof orderId).toBe("string");

    const workflowId = "wf-g6-trade-1";
    const journal = newJournal();
    const plan = newPlan();
    const params = { orderId, provider: "fakeg6", userLogin: "alice" };
    runs.set(workflowId, { state: "running" });

    // Incarnation 1: starts, reaches the approval wait, and is
    // discarded while parked. Nothing settles.
    const abandoned = runTradeApprovalFlow(env, params, tradeStep(journal, plan));
    abandoned.catch(() => {});
    await flushIncarnation();
    expect(journal.parkedWaits).toEqual(["await-approval"]);
    expect(tradeExecutions).toHaveLength(0);
    const parked = await getTradeApprovalStatusViaDoor(env, "alice", { workflowId });
    expect(parked.status).toBe("running");

    // The human decision is delivered to the (durable) instance
    // while no incarnation is in memory.
    journal.events.set("await-approval", {
      decision: "approved",
      authorizerDid: "did:web:alice",
    });

    // Incarnation 2: the wait returns the delivered decision
    // from the journal and the settle runs — once.
    const outcome = await runTradeApprovalFlow(env, params, tradeStep(journal, plan));
    runs.set(workflowId, { state: "complete", output: outcome });
    expect(outcome.status).toBe("settled");
    expect(tradeExecutions).toEqual([
      { orderId, authorizerDid: "did:web:alice", decision: "approved" },
    ]);
    const done = await getTradeApprovalStatusViaDoor(env, "alice", { workflowId });
    expect(done.status).toBe("complete");
    expect((done.output as { status?: string })?.status).toBe("settled");
  });

  it("commit-window eviction at settle: the replayed settle is refused by the agent's own core — the order executes exactly once", async () => {
    const { env, runs } = makeTradingHarness();
    const proposal: unknown = await proposeStockTradeViaDoor(env, "alice", {
      symbol: "MSFT",
      action: "BUY",
      quantity: 5,
    });
    const orderId = (proposal as { proposal: { orderId: string } }).proposal.orderId;

    const workflowId = "wf-g6-trade-2";
    const journal = newJournal();
    journal.events.set("await-approval", {
      decision: "approved",
      authorizerDid: "did:web:alice",
    });
    const plan = newPlan({ after: new Set(["settle-trade"]) });
    const params = { orderId, provider: "fakeg6", userLogin: "alice" };
    runs.set(workflowId, { state: "running" });

    // Incarnation 1: the settle EXECUTES (the broker fills the
    // order), then the instance is discarded before the step
    // result is journaled.
    await expect(runTradeApprovalFlow(env, params, tradeStep(journal, plan))).rejects.toBeInstanceOf(
      SimulatedEviction,
    );
    expect(tradeExecutions).toHaveLength(1);

    // Incarnation 2: the settle step is re-invoked (its memo was
    // lost). The flow delegates to the real TradingAgent door;
    // the settle core reaches the platform, whose
    // claim-then-execute contract refuses the already-executed
    // draft. The run errors honestly instead of double-placing.
    const err: unknown = await runTradeApprovalFlow(env, params, tradeStep(journal, plan)).catch(
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(SimulatedEviction);
    expect(err).toBeInstanceOf(Error);
    expect(tradeExecutions).toHaveLength(1);
    // The draft's own record proves the refusal's ground: the
    // first execution stands, and the replay was refused
    // against that state. (The refusal's error surface is
    // genericized by the settle core's error classification —
    // it surfaces as "Internal error in the trading service."
    // — so this pin asserts the effect, not the wording.)
    expect(tradeLedger.get(orderId)?.status).toBe("executed");

    runs.set(workflowId, {
      state: "errored",
      error: String((err as Error)?.message ?? err),
    });
    const status = await getTradeApprovalStatusViaDoor(env, "alice", { workflowId });
    expect(status.status).toBe("errored");
    expect(status.error).toBe((err as Error).message);
  });
});

/* ------------------------------------------------------------------ */
/* Payment: waits survive, no double charge, submission adoption       */
/* ------------------------------------------------------------------ */

const PAYMENT_PRICE = 0.25;

const paymentAccount: CommercialAccount = {
  userId: "u1",
  email: "u1@example.com",
  tenantId: "t1",
  tier: "PayPerUse",
  creditsUSD: 0,
  includedRunsRemaining: 0,
};

function paymentParams(runRequestId: string): PaymentWorkflowParams {
  return {
    runRequestId,
    family: "stock",
    trigger: "manual",
    tenantId: "t1",
    userId: "u1",
    email: "u1@example.com",
  };
}

function submissionParams(runRequestId: string): PaymentWorkflowEventParams {
  return {
    runRequestId,
    family: "stock",
    trigger: "manual",
    tenantId: "t1",
    userId: "u1",
    email: "u1@example.com",
    account: paymentAccount,
    screenerCommand: parentCommand(),
  } as PaymentWorkflowEventParams;
}

function makePaymentGate() {
  const calls = { check: 0, confirmPaid: 0 };
  const gate: PaymentGate = {
    check: async (run) => {
      calls.check++;
      return {
        allowed: false,
        status: "payment_required",
        httpStatus: 402,
        runRequestId: run.id,
        priceUSD: PAYMENT_PRICE,
        family: "stock",
        checkout: { checkoutId: "chk-g6-1" },
      };
    },
    confirmPaid: async (run) => {
      calls.confirmPaid++;
      return {
        allowed: true,
        status: "paid",
        runRequestId: run.id,
        priceUSD: PAYMENT_PRICE,
        paidVia: "cfpay_checkout",
      };
    },
  };
  return { gate, calls };
}

interface PayRunRecord {
  state: "running" | "complete" | "errored";
  output?: unknown;
  error?: string;
}

/**
 * A Workflows-binding fake with PRODUCTION semantics (per the
 * repo's own cfWorkflowAdapter doc): create() with an id that
 * is already taken is an ERROR, not a second run; get(id)
 * returns a handle whose status() reads the instance record.
 */
function makePaymentBinding() {
  const instances = new Map<string, PayRunRecord>();
  const createAttempts: string[] = [];
  const binding = {
    create: async ({ id }: { id: string; params: unknown }) => {
      createAttempts.push(id);
      if (instances.has(id)) {
        throw new Error(`Workflow instance with id ${id} already exists`);
      }
      instances.set(id, { state: "running" });
      return { id };
    },
    get: async (id: string) => {
      const inst = instances.get(id);
      if (!inst) throw new Error(`workflow instance ${id} not found`);
      return {
        sendEvent: async () => {},
        status: async () =>
          inst.state === "complete"
            ? { status: "complete", output: inst.output }
            : inst.state === "errored"
              ? { status: "errored", error: { name: "Error", message: inst.error } }
              : { status: "running" },
      };
    },
  };
  return { binding: binding as unknown as PaymentWorkflowBinding, instances, createAttempts };
}

describe("G6 payment workflow — eviction/resume across both waits + status (#2409)", () => {
  it("approval and verified-payment waits both survive instance replacement; every money step executes exactly once", async () => {
    const { binding, instances } = makePaymentBinding();
    const { gate, calls } = makePaymentGate();
    const eventTypes: string[] = [];
    let screenerStarts = 0;
    const deps: PaymentWorkflowDeps = {
      gate,
      account: paymentAccount,
      startScreener: async (p) => {
        screenerStarts++;
        return { workflowId: `wf-screener-${p.runRequestId}` };
      },
      recordEvent: async (e) => {
        eventTypes.push(e.type);
      },
      issueFailureCredit: async () => {
        throw new Error("no failure credit expected on the happy path");
      },
    };
    const params = paymentParams("run-g6-pay-1");
    const started = await startPaymentWorkflowViaBinding(binding, submissionParams("run-g6-pay-1"));
    expect(started.workflowId).toBe("run-g6-pay-1");

    const journal = newJournal();
    const plan = newPlan();

    // Incarnation 1: gate-check + checkout record land in the
    // journal; the instance is discarded parked at the
    // approval wait. Status (the binding read S10 wired) is
    // truthfully "running".
    const abandoned1 = runPaymentWorkflowFlow(params, deps, paymentStep(journal, plan));
    abandoned1.catch(() => {});
    await flushIncarnation();
    expect(journal.parkedWaits).toEqual(["await-payment-approval"]);
    expect(calls.check).toBe(1);
    expect(eventTypes).toEqual(["payment.checkout_created"]);
    const statusWhileParked = await (await binding.get("run-g6-pay-1")).status!();
    expect(statusWhileParked.status).toBe("running");

    // The approval arrives while no incarnation is in memory.
    journal.events.set("await-payment-approval", { approved: true, approverId: "ops-1" });

    // Incarnation 2: gate-check and the checkout record replay
    // from the journal (no second check, no second checkout
    // record); the instance parks at the verified-payment wait.
    const abandoned2 = runPaymentWorkflowFlow(params, deps, paymentStep(journal, plan));
    abandoned2.catch(() => {});
    await flushIncarnation();
    expect(journal.parkedWaits).toEqual(["await-payment-approval", "await-payment-verified"]);
    expect(calls.check).toBe(1);
    // #2550: the approval now records payment.approved (naming
    // the approver) before the verified-payment wait.
    expect(eventTypes).toEqual(["payment.checkout_created", "payment.approved"]);
    expect(screenerStarts).toBe(0);

    // The verified-payment wake-up arrives; incarnation 3
    // completes the run.
    journal.events.set("await-payment-verified", { claimTxHash: "0xg6" });
    const outcome = await runPaymentWorkflowFlow(params, deps, paymentStep(journal, plan));
    instances.set("run-g6-pay-1", { state: "complete", output: outcome });
    expect(outcome.status).toBe("started");
    expect(calls.confirmPaid).toBe(1);
    expect(eventTypes).toEqual(["payment.checkout_created", "payment.approved", "payment.confirmed"]);
    expect(screenerStarts).toBe(1);
    const finalStatus = await (await binding.get("run-g6-pay-1")).status!();
    expect(finalStatus.status).toBe("complete");
    expect((finalStatus as { output?: { status?: string } }).output?.status).toBe("started");
  });
});

/** The cfpay ledger endpoint fake (mirrors tests/cfpay_ledger.test.ts). */
function fakeCfpayEnv(seen: Map<string, CfpayTxRecord>): Env {
  const stub = {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (url.pathname.endsWith("/record-cfpay") && req.method === "POST") {
        const kind = body["kind"] as string;
        const runRequestId = body["runRequestId"] as string;
        const key = `${runRequestId}:${kind}`;
        const existing = seen.get(key);
        if (existing) return Response.json({ duplicate: true, record: existing }, { status: 409 });
        const tx = (
          kind === "charge"
            ? buildCfpayChargeTransaction(body as never)
            : buildCfpayCreditTransaction(body as never)
        ) as CfpayTxRecord;
        seen.set(key, tx);
        return Response.json({ duplicate: false, record: tx });
      }
      if (url.pathname.endsWith("/ledger/cfpay") && req.method === "GET") {
        const runRequestId = url.searchParams.get("runRequestId") ?? "";
        const rows = [...seen.values()].filter(
          (t) => t.sessionId === cfpayLedgerSessionId(runRequestId),
        );
        return Response.json({ runRequestId, count: rows.length, rows });
      }
      if (url.pathname.endsWith("/audit/event") && req.method === "POST") {
        return Response.json({ id: "evt-1" }, { status: 201 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  };
  return {
    SERVICE_USER_LOGIN: "svc-test",
    SEARCH_AGENT: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
  } as unknown as Env;
}

describe("G6 payment workflow — no double charge under commit-window replay (#2409)", () => {
  it("record-payment executes twice across the eviction and the ledger still holds exactly ONE charge (CBO one-charge-per-run-request rule)", async () => {
    const { gate, calls } = makePaymentGate();
    const seen = new Map<string, CfpayTxRecord>();
    const ledgerEnv = fakeCfpayEnv(seen);
    const confirmedWrites: Array<{ duplicate: boolean }> = [];
    const otherEventTypes: string[] = [];
    let screenerStarts = 0;
    const params = paymentParams("run-g6-pay-2");
    const deps: PaymentWorkflowDeps = {
      gate,
      account: paymentAccount,
      startScreener: async (p) => {
        screenerStarts++;
        return { workflowId: `wf-screener-${p.runRequestId}` };
      },
      // The production adapter's recordEvent composition for a
      // confirmed payment (src/workflows/paymentWorkflow.ts):
      // refuse a non-positive price, then the real ledger
      // client write, failing loud. (The adapter's best-effort
      // D1 journal projection + read-back reconciliation are
      // no-ops without AGENT_DB and are not the dedupe-bearing
      // call; the ledger write is.)
      recordEvent: async (e) => {
        if (e.type === "payment.confirmed") {
          if (e.priceUSD === undefined || !Number.isFinite(e.priceUSD) || e.priceUSD <= 0) {
            throw new Error(
              `Refusing to record a cfpay charge for run ${e.runRequestId} without a positive price.`,
            );
          }
          const { duplicate } = await recordCfpayLedgerRow(ledgerEnv, "charge", {
            runRequestId: e.runRequestId,
            userId: params.userId,
            family: params.family,
            priceUSD: e.priceUSD,
            checkoutId: e.checkoutId,
            claimTxHash: e.claimTxHash,
            paymentIntentId: e.paymentIntentId,
          });
          confirmedWrites.push({ duplicate });
          return;
        }
        otherEventTypes.push(e.type);
      },
      issueFailureCredit: async () => {},
    };

    const journal = newJournal();
    const plan = newPlan({ after: new Set(["record-payment"]) });

    // Incarnations 1–2: park at each wait in turn; the events
    // are delivered while no incarnation is in memory.
    const abandoned1 = runPaymentWorkflowFlow(params, deps, paymentStep(journal, plan));
    abandoned1.catch(() => {});
    await flushIncarnation();
    expect(journal.parkedWaits).toEqual(["await-payment-approval"]);
    journal.events.set("await-payment-approval", { approved: true, approverId: "ops-1" });
    const abandoned2 = runPaymentWorkflowFlow(params, deps, paymentStep(journal, plan));
    abandoned2.catch(() => {});
    await flushIncarnation();
    expect(journal.parkedWaits).toEqual(["await-payment-approval", "await-payment-verified"]);
    journal.events.set("await-payment-verified", { claimTxHash: "0xg6" });

    // Incarnation 3: confirm-paid journals, then record-payment
    // EXECUTES — the charge lands in the ledger — and the
    // instance is discarded before the step result is
    // journaled.
    await expect(runPaymentWorkflowFlow(params, deps, paymentStep(journal, plan))).rejects.toBeInstanceOf(
      SimulatedEviction,
    );
    expect(confirmedWrites).toEqual([{ duplicate: false }]);
    expect(seen.size).toBe(1);

    // Incarnation 4: record-payment is re-invoked (its memo was
    // lost) and the ledger endpoint dedupes per run+kind: the
    // replay is acknowledged as a duplicate and NO second
    // charge row exists. The run then starts its screener
    // exactly once.
    const outcome = await runPaymentWorkflowFlow(params, deps, paymentStep(journal, plan));
    expect(outcome.status).toBe("started");
    expect(confirmedWrites).toEqual([{ duplicate: false }, { duplicate: true }]);
    expect(seen.size).toBe(1);
    const rows = await listCfpayLedgerRows(ledgerEnv, "run-g6-pay-2");
    expect(rows).toHaveLength(1);
    expect(calls.check).toBe(1);
    expect(calls.confirmPaid).toBe(1);
    expect(screenerStarts).toBe(1);
    // #2550: the approval record (payment.approved) is part of
    // the non-charge event trail now; the charge itself is still
    // exactly one row.
    expect(otherEventTypes).toEqual(["payment.checkout_created", "payment.approved"]);
  });
});

describe("G6 payment submission — idempotent retry at the caller seam (#2409)", () => {
  it("a retried submission adopts the existing instance instead of failing or double-starting (one run per run-request)", async () => {
    const { binding, instances, createAttempts } = makePaymentBinding();
    const params = submissionParams("run-g6-pay-3");
    const first = await startPaymentWorkflowViaBinding(binding, params);
    const second = await startPaymentWorkflowViaBinding(binding, params);
    expect(first.workflowId).toBe("run-g6-pay-3");
    expect(second.workflowId).toBe(first.workflowId);
    expect(createAttempts).toEqual(["run-g6-pay-3", "run-g6-pay-3"]); // the retry DID reach the binding…
    expect(instances.size).toBe(1); // …and there is still exactly one run for the run-request
  });

  it("a genuine start failure is NOT masked by adoption: when no instance exists to adopt, the original error propagates", async () => {
    const broken = {
      create: async () => {
        throw new Error("provider unavailable");
      },
      get: async () => {
        throw new Error("workflow instance run-g6-pay-4 not found");
      },
    } as unknown as PaymentWorkflowBinding;
    await expect(
      startPaymentWorkflowViaBinding(broken, submissionParams("run-g6-pay-4")),
    ).rejects.toThrow(/provider unavailable/);
  });

  it("an approval wait that ends without an event settles as expired — nothing charges, nothing starts", async () => {
    const { gate, calls } = makePaymentGate();
    const eventTypes: string[] = [];
    let screenerStarts = 0;
    const deps: PaymentWorkflowDeps = {
      gate,
      account: paymentAccount,
      startScreener: async (p) => {
        screenerStarts++;
        return { workflowId: `wf-screener-${p.runRequestId}` };
      },
      recordEvent: async (e) => {
        eventTypes.push(e.type);
      },
      issueFailureCredit: async () => {},
    };
    const plan = newPlan({ waitTimeouts: new Set(["await-payment-approval"]) });
    const outcome = await runPaymentWorkflowFlow(
      paymentParams("run-g6-pay-5"),
      deps,
      paymentStep(newJournal(), plan),
    );
    expect(outcome.status).toBe("expired");
    expect(eventTypes).toEqual(["payment.checkout_created", "payment.approval_expired"]);
    expect(calls.confirmPaid).toBe(0);
    expect(screenerStarts).toBe(0);
  });

  it("a gate failure errors the run honestly (no outcome is fabricated)", async () => {
    const gate: PaymentGate = {
      check: async () => {
        throw new Error("gate unavailable");
      },
      confirmPaid: async () => {
        throw new Error("unreachable");
      },
    };
    const deps: PaymentWorkflowDeps = {
      gate,
      account: paymentAccount,
      startScreener: async () => ({ workflowId: "never" }),
      recordEvent: async () => {},
      issueFailureCredit: async () => {},
    };
    await expect(
      runPaymentWorkflowFlow(paymentParams("run-g6-pay-6"), deps, paymentStep(newJournal(), newPlan())),
    ).rejects.toThrow(/gate unavailable/);
  });
});

/* ------------------------------------------------------------------ */
/* Screener honest run states — the #462/#1963 partial contract        */
/* ------------------------------------------------------------------ */

describe("G6 screener parent flow — honest partial (#462/#1963 contract, #2409)", () => {
  it("a partial run is honestly partial: the collation is qualified, the failed shard is recorded failed, the completed shard completed", async () => {
    const b = makeScreenerBundle();
    // Universe-aware runner: HEALTH's screen fails (its store/
    // deliver still run — the child owns a canonical record of
    // the attempt, per the shard flow's contract).
    b.deps.screenRunner.runScreen = async (req) => {
      b.screens.push(req.universe);
      const ok = req.universe !== "HEALTH";
      return {
        success: ok,
        timestamp: "2026-10-30T12:00:00.000Z",
        totalScanned: ok ? 10 : 0,
        expectedCount: 10,
        matchedCount: ok ? 2 : 0,
        universe: req.universe,
        ...(ok ? {} : { error: "provider down" }),
        full: { marker: "full-result", universe: req.universe },
      } as ShardScreenResult;
    };
    const childOutputs = new Map<string, unknown>();
    const childOps: ChildWorkflowOps = {
      createChild: async (cmd) => {
        const workflowId = `child-${cmd.shard?.shardId ?? "?"}`;
        const out = await runShardFlow(
          cmd,
          screenerStep(newJournal(), newPlan(), b.advanceClock),
          b.deps,
        );
        childOutputs.set(workflowId, out);
        return { workflowId };
      },
      getChildStatus: async (workflowId) => ({
        status: "complete",
        output: childOutputs.get(workflowId),
      }),
    };

    const collation = await runParentFlow(
      parentCommand(),
      screenerStep(newJournal(), newPlan(), b.advanceClock),
      b.deps,
      childOps,
    );
    // The collation's honesty contract (documented on
    // collateShards itself): a run with a failed shard is
    // QUALIFIED — the partial is on the record, never a silent
    // full success — with per-shard outcomes carrying the
    // failure. ("ReportGenerated" as a lifecycle describes the
    // report artifact every completed-and-stored shard fed;
    // the qualification is what keeps it honest.)
    expect(collation.qualified).toBe(true);
    expect(collation.shards.find((s) => s.shardId === "TECH")?.status).toBe("completed");
    expect(collation.shards.find((s) => s.shardId === "HEALTH")?.status).toBe("failed");
    const rows = await b.store.listJobsForChain("tenant-1", "job-g6-1");
    expect(rows.find((r) => r.jobKey === "shard:TECH")?.status).toBe("completed");
    expect(rows.find((r) => r.jobKey === "leg:HEALTH")?.status).toBe("failed");
    expect(rows.find((r) => r.jobKey === "job-g6-1")?.status).toBe("completed");
    expect(rows.find((r) => r.jobKey === "job-g6-1")?.detail).toContain("qualified partial");
  });
});

/* ------------------------------------------------------------------ */
/* OrchestratorAgent recovery — queued async jobs + stageChain retry   */
/* (COO C3 surfaces, #1277/#1316: the scheduling capability and        */
/*  retryAsyncJob's per-stage retry semantics, consumed — not          */
/*  re-invented — across an instance replacement.)                     */
/* ------------------------------------------------------------------ */

/** SqlStorage-shaped executor over node:sqlite (the characterization suite's harness shape). */
function makeSql(db: DatabaseSync) {
  return {
    exec: (query: string, ...args: unknown[]) => {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
        return stmt.all(...(args as never[])) as unknown[];
      }
      const info = stmt.run(...(args as never[]));
      const out = [] as unknown[] & { rowsWritten?: number };
      out.rowsWritten = Number(info.changes);
      return out;
    },
  };
}

const ASYNC_BASE_DDL = `CREATE TABLE IF NOT EXISTS mas_async_jobs (
  job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, capability TEXT NOT NULL,
  display_name TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
  result_json TEXT, response_status INTEGER, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  started_at TEXT, completed_at TEXT
)`;

interface ScheduledCall {
  delay: unknown;
  callback: string;
  payload: unknown;
  options: unknown;
}

/** One OrchestratorAgent incarnation's context over the durable store. */
function makeAsyncCtx(sql: ReturnType<typeof makeSql>, scheduled: ScheduledCall[]): AsyncJobsContext {
  return {
    env: {},
    agentCtx: { storage: { sql } },
    ensureTables: () => {
      sql.exec(ASYNC_BASE_DDL);
      ensureAsyncJobGateIndexes(sql as never);
      ensureAsyncJobGraphColumns(sql as never);
      return sql;
    },
    sessionKey: () => "sess-g6",
    schedule: async (when: unknown, callback: string, payload?: unknown, options?: unknown) => {
      scheduled.push({ delay: when, callback, payload, options });
      return {};
    },
    audit: () => {},
    getOrm: () => {
      throw new Error("no orm in G6 recovery harness");
    },
    routeRequest: async () => new Response("{}"),
    nlqSchedulingPort: () => {
      throw new Error("unused");
    },
    nlqStockScreenPort: () => {
      throw new Error("unused");
    },
  } as unknown as AsyncJobsContext;
}

describe("G6 orchestrator recovery — queued async jobs across instance replacement (#2409)", () => {
  it("the resumed incarnation re-arms each queued job exactly once (idempotent schedule), honours not_before, and leaves terminal jobs alone; recovery itself is replay-safe", async () => {
    const db = new DatabaseSync(":memory:");
    const sql = makeSql(db);

    // Incarnation 1: three jobs are submitted into the durable
    // store (the C3 scheduling capability's submit path).
    const scheduled1: ScheduledCall[] = [];
    const ctx1 = makeAsyncCtx(sql, scheduled1);
    const a = await submitAsyncJob(ctx1, {
      capability: "task.draft",
      payload: { title: "a" },
      jobKind: "report",
      stage: "serve",
      chainId: "chain-g6",
    });
    const b = await submitAsyncJob(ctx1, {
      capability: "task.draft",
      payload: { title: "b" },
      jobKind: "report",
      stage: "serve",
      chainId: "chain-g6",
    });
    const c = await submitAsyncJob(ctx1, {
      capability: "task.draft",
      payload: { title: "c" },
      jobKind: "report",
      stage: "serve",
      chainId: "chain-g6",
    });
    // b is deferred 10 minutes; c already completed before the
    // eviction.
    db.prepare("UPDATE mas_async_jobs SET not_before = ? WHERE job_id = ?").run(
      new Date(Date.now() + 600_000).toISOString(),
      b.jobId,
    );
    db.prepare(
      "UPDATE mas_async_jobs SET status = 'completed', completed_at = ? WHERE job_id = ?",
    ).run(new Date().toISOString(), c.jobId);

    // The instance is evicted: ctx1 and its in-memory schedule
    // record are discarded. Incarnation 2 is a fresh context
    // over the SAME durable store, and onStart's recovery
    // (recoverQueuedAsyncJobs) runs.
    const scheduled2: ScheduledCall[] = [];
    const ctx2 = makeAsyncCtx(sql, scheduled2);
    await recoverQueuedAsyncJobs(ctx2);
    const rearmed = scheduled2.filter((s) => s.callback === "executeAsyncJob");
    expect(rearmed.map((s) => (s.payload as { jobId: string }).jobId).sort()).toEqual(
      [a.jobId, b.jobId].sort(),
    );
    // Every re-arm carries the idempotent schedule identity —
    // this is what makes the re-arm itself safe to replay.
    for (const s of rearmed) {
      expect(s.options).toEqual({ idempotent: true, retry: { maxAttempts: 1 } });
    }
    // The deferred job keeps its remaining delay (C3: a
    // deferred stage must not fire early because the DO
    // restarted).
    const bArm = rearmed.find((s) => (s.payload as { jobId: string }).jobId === b.jobId);
    expect(Number(bArm?.delay)).toBeGreaterThan(500);

    // Recovery is itself replay-safe: a second eviction +
    // recovery pass re-arms the same jobs with the same
    // idempotent identity (the platform dedupes idempotent
    // schedules; nothing double-fires).
    const scheduled3: ScheduledCall[] = [];
    const ctx3 = makeAsyncCtx(sql, scheduled3);
    await recoverQueuedAsyncJobs(ctx3);
    const rearmed3 = scheduled3.filter((s) => s.callback === "executeAsyncJob");
    expect(rearmed3.map((s) => (s.payload as { jobId: string }).jobId).sort()).toEqual(
      [a.jobId, b.jobId].sort(),
    );
    for (const s of rearmed3) {
      expect(s.options).toEqual({ idempotent: true, retry: { maxAttempts: 1 } });
    }
  });

  it("stageChain retry semantics survive instance replacement: retryAsyncJob carries retryOf + stage/chain identity, the original stays failed, and a double retry is refused (C3 #1277/#1316)", async () => {
    const db = new DatabaseSync(":memory:");
    const sql = makeSql(db);

    // Incarnation 1: a chained stage job is submitted and
    // fails; the instance is then evicted.
    const ctx1 = makeAsyncCtx(sql, []);
    const submitted = await submitAsyncJob(ctx1, {
      capability: "task.draft",
      payload: { title: "stage me" },
      jobKind: "report",
      stage: "serve",
      chainId: "chain-g6",
    });
    db.prepare("UPDATE mas_async_jobs SET status = 'failed', error = 'boom' WHERE job_id = ?").run(
      submitted.jobId,
    );

    // Incarnation 2 (fresh context, same store): the per-stage
    // retry — the runbook's retry step — works entirely from
    // the durable record.
    const ctx2 = makeAsyncCtx(sql, []);
    const retried = await retryAsyncJob(ctx2, submitted.jobId);
    expect(retried.status).toBe("queued");
    const retriedRow = db
      .prepare("SELECT * FROM mas_async_jobs WHERE job_id = ?")
      .get(retried.jobId) as unknown as Record<string, unknown>;
    expect(JSON.parse(String(retriedRow.payload_json)).retryOf).toBe(submitted.jobId);
    expect(retriedRow.stage).toBe("serve");
    expect(retriedRow.chain_id).toBe("chain-g6");
    const originalRow = db
      .prepare("SELECT * FROM mas_async_jobs WHERE job_id = ?")
      .get(submitted.jobId) as unknown as Record<string, unknown>;
    expect(originalRow.status).toBe("failed");

    // Double retry is refused — the retry is idempotent, not a
    // duplicate-job generator.
    await expect(retryAsyncJob(ctx2, submitted.jobId)).rejects.toThrow(/already retried/);
  });
});
