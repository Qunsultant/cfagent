/**
 * Issue #4774 — the execution-tree ids, under the ADOPTED uniform
 * convention (#5175).
 *
 * User rulings:
 *  - 2026-11-16 (issue #4774 comment 6912854849): chains and families
 *    are named by short identifiers (stockscr, optionsscr, goalscr,
 *    strategyscr, feedsrc). EXTENDED 2026-11-17 (comment 6959360479):
 *    the short-id system covers ALL levels of the execution tree —
 *    stages, sub-stages, pipelines, chains, workflows, tasks, etc. —
 *    and each transaction gets its own id: every run/transaction
 *    instance carries a unique id.
 *  - 2026-11-17 (#5175): the UNIFORM convention is adopted — every
 *    generated id is colon-separated segments, the first segment is
 *    the type, no body ever contains `:`. Fixed arity per type. The
 *    short id is the body; the system id is `<type>:<body>`. The
 *    research family's short id is `resrch` (OODA is one research
 *    type within the family); trading is one family, `tradrun`;
 *    `payrun`; `sagarun`; the `sched:` schedule-id form is confirmed.
 *  - 2026-11-17 (#5175): `respipe:` is RETIRED. Run-level research
 *    stages are plain `stage:` ids — the hierarchy scopes them, so no
 *    separate namespace is needed. Only the candidate-level OODA loop
 *    keeps a qualified short id (`ooda:*`).
 *
 * This module is the system: the level taxonomy, the qualified-id
 * formatter, the stage/step/event execution ids, and the OODA loop
 * ids. It is a LEAF — no runtime imports (only `import type`, erased
 * at build) — so client-reachable modules can import it without
 * dragging in a server graph (the #4780 lesson: a definition module
 * imported by a client-reachable module must not import server-only
 * values).
 *
 * What lives where:
 *  - Chain/family short ids: the catalogs (`workflowCatalog`,
 *    `jobDefinitionCatalog`, `chainPipelineJobs`, `optionsChainJobDefinition`).
 *  - Stage/step/event execution ids: the engine's formats, owned here
 *    — `stageExecutionId` (`stage:`), `stepExecutionId` (`step:`, the
 *    journal id in `jobPipelineEngine.ts`), `stageActionEventId`
 *    (`event:`, the CloudEvents id in `jobPipelineEvents.ts`).
 *    Composite ids embed BODIES, never full ids: a stage id embeds the
 *    run body (`m9x-1`), not the run id (`run:m9x-1`), and the stage
 *    body (`feed`), not the qualified node id (`job:feed`). That is
 *    what keeps every id's arity fixed.
 *  - OODA loop: `ooda:*` (the candidate-level loop). Run-level stages
 *    carry no loop qualifier — see `stageExecutionId`.
 *  - Per-instance ids: engine runs mint `run:<time>-<counter>`
 *    (`jobPipelineEngine.ts` `newRunId`); async jobs mint
 *    `crypto.randomUUID()`; ledger rows carry their `id` PK
 *    (`mas_transactions`). A trace step's instance id is DERIVABLE —
 *    `traceStepInstanceId(runId, shortId, index)` — not stored.
 *
 * NOT in this slice (legacy, pending #5175 migration — the uniform
 * convention's migration slices, not this rework):
 *  - Research runs still mint `rsr_<time>_<rand>`
 *    (`researchPipeline.ts` `newRunId`); the research job id
 *    (`research:<runId>`), checkpoint keys, and generation ids still
 *    embed the full research run id; the options-chain `chainId` is
 *    still a bare UUID. Those minters and their consumers move in
 *    #5175's migration slices (CFO lane owns the research surfaces).
 *    The minters below already exist — the call sites do NOT use
 *    them yet; migrating the 20 legacy run-id call sites is #5175
 *    slice 3, and the no-minting-elsewhere pin is slice 4. Slice 3
 *    migrated the fresh-entropy sites to these minters; the
 *    deterministic sites (report-row generation ids, stage-claim
 *    keys, quota-charge keys, research) keep their legacy strings
 *    until the resolve-or-mint follow-up — they are idempotency keys,
 *    not fresh mints, and a fresh mint there would fork rows.
 *  - Persisting per-step instance ids as stored fields (they are
 *    derivable today from runId + qualified step + index).
 *
 * #5175 slice 1 — the one leaf minter (this slice). The minters
 * below are the single minting authority: one function per id type,
 * one format per type declared as data (`ID_FORMAT_ARITY`), entropy
 * from `crypto.randomUUID()` inside this module only (the run id
 * keeps its adopted `time36-counter36` body, whose entropy is the
 * mint time plus a module counter). Derived ids are built here too —
 * every derived id embeds BODIES, never full ids. `parseId` is the
 * authority's shape check: it rejects any id whose segment count
 * does not match its type, and any body that violates its type's
 * shape. It accepts canonical ids only — legacy ids are aliases,
 * resolved by the registry (#5175 slice 2), never parsed here.
 * The registry (`mas_runs`, slice 2) and the resolver API / MCP
 * `resolve_id` (slice 5) are NOT built here.
 */
import type { OodaStep } from "./researchPipeline";

/** Every level of the execution tree, with its short id. */
export const EXECUTION_TREE_LEVEL_SHORT_IDS = {
  chain: "chain",
  pipeline: "pipe",
  workflow: "wf",
  job: "job",
  stage: "stage",
  /** Sub-stage: one execution unit inside a stage (one shard key). */
  unit: "unit",
  task: "task",
  run: "run",
  /** Transaction: one ledger / transaction-aspect unit. */
  txn: "txn",
} as const;

export type ExecutionTreeLevel = keyof typeof EXECUTION_TREE_LEVEL_SHORT_IDS;

/**
 * One printable id for one instance at one level:
 * `<level-short-id>:<local-id>` — e.g. `chain:feedsrc`,
 * `run:m9x-1`, `job:stock-screener`. The local id is the BODY, never a
 * full id; the level prefix is what makes the same local string
 * unambiguous across levels.
 */
export function qualifyExecutionId(level: ExecutionTreeLevel, localId: string): string {
  return `${EXECUTION_TREE_LEVEL_SHORT_IDS[level]}:${localId}`;
}

/**
 * The body of a run id: the part after the `run:` type prefix.
 * Lenient by design — an id without the prefix (an injected test id
 * such as `run-1`, or a legacy `rsr_*` research run id) is returned
 * unchanged, so callers that mint their own ids keep working and the
 * legacy research format stays resolvable until #5175 migrates it.
 */
export function runIdBody(runId: string): string {
  return runId.startsWith("run:") ? runId.slice("run:".length) : runId;
}

/**
 * The body of a stage / node id: the part after the `job:` type
 * prefix (`job:feed` → `feed`). Stage ids and node paths share the
 * `job:<nodePath>` namespace; composite ids embed the body, never the
 * qualified id — that is what keeps every id's arity fixed. Lenient
 * like `runIdBody`: a bare name passes through unchanged.
 */
export function stageIdBody(stageId: string): string {
  return stageId.startsWith("job:") ? stageId.slice("job:".length) : stageId;
}

/**
 * One printable id for one stage execution:
 * `stage:<runBody>:<stageId>:<unitId>` — e.g. `stage:m9x-1:feed:-`.
 * The run body (not the run id) and the stage body (not the qualified
 * `job:<nodePath>`) are embedded, so the id is always 4 segments.
 * A stage without units carries `"-"` as the unit half.
 *
 * The event id (`stageActionEventId`) shares the run body + stage +
 * unit segments with this id — that segment equality, not a string
 * prefix, is the link between a stage execution and its events.
 */
export function stageExecutionId(runId: string, stageId: string, unitId?: string): StageExecutionId {
  return `stage:${runIdBody(runId)}:${stageIdBody(stageId)}:${unitId ?? "-"}` as StageExecutionId;
}

/**
 * One printable id for one step execution (one journaled step invocation):
 * `step:<runBody>:<nodePath>:<stepIndex>:<shardKey>:<itemIndex>` —
 * e.g. `step:m9x-1:feed:0:AAPL:0`. This is the journal id
 * `JobPipelineEngine` passes to `journal.do` (`jobPipelineEngine.ts`)
 * — the durability key for the step's exactly-once execution. It is
 * derived deterministically from the same tuple as before, so a retry
 * computes the same id; only the prefix and the embedded bodies
 * changed (the uniform convention).
 */
export function stepExecutionId(
  runId: string,
  path: string,
  stepIndex: number,
  shardKey?: string | null,
  itemIndex?: number | null,
): StepExecutionId {
  return `step:${runIdBody(runId)}:${stageIdBody(path) || "root"}:${stepIndex}:${shardKey ?? "-"}:${itemIndex ?? "-"}` as StepExecutionId;
}

/**
 * One printable id for one stage-action CloudEvents event:
 * `event:<runBody>:<stageId>:<unitId>:<action>:<atMillis>:<suffix>` —
 * e.g. `event:m9x-1:feed:-:start:1763419200000:abc123`. The `<at>` is
 * epoch millis, not ISO — an ISO timestamp contains `:`, so it cannot
 * appear in a body. The first three segments after the type are the
 * stage execution's segments (run body, stage, unit): the event id
 * shares them with `stageExecutionId`, which is how an event resolves
 * to its stage.
 */
export function stageActionEventId(
  runId: string,
  stageId: string,
  unitId: string | undefined,
  action: string,
  atMillis: number,
  suffix: string,
): StageActionEventId {
  return `event:${runIdBody(runId)}:${stageIdBody(stageId)}:${unitId ?? "-"}:${action}:${atMillis}:${suffix}` as StageActionEventId;
}

/** The candidate-level OODA loop's short id (one loop per candidate). */
export const OODA_LOOP_SHORT_ID = "ooda" as const;

/**
 * The level-qualified id of one candidate-level OODA step:
 * `ooda:observe` | `ooda:orient` | `ooda:decide` | `ooda:act`.
 */
export function oodaStepShortId(stage: OodaStep["stage"]): string {
  return `${OODA_LOOP_SHORT_ID}:${stage}`;
}

/**
 * One printable id for one trace-step instance, DERIVED (not stored):
 * `trace:<runBody>:<loop>:<step>:<index>` — e.g.
 * `trace:m9x-1:ooda:observe:2`. The index is the entry's position in
 * its trace array (`oodaTrace`); two entries with the same qualified
 * step in one run differ by index, two runs differ by run body. The
 * qualified step splits on `:` into its loop and step halves. If
 * per-step instance ids ever need to be stored fields rather than
 * derived, that is follow-up work, not this slice.
 */
export function traceStepInstanceId(runId: string, shortId: string, index: number): TraceStepInstanceId {
  const [loop, step] = shortId.split(":");
  if (step === undefined) {
    throw new Error(
      `traceStepInstanceId: expected a qualified step id "<loop>:<step>", got "${shortId}" (#4774)`,
    );
  }
  return `trace:${runIdBody(runId)}:${loop}:${step}:${index}` as TraceStepInstanceId;
}

/* ------------------------------------------------------------------ */
/* #5175 slice 1 — the one leaf minter.                               */
/*                                                                     */
/* One function per id type, one format per type, entropy from        */
/* `crypto.randomUUID()` inside this module only. No other module     */
/* mints an id after the migration slices land; until then the        */
/* legacy inline minters still exist at their call sites (slice 3    */
/* moves them). This module stays a LEAF: no runtime imports —       */
/* `crypto` is a platform global, not an import.                      */
/* ------------------------------------------------------------------ */

/**
 * Opaque id types (addendum 2): only this module can mint one of
 * these. A branded string is still a `string` at every use site, so
 * existing callers keep compiling — the brand only stops
 * *construction* outside the authority. A format change cannot leak
 * through construction, because construction exists in exactly one
 * place.
 */
export type BrandedId<Tag extends string> = string & { readonly __brand: Tag };
export type RunId = BrandedId<"RunId">;
export type AsyncJobId = BrandedId<"AsyncJobId">;
export type PaymentDraftId = BrandedId<"PaymentDraftId">;
export type TaskProposalId = BrandedId<"TaskProposalId">;
export type LocalOrderId = BrandedId<"LocalOrderId">;
export type DidProofId = BrandedId<"DidProofId">;
export type GoalRecordId = BrandedId<"GoalRecordId">;
export type ScheduleId = BrandedId<"ScheduleId">;
export type PlatformRowId = BrandedId<"PlatformRowId">;
export type JobInstanceId = BrandedId<"JobInstanceId">;
export type GenerationId = BrandedId<"GenerationId">;
export type DeliveryId = BrandedId<"DeliveryId">;
export type ChainId = BrandedId<"ChainId">;
export type JobDefinitionId = BrandedId<"JobDefinitionId">;
export type NodeId = BrandedId<"NodeId">;
export type PipeId = BrandedId<"PipeId">;
export type LevelId = BrandedId<"LevelId">;
export type StageExecutionId = BrandedId<"StageExecutionId">;
export type StepExecutionId = BrandedId<"StepExecutionId">;
export type StageActionEventId = BrandedId<"StageActionEventId">;
export type TraceStepInstanceId = BrandedId<"TraceStepInstanceId">;

/**
 * The ruled family short ids (#4774 comment 6912854849; extended
 * 2026-11-17: `resrch`, `tradrun`, `payrun`, `sagarun`). The set is
 * closed: a new family needs a ruling and one line here.
 */
export const FAMILY_SHORT_IDS = [
  "stockscr",
  "optionsscr",
  "goalscr",
  "strategyscr",
  "feedsrc",
  "resrch",
  "tradrun",
  "payrun",
  "sagarun",
] as const;

export type FamilyShortId = (typeof FAMILY_SHORT_IDS)[number];

/** The candidate-level OODA loop's steps (mirrors `OodaStep["stage"]`). */
export const OODA_STEPS = ["observe", "orient", "decide", "act"] as const;

/**
 * Fixed arity (segment count) per id type, declared as data in the
 * authority — the colon rule (addendum 5 §1). `job:` is deliberately
 * overloaded: `job:<spec>` names a job definition and `job:<uuid>`
 * names an async job; both have 2 segments and the body
 * disambiguates (a spec name vs a UUID). Job-instance ids
 * (`<kind>:<runBody>`, e.g. `research:m9x-1`) are NOT in this table:
 * the kind is open, so the parser recognizes them by shape (2
 * segments, second segment a run body) instead of by first segment.
 */
export const ID_FORMAT_ARITY = {
  chain: 2,
  lvl: 2,
  ooda: 2,
  job: 2,
  pipe: 2,
  run: 2,
  pay: 2,
  task: 2,
  ord: 2,
  proof: 2,
  goal: 2,
  scen: 2,
  outc: 2,
  sched: 2,
  gen: 2,
  report: 2,
  outcome: 2,
  audit: 2,
  node: 3,
  delivery: 3,
  /** #5175 slice 3: a shard scan's derived run id (see `shardScanRunId`). */
  "shard-scan": 3,
  stage: 4,
  trace: 5,
  step: 6,
  event: 7,
} as const;

export type IdTypeName = keyof typeof ID_FORMAT_ARITY;

/**
 * Ids the authority RECOGNIZES but never generates (addendum 3 §D):
 * assigned by others, stored as-is, declared here by source. The
 * registry (slice 2) records them by source; no minter exists for
 * any of them, by design.
 */
export const EXTERNAL_ID_SOURCES = {
  gateway_ref: "payment gateway",
  order_ref: "broker",
  instanceId: "Workflows runtime",
  traceId: "OpenTelemetry, bare hex for W3C traceparent",
  spanId: "OpenTelemetry, bare hex for W3C traceparent",
  session_id: "scope key, not an instance id",
} as const;

/**
 * Fail-closed guard for every caller-supplied body part: a body must
 * be non-empty and must never contain `:`. A `:` inside a body would
 * silently change the id's arity and break every parser downstream.
 */
export function assertIdBodyPart(value: string, label: string): void {
  if (value === "") {
    throw new Error(`id authority (#5175): ${label} must not be empty`);
  }
  if (value.includes(":")) {
    throw new Error(`id authority (#5175): ${label} must not contain ":", got "${value}"`);
  }
}

/* --- Minted ids (fresh entropy) --- */

/** Module counter for run ids: two runs minted in the same millisecond still differ. */
let runCounter = 0;

/**
 * One run id: `run:<time36>-<counter36>` — e.g. `run:m9x2k-1`. The
 * body embeds the mint time (base36 millis) plus a module counter,
 * exactly the engine's adopted format (`jobPipelineEngine.ts`
 * `newRunId`); the counter is per-module (per isolate) rather than
 * per-engine-instance, so two engines in one isolate cannot collide.
 */
export function newRunId(): RunId {
  return `run:${Date.now().toString(36)}-${(++runCounter).toString(36)}` as RunId;
}

/** First 8 hex chars of a fresh UUID — the `pay_`/`task_`/`ord_` legacy shape, re-prefixed. */
function uuid8(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** First 12 hex chars of a fresh UUID (dashes stripped) — the `proof:` body. */
function uuid12(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/** 6 hex chars of fresh entropy — the `<rand6>` half of a goal id. */
function rand6(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 6);
}

/** One async-job id: `job:<uuid>` — the MCP receipt jobId and the `mas_async_jobs` row id. */
export function newAsyncJobId(): AsyncJobId {
  return `job:${crypto.randomUUID()}` as AsyncJobId;
}

/** One payment-draft id: `pay:<uuid8>` — the draft id IS its `mas_transactions` row id. */
export function newPaymentDraftId(): PaymentDraftId {
  return `pay:${uuid8()}` as PaymentDraftId;
}

/** One task-proposal id: `task:<uuid8>`. */
export function newTaskProposalId(): TaskProposalId {
  return `task:${uuid8()}` as TaskProposalId;
}

/** One local-order id: `ord:<uuid8>`. */
export function newLocalOrderId(): LocalOrderId {
  return `ord:${uuid8()}` as LocalOrderId;
}

/** One DID payment-authorization proof id: `proof:<uuid12>`. */
export function newDidProofId(): DidProofId {
  return `proof:${uuid12()}` as DidProofId;
}

/**
 * One goal-record id: `goal:<time36>-<rand6>` — e.g.
 * `goal:m9x2k-ab12cd`. The exact legacy prefix is unverified (gap
 * G12); this is the canonical shape, and the legacy
 * `<prefix>_<time>_<rand6>` spellings become aliases in slice 3.
 */
export function newGoalRecordId(): GoalRecordId {
  return `goal:${Date.now().toString(36)}-${rand6()}` as GoalRecordId;
}

/** One schedule id: `sched:<uuid>` (form approved 2026-11-17). */
export function newScheduleId(): ScheduleId {
  return `sched:${crypto.randomUUID()}` as ScheduleId;
}

/**
 * One platform-facing D1 row id: `<rowKind>:<uuid>` — e.g.
 * `report:<uuid>`, `outcome:<uuid>`, `audit:<uuid>`.
 */
export function newPlatformRowId(rowKind: string): PlatformRowId {
  assertIdBodyPart(rowKind, "row kind");
  return `${rowKind}:${crypto.randomUUID()}` as PlatformRowId;
}

/* --- Derived ids (no fresh entropy — computed from the run body) --- */

/**
 * One job-instance id: `<kind>:<runBody>` — e.g.
 * `research:m9x-1`, `options-chain:m9x-1`. The kind is the engine
 * job kind; the run body (not the run id) is embedded.
 */
export function jobInstanceId(kind: string, runId: string): JobInstanceId {
  assertIdBodyPart(kind, "job kind");
  return `${kind}:${runIdBody(runId)}` as JobInstanceId;
}

/** One generation id: `gen:<runBody>` — one report generation produced by a run. */
export function generationId(runId: string): GenerationId {
  return `gen:${runIdBody(runId)}` as GenerationId;
}

/**
 * One delivery id: `delivery:<runBody>:<destination>` — e.g.
 * `delivery:m9x-1:slack-C12345`. The destination is colon-free by
 * construction (guarded); the suppression key is the (`runId`,
 * `destination`) pair, not this id.
 */
export function deliveryId(runId: string, destination: string): DeliveryId {
  assertIdBodyPart(destination, "delivery destination");
  return `delivery:${runIdBody(runId)}:${destination}` as DeliveryId;
}

/** One family id: `chain:<family>` — the family short id, ruled, not minted. */
export function chainId(family: string): ChainId {
  if (!(FAMILY_SHORT_IDS as readonly string[]).includes(family)) {
    throw new Error(`id authority (#5175): unknown family short id "${family}"`);
  }
  return `chain:${family}` as ChainId;
}

/** One job-definition id: `job:<spec>` — e.g. `job:screener`. */
export function jobDefinitionId(spec: string): JobDefinitionId {
  assertIdBodyPart(spec, "job definition spec");
  return `job:${spec}` as JobDefinitionId;
}

/** One job-definition node id: `node:<spec>:<nodePath>` — e.g. `node:screener:root`. */
export function nodeId(spec: string, nodePath: string): NodeId {
  assertIdBodyPart(spec, "job definition spec");
  assertIdBodyPart(nodePath, "node path");
  return `node:${spec}:${nodePath}` as NodeId;
}

/** One feed-pipeline job id: `pipe:<feed>-<dataset>` — e.g. `pipe:example-feed-example-dataset`. */
export function pipeId(feed: string, dataset: string): PipeId {
  assertIdBodyPart(feed, "feed");
  assertIdBodyPart(dataset, "dataset");
  return `pipe:${feed}-${dataset}` as PipeId;
}

/** One level id: `lvl:<level>` — e.g. `lvl:run`. */
export function levelId(level: ExecutionTreeLevel): LevelId {
  return `lvl:${EXECUTION_TREE_LEVEL_SHORT_IDS[level]}` as LevelId;
}

/**
 * One shard scan's derived run id: `shard-scan:<chainId>:<symbol>` —
 * e.g. `shard-scan:550e8400-e29b-41d4-a716-446655440000:AAPL`.
 *
 * Issue #4420 — the engine job id that inner shard scan is defined and
 * checkpointed as. Deriving it from the shard payload is what lets the
 * checkpoint and the shard row name the same run; the reader derives it
 * from the shard's own payload (chain id + shard key) instead of
 * guessing. That determinism is load-bearing (a fresh mint would fork
 * the checkpoint), so this builder KEEPS the legacy format — slice 3
 * adopts the construction into the leaf (it lived in
 * `optionsScreenEngine.ts`), it does not re-mint it. The chain id is a
 * bare UUID today (#4780 left it that way); the symbol is colon-free
 * by construction (asserted by the caller-side shard key).
 */
export type ShardScanRunId = BrandedId<"ShardScanRunId">;

export function shardScanRunId(chainId: string, symbol: string): ShardScanRunId {
  assertIdBodyPart(chainId, "shard-scan chain id");
  assertIdBodyPart(symbol, "shard-scan symbol");
  return `shard-scan:${chainId}:${symbol}` as ShardScanRunId;
}

/* --- The parser (the authority's shape check) --- */

const RUN_BODY_PATTERN = /^[0-9a-z]+-[0-9a-z]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID8_PATTERN = /^[0-9a-f]{8}$/;
const UUID12_PATTERN = /^[0-9a-f]{12}$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^[0-9]+$/;

export interface ParsedId {
  /** The first segment: the id's type (or the job kind, for job-instance ids). */
  readonly type: string;
  /** Every segment, in order. */
  readonly segments: readonly string[];
  /** The run body when the id carries one, else null. */
  readonly runBody: string | null;
}

function parseError(id: string, why: string): Error {
  return new Error(`id authority (#5175): cannot parse "${id}": ${why}`);
}

/**
 * Parse a canonical id into its segments, checking the fixed arity
 * for its type and the body shapes the type requires. Accepts
 * canonical ids only — legacy ids (`rsr_…`, `run-…`, `screener:…`,
 * …) are aliases, resolved by the registry (slice 2), never parsed
 * here. A job-instance id (`<kind>:<runBody>`) is recognized by
 * shape: 2 segments, second segment a run body. Throws on any
 * malformed, unknown, or wrong-arity id — fail-closed, never lenient.
 */
export function parseId(id: string): ParsedId {
  const segments = id.split(":");
  const type = segments[0] ?? "";
  if (segments.some((segment) => segment === "")) {
    throw parseError(id, "an id must not contain an empty segment");
  }
  const arity = (ID_FORMAT_ARITY as Readonly<Record<string, number | undefined>>)[type];
  if (arity !== undefined) {
    if (segments.length !== arity) {
      throw parseError(id, `"${type}" ids have ${arity} segments, got ${segments.length}`);
    }
    switch (type) {
      case "chain": {
        if (!(FAMILY_SHORT_IDS as readonly string[]).includes(segments[1] as string)) {
          throw parseError(id, `unknown family short id "${segments[1]}"`);
        }
        break;
      }
      case "lvl": {
        const levels = Object.values(EXECUTION_TREE_LEVEL_SHORT_IDS) as readonly string[];
        if (!levels.includes(segments[1] as string)) {
          throw parseError(id, `unknown level short id "${segments[1]}"`);
        }
        break;
      }
      case "ooda": {
        if (!(OODA_STEPS as readonly string[]).includes(segments[1] as string)) {
          throw parseError(id, `unknown OODA step "${segments[1]}"`);
        }
        break;
      }
      case "run":
      case "gen":
      case "stage":
      case "delivery": {
        if (!RUN_BODY_PATTERN.test(segments[1] as string)) {
          throw parseError(id, `segment 2 is not a run body: "${segments[1]}"`);
        }
        break;
      }
      case "pay":
      case "task":
      case "ord": {
        if (!UUID8_PATTERN.test(segments[1] as string)) {
          throw parseError(id, `segment 2 is not an 8-hex id: "${segments[1]}"`);
        }
        break;
      }
      case "proof": {
        if (!UUID12_PATTERN.test(segments[1] as string)) {
          throw parseError(id, `segment 2 is not a 12-char proof id: "${segments[1]}"`);
        }
        break;
      }
      case "goal": {
        if (!RUN_BODY_PATTERN.test(segments[1] as string)) {
          throw parseError(id, `segment 2 is not a <time>-<rand6> body: "${segments[1]}"`);
        }
        break;
      }
      case "sched":
      case "report":
      case "outcome":
      case "audit":
      case "scen":
      case "outc": {
        if (!UUID_PATTERN.test(segments[1] as string)) {
          throw parseError(id, `segment 2 is not a UUID: "${segments[1]}"`);
        }
        break;
      }
      case "step": {
        if (!RUN_BODY_PATTERN.test(segments[1] as string)) {
          throw parseError(id, `segment 2 is not a run body: "${segments[1]}"`);
        }
        if (!NON_NEGATIVE_INTEGER_PATTERN.test(segments[3] as string)) {
          throw parseError(id, `segment 4 is not a step index: "${segments[3]}"`);
        }
        if (
          segments[5] !== "-" &&
          !NON_NEGATIVE_INTEGER_PATTERN.test(segments[5] as string)
        ) {
          throw parseError(id, `segment 6 is not an item index: "${segments[5]}"`);
        }
        break;
      }
      case "trace": {
        if (!RUN_BODY_PATTERN.test(segments[1] as string)) {
          throw parseError(id, `segment 2 is not a run body: "${segments[1]}"`);
        }
        if (!NON_NEGATIVE_INTEGER_PATTERN.test(segments[4] as string)) {
          throw parseError(id, `segment 5 is not a trace index: "${segments[4]}"`);
        }
        break;
      }
      case "event": {
        if (!RUN_BODY_PATTERN.test(segments[1] as string)) {
          throw parseError(id, `segment 2 is not a run body: "${segments[1]}"`);
        }
        if (!NON_NEGATIVE_INTEGER_PATTERN.test(segments[5] as string)) {
          throw parseError(id, `segment 6 is not epoch millis: "${segments[5]}"`);
        }
        break;
      }
      default:
        break;
    }
  } else {
    // Job-instance ids: <kind>:<runBody> — the kind is open, so the
    // shape is the check: exactly 2 segments, second a run body.
    if (segments.length !== 2 || !RUN_BODY_PATTERN.test(segments[1] as string)) {
      throw parseError(id, `unknown id type "${type}"`);
    }
  }
  const runBody =
    type === "run" ||
    type === "gen" ||
    type === "stage" ||
    type === "step" ||
    type === "event" ||
    type === "trace" ||
    type === "delivery" ||
    arity === undefined
      ? (segments[1] as string)
      : null;
  return { type, segments, runBody };
}
