/**
 * Issue #5610 (G-8) — shared request/response schemas for the CBO routes.
 *
 * ONE registry keyed by (catalog id, method), covering every operation in
 * the two catalogs (`src/data/commercialUrlCatalog.ts` +
 * `src/data/platformUrlCatalog.ts`): 82 commercial entries (99 operations)
 * + 14 platform entries (21 operations). The ONE OpenAPI spec (`src/security/openapiSpec.ts`) generates
 * its CBO path items from this registry — never a hand-written second spec.
 *
 * Contract (the #5604 shape-only rule): a request schema states field
 * presence + JSON types at the boundary. Business rules (authorization,
 * existence, bounds, allowlists, normalizers) stay in the routes and the
 * existing validators; a schema never newly rejects an input those accept.
 * A response schema enumerates the top-level fields the inventory
 * (`~/workspace/cbo-parity/routes.md`, Groups B/C/E/F/G/H) names for the
 * route; nested values are `z.unknown()` unless the inventory enumerates
 * their inner fields — the top-level contract is pinned, inner shapes are
 * not invented. The generated JSON Schema marks every object
 * `additionalProperties: true` (see `zodSchemaToJsonSchema`): requests
 * strip unknown keys, responses carry extra fields — `false` would be a
 * false claim either way.
 *
 * `request` is the query schema for a GET (the `?userId=`-style params)
 * and the body schema for POST/PATCH/PUT. Two routes take raw bodies:
 * the Stripe billing webhook (raw event body, signature-verified) and
 * the refund-policy write (the raw policy object) — their request
 * schemas are `z.unknown()` / `z.record(...)`, not objects with fields.
 *
 * Reuse (no second definition): where the #5604 layer already owns a
 * shape schema for a route (`src/api/requestValidation.ts`), the registry
 * references that schema — profile, onboarding, tenant create/settings,
 * channel patch, slack-channel, webhook-url, account lookup. The registry
 * is the spec + pin contract in this slice: it is NOT wired into live
 * route validation (rewiring 120 operations' accept/reject behavior needs
 * per-route verification — the [Out-of-Scope] follow-up under #5610).
 * Every schema still validates the same shapes the routes accept/return —
 * pinned by `tests/commercial_schemas_5610.test.ts` through
 * `validateRequestShape` + documented-shape acceptance checks.
 */
import { z } from "zod";
import {
  accountLookupQuerySchema,
  channelPatchBodySchema,
  onboardingSaveBodySchema,
  profileSaveBodySchema,
  slackChannelBodySchema,
  tenantCreateBodySchema,
  tenantSettingsBodySchema,
  webhookUrlBodySchema,
} from "./requestValidation";

/** The request + response schemas for one (catalog id, method) operation. */
export interface CboRouteSchemas {
  request: z.ZodType;
  response: z.ZodType;
  /**
   * The success status (default 200). Only set where the inventory
   * states a different one (tenant create + channel checkout return 201).
   */
  successStatus?: number;
}

export type CboCommercialMethod = "GET" | "POST";
export type CboPlatformMethod = "GET" | "POST" | "PATCH" | "PUT";

/** Shared request/response schemas, keyed by commercial catalog id, then method. */
export const COMMERCIAL_SCHEMAS: Record<
  string,
  Partial<Record<CboCommercialMethod, CboRouteSchemas>>
> = {};
/** Shared request/response schemas, keyed by platform catalog id, then method. */
export const PLATFORM_SCHEMAS: Record<
  string,
  Partial<Record<CboPlatformMethod, CboRouteSchemas>>
> = {};

const empty = z.object({});
const code = z.string();
const unknown = z.unknown();
const unknownArray = z.array(z.unknown());

function entry(
  request: z.ZodType,
  response: z.ZodType,
  successStatus?: number,
): CboRouteSchemas {
  return successStatus === undefined ? { request, response } : { request, response, successStatus };
}

/**
 * Convert a zod schema to JSON Schema for the OpenAPI document, reusing
 * zod's own converter (`z.toJSONSchema`, zod 4.x) — no hand-rolled
 * converter, no new dependency. Two honest normalizations: the `$schema`
 * key is dropped (it belongs to a standalone document, not a component),
 * and `additionalProperties: false` becomes `true` everywhere it appears
 * — requests strip unknown keys and responses carry extra fields, so
 * `false` would claim a rejection the server never makes. A typed
 * `additionalProperties` (from `z.record`) is a real constraint and is
 * left alone.
 */
export function zodSchemaToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const converted = z.toJSONSchema(schema) as Record<string, unknown>;
  delete converted.$schema;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.additionalProperties === false) record.additionalProperties = true;
    for (const value of Object.values(record)) walk(value);
  };
  walk(converted);
  return converted;
}

/**
 * The schemas for one (catalog, id, method) operation. Throws when the
 * registry has no entry — fail loud, never emit an un-schematized
 * operation into the spec.
 */
export function cboSchemasFor(
  catalog: "commercial" | "platform",
  id: string,
  method: string,
): CboRouteSchemas {
  const table = catalog === "commercial" ? COMMERCIAL_SCHEMAS : PLATFORM_SCHEMAS;
  const byMethod = table[id]?.[method as CboCommercialMethod & CboPlatformMethod];
  if (!byMethod) {
    throw new Error(`No shared schemas for ${catalog} route ${id} ${method}`);
  }
  return byMethod;
}

/* ================= Commercial catalog (Groups B + C) =================
 * Request/response shapes from the per-route inventory
 * (`~/workspace/cbo-parity/routes.md`); `code` is the outcome-catalog
 * code string where the inventory names it. Nested values are
 * `z.unknown()` unless the inventory enumerates their inner fields.
 */

Object.assign(COMMERCIAL_SCHEMAS, {
  account: {
    GET: entry(
      z.object({ userId: z.string() }),
      z.object({ code, record: unknown, effectiveTier: z.string() }),
    ),
    POST: entry(
      z.object({
        userId: z.string(),
        tenantId: z.string().optional(),
        tier: z.string().optional(),
        creditsUSD: z.number().optional(),
        includedRuns: z.number().optional(),
        unlimitedFreeGrant: unknown.optional(),
      }),
      z.object({ code, record: unknown }),
    ),
  },
  identity: {
    GET: entry(empty, z.object({ code })),
  },
  accountCredits: {
    POST: entry(
      z.object({ userId: z.string(), deltaUSD: z.number() }),
      z.object({ code, record: unknown }),
    ),
  },
  freeRunAllowance: {
    GET: entry(empty, z.object({ code, allowances: unknown })),
    POST: entry(
      z.object({ family: z.string(), runs: z.number() }),
      z.object({ code, family: z.string(), runs: z.number() }),
    ),
  },
  tenantSettings: {
    GET: entry(
      z.object({ tenantId: z.string() }),
      z.object({ code, tenantId: z.string(), adsEnabled: z.boolean() }),
    ),
    POST: entry(
      z.object({ tenantId: z.string(), adsEnabled: z.boolean() }),
      z.object({ code, record: unknown }),
    ),
  },
  submit: {
    POST: entry(
      z.object({
        family: z.string(),
        screenerCommand: z.string(),
        email: z.string().optional(),
        authorizedAtSubmission: z.unknown().optional(),
        scheduleKind: z.string().optional(),
        trigger: z.string().optional(),
      }),
      z.object({
        code,
        runRequestId: z.string(),
        workflowId: z.string(),
        status: z.string(),
        creditRunId: z.string().optional(),
      }),
    ),
  },
  submissionStatus: {
    GET: entry(
      z.object({ workflowId: z.string() }),
      z.object({
        code,
        workflowId: z.string(),
        status: z.string(),
        outcome: unknown.optional(),
        outcomeCode: z.string().optional(),
      }),
    ),
  },
  plans: {
    GET: entry(empty, z.object({ code, plans: unknownArray })),
    POST: entry(
      z.object({
        id: z.string().optional(),
        productId: z.string(),
        name: z.string(),
        priceUSD: z.number(),
        periodDays: z.number(),
        includedRuns: z.number(),
        billingPeriod: z.string().optional(),
        trialDays: z.number().optional(),
        segment: z.string().optional(),
        effectiveFromMs: z.number().optional(),
        effectiveToMs: z.number().optional(),
        stripePriceId: z.string().optional(),
        featuresJson: z.string().optional(),
        monthlyPlanId: z.string().optional(),
      }),
      z.object({ plan: unknown, code, message: z.string() }),
    ),
  },
  plansApprove: {
    POST: entry(
      z.object({ planId: z.string() }),
      z.object({ plan: unknown, code, message: z.string() }),
    ),
  },
  plansDeactivate: {
    POST: entry(
      z.object({ planId: z.string() }),
      z.object({ code, plan: unknown }),
    ),
  },
  bundles: {
    GET: entry(empty, z.object({ bundles: unknownArray })),
    POST: entry(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        memberProductIds: z.array(z.string()),
        priceUSD: z.number(),
        periodDays: z.number(),
        includedRunsPerMember: z.number(),
      }),
      z.object({ bundle: unknown, code, message: z.string() }),
    ),
  },
  bundlesApprove: {
    POST: entry(
      z.object({ bundleId: z.string() }),
      z.object({ bundle: unknown, code, message: z.string() }),
    ),
  },
  bundlesDeactivate: {
    POST: entry(
      z.object({ bundleId: z.string() }),
      z.object({ bundle: unknown }),
    ),
  },
  bundleCheckout: {
    POST: entry(
      z.object({ bundleId: z.string() }),
      z.object({
        checkoutRequestId: z.string(),
        checkoutUrl: z.string(),
        checkoutSessionId: z.string(),
        bundle: unknown,
      }),
    ),
  },
  bundlePurchase: {
    POST: entry(
      z.object({ bundleId: z.string(), checkoutRequestId: z.string(), checkoutSessionId: z.string() }),
      z.object({ purchase: unknown, entitlements: unknown, code, message: z.string() }),
    ),
  },
  subscriptionCheckout: {
    POST: entry(
      z.object({ planId: z.string(), email: z.string(), offerContext: unknown.optional() }),
      z.object({
        code,
        checkoutRequestId: z.string(),
        checkoutUrl: z.string(),
        checkoutSessionId: z.string(),
        plan: unknown,
      }),
    ),
  },
  subscriptionPurchase: {
    POST: entry(
      z.object({ planId: z.string(), checkoutRequestId: z.string(), checkoutSessionId: z.string() }),
      z.object({ code, subscription: unknown, account: unknown, effectiveTier: z.string() }),
    ),
  },
  topUpCheckout: {
    POST: entry(
      z.object({
        amountUSD: z.number(),
        rail: z.string().optional(),
        email: z.string(),
        offerContext: unknown.optional(),
      }),
      z.object({
        topUpRequestId: z.string(),
        checkoutUrl: z.string().optional(),
        checkoutSessionId: z.string().optional(),
        checkoutId: z.string().optional(),
        challenge: unknown.optional(),
      }),
    ),
  },
  topUpConfirm: {
    POST: entry(
      z.object({
        topUpRequestId: z.string(),
        checkoutSessionId: z.string().optional(),
        payer: unknown.optional(),
        paymentProof: unknown.optional(),
      }),
      z.object({
        account: unknown,
        topUpRequestId: z.string(),
        creditedUSD: z.number(),
        rail: z.string(),
      }),
    ),
  },
  subscriptionGrant: {
    POST: entry(
      z.object({ userId: z.string(), planId: z.string(), tenantId: z.string().optional() }),
      z.object({ code, subscription: unknown, account: unknown, effectiveTier: z.string() }),
    ),
  },
  subscriptionTrial: {
    POST: entry(
      z.object({ planId: z.string(), tenantId: z.string().optional() }),
      z.object({
        code,
        subscription: unknown,
        account: unknown,
        effectiveTier: z.string(),
        trialEndsAtMs: z.number(),
      }),
    ),
  },
  subscriptionBillingCheckout: {
    POST: entry(
      z.object({ planId: z.string() }),
      z.object({
        code,
        checkoutRequestId: z.string(),
        checkoutUrl: z.string(),
        checkoutSessionId: z.string(),
        plan: unknown,
      }),
    ),
  },
  subscriptionBillingPurchase: {
    POST: entry(
      z.object({ planId: z.string(), checkoutRequestId: z.string(), checkoutSessionId: z.string() }),
      z.object({ code, subscription: unknown, account: unknown, effectiveTier: z.string() }),
    ),
  },
  billingWebhook: {
    POST: entry(
      unknown,
      z.object({ code, applied: z.boolean(), reason: z.string(), subscriptionId: z.string().optional() }),
    ),
  },
  billingPolicy: {
    GET: entry(empty, z.object({ code, policy: unknown, seedNote: z.string().optional() })),
    POST: entry(
      z.object({
        annualDiscountPct: z.number().optional(),
        offerRules: unknown.optional(),
      }),
      z.object({ code, policy: unknown }),
    ),
  },
  channelCheckout: {
    POST: entry(
      z.object({ family: z.string(), email: z.string() }),
      z.object({ draft: unknown }),
      201,
    ),
  },
  channelPurchase: {
    POST: entry(
      z.object({ channelRequestId: z.string() }),
      z.object({ draft: unknown, account: unknown }),
    ),
  },
  channelPurchases: {
    GET: entry(
      z.object({ userId: z.string().optional() }),
      z.object({ purchases: unknownArray }),
    ),
  },
  channelReconcile: {
    POST: entry(
      z.object({ userId: z.string() }),
      z.object({ verdict: z.string(), local: unknown, reason: z.string().optional() }),
    ),
  },
  subscriptionCancel: {
    POST: entry(
      z.object({ userId: z.string().optional() }),
      z.object({
        userId: z.string(),
        code,
        message: z.string(),
        canceled: unknownArray,
        remaining: unknown,
        accessThroughMs: z.number().optional(),
        downgradeTiming: z.string().optional(),
        canceledBundles: unknownArray,
        bundleCancelFailed: unknownArray,
      }),
    ),
  },
  subscriptionBillingChangePlan: {
    POST: entry(
      z.object({ subscriptionId: z.string(), planId: z.string() }),
      z.object({ code, subscription: unknown, fromPlanId: z.string() }),
    ),
  },
  subscription: {
    GET: entry(
      z.object({ userId: z.string().optional() }),
      z.object({
        code,
        userId: z.string(),
        effectiveTier: z.string(),
        current: unknown,
        subscriptions: unknownArray,
        bundlePurchases: unknownArray,
        bundleEntitlements: unknownArray,
      }),
    ),
  },
  pricing: {
    GET: entry(
      empty,
      z.object({
        code,
        monetizationEnabled: z.boolean(),
        prices: unknown,
        network: z.string().optional(),
        browserPaymentScope: unknown.optional(),
        failurePolicy: unknown.optional(),
      }),
    ),
  },
  prices: {
    GET: entry(empty, z.object({ code, entries: unknownArray })),
    POST: entry(
      z.object({
        family: z.string(),
        priceUSD: z.number().optional(),
        approvalStatus: z.string().optional(),
      }),
      z.object({ code, entry: unknown }),
    ),
  },
  operators: {
    GET: entry(empty, z.object({ code, operators: unknownArray })),
  },
  operatorsAdd: {
    POST: entry(
      z.object({ login: z.string() }),
      z.object({ code, operator: unknown }),
    ),
  },
  operatorsRemove: {
    POST: entry(
      z.object({ login: z.string() }),
      z.object({ code, removed: z.string() }),
    ),
  },
  refunds: {
    GET: entry(
      z.object({ refundId: z.string().optional(), userId: z.string().optional() }),
      z.object({ code, refund: unknown.optional(), refunds: unknownArray.optional() }),
    ),
    POST: entry(
      z.object({
        kind: z.string(),
        originalPaymentRef: z.string(),
        amountUSD: z.number().optional(),
        reason: z.string().optional(),
        originalAmountUSD: z.number().optional(),
        originalPaidAtMs: z.number().optional(),
        rail: z.string().optional(),
        family: z.string().optional(),
      }),
      z.object({ code, refund: unknown }),
    ),
  },
  refundsApprove: {
    POST: entry(
      z.object({ refundId: z.string(), decision: z.string(), note: z.string().optional() }),
      z.object({ code, refund: unknown }),
    ),
  },
  refundsExecute: {
    POST: entry(
      z.object({ refundId: z.string() }),
      z.object({ code, refund: unknown }),
    ),
  },
  refundPolicy: {
    GET: entry(empty, z.object({ code, policy: unknown, disclosure: unknown })),
    POST: entry(
      z.record(z.string(), unknown),
      z.object({ code, policy: unknown }),
    ),
  },
  refundPolicyApprove: {
    POST: entry(
      z.object({ kind: z.string(), approved: z.boolean() }),
      z.object({ code, policy: unknown }),
    ),
  },
  submissionCheckPayment: {
    POST: entry(
      z.object({
        runRequestId: z.string(),
        family: z.string().optional(),
        sessionId: z.string().optional(),
        payer: unknown.optional(),
        paymentProof: unknown.optional(),
      }),
      z.object({
        code,
        runRequestId: z.string(),
        paid: z.boolean(),
        delivered: z.boolean(),
        state: z.string(),
        paymentUrl: z.string().nullable(),
        rail: z.string(),
        challengeFlow: unknown.optional(),
      }),
    ),
  },
  goalCommand: {
    POST: entry(
      z.object({
        jobId: z.string(),
        goalKind: z.string(),
        direction: z.string(),
        symbols: z.array(z.string()),
        tenantId: z.string().optional(),
      }),
      z.object({ code, screenerCommand: unknown }),
    ),
  },
  referralBalance: {
    GET: entry(
      z.object({ userId: z.string() }),
      z.object({ code, userId: z.string(), redeemableUSD: z.number() }),
    ),
  },
  referralRecordEarn: {
    POST: entry(
      z.object({ referrerUserId: z.string(), referredUserId: z.string(), tenantId: z.string() }),
      z.object({ code, earning: unknown }),
    ),
  },
  referralRules: {
    GET: entry(
      z.object({ productId: z.string() }),
      z.object({ productId: z.string(), rules: unknownArray }),
    ),
    POST: entry(
      z.object({
        productId: z.string(),
        issuer: z.string().optional(),
        runsPerCode: z.number().optional(),
        reusable: z.boolean().optional(),
        expiryDays: z.number().optional(),
        attributionMode: z.string().optional(),
        maxRedemptionsPerCode: z.number().optional(),
        maxRedemptionsPerLogin: z.number().optional(),
        globalCap: z.number().optional(),
        active: z.boolean().optional(),
      }),
      z.object({ rule: unknown }),
    ),
  },
  referralAttribute: {
    POST: entry(
      z.object({ referrerUserId: z.string(), referredUserId: z.string(), tenantId: z.string() }),
      z.object({ code, attribution: unknown }),
    ),
  },
  lifecyclePreferences: {
    GET: entry(
      z.object({ userId: z.string(), tenantId: z.string() }),
      z.object({ code, preferences: unknown }),
    ),
    POST: entry(
      z.object({
        userId: z.string(),
        tenantId: z.string(),
        digestEnabled: z.boolean().optional(),
        welcomeEnabled: z.boolean().optional(),
      }),
      z.object({ code, preferences: unknown }),
    ),
  },
  lifecycleWelcome: {
    POST: entry(
      z.object({ userId: z.string(), tenantId: z.string(), email: z.string() }),
      z.object({ sent: z.boolean(), reason: z.string(), code }),
    ),
  },
  lifecycleDigestSend: {
    POST: entry(
      z.object({ userId: z.string(), tenantId: z.string(), email: z.string(), items: unknown }),
      z.object({ sent: z.boolean(), reason: z.string(), code }),
    ),
  },
  lifecycleDigestRunDue: {
    POST: entry(
      z.object({ itemsByUser: unknown }),
      z.object({
        code,
        fired: z.boolean(),
        dateKey: z.string(),
        summary: unknown.optional(),
        reason: z.string().optional(),
      }),
    ),
  },
  lifecycleUnsubscribe: {
    POST: entry(
      z.object({ token: z.string() }),
      z.object({ code, preferences: unknown }),
    ),
  },
  usageBilling: {
    GET: entry(
      z.object({ limit: z.number().optional() }),
      z.object({ usage: unknown, billing: unknown }),
    ),
  },
  approvedFreeQuota: {
    GET: entry(
      z.object({ userId: z.string().optional() }),
      z.object({
        userId: z.string(),
        tenantId: z.string(),
        settings: unknown,
        period: unknown,
        families: unknown,
        grant: unknown,
      }),
    ),
    POST: entry(
      z.object({
        family: z.string(),
        capRuns: z.number(),
        windowKind: z.string().optional(),
        atLimitAction: z.string().optional(),
      }),
      // Two shapes: the per-family write ({family, capRuns, code, message})
      // or the settings write ({settings, code, message}).
      z.union([
        z.object({ family: z.string(), capRuns: z.number(), code, message: z.string() }),
        z.object({ settings: unknown, code, message: z.string() }),
      ]),
    ),
  },
  runsPackCheckout: {
    POST: entry(
      z.object({
        versionId: z.string(),
        rail: z.string().optional(),
        email: z.string(),
        offerContext: unknown.optional(),
      }),
      z.object({
        packRequestId: z.string(),
        checkoutUrl: z.string().optional(),
        checkoutSessionId: z.string().optional(),
        checkoutId: z.string().optional(),
        challenge: unknown.optional(),
        runs: z.number().optional(),
        priceUSD: z.number().optional(),
      }),
    ),
  },
  runsPackConfirm: {
    POST: entry(
      z.object({
        packRequestId: z.string(),
        checkoutSessionId: z.string().optional(),
        payer: unknown.optional(),
        paymentProof: unknown.optional(),
      }),
      z.object({
        account: unknown,
        packRequestId: z.string(),
        creditedRuns: z.number(),
        rail: z.string(),
        packRunsRemaining: z.number(),
      }),
    ),
  },
  referralCodeRules: {
    GET: entry(
      z.object({ productId: z.string() }),
      z.object({ productId: z.string(), rules: unknownArray }),
    ),
    POST: entry(
      z.object({
        productId: z.string(),
        issuer: z.string().optional(),
        runsPerCode: z.number().optional(),
        reusable: z.boolean().optional(),
        expiryDays: z.number().optional(),
        attributionMode: z.string().optional(),
        maxRedemptionsPerCode: z.number().optional(),
        maxRedemptionsPerLogin: z.number().optional(),
        globalCap: z.number().optional(),
        active: z.boolean().optional(),
      }),
      z.object({ rule: unknown }),
    ),
  },
  referralCodeIssue: {
    POST: entry(
      z.object({
        productId: z.string(),
        kind: z.string(),
        issuer: z.string(),
        referrerUserId: z.string().optional(),
        tenantScope: z.string().optional(),
      }),
      z.object({ code: unknown, plaintext: z.string() }),
    ),
  },
  referralCodes: {
    GET: entry(
      z.object({ productId: z.string() }),
      z.object({ productId: z.string(), codes: unknownArray }),
    ),
  },
  referralCodeRevoke: {
    POST: entry(
      z.object({ codeId: z.string() }),
      z.object({ code: unknown }),
    ),
  },
  referralCodeRedeem: {
    POST: entry(
      z.object({ code: z.string() }),
      z.object({
        redemption: unknown,
        runsGranted: z.number(),
        attributionWritten: z.boolean(),
        replayed: z.boolean(),
      }),
    ),
  },
  referralCodesMine: {
    GET: entry(empty, z.object({ codes: unknownArray })),
    POST: entry(
      z.object({ productId: z.string() }),
      z.object({ code: unknown, plaintext: z.string() }),
    ),
  },
  referralCodesMineRevoke: {
    POST: entry(
      z.object({ codeId: z.string() }),
      z.object({ code: unknown }),
    ),
  },
  referralCodesBalance: {
    GET: entry(
      z.object({ userId: z.string() }),
      z.object({ userId: z.string(), codeRunsAvailable: z.number() }),
    ),
  },
  products: {
    GET: entry(empty, z.object({ products: unknownArray })),
    POST: entry(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        kind: z.string(),
        description: z.string().optional(),
        rank: z.number().optional(),
      }),
      z.object({ product: unknown }),
    ),
  },
  offer: {
    POST: entry(
      z.object({
        trigger: z.string(),
        family: z.string(),
        runRequestId: z.string().optional(),
      }),
      z.object({
        trigger: z.string(),
        eligible: z.boolean(),
        reasonCode: z.string().optional(),
        family: z.string().optional(),
        current: unknown.optional(),
        targets: unknownArray.optional(),
      }),
    ),
  },
  offerCompare: {
    GET: entry(
      z.object({ family: z.string().optional() }),
      z.object({
        trigger: z.string(),
        eligible: z.boolean(),
        reasonCode: z.string().optional(),
        family: z.string().optional(),
        current: unknown.optional(),
        targets: unknownArray.optional(),
      }),
    ),
  },
  offerDismiss: {
    POST: entry(
      z.object({ trigger: z.string(), family: z.string().optional() }),
      z.object({ suppressedUntilMs: z.number() }),
    ),
  },
  catalogueVersions: {
    GET: entry(
      z.object({ productId: z.string(), segment: z.string().optional() }),
      z.object({ product: unknown, versions: unknownArray }),
    ),
    POST: entry(
      z.object({
        family: z.string(),
        priceUSD: z.number(),
        segment: z.string().optional(),
        effectiveFromMs: z.number(),
        effectiveToMs: z.number().optional(),
      }),
      z.object({ entry: unknown }),
    ),
  },
  freeAccessGrant: {
    POST: entry(
      z.object({
        userId: z.string(),
        kind: z.string(),
        expiresAtMs: z.number().optional(),
        reason: z.string().optional(),
      }),
      z.object({ granted: unknown, replaced: z.boolean() }),
    ),
  },
  freeAccessRevoke: {
    POST: entry(
      z.object({ userId: z.string(), reason: z.string().optional() }),
      z.object({ revoked: unknown }),
    ),
  },
  freeAccess: {
    GET: entry(
      z.object({ userId: z.string() }),
      z.object({ userId: z.string(), active: z.boolean(), history: unknown }),
    ),
  },
});

/* ---- Group C — parameterized commercial routes (#5610) ---- */

Object.assign(COMMERCIAL_SCHEMAS, {
  subscriptionMove: {
    POST: entry(
      z.object({ toVersionId: z.string(), reason: z.string().optional() }),
      z.object({
        subscription: unknown,
        moved: z.boolean(),
        fromVersionId: z.string(),
        toVersionId: z.string(),
      }),
    ),
  },
  accountSegment: {
    POST: entry(
      z.object({ segment: z.string(), reason: z.string().optional() }),
      z.object({ account: unknown, previousSegment: z.string(), segment: z.string() }),
    ),
  },
  productRank: {
    POST: entry(
      z.object({ rank: unknown }),
      z.object({ product: unknown }),
    ),
  },
  productVersions: {
    GET: entry(
      z.object({ segment: z.string().optional() }),
      z.object({ product: unknown, versions: unknownArray }),
    ),
    POST: entry(
      // Either subscription-version fields or runs-pack fields
      // (`runs`, `priceUSD`); the route discriminates on the shape.
      z.union([
        z.object({
          periodDays: z.number(),
          includedRuns: z.number(),
          priceUSD: z.number(),
          trialDays: z.number().optional(),
          segment: z.string().optional(),
          effectiveFromMs: z.number().optional(),
          effectiveToMs: z.number().optional(),
          billingPeriod: z.string().optional(),
          features: unknown.optional(),
          stripePriceId: z.string().optional(),
        }),
        z.object({ runs: z.number(), priceUSD: z.number() }),
      ]),
      z.object({ version: unknown.optional(), plan: unknown.optional() }),
    ),
  },
  versionApprove: {
    POST: entry(
      empty,
      z.object({
        version: unknown.optional(),
        plan: unknown.optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      }),
    ),
  },
  versionDeactivate: {
    POST: entry(
      empty,
      z.object({ version: unknown.optional(), plan: unknown.optional() }),
    ),
  },
  productBulkMove: {
    POST: entry(
      z.object({
        reason: z.string(),
        segmentScope: z.string().optional(),
        dryRun: z.boolean().optional(),
        resumeBulkMoveId: z.string().optional(),
        limit: z.number().optional(),
      }),
      z.object({
        bulkMove: unknown,
        preview: unknownArray,
        movedCount: z.number(),
        skippedCount: z.number(),
        failedCount: z.number(),
        hasMore: z.boolean(),
        failures: unknownArray,
      }),
    ),
  },
  productBulkMoves: {
    GET: entry(empty, z.object({ bulkMoves: unknownArray })),
  },
  productBulkMoveDetail: {
    GET: entry(empty, z.object({ bulkMove: unknown, moves: unknownArray })),
  },
});

/* ================= Platform catalog (Groups E–H) =================
 * Request schemas reuse the #5604 shape schemas where they exist
 * (profile, onboarding, tenant create/settings, channel patch,
 * slack-channel, webhook-url, account lookup) — one definition, not a
 * second one. Response shapes from the inventory (Groups E–H).
 */

Object.assign(PLATFORM_SCHEMAS, {
  accountSelf: {
    GET: entry(
      empty,
      z.object({
        identity: unknown,
        subscriptions: unknownArray,
        catalogue: unknownArray,
        catalogueAvailable: z.boolean(),
      }),
    ),
  },
  accountSetup: {
    POST: entry(
      z.object({ referralCode: z.string().optional() }),
      z.object({
        created: z.boolean(),
        identity: unknown,
        subscriptions: unknownArray,
        catalogue: unknownArray,
        catalogueAvailable: z.boolean(),
      }),
    ),
  },
  accountLookup: {
    GET: entry(
      accountLookupQuerySchema,
      z.object({
        identity: unknown,
        subscriptions: unknownArray,
        catalogue: unknownArray,
        catalogueAvailable: z.boolean(),
      }),
    ),
  },
  onboardingState: {
    GET: entry(empty, z.object({ state: unknown })),
    POST: entry(
      onboardingSaveBodySchema,
      z.object({ state: unknown }),
    ),
  },
  accountProfile: {
    GET: entry(
      empty,
      z.object({
        code,
        message: z.string(),
        displayName: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
      }),
    ),
    POST: entry(
      profileSaveBodySchema,
      z.object({
        code,
        message: z.string(),
        displayName: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
      }),
    ),
  },
  tenants: {
    GET: entry(empty, z.object({ tenants: unknownArray })),
    POST: entry(
      tenantCreateBodySchema,
      z.object({ tenant: unknown, creationMode: z.string().optional() }),
      201,
    ),
  },
  tenantDetail: {
    GET: entry(empty, z.object({ tenant: unknown })),
  },
  tenantSettings: {
    PATCH: entry(
      tenantSettingsBodySchema,
      z.object({ tenant: unknown }),
    ),
  },
  channelRead: {
    GET: entry(
      empty,
      z.object({
        tenantId: z.string(),
        channels: unknown,
        slackChannel: z.string().optional(),
        webhookUrl: z.string().optional(),
        scheduleWebhookUrls: unknown.optional(),
      }),
    ),
  },
  channelPatch: {
    PATCH: entry(
      channelPatchBodySchema,
      z.object({
        tenantId: z.string(),
        channels: unknown,
        slackChannel: z.string().optional(),
      }),
    ),
  },
  channelSlackChannel: {
    GET: entry(empty, z.object({ tenantId: z.string(), slackChannel: z.string().nullable() })),
    PUT: entry(
      slackChannelBodySchema,
      z.object({ tenantId: z.string(), slackChannel: z.string().nullable() }),
    ),
    PATCH: entry(
      slackChannelBodySchema,
      z.object({ tenantId: z.string(), slackChannel: z.string().nullable() }),
    ),
  },
  channelWebhookUrl: {
    GET: entry(
      z.object({ scheduleId: z.string().optional() }),
      z.object({
        tenantId: z.string(),
        scheduleId: z.string().optional(),
        webhookUrl: z.string().nullable(),
        scheduleWebhookUrls: unknown.optional(),
      }),
    ),
    PUT: entry(
      webhookUrlBodySchema,
      z.object({
        tenantId: z.string(),
        scheduleId: z.string().optional(),
        webhookUrl: z.string().nullable(),
      }),
    ),
    PATCH: entry(
      webhookUrlBodySchema,
      z.object({
        tenantId: z.string(),
        scheduleId: z.string().optional(),
        webhookUrl: z.string().nullable(),
      }),
    ),
  },
  userMe: {
    GET: entry(
      empty,
      z.object({
        identity: unknown,
        account: unknown,
        memberships: unknownArray,
        currentTenantId: unknown.optional(),
      }),
    ),
  },
  userLookup: {
    GET: entry(
      z.object({ login: z.string() }),
      z.object({
        identity: unknown,
        account: unknown,
        memberships: unknownArray,
        currentTenantId: unknown.optional(),
      }),
    ),
  },
});
