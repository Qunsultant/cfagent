/**
 * #1768 (parent #1717, F-39): JSON-Schema-style ingress validation
 * for the webhook ingress path, replacing manual property parsing
 * with a zod schema — without changing any accepted/rejected outcome
 * the NLQ webhook handler already pins.
 *
 * The schema validates SHAPE only (field presence + JSON types):
 * - query: string (the handler still enforces non-empty-after-trim,
 *   the 4,000-char bound, and sanitization, in its existing order);
 * - timestamp: string (the handler still enforces the 5-minute
 *   window — a string that is not a date stays a 401 there);
 * - emailTo: string when present (the handler still enforces its
 *   format regex + domain allowlist);
 * - userId: unknown when present (a non-string userId is NOT an
 *   error today — it falls back to the service login — so the schema
 *   must not newly reject it).
 *
 * One behavior repair, stated honestly: a JSON body that is not an
 * object (null, a number, a bare string) previously threw on
 * `body.query` and surfaced as a 500 through the error boundary;
 * the schema now maps it to the existing 400 query message.
 */

import { z } from "zod";

export const nlqWebhookBodySchema = z.object({
  query: z.string(),
  timestamp: z.string(),
  emailTo: z.string().optional(),
  userId: z.unknown().optional(),
});

export type NlqWebhookBody = z.infer<typeof nlqWebhookBodySchema>;

/**
 * Issue #3311 — webhook-triggered scheduling: the signed body a
 * workflow step posts to POST /api/schedules/webhook/followup.
 *
 * Same contract as the NLQ schema above: SHAPE only. The edge
 * handler still enforces the 5-minute timestamp window, the 128 KB
 * cap, and replay; the DO route still enforces the capability
 * allow-list, the runAt parse, and the per-capability requirements
 * (channel/artifacts for deliver, channel/event for notify).
 *
 * - workflowId: the originating workflow run (required — the
 *   correlation ID the follow-up joins on).
 * - scheduleId / asyncJobId: the schedule / parent job the follow-up
 *   follows up (optional — absent reads as an explicit null).
 * - capability: the T4 follow-up family only (the allow-list; the
 *   builder refuses anything else).
 * - runAt: ISO timestamp of the deferred firing (parsed by the
 *   builder; a past time fires immediately, per the async-job
 *   not-before guard).
 * - userLogin: the run-as owner, asserted by the HMAC-authenticated
 *   platform caller; login-shaped only (the edge stamps it onto the
 *   forwarded request, never a caller header).
 * - outcome: the screener run outcome the follow-up acts on. Required
 *   fields are the ones minting reads (kind / trigger / success /
 *   pdfKeys); the rest passes through untouched for the follow-up
 *   executor (artifact keys, statuses, universe/thesis) — hence
 *   `.passthrough()`, not a strip: a stripped outcome would mint a
 *   follow-up the executor cannot serve.
 * - timestamp: the provider timestamp for the 5-minute window.
 */
export const scheduleWebhookOutcomeSchema = z
  .object({
    kind: z.enum(["stock", "options", "discovery", "goal"]),
    trigger: z.enum(["manual", "scheduled"]),
    success: z.boolean(),
    pdfKeys: z.array(z.string()),
    scheduleId: z.string().optional(),
    workflowId: z.string().optional(),
  })
  .passthrough();

export const scheduleWebhookFollowupBodySchema = z.object({
  workflowId: z.string().min(1).max(200),
  scheduleId: z.string().min(1).max(200).optional(),
  asyncJobId: z.string().min(1).max(200).optional(),
  capability: z.enum(["followup.report", "followup.deliver", "followup.notify"]),
  runAt: z.string().min(1),
  userLogin: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  outcome: scheduleWebhookOutcomeSchema,
  channel: z.enum(["email", "slack", "webhook"]).optional(),
  artifacts: z.array(z.object({ key: z.string(), fileName: z.string() })).optional(),
  event: z.enum(["started", "completed", "failed", "delivered"]).optional(),
  retryOf: z.string().min(1).max(200).optional(),
  chainId: z.string().min(1).max(200).optional(),
  timestamp: z.string(),
});

export type ScheduleWebhookFollowupBody = z.infer<typeof scheduleWebhookFollowupBodySchema>;
