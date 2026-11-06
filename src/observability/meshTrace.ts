/**
 * Issue #2428 (Agent Mesh S17, programme #2225 G13a) — the
 * mesh trace spine's producer + assembly logic, built on the
 * #1743 observability port (ADR 0011). The spine's identity is
 * the W3C trace id; this module owns:
 *
 *  - span derivation from a carried traceparent (child spans,
 *    and deterministic span ids for workflow steps — a durable
 *    replay re-derives the SAME span, so re-recording
 *    converges in the store instead of duplicating);
 *  - the sink-forwarding store decorator: every recorded hop
 *    ALSO emits an ObservabilityEvent (type "mesh.trace.hop")
 *    to the ADR 0011 sink, with the S16 two-part attribution
 *    in the whitelisted fields (caller + agent);
 *  - the read-side assembly: ordered hops + the projection
 *    rows for the trace's mapped jobIds, with break detection.
 *    A missing expected hop is a NAMED break in the assembly —
 *    never a fabricated link, never silently dropped.
 *
 * Tracing observes; it never decides. Nothing in this module
 * branches execution, gates a call, or alters a step input
 * (the programme's determinism boundary).
 */
import type {
  MeshTraceHop,
  MeshTraceHopKind,
  MeshTraceStore,
} from "../data/meshTracePorts";
import type { ShardJobRow } from "../data/shardJobPorts";
import {
  childSpan,
  parseTraceparent,
  timestampIsoFor,
  type ObservabilitySink,
  type TraceContext,
} from "./observabilityPorts";

/** The trace id a traceparent carries, or null when absent/malformed (never invented). */
export function traceIdOfTraceparent(value: unknown): string | null {
  const parsed = parseTraceparent(value);
  return parsed ? parsed.traceId : null;
}

/** Child trace context for a carried traceparent, or null when it does not parse. */
export function childContextOfTraceparent(value: unknown): TraceContext | null {
  const parsed = parseTraceparent(value);
  return parsed ? childSpan(parsed) : null;
}

/**
 * Deterministic 16-hex span id from a seed (FNV-1a 64-bit,
 * the sessionRefFor hash family): workflow step spans derive
 * from (jobId, operation) so a durable replay re-records the
 * identical span and the store's (traceId, spanId) conflict
 * rule converges it.
 */
export function deterministicSpanId(seed: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (const byte of new TextEncoder().encode(seed)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0").slice(0, 16);
}

/**
 * Store decorator: record to the backing store AND emit the
 * hop to the observability sink in the ADR 0011 envelope
 * shape. Neither leg may fail the producer: the composition
 * root wraps recording in a best-effort helper, and the sink
 * itself is the Safe wrapper wherever it is composed from env.
 */
export class SinkForwardingTraceStore implements MeshTraceStore {
  constructor(
    private readonly inner: MeshTraceStore,
    private readonly sink: ObservabilitySink,
  ) {}

  async record(hop: MeshTraceHop): Promise<void> {
    await this.inner.record(hop);
    await this.sink.write({
      type: "mesh.trace.hop",
      level: "info",
      operation: hop.operation,
      tenantId: hop.tenantId ?? null,
      // The hop caller is a user login: it stays out of the
      // stream (the #1743 discipline), so actorId is null.
      actorId: null,
      // Promotion, not new ingestion: hop.agent is the
      // agent/surface serving the hop, already carried in
      // fields below; the §2.2 agent_id attribute carries it.
      agentId: hop.agent ?? null,
      component: "mesh-trace",
      runId: hop.jobId ?? null,
      sessionRef: null,
      traceId: hop.traceId,
      spanId: hop.spanId,
      timestampMs: hop.timestampMs,
      timestampIso: timestampIsoFor(hop.timestampMs),
      fields: {
        hopKind: hop.kind,
        ...(hop.caller ? { caller: hop.caller } : {}),
        ...(hop.agent ? { agent: hop.agent } : {}),
        ...(hop.jobId ? { jobId: hop.jobId } : {}),
        ...(hop.note ? { note: hop.note } : {}),
      },
    });
  }

  hopsFor(traceId: string): Promise<MeshTraceHop[]> {
    return this.inner.hopsFor(traceId);
  }
}

/**
 * Record one workflow hop for a command, from the command's
 * own traceparent. A command carrying no traceparent records
 * NOTHING — that absence is the recorded break the registry
 * names (a run that began outside a traced ingress has no
 * trace to join), and this helper never mints one mid-flight.
 *
 * The emitting workflow defaults to ScreenerScreenWorkflow
 * (the original S17 caller); another workflow reusing this
 * mechanism names itself via `command.agent` (#2730:
 * TradingTradeWorkflow, whose params carry the same #1743
 * field). A step outcome worth naming rides `event.note`.
 */
export async function recordWorkflowTraceHop(
  store: MeshTraceStore,
  command: {
    traceparent?: string;
    jobId: string;
    tenantId?: string;
    userLogin: string;
    agent?: string;
  },
  event: {
    kind: Extract<MeshTraceHopKind, "workflow-step" | "projection">;
    operation: string;
    note?: string;
  },
): Promise<void> {
  const parsed = parseTraceparent(command.traceparent);
  if (!parsed) return;
  await store.record({
    traceId: parsed.traceId,
    spanId: deterministicSpanId(`${command.jobId}:${event.operation}`),
    parentSpanId: parsed.spanId,
    kind: event.kind,
    operation: event.operation,
    timestampMs: Date.now(),
    tenantId: command.tenantId ?? null,
    caller: command.userLogin,
    agent: command.agent ?? "ScreenerScreenWorkflow",
    jobId: command.jobId,
    ...(event.note ? { note: event.note } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* Assembly — the read surface's deterministic core                    */
/* ------------------------------------------------------------------ */

export interface MeshTraceAssembly {
  traceId: string;
  /** True only when every hop this trace's shape requires is present. */
  complete: boolean;
  /** Ordered hops (recorded hops + projection rows folded in as projection hops). */
  hops: MeshTraceHop[];
  /** Named breaks: each expected-but-missing hop, stated plainly. */
  breaks: string[];
  /** The existing run identities the trace maps to (workflow jobIds). */
  jobIds: string[];
}

const KIND_RANK: Record<MeshTraceHopKind, number> = {
  ingress: 0,
  turn: 1,
  door: 2,
  "job-queue": 3,
  "job-execute": 4,
  "workflow-start": 5,
  "workflow-step": 6,
  projection: 7,
  a2a: 2,
  ledger: 8,
};

const ENTRY_KINDS: readonly MeshTraceHopKind[] = [
  "ingress",
  "turn",
  "door",
  "a2a",
  "job-execute",
  "workflow-start",
];

/** Fold one projection row into a projection hop (the row IS the hop's evidence). */
function projectionHop(traceId: string, row: ShardJobRow): MeshTraceHop {
  return {
    traceId,
    spanId: deterministicSpanId(`${row.chainId}:${row.jobKey}:${row.stage}:${row.version}`),
    kind: "projection",
    operation: `projection:${row.stage}`,
    timestampMs: row.updatedAtMs,
    tenantId: row.tenantId,
    agent: row.provenanceSourceDo,
    jobId: row.chainId,
    note: row.status,
  };
}

/**
 * Assemble one trace from its recorded hops + the projection
 * rows for its mapped jobIds. Ordering: timestamp, then
 * pipeline rank, then span id (stable). Break detection is
 * shape-based and conservative:
 *  - no hops at all → not a trace (complete=false, break named);
 *  - no entry hop (ingress/turn/door/a2a/job-execute) → the
 *    chain's head is missing;
 *  - a workflow-start hop with no workflow-step hop → the
 *    workflow's spans never joined;
 *  - a workflow-start hop with no projection hop AND no
 *    projection rows → the projection leg never joined.
 * Anything else missing is not claimed: the assembly reports
 * exactly the hops that exist.
 */
export function assembleMeshTrace(
  traceId: string,
  hops: readonly MeshTraceHop[],
  jobRows: readonly ShardJobRow[],
): MeshTraceAssembly {
  const jobIds = [
    ...new Set([
      ...hops.map((h) => h.jobId).filter((j): j is string => typeof j === "string" && j.length > 0),
      ...jobRows.map((r) => r.chainId),
    ]),
  ];
  const folded: MeshTraceHop[] = [
    ...hops.filter((h) => h.traceId === traceId),
    ...jobRows.map((row) => projectionHop(traceId, row)),
  ];
  // Dedupe on (traceId, spanId): a recorded projection hop and
  // its folded row share the deterministic span only when the
  // seeds coincide; identical spans are the same hop.
  const bySpan = new Map<string, MeshTraceHop>();
  for (const hop of folded) {
    if (!bySpan.has(hop.spanId)) bySpan.set(hop.spanId, hop);
  }
  const ordered = [...bySpan.values()].sort(
    (a, b) =>
      a.timestampMs - b.timestampMs ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.spanId.localeCompare(b.spanId),
  );

  const breaks: string[] = [];
  if (ordered.length === 0) {
    breaks.push("no hops recorded for this trace id");
  } else {
    const kinds = new Set(ordered.map((h) => h.kind));
    if (!ENTRY_KINDS.some((k) => kinds.has(k))) {
      breaks.push("entry hop missing: no ingress/turn/door/a2a hop recorded for this trace");
    }
    if (kinds.has("workflow-start")) {
      if (!kinds.has("workflow-step")) {
        breaks.push("workflow-step hops missing: no workflow step recorded a span for this trace");
      }
      if (!kinds.has("projection")) {
        breaks.push("projection hops missing: no projection row or hop recorded for this trace");
      }
    }
  }
  return { traceId, complete: breaks.length === 0, hops: ordered, breaks, jobIds };
}
