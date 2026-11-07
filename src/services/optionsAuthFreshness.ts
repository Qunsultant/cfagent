/**
 * Options F1 auth guard — issue #2599 (F1 only).
 *
 * The gap this closes: the verify → renew → block policy in
 * etradeAuthPreflight.ts guarded SCHEDULED runs only, so the manual
 * panel routes (POST /trading/options/strategies, /best-trade)
 * scanned with no preflight at all — a dead/expired E*TRADE token
 * failed mid-scan with a raw broker error instead of failing the run
 * before any scan. This module extends that same policy to manual
 * panel runs; it does not reimplement it (preflightETradeAuth stays
 * the one policy) and it does not change selection, ranking,
 * pricing, flags, or delivery.
 *
 * The three modes, documented here because the run record and the
 * response carry only the label, never the reasoning:
 *
 * - LIVE: the token verifies (or renews) and the chain snapshot is
 *   at most DEFAULT_OPTIONS_CHAIN_MAX_AGE_MINUTES old. The run
 *   proceeds and the snapshot is labelled fresh.
 * - DEGRADED (labelled, never silent): the token verifies but the
 *   snapshot is older than the threshold, or its scan timestamp is
 *   missing/unparseable so its age is unknown. The run MAY proceed —
 *   stored-data analysis is legitimate — but only with the stale /
 *   unknown label attached to the unified run record's feed evidence
 *   (the durable, Docs-visible surface), so stale chains are never
 *   presented as live. Degraded is a label, not a fallback: nothing
 *   is substituted for the missing live chains (see below).
 *
 * Where the label is computed matters: the panel route file
 * (src/agents/routes/etradeOptions.ts) sits 90 B under the #359
 * 50 KB ratchet on main (tests/etrade_routes_resplit_995.test.ts),
 * so the route call MUST stay terse — one import, two lines, no
 * comment; the reasoning lives here, in panelAuthResponse's
 * docstring. The freshness label itself is derived in the record
 * layer (recordStrategyScreenRun, from screen.scannedAt), never in
 * the route, and the transient response carries no label field:
 * the unified run record is the label surface. Do not re-add probe
 * code to the route without re-checking the ratchet.
 * - BLOCKED: the token is past its midnight-ET expiry and renewal
 *   failed, or no session exists in PROD. No scan runs at all. The
 *   caller gets a catalog-coded 401 (FAILURE_AUTH_TOKEN_EXPIRED or
 *   FAILURE_AUTH_NO_SESSION, resolved through the single outcome
 *   catalog via codedMessage — no second catalog, no new codes).
 *
 * One alert per episode, preserved: the scheduled guard already
 * deduplicates alerts per user per ET calendar day
 * (etradeAuthEpisodeKey / fireAuthEpisodeAlertOnce). The manual
 * guard in this module sends NO additional alert — the caller is
 * the signed-in user and the synchronous coded 401 IS the notice,
 * so a blocked manual run cannot double-alert an episode the
 * scheduled guard already announced. Subsequent blocked runs stay
 * quiet on both paths.
 *
 * Never Yahoo-substituted chains: the Yahoo adapter declares
 * quotes / historicalBars / fundamentals only — no optionsChains
 * (src/trading/dataProviders/adapters.ts) — and the live options
 * path is broker-chains-only, never a generated fallback (issue
 * #65, src/trading/options/optionsDataAgent.ts). This module adds
 * no provider fallback and no substitution: when live chains cannot
 * be fetched for auth reasons, the run blocks (above) rather than
 * serving another provider's data as if it were the chain.
 *
 * Fail-open, like the scheduled guard: if the guard itself errors
 * (token-store blip, identity lookup failure), the run proceeds
 * and the pipeline's own auth surfacing owns the error, exactly as
 * before #1174. A guard must never take a run down with it, and
 * must never fail closed on its own internal failure.
 *
 * Scope guard: this module implements F1 only. F2–F8 ship in the
 * same #2599 branch (see changelog.d/2599-failures-f2-f8.md);
 * nothing in this module touches the artifact pipeline, the
 * scope resolver (#2583), or any recorder other than the
 * additive feed-evidence fields the unified run record already
 * carries.
 */

import type { Env } from "../types";
import {
  etradeIdentityFromLogin,
  type ETradeTokenIdentity,
} from "../security/etradeOAuth";
import {
  bindETradeAuthPreflightDeps,
  preflightETradeAuth,
  type ETradeAuthPreflightDeps,
} from "./etradeAuthPreflight";
import { codedMessage } from "../outcomes/outcomeAspects";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/optionsAuthFreshness",
});


/**
 * Slice-chosen default for the degraded-mode threshold, in minutes.
 * There is no pre-existing chain-age constant to reuse (the options
 * screen's maxQuoteAgeSeconds is a caller-supplied quote filter, a
 * different quantity), so this default is named here, documented
 * here, and overridable per classifyChainFreshness call — it is not
 * a product-wide constant smuggled in through a default.
 */
export const DEFAULT_OPTIONS_CHAIN_MAX_AGE_MINUTES = 15;

export type ChainFreshnessState = "fresh" | "stale" | "unknown";

/** The freshness label carried on the response and the run record. */
export interface ChainFreshness {
  state: ChainFreshnessState;
  /** Whole minutes since the scan, or null when the age is unknown. */
  ageMinutes: number | null;
  /** Human-readable label; stale/unknown labels always say so. */
  label: string;
}

/**
 * Classify a chain snapshot's freshness from its scan timestamp.
 * Pure and total: a missing, empty, or unparseable timestamp is
 * "unknown" (degraded, labelled), never guessed fresh; a future
 * timestamp (clock skew) clamps to age 0, i.e. fresh. The boundary
 * is inclusive: age exactly equal to the threshold is fresh, age
 * one minute past it is stale.
 */
export function classifyChainFreshness(
  scannedAt: string | null | undefined,
  nowMs: number,
  maxAgeMinutes: number = DEFAULT_OPTIONS_CHAIN_MAX_AGE_MINUTES,
): ChainFreshness {
  const scannedMs = scannedAt ? Date.parse(scannedAt) : NaN;
  if (Number.isNaN(scannedMs)) {
    return {
      state: "unknown",
      ageMinutes: null,
      label:
        "chain age unknown — no usable scan timestamp (degraded, labelled)",
    };
  }
  const ageMinutes = Math.max(
    0,
    Math.floor((nowMs - scannedMs) / 60_000),
  );
  if (ageMinutes <= maxAgeMinutes) {
    return {
      state: "fresh",
      ageMinutes,
      label: `live chains, ${ageMinutes}m old`,
    };
  }
  return {
    state: "stale",
    ageMinutes,
    label:
      `chains ${ageMinutes}m old — stale, older than ${maxAgeMinutes}m ` +
      "(degraded, labelled)",
  };
}

export interface ManualOptionsAuthGuardOptions {
  env: Env;
  userLogin: string;
  environment?: string;
  /** Issue #2440: the run-as login's session identity, so tokens
   *  stored under internal-id or alias-login keys resolve exactly
   *  as the panel seam resolves them. Absent → the legacy
   *  login-scoped + unscoped lookup, unchanged. */
  identity?: ETradeTokenIdentity;
  /** Test seam: preflight deps (default: bound to the real store). */
  deps?: ETradeAuthPreflightDeps;
}

export type ManualOptionsAuthGuardResult =
  | { proceed: true; renewed: boolean }
  /** Blocked before any scan: the caller renders `error` verbatim
   *  (it already carries its catalog code) with HTTP `status`. */
  | { proceed: false; status: 401; error: string };

/**
 * The manual panel-run guard: the scheduled verify → renew → block
 * policy, applied before any scan, with no alert of its own (see
 * the module header: the synchronous coded 401 is the notice).
 * Never throws: on any internal failure the run proceeds and the
 * pipeline's own auth surfacing owns the error.
 */
export async function guardManualOptionsAuth(
  opts: ManualOptionsAuthGuardOptions,
): Promise<ManualOptionsAuthGuardResult> {
  try {
    const deps = opts.deps ?? bindETradeAuthPreflightDeps(opts.env);
    const pre = await preflightETradeAuth(
      deps,
      opts.userLogin,
      opts.environment,
      opts.identity,
    );
    if (pre.status === "ok") return { proceed: true, renewed: pre.renewed };
    // Non-production no-tokens keeps the legacy pass-through: the
    // caller's normal auth-failure path owns that state (the
    // account was never connected here, not an expiry episode).
    if (pre.status === "no-tokens") return { proceed: true, renewed: false };
    const error =
      pre.reason === "no-session"
        ? codedMessage(
            "FAILURE_AUTH_NO_SESSION",
            "no stored session exists for this account in PROD mode. " +
              "Connect your E*TRADE account in Settings to resume options runs. " +
              "No scan ran.",
          )
        : codedMessage(
            "FAILURE_AUTH_TOKEN_EXPIRED",
            "the access token is past its midnight-ET expiry and automatic " +
              "renewal failed. Reconnect your account in Settings to resume " +
              "options runs. No scan ran.",
          );
    return { proceed: false, status: 401, error };
  } catch (err) {
    structuredLog.warn("optionsAuthFreshness.manual_auth_guard_error", {
      message: "[optionsAuthFreshness] manual auth guard error (proceeding without it)",
      error: err instanceof Error ? err.message : String(err),
    });
    return { proceed: true, renewed: false };
  }
}

/**
 * The route-facing seam for the manual panel guard, kept terse on
 * purpose: src/agents/routes/etradeOptions.ts sits 276 B under the
 * #359 50 KB ratchet on main, so the route call is one import plus
 * two lines (`const blocked = await panelAuthResponse(...); if
 * (blocked) return blocked;`) with no comment — this docstring is
 * the comment. It resolves the run-as login's session identity
 * (#2440, so internal-id / alias-login tokens resolve exactly as
 * the panel seam resolves them), runs guardManualOptionsAuth, and
 * maps a block to its coded 401 Response; null means proceed.
 * Never throws (both callees never throw; a block is a Response,
 * not an exception). `deps` is the test seam, passed through.
 */
export async function panelAuthResponse(
  env: Env,
  userLogin: string,
  environment?: string,
  deps?: ETradeAuthPreflightDeps,
): Promise<Response | null> {
  const result = await guardManualOptionsAuth({
    env,
    userLogin,
    environment,
    identity: await etradeIdentityFromLogin(env, userLogin),
    ...(deps ? { deps } : {}),
  });
  if (result.proceed) return null;
  return Response.json({ error: result.error }, { status: result.status });
}
