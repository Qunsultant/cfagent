/**
 * Issue #2337 (#1976 step 2) — composition root for the
 * options/discovery store family. This is the ONLY module that
 * maps a host's storage handles to the family's production
 * implementations: domain code imports this helper and the port
 * types, never a store client.
 *
 * The family's hosts (OrchestratorAgent and everything it
 * feeds) hold two handles over the same Durable Object SQLite
 * database: the sql executor (ctx.storage.sql-shaped) and —
 * when the host passes it — the transaction-capable storage
 * object (ctx.storage). The adapters' withTransaction wraps
 * (ADR D-C) engage through the registered transaction runner
 * (transactionRunnerProvider.ts; src/server.ts registers the
 * aspect-backed runner once) — this module and the adapters
 * import the aspect's TYPES only, because the options family
 * is reachable from the client bundle through the trading
 * barrel and the aspect (node:async_hooks) is server-only
 * (the step-1 registry lesson, #2303). Hosts that pass only
 * the sql handle get the identical adapters with sequential
 * application, exactly the legacy behaviour.
 *
 * IV HISTORY (cutover executed, R-2 on #2337): the env-aware
 * build (buildOptionsDiscoveryPorts) selects the D1 adapter
 * whenever AGENT_DB is bound; IV_HISTORY_D1_ENABLED ===
 * "false" is the rollback lever that forces the DO adapter
 * even when bound, and with no AGENT_DB binding the DO
 * adapter is used regardless (tests/dev without a D1
 * binding). The sync root always composes the DO adapter.
 * The owner ruling recorded on the issue accepts the
 * consequence: production D1 starts EMPTY — a warming-up
 * restart, no backfill — and the DO-side series collected
 * per instance are abandoned (a scoped exception to the
 * 2026-10-13 365-day retention decision, this store only).
 * Cold reads report the honest warming-up state
 * (observations 0, warmingUp true, latest null); nothing
 * falls back to the abandoned DO data.
 *
 * This module imports the transaction aspect (node:async_hooks)
 * through the adapters — it is SERVER-ONLY. Client-reachable
 * modules must import the port TYPES from the individual
 * *Ports.ts files (type-only, erased at compile time), never
 * this root.
 */
import type { DoTransactionStorage } from "../aspects/transactionAspect";
import {
  createD1IvHistoryDb,
  D1IvHistoryStore,
  ensureIvHistorySchema,
  type IvHistoryDb,
} from "./d1IvHistoryAdapter";
import { SqlDiscoveryAlertStore } from "./doSqliteDiscoveryAlertAdapter";
import { SqlDiscoveryRunStore } from "./doSqliteDiscoveryRunAdapter";
import { SqlDiscoverySetupStore } from "./doSqliteDiscoverySetupAdapter";
import { SqlFeedSnapshotStore } from "./doSqliteFeedSnapshotAdapter";
import { SqlIvHistoryStore } from "./doSqliteIvHistoryAdapter";
import { SqlScanRunStore } from "./doSqliteScanRunAdapter";
import { SqlStrategyProfileStore } from "./doSqliteStrategyProfileAdapter";
import type { DiscoveryAlertStore } from "./discoveryAlertPorts";
import type { DiscoveryRunStore } from "./discoveryRunPorts";
import type { DiscoverySetupStore } from "./discoverySetupPorts";
import type { FeedSnapshotStore } from "./feedSnapshotPorts";
import type { IvHistoryStore } from "./ivHistoryPorts";
import type { ScanRunStore, ScanSqlExecutor } from "./scanRunPorts";
import type { StrategyProfileStore } from "./strategyProfilePorts";

export interface OptionsDiscoveryPorts {
  scanRuns: ScanRunStore;
  discoveryRuns: DiscoveryRunStore;
  discoverySetupRuns: DiscoverySetupStore;
  discoveryAlerts: DiscoveryAlertStore;
  ivHistory: IvHistoryStore;
  strategyProfiles: StrategyProfileStore;
  feedSnapshots: FeedSnapshotStore;
}

export interface OptionsDiscoveryPortInputs {
  /** The DO sql executor (ctx.storage.sql-shaped). Every
   *  family adapter executes through this handle; the family's
   *  executor interfaces are all the same structural shape. */
  sql: ScanSqlExecutor;
  /** The transaction-capable storage object (ctx.storage) and the process registered the transaction runner (src/server.ts; see transactionRunnerProvider.ts).
   *  When present, the adapters' multi-statement units run
   *  through withTransaction; when absent they apply
   *  sequentially (legacy behaviour). Typed as the workers
   *  DurableObjectStorage (what hosts actually hold) or the
   *  aspect's structural shape; the root coerces at the seam. */
  storage?: DoTransactionStorage | DurableObjectStorage;
}

/**
 * Compose the family's ports over a host's DO storage. IV
 * history is the DO adapter here unconditionally — see the
 * module header: the env-aware build below is where the D1
 * cutover applies.
 */
export function createOptionsDiscoveryPorts(
  inputs: OptionsDiscoveryPortInputs,
): OptionsDiscoveryPorts {
  const { sql } = inputs;
  const storage = inputs.storage as DoTransactionStorage | undefined;
  return {
    scanRuns: new SqlScanRunStore(sql, {}, storage),
    discoveryRuns: new SqlDiscoveryRunStore(sql, {}, storage),
    discoverySetupRuns: new SqlDiscoverySetupStore(sql, {}, storage),
    discoveryAlerts: new SqlDiscoveryAlertStore(sql),
    ivHistory: new SqlIvHistoryStore(sql),
    strategyProfiles: new SqlStrategyProfileStore(sql, {}, storage),
    feedSnapshots: new SqlFeedSnapshotStore(sql, undefined, storage),
  };
}

/** Env selection for the D1 IV adapter after the R-2 cutover:
 *  D1 is the default whenever AGENT_DB is bound, so this
 *  predicate now answers "not explicitly opted out" — only
 *  the exact string "false" forces the DO adapter (the
 *  rollback lever). The name is kept from step 2: it still
 *  reports whether D1 selection is in effect, and its single
 *  caller and the conformance pins read it the same way. */
export function ivHistoryD1Enabled(env: { IV_HISTORY_D1_ENABLED?: string }): boolean {
  return env.IV_HISTORY_D1_ENABLED !== "false";
}

/**
 * Schema-ensure memoization for the D1 IV adapter, keyed by
 * the AGENT_DB binding object: the first env-aware build for
 * a binding runs the idempotent migration pass; later builds
 * over the same binding reuse the settled promise, so hosts
 * may compose per request (the production IV sites do)
 * without re-running DDL per request. A FAILED ensure is not
 * memoized — the entry is evicted when the promise rejects,
 * so the next build retries instead of inheriting a
 * transient failure for the isolate's lifetime.
 */
const ivHistorySchemaEnsures = new WeakMap<object, Promise<number[]>>();

function ensureIvHistorySchemaMemoized(
  binding: object,
  db: IvHistoryDb,
): Promise<number[]> {
  const existing = ivHistorySchemaEnsures.get(binding);
  if (existing) return existing;
  const pending = ensureIvHistorySchema(db);
  ivHistorySchemaEnsures.set(binding, pending);
  pending.catch(() => {
    if (ivHistorySchemaEnsures.get(binding) === pending) {
      ivHistorySchemaEnsures.delete(binding);
    }
  });
  return pending;
}

/**
 * The env-aware build: identical to createOptionsDiscoveryPorts
 * except IV history resolves through the D1 adapter when
 * AGENT_DB is bound and the flag is not explicitly "false"
 * (schema-ensured here, memoized per AGENT_DB binding — see
 * ensureIvHistorySchemaMemoized). With the flag "false" (the
 * rollback lever) or the binding absent, IV history is the
 * DO adapter.
 */
export async function buildOptionsDiscoveryPorts(
  env: { AGENT_DB?: unknown; IV_HISTORY_D1_ENABLED?: string },
  inputs: OptionsDiscoveryPortInputs,
): Promise<OptionsDiscoveryPorts> {
  const ports = createOptionsDiscoveryPorts(inputs);
  if (ivHistoryD1Enabled(env) && env.AGENT_DB) {
    const db = createD1IvHistoryDb(env.AGENT_DB as D1Database);
    await ensureIvHistorySchemaMemoized(env.AGENT_DB, db);
    ports.ivHistory = new D1IvHistoryStore(db);
  }
  return ports;
}
