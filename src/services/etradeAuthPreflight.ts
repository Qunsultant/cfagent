/**
 * E*TRADE auth pre-flight for scheduled runs (issue #1174, slice S1 of
 * the #1173 screener trust program).
 *
 * Why this exists — the 2026-10-23 overnight incident: E*TRADE OAuth
 * access tokens expire at midnight ET and can only be renewed BEFORE
 * expiry. The one automatic renewal (a 23:00 ET cron) is fire-and-
 * forget, so a single missed/failed renewal turned into six identical
 * scheduled-screen failures overnight (FAILURE_AUTH_TOKEN_EXPIRED), curable only by a
 * manual reconnect nobody was told to perform.
 *
 * This module gives scheduled runs a pre-flight:
 * - verify the stored token before any screening work;
 * - attempt renewal when it is expired;
 * - when unrecoverable, report the run as BLOCKED (not failed) and
 *   raise ONE deduplicated reconnect alert per expiry episode —
 *   subsequent runs in the episode short-circuit quietly.
 *
 * #1200 (same day): production was found to have NO stored session at
 * all — a state the original preflight passed through, so scheduled
 * runs failed identically every cycle with the raw broker errors.
 * No-session in PROD is therefore also a blocked episode (the remedy
 * differs: connect, not reconnect); non-production keeps pass-through.
 *
 * All effects are injected (deps + store + alert sink), so the policy
 * is unit-testable without a broker, a DO, or Slack.
 */

import type { Env } from "../types";
import { resolveEnvironmentConfig } from "../config/environment";
import {
  getStoredTokens,
  isTokenExpiredEt,
  renewETradeAccessToken,
  type ETradeTokenIdentity,
} from "../security/etradeOAuth";
import { codedMessage } from "../outcomes/outcomeAspects";
import { deliverGatedSlack } from "./gatedSlackDelivery";
import type { ScreenerRunOutcome } from "./screenerFollowups";
import {
  formatTraceBlock,
  type ScreenerTrace,
} from "./screenerTrace";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/etradeAuthPreflight",
});

/** Minimal key-value seam (Durable Object storage satisfies it). */
export interface AuthEpisodeStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface ETradeAuthPreflightDeps {
  getTokens: (
    userLogin: string,
    environment?: string,
    /** Issue #2440: the run-as login's session identity. Absent →
     *  today's login-scoped + unscoped lookup, unchanged. */
    identity?: ETradeTokenIdentity
  ) => Promise<{ storedAt: string } | null>;
  renew: (
    userLogin: string,
    environment?: string,
    /** Issue #2440: forwarded to the identity-aware renewal. */
    identity?: ETradeTokenIdentity
  ) => Promise<unknown | null>;
  isExpired: (storedAtIso: string, nowMs: number) => boolean;
  now: () => number;
  /** #1200: is the resolved environment the production one? Bound in
   *  production deps; absent in test seams (legacy no-tokens
   *  pass-through is preserved there). */
  isProduction?: (environment?: string) => boolean;
}

export type ETradeAuthPreflightResult =
  | { status: "ok"; renewed: boolean }
  /** No tokens stored and the environment is NOT production — the
   *  account was never connected here; the caller's normal
   *  auth-failure path owns this state (sandbox/dev semantics). */
  | { status: "no-tokens" }
  /** The run must not proceed. reason "expired": tokens exist but are
   *  past expiry and renewal failed. reason "no-session" (#1200): no
   *  stored session exists in PRODUCTION — a scheduled broker run can
   *  only fail identically every cycle in that state, so it blocks
   *  under the same one-alert-per-episode semantics. */
  | { status: "blocked"; episodeKey: string; reason: "expired" | "no-session" };

/**
 * Episode identity: one alert per user per ET calendar day. A token
 * that dies at midnight ET blocks that whole ET day's runs under one
 * key; if it is still broken the next ET day, that is a new episode
 * and earns exactly one more alert.
 */
export function etradeAuthEpisodeKey(userLogin: string, nowMs: number): string {
  const etDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
  return `etrade:auth-episode:${userLogin}:${etDate}`;
}

/**
 * The pure policy: no tokens → blocked(no-session) in production,
 * no-tokens elsewhere; fresh token → ok; expired token → one renewal
 * attempt → ok(renewed) or blocked(expired).
 */
export async function preflightETradeAuth(
  deps: ETradeAuthPreflightDeps,
  userLogin: string,
  environment?: string,
  /** Issue #2440: the run-as login's session identity, threaded to
   *  the token lookup and renewal so tokens stored under
   *  internal-id or alias-login keys resolve exactly as the panel
   *  seam resolves them. Absent → today's behavior, unchanged. */
  identity?: ETradeTokenIdentity
): Promise<ETradeAuthPreflightResult> {
  const tokens = await deps.getTokens(userLogin, environment, identity);
  if (!tokens) {
    if (deps.isProduction?.(environment)) {
      return {
        status: "blocked",
        reason: "no-session",
        episodeKey: etradeAuthEpisodeKey(userLogin, deps.now()),
      };
    }
    return { status: "no-tokens" };
  }
  if (!deps.isExpired(tokens.storedAt, deps.now())) {
    return { status: "ok", renewed: false };
  }
  const renewed = await deps.renew(userLogin, environment, identity);
  if (renewed) return { status: "ok", renewed: true };
  return {
    status: "blocked",
    reason: "expired",
    episodeKey: etradeAuthEpisodeKey(userLogin, deps.now()),
  };
}

/** Production deps bound to the real OAuth store (etradeOAuth.ts).
 *  Issue #2440: identity forwards to the identity-aware seam, so the
 *  guard resolves the same keys the panel seam resolves. */
export function bindETradeAuthPreflightDeps(env: Env): ETradeAuthPreflightDeps {
  return {
    getTokens: (userLogin, environment, identity) =>
      getStoredTokens(env, userLogin, environment, identity),
    renew: (userLogin, environment, identity) =>
      renewETradeAccessToken(env, userLogin, environment, identity),
    isExpired: (storedAtIso, nowMs) => isTokenExpiredEt(storedAtIso, nowMs),
    now: () => Date.now(),
    isProduction: (environment) =>
      resolveEnvironmentConfig(env, environment).name === "PROD",
  };
}

/**
 * Fire `fire` only when this episode has not alerted yet; records the
 * episode either way it fires. Returns true when the alert fired.
 * Alerting never throws — a failed alert must not break the caller;
 * the episode is still marked so a broken alert channel cannot turn
 * into hourly alert spam (the run record itself carries the state).
 */
export async function fireAuthEpisodeAlertOnce(
  store: AuthEpisodeStore,
  episodeKey: string,
  fire: () => Promise<void>
): Promise<boolean> {
  try {
    const seen = await store.get(episodeKey);
    if (seen) return false;
    await store.put(episodeKey, { alertedAt: new Date().toISOString() });
    await fire();
    return true;
  } catch (err) {
    structuredLog.warn("etrade_auth.episode_alert_failed", {
      message: `[etradeAuthPreflight] episode alert failed for ${episodeKey}: ${err instanceof Error ? err.message : String(err)}`,
      episodeKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** The user-facing blocked message recorded on the run (expired).
 *  Issue #1252 (#1173 R4): rendered through the outcome catalog
 *  (FAILURE_AUTH_TOKEN_EXPIRED) so the run record, the alert, and the logs carry the
 *  same code. */
export function authBlockedMessage(alerted: boolean): string {
  return codedMessage(
    "FAILURE_AUTH_TOKEN_EXPIRED",
    "the access token is past its midnight-ET expiry and automatic " +
      "renewal failed. Reconnect your account in Settings to resume " +
      "scheduled runs. " +
      (alerted
        ? "A reconnect alert has been sent for this episode."
        : "A reconnect alert was already sent for this episode; further runs today stay quiet."),
  );
}

/** The user-facing blocked message recorded on the run (no session, #1200).
 *  Issue #1252: catalog code FAILURE_AUTH_NO_SESSION. */
export function authMissingMessage(alerted: boolean): string {
  return codedMessage(
    "FAILURE_AUTH_NO_SESSION",
    "no stored session exists for this account in PROD mode. Connect " +
      "your E*TRADE account in Settings to resume scheduled runs. " +
      (alerted
        ? "A connect alert has been sent for this episode."
        : "A connect alert was already sent for this episode; further runs today stay quiet."),
  );
}

export interface GuardScheduledETradeAuthOptions {
  env: Env;
  userLogin: string;
  environment?: string;
  /** Issue #2440: the run-as login's session identity, resolved by
   *  the caller from a login it already trusts (the schedule's
   *  owner). Absent → today's login-scoped + unscoped lookup,
   *  unchanged. Unknown logins resolve to an empty identity and
   *  fail closed, never to another login's token. */
  identity?: ETradeTokenIdentity;
  /** Episode dedup store (host DO storage). Absent → alerts fire on
   *  every blocked run (degraded, never silent). */
  store?: AuthEpisodeStore;
  /** Follow-up bridge — a blocked run is recorded as a failed outcome
   *  so it joins the tracked job pipeline (main job + notifications). */
  bridge?: (
    outcome: ScreenerRunOutcome,
    userLogin: string,
    chainReport: boolean
  ) => Promise<void>;
  /** Which scheduled flow is asking (shapes the recorded outcome). */
  kind: "stock" | "options";
  /** Human label for the alert text, e.g. "SP100 stock screen". */
  label: string;
  /** Issue #2216: the run's trace, rendered onto the alert and carried
   *  on the bridged outcome so every leg of the run shares it. */
  trace?: ScreenerTrace;
  /** Test seam: preflight deps (default: bound to the real store). */
  deps?: ETradeAuthPreflightDeps;
  /** Test seam: Slack alert transport. */
  sendSlackAlert?: (text: string) => Promise<void>;
}

export type GuardScheduledETradeAuthResult =
  | { blocked: false }
  | { blocked: true; error: string; alerted: boolean };

/**
 * The scheduled-run guard: preflight + (on block) the deduplicated
 * alert + the recorded outcome. Never throws.
 */
export async function guardScheduledETradeAuth(
  opts: GuardScheduledETradeAuthOptions
): Promise<GuardScheduledETradeAuthResult> {
  try {
    const deps = opts.deps ?? bindETradeAuthPreflightDeps(opts.env);
    const pre = await preflightETradeAuth(deps, opts.userLogin, opts.environment, opts.identity);
    if (pre.status !== "blocked") return { blocked: false };
    const blockedMessage = (alerted: boolean): string =>
      pre.reason === "no-session"
        ? authMissingMessage(alerted)
        : authBlockedMessage(alerted);

    const fire = async (): Promise<void> => {
      // Issue #2216 (#1969 P1): the alert renders FROM the catalog
      // (the run record already did) instead of duplicating the
      // catalog text by hand, and appends the run's trace block so
      // the alert attributes its run without an audit lookup.
      const traceBlock = formatTraceBlock(opts.trace);
      const text =
        pre.reason === "no-session"
          ? `⚠️ ${codedMessage(
              "FAILURE_AUTH_NO_SESSION",
              `scheduled ${opts.label} is blocked. Runs stay blocked (quietly) until you connect.`
            )}${traceBlock ? `\n${traceBlock}` : ""}`
          : `⚠️ ${codedMessage(
              "FAILURE_AUTH_TOKEN_EXPIRED",
              `scheduled ${opts.label} is blocked. Runs stay blocked (quietly) until you reconnect.`
            )}${traceBlock ? `\n${traceBlock}` : ""}`;
      const sends: Array<Promise<unknown>> = [];
      if (opts.sendSlackAlert) {
        sends.push(opts.sendSlackAlert(text));
      } else {
        // #3177: system reconnect alert — ungated (no login passed),
        // master-routed so it no longer depends on cfpay being configured.
        sends.push(
          deliverGatedSlack(opts.env, { text }).then((r) => {
            if (!r.ok) {
              structuredLog.warn("etrade_auth.slack_reconnect_alert_undelivered", {
                message: "[etradeAuthPreflight] Slack reconnect alert not delivered",
                error: r.error,
              });
            }
          })
        );
      }
      if (opts.bridge) {
        const outcome: ScreenerRunOutcome = {
          kind: opts.kind,
          trigger: "scheduled",
          success: false,
          pdfKeys: [],
          error: blockedMessage(true),
          trace: opts.trace,
        };
        sends.push(opts.bridge(outcome, opts.userLogin, false));
      }
      await Promise.allSettled(sends);
    };

    let alerted = false;
    if (opts.store) {
      alerted = await fireAuthEpisodeAlertOnce(opts.store, pre.episodeKey, fire);
    } else {
      try {
        await fire();
        alerted = true;
      } catch {
        alerted = false;
      }
    }
    return { blocked: true, error: blockedMessage(alerted), alerted };
  } catch (err) {
    // The guard must never take a run down with it: on any internal
    // failure the run proceeds and the pipeline's own auth surfacing
    // (FAILURE_AUTH_TOKEN_EXPIRED) owns the error, exactly as before #1174.
    structuredLog.warn("etrade_auth.guard_error", {
      message: "[etradeAuthPreflight] guard error (proceeding without it)",
      error: err instanceof Error ? err.message : String(err),
    });
    return { blocked: false };
  }
}
