/**
 * Issue #2041 S4 — saga entry route (gaps G-ENTRY-ROUTE, Q7).
 *
 * POST /api/saga/start starts a SAGA_WORKFLOW instance. Leg 0
 * remains the flow's payment child via the leg port: a route
 * that started PaymentWorkflow directly would be a paid screen,
 * not a saga. The route mirrors the paid-screen route's
 * discipline (resolvePaidScreenAccount + buildGoalScreenCommand
 * shape + monetization-flag gate) but creates the SAGA instance
 * instead of a payment instance.
 *
 * Adoption is a reviewed wiring step: the route stays behind
 * the monetization flag, fail-closed, flag OFF by default — it
 * must not run in prod unreviewed. The instance id MUST be
 * sagaWorkflowInstanceId(sagaId) (the S2 delivery contract):
 * delivery resolves instances by that id, and any other id
 * would orphan the gate prompts.
 *
 * The response carries the pre-payment disclosure (S3 leftover,
 * wired here): the same single source the flow records on its
 * saga.started row — one function, two surfaces, no copy drift.
 * The route never consults refund deps: Q10 execution stays
 * operator-only, and no saga refund execution is built here.
 */
import type { Env } from "../../types";
import { createFeatureFlagPort } from "../../features/createFeatureFlagPort";
import { createCommercialAdapter } from "../../data/createCommercialPorts";
import { createSubscriptionAdapter } from "../../data/createSubscriptionPorts";
import { createShardJobAdapter } from "../../data/createShardJobPorts";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import {
  resolvePaidScreenAccount,
  type PaidScreenStorePorts,
} from "../../services/paidScreenSubmission";
import type { NativeCommercialAccount } from "../../services/nativeMonetization";
import { sagaCompensationDisclosure } from "../../workflows/sagaCompensation";
import { sagaWorkflowInstanceId } from "../../workflows/sagaJourneyGate";
import type { SagaTradeIntent } from "../../workflows/sagaTradeLeg";
import type { SagaParams } from "../../workflows/sagaWorkflowFlow";
import type { WorkflowJobCommand } from "../../workflows/workflowPorts";
import {
  recordSagaProjectionRow,
  type SagaStatusStore,
} from "./sagaStatus";

/** Minimal structural surface of the SAGA_WORKFLOW binding. */
export interface SagaEntryBinding {
  create: (opts: { id: string; params: unknown }) => Promise<{ id: string }>;
  get: (id: string) => Promise<{
    status: () => Promise<{ status: string; output?: unknown }>;
  }>;
}

export interface SagaEntryInput {
  sagaId: string;
  runRequestId: string;
  screenerCommand: WorkflowJobCommand;
  tradeIntent: SagaTradeIntent;
  email: string;
  rail?: "stripe" | "x402";
  trigger: "manual" | "scheduled";
  scheduleKind?: SagaParams["scheduleKind"];
  authorizedAtSubmission?: boolean;
}

export class SagaEntryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function bad(message: string): SagaEntryError {
  return new SagaEntryError(400, message);
}

/**
 * Validate the entry body. Fail-closed throughout: a missing or
 * mismatched identity, a missing trade intent, or a non-goal
 * family is a 400, never a defaulted value. The saga never
 * invents a trade: an options intent without legs is rejected
 * here, before any instance exists.
 */
export function validateSagaEntryBody(
  body: unknown,
  sessionLogin: string,
): SagaEntryInput {
  if (!isRecord(body)) throw bad("Saga entry body must be a JSON object.");
  const sagaId =
    typeof body["sagaId"] === "string" && body["sagaId"]
      ? (body["sagaId"] as string)
      : `saga-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const runRequestId =
    typeof body["runRequestId"] === "string" && body["runRequestId"]
      ? (body["runRequestId"] as string)
      : sagaId;
  const screenerCommand = body["screenerCommand"];
  if (!isRecord(screenerCommand)) throw bad("screenerCommand is required.");
  if (
    typeof screenerCommand["jobId"] !== "string" ||
    !screenerCommand["jobId"]
  ) {
    throw bad("screenerCommand.jobId is required.");
  }
  if (screenerCommand["userLogin"] !== sessionLogin) {
    throw bad("screenerCommand.userLogin must equal the session login.");
  }
  const tradeIntent = body["tradeIntent"];
  if (!isRecord(tradeIntent)) throw bad("tradeIntent is required.");
  if (tradeIntent["kind"] !== "stock" && tradeIntent["kind"] !== "options") {
    throw bad("tradeIntent.kind must be stock or options.");
  }
  if (typeof tradeIntent["symbol"] !== "string" || !tradeIntent["symbol"]) {
    throw bad("tradeIntent.symbol is required.");
  }
  if (tradeIntent["action"] !== "buy" && tradeIntent["action"] !== "sell") {
    throw bad("tradeIntent.action must be buy or sell.");
  }
  if (
    typeof tradeIntent["quantity"] !== "number" ||
    !(tradeIntent["quantity"] as number > 0)
  ) {
    throw bad("tradeIntent.quantity must be a positive number.");
  }
  if (tradeIntent["kind"] === "options") {
    const legs = tradeIntent["optionLegs"];
    if (!Array.isArray(legs) || legs.length < 1) {
      throw bad("tradeIntent.optionLegs must have at least one leg for options.");
    }
  }
  if (
    body["family"] !== undefined &&
    body["family"] !== "goal"
  ) {
    throw bad("Saga is goal-only (Q5 default); family must be goal.");
  }
  if (typeof body["email"] !== "string" || !body["email"]) {
    throw bad("email is required.");
  }
  if (
    body["rail"] !== undefined &&
    body["rail"] !== "stripe" &&
    body["rail"] !== "x402"
  ) {
    throw bad("rail must be stripe or x402.");
  }
  if (
    body["trigger"] !== undefined &&
    body["trigger"] !== "manual" &&
    body["trigger"] !== "scheduled"
  ) {
    throw bad("trigger must be manual or scheduled.");
  }
  return {
    sagaId,
    runRequestId,
    screenerCommand: screenerCommand as unknown as WorkflowJobCommand,
    tradeIntent: tradeIntent as unknown as SagaTradeIntent,
    email: body["email"] as string,
    ...(body["rail"] === "stripe" || body["rail"] === "x402"
      ? { rail: body["rail"] }
      : {}),
    trigger:
      body["trigger"] === "scheduled" ? "scheduled" : "manual",
    ...(typeof body["scheduleKind"] === "string"
      ? { scheduleKind: body["scheduleKind"] as SagaParams["scheduleKind"] }
      : {}),
    ...(typeof body["authorizedAtSubmission"] === "boolean"
      ? { authorizedAtSubmission: body["authorizedAtSubmission"] }
      : {}),
  };
}

/** Build the saga params from a validated entry + verified account. */
export function buildSagaEntryParams(
  input: SagaEntryInput,
  account: NativeCommercialAccount,
  tenantId: string,
): SagaParams {
  return {
    sagaId: input.sagaId,
    runRequestId: input.runRequestId,
    userLogin: input.screenerCommand.userLogin,
    userId: account.userId,
    email: input.email,
    tenantId,
    family: "goal",
    trigger: input.trigger,
    scheduleKind: input.scheduleKind,
    authorizedAtSubmission: input.authorizedAtSubmission,
    account,
    screenerCommand: input.screenerCommand,
    ...(input.rail ? { rail: input.rail } : {}),
    tradeIntent: input.tradeIntent,
  };
}

/**
 * Create-or-adopt under the S2 contract id (mirroring the
 * payment seam's create-failure → get+status → adopt): a create
 * failure with a readable instance adopts it; anything else
 * rethrows the original create error.
 */
export async function startSagaViaBinding(
  binding: SagaEntryBinding,
  params: SagaParams,
): Promise<{ workflowId: string; existing: boolean }> {
  const id = sagaWorkflowInstanceId(params.sagaId);
  try {
    const created = await binding.create({ id, params });
    return { workflowId: created.id, existing: false };
  } catch (createErr) {
    try {
      await binding.get(id).then((inst) => inst.status());
      return { workflowId: id, existing: true };
    } catch {
      throw createErr;
    }
  }
}

export interface SagaEntryOverrides {
  sagaBinding?: SagaEntryBinding;
  commercial?: PaidScreenStorePorts["commercial"];
  subscriptions?: PaidScreenStorePorts["subscriptions"];
  projectionStore?: SagaStatusStore;
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

/**
 * POST /api/saga/start. Returns null for non-matching paths.
 * Order: 401 (no session) → 403 (flag OFF) → 400 (validation)
 * → 503 (adapters/binding) → 202 (created/adopted). The
 * projection row is best-effort visibility-only: a failed or
 * unbound store warns and never fails the saga start (the
 * saga.started audit row is the durable record).
 */
export async function handleSagaEntryRoutes(
  request: Request,
  _url: URL,
  path: string,
  env: Env,
  sessionLogin: string | null,
  overrides?: SagaEntryOverrides,
): Promise<Response | null> {
  if (path !== "/api/saga/start" || request.method !== "POST") return null;
  if (!sessionLogin) {
    return json(401, { error: "unauthorized" });
  }
  const monetizationOn = await createFeatureFlagPort(env).isEnabled(
    "monetization",
  );
  if (!monetizationOn) {
    return json(403, {
      error: "saga entry is behind the monetization flag (reviewed wiring; flag OFF).",
    });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Saga entry body must be valid JSON." });
  }
  let input: SagaEntryInput;
  try {
    input = validateSagaEntryBody(body, sessionLogin);
  } catch (err) {
    if (err instanceof SagaEntryError) {
      return json(err.status, { error: err.message });
    }
    throw err;
  }
  const tenantId = resolveIaaaTenant(env);
  const commercial =
    overrides?.commercial ?? createCommercialAdapter(env);
  const subscriptions =
    overrides?.subscriptions ?? createSubscriptionAdapter(env);
  if (!commercial || !subscriptions) {
    return json(503, { error: "Commercial account store is unavailable." });
  }
  let account: NativeCommercialAccount;
  try {
    ({ account } = await resolvePaidScreenAccount(
      { commercial, subscriptions },
      {
        userId: sessionLogin,
        email: input.email,
        tenantId,
        nowMs: Date.now(),
      },
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Tenant mismatch")) {
      return json(403, { error: message });
    }
    return json(503, { error: message });
  }
  const params = buildSagaEntryParams(input, account, tenantId);
  const binding =
    overrides?.sagaBinding ??
    (env["SAGA_WORKFLOW"] as SagaEntryBinding | undefined);
  if (
    !binding ||
    typeof binding.create !== "function" ||
    typeof binding.get !== "function"
  ) {
    return json(503, { error: "SAGA_WORKFLOW binding is not bound." });
  }
  let started: { workflowId: string; existing: boolean };
  try {
    started = await startSagaViaBinding(binding, params);
  } catch (err) {
    return json(503, {
      error: `Saga start failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  const statusUrl = `/api/saga/${params.sagaId}/status`;
  const store =
    overrides?.projectionStore ?? createShardJobAdapter(env);
  if (store) {
    try {
      await recordSagaProjectionRow(store, {
        sagaId: params.sagaId,
        runRequestId: params.runRequestId,
        tenantId,
        statusUrl,
      });
    } catch (err) {
      console.warn(
        `Saga projection row failed for ${params.sagaId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return json(202, {
    sagaId: params.sagaId,
    runRequestId: params.runRequestId,
    workflowId: started.workflowId,
    existing: started.existing,
    statusUrl,
    disclosure: sagaCompensationDisclosure(params.rail),
  });
}
