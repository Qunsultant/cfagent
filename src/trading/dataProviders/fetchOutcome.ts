/**
 * Issue #1248 (E7 of epic #1116): fetch-outcome tracking — the
 * pattern module. E1's capture log recorded fetches that SUCCEEDED
 * (a capture row) and fetches whose capture WRITE failed (a
 * capture_failed marker), but a fetch that THREW wrote no record
 * at all: provider health (E6) saw real provider failures — the
 * expired-token morning is the worked example — only as staleness.
 * This module is the mechanism that closes the hole, written once
 * and applied at every adapter fetch boundary:
 *
 *  - PORT (Dependency Inversion / Interface Segregation):
 *    `FetchOutcomeRecorder` is a two-method port. Adapters depend
 *    on the port, never on storage; the capture store is the
 *    port's adapter (captureStore.ts: createCaptureFetchOutcome
 *    Recorder), injected through the existing capture-deps seam.
 *  - DECORATOR + TEMPLATE METHOD: `trackFetchOutcome` owns the
 *    skeleton — execute the fetch → record success → return the
 *    value; on throw → classify → record failure → rethrow the
 *    IDENTICAL error object. Recording is best-effort both ways:
 *    a recorder failure never alters the fetch's outcome, its
 *    value, or its error (pinned by reference identity).
 *  - STRATEGY (failure classification): `classifyFetchError` is
 *    one pure function mapping an error's shape — catalog code,
 *    HTTP status, error name/class, message conventions — to a
 *    kind. Kinds are data; no classification conditionals live in
 *    adapters.
 *  - SUCCESS SEMANTICS (no double-writing): on this platform the
 *    success record for a fetch IS its capture row (captured /
 *    no_payload, or the capture_failed marker when the write
 *    itself failed), which the adapter writes for the same fetch
 *    through recordCapture. The port's recordSuccess therefore
 *    attests without writing in the capture-store implementation;
 *    the hook exists so the decorator's skeleton is uniform and a
 *    store that keeps outcomes separately can implement it.
 *  - SCRUBBING: failure messages are stored only after
 *    `scrubFailureMessage` — credential-shaped substrings are
 *    stripped by construction and the result is bounded, so a
 *    failure record can never become a secret leak (pinned with a
 *    hostile fixture in the E7 suite).
 */

import type { DataProviderCapability, DataProviderId } from "./contract";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "trading/dataProviders/fetchOutcome",
});

/** The classified vocabulary of fetch-failure kinds. */
export const FETCH_FAILURE_KINDS = [
  "auth",
  "rate_limit",
  "timeout",
  "network",
  "upstream",
  "parse",
  "unknown",
] as const;
export type FetchFailureKind = (typeof FETCH_FAILURE_KINDS)[number];

export function isFetchFailureKind(value: unknown): value is FetchFailureKind {
  return (
    typeof value === "string" &&
    (FETCH_FAILURE_KINDS as readonly string[]).includes(value)
  );
}

/** Attribution for one fetch attempt — the run/tenant scope the outcome belongs to. */
export interface FetchOutcomeMeta {
  providerId: DataProviderId;
  capability: DataProviderCapability;
  /** The caller's request parameters, in canonical (normalized) form. */
  requestParams?: Record<string, unknown>;
  runId: string;
  tenantId: string;
  userLogin?: string | null;
}

/** One classified failure, as the decorator hands it to the recorder. */
export interface FetchOutcomeFailure {
  kind: FetchFailureKind;
  /** The error's raw message — implementations scrub before storing. */
  message: string;
}

/**
 * The outcome-recording PORT. Implementations MUST NOT throw:
 * recording is bookkeeping about the fetch, never part of it.
 */
export interface FetchOutcomeRecorder {
  recordSuccess(meta: FetchOutcomeMeta): Promise<void>;
  recordFailure(meta: FetchOutcomeMeta, failure: FetchOutcomeFailure): Promise<void>;
}

// ---------------------------------------------------------------------------
// Strategy — failure classification (pure).
// ---------------------------------------------------------------------------

/** E*TRADE catalog codes (src/aspects/errorCodes.ts) with an unambiguous kind. */
const ETRADE_CODE_KINDS: Readonly<Record<string, FetchFailureKind>> = {
  ETRADE_AUTH_REQUIRED: "auth",
  ETRADE_TOKEN_EXPIRED: "auth",
  ETRADE_CREDENTIALS_MISSING: "auth",
  ETRADE_UNAUTHORIZED_ACTION: "auth",
  ETRADE_RATE_LIMITED: "rate_limit",
  ETRADE_UPSTREAM_ERROR: "upstream",
};

function numericStatus(error: Record<string, unknown>): number | null {
  for (const key of ["status", "httpStatus"] as const) {
    const value = error[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function kindFromStatus(status: number): FetchFailureKind | null {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 408) return "timeout";
  if (status >= 400 && status <= 599) return "upstream";
  return null;
}

function kindFromMessage(message: string): FetchFailureKind | null {
  const text = message.toLowerCase();
  if (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("deadline exceeded") ||
    text.includes("request aborted")
  ) {
    return "timeout";
  }
  if (
    text.includes("unauthorized") ||
    text.includes("authentication") ||
    text.includes("auth required") ||
    text.includes("token expired") ||
    text.includes("token missing") ||
    text.includes("credentials missing") ||
    text.includes("no credential") ||
    /\b401\b/.test(text)
  ) {
    return "auth";
  }
  if (
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    /\b429\b/.test(text)
  ) {
    return "rate_limit";
  }
  if (
    text.includes("fetch failed") ||
    text.includes("network") ||
    text.includes("econnreset") ||
    text.includes("econnrefused") ||
    text.includes("enotfound") ||
    text.includes("socket") ||
    text.includes("dns")
  ) {
    return "network";
  }
  if (
    text.includes("unparseable") ||
    text.includes("unexpected token") ||
    text.includes("not valid json") ||
    text.includes("invalid json") ||
    text.includes("could not be mapped") ||
    text.includes("could not be parsed")
  ) {
    return "parse";
  }
  return null;
}

/**
 * Classify one thrown fetch error into its kind. Deterministic and
 * total: rules run from the most structured evidence (catalog
 * code → HTTP status → error name/class) to message conventions,
 * and anything unclassifiable is honestly "unknown" — the
 * classifier never guesses beyond the evidence the error carries.
 *
 * Evidence, per adapter family:
 *  - E*TRADE: ETradeError carries a catalog `code` (auth codes,
 *    RATE_LIMITED, UPSTREAM_ERROR) and an `httpStatus`; the service
 *    layer also throws plain Errors (e.g. "returned no live quote"
 *    — honestly unknown).
 *  - Public: PublicMcpError carries an optional HTTP `status`
 *    (401 is even named in its message: "the access token was
 *    rejected"); its no-credential refusal names the credential;
 *    its JSON-RPC error form is an upstream refusal; an
 *    unparseable response body is a parse failure. PublicDataError
 *    is the payload/schema interpretation layer — parse.
 *  - Transports: fetch aborts surface as AbortError/TimeoutError,
 *    network failures as TypeError ("fetch failed"), JSON decoding
 *    as SyntaxError.
 */
export function classifyFetchError(error: unknown): FetchFailureKind {
  if (typeof error === "string") {
    return kindFromMessage(error) ?? "unknown";
  }
  if (!error || typeof error !== "object") return "unknown";
  const err = error as Record<string, unknown>;
  const name = typeof err.name === "string" ? err.name : "";
  const message = typeof err.message === "string" ? err.message : "";

  // Abort/timeout names outrank everything: an aborted request may
  // carry no other usable evidence.
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  if (err.code === "ABORT_ERR" || err.code === "ERR_TIMEOUT") return "timeout";

  // Structured catalog code (ETradeError.code).
  if (typeof err.code === "string" && err.code in ETRADE_CODE_KINDS) {
    return ETRADE_CODE_KINDS[err.code];
  }

  // HTTP status, wherever the error carries one.
  const status = numericStatus(err);
  if (status !== null) {
    const kind = kindFromStatus(status);
    if (kind) return kind;
  }

  // Parse-layer shapes.
  if (name === "SyntaxError" || error instanceof SyntaxError) return "parse";
  if (name === "PublicDataError") return "parse";

  // PublicMcpError without a status: decide from its own message
  // conventions (see the evidence note above).
  if (name === "PublicMcpError") {
    if (message.includes("unparseable")) return "parse";
    if (message.includes("allow-list")) return "unknown";
    if (message.includes("credential") || message.includes("access token was rejected")) {
      return "auth";
    }
    return "upstream";
  }

  // Message conventions for the unstructured remainder.
  const fromMessage = kindFromMessage(message);
  if (fromMessage) return fromMessage;

  // Per the fetch spec, network-layer failures surface as TypeError.
  if (name === "TypeError" || error instanceof TypeError) return "network";

  return "unknown";
}

// ---------------------------------------------------------------------------
// Scrubbing — failure messages are stored credential-free and bounded.
// ---------------------------------------------------------------------------

/** Stored failure messages never exceed this many characters. */
export const MAX_FAILURE_MESSAGE_LENGTH = 200;

const REDACTED = "[redacted]";

/**
 * Strip credential-shaped substrings from a failure message, then
 * bound it to MAX_FAILURE_MESSAGE_LENGTH characters. Applied at
 * the storage boundary (recordFetchFailure) so no caller can
 * persist an unscrubbed message by forgetting: bearer tokens,
 * authorization headers, key=value credential forms, URL query
 * credentials, JWTs, provider key shapes, and long opaque token
 * runs (hex / base64-ish) are all replaced before storage.
 */
export function scrubFailureMessage(message: string): string {
  let out = String(message ?? "");
  // Authorization headers and bearer tokens, wherever they appear.
  out = out.replace(/authorization\s*[:=]\s*["']?\s*(?:bearer\s+)?[^\s"',}]+["']?/gi, `authorization: ${REDACTED}`);
  out = out.replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  // URL query credentials (?access_token=…&…).
  out = out.replace(/([?&](?:access_token|refresh_token|api_key|apikey|token|secret|key)=)[^&\s]+/gi, `$1${REDACTED}`);
  // key=value / key: value credential forms.
  out = out.replace(
    /\b(access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|client[_-]?secret|secret|password|passwd|token)\b(\s*[:=]\s*)["']?[^\s"',}]+["']?/gi,
    `$1$2${REDACTED}`
  );
  // JWTs (three base64url segments, header segment starts eyJ).
  out = out.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED);
  // Provider key shapes (sk-live-…, pk_test_…, and kin).
  out = out.replace(/\b[a-z]{2,4}[-_](?:live|test)[-_][A-Za-z0-9-_]+/gi, REDACTED);
  // Long hex strings (≥32 chars) — token-shaped.
  out = out.replace(/\b[0-9a-fA-F]{32,}\b/g, REDACTED);
  // Long opaque runs (≥40 chars) mixing letters and digits.
  out = out.replace(/[A-Za-z0-9+/=_-]{40,}/g, (run) =>
    /[A-Za-z]/.test(run) && /[0-9]/.test(run) ? REDACTED : run
  );
  if (out.length > MAX_FAILURE_MESSAGE_LENGTH) {
    out = out.slice(0, MAX_FAILURE_MESSAGE_LENGTH);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decorator + Template Method — the one fetch-outcome wrapper.
// ---------------------------------------------------------------------------

/**
 * Wrap one fetch: on success, record the success and return the
 * fetch's value untouched; on throw, classify + record the failure
 * and rethrow the IDENTICAL error object (reference identity is
 * pinned — adapters' error contracts are unchanged by recording).
 *
 * Recorder calls are guarded here as well as by the port's
 * never-throws contract: a broken recorder degrades to a logged
 * line, never to a changed fetch outcome.
 */
export async function trackFetchOutcome<T>(
  recorder: FetchOutcomeRecorder,
  meta: FetchOutcomeMeta,
  fetchFn: () => Promise<T>
): Promise<T> {
  try {
    const result = await fetchFn();
    try {
      await recorder.recordSuccess(meta);
    } catch (recorderErr) {
      structuredLog.error("fetchOutcome.fetch_outcome_success_recording_failed", {
        message: "[dataProviders] fetch-outcome success recording failed",
        providerId: meta.providerId,
        capability: meta.capability,
        runId: meta.runId,
        error: recorderErr instanceof Error ? recorderErr.message : String(recorderErr),
      });
    }
    return result;
  } catch (err) {
    try {
      await recorder.recordFailure(meta, {
        kind: classifyFetchError(err),
        message: err instanceof Error ? err.message : String(err),
      });
    } catch (recorderErr) {
      structuredLog.error("fetchOutcome.fetch_outcome_failure_recording_failed", {
        message: "[dataProviders] fetch-outcome failure recording failed",
        providerId: meta.providerId,
        capability: meta.capability,
        runId: meta.runId,
        error: recorderErr instanceof Error ? recorderErr.message : String(recorderErr),
      });
    }
    throw err;
  }
}
