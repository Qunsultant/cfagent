/**
 * Issue #3515 S1 — outgoing rate limiting (standards.md §7.2).
 *
 * The slice-0 audit found the incoming token bucket real
 * (src/security/rateLimiter.ts, wired via src/api/ingress.ts) and the
 * outgoing half NOT FOUND on every external connector. This module is
 * the outgoing half: an async token-bucket limiter that REUSES the
 * incoming bucket primitive (`checkRateLimit`) instead of duplicating
 * it. The limiter adds only what the outgoing direction needs: await
 * a token with a bounded wait, else throw a typed error.
 *
 * Behavior on limit: `acquire()` waits for a token (sleeping the
 * bucket's `retryAfterMs` hint between attempts) up to `maxWaitMs`,
 * then throws `OutboundRateLimitError` (typed: `connector` +
 * `retryAfterMs`). The wait is bounded per acquire, never cumulative
 * across a run. Default max wait is 10_000ms.
 *
 * Limits: conservative defaults, 120 requests/minute per connector,
 * configurable per connector via env (see `resolveOutboundRateLimitConfig`):
 *   - E*TRADE 120/min: a working default below the per-account guidance
 *     the provider documents through its Get Rate Limits API; E*TRADE
 *     publishes no single static number, so the default stays well under
 *     typical per-account ceilings and is env-overridable.
 *   - Alpaca 120/min: below Alpaca's published 200 requests/minute per
 *     API key (Trading API and Basic market data, docs.alpaca.markets),
 *     leaving headroom for traffic on the same key outside this throttle.
 *   - LLM 120/min: one model call per actor turn (the tool loop runs
 *     inside a single generateText), so 120/min sustains ~2 turns/sec
 *     per isolate; env-overridable where env reaches the seam.
 *
 * Bucket scope (honest approximation, same class as the incoming
 * per-isolate bucket): each limiter instance owns its own bucket key,
 * so the budget is per client instance within the isolate. A long-lived
 * operation reusing one client (a screener run on one ETradeRestClient,
 * one AlpacaMarketDataProvider) is throttled as a whole; distinct
 * client instances each carry their own burst allowance. The LLM seams
 * share one module-level limiter per connector (`getSharedOutboundLimiter`)
 * because those seams carry no client instance.
 *
 * What this module does NOT do: it does not change incoming throttling
 * (untouched), it does not add circuit breaking (the §7.2 breaker gap
 * is a later slice), and it does not throttle the gateway-port path a
 * second time — CoreLlmGatewayPort already enforces its own opt-in
 * `TokenBucketGatewayRateLimiter` (AI_GATEWAY_RATE_LIMIT_RPM) before
 * the executor runs; the shared LLM limiter here covers the direct
 * turn path and direct executeModelCall callers (e.g. the verifier).
 */

import { checkRateLimit } from "./rateLimiter";

export type OutboundConnector = "etrade" | "alpaca" | "llm";

/** One token-bucket window: 60 seconds for every connector. */
export const OUTBOUND_RATE_LIMIT_WINDOW_MS = 60_000;

/** Bounded wait for a token, per acquire, when no env value is set. */
export const OUTBOUND_RATE_LIMIT_DEFAULT_MAX_WAIT_MS = 10_000;

/** Conservative default requests/minute per connector (see header). */
export const OUTBOUND_RATE_LIMIT_DEFAULTS: Record<OutboundConnector, { rpm: number }> = {
  etrade: { rpm: 120 },
  alpaca: { rpm: 120 },
  llm: { rpm: 120 },
};

export interface OutboundRateLimitEnvLike {
  ETRADE_OUTBOUND_RPM?: string;
  ALPACA_OUTBOUND_RPM?: string;
  LLM_OUTBOUND_RPM?: string;
  OUTBOUND_RATE_LIMIT_MAX_WAIT_MS?: string;
}

export interface OutboundRateLimitConfig {
  /** Bucket capacity and sustained rate: maxRequests per windowMs. */
  maxRequests: number;
  windowMs: number;
  /** Bounded wait for a token per acquire, in ms. 0 = fail fast. */
  maxWaitMs: number;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

const RPM_ENV_KEY: Record<OutboundConnector, keyof OutboundRateLimitEnvLike> = {
  etrade: "ETRADE_OUTBOUND_RPM",
  alpaca: "ALPACA_OUTBOUND_RPM",
  llm: "LLM_OUTBOUND_RPM",
};

/**
 * Resolve a connector's limiter config from env, falling back to the
 * conservative defaults. Blank/invalid values degrade to the default,
 * never throw, and never fail closed — a zero/negative RPM is not a
 * limit (default applies); a zero max wait is an explicit fail-fast
 * and is honored.
 */
export function resolveOutboundRateLimitConfig(
  env: OutboundRateLimitEnvLike | undefined,
  connector: OutboundConnector,
): OutboundRateLimitConfig {
  const rpm = parsePositiveInt(env?.[RPM_ENV_KEY[connector]]);
  const maxWaitMs = parseNonNegativeInt(env?.OUTBOUND_RATE_LIMIT_MAX_WAIT_MS);
  return {
    maxRequests: rpm ?? OUTBOUND_RATE_LIMIT_DEFAULTS[connector].rpm,
    windowMs: OUTBOUND_RATE_LIMIT_WINDOW_MS,
    maxWaitMs: maxWaitMs ?? OUTBOUND_RATE_LIMIT_DEFAULT_MAX_WAIT_MS,
  };
}

/** Thrown when the bounded wait for a token is exhausted. */
export class OutboundRateLimitError extends Error {
  readonly connector: OutboundConnector;
  /** Milliseconds the bucket says to wait before retrying. */
  readonly retryAfterMs: number;

  constructor(connector: OutboundConnector, retryAfterMs: number, maxWaitMs: number) {
    super(
      `Outbound rate limit exceeded for ${connector}: no token within ${maxWaitMs}ms ` +
        `(retry after ${retryAfterMs}ms).`,
    );
    this.name = "OutboundRateLimitError";
    this.connector = connector;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface OutboundRateLimiterOptions {
  maxRequests?: number;
  windowMs?: number;
  maxWaitMs?: number;
  /** Bucket key; defaults to a unique per-instance key. */
  key?: string;
  /** Injectable for tests; defaults to the shared token bucket. */
  check?: typeof checkRateLimit;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

let outboundLimiterInstanceCounter = 0;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Async token-bucket limiter for one outbound connector, built on the
 * incoming bucket (`checkRateLimit`). One instance = one bucket: pass
 * the same instance to every seam of the connector that must share the
 * budget (Alpaca provider + options data plane), or construct one per
 * client instance (E*TRADE, Alpaca provider) so each client carries
 * its own budget.
 */
export class OutboundRateLimiter {
  readonly connector: OutboundConnector;
  readonly config: OutboundRateLimitConfig;
  private readonly key: string;
  private readonly check: typeof checkRateLimit;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(connector: OutboundConnector, opts: OutboundRateLimiterOptions = {}) {
    this.connector = connector;
    this.config = {
      maxRequests: opts.maxRequests ?? OUTBOUND_RATE_LIMIT_DEFAULTS[connector].rpm,
      windowMs: opts.windowMs ?? OUTBOUND_RATE_LIMIT_WINDOW_MS,
      maxWaitMs: opts.maxWaitMs ?? OUTBOUND_RATE_LIMIT_DEFAULT_MAX_WAIT_MS,
    };
    this.key = opts.key ?? `${connector}:${++outboundLimiterInstanceCounter}`;
    this.check = opts.check ?? checkRateLimit;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /**
   * Wait for one token, up to `maxWaitMs` from the first attempt, then
   * throw `OutboundRateLimitError`. Awaited tokens are consumed; a
   * throw consumes nothing (the denied attempt never took a token).
   */
  async acquire(): Promise<void> {
    const startedAt = this.now();
    for (;;) {
      const result = this.check(this.key, this.config.maxRequests, this.config.windowMs, this.now());
      if (result.allowed) return;
      const elapsed = this.now() - startedAt;
      if (elapsed + result.retryAfterMs > this.config.maxWaitMs) {
        throw new OutboundRateLimitError(this.connector, result.retryAfterMs, this.config.maxWaitMs);
      }
      await this.sleep(result.retryAfterMs);
    }
  }
}

/**
 * Create a limiter for a connector from env (defaults when env is
 * absent or a value is invalid). `overrides` is for tests and for
 * callers that must pin a value in code; env wins over nothing — an
 * explicit override replaces the resolved value.
 */
export function createOutboundRateLimiter(
  env: OutboundRateLimitEnvLike | undefined,
  connector: OutboundConnector,
  overrides: OutboundRateLimiterOptions = {},
): OutboundRateLimiter {
  const resolved = resolveOutboundRateLimitConfig(env, connector);
  return new OutboundRateLimiter(connector, { ...resolved, ...overrides });
}

const sharedLimiters = new Map<OutboundConnector, OutboundRateLimiter>();

/**
 * The one shared limiter per connector, for seams that carry no client
 * instance (the LLM model-turn seams). Created lazily with defaults;
 * `overrides` apply only on first creation. Tests reset with
 * `resetSharedOutboundLimiters()`.
 */
export function getSharedOutboundLimiter(
  connector: OutboundConnector,
  overrides: OutboundRateLimiterOptions = {},
): OutboundRateLimiter {
  let limiter = sharedLimiters.get(connector);
  if (!limiter) {
    limiter = createOutboundRateLimiter(undefined, connector, overrides);
    sharedLimiters.set(connector, limiter);
  }
  return limiter;
}

/** Test helper: drop all shared limiters so the next access re-creates them. */
export function resetSharedOutboundLimiters(): void {
  sharedLimiters.clear();
}
