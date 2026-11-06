/**
 * Issue #1743 ([AGENTIC] Aspect-oriented observability to
 * Analytics Engine, sub-issue of #1736 item 7) — the
 * observability PORT. Provider-neutral by construction: this
 * module names no provider, no provider binding type, and no
 * provider delivery mechanics. A future provider swap replaces
 * the adapter behind this port; domain code does not change.
 *
 * Scope — Foundation layer ONLY (see ADR 0011): logging,
 * tracing, metrics, and correlation IDs streamed to a sink.
 * The doc's Phases 2–4 (security/tenancy injection,
 * guardrails/cost rollout, approval/audit automation) are NOT
 * this slice; neither is tenant isolation enforcement (§1
 * identity belongs to CISO #945) — tenant context is
 * CONSUMED where it exists, never built here. The IAAA audit
 * trail stays authoritative for auth events and is untouched.
 *
 * Event schema discipline (issue acceptance):
 *  - Every event carries tenant/run/session scope fields
 *    (null when the emitting boundary has no scope — an
 *    unauthenticated request has no tenant, and that is
 *    recorded as null, not fabricated).
 *  - Session scope rides as sessionRef: a truncated hash
 *    correlator, NEVER the session id itself (session
 *    material is excluded from the stream by the redactor).
 *  - Stream payloads carry counts and ids only. Envelope
 *    folding is a WHITELIST: prompt text, thesis text, actor
 *    identities, and error messages never reach the sink,
 *    even when a producer envelope happens to carry them.
 *  - The sink never fails the caller: adapters throw into the
 *    Safe wrapper, which degrades to local logging.
 *
 * Trace discipline (W3C traceparent): the trace id rides the
 * HTTP ingress header, the aspect wrapper, the queue envelope
 * extension, and the workflow command. Producer-side stamping
 * at service-layer call sites (where no request context
 * reaches today) is a follow-up — this slice lands the
 * contract, the consumer-side continuation, and the
 * ingress/aspect paths, and does not fake a producer.
 */

import type { MessageEnvelope } from "../messaging/messagingPorts";
import { guardResourceEvent } from "./resourceEventGuard";

/** W3C trace context for one trace span. */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  flags: string;
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX2 = /^[0-9a-f]{2}$/;

function randomHex(chars: number): string {
  const bytes = new Uint8Array(chars / 2);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mint a fresh trace (new trace id, root span, sampled flag). */
export function newTraceContext(): TraceContext {
  return { traceId: randomHex(32), spanId: randomHex(16), flags: "01" };
}

/**
 * Parse a W3C traceparent header. Strict version "00" with
 * exactly four parts; all-zero ids and non-lowercase hex are
 * rejected. Returns null (never throws, never invents) for
 * anything malformed — callers start a fresh trace instead.
 */
export function parseTraceparent(value: unknown): TraceContext | null {
  if (typeof value !== "string") return null;
  const parts = value.split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, flags] = parts;
  if (version !== "00") return null;
  if (!HEX32.test(traceId) || traceId === "0".repeat(32)) return null;
  if (!HEX16.test(spanId) || spanId === "0".repeat(16)) return null;
  if (!HEX2.test(flags)) return null;
  return { traceId, spanId, flags };
}

/** Format a trace context as a W3C traceparent header. */
export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.flags}`;
}

/** Child span of a trace: same trace id, new span, parent linked. */
export function childSpan(ctx: TraceContext): TraceContext {
  return {
    traceId: ctx.traceId,
    spanId: randomHex(16),
    parentSpanId: ctx.spanId,
    flags: ctx.flags,
  };
}

/**
 * Continue an incoming traceparent, or start a fresh trace
 * when the header is absent or malformed (the ingress rule).
 */
export function traceContextFromHeaders(headers: {
  get(name: string): string | null;
}): TraceContext {
  return parseTraceparent(headers.get("traceparent")) ?? newTraceContext();
}

/** Stamp a traceparent onto an envelope (correlationid untouched). */
export function envelopeWithTraceparent(
  envelope: MessageEnvelope,
  ctx: TraceContext,
): MessageEnvelope {
  return { ...envelope, traceparent: formatTraceparent(ctx) };
}

export type ObservabilityLevel = "info" | "warn" | "error";

/**
 * One ISO-8601 timestamp for one epoch-ms timestamp. The stream
 * carries ONE clock: timestampIso is always the derivation of
 * timestampMs, never a second Date.now(). A non-finite input
 * falls back to now (documented; construction sites pass real
 * timestamps — the fold path already falls back to Date.now()
 * for unparseable envelope times).
 */
export function timestampIsoFor(timestampMs: number): string {
  if (Number.isFinite(timestampMs)) return new Date(timestampMs).toISOString();
  return new Date().toISOString();
}

/**
 * One stream event. Scope fields are present on EVERY event
 * (null when the boundary has no scope). `fields` carries
 * whitelisted scalars only — adapters redact defensively, but
 * builders must never put secrets, user material, or error
 * messages here in the first place.
 *
 * Standards.md §2.2 — the 7 mandatory attributes, as this
 * schema spells them (camelCase, per the existing traceId /
 * tenantId convention): trace_id → traceId, tenant_id →
 * tenantId, actor_id → actorId, agent_id → agentId,
 * timestamp_iso8601 → timestampIso, severity → level,
 * component → component. actorId / agentId / component are
 * the acting system actor / agent / emitting component — user
 * logins and decision-maker identities stay out of the stream
 * (the #1743 discipline) and read as null here.
 */
export interface ObservabilityEvent {
  type: string;
  level: ObservabilityLevel;
  operation: string;
  tenantId: string | null;
  actorId: string | null;
  agentId: string | null;
  component: string | null;
  runId: string | null;
  sessionRef: string | null;
  traceId: string;
  spanId?: string;
  timestampMs: number;
  timestampIso: string;
  durationMs?: number;
  count?: number;
  errorCode?: string;
  fields: Record<string, unknown>;
}

/** The sink surface: one event, or a batch. Never throws (see Safe). */
export interface ObservabilitySink {
  write(event: ObservabilityEvent): void | Promise<void>;
  writeBatch(events: readonly ObservabilityEvent[]): void | Promise<void>;
}

/** Keys whose values are never stream material, at any depth. */
const SENSITIVE_KEY =
  /key|secret|token|password|authorization|cookie|session|credential|api[-_]?key/i;

/**
 * Recursive key-based redaction: a sensitive key maps to "***"
 * no matter how deeply it nests. Idempotent ("***" stays "***").
 */
export function redactForStream(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForStream);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "***" : redactForStream(v);
    }
    return out;
  }
  return value;
}

/**
 * Session correlator: FNV-1a 64-bit hash, truncated to 12 hex
 * chars. Deterministic per session id, but NOT usable as a
 * session credential — the raw id never enters the stream.
 * (A correlator, not a security boundary: the boundary is
 * never logging session material at all.)
 */
export function sessionRefFor(sessionId: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (const byte of new TextEncoder().encode(sessionId)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0").slice(0, 12);
}

/** Local-logging sink: the unbound degradation (never fails). */
export class ConsoleObservabilitySink implements ObservabilitySink {
  write(event: ObservabilityEvent): void {
    console.info(
      JSON.stringify({
        ...event,
        fields: redactForStream(event.fields),
      }),
    );
  }

  writeBatch(events: readonly ObservabilityEvent[]): void {
    for (const event of events) this.write(event);
  }
}

/**
 * Degradation wrapper: an adapter failure degrades to local
 * logging and NEVER throws to the caller (the issue's failure
 * criterion: Analytics Engine unavailability never fails the
 * request). Even a throwing log callback cannot throw.
 */
export class SafeObservabilitySink implements ObservabilitySink {
  constructor(
    private readonly inner: ObservabilitySink,
    private readonly log: (message: string) => void = (message: string) =>
      console.warn(message),
  ) {}

  async write(event: ObservabilityEvent): Promise<void> {
    try {
      await this.inner.write(event);
    } catch (err) {
      this.logLocal(err);
    }
  }

  async writeBatch(events: readonly ObservabilityEvent[]): Promise<void> {
    try {
      await this.inner.writeBatch(events);
    } catch (err) {
      this.logLocal(err);
    }
  }

  private logLocal(err: unknown): void {
    try {
      this.log(
        `[observability] sink write failed, degraded to local logging: ${err instanceof Error ? err.message : String(err)}`,
      );
    } catch {
      // A failing log callback still never fails the caller.
    }
  }
}

/* ------------------------------------------------------------------ */
/* Envelope folding — whitelist ingestion for the stream              */
/* ------------------------------------------------------------------ */

type DataRecord = Record<string, unknown>;

function dataOf(envelope: MessageEnvelope): DataRecord | null {
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as DataRecord;
}

function str(data: DataRecord, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optStr(data: DataRecord, key: string): string | undefined {
  const value = str(data, key);
  return value ?? undefined;
}

function num(data: DataRecord, key: string): number | null {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(data: DataRecord, key: string): boolean | null {
  const value = data[key];
  return typeof value === "boolean" ? value : null;
}

/** Trace for a folded event: envelope traceparent wins, else correlation, else id. */
function traceOf(envelope: MessageEnvelope): string {
  const parsed = parseTraceparent(envelope.traceparent);
  if (parsed) return parsed.traceId;
  return envelope.correlationid ?? envelope.id;
}

function timestampOf(envelope: MessageEnvelope): number {
  const parsed = Date.parse(envelope.time);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Emitting component for a folded envelope, from its type
 * prefix. The fold cases below are the only callers, so every
 * value here is a known family; anything else reads null
 * (never fabricated).
 */
function componentOf(type: string): string | null {
  if (type.startsWith("telemetry.")) return "telemetry";
  if (type.startsWith("breaker.")) return "breaker";
  if (type.startsWith("gateway.")) return "gateway";
  if (type.startsWith("retrieval.")) return "retrieval";
  if (type.startsWith("screener.")) return "screener";
  if (type.startsWith("resource.")) return "resource";
  if (type.startsWith("goal.")) return "goal";
  return null;
}

function baseEvent(
  envelope: MessageEnvelope,
  operation: string,
  level: ObservabilityLevel,
  tenantId: string | null,
): ObservabilityEvent {
  const timestampMs = timestampOf(envelope);
  return {
    type: envelope.type,
    level,
    operation,
    tenantId,
    actorId: null,
    agentId: null,
    component: componentOf(envelope.type),
    runId: null,
    sessionRef: null,
    traceId: traceOf(envelope),
    timestampMs,
    timestampIso: timestampIsoFor(timestampMs),
    fields: {},
  };
}

/**
 * Fold a known CloudEvents envelope into a stream event by
 * WHITELIST — only the listed count/id fields survive. Unknown
 * types and malformed data fold to null (ignored, never
 * thrown). Deliberately dropped even when present: promptKey,
 * sliceKey/thesis text, appliedBy/decidedBy identities, error
 * messages, and any other user material.
 */
export function foldEnvelopeToEvent(
  envelope: MessageEnvelope,
): ObservabilityEvent | null {
  try {
    const data = dataOf(envelope);
    if (!data) return null;
    switch (envelope.type) {
      case "telemetry.realization_recorded": {
        const tenantId = str(data, "tenantId");
        const outcomeId = str(data, "outcomeId");
        const agentKey = str(data, "agentKey");
        const structure = str(data, "structure");
        const regime = str(data, "regime");
        const directionCorrect = bool(data, "directionCorrect");
        const falsified = bool(data, "falsified");
        if (
          !tenantId ||
          !outcomeId ||
          !agentKey ||
          !structure ||
          !regime ||
          directionCorrect === null ||
          falsified === null
        ) {
          return null;
        }
        // outcomeId grammar: `${runId}:${symbol}:${structure}` —
        // the run id is everything before the last two segments.
        const parts = outcomeId.split(":");
        const event = baseEvent(envelope, "telemetry.realization", "info", tenantId);
        event.runId = parts.length >= 3 ? parts.slice(0, -2).join(":") : null;
        // Promotion, not new ingestion: agentKey is already
        // whitelisted into fields below; the §2.2 agent_id
        // attribute carries the same system-agent key.
        event.agentId = agentKey;
        event.fields = { agentKey, structure, regime, directionCorrect, falsified };
        return event;
      }
      case "telemetry.calibration_proposed": {
        const tenantId = str(data, "tenantId");
        const decisionId = str(data, "decisionId");
        const actorKey = str(data, "actorKey");
        const dimension = str(data, "dimension");
        const evaluated = num(data, "evaluated");
        const hits = num(data, "hits");
        if (!tenantId || !decisionId || !dimension || evaluated === null || hits === null) {
          return null;
        }
        const falsificationRate = num(data, "falsificationRate");
        const event = baseEvent(envelope, "telemetry.calibration", "info", tenantId);
        // Promotion, not new ingestion: actorKey is already
        // whitelisted into fields below; the §2.2 actor_id
        // attribute carries the same system-actor key. The
        // dropped identities (appliedBy/decidedBy humans,
        // prompt/thesis text) stay dropped.
        event.actorId = actorKey;
        event.fields = {
          decisionId,
          ...(actorKey ? { actorKey } : {}),
          dimension,
          evaluated,
          hits,
          ...(falsificationRate !== null ? { falsificationRate } : {}),
        };
        return event;
      }
      case "telemetry.calibration_applied": {
        const tenantId = str(data, "tenantId");
        const decisionId = str(data, "decisionId");
        if (!tenantId || !decisionId) return null;
        const event = baseEvent(envelope, "telemetry.calibration", "info", tenantId);
        // Promotion (see calibration_proposed above): the
        // whitelisted actorKey becomes the actor_id attribute.
        event.actorId = optStr(data, "actorKey") ?? null;
        event.fields = {
          decisionId,
          ...(optStr(data, "actorKey") ? { actorKey: optStr(data, "actorKey") } : {}),
        };
        return event;
      }
      case "breaker.state_changed": {
        const providerId = str(data, "providerId");
        const from = str(data, "from");
        const to = str(data, "to");
        const trips = num(data, "trips");
        const fallbacks = num(data, "fallbacks");
        if (!providerId || !from || !to || trips === null || fallbacks === null) {
          return null;
        }
        const event = baseEvent(
          envelope,
          "breaker.state_changed",
          to === "open" ? "warn" : "info",
          null,
        );
        event.fields = { providerId, from, to, trips, fallbacks };
        return event;
      }
      case "gateway.request_completed":
      case "gateway.cache_hit":
      case "gateway.fallback":
      case "gateway.rate_limited": {
        const model = str(data, "model");
        const provider = str(data, "provider");
        const cacheHit = bool(data, "cacheHit");
        const attempts = num(data, "attempts");
        const durationMs = num(data, "durationMs");
        if (
          !model ||
          !provider ||
          cacheHit === null ||
          attempts === null ||
          durationMs === null
        ) {
          return null;
        }
        const event = baseEvent(
          envelope,
          envelope.type,
          envelope.type === "gateway.rate_limited" ? "warn" : "info",
          null,
        );
        event.durationMs = durationMs;
        event.fields = { model, provider, cacheHit, attempts };
        return event;
      }
      case "retrieval.completed": {
        const denseCount = num(data, "denseCount");
        const graphCount = num(data, "graphCount");
        const degraded = bool(data, "degraded");
        if (denseCount === null || graphCount === null || degraded === null) {
          return null;
        }
        // The retrieval leg carries no tenant context — null is
        // honest scope, not a gap to paper over.
        const event = baseEvent(envelope, "retrieval.completed", "info", null);
        event.fields = { denseCount, graphCount, degraded };
        return event;
      }
      case "screener.completed":
      case "screener.failed": {
        const eventData = data.event;
        if (!eventData || typeof eventData !== "object") return null;
        const failed = envelope.type === "screener.failed";
        const event = baseEvent(
          envelope,
          "screener.delivery",
          failed ? "error" : "info",
          optStr(data, "ownerLogin") ?? null,
        );
        if (failed) event.errorCode = "screener.failed";
        event.fields = {
          ...(typeof envelope.subject === "string" && envelope.subject
            ? { deliveryId: envelope.subject }
            : {}),
        };
        return event;
      }
      case "resource.sql_op": {
        // Phase 5 slice 5 (#1819): counts-only fold. The guard bounds
        // every dimension and drops identities; the whitelist here
        // admits nothing else, even when a producer envelope carries
        // session ids, user logins, bound values, or error text.
        // Trace rides the envelope traceparent (traceOf), the same
        // design Slice 3 uses for steps — no Slice 3 code is needed.
        const guarded = guardResourceEvent(data);
        if (!guarded) return null;
        const event = baseEvent(envelope, "resource.sql_op", "info", guarded.tenantId);
        event.runId = guarded.runId;
        event.sessionRef = guarded.sessionRef;
        if (guarded.durationMs !== undefined) event.durationMs = guarded.durationMs;
        event.fields = guarded.fields;
        return event;
      }
      case "screener.stage.feed_completed":
      case "screener.stage.feed_failed":
      case "screener.stage.gather_completed":
      case "screener.stage.gather_failed":
      case "screener.stage.analysis_completed":
      case "screener.stage.analysis_failed":
      case "screener.stage.deliver_completed":
      case "screener.stage.deliver_failed": {
        // Issue #2000 Phase 5 slice 4 — stage events as NEW TYPE
        // VALUES ONLY (no schema change): the stage vocabulary
        // comes from the screener flow's stage outcomes (feed,
        // gather, analysis, deliver); `serve` is not a stage in
        // that vocabulary and still folds to null. Counts+ids
        // only: tenantId + runId required (tenant is the stream's
        // index dimension, so a tenant-less stage envelope folds
        // to null rather than being mis-indexed), optional
        // numeric count. Failed forms carry the type itself as
        // errorCode, never an error message.
        const tenantId = str(data, "tenantId");
        const runId = str(data, "runId");
        if (!tenantId || !runId) return null;
        const failed = envelope.type.endsWith("_failed");
        const count = num(data, "count");
        const event = baseEvent(
          envelope,
          "screener.stage",
          failed ? "error" : "info",
          tenantId,
        );
        event.runId = runId;
        if (failed) event.errorCode = envelope.type;
        event.fields = {
          ...(count !== null ? { count } : {}),
        };
        return event;
      }
      case "goal.gather.missed": {
        // Issue #2000 Phase 5 slice 7 — gather-miss event as a
        // NEW TYPE VALUE ONLY (no schema change, same pattern
        // as slice 4's stage events): counts+ids only, tenantId
        // + runId required (tenant is the stream's index
        // dimension, so a tenant-less envelope folds to null
        // rather than being mis-indexed). Symbol lists, error
        // messages, and any other user material never survive,
        // even when a producer envelope carries them.
        const tenantId = str(data, "tenantId");
        const runId = str(data, "runId");
        if (!tenantId || !runId) return null;
        const requested = num(data, "requested");
        const stored = num(data, "stored");
        const missing = num(data, "missing");
        const event = baseEvent(envelope, "goal.gather", "warn", tenantId);
        event.runId = runId;
        event.fields = {
          ...(requested !== null ? { requested } : {}),
          ...(stored !== null ? { stored } : {}),
          ...(missing !== null ? { missing } : {}),
        };
        return event;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Fold + write one envelope. Returns true when the envelope
 * folded and was written, false when it was unknown or
 * malformed (ignored, never thrown). Sink errors propagate —
 * callers use the Safe wrapper (or an engine's best-effort
 * emit) so a sink failure never fails the producer.
 */
export async function writeEnvelopeToSink(
  sink: ObservabilitySink,
  envelope: MessageEnvelope,
): Promise<boolean> {
  const event = foldEnvelopeToEvent(envelope);
  if (!event) return false;
  await sink.write(event);
  return true;
}
