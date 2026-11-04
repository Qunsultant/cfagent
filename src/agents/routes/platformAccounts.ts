/**
 * Issue #2222 (program #2218, slice 4) — account administration
 * routes, invoked from OrchestratorAgent.routeRequest in the
 * sequential path.endsWith matching sequence (after the
 * agentic-payments handler). Returns a Response on match, null
 * when no platform-accounts path matches.
 *
 *   GET  /platform/accounts/self        self-service account view
 *   POST /platform/accounts/setup       self-service account setup
 *   GET  /platform/accounts/lookup      operator lookup by userId
 *
 * (Paths are the DO-internal spellings: src/server.ts strips the
 * /api prefix when forwarding, so externally these are
 * /api/platform/accounts/*.)
 *
 * SESSION GATE: production traffic reaches this DO only through
 * src/server.ts's generic /api/ forwarder, which runs requireAuth
 * on EVERY /api/* request before forwarding and sets the
 * x-user-login header from the verified session. The login is
 * the identity everywhere below — no endpoint reads a
 * client-supplied tenantId for scoping, ever. The self endpoints
 * ignore a userId query/body entirely; the lookup endpoint takes
 * a userId to LOOK UP but is operator-gated, so a non-operator
 * can never use it to read another user's account.
 *
 * SETUP FLOW: the destination of slice 1's paid-path no-account
 * message (NO_ACCOUNT_PAID_MESSAGE, src/services/platformIdentity).
 * Setup reuses the subscription-purchase auto-create derivation
 * exactly: tenant = resolved tenant ?? login, Free tier, created
 * server-side from the verified session identity. It is
 * idempotent (an existing account is returned with created
 * false, never overwritten) and it never gates free runs —
 * setup is opt-in; the free path proceeds without an account
 * exactly as today, and pay-per-run submit still fails closed
 * on no account (that path does not auto-create).
 *
 * OPERATOR GATE (#2680 idiom, reused from agenticPayments):
 * effective operators = env COMMERCIAL_STORE_OPERATORS UNION the
 * store operator list; empty = deny all. A store-read failure
 * degrades to env-only, never a 500, never a lockout.
 *
 * MUTATION: this slice adds NO credit/tier mutation endpoint.
 * Mutation already exists, operator-gated, as
 * POST /payments/agentic/commercial/account (upsert) and
 * POST /payments/agentic/commercial/account/credits in
 * agenticPayments.ts, and the AccountAdminPanel wires to those.
 * No new credit-granting path is invented here.
 *
 * Port-first (ADR 0002): this module depends only on port
 * interfaces (CommercialStore, SubscriptionStore, PriceCatalogue,
 * StoreOperators) and the pure identity helpers. Adapters are
 * built by the composition roots (createCommercialAdapter,
 * createSubscriptionAdapter, createPriceCatalogueAdapter,
 * createStoreOperatorsAdapter — null when unbound); an unbound
 * commercial/subscription store fails closed with 503, never a
 * silent Free view. An unbound catalogue is reported honestly
 * (catalogueAvailable false) rather than as an empty price list,
 * because display must not be mistaken for "no prices exist".
 * No store client imports, no env.AGENT_DB references, no SQL.
 */
import { createCommercialAdapter } from "../../data/createCommercialPorts";
import { createPriceCatalogueAdapter } from "../../data/createPriceCataloguePorts";
import { createStoreOperatorsAdapter } from "../../data/createStoreOperatorsPorts";
import { createSubscriptionAdapter } from "../../data/createSubscriptionPorts";
import type { CommercialStore } from "../../data/commercialPorts";
import type { PriceCatalogue, PriceEntry } from "../../data/priceCataloguePorts";
import type { StoreOperators } from "../../data/storeOperatorsPorts";
import type { SubscriptionStore } from "../../data/subscriptionPorts";
import {
  resolvePlatformIdentity,
  toPlatformIdentityView,
  type PlatformIdentity,
} from "../../services/platformIdentity";
import type { AgentName, Env } from "../../types";

/** Port inputs for the account routes (adapters satisfy these structurally). */
export interface PlatformAccountPorts {
  commercial: CommercialStore | null;
  subscriptions: SubscriptionStore | null;
  prices: PriceCatalogue | null;
  operators: StoreOperators | null;
}

export interface PlatformAccountRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** Audit funnel (owner: OrchestratorAgent.audit - was `this.audit`). */
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>,
  ): void;
  /**
   * Test seam: when provided, these ports are used instead of
   * building adapters from env. Production callers omit it and
   * the composition roots build (or return null when unbound).
   */
  ports?: PlatformAccountPorts;
}

/** One subscription row as the account view exposes it — no payment references leak. */
export interface AccountSubscriptionView {
  id: string;
  planId: string;
  provider: string;
  providerStatus: string | null;
  status: string;
  periodStartMs: number;
  periodEndMs: number;
  canceledAtMs: number | null;
}

/** One catalogue row as the account view exposes it. */
export interface AccountCatalogueView {
  family: string;
  priceUSD: number;
  approvalStatus: string;
  approvedBy: string | null;
  approvedAtMs: number | null;
  updatedAtMs: number;
}

export interface AccountView {
  identity: ReturnType<typeof toPlatformIdentityView>;
  subscriptions: AccountSubscriptionView[];
  catalogue: AccountCatalogueView[];
  catalogueAvailable: boolean;
}

function resolvePorts(ctx: PlatformAccountRouteContext): PlatformAccountPorts {
  if (ctx.ports) return ctx.ports;
  const env = ctx.env as unknown as { AGENT_DB?: unknown };
  return {
    commercial: createCommercialAdapter(env),
    subscriptions: createSubscriptionAdapter(env),
    prices: createPriceCatalogueAdapter(env),
    operators: createStoreOperatorsAdapter(env),
  };
}

function envOperatorLogins(ctx: PlatformAccountRouteContext): Set<string> {
  const raw = (ctx.env as unknown as Record<string, unknown>)["COMMERCIAL_STORE_OPERATORS"];
  if (typeof raw !== "string" || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

async function isOperator(ctx: PlatformAccountRouteContext, ports: PlatformAccountPorts, login: string): Promise<boolean> {
  if (envOperatorLogins(ctx).has(login)) return true;
  try {
    const entries = (await ports.operators?.listOperators()) ?? [];
    return entries.some((entry) => entry.login === login);
  } catch {
    return false;
  }
}

async function buildAccountView(
  ports: PlatformAccountPorts,
  userId: string,
): Promise<AccountView> {
  if (!ports.commercial || !ports.subscriptions) {
    throw new Error("Commercial account store is unavailable.");
  }
  const identity: PlatformIdentity = await resolvePlatformIdentity(
    { commercial: ports.commercial, subscriptions: ports.subscriptions },
    { userId, nowMs: Date.now() },
  );
  const subscriptions = await ports.subscriptions.listSubscriptions(userId);
  let catalogue: AccountCatalogueView[] = [];
  let catalogueAvailable = false;
  if (ports.prices) {
    try {
      const entries: PriceEntry[] = await ports.prices.getAllPrices();
      catalogue = entries.map((entry) => ({
        family: entry.family,
        priceUSD: entry.priceUSD,
        approvalStatus: entry.approvalStatus,
        approvedBy: entry.approvedBy,
        approvedAtMs: entry.approvedAtMs,
        updatedAtMs: entry.updatedAtMs,
      }));
      catalogueAvailable = true;
    } catch {
      catalogue = [];
      catalogueAvailable = false;
    }
  }
  return {
    identity: toPlatformIdentityView(identity),
    subscriptions: subscriptions.map((row) => ({
      id: row.id,
      planId: row.planId,
      provider: row.provider,
      providerStatus: row.providerStatus,
      status: row.status,
      periodStartMs: row.periodStartMs,
      periodEndMs: row.periodEndMs,
      canceledAtMs: row.canceledAtMs,
    })),
    catalogue,
    catalogueAvailable,
  };
}

export async function handlePlatformAccountRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: PlatformAccountRouteContext,
): Promise<Response | null> {
  void sessionId;
  const isSelf = path.endsWith("/platform/accounts/self") && request.method === "GET";
  const isSetup = path.endsWith("/platform/accounts/setup") && request.method === "POST";
  const isLookup = path.endsWith("/platform/accounts/lookup") && request.method === "GET";
  if (!isSelf && !isSetup && !isLookup) return null;

  const login = request.headers.get("x-user-login");
  const verifiedLogin = login && login.trim() ? login.trim() : null;
  if (!verifiedLogin) {
    return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
  }
  const ports = resolvePorts(ctx);

  try {
    if (isLookup) {
      if (!ports.commercial || !ports.subscriptions) {
        // Fail closed before the gate would otherwise leak nothing:
        // an unbound store is a 503 for operators and non-operators
        // alike only once the gate passes; the gate itself runs
        // first so availability is never disclosed to strangers.
        if (!(await isOperator(ctx, ports, verifiedLogin))) {
          return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
        }
        return Response.json({ error: "Commercial account store is unavailable." }, { status: 503 });
      }
      if (!(await isOperator(ctx, ports, verifiedLogin))) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const userId = url.searchParams.get("userId") ?? "";
      if (!userId) {
        return Response.json({ error: "userId is required." }, { status: 400 });
      }
      return Response.json(await buildAccountView(ports, userId));
    }

    if (isSelf) {
      if (!ports.commercial || !ports.subscriptions) {
        return Response.json({ error: "Commercial account store is unavailable." }, { status: 503 });
      }
      return Response.json(await buildAccountView(ports, verifiedLogin));
    }

    // POST /platform/accounts/setup — self-service, idempotent.
    if (!ports.commercial || !ports.subscriptions) {
      return Response.json({ error: "Commercial account store is unavailable." }, { status: 503 });
    }
    // The body is never trusted for identity: a client-supplied
    // tenantId is not read here at all, in any path.
    await request.json().catch(() => ({}));
    const identity = await resolvePlatformIdentity(
      { commercial: ports.commercial, subscriptions: ports.subscriptions },
      { userId: verifiedLogin, nowMs: Date.now() },
    );
    if (identity.hasAccount) {
      return Response.json({
        created: false,
        ...(await buildAccountView(ports, verifiedLogin)),
      });
    }
    // Same derivation as the subscription-purchase auto-create:
    // resolved tenant when one exists (never, on this branch —
    // no row exists), else the verified login itself.
    const tenantId = identity.tenantId ?? verifiedLogin;
    await ports.commercial.upsertAccount({
      userId: verifiedLogin,
      tenantId,
      tier: "Free",
    });
    ctx.audit("platform.account.created", "payments", {
      userLogin: verifiedLogin,
      tenantId,
      tier: "Free",
    });
    return Response.json({
      created: true,
      ...(await buildAccountView(ports, verifiedLogin)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /unavailable|Subscription state unavailable/.test(message) ? 503 : 500;
    return Response.json({ error: message || "Failed to handle platform account request" }, { status });
  }
}
