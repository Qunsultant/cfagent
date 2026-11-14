/**
 * Issue #3239 — client side of the #2373 paid seam for manual stock screens.
 *
 * The server seam (src/agents/routes/paidStockScreenSeam.ts) refuses a
 * SYNC screen with 402 `monetization_enabled_workflow_required` when
 * monetization is ON; the paid path is async submission (`async: true`)
 * plus the checkout contact (`email`). These pure helpers are the ONE
 * mapping every manual screen call site shares, so a server error code
 * is never rendered raw and the paid request is built identically
 * everywhere. No DOM, no fetch implementation: call sites pass their
 * own pricing reader, so the helpers stay unit-testable in node.
 */

/** The server seam's refusal code for a sync screen under monetization ON. */
export const MONETIZATION_WORKFLOW_ERROR = "monetization_enabled_workflow_required";

/** The broker gate's refusal code for a surface the selected broker does not implement (#4430). */
export const BROKER_UNAVAILABLE_ERROR = "FAILURE_BROKER_UNAVAILABLE";

/** The coded business message for a broker-unavailable refusal (#4430). */
export const BROKER_UNAVAILABLE_MESSAGE =
  "This broker surface is not available for the selected broker. Change the broker selection in Settings.";

/** The paid seam's refusal code when payment is needed but no checkout contact was supplied (#2373 S1b). */
export const CHECKOUT_EMAIL_REQUIRED_ERROR = "checkout_email_required";

/** The provider-mismatch refusal code: the route's implied provider differs from the tenant's stored data-provider selection (#2373 S1b, F9). */
export const PROVIDER_MISMATCH_ERROR = "FAILURE_PROVIDER_MISMATCH";

/** The coded business message for a provider-mismatch refusal (#2373 S1b, F9). */
export const PROVIDER_MISMATCH_MESSAGE =
  "The screen provider does not match the tenant's selected data provider. Change the provider selection in Settings.";

/** The approved-free quota cap refusal codes: the gate refuses the run with no fall-through (#3241, surfaced by the #2373 S1b probe). */
export const APPROVED_FREE_QUOTA_EXHAUSTED_ERROR = "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED";
export const APPROVED_FREE_QUOTA_EXHAUSTED_STOP_ERROR = "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED_STOP";

/** The fixed message for an approved-free quota cap refusal (#2373 S1b): payment does not help — the run is refused, not payable. */
export const APPROVED_FREE_QUOTA_EXHAUSTED_MESSAGE =
  "The approved-free quota for this service is exhausted for this period. Nothing runs over the allowance — try again next period.";

/** True when the failure is the provider-mismatch 409 refusal, by status and code (#2373 S1b, F9). */
export function isProviderMismatchError(status: number, error?: string, code?: string): boolean {
  return status === 409 && (error === PROVIDER_MISMATCH_ERROR || code === PROVIDER_MISMATCH_ERROR);
}

/** True when the failure is the seam's checkout-contact 400, by status and code (#2373 S1b). */
export function isCheckoutEmailRequiredError(status: number, error?: string, code?: string): boolean {
  return (
    status === 400 &&
    (code === CHECKOUT_EMAIL_REQUIRED_ERROR ||
      (typeof error === "string" && /checkout contact/i.test(error) && /required/i.test(error)))
  );
}

/** True when the failure is the gate's approved-free quota cap refusal, by status and code (#2373 S1b). */
export function isApprovedFreeQuotaExhaustedError(status: number, code?: string): boolean {
  return (
    status === 402 &&
    (code === APPROVED_FREE_QUOTA_EXHAUSTED_ERROR || code === APPROVED_FREE_QUOTA_EXHAUSTED_STOP_ERROR)
  );
}

/**
 * Read the renderable error text out of a screen error body (#4430).
 * Server bodies carry the reason under `error` or under `message`
 * (the 409 broker-gate body carried `message` only, so call sites
 * that read `error` alone dropped the real reason). `code` alone is
 * a bare machine label and is never returned as the message here —
 * callers that need the code read it from the body themselves.
 */
export function readScreenErrorText(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim() !== "") return record.error;
  if (typeof record.message === "string" && record.message.trim() !== "") return record.message;
  return undefined;
}

/** True when the failure is the broker gate's 409 refusal, by status and code (#4430). */
export function isBrokerUnavailableError(status: number, error?: string, code?: string): boolean {
  return status === 409 && (error === BROKER_UNAVAILABLE_ERROR || code === BROKER_UNAVAILABLE_ERROR);
}

/**
 * Map a screen error body to its UI message (#4430). Reads `error`
 * or `message` (whichever the body carries) and the `code`, so the
 * 409 broker refusal maps to its business message instead of the
 * generic 409 text at every call site.
 */
export function mapScreenErrorFromBody(
  status: number,
  data: unknown,
): string {
  const code =
    data && typeof data === "object" && typeof (data as Record<string, unknown>).code === "string"
      ? ((data as Record<string, unknown>).code as string)
      : undefined;
  return mapScreenError(status, readScreenErrorText(data), code);
}

/** Monetization flag as the client knows it. "unknown" = the pricing read failed. */
export type MonetizationState = "on" | "off" | "unknown";

export interface PaidScreenOptions {
  monetization: MonetizationState;
  checkoutEmail: string;
}

/**
 * The paid POST body: async rides whenever monetization is known
 * ON, and the checkout email rides only when one is present
 * (issue #2373 S1b, gate-before-email — a covered run starts
 * with no email demanded, so the body carries async without an
 * email and the server gate decides coverage first). Every other
 * state returns the body untouched, so flag-OFF behavior is
 * byte-identical to today.
 */
export function buildPaidScreenBody(
  body: Record<string, unknown>,
  opts: PaidScreenOptions,
): Record<string, unknown> {
  if (opts.monetization !== "on") return body;
  const email = opts.checkoutEmail.trim();
  return email ? { ...body, async: true, email } : { ...body, async: true };
}

/**
 * The paid GET query (market-data route: async rides `async=1`, the
 * checkout contact rides `email`). Same gating as the POST body:
 * async rides whenever monetization is known ON, the email only
 * when one is present (issue #2373 S1b); the input params are
 * never mutated.
 */
export function buildPaidScreenQuery(
  params: URLSearchParams,
  opts: PaidScreenOptions,
): URLSearchParams {
  if (opts.monetization !== "on") return params;
  const email = opts.checkoutEmail.trim();
  const next = new URLSearchParams(params);
  next.set("async", "1");
  if (email) next.set("email", email);
  return next;
}

/** True when the failure is the paid seam's sync refusal, by status or by code. */
export function isMonetizationWorkflowError(status: number, error?: string): boolean {
  return status === 402 && error === MONETIZATION_WORKFLOW_ERROR;
}

/** True for the seam's 202 shape: payment started for this run request. */
export function isPaymentStarted(
  data: unknown,
): data is { status: string; runRequestId: string; workflowId?: string } {
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  return record.status === "payment_started" && typeof record.runRequestId === "string";
}

/** A bare snake_case machine code — never renderable as a page message. */
function isBareCode(value: string): boolean {
  return /^[a-z0-9]+(_[a-z0-9]+)+$/.test(value.trim());
}

/**
 * Outcome-encoded screen error with remediation. Known codes map to
 * fixed messages; a descriptive sentence is kept (it IS the remediation
 * — e.g. a 400 field error or a 500 upstream message pinned by
 * #2438's "upstream down" test); a single token or bare code can only
 * be a machine label, never a message, so it maps to a fixed status
 * message. A raw server code is never returned.
 */
export function mapScreenError(status: number, error?: string, code?: string): string {
  const raw = (error ?? "").trim();
  // Issue #4430: the broker gate's 409 refusal maps to its coded
  // business message plus the switch-to-workflow-variant remediation — the
  // workflow-backed variant runs the screen without the broker gate.
  // Never the generic 409 text, never the raw code.
  if (isBrokerUnavailableError(status, raw, code)) {
    return (
      `${BROKER_UNAVAILABLE_MESSAGE} ` +
      "Switch the hub provider to Yahoo Finance to run this screen through the workflow instead."
    );
  }
  // Issue #2373 (S1b, F9): the provider-mismatch 409 maps to its
  // coded business message — never the generic 409 text, never the
  // raw code.
  if (isProviderMismatchError(status, raw, code)) {
    return PROVIDER_MISMATCH_MESSAGE;
  }
  // Issue #2373 (S1b): the approved-free quota cap refusal is a
  // refusal, not a payment prompt — payment does not help, so it
  // maps to its own fixed message, never the generic 402 text.
  if (isApprovedFreeQuotaExhaustedError(status, code)) {
    return APPROVED_FREE_QUOTA_EXHAUSTED_MESSAGE;
  }
  // Any 402 on a screen route is the paid seam's refusal: the seam is
  // the only 402 producer there, whatever body rides with it.
  if (status === 402 || raw === MONETIZATION_WORKFLOW_ERROR) {
    return (
      "Screens require payment while monetization is on. " +
      "Start the run through the payment workflow (Stock Hub → Run a new screen) — no screen has started yet."
    );
  }
  // Issue #2373 (S1b): the seam demands the checkout contact only
  // when the gate says payment is actually needed — by code, or by
  // the message the server still carries for it.
  if (isCheckoutEmailRequiredError(status, raw, code)) {
    return "Enter a checkout email to run this paid screen.";
  }
  if (raw && isBareCode(raw)) {
    return "The screen could not run. Try again later.";
  }
  // A descriptive sentence reads like a message — keep it. A single
  // token does not, so it falls through to the fixed status messages.
  if (raw.includes(" ")) return raw;
  if (status === 401) return "Sign in again to continue.";
  if (status === 403) return "You do not have access to run this screen.";
  if (status === 404) return "This screen service is not deployed yet. Try again after the next release.";
  if (status === 500 || status === 502 || status === 503) {
    return "The screen service is temporarily unavailable. Try again later.";
  }
  if (raw) return raw;
  return `Screening request failed [HTTP ${status}]. Try again.`;
}

/**
 * Read the monetization flag through the caller's pricing reader
 * (commercialApi.getPricing in production). Any read failure yields
 * "unknown": the caller keeps today's sync request and maps a 402 to
 * the payment message with a retry action, instead of guessing.
 */
export async function readMonetizationState(
  fetchPricing: () => Promise<{ monetizationEnabled: boolean }>,
): Promise<MonetizationState> {
  try {
    const pricing = await fetchPricing();
    return pricing.monetizationEnabled ? "on" : "off";
  } catch {
    return "unknown";
  }
}
