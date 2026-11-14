/**
 * Issue #2373 (Slice A) — the ONE paid-seam body for the manual
 * REST stock screens, shared by /etrade/screen (etradeBroker.ts)
 * and /market-data/screen + siblings (marketDataResearch.ts).
 *
 * The handlers own request parsing (including the checkout-email
 * strip below) and their route conditions; this module owns the
 * flag check, the provider-mismatch refusal, the gate-before-
 * email decision, the payment-workflow submission, the audit,
 * and the payment_started response. It mirrors the goal route's
 * paid branch in screenerResearch.ts: the payment workflow
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
 * Issue #2373 (S1b, gate-before-email) — the order is the fix:
 * the gate decides coverage FIRST, before any checkout email is
 * demanded. A covered run (free-run allowance, approved grant,
 * ...) starts with NO email; a run refused at the approved-free
 * quota cap answers the gate's 402 directly, also with no email
 * demanded; only when the gate says payment is actually needed
 * is a checkout email demanded (400, code
 * checkout_email_required), then the payment workflow. The
 * coverage probe is read-only — the workflow's own check()
 * remains the single consuming decision, so a probe/workflow
 * race can only resolve to refusal or checkout, never to an
 * uncounted run. The provider check (F9) runs before the gate:
 * the route's implied provider must match the tenant's stored
 * data-provider selection, or the run is refused with a coded
 * 409 and no fallback provider is used.
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
 * the query. Issue #2373 (S1b, gate-before-email): it is
 * demanded only when the gate says payment is actually needed —
 * a covered run carries none, and the seam starts it with an
 * empty email. Ignored when monetization is OFF. Callers read
 * it BEFORE building the spec.
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
  // Issue #2373 (S1b, gate-before-email) — the checkout email is
  // NOT checked here any more. The gate decides coverage first
  // (below); the email is demanded only when the gate says
  // payment is actually needed.
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
    const {
      resolveTenantDataProviderSelection,
      resolveTenantBrokerSelection,
      providerMismatchResponse,
    } = await import("../../services/tenantProviders");
    const commercial = createCommercialAdapter(args.env as { AGENT_DB?: unknown });
    const subscriptions = createSubscriptionAdapter(args.env as { AGENT_DB?: unknown });
    if (!commercial || !subscriptions) {
      // Coverage is unprovable without the stores, so a no-email
      // run is refused with the contact 400 — exactly today's
      // behaviour — and an email run keeps today's 503.
      if (!args.checkoutEmail) {
        return Response.json(
          {
            error: "email (checkout contact) is required when monetization is on.",
            code: "checkout_email_required",
          },
          { status: 400 },
        );
      }
      return Response.json(
        { error: "Commercial account store is unavailable; no run started." },
        { status: 503 },
      );
    }
    await ensureCommercialSchema(commercial.db);
    await ensureSubscriptionSchema(subscriptions.db);
    const tenantId = workflowTenantId(args.env);
    // Issue #2373 (S1b, F9) — the provider check runs BEFORE the
    // gate: the route's implied provider must match the tenant's
    // stored data-provider selection, or the run is refused with
    // a coded 409 and no fallback provider is used. An
    // unconfigured tenant (no selection stored) passes: the
    // implied provider is the run's provider.
    const impliedProvider = args.spec.provider ?? "etrade";
    const selectedProvider = await resolveTenantDataProviderSelection(args.env);
    if (selectedProvider !== null && selectedProvider !== impliedProvider) {
      return providerMismatchResponse(impliedProvider, selectedProvider);
    }
    const { account } = await resolvePaidScreenAccount(
      { commercial, subscriptions },
      { userId: args.userLogin, email: args.checkoutEmail, tenantId, nowMs: Date.now() },
    );
    // Issue #2373 (S1b, gate-before-email) — the gate decides
    // coverage BEFORE any checkout email is demanded, and only
    // for a run that carries none. A covered run falls through
    // to the workflow with an empty email; a run refused at the
    // approved-free quota cap answers the gate's 402 directly,
    // with no email demanded either; only when the gate says
    // payment is actually needed is the email demanded (400).
    // The probe is read-only: the workflow's own check()
    // remains the single consuming decision.
    if (!args.checkoutEmail) {
      const probe = await probePaidScreenCoverage(args.env, account);
      if (probe.refusedAtLimit) {
        return Response.json(
          {
            error: probe.reason,
            code: probe.outcomeCode,
            status: "approved_free_quota_exhausted",
            ...(probe.nextStep !== undefined ? { nextStep: probe.nextStep } : {}),
          },
          { status: 402 },
        );
      }
      if (!probe.covered) {
        return Response.json(
          {
            error: "email (checkout contact) is required when monetization is on.",
            code: "checkout_email_required",
          },
          { status: 400 },
        );
      }
    }
    // The command is the broker's one command (same inputs the
    // broker would pass: requested env + portfolio flag for
    // E*TRADE, neither for market-data); its jobId is the run
    // request id, so the payment workflow instance id IS the
    // run request id. Issue #2373 (S1b, F9): the tenant-resolved
    // provider is stamped explicitly (the mismatch check above
    // already proved it equals any stored selection), and the
    // stored broker rides as provenance only when one is stored
    // — never a defaulted broker.
    let portfolioContext: boolean | undefined;
    if (args.readSettingRaw) {
      const { isPortfolioContextEnabled } =
        await import("../../services/screeningFlags");
      portfolioContext = isPortfolioContextEnabled(args.readSettingRaw);
    }
    const storedBroker = await resolveTenantBrokerSelection(args.env);
    const paidCommand = buildStockScreenWorkflowCommand(args.spec, {
      userLogin: args.userLogin,
      tenantId,
      provider: impliedProvider,
      ...(storedBroker !== null ? { brokerId: storedBroker } : {}),
      ...(args.environment !== undefined ? { environment: args.environment } : {}),
      ...(portfolioContext !== undefined ? { portfolioContext } : {}),
    });
    const params = buildPaidScreenSubmission({
      runRequestId: paidCommand.jobId,
      family: "stock",
      trigger: "manual",
      tenantId,
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

/**
 * Issue #2373 (S1b, gate-before-email) — the read-only coverage
 * probe for a no-email run: would the gate cover this run
 * without minting a checkout? Wires the probe's stores the same
 * way the payment workflow wires the gate's (best-effort, like
 * the workflow: an adapter that cannot be ensured reads as
 * absent, so the probe reports that branch unavailable and the
 * seam demands the email — a wiring failure never grants a
 * free run and never fails the run). Checkout ports are NOT
 * wired: the probe never mints, so checkout is null.
 */
async function probePaidScreenCoverage(
  env: Env,
  account: import("../../services/cfpayMonetization").CommercialAccount,
): Promise<import("../../services/nativeMonetization").CoverageProbeResult> {
  const { NativeMonetizationGate } = await import("../../services/nativeMonetization");
  const { createPriceCatalogueAdapter, ensurePriceCatalogueSchema } =
    await import("../../data/createPriceCataloguePorts");
  const { createFreeRunCounterAdapter, ensureFreeRunCounterSchema } =
    await import("../../data/createFreeRunCounterPorts");
  const { createApprovedFreeQuotaAdapter } = await import("../../data/createApprovedFreeQuotaPorts");
  const { createRunsPackAdapters, ensureRunsPackSchema } = await import("../../data/createRunsPackPorts");
  const { createReferralCodeAdapters, ensureReferralCodeSchema } =
    await import("../../data/createReferralCodePorts");
  const dbEnv = env as { AGENT_DB?: unknown };
  let priceCatalogue: ReturnType<typeof createPriceCatalogueAdapter> = null;
  try {
    priceCatalogue = createPriceCatalogueAdapter(dbEnv);
    if (priceCatalogue) await ensurePriceCatalogueSchema(priceCatalogue.db);
  } catch (err) {
    structuredLog.warn("paidStockScreenSeam.probe_price_catalogue_unavailable", {
      message: "[paid-stock-screen-seam] Price catalogue unavailable for coverage probe; priced branches read as unavailable.",
      error: err instanceof Error ? err.message : String(err),
    });
    priceCatalogue = null;
  }
  let freeRunCounter: ReturnType<typeof createFreeRunCounterAdapter> = null;
  try {
    const counter = createFreeRunCounterAdapter(dbEnv);
    if (counter) {
      await ensureFreeRunCounterSchema(counter.db);
      freeRunCounter = counter;
    }
  } catch (err) {
    structuredLog.warn("paidStockScreenSeam.probe_free_run_counter_unavailable", {
      message: "[paid-stock-screen-seam] Free-run counter unavailable for coverage probe; allowance reads as unavailable.",
      error: err instanceof Error ? err.message : String(err),
    });
    freeRunCounter = null;
  }
  let approvedFreeQuota: ReturnType<typeof createApprovedFreeQuotaAdapter> = null;
  try {
    const quota = createApprovedFreeQuotaAdapter(dbEnv);
    if (quota) {
      await quota.ensureSchema();
      approvedFreeQuota = quota;
    }
  } catch (err) {
    structuredLog.warn("paidStockScreenSeam.probe_approved_free_quota_unavailable", {
      message: "[paid-stock-screen-seam] Approved-free quota unavailable for coverage probe; grant quota reads as unavailable.",
      error: err instanceof Error ? err.message : String(err),
    });
    approvedFreeQuota = null;
  }
  let runsPackBalance: import("../../data/runsPackPorts").RunsPackBalancePort | null = null;
  try {
    const packs = createRunsPackAdapters(dbEnv);
    if (packs) {
      await ensureRunsPackSchema(packs.balance.db);
      runsPackBalance = packs.balance;
    }
  } catch (err) {
    structuredLog.warn("paidStockScreenSeam.probe_runs_pack_unavailable", {
      message: "[paid-stock-screen-seam] Runs-pack balance unavailable for coverage probe; pack reads as empty.",
      error: err instanceof Error ? err.message : String(err),
    });
    runsPackBalance = null;
  }
  let codeRunsBalance: import("../../data/referralCodePorts").CodeRunsBalancePort | null = null;
  try {
    const codes = createReferralCodeAdapters(dbEnv);
    if (codes) {
      await ensureReferralCodeSchema(codes.rules.db);
      codeRunsBalance = codes.balances;
    }
  } catch (err) {
    structuredLog.warn("paidStockScreenSeam.probe_code_runs_unavailable", {
      message: "[paid-stock-screen-seam] Code-runs balance unavailable for coverage probe; code balance reads as empty.",
      error: err instanceof Error ? err.message : String(err),
    });
    codeRunsBalance = null;
  }
  const gate = new NativeMonetizationGate({
    monetizationEnabled: true,
    priceCatalogue,
    freeRunCounter,
    approvedFreeQuota,
    runsPackBalance,
    codeRunsBalance,
    checkout: null,
  });
  return gate.probeCoverage({ account, family: "stock", tenantId: account.tenantId, nowMs: Date.now() });
}
