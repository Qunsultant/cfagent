/**
 * Issue #1739 ([AGENTIC] Queue-backed messaging pipeline) — the
 * messaging PORT. Provider-neutral by construction: this module
 * names no provider, no provider binding type, and no provider
 * delivery mechanics. A future provider swap replaces the adapter
 * behind this port; domain code does not change.
 *
 * Envelope contract — CloudEvents v1.0 (owner decision 2026-10-26,
 * closing assessment-01.md Recommendation 4, P2 gap; repo
 * standards §7.1 already mandate CloudEvents-compliant events).
 * The ABoK blueprint §11.3 field names are superseded by the
 * CloudEvents names below; semantics are unchanged. Every
 * envelope carries the required attributes — specversion "1.0",
 * id, source, type, time, data — and NOTHING provider-specific.
 * Optional CloudEvents attributes and lowercase extensions ride
 * alongside: subject (the entity the event is about — a
 * chain/job id), correlationid, and the four job-routing
 * extensions jobid, parentjobid, shardid, stage. They express
 * job/sub-job fan-out, collation, and per-stage resume in
 * messages without touching data shapes, so a collator or
 * resume step reads them without knowing what a stage's data
 * looks like. Plain domain events (no job context) simply omit
 * the extensions.
 *
 * Mapping from the §11.3 names (semantics unchanged):
 * eventId → id, eventType → type, timestamp → time,
 * producer → source, payload → data, plus specversion "1.0".
 * Extensions are lowercase per the CloudEvents spec (an
 * extension name with an uppercase letter fails validation).
 *
 * Stage pipeline (owner spec; execution belongs to #1737, the
 * message shape belongs here): feed (collect from multiple
 * providers) and gather (combine + enrich) are TWO separate
 * stages; analysis runs only on post-gather data and persists
 * its own results, like each prior stage persists its own
 * results independently. The full stage order is feed → gather
 * → analysis → store → serve → deliver (§7.4's "generate" is
 * the analysis stage in this split). Stage-typed events are
 * first-class type values: stageEventType(stage, outcome)
 * builds "feed.completed" and siblings. Triggers are
 * trigger-agnostic: UX events and scheduled events produce the
 * same envelope and the same execution path; the source
 * field records the trigger source for audit (scheduled-tasks
 * vs an interactive/manual producer) and the consumer never
 * branches on it.
 *
 * Job/sub-job model alignment (slice 2): the envelope's
 * jobid/parentjobid/shardid map onto agent_shard_jobs (one row
 * per chain/job/version, terminal rails) as job id / parent
 * chain id / shard leg id. This port invents no second job
 * model. Two mismatches are noted, not papered over, for
 * #1737's design: (1) the stage pipeline's qualified partial
 * results (a per-shard timeout yields partial results with
 * audit status, never total failure) have no home in the
 * shard-job terminal rails (completed/submitted/failed) —
 * partial is not terminal, so collation state needs either a
 * new outcome value or a separate collation record; (2) the
 * projection carries a version column the envelope
 * deliberately does not (replay/versioning is projection
 * state, not message state). Per-stage resume/checkpointing,
 * configurable parallelism bounded by platform limits (#1204),
 * per-shard timeouts, and collation itself are #1737 execution
 * concerns — the envelope only guarantees they are expressible.
 *
 * Idempotency contract (blueprint §11.3 + CloudEvents §7.2
 * Idempotent Receiver): the idempotency key IS the id.
 * CloudEvents requires id unique, which satisfies the
 * idempotent-receiver requirement. A consumer delivers a given
 * id to its handler at most once per consumer instance: a
 * second delivery of the same id reports "duplicate" and never
 * re-invokes the handler. A "retry" disposition deliberately
 * leaves the id unmarked, so a later redelivery may invoke the
 * handler again.
 *
 * Dedup scope, stated honestly: the seen set lives in the
 * consumer instance (in the worker, module-level state shared
 * across batches in one isolate). Cross-isolate redelivery is
 * therefore possible under at-least-once delivery; a durable
 * cross-instance dedup store is a separate follow-up, not this
 * slice. Downstream scheduled deliveries already dedup on their
 * own stable delivery id.
 *
 * Dispositions are provider-neutral words: "processed" (done),
 * "retry" (not done; may be redelivered), "drop" (terminally
 * refused; never redelivered as new work). How a provider
 * adapter turns a disposition into its own mechanics is the
 * adapter's private concern — the port never names it.
 *
 * TWO primitives, at different layers (owner design decision):
 *  - Point-to-point (producer-consumer): `send` puts a job /
 *    command message on one work queue with competing consumers;
 *    each message is processed once, with exactly-once effect via
 *    the mandatory idempotency keys (id). This is the shape
 *    for work items such as run-screen jobs.
 *  - Pub/sub (broadcast): `publish` broadcasts a domain event
 *    (screen completed, leg failed, report ready) to MULTIPLE
 *    subscribers — projection writer, delivery, telemetry,
 *    reconcile — routed by type. Because provider queues
 *    are point-to-point, a provider adapter implements publish
 *    as fan-out to one queue per subscriber; it must NOT
 *    collapse broadcast into a single consumer that secretly
 *    calls everything, because that breaks the decoupling and
 *    the future provider swap.
 *  - A subscriber registers one handler per (subscriber,
 *    type); a second registration for the same pair
 *    replaces the first. Dedup for broadcast is per
 *    (subscriber, id): the same event redelivered to one
 *    subscriber never re-invokes that subscriber's handler,
 *    while other subscribers are unaffected.
 *
 * Event-driven shape (owner framing): choreography at the
 * edges — producers emit envelope events, consumers react
 * independently — with workflow orchestration in the middle
 * (multi-step sagas are coordinated by workflow runs, because
 * pure choreography alone would make runs unresumable and
 * unreasoned-about). Two boundaries stay explicit: durable
 * object state remains authoritative and the D1 projection is
 * read-only (the audit log is append-only event history, not
 * an event-sourced system of record, so there are no
 * replay-from-projection semantics); and synchronous paths
 * stay synchronous where they must (HTTP responses, human
 * approvals, deterministic trade preflight) — event-driven
 * architecture governs async work, not everything.
 *
 * Claim-check discipline (screener.md §8.2): envelopes carry
 * IDs and references, never bulk data. A screener event
 * references its run by delivery id and its artifacts by
 * R2/DO keys (pdf/xlsx/csv keys, stage chain); the option
 * chains and report bodies stay behind those references.
 * The discipline is enforced, not just documented: an
 * envelope whose serialized form exceeds MAX_ENVELOPE_BYTES
 * is invalid at every boundary (send, publish, consume), so
 * bulk data can never cross the bus — it must be
 * stored first and referenced instead.
 */

/** Pipeline stage identity (owner stage-architecture spec). */
export type StageName =
  | "feed"
  | "gather"
  | "analysis"
  | "store"
  | "serve"
  | "deliver";

export const STAGE_NAMES: readonly StageName[] = [
  "feed",
  "gather",
  "analysis",
  "store",
  "serve",
  "deliver",
];

/** Stage outcome vocabulary for stage-typed type values. */
export type StageOutcome = "started" | "completed" | "failed";

/** Build a first-class stage-typed type value, e.g. "feed.completed". */
export function stageEventType(
  stage: StageName,
  outcome: StageOutcome
): string {
  return `${stage}.${outcome}`;
}

/**
 * The CloudEvents v1.0 envelope for this port. Required
 * attributes (this profile requires time and data, which the
 * CloudEvents base spec leaves optional): specversion, id,
 * source, type, time, data. Optional: subject (the entity the
 * event is about — a chain/job id), correlationid, and the
 * job-routing extensions jobid, parentjobid, shardid, stage
 * (absent for plain domain events).
 */
export interface MessageEnvelope {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  time: string;
  data: unknown;
  /** The entity the event is about (a chain/job id). */
  subject?: string;
  correlationid?: string;
  /**
   * Issue #1743 — W3C traceparent for the envelope's trace
   * (e.g. "00-<traceId>-<spanId>-<flags>"). Consumer-side
   * continuation: a subscriber folds under this trace. The
   * validator tolerates it as a lowercase extension; it is
   * listed here so the contract is explicit, not accidental.
   */
  traceparent?: string;
  /** Job this message belongs to. */
  jobid?: string;
  /** Parent job for a sub-job (the chain / request this shard belongs to). */
  parentjobid?: string;
  /** Shard within the parent job (e.g. one ticker's sub-job). */
  shardid?: string;
  /** Pipeline stage this message belongs to. */
  stage?: StageName;
}

/** Job-routing context read off an envelope, or null when it carries none. */
export interface JobContext {
  jobId: string;
  parentJobId?: string;
  shardId?: string;
  stage?: StageName;
}

/** Extract the job-routing context from an envelope, if it carries one. */
export function jobContextFromEnvelope(
  envelope: MessageEnvelope
): JobContext | null {
  if (!envelope.jobid) return null;
  const ctx: JobContext = { jobId: envelope.jobid };
  if (envelope.parentjobid) ctx.parentJobId = envelope.parentjobid;
  if (envelope.shardid) ctx.shardId = envelope.shardid;
  if (envelope.stage) ctx.stage = envelope.stage;
  return ctx;
}

/** A handler's verdict on one envelope. */
export type ConsumeOutcome = "processed" | "retry" | "drop";

export type MessageHandler = (
  envelope: MessageEnvelope
) => Promise<ConsumeOutcome> | ConsumeOutcome;

/** One item of a consumption report, in input order. */
export interface ConsumeResult {
  id: string | null;
  disposition: "processed" | "retried" | "dropped" | "duplicate" | "invalid";
}

export interface ConsumeReport {
  results: ConsumeResult[];
}

/** Neutral error codes. Provider error shapes never escape an adapter. */
export type MessagingErrorCode =
  | "invalid_envelope"
  | "send_failed"
  | "unavailable";

export class MessagingError extends Error {
  readonly code: MessagingErrorCode;
  constructor(code: MessagingErrorCode, message: string) {
    super(message);
    this.name = "MessagingError";
    this.code = code;
  }
}

/** Producer side of the port. */
export interface MessageProducer {
  send(envelope: MessageEnvelope): Promise<void>;
  sendBatch(envelopes: readonly MessageEnvelope[]): Promise<void>;
}

/** Consumer side of the port. Never throws for handler failures. */
export interface MessageConsumer {
  consume(
    envelopes: readonly unknown[],
    handler: MessageHandler
  ): Promise<ConsumeReport>;
}

/**
 * Issue #2544 (migration step 1) — the DLQ-aware
 * consumer contract for one queue: the platform-side settings
 * the worker's consumer runs under. This is the port's config
 * surface, not a deployment file: the wrangler.jsonc consumer
 * entries are pinned against these values by test, so the two
 * copies cannot drift (gitops §7, the pin rule).
 * maxBatchTimeoutSeconds is absent for consumers the platform
 * leaves at its default; deadLetterQueue is absent only for a
 * consumer with no DLQ (none remain after step 1).
 */
export interface QueueConsumerConfig {
  maxBatchSize: number;
  maxBatchTimeoutSeconds?: number;
  maxRetries: number;
  maxConcurrency?: number;
  deadLetterQueue?: string;
}

export interface MessagingPorts {
  /** Point-to-point work queue: one queue, competing consumers. */
  producer: MessageProducer;
  consumer: MessageConsumer;
  /** Broadcast: fan-out to subscriber streams, routed by type. */
  publisher: MessagePublisher;
  subscriber: MessageSubscriber;
}

/** Claim-check ceiling: serialized envelope size limit (see header). */
export const MAX_ENVELOPE_BYTES = 128 * 1024;

/** Runtime shape check for a CloudEvents v1.0 envelope. */
export function isMessageEnvelope(value: unknown): value is MessageEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    v.specversion !== "1.0" ||
    typeof v.id !== "string" ||
    v.id.length === 0 ||
    typeof v.source !== "string" ||
    v.source.length === 0 ||
    typeof v.type !== "string" ||
    v.type.length === 0 ||
    typeof v.time !== "string" ||
    v.time.length === 0 ||
    v.data === undefined
  ) {
    return false;
  }
  if (
    (v.subject !== undefined &&
      (typeof v.subject !== "string" || v.subject.length === 0)) ||
    (v.correlationid !== undefined &&
      (typeof v.correlationid !== "string" ||
        v.correlationid.length === 0)) ||
    (v.traceparent !== undefined &&
      (typeof v.traceparent !== "string" ||
        v.traceparent.length === 0)) ||
    (v.jobid !== undefined &&
      (typeof v.jobid !== "string" || v.jobid.length === 0)) ||
    (v.parentjobid !== undefined &&
      (typeof v.parentjobid !== "string" || v.parentjobid.length === 0)) ||
    (v.shardid !== undefined &&
      (typeof v.shardid !== "string" || v.shardid.length === 0)) ||
    (v.stage !== undefined &&
      (typeof v.stage !== "string" ||
        !(STAGE_NAMES as readonly string[]).includes(v.stage)))
  ) {
    return false;
  }
  // Extension naming rule (CloudEvents spec): extension names are
  // lowercase. An unknown key with an uppercase letter fails;
  // unknown all-lowercase keys are tolerated as future extensions.
  for (const key of Object.keys(v)) {
    if (!KNOWN_KEYS.has(key) && /[A-Z]/.test(key)) return false;
  }
  // Claim-check enforcement: bulk data must travel by reference.
  // An unserializable data value (e.g. circular) is invalid the same way.
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytes > MAX_ENVELOPE_BYTES) return false;
  } catch {
    return false;
  }
  return true;
}

/** Known envelope keys (required + optional + extensions). */
const KNOWN_KEYS = new Set([
  "specversion",
  "id",
  "source",
  "type",
  "time",
  "data",
  "subject",
  "correlationid",
  "traceparent",
  "jobid",
  "parentjobid",
  "shardid",
  "stage",
]);

/** Throw a neutral error for a malformed envelope. */
export function assertMessageEnvelope(value: unknown): MessageEnvelope {
  if (!isMessageEnvelope(value)) {
    throw new MessagingError(
      "invalid_envelope",
      "Envelope lacks a required CloudEvents attribute (specversion 1.0, id, source, type, time, data) or carries a malformed extension."
    );
  }
  return value;
}

/**
 * The shared, provider-neutral consumption core. Both adapters run
 * it, which is what makes the conformance suite meaningful: the
 * dedup/disposition rules are port behavior, not adapter behavior.
 * Total: invalid items are counted, handler throws become "retry",
 * and this function itself never throws for item-level failures.
 */
export async function deliverEnvelopes(
  items: readonly unknown[],
  seen: Set<string>,
  handler: MessageHandler
): Promise<ConsumeReport> {
  const results: ConsumeResult[] = [];
  for (const item of items) {
    if (!isMessageEnvelope(item)) {
      results.push({ id: null, disposition: "invalid" });
      continue;
    }
    if (seen.has(item.id)) {
      results.push({ id: item.id, disposition: "duplicate" });
      continue;
    }
    let outcome: ConsumeOutcome;
    try {
      outcome = await handler(item);
    } catch {
      outcome = "retry";
    }
    if (outcome === "processed" || outcome === "drop") {
      seen.add(item.id);
    }
    results.push({
      id: item.id,
      disposition:
        outcome === "processed"
          ? "processed"
          : outcome === "drop"
            ? "dropped"
            : "retried",
    });
  }
  return { results };
}

/** Fan-out report: which subscriber streams accepted the event. */
export interface PublishReport {
  deliveredTo: string[];
  failedTo: string[];
}

/** Broadcast side of the port: fan-out by type. */
export interface MessagePublisher {
  publish(envelope: MessageEnvelope): Promise<PublishReport>;
}

/**
 * Subscriber side of the port. `subscribe` registers one handler
 * per (subscriber, type); `dispatch` routes one envelope to
 * that subscriber's handler for its type, with per-subscriber
 * dedup. A dispatch with no registered handler is a drop: there
 * is nothing that could ever process it, so redelivery would
 * only loop.
 */
export interface MessageSubscriber {
  subscribe(
    subscriber: string,
    type: string,
    handler: MessageHandler
  ): () => void;
  dispatch(
    subscriber: string,
    envelope: MessageEnvelope
  ): Promise<ConsumeOutcome>;
}

/** Handlers keyed by subscriber, then by type. */
export type SubscriberHandlers = Map<string, Map<string, MessageHandler>>;

/**
 * The shared, provider-neutral broadcast core. Both adapters run
 * it. The seen key includes the subscriber name, so dedup is per
 * subscriber: redelivery to one subscriber never re-invokes that
 * subscriber's handler, while other subscribers are unaffected.
 * A dispatch that returns "drop" (no handler, or the handler
 * refused terminally) marks the event seen, so redelivery is
 * also a drop rather than a reprocess; a "retry" leaves it
 * unmarked. Total: handler throws become "retry".
 */
export async function dispatchEnvelope(
  handlers: SubscriberHandlers,
  seen: Set<string>,
  subscriber: string,
  envelope: MessageEnvelope
): Promise<ConsumeOutcome> {
  const handler = handlers.get(subscriber)?.get(envelope.type);
  if (!handler) {
    console.warn(
      `[messaging] No handler for subscriber "${subscriber}" and event type "${envelope.type}" — dropping.`
    );
    return "drop";
  }
  const key = `${subscriber}:${envelope.id}`;
  if (seen.has(key)) {
    return "drop";
  }
  let outcome: ConsumeOutcome;
  try {
    outcome = await handler(envelope);
  } catch {
    outcome = "retry";
  }
  if (outcome === "processed" || outcome === "drop") {
    seen.add(key);
  }
  return outcome;
}
