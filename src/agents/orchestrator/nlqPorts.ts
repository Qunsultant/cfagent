/**
 * Issue #992: NLQ ports (scheduling + stock-screen bindings for the NLQ executor) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * NlqPortsContext.
 */

import type { AgentContext, ScheduleOptions } from "agents";
import type { AgentScheduleItem, Env, StockScreenerFilter } from "../../types";
import type { NLQSchedulingPort, NLQSocialBriefPort, NLQStockScreenPort, NLQStockScreenRunResult } from "../nlq";
import type { ScreenerAgent, ScreenerRunRequest } from "../screener-agent";
import type { SocialBriefStore } from "../social/briefStore";
import { shardableUniverses } from "../../trading";
import { createWorkflowPorts } from "../../workflows/createWorkflowPorts";
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
import { childContextOfTraceparent } from "../../observability/meshTrace";
import {
  listScheduledReports,
  resolveCanonicalReportBody,
  type ScheduledReportHit,
} from "../../services/scheduledReports";
import { createFeatureFlagPort } from "../../features/createFeatureFlagPort";
import { checkPaymentBudgetViaDoor } from "./meshDoors";
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

/**
 * Ports the NLQ-port constructors receive from the class. The schedule
 * functions are the Agent base class's own methods, bound by the class
 * with the `keyof this` cast the SDK signature requires (the same
 * binding routeRequest's contexts use).
 */
export interface NlqPortsContext {
  schedule: (when: Date | number | string, callback: string, payload?: unknown, options?: ScheduleOptions) => Promise<unknown>;
  scheduleEvery: (intervalSeconds: number, callback: string, payload?: unknown) => Promise<unknown>;
  cancelSchedule: (id: string) => Promise<boolean>;
  listSchedules: () => Promise<unknown[]>;
  getScreenerAgent: (userLogin?: string) => ScreenerAgent;
  getSocialBriefStore: () => SocialBriefStore | null;
  /**
   * Issue #2369: the worker env — the workflow composition
   * root, the IAAA tenant resolution and the canonical-body
   * R2 resolution all read it.
   */
  env: Env;
  /**
   * Issue #2369: the orchestrator instance's SQL storage —
   * the mas_reports read-back for workflow-run results (the
   * canonical copies live in this instance's own store).
   */
  ensureTables: () => AgentContext["storage"]["sql"];
  /**
   * Issue #2369 test seam: workflow port override (a
   * binding-seam fake). Absent → createWorkflowPorts(env)
   * per call; explicit null → the workflow path is
   * unavailable and the port keeps the legacy direct call.
   */
  workflowPort?: WorkflowPort | null;
  /**
   * Issue #2369 test seam: D1 job-history reader override.
   * Absent → readJobHistory(env, ...) (the projection read
   * behind /api/jobs/history).
   */
  readWorkflowJobHistory?: (tenantId: string, chainId: string) => Promise<ShardJobRow[] | null>;
  /** Issue #2369 test seams: await cadence/bound. Absent → the production defaults below. */
  workflowPollIntervalMs?: number;
  workflowAwaitDeadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  /**
   * Issue #2428 (Agent Mesh S17): the in-flight turn's mesh
   * traceparent resolver — the workflow command built here is
   * stamped with it (the #1743 traceparent field), so the run
   * joins the turn's trace. Absent → the command carries no
   * traceparent: the run is untraced (the registry's recorded
   * break), never stamped with a minted-after-the-fact trace.
   */
  traceparent?: () => string | undefined;
  /**
   * Issue #2428 test seam: trace hop store override. Absent →
   * the env-resolved store (createMeshTracePorts); explicit
   * null → hop recording off for this context.
   */
  traceStore?: import("../../data/meshTracePorts").MeshTraceStore | null;
  /**
   * Issue #2378 (Agent Mesh S10, G5) paid-path seams. All
   * optional; the production defaults derive from `env`
   * exactly as the routes derive theirs (flag port, catalogue
   * adapter, commercial/subscription adapters, the
   * PAYMENT_WORKFLOW binding).
   */
  /** Monetization (Flagship) flag read for the paid branch. Absent → createFeatureFlagPort(env).isEnabled("monetization"). */
  monetizationOn?: () => Promise<boolean>;
  /**
   * Stored catalogue price (USD) for the stock family.
   * Absent → the price-catalogue adapter's getPrice("stock") —
   * null when the catalogue is unbound or carries no stock
   * price, and the paid path then fails closed before any
   * budget check or workflow start (no amount is invented).
   */
  paidScreenPriceUSD?: () => Promise<number | null>;
  /**
   * PaymentsAgent budget check behind the S5 door machinery.
   * Absent → checkPaymentBudgetViaDoor(env, actingLogin, input)
   * — the door stamps the spend-attribution agentId and
   * carries the acting login as the separate requester.
   */
  paidBudgetCheck?: (
    actingLogin: string,
    input: { operation: string; amountCents: number },
  ) => Promise<{ allowed: boolean; reason?: string }>;
  /**
   * Checkout contact email for a chat paid request. NO
   * production default exists: no verified email is carried
   * by a chat turn in this codebase (the routes take the
   * caller's checkout contact for the same reason), so until
   * a chat email source is composed in, the paid branch
   * refuses honestly when monetization is on rather than
   * inventing one.
   */
  checkoutEmail?: () => string | null | Promise<string | null>;
  /**
   * Commercial + subscription stores for the fail-closed
   * account resolution. Absent → the env adapters; an
   * explicit null (or unbound AGENT_DB) leaves the resolver
   * store-less, which it refuses. Tests pin explicit stores.
   */
  paidScreenStores?: PaidScreenStorePorts | null;
  /** PAYMENT_WORKFLOW binding seam — the only place a payment workflow is started from. Absent → env.PAYMENT_WORKFLOW. */
  paymentWorkflowBinding?: PaymentWorkflowBinding | null;
  /**
   * Best-effort PaymentWorkflow instance status read — the
   * workflow's own status surface. Absent → the binding's
   * get(id).status(); null when unreadable, and the await
   * then relies on the D1 collation + deadline alone.
   */
  paymentWorkflowStatus?: (
    workflowId: string,
  ) => Promise<{ status: string; output?: unknown } | null>;
}

/**
 * Issue #109: binds this agent's Cloudflare Agents scheduling API
 * into the narrow port the NLQ executor consumes, so schedules
 * created/listed/cancelled from natural language are real SDK
 * schedules with real ids.
 *
 * Issue #108: the bindings call the typed Agent methods directly —
 * schedule/scheduleEvery/cancelSchedule/listSchedules are typed
 * members of the Agent base class, so the old `(this as any)` +
 * typeof-guard layer is gone. The port receives callback names as
 * plain strings from NLQ plan parsing; the narrow `as keyof this`
 * assertion is the one cast that remains, because the SDK signature
 * requires a method-name key. It cannot fabricate success: an
 * unknown name makes the SDK call throw, and the NLQ executor
 * converts any throw into an honest failure reply.
 */
export function nlqSchedulingPort(ctx: NlqPortsContext): NLQSchedulingPort {
  return {
    schedule: async (when, callback, payload, options) =>
      (await ctx.schedule(when, callback, payload, options)) as AgentScheduleItem,
    scheduleEvery: async (intervalSeconds, callback, payload) =>
      (await ctx.scheduleEvery(intervalSeconds, callback, payload)) as AgentScheduleItem,
    cancelSchedule: async (id) => await ctx.cancelSchedule(id),
    listSchedules: async () => (await ctx.listSchedules()) as AgentScheduleItem[],
  };
}

/**
 * Issue #982: the NLQ stock-screen port — binds the stock
 * screening service the REST /etrade/screen route delegates
 * to into the NLQ execution deps, so NLQ stock screens run
 * the same pipeline as REST screens.
 *
 * Issue #2369 (Agent Mesh S8, #2225 G2): a chat stock screen
 * now executes as a ScreenerScreenWorkflow run. The port
 * starts a parent command through the WorkflowPort (the
 * #1737 port the synchronous routes adopt opt-in and goal
 * screens submit through, #1996), awaits the outcome on the
 * workflow's own status surface (instance status + the D1
 * parent-row collation), and reads the full results back
 * from mas_reports — the canonical copies the workflow's
 * own store step wrote (survey §3.4: results travel
 * store→read-back, never through workflow outputs). The NLQ
 * contract is unchanged: the executor still receives the
 * completed run result, and its own canonical persist
 * dedupes onto the same screener:<timestamp> generation row
 * the workflow store wrote. When the workflow port is
 * unavailable (binding/projection unbound) or the start
 * fails, the port falls back to the direct ScreenerAgent
 * call below — the route precedent (tryStartScreenerWorkflow:
 * an adoption must never fail a screen the direct path can
 * serve) — with the failure logged, never silent.
 *
 * Identity is fail-closed (#1185): a missing, blank, or
 * synthetic ("default") login throws before any workflow
 * start and before the fallback — the screen never runs
 * under an identity the caller did not actually carry. The
 * login arrives threaded through the async job's payload
 * (the S5 carriage, #2341), never from a tool argument.
 *
 * Delivery: the NLQ screen request shape carries no
 * delivery request, so the command runs no deliver step and
 * no chat-side delivery path exists beside the workflow's —
 * delivery requested on other doors keeps flowing through
 * the workflow's own deliver step.
 *
 * maxItems 10: the port's consumers take up to ten standout
 * picks (the watchlist_save fallback's top-10).
 *
 * Issue #2378 (Agent Mesh S10, #2225 G5): with the
 * monetization flag ON, the same port is the chat PAID path:
 * a PaymentsAgent budget check through the S5 door runs
 * first (a refusal ends the request — no workflow start, no
 * free fallback), then the request is submitted through the
 * fail-closed caller seam (paymentWorkflowSubmission) as a
 * PaymentWorkflow run — one charge per run-request, the run
 * id IS the screener job id — and the result is awaited and
 * read back exactly as the free workflow path reads it. The
 * gate's disposition inside the workflow governs as
 * configured; this port neither bypasses nor re-interprets
 * it. Scheduled runs never take this branch (they are
 * subscription/credits only, and they do not enter through
 * this port at all).
 */
export function nlqStockScreenPort(ctx: NlqPortsContext): NLQStockScreenPort {
  return {
    runScreen: async ({ filters, userLogin }) => {
      const login = typeof userLogin === "string" ? userLogin.trim() : "";
      if (!login || login === "default") {
        throw new Error(
          "NLQ stock screen requires the acting user's login — refusing to run under a missing or synthetic identity (issue #1185).",
        );
      }
      const universe = typeof (filters as { universe?: unknown })?.universe === "string"
        ? ((filters as { universe?: string }).universe as ScreenerRunRequest["universe"])
        : undefined;
      // Issue #2378 (Agent Mesh S10, #2225 G5): when the
      // monetization flag is on, a chat screen is a PAID
      // request — it takes the paid branch (budget check →
      // caller seam → PaymentWorkflow run) and never the free
      // paths below. Flag off → exactly the pre-S10 behavior.
      if (await chatMonetizationOn(ctx)) {
        return runChatPaidScreen(ctx, { filters, userLogin: login, universe });
      }
      const viaWorkflow = await runChatScreenViaWorkflow(ctx, { filters, userLogin: login, universe });
      if (viaWorkflow) return viaWorkflow;
      return ctx.getScreenerAgent(userLogin).runScreen({
        trigger: "manual",
        filters,
        universe,
        userLogin,
        maxItems: 10,
      });
    },
  };
}

/** Cadence for the port's own status-surface polls (the workflow's internal child polling is the command's pollIntervalMs). */
const CHAT_SCREEN_POLL_INTERVAL_MS = 2_000;
/**
 * Bound on the port's await. Generous against the workflow's
 * own per-shard deadlines (10 min per batch); on expiry the
 * port returns an honest tracked failure — the run continues
 * in the workflow and stays visible at its status URL — never
 * a fake success and never a silent second direct run.
 */
const CHAT_SCREEN_AWAIT_DEADLINE_MS = 15 * 60_000;
/** The parent workflow's child-poll cadence for chat runs (its durable sleeps; granularity only). */
const CHAT_SCREEN_PARENT_POLL_INTERVAL_MS = 5_000;

/** The pieces of one chat screen run, shared by the free (S8) and paid (S10) chat paths. */
interface ChatScreenCommandParts {
  command: WorkflowJobCommand;
  jobId: string;
  tenantId: string;
  shards: WorkflowJobCommand["shards"];
  startedAtIso: string;
}

/**
 * Build the parent ScreenerScreenWorkflow command for one
 * chat screen. Extracted unchanged from the S8 path (#2369)
 * so the S10 paid path submits the IDENTICAL command shape
 * through the PaymentWorkflow — the payment run starts the
 * screener under this command's job id once covered/paid.
 */
function buildChatScreenCommand(
  ctx: NlqPortsContext,
  req: { filters: StockScreenerFilter; userLogin: string; universe?: string },
): ChatScreenCommandParts {
  const universeId = req.universe ?? "TECH";
  const shards: WorkflowJobCommand["shards"] =
    universeId === "ALL"
      ? shardableUniverses().map((u) => ({ shardId: u, universe: u }))
      : [{ shardId: universeId, universe: universeId }];
  const nowMs = ctx.nowMs ?? (() => Date.now());
  const startedAtIso = new Date(nowMs()).toISOString();
  // Job id derived from the run (survey §3.4): the manual
  // scheme (screener:<source>:<universe>:<timestamp>) plus a
  // random suffix — two chat screens in one millisecond must
  // never adopt each other's run.
  const jobId = `screener:chat:${universeId}:${startedAtIso}:${crypto.randomUUID().slice(0, 8)}`;
  const tenantId = workflowTenantId(ctx.env);
  // Issue #2428 (Agent Mesh S17): stamp the turn's traceparent
  // onto the command (the #1743 field's first producer). The
  // resolver is the turn stash's lazy mint, so the command, the
  // workflow's step hops, and the read-surface assembly all
  // share the turn's ONE trace id. No resolver / no turn → no
  // stamp: an untraced run, honestly.
  const traceparent = ctx.traceparent?.();
  const command: WorkflowJobCommand = {
    jobId,
    type: "run-screen",
    source: "nlq-chat",
    trigger: "manual",
    userLogin: req.userLogin,
    role: "parent",
    tenantId,
    shards,
    filters: req.filters as unknown as Record<string, unknown>,
    maxItems: 10,
    pollIntervalMs: CHAT_SCREEN_PARENT_POLL_INTERVAL_MS,
    ...(traceparent ? { traceparent } : {}),
  };
  return { command, jobId, tenantId, shards, startedAtIso };
}

/**
 * Issue #2428: record the workflow-start hop for a chat screen
 * run, under the command's traceparent. Best-effort through the
 * env-resolved store (or the context's seam): a recording
 * failure degrades the trace, never the run. No traceparent →
 * no hop (the recorded break).
 */
async function recordChatScreenStartHop(
  ctx: NlqPortsContext,
  parts: ChatScreenCommandParts,
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
 * Start one chat screen as a ScreenerScreenWorkflow run and
 * await its outcome. Returns null ONLY when no run was
 * started (port unavailable / start failed) — the caller
 * then falls back to the direct call. Once a run exists,
 * every outcome (success, stage failure, await expiry)
 * returns as a result; falling back after a start would run
 * the screen twice.
 */
async function runChatScreenViaWorkflow(
  ctx: NlqPortsContext,
  req: { filters: StockScreenerFilter; userLogin: string; universe?: string },
): Promise<NLQStockScreenRunResult | null> {
  const ports: WorkflowPort | null =
    ctx.workflowPort !== undefined ? ctx.workflowPort : createWorkflowPorts(ctx.env);
  if (!ports) return null;

  const { command, jobId, tenantId, shards, startedAtIso } = buildChatScreenCommand(ctx, req);
  const nowMs = ctx.nowMs ?? (() => Date.now());

  let handle;
  try {
    handle = await ports.start(assertWorkflowJobCommand(command));
  } catch (err) {
    console.warn(
      "[nlq-stock-screen] Workflow start failed; falling back to the direct screen:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  // Issue #2428: the run exists — record its start hop on the
  // turn's trace (best-effort; never blocks the await below).
  await recordChatScreenStartHop(ctx, { command, jobId, tenantId, shards, startedAtIso }, "screener.start");

  const readHistory =
    ctx.readWorkflowJobHistory ?? ((t: string, c: string) => readJobHistory(ctx.env, t, c));
  const sleep =
    ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = ctx.workflowPollIntervalMs ?? CHAT_SCREEN_POLL_INTERVAL_MS;
  const deadline = nowMs() + (ctx.workflowAwaitDeadlineMs ?? CHAT_SCREEN_AWAIT_DEADLINE_MS);
  // A terminal instance whose collation has not projected yet
  // gets a few extra polls — projection lag is not a failure.
  let terminalPolls = 0;
  for (;;) {
    const rows = await readHistory(tenantId, jobId).catch(() => null);
    const collation = collationFromRows(rows, jobId);
    if (collation) {
      return assembleChatScreenResult(ctx, {
        shards,
        userLogin: req.userLogin,
        startedAtIso,
        collation,
        rows,
        jobId,
        terminalNote: "completed",
      });
    }
    const status = await ports.status(handle.workflowId).catch(() => null);
    const terminal =
      status !== null &&
      (status.status === "complete" || status.status === "errored" || status.status === "terminated");
    if (terminal) {
      terminalPolls += 1;
      if (terminalPolls >= 3) {
        return assembleChatScreenResult(ctx, {
          shards,
          userLogin: req.userLogin,
          startedAtIso,
          collation: null,
          rows,
          jobId,
          terminalNote: `ended with workflow status "${status.status}" before its outcome was projected`,
        });
      }
    }
    if (nowMs() >= deadline) {
      return assembleChatScreenResult(ctx, {
        shards,
        userLogin: req.userLogin,
        startedAtIso,
        collation: null,
        rows,
        jobId,
        terminalNote: "did not complete within the chat await window",
      });
    }
    await sleep(pollIntervalMs);
  }
}

/* ------------------------------------------------------------------ */
/* Issue #2378 (Agent Mesh S10, #2225 G5): the chat paid path.        */
/*                                                                     */
/* Order of operations (each step fail-closed, in this order):         */
/*   1. catalogue price (no stored price → refuse; never invent)       */
/*   2. PaymentsAgent budget check via the S5 door (refusal →          */
/*      refuse; zero workflow starts, no free fallback)                */
/*   3. checkout email (none resolvable → refuse, the route's          */
/*      400 in chat shape)                                             */
/*   4. fail-closed account resolution (tenant-checked stores)         */
/*   5. submit through the caller seam → one PaymentWorkflow run;      */
/*      the run id IS the screener job id (one charge per              */
/*      run-request; a retry adopts the same instance)                 */
/*   6. await the run on its own status surface + the D1               */
/*      collation; the result is the screener run's stored             */
/*      read-back, exactly as the free chat path assembles it.         */
/* The monetization gate's disposition inside the workflow             */
/* governs exactly as configured — this path neither bypasses          */
/* nor re-interprets it.                                               */
/* ------------------------------------------------------------------ */

/**
 * The budget-guard operation a chat screen is charged
 * against. It is on PaymentsAgent's GUARD_ALLOWLIST, so the
 * guard evaluates the NLQ surface's spend limits. The amount
 * is the stored catalogue price for the stock family, in
 * cents; spend attribution is the door's (the orchestrator
 * agentic-spend bucket), the acting login its requester.
 */
const CHAT_PAID_BUDGET_OPERATION = "nlq.execute";

/** The monetization flag read for the paid branch (the routes' composition). */
async function chatMonetizationOn(ctx: NlqPortsContext): Promise<boolean> {
  if (ctx.monetizationOn) return ctx.monetizationOn();
  return createFeatureFlagPort(ctx.env).isEnabled("monetization");
}

/** Production price source: the operator price catalogue (schema ensured, as the routes ensure). */
async function defaultPaidScreenPriceUSD(
  env: NlqPortsContext["env"],
): Promise<number | null> {
  const adapter = createPriceCatalogueAdapter(env as { AGENT_DB?: unknown });
  if (!adapter) return null;
  await ensurePriceCatalogueSchema(adapter.db);
  return adapter.getPrice("stock");
}

/** Production budget check: the S5 door (check_payment_budget's machinery, in-process). */
async function defaultPaidBudgetCheck(
  ctx: NlqPortsContext,
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
async function defaultPaidScreenStores(
  env: NlqPortsContext["env"],
): Promise<PaidScreenStorePorts | null> {
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
  env: NlqPortsContext["env"],
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
 * One chat paid request: budget check → seam → PaymentWorkflow
 * run → awaited read-back. Throws (fail-closed, before any
 * start) on every pre-submission refusal; after submission,
 * every outcome returns as an honest result.
 */
async function runChatPaidScreen(
  ctx: NlqPortsContext,
  req: { filters: StockScreenerFilter; userLogin: string; universe?: string },
): Promise<NLQStockScreenRunResult> {
  const { command, jobId, tenantId, shards, startedAtIso } = buildChatScreenCommand(ctx, req);

  // 1. Price from the operator catalogue — fail closed
  // before the budget check when no valid stored price
  // exists; no amount is ever invented.
  const priceUSD = await (ctx.paidScreenPriceUSD
    ? ctx.paidScreenPriceUSD()
    : defaultPaidScreenPriceUSD(ctx.env));
  if (typeof priceUSD !== "number" || !Number.isFinite(priceUSD) || priceUSD <= 0) {
    throw new Error(
      "Chat paid screen cannot proceed: no valid stored price for family \"stock\" in the operator price catalogue " +
        "(fail-closed — prices are operator-set, never invented). No budget check ran, no workflow was started, and no screen ran.",
    );
  }

  // 2. PaymentsAgent budget check FIRST, through the S5
  // door, under the S5/S9 attribution discipline. A refusal
  // ends the request here: no workflow start, and no free
  // fallback — monetization on never runs a screen for free.
  const amountCents = Math.round(priceUSD * 100);
  const budgetInput = { operation: CHAT_PAID_BUDGET_OPERATION, amountCents };
  const verdict = await (ctx.paidBudgetCheck
    ? ctx.paidBudgetCheck(req.userLogin, budgetInput)
    : defaultPaidBudgetCheck(ctx, req.userLogin, budgetInput));
  if (!verdict.allowed) {
    throw new Error(
      `Chat paid screen refused by the PaymentsAgent budget check: ${verdict.reason ?? "no reason given"} ` +
        `(operation "${CHAT_PAID_BUDGET_OPERATION}", amount ${amountCents} cents). No workflow was started and no screen ran.`,
    );
  }

  // 3. Checkout contact. The submission params refuse to
  // build without an email; no verified email source exists
  // for a chat turn today, so this refuses honestly until
  // one is composed in through the seam.
  const email = ((await ctx.checkoutEmail?.()) ?? "").trim();
  if (!email) {
    throw new Error(
      "Chat paid screen requires a checkout email when monetization is on, and no checkout email source is configured for chat " +
        "in this deployment. No workflow was started and no screen ran.",
    );
  }

  // 4. Fail-closed account resolution (tenant-checked) from
  // the commercial + subscription stores, exactly as the
  // routes resolve it.
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
    screenerCommand: command,
  });
  const binding =
    ctx.paymentWorkflowBinding !== undefined
      ? (ctx.paymentWorkflowBinding ?? undefined)
      : (ctx.env.PAYMENT_WORKFLOW as unknown as PaymentWorkflowBinding | undefined);
  const started = await startPaymentWorkflowViaBinding(binding, params);

  // Issue #2428: the payment run exists — record its start hop
  // on the turn's trace (the screener command it will start
  // carries the same traceparent, stamped in
  // buildChatScreenCommand).
  await recordChatScreenStartHop(ctx, { command, jobId, tenantId, shards, startedAtIso }, "payment.start");

  // 6. Await: the payment run starts the screener under the
  // same job id once coverage/payment lands.
  return awaitChatPaidScreenOutcome(ctx, {
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
 * the failure-compensation rule (automatic compensation is a
 * one-time replacement-run credit, never an automatic cash
 * refund, #2549) is named where it applies.
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
      return `payment run ${runRequestId} was covered/paid but the screener failed to start — a one-time replacement-run credit was issued for it (automatic compensation is a credit, not a cash refund)`;
    default:
      return `payment run ${runRequestId} ended (workflow status "${instanceStatus}"${outcome ? `, outcome "${outcome}"` : ""}) without starting the screen`;
  }
}

/**
 * Await a submitted chat payment run: poll the D1 collation
 * for the screener job id (the read-back the free path uses)
 * and the payment instance's own status surface. A terminal
 * payment outcome other than "started" returns promptly with
 * its honest note; "started" keeps polling the collation —
 * the screen runs under its own workflow from there.
 */
async function awaitChatPaidScreenOutcome(
  ctx: NlqPortsContext,
  args: {
    shards: WorkflowJobCommand["shards"];
    userLogin: string;
    startedAtIso: string;
    jobId: string;
    tenantId: string;
    workflowId: string;
  },
): Promise<NLQStockScreenRunResult> {
  const readHistory =
    ctx.readWorkflowJobHistory ?? ((t: string, c: string) => readJobHistory(ctx.env, t, c));
  const sleep =
    ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowMs = ctx.nowMs ?? (() => Date.now());
  const pollIntervalMs = ctx.workflowPollIntervalMs ?? CHAT_SCREEN_POLL_INTERVAL_MS;
  const deadline = nowMs() + (ctx.workflowAwaitDeadlineMs ?? CHAT_SCREEN_AWAIT_DEADLINE_MS);
  const readPaymentStatus =
    ctx.paymentWorkflowStatus ??
    ((id: string) => defaultPaymentWorkflowStatus(ctx.env, id));
  for (;;) {
    const rows = await readHistory(args.tenantId, args.jobId).catch(() => null);
    const collation = collationFromRows(rows, args.jobId);
    if (collation) {
      return assembleChatScreenResult(ctx, {
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
        return assembleChatScreenResult(ctx, {
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
      return assembleChatScreenResult(ctx, {
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

/**
 * The collation out of a chain's projection rows: the parent
 * row (keyed by the job id) carries it as its resultJson
 * once project-final lands. The announce row's {jobId,
 * detail} shape has no lifecycle — not terminal, keep
 * polling. A Failed-lifecycle final leg is projected under
 * a leg key with only its detail (the projection's failed-leg
 * shape), so a missing collation is not a missing outcome:
 * assembly falls back to the rows' details + stored bodies.
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
  allStocks: NLQStockScreenRunResult["allStocks"];
  opportunities: NLQStockScreenRunResult["opportunities"];
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
        ? (parsed.allStocks as NLQStockScreenRunResult["allStocks"])
        : [],
      opportunities: Array.isArray(parsed.opportunities)
        ? (parsed.opportunities as NLQStockScreenRunResult["opportunities"])
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Read back the canonical screener reports stored at or
 * after the run started (the store seam keys created_at to
 * the run's own timestamp, which follows the workflow
 * start). User-scoped via listScheduledReports (#584
 * EP-003 strict filter when the login is known — it always
 * is here). Bodies stored out-of-line resolve through R2.
 */
async function readStoredScreenBodies(
  ctx: NlqPortsContext,
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

function resultFromStoredBody(body: StoredScreenBody): NLQStockScreenRunResult {
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
 * Assemble the port result for a started run: per-shard
 * results read back from mas_reports, aggregated the way
 * the route's ALL path aggregates (success iff at least one
 * shard succeeded; counts sum; rows concatenate in shard
 * order). Stage failures surface as coded failures (#1999):
 * the error is the collation's, the shard outcome's, the
 * stored failure record's, or the projection detail's —
 * in that order — never a fabricated success.
 */
async function assembleChatScreenResult(
  ctx: NlqPortsContext,
  args: {
    shards: WorkflowJobCommand["shards"];
    userLogin: string;
    startedAtIso: string;
    collation: WorkflowCollation | null;
    rows: ShardJobRow[] | null;
    jobId: string;
    terminalNote: string;
  },
): Promise<NLQStockScreenRunResult> {
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
      (b, i) => !used.has(i) && shard.universe !== undefined && b.universe === shard.universe,
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

/**
 * #1077 Phase 5b slice 2: the NLQ social-brief port — binds the
 * durable brief store into the NLQ execution deps, so an explicit
 * "set social brief" request in trusted chat writes the day's brief
 * the social goal will publish. Returns null when no store is
 * available, so callers pass no port and the executor fails honestly
 * instead of writing to nowhere.
 */
export function nlqSocialBriefPort(ctx: NlqPortsContext): NLQSocialBriefPort | null {
  const store = ctx.getSocialBriefStore();
  if (!store) return null;
  return {
    setBrief: async ({ date, text }) => {
      await store.putBrief(date, text);
    },
  };
}
