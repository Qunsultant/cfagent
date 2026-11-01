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
