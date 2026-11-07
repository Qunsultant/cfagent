/**
 * Issue #2059: LIVE PaymentWorkflow assurance routes (no fake seams).
 * Issue #2197 (slice 4 of the native-payments program #2146,
 * stacked on #2195): the live-assurance checkout path is native.
 *
 * These routes test the live deployed PaymentWorkflow end-to-end
 * with test inputs. Unlike the browser simulation in
 * PaymentWorkflowAssurance.tsx (fake step/gate/screener), every
 * step here is real: a real workflow instance is created through
 * the PAYMENT_WORKFLOW binding, the real gate evaluates, real
 * approval/verified events are delivered through the binding, the
 * real native Stripe session is re-read, and a completed run
 * really starts ScreenerScreenWorkflow through the workflow port.
 *
 * What is "test" here is only the INPUT: run ids are
 * live-test-prefixed, the screener command carries environment
 * TEST, and the account is a synthetic test account (coverage or
 * pay-per-use). Nothing about the workflow, the binding, the
 * gate, or the screener start is simulated.
 *
 * Guards (all fail closed):
 * - payment_assurance flag must be ON (FeatureFlagPort).
 * - Caller identity comes from x-user-login / execution context,
 *   never from the request body.
 * - Live endpoints additionally require the caller login to be
 *   listed in PAYMENT_ASSURANCE_LIVE_LOGINS (comma-separated
 *   Worker var). Empty/missing = deny all. This endpoint can
 *   start real screener runs and mint real native checkouts, so
 *   it is never open to every signed-in user.
 * - Event/status/check-payment endpoints only accept
 *   live-test-prefixed workflow ids, so they can never poke a
 *   production workflow instance.
 * - Checkout mode additionally requires the monetization flag ON
 *   via the FeatureFlagPort (the gate's source — never the raw
 *   MONETIZATION_ENABLED env var, so assurance cannot disagree
 *   with production) AND a configured native Stripe card port
 *   (createCheckoutPorts, slice 1 #2195); otherwise it returns
 *   409 naming the missing piece instead of silently running the
 *   free path.
 * - Status/check-payment re-read NATIVE state only: a Stripe
 *   session retrieve through the card CheckoutPort. The cfpay
 *   checkout.status path is gone from this file (retired at
 *   slice 4, per design §3); no /a2a/payments call remains here.
 *   The x402 rail has no session to retrieve, so check-payment
 *   covers the card rail; an x402 proof is delivered through the
 *   /event endpoint instead.
 *
 * Handler shape follows the other route modules (payments.ts):
 * returns a Response when a path matches, null otherwise, and is
 * invoked from OrchestratorAgent.routeRequest in sequence.
 */

import { createFeatureFlagPort } from "../../features/createFeatureFlagPort";
import { buildScenario } from "../../services/goalScenarioEngine";
import { buildGoalScreenCommand } from "../../services/goalScreenWorkflowSubmission";
import type { CardSessionEvidence, CheckoutPorts } from "../../services/checkoutPorts";
import { createCheckoutPorts, type CheckoutEnv } from "../../services/createCheckoutPorts";
import type { CommercialAccount } from "../../services/cfpayMonetization";
import {
  buildPaymentWorkflowParams,
  deliverPaymentApprovalViaHost,
  deliverPaymentVerifiedViaHost,
  startPaymentWorkflowViaBinding,
  type PaymentWorkflowBinding,
  type PaymentWorkflowHost,
} from "../../services/paymentWorkflowSubmission";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/paymentAssuranceLive",
});

export interface PaymentAssuranceLiveContext {
  env: unknown;
  getUserLogin?: () => string | undefined;
  /**
   * Issue #2197: test seam for the checkout ports. When present
   * (including explicitly null = unconfigured), it wins over the
   * composition root; production call sites omit it and the route
   * builds the ports from Worker env via createCheckoutPorts.
   * This is never a silent production fallback: null means no
   * native Stripe, and checkout mode refuses with 409.
   */
  checkoutPorts?: CheckoutPorts | null;
}

type EnvRecord = Record<string, unknown>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envRecord(ctx: PaymentAssuranceLiveContext): EnvRecord {
  return (ctx.env ?? {}) as EnvRecord;
}

// CodeQL information-exposure follow-up: exception details never
// reach the caller. The real error is logged server-side (Workers
// Logs); responses carry a generic message only.
function logError(err: unknown): void {
  structuredLog.error("paymentAssuranceLive.error", {
    message: "[payment-assurance-live] error",
    error: err instanceof Error ? err.message : String(err),
  });
}

function callerLogin(request: Request, ctx: PaymentAssuranceLiveContext): string | null {
  const login = request.headers.get("x-user-login")?.trim() || ctx.getUserLogin?.()?.trim() || "";
  return login ? login : null;
}

function liveLogins(env: EnvRecord): string[] {
  const raw = env.PAYMENT_ASSURANCE_LIVE_LOGINS;
  if (typeof raw !== "string") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function guard(request: Request, ctx: PaymentAssuranceLiveContext): Promise<{ login: string } | Response> {
  const env = envRecord(ctx);
  const flagOn = await createFeatureFlagPort(ctx.env).isEnabled("payment_assurance");
  if (!flagOn) {
    return json({ error: "payment_assurance flag is OFF; live testing is disabled." }, 403);
  }
  const login = callerLogin(request, ctx);
  if (!login) {
    return json({ error: "Missing caller identity (x-user-login); refusing to start a live test run." }, 401);
  }
  if (!liveLogins(env).includes(login)) {
    return json({ error: `Live testing is not configured for this login. Ask the owner to add it to PAYMENT_ASSURANCE_LIVE_LOGINS.` }, 403);
  }
  return { login };
}

function testEmailFor(login: string): string {
  // Test-run marker address, never a real user's address. The
  // local part is sanitized so any login shape stays a valid
  // email format for checkout.create.
  const local = login.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "tester";
  return `${local}@assurance-test.local`;
}

/** Resolve the checkout ports: injected ports win in tests, otherwise the slice-1 composition root builds them from env. */
function resolveCheckoutPorts(ctx: PaymentAssuranceLiveContext): CheckoutPorts | null {
  if (ctx.checkoutPorts !== undefined) return ctx.checkoutPorts;
  return createCheckoutPorts(envRecord(ctx) as unknown as CheckoutEnv);
}

/**
 * The lookup key for a native session retrieve. An explicit
 * sessionId (or checkoutId) supplied by the caller wins — a real
 * Stripe session id is `cs_*`, not the run id. Otherwise the
 * live-test workflow id is used as the key: the assurance run id
 * is the checkout draftId (client_reference_id), so a port that
 * resolves by draftId answers for it, and the fulfilled test below
 * still binds the retrieved session back to this run.
 */
function sessionLookupKey(workflowId: string, record: Record<string, unknown> | null): string {
  const explicit = record?.sessionId ?? record?.checkoutId;
  return typeof explicit === "string" && explicit.trim() ? explicit.trim() : workflowId;
}

/**
 * The route-level fulfilled test, mirroring the native gate's
 * card rule as far as the route can see it: session complete AND
 * payment_status paid AND the session's client_reference_id bound
 * to this run. The gate re-applies its full rule (including the
 * amount match, which the route cannot check — it holds no price)
 * when the delivered payment_verified event reaches confirmPaid,
 * so this wake-up is never itself proof of payment.
 */
function isNativeFulfilled(evidence: CardSessionEvidence, workflowId: string): boolean {
  return (
    evidence.status.toLowerCase() === "complete" &&
    evidence.paymentStatus.toLowerCase() === "paid" &&
    evidence.clientReferenceId === workflowId
  );
}

function bindingFrom(env: EnvRecord): PaymentWorkflowBinding | undefined {
  const binding = env.PAYMENT_WORKFLOW as PaymentWorkflowBinding | undefined;
  return binding && typeof binding.create === "function" ? binding : undefined;
}

function bindingHost(binding: PaymentWorkflowBinding): PaymentWorkflowHost {
  return {
    runWorkflow: async (_bindingName: string, params: unknown) => {
      const started = await startPaymentWorkflowViaBinding(binding, params as never);
      return { id: started.workflowId };
    },
    sendWorkflowEvent: async (_bindingName: string, workflowId: string, event: { type: string; payload: unknown }) => {
      const instance = await binding.get(workflowId);
      if (!instance || typeof instance.sendEvent !== "function") {
        throw new Error(`Workflow binding cannot deliver events to instance ${workflowId}.`);
      }
      await instance.sendEvent(event);
    },
  };
}

function isLiveTestId(workflowId: unknown): workflowId is string {
  return typeof workflowId === "string" && workflowId.startsWith("live-test-");
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function handleStart(request: Request, ctx: PaymentAssuranceLiveContext, login: string): Promise<Response> {
  const env = envRecord(ctx);
  const body = await readBody(request);
  if (!body) return json({ error: "Request body must be a JSON object." }, 400);
  const mode = body.mode;
  if (mode !== "coverage" && mode !== "checkout") {
    return json({ error: "mode must be \"coverage\" or \"checkout\"." }, 400);
  }
  const scheduleKind = body.scheduleKind ?? "one_off";
  if (scheduleKind !== "one_off" && scheduleKind !== "recurring") {
    return json({ error: "scheduleKind must be \"one_off\" or \"recurring\"." }, 400);
  }
  const authorizedAtSubmission = body.authorizedAtSubmission === true;

  // Issue #2197: the flag comes from the FeatureFlagPort — the
  // gate's source — not the raw MONETIZATION_ENABLED env var, so
  // assurance cannot disagree with production (in a Flagship env
  // the dashboard value wins over any env var; in a non-Flagship
  // env the port's own legacy-var rule still applies).
  const monetizationEnabled = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
  const checkoutPorts = resolveCheckoutPorts(ctx);
  const nativeStripeConfigured = Boolean(checkoutPorts?.card);
  if (mode === "checkout") {
    if (!monetizationEnabled) {
      return json({ error: "Checkout-mode live test refused: the monetization flag is OFF (FeatureFlagPort)." }, 409);
    }
    if (!nativeStripeConfigured) {
      return json({ error: "Checkout-mode live test refused: native Stripe is not configured (no Stripe key for the card CheckoutPort in the deployed env)." }, 409);
    }
  }

  const runRequestId = `live-test-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tenantId = "primary";
  const email = testEmailFor(login);
  const account: CommercialAccount =
    mode === "coverage"
      ? { userId: login, email, tenantId, tier: "Subscribed", creditsUSD: 0, includedRunsRemaining: 1 }
      : { userId: login, email, tenantId, tier: "PayPerUse", creditsUSD: 0, includedRunsRemaining: 0 };
  const scenario = buildScenario({
    goalKind: "income",
    portfolioRef: { kind: "hypothetical" },
    direction: "bullish",
  });
  const screenerCommand = buildGoalScreenCommand({
    jobId: `goal-screen:live-test:${runRequestId}`,
    source: "payment-assurance-live",
    trigger: "scheduled",
    userLogin: login,
    tenantId,
    scenario,
    scenarioSource: "built",
    environment: "TEST",
  });
  const params = buildPaymentWorkflowParams({
    runRequestId,
    family: "goal",
    trigger: "scheduled",
    scheduleKind,
    authorizedAtSubmission,
    tenantId,
    userId: login,
    email,
    account,
    screenerCommand,
  });
  const binding = bindingFrom(env);
  if (!binding) {
    return json({ error: "PAYMENT_WORKFLOW binding is not configured; refusing to start a live test run." }, 503);
  }
  try {
    const started = await startPaymentWorkflowViaBinding(binding, params);
    structuredLog.info("paymentAssuranceLive.live_test_run_started", {
      message: `[payment-assurance-live] started run=${runRequestId} workflow=${started.workflowId} mode=${mode} login=${login}`,
      runRequestId,
      workflowId: started.workflowId,
      mode,
      login,
    });
    return json({
      workflowId: started.workflowId,
      runRequestId,
      screenerJobId: screenerCommand.jobId,
      mode,
      scheduleKind,
      authorizedAtSubmission,
      monetizationEnabled,
      nativeStripeConfigured,
      testAccountTier: account.tier,
    });
  } catch (err) {
    logError(err);
    return json({ error: "Internal error." }, 500);
  }
}

async function handleEvent(request: Request, ctx: PaymentAssuranceLiveContext, login: string): Promise<Response> {
  const env = envRecord(ctx);
  const body = await readBody(request);
  if (!body) return json({ error: "Request body must be a JSON object." }, 400);
  if (!isLiveTestId(body.workflowId)) {
    return json({ error: "Only live-test workflow ids can receive events through this endpoint." }, 403);
  }
  const binding = bindingFrom(env);
  if (!binding) return json({ error: "PAYMENT_WORKFLOW binding is not configured." }, 503);
  const host = bindingHost(binding);
  try {
    if (body.type === "approval") {
      if (typeof body.approved !== "boolean") {
        return json({ error: "approval events require a boolean \"approved\" field." }, 400);
      }
      await deliverPaymentApprovalViaHost(host, body.workflowId, {
        approved: body.approved,
        approverId: typeof body.approverId === "string" ? body.approverId : login,
      });
    } else if (body.type === "payment_verified") {
      await deliverPaymentVerifiedViaHost(host, body.workflowId, {
        claimTxHash: typeof body.claimTxHash === "string" ? body.claimTxHash : undefined,
        paymentIntentId: typeof body.paymentIntentId === "string" ? body.paymentIntentId : undefined,
      });
    } else {
      return json({ error: "type must be \"approval\" or \"payment_verified\"." }, 400);
    }
    structuredLog.info("paymentAssuranceLive.event_delivered", {
      message: `[payment-assurance-live] event type=${body.type} workflow=${body.workflowId} login=${login}`,
      type: body.type,
      workflowId: body.workflowId,
      login,
    });
    return json({ delivered: true, workflowId: body.workflowId, type: body.type });
  } catch (err) {
    logError(err);
    return json({ error: "Internal error." }, 500);
  }
}

async function handleStatus(_request: Request, url: URL, ctx: PaymentAssuranceLiveContext): Promise<Response> {
  const env = envRecord(ctx);
  const workflowId = url.searchParams.get("workflowId");
  if (!isLiveTestId(workflowId)) {
    return json({ error: "Only live-test workflow ids can be queried through this endpoint." }, 403);
  }
  const binding = bindingFrom(env);
  let instanceStatus: unknown = "unknown";
  if (binding) {
    try {
      const instance = await binding.get(workflowId);
      const statusFn = (instance as { status?: unknown }).status;
      if (typeof statusFn === "function") {
        const result: unknown = await (statusFn as () => Promise<unknown>).call(instance);
        instanceStatus =
          typeof result === "string"
            ? result
            : result && typeof result === "object" && typeof (result as { status?: unknown }).status === "string"
              ? (result as { status: string }).status
              : result ?? "unknown";
      }
    } catch {
      instanceStatus = "unknown";
    }
  }
  // Issue #2197: native state only — a Stripe session retrieve
  // through the card CheckoutPort. No card port means no native
  // state to report, so checkout stays null (same shape as the
  // old no-cfpay case); a retrieve failure is reported as an
  // error object, never thrown to the caller.
  let checkout: unknown = null;
  const card = resolveCheckoutPorts(ctx)?.card ?? null;
  if (card) {
    try {
      checkout = await card.retrieveCardSession({
        sessionId: sessionLookupKey(workflowId, {
          sessionId: url.searchParams.get("sessionId"),
          // Retrieve-by-reference parity with check-payment: a
          // stored checkoutId (the card checkout join key) is an
          // explicit lookup key here too, not just sessionId.
          checkoutId: url.searchParams.get("checkoutId"),
        }),
      });
    } catch (err) {
      logError(err);
      checkout = { error: "Stripe session retrieve failed" };
    }
  }
  return json({ workflowId, instanceStatus, checkout });
}

async function handleCheckPayment(request: Request, ctx: PaymentAssuranceLiveContext): Promise<Response> {
  const env = envRecord(ctx);
  const body = await readBody(request);
  if (!body) return json({ error: "Request body must be a JSON object." }, 400);
  if (!isLiveTestId(body.workflowId)) {
    return json({ error: "Only live-test workflow ids can be checked through this endpoint." }, 403);
  }
  // Issue #2197: native state only — the card CheckoutPort's
  // session retrieve replaces cfpay checkout.status. No card port
  // refuses instead of faking fulfillment.
  const card = resolveCheckoutPorts(ctx)?.card ?? null;
  if (!card) {
    return json({ error: "Native Stripe is not configured in the deployed env; cannot re-read checkout status." }, 409);
  }
  const binding = bindingFrom(env);
  if (!binding) return json({ error: "PAYMENT_WORKFLOW binding is not configured." }, 503);
  let evidence: CardSessionEvidence | null = null;
  try {
    evidence = await card.retrieveCardSession({
      sessionId: sessionLookupKey(body.workflowId as string, body),
    });
  } catch (err) {
    logError(err);
    return json({ delivered: false, checkout: { error: "Stripe session retrieve failed" } });
  }
  // Mirror the native gate's card rule as far as the route can see
  // it (complete + paid + reference bound to this run). Anything
  // else delivers nothing — the wake-up event is never sent for
  // an unfulfilled or mis-bound session.
  if (!evidence || !isNativeFulfilled(evidence, body.workflowId as string)) {
    return json({ delivered: false, checkout: evidence, reason: "Checkout session is not fulfilled for this run; no payment_verified event was delivered." });
  }
  try {
    await deliverPaymentVerifiedViaHost(bindingHost(binding), body.workflowId, {
      paymentIntentId: evidence.paymentIntentId,
    });
    return json({ delivered: true, workflowId: body.workflowId, checkout: evidence });
  } catch (err) {
    logError(err);
    return json({ error: "Internal error." }, 500);
  }
}

export async function handlePaymentAssuranceLiveRoutes(
  request: Request,
  url: URL,
  path: string,
  _sessionId: string | undefined,
  ctx: PaymentAssuranceLiveContext,
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  if (method === "POST" && path.endsWith("/api/assurance/payment-workflow/start")) {
    const guarded = await guard(request, ctx);
    if (guarded instanceof Response) return guarded;
    return handleStart(request, ctx, guarded.login);
  }
  if (method === "POST" && path.endsWith("/api/assurance/payment-workflow/event")) {
    const guarded = await guard(request, ctx);
    if (guarded instanceof Response) return guarded;
    return handleEvent(request, ctx, guarded.login);
  }
  if (method === "GET" && path.endsWith("/api/assurance/payment-workflow/status")) {
    const guarded = await guard(request, ctx);
    if (guarded instanceof Response) return guarded;
    return handleStatus(request, url, ctx);
  }
  if (method === "POST" && path.endsWith("/api/assurance/payment-workflow/check-payment")) {
    const guarded = await guard(request, ctx);
    if (guarded instanceof Response) return guarded;
    return handleCheckPayment(request, ctx);
  }
  return null;
}
