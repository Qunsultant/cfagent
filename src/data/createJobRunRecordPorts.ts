/**
 * Issue #6101 — composition root for the D1 run-record port. This
 * is the ONLY module that maps a Worker binding to the run-record
 * port implementation: domain code imports this helper and the port
 * types, never a store client. Mirrors
 * src/data/createAuditEventPorts.ts (#6102).
 *
 * Absence of the binding is a normal, non-error state:
 * `createJobRunRecordAdapter` returns null and callers keep their
 * fail direction — run recording is fail-closed (a bound D1 is
 * required; an unbound env throws at the write door, never
 * silently drops the run), reads return empty per their own
 * contract. Never fall back to the DO job_run_records table: after
 * cutover the DO table is frozen pre-cutover history, and the only
 * DO reads left are the retention drain. The #6099 projector is
 * deleted — no code re-points at a projection.
 *
 * Attribution (Q7/Q8): the tenant comes from IAAA_TENANT_ID (the
 * projector's precedent — the default tenant when unconfigured);
 * the platform from PLATFORM_ID (default "cfagent", the #6100
 * attribution envelope). User and session are caller-supplied
 * only — never inferred from the env, never invented; absent means
 * NULL on the row. Correlation/trace ride the call site's values.
 *
 * #CDO-mha7
 */
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
  type JobRunRecordDb,
} from "./d1JobRunRecordAdapter";
import {
  buildJobRunRecord,
  type JobRunRecordInput,
} from "../services/jobRunRecords";
import type { JobRunRecord } from "./jobRunRecordPorts";
import type { JobRunRecorder } from "../services/jobPipelineEngine";
import { resolveIaaaTenant } from "../security/iaaaGithubEndToEnd";
import { resolvePlatformId } from "../security/attributionEnvelope";

/** Build the run-record adapter from Worker env, or null if unbound. */
export function createJobRunRecordAdapter(env: {
  AGENT_DB?: unknown;
} | null | undefined): D1JobRunRecordStore | null {
  if (!env || !env.AGENT_DB) return null;
  return new D1JobRunRecordStore(createD1JobRunRecordDb(env.AGENT_DB as D1Database));
}

/**
 * Build the adapter AND ensure its schema (idempotent — migration
 * 0093 applies once), so a first run write never fails closed
 * merely because the migration was never applied to this D1.
 * Returns null if unbound.
 */
export async function createEnsuredJobRunRecordAdapter(env: {
  AGENT_DB?: unknown;
} | null | undefined): Promise<D1JobRunRecordStore | null> {
  if (!env || !env.AGENT_DB) return null;
  const db = createD1JobRunRecordDb(env.AGENT_DB as D1Database);
  await ensureJobRunRecordsSchema(db);
  return new D1JobRunRecordStore(db);
}

/**
 * The memoized ensured port per env object (one adapter per
 * isolate — env is stable per isolate, so the WeakMap is
 * effectively per-isolate). Every run-record call site resolves
 * the port through here; the ensure runs once per env, and a
 * failed ensure stays failed (fail-closed, same as the audit-event
 * port's per-instance memo).
 */
const ensuredPorts = new WeakMap<object, Promise<D1JobRunRecordStore | null>>();

export function jobRunRecordPort(
  env: { AGENT_DB?: unknown } | undefined | null,
): Promise<D1JobRunRecordStore | null> {
  if (!env || !env.AGENT_DB) return Promise.resolve(null);
  let port = ensuredPorts.get(env);
  if (!port) {
    port = createEnsuredJobRunRecordAdapter(env);
    ensuredPorts.set(env, port);
  }
  return port;
}

/** The identity attribution stamped on a run record (Q7/Q8). */
export interface LedgerAttribution {
  tenantId: string;
  platformId: string;
  userId?: string;
  sessionId?: string;
  correlationId?: string;
  traceId?: string;
}

/**
 * Resolve the host's ledger attribution from env + caller
 * overrides. Tenant and platform always resolve (defaults, never
 * invented values); user/session/correlation/trace come from the
 * caller only — absent stays absent, never guessed from env.
 */
export function resolveLedgerAttribution(
  env: {
    AGENT_DB?: unknown;
    IAAA_TENANT_ID?: unknown;
    PLATFORM_ID?: unknown;
  } | null | undefined,
  overrides?: Partial<LedgerAttribution>,
): LedgerAttribution {
  const envLike = env as Partial<import("../types").Env> | null | undefined;
  return {
    tenantId: overrides?.tenantId ?? resolveIaaaTenant(envLike),
    platformId:
      overrides?.platformId ??
      resolvePlatformId(
        typeof env?.PLATFORM_ID === "string" ? env.PLATFORM_ID : undefined,
      ),
    ...(overrides?.userId !== undefined ? { userId: overrides.userId } : {}),
    ...(overrides?.sessionId !== undefined
      ? { sessionId: overrides.sessionId }
      : {}),
    ...(overrides?.correlationId !== undefined
      ? { correlationId: overrides.correlationId }
      : {}),
    ...(overrides?.traceId !== undefined ? { traceId: overrides.traceId } : {}),
  };
}

/**
 * The one async D1 write entry for a run record: build (validate)
 * the record — attribution fills only the identity fields the
 * input did not carry; an explicit input value always wins — then
 * record it through the D1 store. A poisoned identity literal
 * throws the #3650 honesty error and nothing is written.
 */
export async function recordLedgerRunD1(
  store: D1JobRunRecordStore,
  input: JobRunRecordInput,
  attribution?: Partial<LedgerAttribution>,
): Promise<JobRunRecord> {
  const built = buildJobRunRecord({
    ...input,
    tenantId: input.tenantId ?? attribution?.tenantId,
    platformId: input.platformId ?? attribution?.platformId,
    userId: input.userId ?? attribution?.userId,
    sessionId: input.sessionId ?? attribution?.sessionId,
    correlationId: input.correlationId ?? attribution?.correlationId,
    traceId: input.traceId ?? attribution?.traceId,
  });
  await store.record(built);
  return built;
}

/**
 * The engine seam over the D1 store: the async JobRunRecorder the
 * pipeline engine consumes, stamping the host's attribution on
 * every recordRun. Mirrors jobRunRecorderFromStore (the DO seam)
 * without inventing a second store or record shape.
 */
export function jobRunRecorderFromD1(
  store: D1JobRunRecordStore,
  attribution: Partial<LedgerAttribution>,
): JobRunRecorder {
  return {
    recordRun: async (record) => {
      await recordLedgerRunD1(store, record, attribution);
    },
    listRuns: async (jobId, limit) => store.listByJob(jobId, limit),
    latestRun: async (jobId) => store.latestByJob(jobId),
  };
}

/**
 * The fail-closed recorder for a host with no D1 binding: a write
 * throws a named error (a run that cannot be recorded honestly
 * fails settlement rather than silently vanishing — the #6102
 * fail-closed rule for blocking writes), while reads return empty
 * (no ledger exists to read). Never a silent no-op write, never
 * an in-memory substitute that would lose the run.
 */
export function jobRunRecorderUnbound(): JobRunRecorder {
  const error = new Error(
    "[run-ledger] D1 run-ledger binding unbound (AGENT_DB): the run cannot be recorded; configure the binding rather than recording nowhere (#6101).",
  );
  return {
    recordRun: async () => {
      throw error;
    },
    listRuns: async () => [],
    latestRun: async () => undefined,
  };
}

/**
 * The engine seam from Worker env: the D1 recorder when AGENT_DB
 * is bound (attribution from the same env), the fail-closed
 * recorder otherwise. The one place a sync factory resolves a
 * recorder without awaiting an ensure — the D1 store ensures its
 * schema lazily on first use.
 */
export function jobRunRecorderFromEnv(
  env: { AGENT_DB?: unknown; IAAA_TENANT_ID?: unknown; PLATFORM_ID?: unknown } | null | undefined,
): JobRunRecorder {
  const store = createJobRunRecordAdapter(env);
  if (!store) return jobRunRecorderUnbound();
  return jobRunRecorderFromD1(store, resolveLedgerAttribution(env));
}

export { ensureJobRunRecordsSchema };
export type { JobRunRecordDb, JobRunRecord };
export type { D1JobRunRecordStore } from "./d1JobRunRecordAdapter";
