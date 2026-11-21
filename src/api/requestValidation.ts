/**
 * Issue #5604 — hardening slice 3 (G-4 validation): ONE shared
 * request-validation helper on zod schemas.
 *
 * Placement: the SHARED validation layer (door/service layer per
 * #5386: "REST, MCP, and chat all validate through the same shared
 * validators"), in `src/api/` alongside `ingressSchemas.ts` — the
 * #1768 zod-schema precedent. The CDO survey (#5387/#5386) has
 * landed no shared-layer home yet (survey-first, no conclusions at
 * slice start), so this file is the pattern-following proposal the
 * filed body names; when the survey lands a home, the helper moves
 * there as one import change, not a rewrite. No second catalog:
 * zod ^4.1.8 is reused as it stands (already a dependency); no new
 * validation framework, no `@hono/zod-validator` (arrives with the
 * Hono foundation slice H-1; #1024 Phase 2 is open).
 *
 * Contract (the #1768 precedent): SHAPE ONLY — field presence +
 * JSON types at the boundary. Business rules (authorization,
 * existence, bounds enforced elsewhere, allowlists, normalizers)
 * stay where they are: the routes and the existing validators keep
 * them, and the schemas below never encode them. The helper never
 * throws and never invents a message: `safeParse` maps to a
 * `{field, kind, path}` issue, and the caller renders its existing
 * message for that field. No store access here, no env reads.
 *
 * One behavior repair, stated honestly (#1768 precedent): a JSON
 * body that is not an object (a scalar, or an array) previously
 * threw on the `in` operator inside the validators and surfaced
 * as a 500 through the route catch; the shape gate now maps it to
 * the existing coded 400 for the route (field `body`). Every other
 * accept/reject outcome is identical — pinned by
 * `tests/request_validation_5604.test.ts`.
 */
import { z } from "zod";

/** Structural shape failure: which field, and which kind — never a message. */
export type ShapeIssueKind = "wrongType" | "missing";

export interface ShapeIssue {
  /** First path segment of the failing value; `"body"` when the body itself is not an object. */
  field: string;
  kind: ShapeIssueKind;
  /** Full zod path (empty for a body-level failure); lets a caller name a nested field. */
  path: string[];
}

export type ShapeResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ShapeIssue[] };

function toShapeIssue(
  issue: { code: string; path: PropertyKey[] },
  body: unknown,
): ShapeIssue {
  const path = issue.path.map((segment) => String(segment));
  // zod v4 reports a missing required field as `invalid_type` with
  // no `received` to read, so "missing" is derived from the input:
  // the failing key is absent from its parent object. A key present
  // with explicit `undefined` IS present (`in` is true) and stays
  // wrongType.
  let kind: ShapeIssueKind = "wrongType";
  if (issue.code === "invalid_type" && path.length > 0) {
    let parent: unknown = body;
    let walkable = true;
    for (let i = 0; i < path.length - 1; i++) {
      if (parent && typeof parent === "object") {
        parent = (parent as Record<string, unknown>)[path[i]!];
      } else {
        walkable = false;
        break;
      }
    }
    if (
      walkable &&
      parent &&
      typeof parent === "object" &&
      !(path[path.length - 1]! in parent)
    ) {
      kind = "missing";
    }
  }
  return { field: path[0] ?? "body", kind, path };
}

/**
 * Validate `body` against a shape-only zod schema. Returns the
 * parsed value (unknown keys stripped — unknown fields are ignored,
 * exactly as the hand-rolled validators ignored them) or the shape
 * issues in schema order. Never throws.
 */
export function validateRequestShape<T>(
  schema: z.ZodType<T>,
  body: unknown,
): ShapeResult<T> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: parsed.error.issues.map((issue) => toShapeIssue(issue, body)) };
}

/**
 * The outcome-catalog code for a malformed request (httpStatus 400;
 * pinned by `tests/request_validation_5604.test.ts` to resolve in
 * the catalog). The agenticPayments precedent
 * (`src/agents/routes/agenticPayments.ts:1126`): `{code, error}` —
 * the code is catalog-coded and the existing specific message stays
 * in `error`, so clients reading `.error` are untouched.
 */
export const REQUEST_INVALID_CODE = "FAILURE_COMMERCIAL_REQUEST_INVALID" as const;

/** Render a coded 400 for a shape failure, keeping the caller's existing message. */
export function requestInvalidResponse(error: string): Response {
  return Response.json({ code: REQUEST_INVALID_CODE, error }, { status: 400 });
}

/* ================= Shared shape predicates =================
 * Verbatim moves of the duplicated predicates the platform route
 * files each defined locally (platformTenants.ts /
 * platformChannels.ts): one implementation of the rule now. The
 * `tenantQueueMapping` copy (`src/security/tenantQueueMapping.ts`)
 * is untouched — outside the converted families; consolidating it
 * is follow-up work, not this slice.
 */

/** Same shape rule as isTenantIdShaped (tenantQueueMapping): non-empty, <=512, no whitespace/control. */
export function isTenantIdShaped(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 512 &&
    !/[\s\x00-\x1F\x7F]/.test(value.trim())
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ================= Shape-only schemas =================
 * Presence + JSON types only. Value bounds, allowlists, and
 * normalizers stay in the routes / validators / ports that own
 * them today; a schema never newly rejects an input those accept.
 */

/** Profile-update fields (#3261): string or null when present, absent when unchanged. */
export const profileInputSchema = z.object({
  displayName: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
});

/**
 * Profile-save body: the profile fields plus the idempotency key
 * (standards §7.2 Idempotent Receiver). Key order is the route's
 * failure order: a bad key reports before a bad profile field,
 * exactly as the route's key-first check does today.
 */
export const profileSaveBodySchema = z.object({
  idempotencyKey: z.string().optional(),
  displayName: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
});

/**
 * Strict audit-write body (#1733 R04): `type` is a string when
 * present (the validator still enforces non-empty-after-trim and
 * the 120-char bound); `agent`, `payload`, and `mode` are unknown
 * by design — a non-string agent falls back to the caller's
 * default, a non-object payload coerces to {} (pinned by
 * `tests/rest_twins_modes_1733.test.ts`), and an invalid `mode`
 * fails closed to legacy in the switch resolver. The schema must
 * not newly reject any of those.
 */
export const strictAuditWriteSchema = z.object({
  type: z.string().optional(),
  agent: z.unknown().optional(),
  payload: z.unknown().optional(),
  mode: z.unknown().optional(),
});

/** Onboarding-state save (#3256): `currentStep` must be present as a number; the 1..5 integer bound stays in the route. */
export const onboardingSaveBodySchema = z.object({
  currentStep: z.number(),
  completed: z.unknown().optional(),
  trialPlanId: z.unknown().optional(),
});

/** Account lookup query (#2222): `userId` must be present as a string; the non-empty check stays in the route. */
export const accountLookupQuerySchema = z.object({
  userId: z.string(),
});

/** Tenant create (#2221): `tenantId` must be present as a string; shape (non-empty, no whitespace) + the `login:` reservation stay in the route. */
export const tenantCreateBodySchema = z.object({
  tenantId: z.string(),
});

/**
 * Tenant settings PATCH (#2221): JSON types only. `intervalS` must
 * be a number and the provider ids strings when present; the
 * positive-integer bound and the non-empty checks stay in the route.
 * `turnStepTimeoutMs` (#5423, #3515 S4) must be a number when
 * present; its bounds (1000–600000 ms) stay in the route.
 */
export const tenantSettingsBodySchema = z.object({
  adsEnabled: z.boolean().optional(),
  autoRefresh: z
    .object({ enabled: z.boolean(), intervalS: z.number() })
    .optional(),
  providers: z
    .object({ dataProviderId: z.string(), brokerId: z.string() })
    .optional(),
  turnStepTimeoutMs: z.number().optional(),
});

/**
 * Channel patch (#3169): `channels` is a map of channel flags to
 * booleans when present; the known-channel allowlist and the
 * "no flag supplied" rule stay in the route. `slackChannel` is
 * unknown by design — its normalizer owns the value rules.
 */
export const channelPatchBodySchema = z.object({
  channels: z.record(z.string(), z.boolean()).optional(),
  slackChannel: z.unknown().optional(),
});

/** Slack-channel write (#3169): `slackChannel` must be present; its normalizer owns the value rules. */
export const slackChannelBodySchema = z.object({
  slackChannel: z.unknown(),
});

/** Webhook-URL write (#3169): `webhookUrl` must be present; its normalizer owns the value rules. `scheduleId` is a string when present, else the query param applies. */
export const webhookUrlBodySchema = z.object({
  webhookUrl: z.unknown(),
  scheduleId: z.unknown().optional(),
});
