/**
 * #2041 G-METERING: meter route (POST /api/meter/event).
 *
 * Writes one usage_events row per saga paid run, via the DO usage
 * port (createCanonicalReportStorePorts(ctx.sql).usage) — the same
 * port the premium route meters through. The workflow reaches this
 * route endpoint-mediated (recordMeterUsageEvent in
 * src/services/cfpayLedger.ts posts through the SEARCH_AGENT
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
 * account.
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
import { createCommercialAdapter } from "../../data/createCommercialPorts";
import { createSubscriptionAdapter } from "../../data/createSubscriptionPorts";
import { resolveEffectiveTier } from "../../data/subscriptionPorts";
import type { StoreTier } from "../../data/commercialPorts";
import { resolveMeteredTier } from "../../services/meteredPaymentGate";

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
    const { receiptId, protocol, userLogin, priceUSD, category } = body;
    if (typeof receiptId !== "string" || !receiptId) {
      return Response.json({ error: "receiptId is required." }, { status: 400 });
    }
    if (protocol !== "stripe" && protocol !== "x402") {
      return Response.json({ error: 'protocol must be "stripe" or "x402".' }, { status: 400 });
    }
    if (typeof userLogin !== "string" || !userLogin) {
      return Response.json({ error: "userLogin is required." }, { status: 400 });
    }
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
    };
    try {
      meter.insertEvent(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint|PRIMARY KEY/i.test(message)) {
        return Response.json({ id: row.id, duplicate: true }, { status: 201 });
      }
      throw err;
    }
    return Response.json({ id: row.id, duplicate: false }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Meter event failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
