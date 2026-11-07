/**
 * Issue #2373 (Slice A) — the ONE paid-seam body for the manual
 * REST stock screens, shared by /etrade/screen (etradeBroker.ts)
 * and /market-data/screen + siblings (marketDataResearch.ts).
 *
 * The handlers own request parsing (including the checkout-email
 * strip below) and their route conditions; this module owns the
 * flag check, the payment-workflow submission, the audit, and
 * the payment_started response. It mirrors the goal route's paid
 * branch in screenerResearch.ts: the payment workflow
 * gate-checks (coverage first, including the #2547
 * price-approval state), consumes coverage, and starts the
 * screener itself when covered or paid — this seam never starts
 * a screener, and a payment-workflow start failure answers 503
 * with no run started. The synchronous direct path cannot carry
 * a payment workflow, so when the workflow path is inactive (no
 * async flag) the run is refused with 402 instead of silently
 * running free — the goal route's exact condition shape and
 * error code. No catalogue price is read here: the workflow
 * gate checks prices internally.
 *
 * Returns null when monetization is OFF: the caller then
 * proceeds with its broker-or-sync path, unchanged. Any other
 * return is the seam's response and the caller returns it
 * directly, before the async/sync fork. The `listings` branch
 * in etradeBroker.ts returns before spec building, so it never
 * reaches this seam (listings is not a screen run: audit-only,
 * persists nothing).
 */

import type { Env } from "../../types";
import type { StockScreenRunSpec } from "../../workflows/stockScreenRunSpec";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/paidStockScreenSeam",
});

/**
 * The checkout contact for the paid path only. POST bodies carry
 * it as `email`; it is stripped here — like `async` — so the
 * strict stock-screen schema never sees it. GET reads it from
 * the query. Required when monetization is ON; ignored when
 * it is OFF. Callers read it BEFORE building the spec.
 */
export function extractCheckoutEmail(
  method: string,
  filters: Record<string, unknown>,
  query: URLSearchParams,
): string {
  const email =
    method === "POST"
      ? (typeof filters.email === "string" ? filters.email.trim() : "")
      : (query.get("email") ?? "").trim();
  if (method === "POST") delete filters.email;
  return email;
}

export interface PaidStockScreenSeamArgs {
  env: Env;
  /** Session-verified login (x-user-login); client tenant ids are never read. */
  userLogin: string;
  checkoutEmail: string;
  spec: StockScreenRunSpec;
  /** E*TRADE passes its requested env; market-data passes none (broker parity). */
  environment?: "TEST" | "PROD";
  /** E*TRADE passes its settings reader; market-data passes none (broker parity). */
  readSettingRaw?: (key: string) => string | null;
  auditType:
    | "etrade.screen_payment_started"
    | "market_data.screener.payment_started";
  auditAgent: "trading" | "research";
  audit: (
    type:
      | "etrade.screen_payment_started"
      | "market_data.screener.payment_started",
    agent: "trading" | "research",
    payload: Record<string, unknown>,
  ) => void;
}

/**
 * Run the paid seam for one validated manual stock spec, or
 * return null when monetization is OFF (caller proceeds).
 */
export async function submitPaidStockScreenOrNull(
  args: PaidStockScreenSeamArgs,
): Promise<Response | null> {
  const monetizationOn = await (
    await import("../../features/createFeatureFlagPort")
  ).createFeatureFlagPort(args.env).isEnabled("monetization");
  if (!monetizationOn) return null;
  if (!args.spec.asyncRequested) {
    return Response.json(
      {
        error: "monetization_enabled_workflow_required",
        detail:
          "Monetization is on: stock screens must go through the payment workflow via async workflow submission (async: true) or the paid submission route.",
      },
      { status: 402 },
    );
  }
  if (!args.checkoutEmail) {
    return Response.json(
      { error: "email (checkout contact) is required when monetization is on." },
      { status: 400 },
    );
  }
  try {
    const { createCommercialAdapter, ensureCommercialSchema } =
      await import("../../data/createCommercialPorts");
    const { createSubscriptionAdapter, ensureSubscriptionSchema } =
      await import("../../data/createSubscriptionPorts");
    const { resolvePaidScreenAccount, buildPaidScreenSubmission } =
      await import("../../services/paidScreenSubmission");
    const { startPaymentWorkflowViaBinding } =
      await import("../../services/paymentWorkflowSubmission");
    const { buildStockScreenWorkflowCommand } =
      await import("../../workflows/screenExecutionBroker");
    const { workflowTenantId } =
      await import("../../workflows/screenerWorkflowRoutes");
    const commercial = createCommercialAdapter(args.env as { AGENT_DB?: unknown });
    const subscriptions = createSubscriptionAdapter(args.env as { AGENT_DB?: unknown });
    if (!commercial || !subscriptions) {
      return Response.json(
        { error: "Commercial account store is unavailable; no run started." },
        { status: 503 },
      );
    }
    await ensureCommercialSchema(commercial.db);
    await ensureSubscriptionSchema(subscriptions.db);
    const { account } = await resolvePaidScreenAccount(
      { commercial, subscriptions },
      { userId: args.userLogin, email: args.checkoutEmail, tenantId: workflowTenantId(args.env), nowMs: Date.now() },
    );
    // The command is the broker's one command (same inputs the
    // broker would pass: requested env + portfolio flag for
    // E*TRADE, neither for market-data); its jobId is the run
    // request id, so the payment workflow instance id IS the
    // run request id.
    let portfolioContext: boolean | undefined;
    if (args.readSettingRaw) {
      const { isPortfolioContextEnabled } =
        await import("../../services/screeningFlags");
      portfolioContext = isPortfolioContextEnabled(args.readSettingRaw);
    }
    const paidCommand = buildStockScreenWorkflowCommand(args.spec, {
      userLogin: args.userLogin,
      tenantId: workflowTenantId(args.env),
      ...(args.environment !== undefined ? { environment: args.environment } : {}),
      ...(portfolioContext !== undefined ? { portfolioContext } : {}),
    });
    const params = buildPaidScreenSubmission({
      runRequestId: paidCommand.jobId,
      family: "stock",
      trigger: "manual",
      tenantId: workflowTenantId(args.env),
      userId: args.userLogin,
      email: args.checkoutEmail,
      account,
      screenerCommand: paidCommand,
    });
    const started = await startPaymentWorkflowViaBinding(
      args.env.PAYMENT_WORKFLOW as unknown as
        | import("../../services/paymentWorkflowSubmission").PaymentWorkflowBinding
        | undefined,
      params,
    );
    args.audit(args.auditType, args.auditAgent, {
      principalKind: "session",
      jobId: paidCommand.jobId,
      trigger: "manual",
      workflowId: started.workflowId,
      universe: args.spec.universe,
    });
    return Response.json(
      { runRequestId: paidCommand.jobId, workflowId: started.workflowId, status: "payment_started" },
      { status: 202 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Tenant mismatch/.test(message)) {
      return Response.json({ error: message }, { status: 403 });
    }
    structuredLog.warn("paidStockScreenSeam.paid_start_failed", {
      message: `[paid-stock-screen-seam] Paid start failed: ${message}`,
      error: message,
    });
    return Response.json(
      { error: "Payment workflow could not start; no screener started." },
      { status: 503 },
    );
  }
}
