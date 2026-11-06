/**
 * Issue #1741 ([AGENTIC] AI Gateway fallback integration).
 *
 * LLM gateway port: inference routing with rate limiting, caching,
 * and multi-provider failover. Port-first, adapter-first: domain
 * code talks to `LlmGatewayPort` only; the Cloudflare AI Gateway
 * executor (cfGatewayExecutor.ts) and the direct Workers AI
 * executor (directExecutor.ts) are interchangeable behind it, and
 * the conformance semantics in tests/gateway_ports.test.ts run
 * unchanged against any executor.
 *
 * Rules (all pinned by tests):
 * - Failover walks `models` in order, advancing ONLY on retryable
 *   errors (the single source of truth is `isRetryable` from
 *   src/models/router.ts). Non-retryable errors fail fast. Total
 *   failure is a business error, never a raw provider error.
 * - Cache ONLY when a tenantId is present, no tools are attached,
 *   skipCache is unset, and the cache-key material is <= 8000
 *   chars. Without a tenant the call is never served from cache
 *   and never stored — fail-safe against cross-tenant leaks.
 * - Rate limiting is gateway-level (per caller/tenant + first
 *   model), one spend per generate call. A limited call throws
 *   immediately with NO failover (failover must never evade a
 *   limit). It does not replace #1745 provider breakers.
 * - Breakers compose per ADR 0008: an optional CircuitBreaker
 *   wraps each model attempt; an open/budget-exhausted breaker
 *   SKIPS the attempt (no provider call, no budget spend) and
 *   failover continues. A breaker "fallback" outcome is never
 *   served as text — model fallback is the fallback.
 * - Events use the #1739 CloudEvents envelope (id-as-idempotency
 *   key); emission is best-effort and never fails the call, and
 *   envelope data carries counts only — never prompts, outputs,
 *   or tenant material.
 */
import type { FlexibleSchema, ToolSet } from "ai";
import { BreakerBudgetExhaustedError, BreakerOpenError, type CircuitBreaker } from "../breakers/breakerPorts";
import type { MessageEnvelope } from "../messaging/messagingPorts";
import { isRetryable } from "../models/router";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "gateway/gatewayPorts",
});

/** Business error: the caller hit the gateway rate limit. No failover. */
export class GatewayRateLimitedError extends Error {
  constructor() {
    super("Inference rate limit reached. Try again shortly.");
    this.name = "GatewayRateLimitedError";
  }
}

/** Business error: every model in the failover order failed. Never wraps a raw provider error. */
export class GatewayAllProvidersFailedError extends Error {
  constructor(readonly attempts: GatewayAttemptOutcome[]) {
    super("Inference is temporarily unavailable. Try again shortly.");
    this.name = "GatewayAllProvidersFailedError";
  }
}

export type GatewayProviderKind = "ai-gateway" | "direct";

export interface GatewayModelMessage {
  role: string;
  content: string;
}

export interface GatewayGenerateInput {
  /** Ordered failover list, at least one model. */
  models: string[];
  system?: string;
  /** Exactly one of prompt / messages is required. */
  prompt?: string;
  messages?: GatewayModelMessage[];
  /** Tool-calling turn (AI SDK ToolSet). Tools + schema together is a programming error. */
  tools?: ToolSet;
  maxSteps?: number;
  /** Present => generateObject path; absent => generateText path. Any AI SDK schema (zod, jsonSchema, standard). */
  schema?: FlexibleSchema<any>;
  temperature?: number;
  maxOutputTokens?: number;
  /** Per-attempt timeout (AbortController). A timeout fails fast, like the judge's 2500ms guard. */
  timeoutMs?: number;
  /** Tenant scoping for cache isolation. Absent => cache skipped entirely (safe direction). */
  tenantId?: string;
  /** Rate-limit key fallback when no tenant is present. */
  caller?: string;
  cacheKey?: string;
  skipCache?: boolean;
  /**
   * Optional #1745 breaker resolver (ADR 0008 interface): one
   * breaker per model/provider, as in BreakerRegistry.breakerFor.
   * A single shared breaker would gate every model identically,
   * which is not per-provider failover.
   */
  breakerFor?: (model: string) => CircuitBreaker | undefined;
}

export interface GatewayAttemptOutcome {
  model: string;
  status: "success" | "failed" | "skipped";
  error?: string;
}

export interface GatewayGenerateResult {
  text: string;
  object?: unknown;
  /** The model that actually produced the result. */
  model: string;
  provider: GatewayProviderKind;
  cacheHit: boolean;
  attempts: GatewayAttemptOutcome[];
}

export interface ModelExecutorInput {
  model: string;
  system?: string;
  prompt?: string;
  messages?: GatewayModelMessage[];
  tools?: ToolSet;
  maxSteps?: number;
  schema?: FlexibleSchema<any>;
  temperature?: number;
  maxOutputTokens?: number;
  /** Abort signal owned by the core (per-attempt timeout). */
  abortSignal?: AbortSignal;
  /** Gateway-level cache TTL (seconds) forwarded by the CF executor only. */
  cacheTtlSeconds?: number;
  /** Gateway-level cache bypass forwarded by the CF executor only. */
  skipCache?: boolean;
}

/** A model executor: one provider transport. The core owns cache/limit/failover/stats. */
export interface ModelExecutor {
  readonly kind: GatewayProviderKind;
  execute(input: ModelExecutorInput): Promise<{ text: string; object?: unknown }>;
}

export interface GatewayCacheEntry {
  text: string;
  object?: unknown;
  model: string;
  provider: GatewayProviderKind;
}

export interface GatewayCacheStore {
  get(key: string): GatewayCacheEntry | undefined;
  set(key: string, value: GatewayCacheEntry, ttlMs: number): void;
}

export class InMemoryGatewayCacheStore implements GatewayCacheStore {
  private readonly entries = new Map<string, { value: GatewayCacheEntry; expiresAtMs: number }>();
  private readonly maxEntries: number;
  private readonly nowMs: () => number;

  constructor(opts: { maxEntries?: number; nowMs?: () => number } = {}) {
    this.maxEntries = opts.maxEntries ?? 1000;
    this.nowMs = opts.nowMs ?? Date.now;
  }

  get(key: string): GatewayCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.nowMs()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: GatewayCacheEntry, ttlMs: number): void {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAtMs: this.nowMs() + ttlMs });
  }
}

export interface GatewayRateLimiter {
  tryConsume(key: string): boolean;
}

/** Fixed-window token bucket: maxRequests per windowMs per key. Clock injected for tests. */
export class TokenBucketGatewayRateLimiter implements GatewayRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; windowStartMs: number }>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly nowMs: () => number;

  constructor(opts: { maxRequests: number; windowMs: number; nowMs?: () => number }) {
    this.maxRequests = opts.maxRequests;
    this.windowMs = opts.windowMs;
    this.nowMs = opts.nowMs ?? Date.now;
  }

  tryConsume(key: string): boolean {
    const now = this.nowMs();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStartMs >= this.windowMs) {
      this.buckets.set(key, { tokens: this.maxRequests - 1, windowStartMs: now });
      return true;
    }
    if (bucket.tokens <= 0) return false;
    bucket.tokens -= 1;
    return true;
  }
}

export interface GatewayStatsSnapshot {
  requests: number;
  cacheHits: number;
  fallbacks: number;
  failures: number;
  rateLimited: number;
  attemptsByModel: Record<string, number>;
}

export class GatewayStatsAccumulator {
  private stats: GatewayStatsSnapshot = {
    requests: 0,
    cacheHits: 0,
    fallbacks: 0,
    failures: 0,
    rateLimited: 0,
    attemptsByModel: {},
  };

  recordRequest(): void {
    this.stats.requests += 1;
  }
  recordCacheHit(): void {
    this.stats.cacheHits += 1;
  }
  recordFallback(): void {
    this.stats.fallbacks += 1;
  }
  recordFailure(): void {
    this.stats.failures += 1;
  }
  recordRateLimited(): void {
    this.stats.rateLimited += 1;
  }
  recordAttempt(model: string): void {
    this.stats.attemptsByModel[model] = (this.stats.attemptsByModel[model] ?? 0) + 1;
  }
  snapshot(): GatewayStatsSnapshot {
    return { ...this.stats, attemptsByModel: { ...this.stats.attemptsByModel } };
  }
  reset(): void {
    this.stats = {
      requests: 0,
      cacheHits: 0,
      fallbacks: 0,
      failures: 0,
      rateLimited: 0,
      attemptsByModel: {},
    };
  }
}

/** Cache-key material cap: oversize inputs bypass the cache on read and write. */
export const GATEWAY_CACHE_KEY_MAX_CHARS = 8000;

/**
 * Deterministic cache key, or null when the call must not be cached:
 * no tenant, tools attached, explicit skipCache, or oversize material.
 * The caller's explicit cacheKey (when cacheable) wins over the derived key.
 */
export function buildGatewayCacheKey(
  input: Pick<
    GatewayGenerateInput,
    "models" | "system" | "prompt" | "messages" | "temperature" | "schema" | "tenantId" | "tools" | "skipCache" | "cacheKey"
  >,
): string | null {
  if (!input.tenantId || input.tools || input.skipCache) return null;
  if (input.cacheKey) return `gateway-cache:${input.tenantId}:${input.cacheKey}`;
  const material = JSON.stringify({
    models: input.models,
    system: input.system ?? null,
    prompt: input.prompt ?? null,
    messages: input.messages ?? null,
    temperature: input.temperature ?? null,
    schema: input.schema ?? null,
  });
  if (material.length > GATEWAY_CACHE_KEY_MAX_CHARS) return null;
  return `gateway-cache:${input.tenantId}:${material}`;
}

export type GatewayEventType =
  | "gateway.request_completed"
  | "gateway.cache_hit"
  | "gateway.fallback"
  | "gateway.rate_limited";

export interface GatewayEventFields {
  type: GatewayEventType;
  model: string;
  provider: GatewayProviderKind;
  cacheHit: boolean;
  attempts: number;
  durationMs: number;
  atMs: number;
  seq: number;
}

/** CloudEvents envelope for gateway events (same envelope as #1739, id-as-idempotency-key). */
export function toGatewayEventEnvelope(fields: GatewayEventFields): MessageEnvelope {
  return {
    specversion: "1.0",
    id: `gateway:${fields.type}:${fields.seq}`,
    source: "llm-gateway",
    type: fields.type,
    time: new Date(fields.atMs).toISOString(),
    subject: fields.model,
    correlationid: `gateway:${fields.seq}`,
    data: {
      model: fields.model,
      provider: fields.provider,
      cacheHit: fields.cacheHit,
      attempts: fields.attempts,
      durationMs: fields.durationMs,
    },
  };
}

export interface LlmGatewayPort {
  generate(input: GatewayGenerateInput): Promise<GatewayGenerateResult>;
  snapshot(): GatewayStatsSnapshot;
}

export interface CoreGatewayDeps {
  executor: ModelExecutor;
  cache?: GatewayCacheStore;
  limiter?: GatewayRateLimiter;
  stats?: GatewayStatsAccumulator;
  /** Optional event sink (server-boot wiring is a #1743 follow-up; absent => no emission). */
  emit?: (envelope: MessageEnvelope) => Promise<void>;
  log?: (message: string) => void;
  nowMs?: () => number;
  defaultCacheTtlMs?: number;
}

export class CoreLlmGatewayPort implements LlmGatewayPort {
  private readonly stats: GatewayStatsAccumulator;
  private readonly nowMs: () => number;
  private readonly log: (message: string) => void;
  private readonly defaultCacheTtlMs: number;
  private seq = 0;

  constructor(private readonly deps: CoreGatewayDeps) {
    this.stats = deps.stats ?? new GatewayStatsAccumulator();
    this.nowMs = deps.nowMs ?? Date.now;
    this.log = deps.log ?? ((message: string) => structuredLog.warn("gateway.log", { message }));
    this.defaultCacheTtlMs = deps.defaultCacheTtlMs ?? 3_600_000;
  }

  snapshot(): GatewayStatsSnapshot {
    return this.stats.snapshot();
  }

  async generate(input: GatewayGenerateInput): Promise<GatewayGenerateResult> {
    if (input.models.length === 0) throw new Error("Gateway generate requires at least one model");
    if ((input.prompt !== undefined) === (input.messages !== undefined)) {
      throw new Error("Gateway generate requires exactly one of prompt / messages");
    }
    if (input.tools && input.schema) {
      throw new Error("Gateway generate cannot combine tools with a schema (generateText vs generateObject)");
    }
    const startedMs = this.nowMs();
    this.stats.recordRequest();
    const provider = this.deps.executor.kind;

    if (this.deps.limiter) {
      const key = `${input.tenantId ?? input.caller ?? "unknown"}:${input.models[0]}`;
      if (!this.deps.limiter.tryConsume(key)) {
        this.stats.recordRateLimited();
        await this.emitSafe({
          type: "gateway.rate_limited",
          model: input.models[0],
          provider,
          cacheHit: false,
          attempts: 0,
          durationMs: this.nowMs() - startedMs,
        });
        throw new GatewayRateLimitedError();
      }
    }

    const cacheKey = buildGatewayCacheKey(input);
    if (cacheKey && this.deps.cache) {
      const hit = this.deps.cache.get(cacheKey);
      if (hit) {
        this.stats.recordCacheHit();
        await this.emitSafe({
          type: "gateway.cache_hit",
          model: hit.model,
          provider: hit.provider,
          cacheHit: true,
          attempts: 0,
          durationMs: this.nowMs() - startedMs,
        });
        return { text: hit.text, object: hit.object, model: hit.model, provider: hit.provider, cacheHit: true, attempts: [] };
      }
    }

    const attempts: GatewayAttemptOutcome[] = [];
    for (let index = 0; index < input.models.length; index += 1) {
      const model = input.models[index];
      const last = index === input.models.length - 1;
      try {
        const outcome = await this.attempt(input, model);
        if (outcome === "skipped") {
          attempts.push({ model, status: "skipped" });
          if (!last) {
            this.stats.recordFallback();
            await this.emitSafe({
              type: "gateway.fallback",
              model,
              provider,
              cacheHit: false,
              attempts: attempts.length,
              durationMs: this.nowMs() - startedMs,
            });
            continue;
          }
          this.stats.recordFailure();
          throw new GatewayAllProvidersFailedError(attempts);
        }
        this.stats.recordAttempt(model);
        attempts.push({ model, status: "success" });
        if (cacheKey && this.deps.cache) {
          this.deps.cache.set(cacheKey, { text: outcome.text, object: outcome.object, model, provider }, this.defaultCacheTtlMs);
        }
        await this.emitSafe({
          type: "gateway.request_completed",
          model,
          provider,
          cacheHit: false,
          attempts: attempts.length,
          durationMs: this.nowMs() - startedMs,
        });
        return { text: outcome.text, object: outcome.object, model, provider, cacheHit: false, attempts };
      } catch (err) {
        if (err instanceof GatewayAllProvidersFailedError) throw err;
        this.stats.recordAttempt(model);
        const retryable = isRetryable(err);
        attempts.push({ model, status: "failed", error: err instanceof Error ? err.name : String(err) });
        this.log(`[gateway] model ${model} failed (${err instanceof Error ? err.name : "unknown"}), retryable=${retryable}`);
        if (!retryable) {
          this.stats.recordFailure();
          throw new GatewayAllProvidersFailedError(attempts);
        }
        if (!last) {
          this.stats.recordFallback();
          await this.emitSafe({
            type: "gateway.fallback",
            model,
            provider,
            cacheHit: false,
            attempts: attempts.length,
            durationMs: this.nowMs() - startedMs,
          });
          continue;
        }
        this.stats.recordFailure();
        throw new GatewayAllProvidersFailedError(attempts);
      }
    }
    // Unreachable: models is non-empty, so the loop always returns or throws.
    this.stats.recordFailure();
    throw new GatewayAllProvidersFailedError(attempts);
  }

  /**
   * One model attempt, optionally breaker-gated. Returns "skipped"
   * when the breaker is open / budget-exhausted (no provider call,
   * no budget spend); the caller advances failover. A breaker
   * "fallback" outcome is never served as text.
   */
  private async attempt(
    input: GatewayGenerateInput,
    model: string,
  ): Promise<{ text: string; object?: unknown } | "skipped"> {
    const breaker = input.breakerFor?.(model);
    if (!breaker) return this.executeAttempt(input, model);
    if (breaker.getState() === "open") return "skipped";
    try {
      const outcome = await breaker.execute(() => this.executeAttempt(input, model), {
        shouldRetry: (err: unknown) => isRetryable(err),
      });
      if (outcome.status === "fallback") return "skipped";
      return outcome.value;
    } catch (err) {
      if (err instanceof BreakerOpenError || err instanceof BreakerBudgetExhaustedError) return "skipped";
      throw err;
    }
  }

  private async executeAttempt(
    input: GatewayGenerateInput,
    model: string,
  ): Promise<{ text: string; object?: unknown }> {
    const controller = input.timeoutMs !== undefined ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (controller && input.timeoutMs !== undefined) {
      timer = setTimeout(() => controller.abort(), input.timeoutMs);
    }
    try {
      return await this.deps.executor.execute({
        model,
        system: input.system,
        prompt: input.prompt,
        messages: input.messages,
        tools: input.tools,
        maxSteps: input.maxSteps,
        schema: input.schema,
        temperature: input.temperature,
        maxOutputTokens: input.maxOutputTokens,
        abortSignal: controller?.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async emitSafe(fields: Omit<GatewayEventFields, "atMs" | "seq">): Promise<void> {
    if (!this.deps.emit) return;
    this.seq += 1;
    try {
      await this.deps.emit(toGatewayEventEnvelope({ ...fields, atMs: this.nowMs(), seq: this.seq }));
    } catch (err) {
      this.log(
        `[gateway] ${fields.type} emission failed (ignored): ${err instanceof Error ? err.name : "unknown"}`,
      );
    }
  }
}
