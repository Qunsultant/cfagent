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
import { createLifecycleAdapter } from "../../data/createLifecyclePorts";
import { createOnboardingAdapter } from "../../data/createOnboardingPorts";
import { createPriceCatalogueAdapter } from "../../data/createPriceCataloguePorts";
import { createProfileAdapter } from "../../data/createProfilePorts";
import { createReferralCodeAdapters } from "../../data/createReferralCodePorts";
import { createStoreOperatorsAdapter } from "../../data/createStoreOperatorsPorts";
import { createSubscriptionAdapter } from "../../data/createSubscriptionPorts";
import { PLATFORM_ROUTE_SUFFIXES } from "../../data/platformUrlCatalog";
import type { CommercialStore } from "../../data/commercialPorts";
import type { LifecycleStore } from "../../data/lifecyclePorts";
import type { ReferralCodeRuleStore, ReferralCodeStore } from "../../data/referralCodePorts";
import type { OnboardingStateStore } from "../../data/onboardingPorts";
import type { UserProfileStore } from "../../data/profilePorts";
import type { PriceCatalogue, PriceEntry } from "../../data/priceCataloguePorts";
import type { StoreOperators } from "../../data/storeOperatorsPorts";
import type { SubscriptionStore } from "../../data/subscriptionPorts";
import {
  resolveEffectiveTenantId,
  resolvePlatformIdentity,
  toPlatformIdentityView,
  type PlatformIdentity,
} from "../../services/platformIdentity";
import { captureSignupAttribution } from "../../services/referralAttribution";
import { activateTrialSubscription } from "../../services/trialSubscriptionActivation";
import {
  extractIdempotencyKey,
  toUserProfileView,
  validateProfileInput,
} from "../../services/userProfile";
import { BusinessError, getOutcome } from "../../outcomes/outcomeAspects";
import { logAspectEvent } from "../../aspects/loggingAspect";
import {
  accountLookupQuerySchema,
  onboardingSaveBodySchema,
  profileSaveBodySchema,
  requestInvalidResponse,
  validateRequestShape,
} from "../../api/requestValidation";
import type { AgentName, Env } from "../../types";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { lookupInternalUserIdByLogin } from "../../security/iaaaMigration";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { sessionStore } from "../../security/session";

/** Issue #5606 (G-3) — module logger on the structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/platformAccounts",
});


/**
 * Issue #3261 — coded profile response bodies (AOP, #1969 program).
 *
 * Every profile response carries {code, message} resolved through
 * the single outcome resolver — the businessMessage is the one
 * rendering in every channel, never a hand-written variant. An
 * unknown code is a programming error and fails closed as a coded
 * 500 (BusinessError), never an uncoded message. Issue #5607
 * (G-5/G-6) extends this helper to the remaining account routes:
 * the non-profile error returns below go through
 * `codedErrorResponse`, which renders the same {code, message}
 * shape and logs the refusal.
 */
function profileCodedBody(
  code: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const entry = getOutcome(code);
  if (!entry) throw new BusinessError("FAILURE_UNEXPECTED_ERROR");
  return { code: entry.code, message: entry.businessMessage, ...(extra ?? {}) };
}

/**
 * Issue #5607 (G-5/G-6) — the coded refusal helper for the
 * non-profile account routes: logs the refusal (warn, with code
 * + status) and returns the same {code, message} shape the
 * profile paths use. Statuses are unchanged from the pre-slice
 * literals.
 */
function codedErrorResponse(
  code: string,
  status: number,
  fields: Record<string, unknown> = {},
): Response {
  structuredLog.warn("platformAccounts.request_refused", {
    code,
    status,
    ...fields,
  });
  return Response.json(profileCodedBody(code), { status });
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
  /**
   * Lifecycle store (#5226, 2.27; #6141 widens it to the full
   * store for the referred-trial grant's rule read). Null/undefined
   * when unbound — the setup route skips attribution, never blocks
   * account creation. The runtime object is the full D1 lifecycle
   * adapter; the narrower type above was the pre-#6141 shape.
   */
  lifecycle?: LifecycleStore | null;
  /**
   * Referral-code stores (#5226, 2.27); null/undefined when unbound —
   * the setup route skips code resolution. Only the rule + code reads
   * are used (no redemption, no balance mutation at signup).
   */
  referralCodes?: {
    rules: Pick<ReferralCodeRuleStore, "getRule">;
    codes: Pick<ReferralCodeStore, "getCodeByHash">;
  } | null;
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
  const referralCodeAdapters = createReferralCodeAdapters(env);
  return {
    commercial: createCommercialAdapter(env),
    subscriptions: createSubscriptionAdapter(env),
    prices: createPriceCatalogueAdapter(env),
    operators: createStoreOperatorsAdapter(env),
    onboarding: createOnboardingAdapter(env),
    profile: createProfileAdapter(env),
    lifecycle: createLifecycleAdapter(env),
    referralCodes: referralCodeAdapters
      ? { rules: referralCodeAdapters.rules, codes: referralCodeAdapters.codes }
      : null,
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
    // #5607 (G-5): the degrade was silent; log it. A store-read
    // failure degrades to env-only (checked above), never a 500.
    structuredLog.warn("platformAccounts.operator_list_degraded", { login });
    return false;
  }
}

async function buildAccountView(
  ports: PlatformAccountPorts,
  userId: string,
): Promise<AccountView> {
  if (!ports.commercial || !ports.subscriptions) {
    throw new BusinessError("FAILURE_COMMERCIAL_STORE_UNAVAILABLE"); // #5606 (G-3)
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
      // #5607 (G-5): the degrade was silent; log it. An unbound
      // catalogue is reported honestly (catalogueAvailable
      // false) rather than as an empty price list.
      structuredLog.warn("platformAccounts.catalogue_read_failed", { login: userId });
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
  const isSelf = path.endsWith(PLATFORM_ROUTE_SUFFIXES.accountSelf) && request.method === "GET";
  const isSetup = path.endsWith(PLATFORM_ROUTE_SUFFIXES.accountSetup) && request.method === "POST";
  const isLookup = path.endsWith(PLATFORM_ROUTE_SUFFIXES.accountLookup) && request.method === "GET";
  const isOnboardingGet = path.endsWith(PLATFORM_ROUTE_SUFFIXES.onboardingState) && request.method === "GET";
  const isOnboardingSave = path.endsWith(PLATFORM_ROUTE_SUFFIXES.onboardingState) && request.method === "POST";
  const isProfileGet = path.endsWith(PLATFORM_ROUTE_SUFFIXES.accountProfile) && request.method === "GET";
  const isProfileSave = path.endsWith(PLATFORM_ROUTE_SUFFIXES.accountProfile) && request.method === "POST";
  if (!isSelf && !isSetup && !isLookup && !isOnboardingGet && !isOnboardingSave && !isProfileGet && !isProfileSave) return null;
  const route = isSelf
    ? "self"
    : isSetup
      ? "setup"
      : isLookup
        ? "lookup"
        : isOnboardingGet
          ? "onboarding-get"
          : isOnboardingSave
            ? "onboarding-save"
            : isProfileGet
              ? "profile-get"
              : "profile-save";

  const login = request.headers.get("x-user-login");
  const verifiedLogin = login && login.trim() ? login.trim() : null;
  if (!verifiedLogin) {
    // #5607 (G-5/G-6): one warn for the 401, whichever code the
    // route answers — profile paths keep
    // FAILURE_PROFILE_NOT_SIGNED_IN, the other routes answer
    // FAILURE_COMMERCIAL_UNAUTHORIZED.
    const code =
      isProfileGet || isProfileSave
        ? "FAILURE_PROFILE_NOT_SIGNED_IN"
        : "FAILURE_COMMERCIAL_UNAUTHORIZED";
    structuredLog.warn("platformAccounts.request_refused", {
      code,
      status: 401,
      route,
      login: null,
    });
    if (isProfileGet || isProfileSave) {
      return Response.json(profileCodedBody("FAILURE_PROFILE_NOT_SIGNED_IN"), { status: 401 });
    }
    return Response.json(profileCodedBody("FAILURE_COMMERCIAL_UNAUTHORIZED"), { status: 401 });
  }
  const ports = resolvePorts(ctx);

  try {
    // #5607 (G-5): entry event — route name + verified login.
    structuredLog.info("platformAccounts.request_started", {
      route,
      login: verifiedLogin,
    });
    if (isLookup) {
      if (!ports.commercial || !ports.subscriptions) {
        // Fail closed before the gate would otherwise leak nothing:
        // an unbound store is a 503 for operators and non-operators
        // alike only once the gate passes; the gate itself runs
        // first so availability is never disclosed to strangers.
        if (!(await isOperator(ctx, ports, verifiedLogin))) {
          return codedErrorResponse("FAILURE_COMMERCIAL_OPERATOR_REQUIRED", 403, {
            route,
            login: verifiedLogin,
          });
        }
        return codedErrorResponse("FAILURE_COMMERCIAL_STORE_UNAVAILABLE", 503, {
          route,
          login: verifiedLogin,
        });
      }
      if (!(await isOperator(ctx, ports, verifiedLogin))) {
        return codedErrorResponse("FAILURE_COMMERCIAL_OPERATOR_REQUIRED", 403, {
          route,
          login: verifiedLogin,
        });
      }
      const userId = url.searchParams.get("userId") ?? "";
      // #5604: the lookup query shape goes through the shared
      // helper; the non-empty check stays here (a bound, not a
      // shape). Message and status unchanged; the 400 is coded.
      const queryShape = validateRequestShape(accountLookupQuerySchema, {
        userId: url.searchParams.get("userId"),
      });
      if (!queryShape.ok || !userId) {
        return requestInvalidResponse("userId is required.");
      }
      const view = await buildAccountView(ports, userId);
      structuredLog.info("platformAccounts.account_lookup_succeeded", {
        route,
        login: verifiedLogin,
      });
      return Response.json(view);
    }

    if (isSelf) {
      if (!ports.commercial || !ports.subscriptions) {
        return codedErrorResponse("FAILURE_COMMERCIAL_STORE_UNAVAILABLE", 503, {
          route,
          login: verifiedLogin,
        });
      }
      const selfView = await buildAccountView(ports, verifiedLogin);
      structuredLog.info("platformAccounts.account_self_read", {
        route,
        login: verifiedLogin,
      });
      return Response.json(selfView);
    }

    // Onboarding state (#3256) — self only, keyed by the verified
    // session login. The body is never trusted for identity: a
    // client-supplied userLogin/tenantId is not read here at all,
    // in any path. The tenantId is stamped server-side from the
    // resolved platform identity (null when no account exists yet).
    if (isOnboardingGet || isOnboardingSave) {
      if (!ports.onboarding) {
        return codedErrorResponse("FAILURE_COMMERCIAL_STORE_UNAVAILABLE", 503, {
          route,
          login: verifiedLogin,
        });
      }
      if (isOnboardingGet) {
        const state = await ports.onboarding.getOnboardingState(verifiedLogin);
        structuredLog.info("platformAccounts.onboarding_state_read", {
          route,
          login: verifiedLogin,
        });
        return Response.json({ state });
      }
      const body = (await request.json().catch(() => ({}))) as {
        currentStep?: unknown;
        completed?: unknown;
        trialPlanId?: unknown;
      };
      // #5604: the save-body shape goes through the shared helper
      // (`onboardingSaveBodySchema` — presence + JSON type of
      // currentStep only). The 1..5 integer bound stays here, and
      // `completed` / `trialPlanId` keep their existing coercions.
      // Message and status unchanged; the 400 is coded.
      const bodyShape = validateRequestShape(onboardingSaveBodySchema, body);
      if (!bodyShape.ok) {
        return requestInvalidResponse("currentStep must be an integer between 1 and 5.");
      }
      const currentStep = body.currentStep;
      if (typeof currentStep !== "number" || !Number.isInteger(currentStep) || currentStep < 1 || currentStep > 5) {
        return requestInvalidResponse("currentStep must be an integer between 1 and 5.");
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
          // #5607 (G-5): the fallback was silent; log it.
          // Identity unavailable: keep the previously stamped tenant.
          structuredLog.warn("platformAccounts.identity_resolve_degraded", {
            route,
            login: verifiedLogin,
          });
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
      structuredLog.info("platformAccounts.onboarding_state_saved", {
        route,
        login: verifiedLogin,
      });
      return Response.json({ state });
    }

    // User profile (#3261) — self only, keyed by the verified
    // session login. The body is never trusted for identity: a
    // client-supplied userLogin/tenantId is not read here at all,
    // in any path. Display name, phone, and contact email are the
    // editable fields; the contact email never changes the login
    // (the login IS the verified identity) and is never used for
    // auth or recovery. Email was added owner-directed 2026-11-16,
    // the CISO-review deferral lifted by explicit owner direction;
    // no CISO review happened and none is claimed. Every response
    // carries {code, message} from the outcome catalog (AOP);
    // validation failures are structural (field + kind at the
    // point of failure, kind to logs only, never values).
    // Idempotent Receiver (standards §7.2): the POST requires an
    // idempotencyKey and replays it with 409. A POST with no
    // profile fields is a no-op read: it writes nothing and audits
    // nothing. Writes audit code + message + login + changed-flags
    // only, never the profile values themselves (email and phone
    // are PII). A store throw fails closed as a coded 503, never
    // a raw error.
    // #5160 — the profile is per-tenant: this route reads and
    // writes the OPERATING-tenant row (IAAA_TENANT_ID else
    // "primary"), and the view carries the effective values
    // (user-edited values where set, otherwise the provider
    // value) plus the per-field provenance and the tenant. A user
    // edit marks its field provenance 'user', so later sign-ins
    // leave it alone. POST {syncFromProvider: true} (no profile
    // fields, no idempotency key — the sync is naturally
    // idempotent) resets user-owned fields to their provider
    // values. The internal user id resolves via the login alias
    // (best-effort; an unresolvable login saves a legacy row the
    // next sign-in re-keys).
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
      const tenantId = resolveIaaaTenant(ctx.env);
      let internalUserId: string | null = null;
      try {
        internalUserId = await lookupInternalUserIdByLogin(
          sessionStore(ctx.env),
          verifiedLogin,
        );
      } catch {
        internalUserId = null;
      }
      const readProfile = async (): Promise<
        { ok: true; profile: Awaited<ReturnType<typeof store.getProfileByLogin>> } | { ok: false }
      > => {
        try {
          return { ok: true, profile: await store.getProfileByLogin(verifiedLogin, tenantId) };
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
        structuredLog.info("platformAccounts.profile_read", {
          route,
          login: verifiedLogin,
        });
        return Response.json({
          ...profileCodedBody("SUCCESS_PROFILE_READ"),
          ...toUserProfileView(verifiedLogin, read.profile, tenantId),
        });
      }
      const body = (await request.json().catch(() => ({}))) as {
        displayName?: unknown;
        phone?: unknown;
        email?: unknown;
        idempotencyKey?: unknown;
        syncFromProvider?: unknown;
      };
      // #5604: the save-body shape goes through the shared helper
      // first (`profileSaveBodySchema` — key first in schema order,
      // so a bad key still reports before a bad profile field).
      // A body that is not an object (scalar or array) previously
      // threw in the `in` checks below and surfaced as a 500; it
      // now fails here as the coded 400, field `body` (#1768
      // precedent). The gate checks shape only — the raw body
      // flows on, so the key and profile checks below see exactly
      // what they saw before. Enumerated attribution change: a
      // body with an ABSENT key and an invalid profile field now
      // reports the profile field (it previously reported the
      // missing key); status and code are unchanged.
      const bodyShape = validateRequestShape(profileSaveBodySchema, body);
      if (!bodyShape.ok) {
        const issue = bodyShape.issues[0]!;
        logAspectEvent({
          aspect: "Profile",
          operationName: "profile.save",
          code: "FAILURE_PROFILE_VALIDATION",
          level: "warn",
          message: "profile save body failed shape validation",
          metadata: { userLogin: verifiedLogin, field: issue.field, kind: issue.kind },
        });
        return Response.json(
          profileCodedBody("FAILURE_PROFILE_VALIDATION", { field: issue.field }),
          { status: 400 },
        );
      }
      const key = extractIdempotencyKey(body);
      // #5160 — sync-from-provider: POST {syncFromProvider: true}
      // with no profile fields resets user-owned fields to their
      // provider values. The sync is naturally idempotent (a
      // re-run converges), so no idempotency key is required; a
      // body that mixes a sync with profile fields fails as a
      // validation error, field `syncFromProvider`.
      if (body.syncFromProvider === true) {
        if (
          "displayName" in body ||
          "phone" in body ||
          "email" in body
        ) {
          logAspectEvent({
            aspect: "Profile",
            operationName: "profile.sync",
            code: "FAILURE_PROFILE_VALIDATION",
            level: "warn",
            message: "sync request carried profile fields",
            metadata: { userLogin: verifiedLogin, field: "syncFromProvider", kind: "conflict" },
          });
          return Response.json(
            profileCodedBody("FAILURE_PROFILE_VALIDATION", { field: "syncFromProvider" }),
            { status: 400 },
          );
        }
        const previous = await readProfile();
        if (!previous.ok) {
          return Response.json(profileCodedBody("FAILURE_PROFILE_STORE_UNAVAILABLE"), { status: 503 });
        }
        const syncId = previous.profile?.internalUserId ?? internalUserId;
        if (!syncId) {
          logAspectEvent({
            aspect: "Profile",
            operationName: "profile.sync",
            code: "FAILURE_IDP_PROFILE_REFRESH_FAILED",
            level: "warn",
            message: "sync requested with no resolvable internal user id",
            metadata: { userLogin: verifiedLogin },
          });
          return Response.json(profileCodedBody("FAILURE_IDP_PROFILE_REFRESH_FAILED"), { status: 503 });
        }
        let synced: Awaited<ReturnType<typeof store.syncFromProvider>>;
        try {
          synced = await store.syncFromProvider(syncId, tenantId, Date.now());
        } catch {
          logAspectEvent({
            aspect: "Profile",
            operationName: "profile.sync",
            code: "FAILURE_IDP_PROFILE_REFRESH_FAILED",
            level: "error",
            message: "profile sync failed",
            metadata: { userLogin: verifiedLogin },
          });
          return Response.json(profileCodedBody("FAILURE_IDP_PROFILE_REFRESH_FAILED"), { status: 503 });
        }
        structuredLog.info("platformAccounts.profile_synced", {
          route,
          login: verifiedLogin,
        });
        return Response.json({
          ...profileCodedBody("SUCCESS_IDP_PROFILE_REFRESHED"),
          ...toUserProfileView(verifiedLogin, synced, tenantId),
        });
      }
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
      if (!("displayName" in input) && !("phone" in input) && !("email" in input)) {
        structuredLog.info("platformAccounts.profile_read", {
          route,
          login: verifiedLogin,
          noop: true,
        });
        return Response.json({
          ...profileCodedBody("SUCCESS_PROFILE_READ"),
          ...toUserProfileView(verifiedLogin, previous.profile, tenantId),
        });
      }
      const nowMs = Date.now();
      // #5160 — the save carries the FULL merged row (the row the
      // caller read first, plus the user edits): dropping the IDP
      // columns would silently un-record the provenance the
      // sign-in refresh relies on. Each edited field is stamped
      // provenance 'user' at nowMs, so later sign-ins leave it
      // alone; a user-clear (null) is a 'user' value too and wins
      // over a live provider value.
      const provenance = { ...(previous.profile?.provenance ?? {}) };
      if ("displayName" in input) {
        provenance.displayName = { source: "user", updatedAtMs: nowMs };
      }
      if ("phone" in input) {
        provenance.phone = { source: "user", updatedAtMs: nowMs };
      }
      if ("email" in input) {
        provenance.email = { source: "user", updatedAtMs: nowMs };
      }
      let saved: Awaited<ReturnType<typeof store.saveProfileOnce>>;
      try {
        saved = await store.saveProfileOnce(
          {
            userLogin: verifiedLogin,
            displayName:
              "displayName" in input ? (input.displayName ?? null) : (previous.profile?.displayName ?? null),
            phone: "phone" in input ? (input.phone ?? null) : (previous.profile?.phone ?? null),
            email: "email" in input ? (input.email ?? null) : (previous.profile?.email ?? null),
            updatedAtMs: nowMs,
            internalUserId: previous.profile?.internalUserId ?? internalUserId,
            tenantId: previous.profile?.tenantId ?? tenantId,
            idpIssuer: previous.profile?.idpIssuer ?? null,
            idpAttributes: previous.profile?.idpAttributes ?? {},
            provenance,
            idpUpdatedAtMs: previous.profile?.idpUpdatedAtMs ?? null,
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
        emailChanged: (previous.profile?.email ?? null) !== next.email,
        updatedAtMs: nowMs,
      });
      structuredLog.info("platformAccounts.profile_updated", {
        route,
        login: verifiedLogin,
      });
      return Response.json({
        ...profileCodedBody("SUCCESS_PROFILE_UPDATED"),
        ...toUserProfileView(verifiedLogin, next, tenantId),
      });
    }

    // POST /platform/accounts/setup — self-service, idempotent.
    if (!ports.commercial || !ports.subscriptions) {
      return codedErrorResponse("FAILURE_COMMERCIAL_STORE_UNAVAILABLE", 503, {
        route,
        login: verifiedLogin,
      });
    }
    // The body is never trusted for identity: a client-supplied
    // tenantId is not read here at all, in any path. The only body
    // field read is the optional referral code (#5226, 2.27).
    const setupBody = (await request.json().catch(() => ({}))) as { referralCode?: unknown };
    const identity = await resolvePlatformIdentity(
      { commercial: ports.commercial, subscriptions: ports.subscriptions },
      { userId: verifiedLogin, nowMs: Date.now() },
    );
    if (identity.hasAccount) {
      const existingView = await buildAccountView(ports, verifiedLogin);
      structuredLog.info("platformAccounts.account_setup_succeeded", {
        route,
        login: verifiedLogin,
        created: false,
      });
      return Response.json({
        created: false,
        ...existingView,
      });
    }
    // Same derivation as the subscription-purchase auto-create:
    // resolved tenant when one exists (never, on this branch —
    // no row exists), else the namespaced login-as-tenant id (#4602).
    const tenantId = resolveEffectiveTenantId(identity.tenantId, verifiedLogin);
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
    // Issue #5226 (2.27): automatic referral attribution, best-effort
    // and only on actual creation (the idempotent re-call returns
    // above, where the attribution already stands). The capture never
    // throws and never fails setup — an unbound store, an unknown
    // code, a self-referral, or any store error is a silent skip,
    // and the operator record-earn route stays the manual fallback.
    // The automatic earn trigger in the paid-submit path reads the
    // attribution row from here on the referred user's first
    // verified paid run.
    if (ports.lifecycle && ports.referralCodes && ports.commercial) {
      try {
        const attribution = await captureSignupAttribution(
          {
            codes: ports.referralCodes.codes,
            rules: ports.referralCodes.rules,
            commercial: ports.commercial,
            lifecycle: ports.lifecycle,
          },
          {
            codeValue: setupBody.referralCode,
            referredUserId: verifiedLogin,
            tenantId,
            nowMs: Date.now(),
          },
        );
        if (attribution) {
          ctx.audit("platform.account.referral_attributed", "payments", {
            userLogin: verifiedLogin,
            referrerUserId: attribution.referrerUserId,
            source: attribution.source,
          });
          // Issue #6141: the referred user's trial grant — the
          // rule's referredTrialDays on the operator-chosen trial
          // plan (null = disabled). Best-effort like the capture:
          // a missing plan, an unapproved version, or any store
          // error is a silent skip (audited), never a failed
          // signup. The grant activates the trial at the rule's
          // length (trialDaysOverride); the free tier follows
          // when the trial lapses, per the existing trial path.
          try {
            const rules = await ports.lifecycle.getRules();
            if (rules.referralTrialPlanId) {
              const plan = await ports.subscriptions.getPlan(rules.referralTrialPlanId);
              if (plan && plan.active && plan.trialDays !== null && plan.trialDays !== undefined) {
                const trial = await activateTrialSubscription({
                  subs: ports.subscriptions,
                  store: ports.commercial,
                  userId: verifiedLogin,
                  tenantId,
                  plan,
                  trialDaysOverride: rules.referredTrialDays,
                });
                ctx.audit("platform.account.referral_trial_granted", "payments", {
                  userLogin: verifiedLogin,
                  referrerUserId: attribution.referrerUserId,
                  planId: plan.id,
                  subscriptionId: trial.subscription.id,
                  trialEndsAtMs: trial.trialEndsAtMs,
                });
              }
            }
          } catch {
            structuredLog.warn("platformAccounts.signup_referred_trial_failed", {
              route,
              login: verifiedLogin,
              tenantId,
            });
            ctx.audit("platform.account.referral_trial_failed", "payments", {
              userLogin: verifiedLogin,
              tenantId,
            });
          }
        }
      } catch {
        // #5607 (G-5): the skip was silent; log it and audit it.
        // Attribution must never block account creation.
        structuredLog.warn("platformAccounts.signup_attribution_failed", {
          route,
          login: verifiedLogin,
          tenantId,
        });
        ctx.audit("platform.account.referral_attribution_failed", "payments", {
          userLogin: verifiedLogin,
          tenantId,
        });
      }
    }
    const createdView = await buildAccountView(ports, verifiedLogin);
    structuredLog.info("platformAccounts.account_setup_succeeded", {
      route,
      login: verifiedLogin,
      created: true,
    });
    return Response.json({
      created: true,
      ...createdView,
    });
  } catch (err) {
    // #5606 (G-3): typed failures render from the catalog (the
    // store-unavailable throw keeps its 503 through its code);
    // anything else logs server-side and answers the generic code.
    if (err instanceof BusinessError) {
      return Response.json(profileCodedBody(err.code), {
        status: getOutcome(err.code)?.httpStatus ?? 500,
      });
    }
    structuredLog.error("platformAccounts.account_request_failed", {
      message: `[accounts] platform account request failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(profileCodedBody("FAILURE_UNEXPECTED_ERROR"), { status: 500 });
  }
}
