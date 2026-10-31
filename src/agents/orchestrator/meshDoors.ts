/**
 * Issue #2341 (Agent Mesh S5, programme #2225 G1 batch A) — typed
 * outbound doors from the orchestrator to ScheduledAgent and
 * PaymentsAgent.
 *
 * G1's discipline is the one the two existing wires already keep
 * (the ScreenerAgent typed stub, the ResearchAgent runAgentTool
 * dispatch): typed methods, explicit acting identity, honest typed
 * errors. A door resolves identity first, checks gates second,
 * dispatches third (docs/architecture/agentic/doors-and-layers.md
 * §11.1): a call whose acting identity is missing, blank, or the
 * retired synthetic literal "default" (retired by #2327 / mesh S3)
 * is refused BEFORE any stub is resolved — never defaulted, never
 * substituted.
 *
 * Addressing follows the A2A resolution precedent (#2223,
 * src/a2a/resolution.ts) and the production callers: ScheduledAgent
 * is the singleton instance "default" (the bare name would seed a
 * virgin catalogue); PaymentsAgent's live instance is "default"
 * (both production callers resolve it so, and the class is
 * instance-agnostic — its state derives from the ledger of record).
 *
 * Budget attribution: a chat-initiated budget check names
 * AGENTIC_SPEND_AGENT_ID ("orchestrator") as the budgetCheck
 * agentId. The ledger contract (#785/#896, src/payments/ledger.ts)
 * attributes orchestrator-executed outbound spend to that bucket,
 * and a check is only meaningful against the bucket the gated spend
 * will actually land in — the same reason ScheduledAgent's checks
 * name the same bucket post-S3. The acting user's login is a
 * different field: it is required, carried, and audited as the
 * check's requester; it is never the bucket.
 *
 * processPaidRequest is deliberately NOT exposed through this door
 * to the chat turn: the chat paid-request flow is S10's (G5 —
 * PaymentWorkflow with a PaymentsAgent budget check first), and
 * wiring the raw paid request here would pre-build that shape
 * beside the workflow path. The stub interface below types it for
 * completeness of the agent's surface; no door operation and no
 * turn command calls it in this slice, and no gate inside
 * PaymentsAgent (budget guard, facilitator verification,
 * idempotency) is touched.
 *
 * Batch B (#2349, G1) adds the TradingAgent and ReportAssetAgent
 * doors below, under the same discipline. Addressing is per-user:
 * each door resolves the ACTING user's own instance through the
 * fleet's one instance-name scheme per agent (tradingAgentName /
 * reportAssetAgentName — the bare "trading" / "default" instances
 * belong to the configured service identity alone, #1185).
 *
 * Batch B deliberately did NOT expose the TradingAgent approval
 * door: executeApprovedOrder, startTradeApproval, and
 * decideTradeApproval were not typed on the door stub, not called
 * by any door operation, and had no turn command. Batch B gave the
 * turn only the proposal side (the preview-only trade services,
 * whose result is a pending-approval proposal — never a placed
 * order) and the typed reads.
 *
 * Batch D (#2375, S9/G4) is the slice that crosses that boundary —
 * through the approval door itself, not around it. The door now
 * types startTradeApproval and decideTradeApproval, and exposes
 * three operations: start a TradingTradeWorkflow run behind the
 * door for an existing proposal, deliver the human's decision to
 * that run, and read the run's status from the TRADE_WORKFLOW
 * binding's own instance status (Trading has no D1 projection, and
 * no second tracker is invented here). The authorizer DID on a
 * decision is derived server-side from the acting login
 * (getUserDid) — it is never a caller-supplied field. The
 * synchronous settle (executeApprovedOrder) stays OFF the door:
 * it is called only by the workflow's settle step, inside the
 * agent that holds the draft store.
 *
 * Batch C (#2351, G1) adds the BrowserAgent and SlackAgent doors
 * below, under the same discipline. Addressing follows the A2A
 * resolution precedent (#2223, src/a2a/resolution.ts): both
 * classes are stateless/env-driven, so each door resolves the
 * fixed instance its A2A surface name denotes ("browser" /
 * "slack"). The SlackAgent door exposes only the class's two
 * outbound domain helpers; Slack ingress (the server forwarders
 * and the class's own gated onRequest) is S13/G10 and is not
 * touched, and the approval-ticket operation only POSTS the HITL
 * ticket — it approves and executes nothing.
 *
 * The webhookUrl policy (survey §2.8's open call, decided here):
 * a chat-turn caller may NOT supply a delivery webhook URL
 * through these doors. The stub option types carry no webhookUrl
 * field and the door operations build options field-by-field, so
 * no caller-supplied URL can reach the services; delivery goes
 * only where env configuration sends it (the services fall back
 * to env SLACK_WEBHOOK_URL, and with nothing configured they
 * return an honest not-delivered result, which the door
 * propagates verbatim). This is the same delivery-target
 * discipline the #2223 A2A doors already hold for these agents —
 * an arbitrary caller-chosen webhook would be an SSRF-shaped
 * surface, and no new allowlist is invented here.
 */

import type {
  Env,
  ETradeOrderDraft,
  TransactionSnapData,
  PreTradeApprovalDraft,
  BrowserAgentSnapResult,
  BrowserInspectResult,
} from "../../types";
import type { ScheduledGoal, ScheduleTick } from "../../schedule";
import {
  AGENTIC_SPEND_AGENT_ID,
  type PaymentRecord,
} from "../../payments/ledger";
import { tradingAgentName } from "../trading-agent";
import { getUserDid } from "../did";
import {
  reportAssetAgentName,
  type ReportAssetMeta,
} from "../report-asset-agent";
import { getServiceUserLogin } from "../../security/serviceIdentity";

// ---------------------------------------------------------------------------
// Errors — honest, typed, coded (doors-and-layers §11.1)
// ---------------------------------------------------------------------------

export type MeshDoorErrorCode =
  | "identity_required"
  | "door_unavailable"
  | "goal_not_found"
  | "asset_not_found"
  // Issue #2488: the mesh screen door's (meshScreenDoor.ts)
  // fail-closed refusal codes — budget_denied (the S5 budget
  // door refused the paid path), price_unavailable (no stored
  // catalogue price), checkout_email_required (no checkout
  // email source for a chat turn).
  | "budget_denied"
  | "price_unavailable"
  | "checkout_email_required"
  // Issue #2530: the screen door's dual-mode refusal codes —
  // nd_mode_unavailable (a non-deterministic run was requested
  // while SCREENER_ND_MODE is off; never a silent downgrade to
  // a deterministic screen), screen_intent_required (ND mode
  // without its intent, or an intent supplied without ND mode).
  | "nd_mode_unavailable"
  | "screen_intent_required";

export class MeshDoorError extends Error {
  readonly code: MeshDoorErrorCode;
  constructor(code: MeshDoorErrorCode, message: string) {
    super(message);
    this.name = "MeshDoorError";
    this.code = code;
  }
}

/**
 * The door's identity gate. Returns the trimmed acting login, or
 * throws identity_required — before the caller resolves any stub.
 */
export function requireActingLogin(
  actingLogin: string | undefined | null,
): string {
  const login = typeof actingLogin === "string" ? actingLogin.trim() : "";
  if (!login || login === "default") {
    throw new MeshDoorError(
      "identity_required",
      "This door requires the chat turn's acting identity (the signed-in user's login); " +
        "no identity was supplied, or the retired synthetic identity was presented. " +
        "Refusing before dispatch — identities are never defaulted.",
    );
  }
  return login;
}

// ---------------------------------------------------------------------------
// Typed stubs — the seam. Door-local interfaces over the agents'
// real RPC surfaces (the getScreenerAgent/getResearchAgent cast
// precedent); tests fake the namespace at this boundary.
// ---------------------------------------------------------------------------

export interface ScheduledAgentDoorStub {
  listGoals(): Promise<ScheduledGoal[]>;
  triggerGoal(id: string): Promise<ScheduleTick>;
}

export interface PaymentsAgentDoorStub {
  budgetCheck(req: {
    operation: string;
    amountCents: number;
    agentId: string;
  }): Promise<{ allowed: boolean; reason?: string }>;
  todaySpent(): Promise<number>;
  listPayments(limit?: number): Promise<PaymentRecord[]>;
  /** Typed for surface completeness; NOT called by any door
   *  operation in this slice (see the header: S10/G5 owns the chat
   *  paid-request flow). */
  processPaidRequest(req: {
    agentId: string;
    operation: string;
    amountCents: number;
    idempotencyKey: string;
    paymentProof: string;
  }): Promise<PaymentRecord>;
}

const SCHEDULED_AGENT_INSTANCE = "default";
const PAYMENTS_AGENT_INSTANCE = "default";

function resolveStub<T>(
  namespace: DurableObjectNamespace | undefined,
  instanceName: string,
  door: string,
): T {
  if (!namespace) {
    throw new MeshDoorError(
      "door_unavailable",
      `${door} is unavailable: its Durable Object binding is not configured in this deployment.`,
    );
  }
  return namespace.get(namespace.idFromName(instanceName)) as unknown as T;
}

export function getScheduledAgentDoor(env: Env): ScheduledAgentDoorStub {
  return resolveStub<ScheduledAgentDoorStub>(
    env.SCHEDULED_AGENT,
    SCHEDULED_AGENT_INSTANCE,
    "ScheduledAgent door",
  );
}

export function getPaymentsAgentDoor(env: Env): PaymentsAgentDoorStub {
  return resolveStub<PaymentsAgentDoorStub>(
    env.PAYMENTS_AGENT,
    PAYMENTS_AGENT_INSTANCE,
    "PaymentsAgent door",
  );
}

// ---------------------------------------------------------------------------
// ScheduledAgent door — list/inspect the goal catalogue, trigger one
// ---------------------------------------------------------------------------

export interface ScheduledGoalsDoorResult {
  goals: ScheduledGoal[];
}

/**
 * List the scheduled-goal catalogue, or inspect one goal when
 * goalId is given. The catalogue is the shared operator catalogue
 * the session-gated /api/schedule/* routes already expose to any
 * signed-in user (ScheduledGoal carries no owner field); the door
 * mirrors that authority for an identified chat user. An unknown
 * goalId is an honest goal_not_found error, never an empty success.
 */
export async function listScheduledGoalsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  goalId?: string,
): Promise<ScheduledGoalsDoorResult> {
  requireActingLogin(actingLogin);
  const door = getScheduledAgentDoor(env);
  const goals = await door.listGoals();
  if (goalId === undefined) return { goals };
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) {
    throw new MeshDoorError(
      "goal_not_found",
      `No scheduled goal with id "${goalId}" exists in the catalogue.`,
    );
  }
  return { goals: [goal] };
}

export interface ScheduledGoalTriggerDoorResult {
  goalId: string;
  tick: ScheduleTick;
}

/**
 * Trigger one goal now. The returned tick is ScheduledAgent's own
 * outcome, verbatim: a budget-denied or skipped firing surfaces in
 * tick.errors / jobsSkipped — the door never converts it into a
 * success shape.
 */
export async function triggerScheduledGoalViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  goalId: string,
): Promise<ScheduledGoalTriggerDoorResult> {
  requireActingLogin(actingLogin);
  const door = getScheduledAgentDoor(env);
  const tick = await door.triggerGoal(goalId);
  return { goalId, tick };
}

// ---------------------------------------------------------------------------
// PaymentsAgent door — budget check + the read side
// ---------------------------------------------------------------------------

export interface PaymentBudgetDoorResult {
  allowed: boolean;
  reason?: string;
  /** The spend bucket the check was evaluated against. */
  agentId: string;
  operation: string;
  amountCents: number;
}

/**
 * Ask PaymentsAgent whether the orchestrator spend bucket may
 * spend amountCents on operation. The guard's verdict propagates
 * as-is, denial reason included; the check records nothing (only
 * processPaidRequest records, after verification).
 */
export async function checkPaymentBudgetViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { operation: string; amountCents: number },
): Promise<PaymentBudgetDoorResult> {
  requireActingLogin(actingLogin);
  const door = getPaymentsAgentDoor(env);
  const verdict = await door.budgetCheck({
    operation: input.operation,
    amountCents: input.amountCents,
    agentId: AGENTIC_SPEND_AGENT_ID,
  });
  return {
    allowed: verdict.allowed,
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    agentId: AGENTIC_SPEND_AGENT_ID,
    operation: input.operation,
    amountCents: input.amountCents,
  };
}

export interface PaymentsOverviewDoorResult {
  todaySpentCents: number;
  recentPayments: PaymentRecord[];
}

/** The payments read side a turn may show: today's total spend and
 *  the most recent ledger payments, both read by PaymentsAgent from
 *  the ledger of record. */
export async function getPaymentsOverviewViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  limit = 10,
): Promise<PaymentsOverviewDoorResult> {
  requireActingLogin(actingLogin);
  const door = getPaymentsAgentDoor(env);
  const todaySpentCents = await door.todaySpent();
  const recentPayments = await door.listPayments(limit);
  return { todaySpentCents, recentPayments };
}

// ---------------------------------------------------------------------------
// TradingAgent door (#2349) — proposals + reads, per-user instance.
// The approval door is NOT part of this stub (see the header): the
// stub types only the proposal-side executeService and the typed
// read surface, so no door operation can reach trade execution.
// ---------------------------------------------------------------------------

/** The door-local shape of a TradingServiceCall: the fields the
 *  door supplies. The agent fills ORM/storage from its own
 *  instance handles (the executeService contract). */
export interface TradingServiceDoorCall {
  serviceId: string;
  input?: Record<string, unknown>;
  /** The acting identity, threaded at the call level — the agent
   *  executes under it. Never read from the service input. */
  userLogin: string;
}

/** The approval door's start result (TradingAgent.startTradeApproval). */
export interface TradeApprovalStartDoorResult {
  workflowId: string;
  orderId: string;
  status: "awaiting_approval";
}

/** The approval door's decision result (TradingAgent.decideTradeApproval). */
export interface TradeApprovalDecisionDoorResult {
  workflowId: string;
  delivered: true;
}

export interface TradingAgentDoorStub {
  executeService(call: TradingServiceDoorCall): Promise<unknown>;
  getAccounts(provider?: string): Promise<unknown>;
  getPositions(accountKey?: string, provider?: string): Promise<unknown>;
  getQuote(symbol: string, provider?: string): Promise<unknown>;
  /** #2375 (batch D): the approval door's workflow operations —
   *  start a TradingTradeWorkflow run for a previewed order, and
   *  deliver a decision to it. The synchronous settle
   *  (executeApprovedOrder) is deliberately NOT typed here: it is
   *  reached only by the workflow's own settle step. */
  startTradeApproval(input: {
    orderId: string;
    provider?: string;
    userLogin: string;
  }): Promise<TradeApprovalStartDoorResult>;
  decideTradeApproval(input: {
    workflowId: string;
    authorizerDid: string;
    decision: "approved" | "rejected";
    reason?: string;
  }): Promise<TradeApprovalDecisionDoorResult>;
}

export function getTradingAgentDoor(env: Env, actingLogin: string): TradingAgentDoorStub {
  return resolveStub<TradingAgentDoorStub>(
    env.TRADING_AGENT,
    tradingAgentName(actingLogin, getServiceUserLogin(env)),
    "TradingAgent door",
  );
}

export type TradeAction = "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
export type TradeOrderType = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";

export interface StockTradeProposalInput {
  symbol: string;
  action: TradeAction;
  quantity: number;
  orderType?: TradeOrderType;
  limitPrice?: number;
  stopPrice?: number;
  provider?: string;
}

export interface OptionsTradeLegInput {
  underlyingSymbol: string;
  securityType: "OPTN";
  side: "BUY" | "SELL";
  quantity: number;
  optionType?: "CALL" | "PUT";
  strike?: number;
  expirationDate?: string;
}

export interface OptionsTradeProposalInput extends StockTradeProposalInput {
  optionLegs: OptionsTradeLegInput[];
  strategyNetDebit?: number;
}

/**
 * The trade services' result envelope: a broker preview held as a
 * pending-approval proposal. `status` is the service's own value
 * ("pending_approval" for both trade services); the door returns
 * the envelope verbatim — it never converts a preview into
 * anything resembling an execution result.
 */
export interface TradeProposalDoorResult {
  status: string;
  proposal: ETradeOrderDraft;
  note?: string;
}

/**
 * Create a stock trade proposal through TradingAgent's
 * stock_trading service. Preview only: the service validates the
 * intent against the provider and returns the pending-approval
 * proposal; no order is placed (placement lives behind the
 * agent's approval door, which this door does not expose). The
 * acting identity is threaded as the call's userLogin; the
 * service input is built field-by-field and carries no identity
 * field of its own, so a caller can never smuggle a different
 * identity through the arguments. TradingServiceError tokens from
 * the agent propagate unchanged.
 */
export async function proposeStockTradeViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: StockTradeProposalInput,
): Promise<TradeProposalDoorResult> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  const serviceInput: Record<string, unknown> = {
    symbol: input.symbol,
    action: input.action,
    quantity: input.quantity,
  };
  if (input.orderType !== undefined) serviceInput.orderType = input.orderType;
  if (input.limitPrice !== undefined) serviceInput.limitPrice = input.limitPrice;
  if (input.stopPrice !== undefined) serviceInput.stopPrice = input.stopPrice;
  if (input.provider !== undefined) serviceInput.provider = input.provider;
  const result = await door.executeService({
    serviceId: "stock_trading",
    input: serviceInput,
    userLogin: login,
  });
  return result as TradeProposalDoorResult;
}

/**
 * Create an options trade proposal through TradingAgent's
 * options_trading service (single-leg or multi-leg via
 * optionLegs). Same discipline as the stock door: preview only,
 * call-level identity, field-by-field input.
 */
export async function proposeOptionsTradeViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: OptionsTradeProposalInput,
): Promise<TradeProposalDoorResult> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  const serviceInput: Record<string, unknown> = {
    symbol: input.symbol,
    action: input.action,
    quantity: input.quantity,
    optionLegs: input.optionLegs,
  };
  if (input.orderType !== undefined) serviceInput.orderType = input.orderType;
  if (input.limitPrice !== undefined) serviceInput.limitPrice = input.limitPrice;
  if (input.stopPrice !== undefined) serviceInput.stopPrice = input.stopPrice;
  if (input.strategyNetDebit !== undefined) serviceInput.strategyNetDebit = input.strategyNetDebit;
  if (input.provider !== undefined) serviceInput.provider = input.provider;
  const result = await door.executeService({
    serviceId: "options_trading",
    input: serviceInput,
    userLogin: login,
  });
  return result as TradeProposalDoorResult;
}

/** The acting user's broker accounts, read through their own
 *  TradingAgent instance (the platform resolves for the instance's
 *  user). The agent's result propagates verbatim. */
export async function getTradingAccountsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  provider?: string,
): Promise<unknown> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  return door.getAccounts(provider);
}

/** The acting user's broker positions (optionally for one
 *  account), read through their own TradingAgent instance. */
export async function getTradingPositionsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { accountKey?: string; provider?: string },
): Promise<unknown> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  return door.getPositions(input.accountKey, input.provider);
}

/** A quote for one symbol, read through the acting user's own
 *  TradingAgent instance. */
export async function getTradingQuoteViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { symbol: string; provider?: string },
): Promise<unknown> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  return door.getQuote(input.symbol, input.provider);
}

// ---------------------------------------------------------------------------
// TradingAgent approval door (#2375, batch D — S9/G4). A proposal
// created through the batch-B door is submitted to the agent's
// approval door, which starts the durable TradingTradeWorkflow run;
// the human's decision is delivered back through the same door; the
// run's status reads from the workflow binding's own surface.
// ---------------------------------------------------------------------------

/**
 * Submit an existing proposal (an orderId from propose_stock_trade /
 * propose_options_trade) to TradingAgent's approval door: the agent
 * starts a TradingTradeWorkflow run that waits for the decision
 * (up to the workflow's 24h timeout) and settles through the
 * agent's own draft store on an approved decision. The acting
 * identity is threaded as the run's userLogin — the run's owner is
 * the acting user, never the service identity. Places nothing:
 * starting the run only opens the approval wait.
 */
export async function startTradeApprovalViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { orderId: string; provider?: string },
): Promise<TradeApprovalStartDoorResult> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  return door.startTradeApproval({
    orderId: input.orderId,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    userLogin: login,
  });
}

/**
 * Deliver the human's decision to a running trade approval
 * workflow through TradingAgent's approval door. The authorizer DID
 * is derived here from the acting login (getUserDid — the same
 * derivation the platform stamps on the draft at preview); it is
 * never accepted from the caller, so a decision can only ever be
 * attributed to the signed-in user delivering it. An approved
 * decision makes the workflow settle the draft exactly once; a
 * rejected decision settles it as rejected and places nothing.
 */
export async function decideTradeApprovalViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { workflowId: string; decision: "approved" | "rejected"; reason?: string },
): Promise<TradeApprovalDecisionDoorResult> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  return door.decideTradeApproval({
    workflowId: input.workflowId,
    authorizerDid: getUserDid(login),
    decision: input.decision,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
}

/** The status read for one trade approval run: the workflow
 *  binding's own instance status, shaped without inventing a
 *  vocabulary — `status` is the binding's value verbatim, `output`
 *  carries the run's outcome once complete, `error` its message
 *  once errored. */
export interface TradeApprovalStatusDoorResult {
  workflowId: string;
  status: string;
  output?: unknown;
  error?: string;
}

/**
 * Read one trade approval run's status from the TRADE_WORKFLOW
 * binding. Trading writes no D1 projection (survey §3.1), so the
 * workflow's own status IS the status surface — no second tracker.
 * Identity gates first, as at every door; a missing binding is an
 * honest door_unavailable.
 */
export async function getTradeApprovalStatusViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { workflowId: string },
): Promise<TradeApprovalStatusDoorResult> {
  requireActingLogin(actingLogin);
  const binding = env.TRADE_WORKFLOW as unknown as
    | {
        get(id: string): {
          status(): Promise<{
            status: string;
            output?: unknown;
            error?: { name?: string; message?: string } | string;
          }>;
        };
      }
    | undefined;
  if (!binding) {
    throw new MeshDoorError(
      "door_unavailable",
      "Trade approval status is unavailable: the TRADE_WORKFLOW binding is not configured on this deployment.",
    );
  }
  const s = await binding.get(input.workflowId).status();
  return {
    workflowId: input.workflowId,
    status: s.status,
    ...(s.output !== undefined ? { output: s.output } : {}),
    ...(s.error !== undefined && s.error !== null
      ? {
          error:
            typeof s.error === "string"
              ? s.error
              : (s.error.message ?? s.error.name ?? "workflow error"),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// ReportAssetAgent door (#2349) — list + get, per-user instance.
// Replaces the turn's indirect reach through the report pipeline
// with a direct typed path to the agent that owns the assets.
// ---------------------------------------------------------------------------

export interface ReportAssetAgentDoorStub {
  listAssets(limit?: number): Promise<ReportAssetMeta[]>;
  getAsset(key: string): Promise<{ bytes: Uint8Array; fileName: string } | null>;
}

export function getReportAssetAgentDoor(env: Env, actingLogin: string): ReportAssetAgentDoorStub {
  return resolveStub<ReportAssetAgentDoorStub>(
    env.REPORT_ASSET_AGENT,
    reportAssetAgentName(actingLogin, getServiceUserLogin(env)),
    "ReportAssetAgent door",
  );
}

export interface ReportAssetsDoorResult {
  assets: ReportAssetMeta[];
}

/**
 * List the acting user's report assets (metadata only, newest
 * first) from their own ReportAssetAgent instance — the assets
 * the report pipeline generated for them. Assets generated under
 * the service identity (e.g. via the A2A door) live on the service
 * instance and are not the user's; they are listed only for a
 * turn acting as that identity.
 */
export async function listReportAssetsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  limit = 20,
): Promise<ReportAssetsDoorResult> {
  const login = requireActingLogin(actingLogin);
  const door = getReportAssetAgentDoor(env, login);
  const assets = await door.listAssets(limit);
  return { assets };
}

export interface ReportAssetDoorResult {
  key: string;
  fileName: string;
  byteLength: number;
  bytesBase64: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Fetch one of the acting user's report assets by key, shaped
 * exactly as the report-asset A2A door shapes it (reportAsset
 * A2A dispatch: key, fileName, byteLength, bytesBase64).
 * getAsset's null failure signal (no such key, or the store could
 * not be read) becomes an honest typed asset_not_found error —
 * never an empty success.
 */
export async function getReportAssetViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  key: string,
): Promise<ReportAssetDoorResult> {
  const login = requireActingLogin(actingLogin);
  const door = getReportAssetAgentDoor(env, login);
  const stored = await door.getAsset(key);
  if (!stored) {
    throw new MeshDoorError(
      "asset_not_found",
      `No report asset stored under key "${key}" for this user (or the asset store could not be read).`,
    );
  }
  return {
    key,
    fileName: stored.fileName,
    byteLength: stored.bytes.length,
    bytesBase64: bytesToBase64(stored.bytes),
  };
}

// ---------------------------------------------------------------------------
// BrowserAgent door (#2351) — transaction snap, page capture, table
// scrape. Fixed instance "browser" (A2A parity: the class is
// stateless, every method delegates to a service built from env,
// so any instance name behaves identically). Delivery options are
// typed WITHOUT a webhookUrl field — see the header's policy.
// ---------------------------------------------------------------------------

export interface BrowserAgentDoorStub {
  sendTransactionSnapToSlack(
    tx: TransactionSnapData,
    options: { channel?: string; caption?: string },
  ): Promise<BrowserAgentSnapResult>;
  capturePageSnapshot(
    url: string,
    options: { caption?: string; channel?: string },
  ): Promise<BrowserAgentSnapResult>;
  scrapeTables(url: string): Promise<BrowserInspectResult>;
}

const BROWSER_AGENT_INSTANCE = "browser";

export function getBrowserAgentDoor(env: Env): BrowserAgentDoorStub {
  return resolveStub<BrowserAgentDoorStub>(
    env.BROWSER_AGENT,
    BROWSER_AGENT_INSTANCE,
    "BrowserAgent door",
  );
}

/**
 * The door-local transaction shape: the TransactionSnapData
 * fields a chat caller may supply. The door builds the
 * TransactionSnapData field-by-field from it, so nothing else a
 * caller attaches (an identity field, a delivery URL) can travel
 * into the agent call.
 */
export interface TransactionSnapDoorInput {
  transactionId: string;
  symbol: string;
  action: string;
  quantity: number;
  status: string;
  price?: number;
  orderType?: string;
  totalValue?: number;
  environment?: string;
  accountKey?: string;
  commission?: number;
  timestamp?: string;
  humanApproved?: boolean;
  notes?: string;
  legs?: Array<{
    action: string;
    symbol: string;
    strike?: number;
    expiry?: string;
    type?: string;
  }>;
}

function buildTransactionSnap(input: TransactionSnapDoorInput): TransactionSnapData {
  const tx: TransactionSnapData = {
    transactionId: input.transactionId,
    symbol: input.symbol,
    action: input.action,
    quantity: input.quantity,
    status: input.status,
  };
  if (input.price !== undefined) tx.price = input.price;
  if (input.orderType !== undefined) tx.orderType = input.orderType;
  if (input.totalValue !== undefined) tx.totalValue = input.totalValue;
  if (input.environment !== undefined) tx.environment = input.environment;
  if (input.accountKey !== undefined) tx.accountKey = input.accountKey;
  if (input.commission !== undefined) tx.commission = input.commission;
  if (input.timestamp !== undefined) tx.timestamp = input.timestamp;
  if (input.humanApproved !== undefined) tx.humanApproved = input.humanApproved;
  if (input.notes !== undefined) tx.notes = input.notes;
  if (input.legs !== undefined) tx.legs = input.legs;
  return tx;
}

/**
 * Generate a transaction snap receipt and deliver it to the
 * configured Slack destination through BrowserAgent. The
 * agent's result propagates verbatim: a not-delivered outcome
 * (success: false with its reason) is the honest result, never
 * converted into a success shape.
 */
export async function sendTransactionSnapViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { transaction: TransactionSnapDoorInput; channel?: string; caption?: string },
): Promise<BrowserAgentSnapResult> {
  requireActingLogin(actingLogin);
  const door = getBrowserAgentDoor(env);
  const options: { channel?: string; caption?: string } = {};
  if (input.channel !== undefined) options.channel = input.channel;
  if (input.caption !== undefined) options.caption = input.caption;
  return door.sendTransactionSnapToSlack(buildTransactionSnap(input.transaction), options);
}

/**
 * Capture a rendered page snapshot through BrowserAgent and
 * deliver it to the configured Slack destination. Same
 * verbatim-result discipline as the transaction snap.
 */
export async function capturePageSnapshotViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { url: string; caption?: string; channel?: string },
): Promise<BrowserAgentSnapResult> {
  requireActingLogin(actingLogin);
  const door = getBrowserAgentDoor(env);
  const options: { caption?: string; channel?: string } = {};
  if (input.caption !== undefined) options.caption = input.caption;
  if (input.channel !== undefined) options.channel = input.channel;
  return door.capturePageSnapshot(input.url, options);
}

/**
 * Scrape structured DOM tables from a rendered page through
 * BrowserAgent. The inspect result propagates verbatim —
 * including its provenance labelling: when no real Browser
 * Rendering capture was available, the service marks the
 * screenshot "placeholder" (#120), and the door returns that
 * label untouched rather than presenting the image as a capture
 * of the page.
 */
export async function scrapePageTablesViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  url: string,
): Promise<BrowserInspectResult> {
  requireActingLogin(actingLogin);
  const door = getBrowserAgentDoor(env);
  return door.scrapeTables(url);
}

// ---------------------------------------------------------------------------
// SlackAgent door (#2351) — the class's two outbound domain
// helpers. Fixed instance "slack" (A2A parity). Slack ingress is
// NOT part of this door (S13/G10): nothing here parses Slack
// payloads, and the class's sessionKey fallback is untouched.
// ---------------------------------------------------------------------------

export interface SlackAgentDoorStub {
  sendPreTradeApprovalTicket(
    draft: PreTradeApprovalDraft,
    options: { channel?: string; threadTs?: string },
  ): Promise<{ success: boolean; payload: unknown; orderId: string }>;
  dispatchTransactionSnap(
    tx: TransactionSnapData,
    options: { channel?: string; caption?: string },
  ): Promise<BrowserAgentSnapResult>;
}

const SLACK_AGENT_INSTANCE = "slack";

export function getSlackAgentDoor(env: Env): SlackAgentDoorStub {
  return resolveStub<SlackAgentDoorStub>(
    env.SLACK_AGENT,
    SLACK_AGENT_INSTANCE,
    "SlackAgent door",
  );
}

/**
 * The door-local approval-draft shape: the PreTradeApprovalDraft
 * fields a chat caller may supply (its channel field is
 * deliberately not one of them — the delivery channel is a door
 * option, as on the A2A door). The door builds the draft
 * field-by-field, so no extra caller field travels.
 */
export interface PreTradeApprovalDraftDoorInput {
  orderId: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  orderType?: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  limitPrice?: number;
  estimatedPrice?: number | string;
  estimatedTotal?: number | string;
  commission?: number | string;
  proposerDid?: string;
  expiresAt?: string;
  notes?: string;
}

function buildPreTradeApprovalDraft(
  input: PreTradeApprovalDraftDoorInput,
): PreTradeApprovalDraft {
  const draft: PreTradeApprovalDraft = {
    orderId: input.orderId,
    symbol: input.symbol,
    action: input.action,
    quantity: input.quantity,
  };
  if (input.orderType !== undefined) draft.orderType = input.orderType;
  if (input.limitPrice !== undefined) draft.limitPrice = input.limitPrice;
  if (input.estimatedPrice !== undefined) draft.estimatedPrice = input.estimatedPrice;
  if (input.estimatedTotal !== undefined) draft.estimatedTotal = input.estimatedTotal;
  if (input.commission !== undefined) draft.commission = input.commission;
  if (input.proposerDid !== undefined) draft.proposerDid = input.proposerDid;
  if (input.expiresAt !== undefined) draft.expiresAt = input.expiresAt;
  if (input.notes !== undefined) draft.notes = input.notes;
  return draft;
}

/** The approval-ticket service result, as SlackAgent returns it. */
export interface PreTradeApprovalTicketDoorResult {
  success: boolean;
  payload: unknown;
  orderId: string;
}

/**
 * Post a pre-trade approval ticket (the strict HITL gate card)
 * to the configured Slack destination through SlackAgent. This
 * door only REQUESTS the human decision: it approves nothing
 * and executes nothing — the trade stays blocked until a human
 * authorizes it through the ticket's own flow. The service
 * result propagates verbatim.
 */
export async function sendPreTradeApprovalTicketViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { draft: PreTradeApprovalDraftDoorInput; channel?: string; threadTs?: string },
): Promise<PreTradeApprovalTicketDoorResult> {
  requireActingLogin(actingLogin);
  const door = getSlackAgentDoor(env);
  const options: { channel?: string; threadTs?: string } = {};
  if (input.channel !== undefined) options.channel = input.channel;
  if (input.threadTs !== undefined) options.threadTs = input.threadTs;
  return door.sendPreTradeApprovalTicket(buildPreTradeApprovalDraft(input.draft), options);
}

/**
 * Dispatch a transaction snap to the configured Slack
 * destination through SlackAgent (which coordinates BrowserAgent
 * for the receipt image; its delivery target likewise falls back
 * to env configuration inside the class). The agent's result
 * propagates verbatim.
 */
export async function dispatchTransactionSnapViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { transaction: TransactionSnapDoorInput; channel?: string; caption?: string },
): Promise<BrowserAgentSnapResult> {
  requireActingLogin(actingLogin);
  const door = getSlackAgentDoor(env);
  const options: { channel?: string; caption?: string } = {};
  if (input.channel !== undefined) options.channel = input.channel;
  if (input.caption !== undefined) options.caption = input.caption;
  return door.dispatchTransactionSnap(buildTransactionSnap(input.transaction), options);
}
