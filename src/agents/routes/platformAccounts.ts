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
 *   GET  /platform/onboarding/state     self-only onboarding state
 *   POST /platform/onboarding/state     self-only onboarding state save
 *   GET  /platform/accounts/profile     self-only profile read (#3261)
 *   POST /platform/accounts/profile     self-only profile save (#3261)
 *
 * (#3261, sub-issue of #3256: profile view + edit — display name
 * and phone only. Email is NOT a field here: email change touches
 * IAAA / session / auth and needs CISO review first (#3261 comment
 * 6681436382, refs #945); until that review lands, email is
 * explicitly deferred and no email route exists. Phone is an
 * UNVERIFIED contact field, never used for auth or recovery.)
 *
 * (#3256, sub-issue of #3241: the onboarding state routes live here
 * because they are self-service platform-account state, keyed by the
 * verified login exactly like the self/setup endpoints. One row per
 * login: current step 1..5, completion, and the trial plan started
 * from the flow. A client-supplied userLogin/tenantId in the POST
 * body is never read; the tenantId is stamped server-side from the
 * resolved platform identity. An absent row reads as no state — the
 * client falls back to the per-user localStorage flag, #2471.)
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
import { createOnboardingAdapter } from "../../data/createOnboardingPorts";
import { createPriceCatalogueAdapter } from "../../data/createPriceCataloguePorts";
import { createProfileAdapter } from "../../data/createProfilePorts";
import { createStoreOperatorsAdapter } from "../../data/createStoreOperatorsPorts";
import { createSubscriptionAdapter } from "../../data/createSubscriptionPorts";
import type { CommercialStore } from "../../data/commercialPorts";
import type { OnboardingStateStore } from "../../data/onboardingPorts";
import type { UserProfileStore } from "../../data/profilePorts";
import type { PriceCatalogue, PriceEntry } from "../../data/priceCataloguePorts";
import type { StoreOperators } from "../../data/storeOperatorsPorts";
import type { SubscriptionStore } from "../../data/subscriptionPorts";
import {
  resolvePlatformIdentity,
  toPlatformIdentityView,
  type PlatformIdentity,
} from "../../services/platformIdentity";
import {
  extractIdempotencyKey,
  toUserProfileView,
  validateProfileInput,
} from "../../services/userProfile";
import { BusinessError, getOutcome } from "../../outcomes/outcomeAspects";
import { logAspectEvent } from "../../aspects/loggingAspect";
import type { AgentName, Env } from "../../types";

/**
 * Issue #3261 — coded profile response bodies (AOP, #1969 program).
 *
 * Every profile response carries {code, message} resolved through
 * the single outcome resolver — the businessMessage is the one
 * rendering in every channel, never a hand-written variant. An
 * unknown code is a programming error and fails closed as a coded
 * 500 (BusinessError), never an uncoded message. Only the profile
 * paths use this helper; the other account routes keep their
 * existing fixed strings, untouched.
 */
function profileCodedBody(
  code: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const entry = getOutcome(code);
  if (!entry) throw new BusinessError("FAILURE_UNEXPECTED_ERROR");
  return { code: entry.code, message: entry.businessMessage, ...(extra ?? {}) };
}

/** Port inputs for the account routes (adapters satisfy these structurally). */
export interface PlatformAccountPorts {
  commercial: CommercialStore | null;
  subscriptions: SubscriptionStore | null;
  prices: PriceCatalogue | null;
  operators: StoreOperators | null;
  /** Onboarding state store (#3256); null when unbound — the state routes fail closed with 503. */
  onboarding: OnboardingStateStore | null;
  /** User profile store (#3261); null when unbound — the profile routes fail closed with 503. */
  profile: UserProfileStore | null;
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
    onboarding: createOnboardingAdapter(env),
    profile: createProfileAdapter(env),
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
  const isOnboardingGet = path.endsWith("/platform/onboarding/state") && request.method === "GET";
  const isOnboardingSave = path.endsWith("/platform/onboarding/state") && request.method === "POST";
  const isProfileGet = path.endsWith("/platform/accounts/profile") && request.method === "GET";
  const isProfileSave = path.endsWith("/platform/accounts/profile") && request.method === "POST";
  if (!isSelf && !isSetup && !isLookup && !isOnboardingGet && !isOnboardingSave && !isProfileGet && !isProfileSave) return null;

  const login = request.headers.get("x-user-login");
  const verifiedLogin = login && login.trim() ? login.trim() : null;
  if (!verifiedLogin) {
    // Profile paths get the coded 401; the other account routes
    // keep their existing fixed string, untouched.
    if (isProfileGet || isProfileSave) {
      return Response.json(profileCodedBody("FAILURE_PROFILE_NOT_SIGNED_IN"), { status: 401 });
    }
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

    // Onboarding state (#3256) — self only, keyed by the verified
    // session login. The body is never trusted for identity: a
    // client-supplied userLogin/tenantId is not read here at all,
    // in any path. The tenantId is stamped server-side from the
    // resolved platform identity (null when no account exists yet).
    if (isOnboardingGet || isOnboardingSave) {
      if (!ports.onboarding) {
        return Response.json({ error: "Onboarding state store is unavailable." }, { status: 503 });
      }
      if (isOnboardingGet) {
        return Response.json({ state: await ports.onboarding.getOnboardingState(verifiedLogin) });
      }
      const body = (await request.json().catch(() => ({}))) as {
        currentStep?: unknown;
        completed?: unknown;
        trialPlanId?: unknown;
      };
      const currentStep = body.currentStep;
      if (typeof currentStep !== "number" || !Number.isInteger(currentStep) || currentStep < 1 || currentStep > 5) {
        return Response.json({ error: "currentStep must be an integer between 1 and 5." }, { status: 400 });
      }
      const completed = body.completed === true;
      const trialPlanId =
        typeof body.trialPlanId === "string" && body.trialPlanId.length > 0 ? body.trialPlanId : null;
      const nowMs = Date.now();
      const previous = await ports.onboarding.getOnboardingState(verifiedLogin);
      let tenantId: string | null = previous?.tenantId ?? null;
      if (ports.commercial && ports.subscriptions) {
        try {
          const identity = await resolvePlatformIdentity(
            { commercial: ports.commercial, subscriptions: ports.subscriptions },
            { userId: verifiedLogin, nowMs },
          );
          if (identity.tenantId) tenantId = identity.tenantId;
        } catch {
          // Identity unavailable: keep the previously stamped tenant.
        }
      }
      const state = await ports.onboarding.saveOnboardingState({
        userLogin: verifiedLogin,
        tenantId,
        currentStep,
        completedAtMs: completed
          ? (previous?.completedAtMs ?? nowMs)
          : (previous?.completedAtMs ?? null),
        trialPlanId: trialPlanId ?? previous?.trialPlanId ?? null,
        trialStartedAtMs: trialPlanId
          ? (previous?.trialPlanId === trialPlanId
            ? (previous?.trialStartedAtMs ?? nowMs)
            : nowMs)
          : (previous?.trialStartedAtMs ?? null),
        updatedAtMs: nowMs,
      });
      if (completed && !previous?.completedAtMs) {
        ctx.audit("platform.onboarding.completed", "payments", {
          userLogin: verifiedLogin,
          tenantId,
        });
      }
      return Response.json({ state });
    }

    // User profile (#3261) — self only, keyed by the verified
    // session login. The body is never trusted for identity: a
    // client-supplied userLogin/tenantId/email is not read here at
    // all, in any path. Display name and phone only — email change
    // needs CISO review first (#3261 comment 6681436382, refs
    // #945) and has no route until that review lands. Every
    // response carries {code, message} from the outcome catalog
    // (AOP); validation failures are structural (field + kind at
    // the point of failure, kind to logs only, never values).
    // Idempotent Receiver (standards §7.2): the POST requires an
    // idempotencyKey and replays it with 409. A POST with no
    // profile fields is a no-op read: it writes nothing and audits
    // nothing. Writes audit code + message + login + changed-flags
    // only, never the profile values themselves (phone is PII).
    // A store throw fails closed as a coded 503, never a raw error.
    if (isProfileGet || isProfileSave) {
      if (!ports.profile) {
        logAspectEvent({
          aspect: "Profile",
          operationName: "profile",
          code: "FAILURE_PROFILE_STORE_UNAVAILABLE",
          level: "error",
          message: "profile store unbound",
          metadata: { userLogin: verifiedLogin },
        });
        return Response.json(profileCodedBody("FAILURE_PROFILE_STORE_UNAVAILABLE"), { status: 503 });
      }
      const store = ports.profile;
      const readProfile = async (): Promise<
        { ok: true; profile: Awaited<ReturnType<typeof store.getProfile>> } | { ok: false }
      > => {
        try {
          return { ok: true, profile: await store.getProfile(verifiedLogin) };
        } catch {
          logAspectEvent({
            aspect: "Profile",
            operationName: "profile.read",
            code: "FAILURE_PROFILE_STORE_UNAVAILABLE",
            level: "error",
            message: "profile store read failed",
            metadata: { userLogin: verifiedLogin },
          });
          return { ok: false };
        }
      };
      if (isProfileGet) {
        const read = await readProfile();
        if (!read.ok) {
          return Response.json(profileCodedBody("FAILURE_PROFILE_STORE_UNAVAILABLE"), { status: 503 });
        }
        return Response.json({
          ...profileCodedBody("SUCCESS_PROFILE_READ"),
          ...toUserProfileView(verifiedLogin, read.profile),
        });
      }
      const body = (await request.json().catch(() => ({}))) as {
        displayName?: unknown;
        phone?: unknown;
        idempotencyKey?: unknown;
      };
      const key = extractIdempotencyKey(body);
      if (!key.ok) {
        logAspectEvent({
          aspect: "Profile",
          operationName: "profile.save",
          code: "FAILURE_PROFILE_VALIDATION",
          level: "warn",
          message: "idempotency key missing or wrong type",
          metadata: { userLogin: verifiedLogin, field: "idempotencyKey", kind: key.kind },
        });
        return Response.json(
          profileCodedBody("FAILURE_PROFILE_VALIDATION", { field: "idempotencyKey" }),
          { status: 400 },
        );
      }
      const validated = validateProfileInput(body);
      if (!validated.ok) {
        logAspectEvent({
          aspect: "Profile",
          operationName: "profile.save",
          code: "FAILURE_PROFILE_VALIDATION",
          level: "warn",
          message: "profile validation failed",
          metadata: {
            userLogin: verifiedLogin,
            field: validated.failure.field,
            kind: validated.failure.kind,
          },
        });
        return Response.json(
          profileCodedBody("FAILURE_PROFILE_VALIDATION", { field: validated.failure.field }),
          { status: 400 },
        );
      }
      const previous = await readProfile();
      if (!previous.ok) {
        return Response.json(profileCodedBody("FAILURE_PROFILE_STORE_UNAVAILABLE"), { status: 503 });
      }
      const input = validated.value;
      if (!("displayName" in input) && !("phone" in input)) {
        return Response.json({
          ...profileCodedBody("SUCCESS_PROFILE_READ"),
          ...toUserProfileView(verifiedLogin, previous.profile),
        });
      }
      const nowMs = Date.now();
      let saved: Awaited<ReturnType<typeof store.saveProfileOnce>>;
      try {
        saved = await store.saveProfileOnce(
          {
            userLogin: verifiedLogin,
            displayName:
              "displayName" in input ? (input.displayName ?? null) : (previous.profile?.displayName ?? null),
            phone: "phone" in input ? (input.phone ?? null) : (previous.profile?.phone ?? null),
            updatedAtMs: nowMs,
          },
          key.key,
          nowMs,
        );
      } catch {
        logAspectEvent({
          aspect: "Profile",
          operationName: "profile.save",
          code: "FAILURE_PROFILE_STORE_UNAVAILABLE",
          level: "error",
          message: "profile store write failed",
          metadata: { userLogin: verifiedLogin },
        });
        return Response.json(profileCodedBody("FAILURE_PROFILE_STORE_UNAVAILABLE"), { status: 503 });
      }
      if (saved.duplicate) {
        logAspectEvent({
          aspect: "Profile",
          operationName: "profile.save",
          code: "FAILURE_PROFILE_DUPLICATE",
          level: "warn",
          message: "idempotency key replayed",
          metadata: { userLogin: verifiedLogin },
        });
        return Response.json(
          profileCodedBody("FAILURE_PROFILE_DUPLICATE", { duplicate: true }),
          { status: 409 },
        );
      }
      const next = saved.profile!;
      const updatedEntry = getOutcome("SUCCESS_PROFILE_UPDATED")!;
      ctx.audit("platform.profile.updated", "payments", {
        code: "SUCCESS_PROFILE_UPDATED",
        message: updatedEntry.businessMessage,
        userLogin: verifiedLogin,
        displayNameChanged: (previous.profile?.displayName ?? null) !== next.displayName,
        phoneChanged: (previous.profile?.phone ?? null) !== next.phone,
        updatedAtMs: nowMs,
      });
      return Response.json({
        ...profileCodedBody("SUCCESS_PROFILE_UPDATED"),
        ...toUserProfileView(verifiedLogin, next),
      });
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
