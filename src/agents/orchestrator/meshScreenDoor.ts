/**
 * Issue #2488 — the mesh screen door: the chat turn's stock
 * screen execution, owned by the orchestrator's door layer and
 * built WITHOUT NLQ.
 *
 * Owner direction (2026-10-30): "just build the entire solution
 * without NLQ. keep NLQ in the turn but don't use it... turn it
 * off with a flag. don't touch NLQ... put it behind a flag."
 * RCA: OpenAIMP/cfagent#2487 — the mesh's chat screen wiring
 * (S8 #2369, S10 #2378) lives in the NLQ stock-screen port, and
 * no model-invoked turn tool ever reached it; the turn's screen
 * path was the pre-mesh listings scan.
 *
 * This module is the door layer's own implementation of that
 * execution, composed ONLY from platform primitives:
 *   - createWorkflowPorts / WorkflowPort (src/workflows) — the
 *     ScreenerScreenWorkflow start + status surface;
 *   - readJobHistory (src/data/createShardJobPorts) — the D1
 *     projection read the await polls;
 *   - listScheduledReports / resolveCanonicalReportBody
 *     (src/services/scheduledReports) — the mas_reports
 *     read-back of the workflow's stored results;
 *   - buildPaidScreenSubmission / resolvePaidScreenAccount
 *     (src/services/paidScreenSubmission) +
 *     startPaymentWorkflowViaBinding
 *     (src/services/paymentWorkflowSubmission) + the S5 budget
 *     door (checkPaymentBudgetViaDoor, ./meshDoors) — the paid
 *     path.
 * It imports NOTHING from the NLQ modules (src/agents/nlq.ts,
 * src/agents/nlq/**, src/agents/orchestrator/nlqPorts.ts): the
 * glue (command build, await/collation, result assembly) is
 * re-implemented here against those primitives, at behavior
 * parity with the S8/S10 port — same `screener:chat:…` jobId
 * shape, fail-closed identity, one charge per run-request,
 * canonical read-back. The NLQ port itself is untouched and
 * keeps serving its own callers (the async `nlq.execute`
 * capability, A2A, the chat error fallback); this service is
 * parallel to it, not a replacement inside it.
 *
 * DELIBERATE DIFFERENCES from the NLQ port (recorded here and
 * in the PR body, per the owner's direction):
 *   1. NO direct-ScreenerAgent fallback. The port falls back to
 *      a direct agent call when the workflow port is
 *      unavailable or the start fails (the route precedent).
 *      The door refuses instead: a coded `door_unavailable`
 *      failure, zero runs started. A mesh screen IS a workflow
 *      run; serving it off-workflow would recreate the #2487
 *      bypass inside the door. This module has no ScreenerAgent
 *      seam at all — the fallback is absent, not disabled.
 *   2. The workflow command's source is "mesh-door" (the port
 *      uses "nlq-chat"): the trigger source is audit data, and
 *      this run did not come through NLQ.
 *   3. The universe is an explicit structured parameter over
 *      the registry universe set (src/trading/universes.ts),
 *      defaulting to NASDAQ100 — the route default
 *      (parseStockScreenRequest, src/trading/screeningSchemas)
 *      — not inherited from NLQ planning defaults (the port
 *      defaults an absent universe to TECH).
 *   4. The result type is this module's own
 *      MeshScreenRunResult (field-for-field the shape the port
 *      returns); the port's type lives in an NLQ module and is
 *      not imported.
 *
 * Identity is fail-closed (the door discipline, #1185):
 * requireActingLogin refuses a missing, blank, or synthetic
 * ("default") acting login BEFORE any workflow start. The
 * login arrives from the tool context's actingLogin carrier —
 * stamped server-side at queue time by the turn adapter,
 * re-supplied by the job executor — never from tool arguments.
 *
 * The paid path's order of operations is the S10 order, each
 * step fail-closed: catalogue price → PaymentsAgent budget
 * check through the S5 door → checkout email → fail-closed
 * account resolution → PaymentWorkflow submission (one charge
 * per run-request; the run id IS the screener job id) → awaited
 * read-back. The budget check charges against the guard
 * operation "nlq.execute": the PaymentsAgent GUARD_ALLOWLIST is
 * payments-internal and unchanged by this slice, and that
 * operation names the chat-screen spend category whose limits
 * the operator configured (the S10 chat path charged against
 * it for the same reason). Checkout email has NO production
 * source for a chat turn (the S10 gap, unchanged): with
 * monetization on and no email seam composed in, the paid path
 * refuses honestly with `checkout_email_required`.
 */

import type { AgentContext } from "agents";
import type { Env, StockScreenerFilter } from "../../types";
import { shardableUniverses, UNIVERSES, type UniverseId } from "../../trading";
import { createWorkflowPorts, workflowPortsUnavailableReason } from "../../workflows/createWorkflowPorts";
import { workflowTenantId } from "../../workflows/screenerWorkflowRoutes";
import {
  assertWorkflowJobCommand,
  workflowStatusUrl,
  type WorkflowCollation,
  type WorkflowJobCommand,
  type WorkflowPort,
} from "../../workflows/workflowPorts";
import { readJobHistory } from "../../data/createShardJobPorts";
import type { ShardJobRow } from "../../data/shardJobPorts";
import { meshTraceStoreForEnv } from "../../data/createMeshTracePorts";
import type { MeshTraceStore } from "../../data/meshTracePorts";
import { childContextOfTraceparent } from "../../observability/meshTrace";
import {
  listScheduledReports,
  resolveCanonicalReportBody,
  type ScheduledReportHit,
} from "../../services/scheduledReports";
import { createFeatureFlagPort } from "../../features/createFeatureFlagPort";
import {
  resolveScreenerNdGateFromEnv,
  screenerNdConfigErrorEvent,
} from "../../config/screenerModes";
import {
  checkPaymentBudgetViaDoor,
  requireActingLogin,
  MeshDoorError,
} from "./meshDoors";
import {
  buildPaidScreenSubmission,
  resolvePaidScreenAccount,
  type PaidScreenStorePorts,
} from "../../services/paidScreenSubmission";
import {
  startPaymentWorkflowViaBinding,
  type PaymentWorkflowBinding,
} from "../../services/paymentWorkflowSubmission";
import {
  createPriceCatalogueAdapter,
  ensurePriceCatalogueSchema,
} from "../../data/createPriceCataloguePorts";
import {
  createCommercialAdapter,
  ensureCommercialSchema,
} from "../../data/createCommercialPorts";
import {
  createSubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../../data/createSubscriptionPorts";
import type { McpToolContext } from "../../patterns/interfaces";

/* ------------------------------------------------------------------ */
/* Result shape                                                        */
/* ------------------------------------------------------------------ */

/**
 * The door's screen-run result: the fields of the ScreenerAgent
 * run result a chat caller consumes (structural parity with the
 * NLQ port's return shape — see the header, difference 4).
 */
export interface MeshScreenRunResult {
  timestamp: string;
  universe: string;
  sector: string;
  success: boolean;
  totalScanned: number;
  matchedCount: number;
  filterSummary?: string;
  discoveryMessage: string;
  error?: string;
  pdfKey?: string;
  rejections?: Array<{ symbol: string; reason: string }>;
  allStocks: Array<{
    symbol: string;
    companyName: string;
    sector?: string;
    lastPrice: number;
    changePercent: number;
    source: string;
  }>;
  opportunities: Array<{ symbol: string }>;
}

/** The door command's structured input (never an identity field). */
export interface MeshScreenDoorInput {
  /**
   * The universe to screen — one of the registry universe ids
   * (src/trading/universes.ts), or "ALL" for every shardable
   * universe. Absent → NASDAQ100 (the route default).
   */
  universe?: string;
  /** Structured screener filters, passed through to the workflow command. */
  filters?: StockScreenerFilter;
  /**
   * Issue #2530 — the per-run mode selection. Absent or
   * "deterministic" → today's deterministic run, unaffected
   * by the flag. "non-deterministic" → the dual-mode run:
   * admissible only while SCREENER_ND_MODE is on (else a
   * coded nd_mode_unavailable refusal before any start —
   * never a silent downgrade), and only with a screenIntent.
   */
  screenMode?: "deterministic" | "non-deterministic";
  /**
   * Issue #2530 — the free-form screening intent the ND
   * run's interpretation step proposes criteria from.
   * Required with screenMode "non-deterministic"; refused
   * without it (an intent on a deterministic run would be
   * silently ignored, so the door refuses instead).
   */
  screenIntent?: string;
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

/**
 * Binding-seam overrides for the door service. Production
 * contexts supply NONE of these: every seam then derives from
 * `env` exactly as the platform composition roots derive
 * theirs. Tests (and only tests) populate them through the
 * executor-shaped tool context (McpToolContext's
 * meshScreenDoorSeams carrier) to fake the binding seams — the
 * programme's acceptance rule (fakes only at binding seams).
 */
export interface MeshScreenDoorSeams {
  /**
   * Workflow port override. Absent → createWorkflowPorts(env)
   * per call; explicit null → the workflow path is unavailable
   * and the door refuses (`door_unavailable`) — there is no
   * fallback.
   */
  workflowPort?: WorkflowPort | null;
  /** D1 job-history reader override. Absent → readJobHistory(env, …). */
  readWorkflowJobHistory?: (tenantId: string, chainId: string) => Promise<ShardJobRow[] | null>;
  /** Await cadence/bound overrides. Absent → the production defaults below. */
  workflowPollIntervalMs?: number;
  workflowAwaitDeadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  /** Trace hop store override. Absent → meshTraceStoreForEnv(env); explicit null → hop recording off. */
  traceStore?: MeshTraceStore | null;
  /* Paid-path seams (the S10 set, same production defaults). */
  /** Monetization flag read. Absent → createFeatureFlagPort(env).isEnabled("monetization"). */
  monetizationOn?: () => Promise<boolean>;
  /** Stored catalogue price (USD) for the stock family. Absent → the price-catalogue adapter. */
  paidScreenPriceUSD?: () => Promise<number | null>;
  /** Budget check. Absent → checkPaymentBudgetViaDoor(env, actingLogin, input). */
  paidBudgetCheck?: (
    actingLogin: string,
    input: { operation: string; amountCents: number },
  ) => Promise<{ allowed: boolean; reason?: string }>;
  /** Checkout email source. NO production default exists (see the header). */
  checkoutEmail?: () => string | null | Promise<string | null>;
  /** Commercial + subscription stores. Absent → the env adapters; store-less resolution refuses. */
  paidScreenStores?: PaidScreenStorePorts | null;
  /** PAYMENT_WORKFLOW binding seam. Absent → env.PAYMENT_WORKFLOW. */
  paymentWorkflowBinding?: PaymentWorkflowBinding | null;
  /** PaymentWorkflow instance status read. Absent → the binding's get(id).status(). */
  paymentWorkflowStatus?: (
    workflowId: string,
  ) => Promise<{ status: string; output?: unknown } | null>;
}

/** Everything runStockScreenViaDoor receives from its context owner. */
export interface MeshScreenDoorContext extends MeshScreenDoorSeams {
  /** The worker env — workflow composition, tenant resolution, canonical-body R2 resolution. */
  env: Env;
  /**
   * The executing instance's SQL storage — the mas_reports
   * read-back (the canonical copies live in the orchestrator
   * instance's own store; chat jobs execute on that instance,
   * whose storage the async-job executor's tool context
   * carries). A context without one cannot read results back
   * and the door refuses (`door_unavailable`) rather than
   * fabricating a result.
   */
  ensureTables: () => AgentContext["storage"]["sql"];
  /**
   * The in-flight turn's mesh traceparent resolver — the
   * workflow command is stamped with it so the run joins the
   * turn's trace. Absent → the run is untraced (the registry's
   * recorded break), never stamped after the fact.
   */
  traceparent?: () => string | undefined;
}

/**
 * Build the production door context out of a tool context: env,
 * the instance storage the executor carries, the traceparent
 * carrier, and whatever binding seams the context carries
 * (production contexts carry none).
 */
export function meshScreenDoorContextFromMcp(context: McpToolContext): MeshScreenDoorContext {
  const storage = context.storage as unknown as
    | { sql?: AgentContext["storage"]["sql"] }
    | undefined;
  return {
    env: context.env,
    ensureTables: () => {
      const sql = storage?.sql;
      if (!sql) {
        throw new MeshDoorError(
          "door_unavailable",
          "run_stock_screen cannot read results back: the executing context carries no instance SQL storage " +
            "(chat jobs execute on the orchestrator instance, whose storage carries the canonical reports). " +
            "Refusing — the door has no off-store result path and no direct-agent fallback.",
        );
      }
      return sql;
    },
    traceparent: context.traceparent,
    ...(context.meshScreenDoorSeams ?? {}),
  };
}

/* ------------------------------------------------------------------ */
/* The door operation                                                  */
/* ------------------------------------------------------------------ */

/** Cadence for the door's own status-surface polls (the workflow's internal child polling is the command's pollIntervalMs). */
const SCREEN_DOOR_POLL_INTERVAL_MS = 2_000;
/** Bound on the door's await (parity with the port: on expiry an honest tracked failure — the run stays visible at its status URL). */
const SCREEN_DOOR_AWAIT_DEADLINE_MS = 15 * 60_000;
/** The parent workflow's child-poll cadence for door runs. */
const SCREEN_DOOR_PARENT_POLL_INTERVAL_MS = 5_000;

/** The budget-guard operation a chat screen is charged against (see the header for why this name). */
const SCREEN_DOOR_BUDGET_OPERATION = "nlq.execute";

/**
 * Run one chat stock screen through the mesh door: identity
 * gate → monetization branch → workflow start → awaited
 * canonical read-back. Throws MeshDoorError (coded, honest)
 * for every pre-start refusal; once a run exists, every
 * outcome returns as a result.
 */
export async function runStockScreenViaDoor(
  ctx: MeshScreenDoorContext,
  actingLogin: string | undefined | null,
  input: MeshScreenDoorInput,
): Promise<MeshScreenRunResult> {
  const login = requireActingLogin(actingLogin);
  // The read-back is this door's result path; a context that
  // cannot supply the instance store fails here, before any
  // start, not after a run nobody can read.
  ctx.ensureTables();

  // Issue #2530 — mode selection at the seam, before any
  // start. An ND request is admissible only with the gate
  // open and an intent present; every other ND shape refuses
  // coded, and an intent without ND mode refuses rather than
  // being silently ignored. Deterministic requests (the
  // default) never read the gate.
  const ndRequested = input.screenMode === "non-deterministic";
  if (
    input.screenMode !== undefined &&
    !ndRequested &&
    input.screenMode !== "deterministic"
  ) {
    throw new MeshDoorError(
      "door_unavailable",
      `run_stock_screen: unknown screenMode "${String(input.screenMode)}" — the door takes "deterministic" or "non-deterministic"; refusing rather than guessing.`,
    );
  }
  if (input.screenIntent !== undefined && !ndRequested) {
    throw new MeshDoorError(
      "screen_intent_required",
      "run_stock_screen refused: a screenIntent was supplied without screenMode \"non-deterministic\" — the intent would be silently ignored by a deterministic run, so the door refuses instead. No workflow was started.",
    );
  }
  let screenIntent: string | undefined;
  if (ndRequested) {
    const gate = resolveScreenerNdGateFromEnv(ctx.env);
    if (gate.invalid) {
      console.warn(
        `[mesh-screen-door] ${screenerNdConfigErrorEvent()}: SCREENER_ND_MODE value ${JSON.stringify(gate.raw)} is not "on"/"off" — failing closed to off.`,
      );
    }
    if (!gate.enabled) {
      throw new MeshDoorError(
        "nd_mode_unavailable",
        "run_stock_screen refused: the non-deterministic screener mode is disabled in this deployment (SCREENER_ND_MODE is off). " +
          "No workflow was started and no screen ran — an ND request is never silently downgraded to a deterministic screen.",
      );
    }
    screenIntent = typeof input.screenIntent === "string" ? input.screenIntent.trim() : "";
    if (!screenIntent) {
      throw new MeshDoorError(
        "screen_intent_required",
        "run_stock_screen refused: screenMode \"non-deterministic\" requires a non-blank screenIntent (the free-form intent the run's interpretation step proposes criteria from). No workflow was started.",
      );
    }
  }

  const rawUniverse = typeof input.universe === "string" ? input.universe.trim() : "";
  let universeId: UniverseId = "NASDAQ100";
  if (rawUniverse) {
    if (!(rawUniverse in UNIVERSES)) {
      throw new MeshDoorError(
        "door_unavailable",
        `run_stock_screen: unknown universe "${rawUniverse}" — the door takes the registry universe set ` +
          `(${Object.keys(UNIVERSES).join(", ")}); refusing rather than guessing.`,
      );
    }
    universeId = rawUniverse as UniverseId;
  }
  const filters: StockScreenerFilter = {
    ...(input.filters ?? {}),
    universe: universeId,
  } as StockScreenerFilter;

  const modeFields = ndRequested
    ? { screenMode: "non-deterministic" as const, screenIntent }
    : {};
  if (await screenMonetizationOn(ctx)) {
    return runPaidScreen(ctx, { filters, userLogin: login, universeId, ...modeFields });
  }
  return runFreeScreen(ctx, { filters, userLogin: login, universeId, ...modeFields });
}

/** The pieces of one door screen run, shared by the free and paid paths. */
interface ScreenCommandParts {
  command: WorkflowJobCommand;
  jobId: string;
  tenantId: string;
  shards: WorkflowJobCommand["shards"];
  startedAtIso: string;
}

/**
 * Build the parent ScreenerScreenWorkflow command for one door
 * screen (the S8 command shape under the door's own source —
 * header difference 2). Job id: the manual scheme
 * (screener:<source>:<universe>:<timestamp>) plus a random
 * suffix, so two screens in one millisecond never adopt each
 * other's run.
 */
function buildScreenCommand(
  ctx: MeshScreenDoorContext,
  req: {
    filters: StockScreenerFilter;
    userLogin: string;
    universeId: UniverseId;
    /** Issue #2530: present only on an admitted ND run (gate + intent checked at the seam). */
    screenMode?: "non-deterministic";
    screenIntent?: string;
  },
): ScreenCommandParts {
  const shards: WorkflowJobCommand["shards"] =
    req.universeId === "ALL"
      ? shardableUniverses().map((u) => ({ shardId: u, universe: u }))
      : [{ shardId: req.universeId, universe: req.universeId }];
  const nowMs = ctx.nowMs ?? (() => Date.now());
  const startedAtIso = new Date(nowMs()).toISOString();
  const jobId = `screener:chat:${req.universeId}:${startedAtIso}:${crypto.randomUUID().slice(0, 8)}`;
  const tenantId = workflowTenantId(ctx.env);
  const traceparent = ctx.traceparent?.();
  const command: WorkflowJobCommand = {
    jobId,
    type: "run-screen",
    source: "mesh-door",
    trigger: "manual",
    userLogin: req.userLogin,
    role: "parent",
    tenantId,
    shards,
    filters: req.filters as unknown as Record<string, unknown>,
    maxItems: 10,
    pollIntervalMs: SCREEN_DOOR_PARENT_POLL_INTERVAL_MS,
    ...(req.screenMode
      ? { screenMode: req.screenMode, screenIntent: req.screenIntent }
      : {}),
    ...(traceparent ? { traceparent } : {}),
  };
  return { command, jobId, tenantId, shards, startedAtIso };
}

/**
 * Record the workflow-start hop for a door screen run, under
 * the command's traceparent (the S17 discipline the port
 * keeps: best-effort, never blocks or fails the run; no
 * traceparent → no hop, the recorded break).
 */
async function recordScreenStartHop(
  ctx: MeshScreenDoorContext,
  parts: ScreenCommandParts,
  operation: string,
): Promise<void> {
  const child = childContextOfTraceparent(parts.command.traceparent);
  if (!child) return;
  const hop: import("../../data/meshTracePorts").MeshTraceHop = {
    traceId: child.traceId,
    spanId: child.spanId,
    parentSpanId: child.parentSpanId,
    kind: "workflow-start",
    operation,
    timestampMs: (ctx.nowMs ?? Date.now)(),
    tenantId: parts.tenantId,
    caller: parts.command.userLogin,
    agent: "ScreenerScreenWorkflow",
    jobId: parts.jobId,
  };
  try {
    if (ctx.traceStore !== undefined) {
      if (ctx.traceStore) await ctx.traceStore.record(hop);
    } else {
      await meshTraceStoreForEnv(ctx.env).record(hop);
    }
  } catch {
    // Best-effort by design (the #1743 degradation rule).
  }
}

/**
 * The free path: start the run and await its outcome. Unlike
 * the NLQ port there is NO fallback: an unavailable port or a
 * failed start is a coded refusal (header difference 1). Once
 * a run exists, every outcome returns as a result — starting
 * anything else would run the screen twice.
 */
async function runFreeScreen(
  ctx: MeshScreenDoorContext,
  req: {
    filters: StockScreenerFilter;
    userLogin: string;
    universeId: UniverseId;
    screenMode?: "non-deterministic";
    screenIntent?: string;
  },
): Promise<MeshScreenRunResult> {
  const ports: WorkflowPort | null =
    ctx.workflowPort !== undefined ? ctx.workflowPort : createWorkflowPorts(ctx.env);
  if (!ports) {
    const reason =
      ctx.workflowPort === null
        ? "the workflow port was explicitly unavailable in this context"
        : `the workflow composition root returned no port (${workflowPortsUnavailableReason(ctx.env) ?? "unavailable"})`;
    throw new MeshDoorError(
      "door_unavailable",
      `run_stock_screen refused: ${reason}. A mesh screen is a ScreenerScreenWorkflow run, and this door has ` +
        "no direct-agent fallback — nothing was started and no screen ran off-workflow.",
    );
  }

  const parts = buildScreenCommand(ctx, req);
  let handle;
  try {
    handle = await ports.start(assertWorkflowJobCommand(parts.command));
  } catch (err) {
    throw new MeshDoorError(
      "door_unavailable",
      `run_stock_screen refused: the ScreenerScreenWorkflow start failed (${err instanceof Error ? err.message : String(err)}). ` +
        "No fallback run was started — a mesh screen is a workflow run or it does not run.",
    );
  }

  await recordScreenStartHop(ctx, parts, "screener.start");
  return awaitScreenOutcome(ctx, {
    shards: parts.shards,
    userLogin: req.userLogin,
    startedAtIso: parts.startedAtIso,
    jobId: parts.jobId,
    tenantId: parts.tenantId,
    statusOf: async () => {
      const status = await ports.status(handle.workflowId).catch(() => null);
      return status?.status ?? null;
    },
  });
}

/**
 * Await a started screener run on its own surfaces: the D1
 * parent-row collation first, the workflow instance status for
 * terminal detection (the free path's await; the paid path has
 * its own await below, as in the port).
 */
async function awaitScreenOutcome(
  ctx: MeshScreenDoorContext,
  args: {
    shards: WorkflowJobCommand["shards"];
    userLogin: string;
    startedAtIso: string;
    jobId: string;
    tenantId: string;
    statusOf: () => Promise<string | null>;
  },
): Promise<MeshScreenRunResult> {
  const readHistory =
    ctx.readWorkflowJobHistory ?? ((t: string, c: string) => readJobHistory(ctx.env, t, c));
  const sleep =
    ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowMs = ctx.nowMs ?? (() => Date.now());
  const pollIntervalMs = ctx.workflowPollIntervalMs ?? SCREEN_DOOR_POLL_INTERVAL_MS;
  const deadline = nowMs() + (ctx.workflowAwaitDeadlineMs ?? SCREEN_DOOR_AWAIT_DEADLINE_MS);
  // A terminal instance whose collation has not projected yet
  // gets a few extra polls — projection lag is not a failure.
  let terminalPolls = 0;
  for (;;) {
    const rows = await readHistory(args.tenantId, args.jobId).catch(() => null);
    const collation = collationFromRows(rows, args.jobId);
    if (collation) {
      return assembleScreenResult(ctx, {
        shards: args.shards,
        userLogin: args.userLogin,
        startedAtIso: args.startedAtIso,
        collation,
        rows,
        jobId: args.jobId,
        terminalNote: "completed",
      });
    }
    const status = await args.statusOf().catch(() => null);
    const terminal =
      status !== null &&
      (status === "complete" || status === "errored" || status === "terminated");
    if (terminal) {
      terminalPolls += 1;
      if (terminalPolls >= 3) {
        return assembleScreenResult(ctx, {
          shards: args.shards,
          userLogin: args.userLogin,
          startedAtIso: args.startedAtIso,
          collation: null,
          rows,
          jobId: args.jobId,
          terminalNote: `ended with workflow status "${status}" before its outcome was projected`,
        });
      }
    }
    if (nowMs() >= deadline) {
      return assembleScreenResult(ctx, {
        shards: args.shards,
        userLogin: args.userLogin,
        startedAtIso: args.startedAtIso,
        collation: null,
        rows,
        jobId: args.jobId,
        terminalNote: "did not complete within the chat await window",
      });
    }
    await sleep(pollIntervalMs);
  }
}

/* ------------------------------------------------------------------ */
/* The paid path (S10 order, door-owned)                               */
/*                                                                     */
/* Order of operations (each step fail-closed, in this order):         */
/*   1. catalogue price (no stored price → refuse; never invent)       */
/*   2. PaymentsAgent budget check via the S5 door (refusal →          */
/*      refuse; zero workflow starts, no free fallback)                */
/*   3. checkout email (none resolvable → refuse)                      */
/*   4. fail-closed account resolution (tenant-checked stores)         */
/*   5. submit through the caller seam → one PaymentWorkflow run;      */
/*      the run id IS the screener job id (one charge per              */
/*      run-request; a retry adopts the same instance)                 */
/*   6. await the run on its own status surface + the D1               */
/*      collation; the result is the screener run's stored             */
/*      read-back, exactly as the free path assembles it.              */
/* The monetization gate's disposition inside the workflow governs     */
/* as configured; this path neither bypasses nor re-interprets it.     */
/* ------------------------------------------------------------------ */

/** The monetization flag read for the paid branch (the routes' composition). */
async function screenMonetizationOn(ctx: MeshScreenDoorContext): Promise<boolean> {
  if (ctx.monetizationOn) return ctx.monetizationOn();
  return createFeatureFlagPort(ctx.env).isEnabled("monetization");
}

/** Production price source: the operator price catalogue (schema ensured, as the routes ensure). */
async function defaultPaidScreenPriceUSD(env: Env): Promise<number | null> {
  const adapter = createPriceCatalogueAdapter(env as { AGENT_DB?: unknown });
  if (!adapter) return null;
  await ensurePriceCatalogueSchema(adapter.db);
  return adapter.getPrice("stock");
}

/** Production budget check: the S5 door (check_payment_budget's machinery, in-process). */
async function defaultPaidBudgetCheck(
  ctx: MeshScreenDoorContext,
  actingLogin: string,
  input: { operation: string; amountCents: number },
): Promise<{ allowed: boolean; reason?: string }> {
  const verdict = await checkPaymentBudgetViaDoor(ctx.env, actingLogin, input);
  return {
    allowed: verdict.allowed,
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
  };
}

/** Production account stores: the env adapters (null when AGENT_DB is unbound). */
async function defaultPaidScreenStores(env: Env): Promise<PaidScreenStorePorts | null> {
  const commercial = createCommercialAdapter(env as { AGENT_DB?: unknown });
  const subscriptions = createSubscriptionAdapter(env as { AGENT_DB?: unknown });
  if (!commercial || !subscriptions) return null;
  await Promise.all([
    ensureCommercialSchema(commercial.db),
    ensureSubscriptionSchema(subscriptions.db),
  ]);
  return { commercial, subscriptions };
}

/**
 * Production payment-status read: the PAYMENT_WORKFLOW
 * binding's own instance status. Best-effort — any failure
 * reads as null and the await falls back to the D1 collation
 * plus the deadline.
 */
async function defaultPaymentWorkflowStatus(
  env: Env,
  workflowId: string,
): Promise<{ status: string; output?: unknown } | null> {
  const binding = env.PAYMENT_WORKFLOW as unknown as
    | {
        get?: (
          id: string,
        ) => Promise<{ status?: () => Promise<{ status: string; output?: unknown }> }>;
      }
    | undefined;
  if (!binding || typeof binding.get !== "function") return null;
  const instance = await binding.get(workflowId);
  if (!instance || typeof instance.status !== "function") return null;
  const st = await instance.status();
  return { status: st.status, ...(st.output !== undefined ? { output: st.output } : {}) };
}

/**
 * One door paid request: budget check → seam → PaymentWorkflow
 * run → awaited read-back. Throws (fail-closed, before any
 * start) on every pre-submission refusal; after submission,
 * every outcome returns as an honest result.
 */
async function runPaidScreen(
  ctx: MeshScreenDoorContext,
  req: {
    filters: StockScreenerFilter;
    userLogin: string;
    universeId: UniverseId;
    screenMode?: "non-deterministic";
    screenIntent?: string;
  },
): Promise<MeshScreenRunResult> {
  const parts = buildScreenCommand(ctx, req);
  const { jobId, tenantId, shards, startedAtIso } = parts;

  // 1. Price from the operator catalogue — fail closed before
  // the budget check when no valid stored price exists.
  const priceUSD = await (ctx.paidScreenPriceUSD
    ? ctx.paidScreenPriceUSD()
    : defaultPaidScreenPriceUSD(ctx.env));
  if (typeof priceUSD !== "number" || !Number.isFinite(priceUSD) || priceUSD <= 0) {
    throw new MeshDoorError(
      "price_unavailable",
      "Paid screen cannot proceed: no valid stored price for family \"stock\" in the operator price catalogue " +
        "(fail-closed — prices are operator-set, never invented). No budget check ran, no workflow was started, and no screen ran.",
    );
  }

  // 2. PaymentsAgent budget check FIRST, through the S5 door.
  // A refusal ends the request here: no workflow start, and
  // no free fallback — monetization on never runs a screen
  // for free.
  const amountCents = Math.round(priceUSD * 100);
  const budgetInput = { operation: SCREEN_DOOR_BUDGET_OPERATION, amountCents };
  const verdict = await (ctx.paidBudgetCheck
    ? ctx.paidBudgetCheck(req.userLogin, budgetInput)
    : defaultPaidBudgetCheck(ctx, req.userLogin, budgetInput));
  if (!verdict.allowed) {
    throw new MeshDoorError(
      "budget_denied",
      `Paid screen refused by the PaymentsAgent budget check: ${verdict.reason ?? "no reason given"} ` +
        `(operation "${SCREEN_DOOR_BUDGET_OPERATION}", amount ${amountCents} cents). No workflow was started and no screen ran.`,
    );
  }

  // 3. Checkout contact. No verified email source exists for
  // a chat turn today, so this refuses honestly until one is
  // composed in through the seam (the S10 gap, unchanged).
  const email = ((await ctx.checkoutEmail?.()) ?? "").trim();
  if (!email) {
    throw new MeshDoorError(
      "checkout_email_required",
      "Paid screen requires a checkout email when monetization is on, and no checkout email source is configured for chat " +
        "in this deployment. No workflow was started and no screen ran.",
    );
  }

  // 4. Fail-closed account resolution (tenant-checked).
  const stores =
    ctx.paidScreenStores !== undefined
      ? ctx.paidScreenStores
      : await defaultPaidScreenStores(ctx.env);
  const { account } = await resolvePaidScreenAccount(
    stores ?? { commercial: null, subscriptions: null },
    { userId: req.userLogin, email, tenantId, nowMs: (ctx.nowMs ?? Date.now)() },
  );

  // 5. Submit through the fail-closed caller seam: one
  // PaymentWorkflow run per run-request; the binding throws
  // when unconfigured rather than running the screen free.
  const params = buildPaidScreenSubmission({
    runRequestId: jobId,
    family: "stock",
    trigger: "manual",
    tenantId,
    userId: req.userLogin,
    email,
    account,
    screenerCommand: parts.command,
  });
  const binding =
    ctx.paymentWorkflowBinding !== undefined
      ? (ctx.paymentWorkflowBinding ?? undefined)
      : (ctx.env.PAYMENT_WORKFLOW as unknown as PaymentWorkflowBinding | undefined);
  const started = await startPaymentWorkflowViaBinding(binding, params);

  await recordScreenStartHop(ctx, parts, "payment.start");

  // 6. Await: the payment run starts the screener under the
  // same job id once coverage/payment lands.
  return awaitPaidScreenOutcome(ctx, {
    shards,
    userLogin: req.userLogin,
    startedAtIso,
    jobId,
    tenantId,
    workflowId: started.workflowId,
  });
}

/** The PaymentWorkflowOutcome status out of an instance status output, when present. */
function paymentOutcomeStatus(output: unknown): string | null {
  if (output && typeof output === "object" && "status" in output) {
    const s = (output as { status?: unknown }).status;
    return typeof s === "string" ? s : null;
  }
  return null;
}

/**
 * The honest terminal note for a payment run that ended
 * without starting the screen. Wording states what happened
 * and what did NOT happen (no screen, no confirmed charge);
 * the failure-compensation rule (a one-time replacement-run
 * credit, never a cash refund) is named where it applies.
 */
function paymentTerminalNote(outcome: string | null, instanceStatus: string, runRequestId: string): string {
  switch (outcome) {
    case "payment_required":
      return `payment run ${runRequestId} is still awaiting payment (checkout outstanding) — no screen was started and no charge was confirmed`;
    case "coverage_required":
      return `payment run ${runRequestId} requires subscription or credit coverage before it can start — no screen was started`;
    case "approval_rejected":
      return `payment run ${runRequestId} was rejected at approval — no screen was started and no charge was made`;
    case "expired":
      return `payment run ${runRequestId} expired before payment completed — no screen was started and no charge was confirmed`;
    case "screener_failed_credit_issued":
      return `payment run ${runRequestId} was covered/paid but the screener failed to start — a one-time replacement-run credit was issued for it (never a cash refund)`;
    default:
      return `payment run ${runRequestId} ended (workflow status "${instanceStatus}"${outcome ? `, outcome "${outcome}"` : ""}) without starting the screen`;
  }
}

/**
 * Await a submitted door payment run: poll the D1 collation
 * for the screener job id (the read-back the free path uses)
 * and the payment instance's own status surface. A terminal
 * payment outcome other than "started" returns promptly with
 * its honest note; "started" keeps polling the collation —
 * the screen runs under its own workflow from there.
 */
async function awaitPaidScreenOutcome(
  ctx: MeshScreenDoorContext,
  args: {
    shards: WorkflowJobCommand["shards"];
    userLogin: string;
    startedAtIso: string;
    jobId: string;
    tenantId: string;
    workflowId: string;
  },
): Promise<MeshScreenRunResult> {
  const readHistory =
    ctx.readWorkflowJobHistory ?? ((t: string, c: string) => readJobHistory(ctx.env, t, c));
  const sleep =
    ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowMs = ctx.nowMs ?? (() => Date.now());
  const pollIntervalMs = ctx.workflowPollIntervalMs ?? SCREEN_DOOR_POLL_INTERVAL_MS;
  const deadline = nowMs() + (ctx.workflowAwaitDeadlineMs ?? SCREEN_DOOR_AWAIT_DEADLINE_MS);
  const readPaymentStatus =
    ctx.paymentWorkflowStatus ??
    ((id: string) => defaultPaymentWorkflowStatus(ctx.env, id));
  for (;;) {
    const rows = await readHistory(args.tenantId, args.jobId).catch(() => null);
    const collation = collationFromRows(rows, args.jobId);
    if (collation) {
      return assembleScreenResult(ctx, {
        shards: args.shards,
        userLogin: args.userLogin,
        startedAtIso: args.startedAtIso,
        collation,
        rows,
        jobId: args.jobId,
        terminalNote: "completed",
      });
    }
    const pStatus = await readPaymentStatus(args.workflowId).catch(() => null);
    if (
      pStatus &&
      (pStatus.status === "complete" || pStatus.status === "errored" || pStatus.status === "terminated")
    ) {
      const outcome = paymentOutcomeStatus(pStatus.output);
      if (outcome !== "started") {
        return assembleScreenResult(ctx, {
          shards: args.shards,
          userLogin: args.userLogin,
          startedAtIso: args.startedAtIso,
          collation: null,
          rows,
          jobId: args.jobId,
          terminalNote: paymentTerminalNote(outcome, pStatus.status, args.jobId),
        });
      }
      // Outcome "started": the screener is running under its
      // own workflow; keep polling the collation until the
      // deadline, exactly as the free path awaits its run.
    }
    if (nowMs() >= deadline) {
      return assembleScreenResult(ctx, {
        shards: args.shards,
        userLogin: args.userLogin,
        startedAtIso: args.startedAtIso,
        collation: null,
        rows,
        jobId: args.jobId,
        terminalNote:
          `payment run ${args.jobId} (payment workflow ${args.workflowId}) produced no screen result within the chat await window — ` +
          "no second run was started",
      });
    }
    await sleep(pollIntervalMs);
  }
}

/* ------------------------------------------------------------------ */
/* Collation + canonical read-back + assembly                          */
/* ------------------------------------------------------------------ */

/**
 * The collation out of a chain's projection rows: the parent
 * row (keyed by the job id) carries it as its resultJson once
 * project-final lands. The announce row's {jobId, detail}
 * shape has no lifecycle — not terminal, keep polling.
 */
function collationFromRows(rows: ShardJobRow[] | null, jobId: string): WorkflowCollation | null {
  const parent = rows?.find((r) => r.jobKey === jobId);
  if (!parent) return null;
  try {
    const parsed = JSON.parse(parent.resultJson) as WorkflowCollation;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.lifecycle === "string" &&
      Array.isArray(parsed.shards)
    ) {
      return parsed;
    }
  } catch {
    // Not a collation payload (announce row) — keep polling.
  }
  return null;
}

/** One stored canonical screener body, parsed (the read-back shape). */
interface StoredScreenBody {
  timestamp: string;
  universe?: string;
  sector?: string;
  success: boolean;
  totalScanned: number;
  matchedCount: number;
  filterSummary?: string;
  discoveryMessage?: string;
  error?: string;
  pdfKey?: string;
  rejections?: Array<{ symbol: string; reason: string }>;
  allStocks: MeshScreenRunResult["allStocks"];
  opportunities: MeshScreenRunResult["opportunities"];
}

function parseStoredScreenBody(text: string): StoredScreenBody | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.success !== "boolean" || typeof parsed.timestamp !== "string") return null;
    return {
      timestamp: parsed.timestamp,
      ...(typeof parsed.universe === "string" ? { universe: parsed.universe } : {}),
      ...(typeof parsed.sector === "string" ? { sector: parsed.sector } : {}),
      success: parsed.success,
      totalScanned: typeof parsed.totalScanned === "number" ? parsed.totalScanned : 0,
      matchedCount: typeof parsed.matchedCount === "number" ? parsed.matchedCount : 0,
      ...(typeof parsed.filterSummary === "string" ? { filterSummary: parsed.filterSummary } : {}),
      ...(typeof parsed.discoveryMessage === "string" ? { discoveryMessage: parsed.discoveryMessage } : {}),
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      ...(typeof parsed.pdfKey === "string" ? { pdfKey: parsed.pdfKey } : {}),
      ...(Array.isArray(parsed.rejections)
        ? { rejections: parsed.rejections as Array<{ symbol: string; reason: string }> }
        : {}),
      allStocks: Array.isArray(parsed.allStocks)
        ? (parsed.allStocks as MeshScreenRunResult["allStocks"])
        : [],
      opportunities: Array.isArray(parsed.opportunities)
        ? (parsed.opportunities as MeshScreenRunResult["opportunities"])
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Read back the canonical screener reports stored at or after
 * the run started (the store seam keys created_at to the run's
 * own timestamp, which follows the workflow start). User-scoped
 * via listScheduledReports (strict filter when the login is
 * known — it always is here). Bodies stored out-of-line resolve
 * through R2.
 */
async function readStoredScreenBodies(
  ctx: MeshScreenDoorContext,
  userLogin: string,
  startedAtIso: string,
): Promise<StoredScreenBody[]> {
  let hits: ScheduledReportHit[];
  try {
    hits = listScheduledReports(ctx.ensureTables(), {
      userLogin,
      sourceFilter: "screener",
      limit: 100,
    });
  } catch {
    return [];
  }
  const bodies: StoredScreenBody[] = [];
  for (const hit of hits) {
    if (hit.createdAt < startedAtIso) continue;
    const text = await resolveCanonicalReportBody(ctx.env, hit);
    if (!text) continue;
    const body = parseStoredScreenBody(text);
    if (body) bodies.push(body);
  }
  return bodies;
}

function resultFromStoredBody(body: StoredScreenBody): MeshScreenRunResult {
  return {
    timestamp: body.timestamp,
    universe: body.universe ?? "",
    sector: body.sector ?? "",
    success: body.success,
    totalScanned: body.totalScanned,
    matchedCount: body.matchedCount,
    ...(body.filterSummary ? { filterSummary: body.filterSummary } : {}),
    discoveryMessage: body.discoveryMessage ?? "",
    ...(body.error ? { error: body.error } : {}),
    ...(body.pdfKey ? { pdfKey: body.pdfKey } : {}),
    ...(body.rejections ? { rejections: body.rejections } : {}),
    allStocks: body.allStocks,
    opportunities: body.opportunities,
  };
}

/**
 * Assemble the door result for a started run: per-shard
 * results read back from mas_reports, aggregated the way the
 * route's ALL path aggregates (success iff at least one shard
 * succeeded unless the collation lifecycle is Failed; counts
 * sum; rows concatenate in shard order). Stage failures
 * surface as coded failures: the error is the collation's, the
 * shard outcome's, the stored failure record's, or the
 * projection detail's — in that order — never a fabricated
 * success.
 */
async function assembleScreenResult(
  ctx: MeshScreenDoorContext,
  args: {
    shards: WorkflowJobCommand["shards"];
    userLogin: string;
    startedAtIso: string;
    collation: WorkflowCollation | null;
    rows: ShardJobRow[] | null;
    jobId: string;
    terminalNote: string;
  },
): Promise<MeshScreenRunResult> {
  const { shards, collation, rows, jobId } = args;
  const bodies = await readStoredScreenBodies(ctx, args.userLogin, args.startedAtIso);

  // Match bodies to shards: by the collation's pdfKey first
  // (unique per run), then by universe, then — when exactly
  // one body and one unmatched shard remain — by elimination.
  const used = new Set<number>();
  const perShard = new Map<string, StoredScreenBody>();
  for (const shard of shards) {
    const outcome = collation?.shards.find((s) => s.shardId === shard.shardId);
    if (outcome?.pdfKey) {
      const idx = bodies.findIndex((b, i) => !used.has(i) && b.pdfKey === outcome.pdfKey);
      if (idx >= 0) {
        used.add(idx);
        perShard.set(shard.shardId, bodies[idx]);
      }
    }
  }
  for (const shard of shards) {
    if (perShard.has(shard.shardId)) continue;
    const idx = bodies.findIndex(
      (b, i) => !used.has(i) && b.universe !== undefined && b.universe === shard.universe,
    );
    if (idx >= 0) {
      used.add(idx);
      perShard.set(shard.shardId, bodies[idx]);
    }
  }
  const unmatchedShards = shards.filter((s) => !perShard.has(s.shardId));
  const unmatchedBodies = bodies.filter((_, i) => !used.has(i));
  if (unmatchedShards.length === 1 && unmatchedBodies.length === 1) {
    perShard.set(unmatchedShards[0].shardId, unmatchedBodies[0]);
  }

  const detailFor = (jobKey: string): string | undefined =>
    rows?.find((r) => r.jobKey === jobKey)?.detail || undefined;
  const shardError = (shardId: string): string | undefined =>
    collation?.shards.find((s) => s.shardId === shardId)?.error ??
    detailFor(`leg:${shardId}`);

  const matched = shards
    .map((s) => perShard.get(s.shardId))
    .filter((b): b is StoredScreenBody => b !== undefined);

  if (matched.length === 0) {
    const error =
      collation?.error ??
      detailFor("leg:parent") ??
      shards.map((s) => shardError(s.shardId)).find((e) => typeof e === "string") ??
      `Screen workflow run ${jobId} ${args.terminalNote}; it remains tracked at ${workflowStatusUrl(jobId)}.`;
    return {
      timestamp: args.startedAtIso,
      universe: shards.length === 1 ? (shards[0].universe ?? "") : "ALL",
      sector: "",
      success: false,
      totalScanned: collation?.coverage.evaluated ?? 0,
      matchedCount: collation?.shards.reduce((n, s) => n + (s.matchedCount ?? 0), 0) ?? 0,
      discoveryMessage: "",
      error,
      allStocks: [],
      opportunities: [],
    };
  }

  const results = matched.map(resultFromStoredBody);
  const success =
    collation?.lifecycle === "Failed" ? false : results.some((r) => r.success);
  const firstError =
    results.find((r) => !r.success)?.error ??
    collation?.error ??
    shards.map((s) => shardError(s.shardId)).find((e) => typeof e === "string");
  return {
    timestamp: results.reduce((max, r) => (r.timestamp > max ? r.timestamp : max), results[0].timestamp),
    universe: shards.length === 1 ? (results[0].universe ?? "") : "ALL",
    sector:
      results.length === 1
        ? (results[0].sector ?? "")
        : results.every((r) => r.sector === results[0].sector)
          ? (results[0].sector ?? "")
          : "ALL",
    success,
    totalScanned: results.reduce((n, r) => n + r.totalScanned, 0),
    matchedCount: results.reduce((n, r) => n + r.matchedCount, 0),
    ...(results.find((r) => r.filterSummary)?.filterSummary
      ? { filterSummary: results.find((r) => r.filterSummary)!.filterSummary }
      : {}),
    discoveryMessage: results.find((r) => r.discoveryMessage)?.discoveryMessage ?? "",
    ...(!success && firstError ? { error: firstError } : {}),
    ...(results.find((r) => r.pdfKey)?.pdfKey
      ? { pdfKey: results.find((r) => r.pdfKey)!.pdfKey }
      : {}),
    ...(results.some((r) => r.rejections?.length)
      ? { rejections: results.flatMap((r) => r.rejections ?? []) }
      : {}),
    allStocks: results.flatMap((r) => r.allStocks),
    opportunities: results.flatMap((r) => r.opportunities),
  };
}
