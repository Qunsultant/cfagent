/**
 * #2041 G-METERING: meter route (POST /api/meter/event).
 *
 * Writes one usage_events row per saga paid run, via the DO usage
 * port (createCanonicalReportStorePorts(ctx.sql).usage) — the same
 * port the premium route meters through. The workflow reaches this
 * route endpoint-mediated (recordMeterUsageEvent in
 * src/services/cfpayLedger.ts posts through the ORCHESTRATOR_AGENT
 * stub), because workflow steps run in the Worker with no DO sql
 * accessor — the same reachability shape as the saga audit
 * forwarder posting to /api/audit/event.
 *
 * Trust model: identical to the audit route. server.ts does NOT
 * route this path publicly, so the only caller is the internal
 * stub channel (service identity in the x-user-login header).
 * The row's userLogin comes from the VALIDATED BODY, never from
 * that header: the header carries the forwarder service identity,
 * and taking it would misattribute every row to the service
 * account. The tenantId rides the same validated body from the
 * server-side workflow caller (issue #3185 stamp slice) — the
 * saga's validated account tenant, threaded, never re-resolved
 * here; absent stamps NULL.
 *
 * Payload shape follows buildMeteredCallEvent
 * (src/services/meteredPaymentGate.ts) exactly — id
 * use_<receiptId>, runId = receiptId, detailJson
 * {receiptId, priceUSD, tier, protocol} — but the row is built
 * directly rather than through that function: detailJson.protocol
 * is a free-form string in receipts, while AgenticPaymentProtocol
 * (src/types.ts) has no "stripe" variant (card-ish paths here use
 * "mpp", a separate micropayment protocol, not Stripe), so
 * routing through the function would mislabel stripe runs as
 * "mpp" or force a widening of the shared type. protocol here is
 * the actual rail ("stripe" | "x402", i.e. CheckoutRail).
 *
 * Fail-closed throughout: validation failures are 400, any store
 * failure (including ensureSchema) is 500, never a silent swallow
 * — a meter failure must fail the calling step so a run never
 * completes unmetered. Dedupe: the receipt-scoped id makes a
 * retried step re-insert the same id; the table's only UNIQUE is
 * the id PRIMARY KEY, so a UNIQUE failure is an id conflict and
 * the retry reports duplicate with exactly one row.
 */

import { createCanonicalReportStorePorts } from "../../data/createCanonicalReportStorePorts";
import type { CanonicalReportStoreSqlExecutor } from "../../data/canonicalReportStorePorts";
import { DuplicateUsageEventError } from "../../data/canonicalReportStorePorts";
import { createCommercialAdapter } from "../../data/createCommercialPorts";
import { createSubscriptionAdapter } from "../../data/createSubscriptionPorts";
import { resolveEffectiveTier } from "../../data/subscriptionPorts";
import type { StoreTier } from "../../data/commercialPorts";
import { resolveMeteredTier } from "../../services/meteredPaymentGate";
import { projectUsageEventBestEffort } from "../../services/usageEventProjectionHooks";
import type { Env } from "../../types";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #5606 (G-3) — module logger on the structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/meter",
});


export interface MeterRouteContext {
  sql: CanonicalReportStoreSqlExecutor;
  env: unknown;
  /**
   * Test seam: override the tier resolver. Defaults to the store
   * resolver below — the same rule the premium route uses
   * (resolvePremiumTier in src/agents/routes/premium.ts).
   */
  resolveTier?: (userLogin: string) => Promise<StoreTier | null>;
}

/**
 * Resolve a user's tier from the tier store. Unbound store (no
 * AGENT_DB) resolves null, which resolveMeteredTier maps to the
 * Free default. A failing store THROWS (fail-closed): the route
 * answers 500 rather than metering a run under a guessed tier.
 */
export function createMeterTierResolver(
  env: unknown,
): (userLogin: string) => Promise<StoreTier | null> {
  return async (userLogin: string) => {
    const store = createCommercialAdapter(env as { AGENT_DB?: unknown });
    const subs = createSubscriptionAdapter(env as { AGENT_DB?: unknown });
    if (!store || !subs) return null;
    const record = await store.getAccount(userLogin);
    const subscriptions = await subs.listSubscriptions(userLogin);
    return resolveEffectiveTier(record, subscriptions, Date.now());
  };
}

interface MeterEventBody {
  receiptId?: unknown;
  protocol?: unknown;
  userLogin?: unknown;
  priceUSD?: unknown;
  category?: unknown;
  tenantId?: unknown;
}

export async function handleMeterRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: MeterRouteContext,
): Promise<Response | null> {
  if (!(path.endsWith("/meter/event") && request.method === "POST")) return null;
  try {
    const body = (await request.json().catch(() => null)) as MeterEventBody | null;
    if (!body || typeof body !== "object") {
      return Response.json({ error: "Meter event body must be a JSON object." }, { status: 400 });
    }
    const { receiptId, protocol, userLogin, priceUSD, category, tenantId } = body;
    if (typeof receiptId !== "string" || !receiptId) {
      return Response.json({ error: "receiptId is required." }, { status: 400 });
    }
    if (protocol !== "stripe" && protocol !== "x402") {
      return Response.json({ error: 'protocol must be "stripe" or "x402".' }, { status: 400 });
    }
    if (typeof userLogin !== "string" || !userLogin) {
      return Response.json({ error: "userLogin is required." }, { status: 400 });
    }
    // Issue #3185 (stamp slice): the tenant rides the validated
    // body from the server-side workflow caller (recordMeterUsageEvent),
    // exactly like userLogin — never from the forwarder header.
    // Absent or null stamps NULL (unattributed); a non-string
    // value is a malformed body.
    if (tenantId !== undefined && tenantId !== null && typeof tenantId !== "string") {
      return Response.json({ error: "tenantId must be a string." }, { status: 400 });
    }
    const stampedTenantId =
      typeof tenantId === "string" && tenantId.trim().length > 0 ? tenantId.trim() : null;
    if (typeof priceUSD !== "number" || !Number.isFinite(priceUSD) || priceUSD <= 0) {
      return Response.json({ error: "priceUSD must be a positive number." }, { status: 400 });
    }
    // Saga-scoped by decision (Venus 2026-11-01): only saga runs
    // are ever metered, so any other category is a mislabeling
    // bug, rejected rather than stored.
    if (category !== "saga") {
      return Response.json({ error: 'category must be "saga".' }, { status: 400 });
    }
    const tier = await resolveMeteredTier(
      ctx.resolveTier ?? createMeterTierResolver(ctx.env),
      userLogin,
    );
    const meter = createCanonicalReportStorePorts(ctx.sql).usage;
    meter.ensureSchema();
    const row = {
      id: `use_${receiptId}`,
      userLogin,
      runId: receiptId,
      category: "saga",
      createdAt: new Date().toISOString(),
      detailJson: JSON.stringify({ receiptId, priceUSD, tier, protocol }),
      tenantId: stampedTenantId,
    };
    try {
      meter.insertEvent(row);
    } catch (err) {
      // #5606 (G-3): a duplicate id is a retried step — 201
      // duplicate. Any other store failure propagates to the
      // outer catch.
      if (err instanceof DuplicateUsageEventError) {
        // Issue #3185 (bridge slice): the row already exists in
        // this DO — project it anyway (INSERT OR IGNORE in the
        // mirror): the first attempt's live hook may have missed
        // it, and a retried step is the repair path for it.
        await projectUsageEventBestEffort({ env: ctx.env as Env, row });
        return Response.json({ id: row.id, duplicate: true }, { status: 201 });
      }
      throw err;
    }
    // Issue #3185 (bridge slice): project the row into the D1
    // mirror. Best-effort, never a gate condition — the hook
    // never throws, so a projection failure cannot turn this
    // 201 into a 500 (the reconcile sweep backstops it).
    // sourceInstance is unknown here — the route carries no
    // instance label — so the mirror row records null; the
    // reconcile sweep labels its own instance.
    await projectUsageEventBestEffort({ env: ctx.env as Env, row });
    return Response.json({ id: row.id, duplicate: false }, { status: 201 });
  } catch (err) {
    // #5606 (G-3): no raw store text reaches the caller; the
    // detail stays in the server log.
    structuredLog.error("meter.event_failed", {
      message: `[meter] meter event failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ error: "Meter event failed.", code: "FAILURE_UNEXPECTED_ERROR" }, { status: 500 });
  }
}
