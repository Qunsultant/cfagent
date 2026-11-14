/**
 * Issue #2337 (#1976 step 2) — the DO-SQLite implementation of
 * the discovery setup-run port: the legacy
 * SqlDiscoverySetupStore (issue #14), moved into the data
 * layer. src/trading/options/discoverySetupStore.ts is now a
 * re-export shim over this module and discoverySetupPorts.ts.
 *
 * Same table discipline as the scan store: lazy ensure, the
 * #103 user_login probe + migration, visibility in the list
 * statement itself. The count reconciliation (acceptance (e))
 * runs BEFORE the INSERT — a rejected run stores nothing —
 * and the INSERT + retention prune runs through
 * withTransaction (DO leg) when the host supplies the
 * transaction-capable storage object (ADR D-C, step-2 audit
 * §4); sequential over a bare sql handle, exactly the legacy
 * behaviour.
 */
import type { DoTransactionStorage } from "../aspects/transactionAspect";
import { getTransactionRunner } from "./transactionRunnerProvider";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";
import {
  DISCOVERY_MODEL_VERSION,
  DISCOVERY_SETUP_RUN_MAX_ROWS,
  DISCOVERY_SETUP_RUN_RETENTION_DAYS,
  discoverySetupRunVisibleToCaller,
  validateDiscoveryRunCounts,
  type DiscoveryRunCounts,
  type DiscoverySetupRunInput,
  type DiscoverySetupSqlExecutor,
  type DiscoverySetupStore,
  type DiscoverySetupStoreOptions,
  type StoredDiscoverySetupRun,
} from "./discoverySetupPorts";

const TABLE = "mas_discovery_setup_runs";

const CREATE_TABLE_SQL = doTableSql("mas_discovery_setup_runs");
const CREATE_INDEX_SQL = doIndexSql("idx_mas_discovery_setup_runs_created_at");
const INSERT_SQL =
  `INSERT INTO ${TABLE} (id, created_at, scope_key, user_login, run_json) VALUES (?, ?, ?, ?, ?)`;
// The visibility predicate lives in the list statement itself
// (issue #103), exactly as in the sibling stores.
const LIST_SQL =
  `SELECT run_json FROM ${TABLE} WHERE (user_login IS NULL OR user_login = ?) ` +
  `ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
const LIST_SCOPED_SQL =
  `SELECT run_json FROM ${TABLE} WHERE (user_login IS NULL OR user_login = ?) AND scope_key = ? ` +
  `ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
const GET_SQL = `SELECT run_json FROM ${TABLE} WHERE id = ?`;
const COUNT_SQL = `SELECT COUNT(*) AS count FROM ${TABLE}`;
const PRUNE_AGE_SQL = `DELETE FROM ${TABLE} WHERE created_at < ?`;
const PRUNE_CAP_SQL =
  `DELETE FROM ${TABLE} WHERE id NOT IN (SELECT id FROM ${TABLE} ORDER BY created_at DESC, id DESC LIMIT ?)`;

function retentionCutoff(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

function byNewestFirst(a: StoredDiscoverySetupRun, b: StoredDiscoverySetupRun): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function assertReconciled(input: DiscoverySetupRunInput): void {
  const error = validateDiscoveryRunCounts(input.counts, input.items);
  if (error) throw new Error(`discovery run rejected: ${error}`);
}

export class SqlDiscoverySetupStore implements DiscoverySetupStore {
  private ensured = false;
  private readonly idFactory: () => string;
  private readonly retentionDays: number;
  private readonly maxRows: number;

  constructor(
    private readonly sql: DiscoverySetupSqlExecutor,
    options: DiscoverySetupStoreOptions = {},
    /** The transaction-capable storage object (ctx.storage) and the process registered the transaction runner (src/server.ts; see transactionRunnerProvider.ts),
     *  when the host supplies it — enables the withTransaction
     *  wrap on save (see the module header). */
    private readonly storage?: DoTransactionStorage,
  ) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.retentionDays = options.retentionDays ?? DISCOVERY_SETUP_RUN_RETENTION_DAYS;
    this.maxRows = options.maxRows ?? DISCOVERY_SETUP_RUN_MAX_ROWS;
  }

  private ensure(): void {
    if (this.ensured) return;
    this.sql.exec(CREATE_TABLE_SQL);
    this.sql.exec(CREATE_INDEX_SQL);
    this.ensured = true;
  }

  private count(): number {
    const rows = Array.from(this.sql.exec(COUNT_SQL)) as Array<{ count: number }>;
    return Number(rows[0]?.count ?? 0);
  }

  async save(input: DiscoverySetupRunInput): Promise<StoredDiscoverySetupRun> {
    assertReconciled(input);
    this.ensure();
    const run: StoredDiscoverySetupRun = {
      ...input,
      id: this.idFactory(),
      modelVersion: DISCOVERY_MODEL_VERSION,
    };
    const insert = () => {
      this.sql.exec(
        INSERT_SQL,
        run.id,
        run.createdAt,
        run.scopeKey,
        run.userLogin ?? null,
        JSON.stringify(run),
      );
    };
    // Retention is enforced on the write path, relative to the
    // run's own timestamp (same discipline as the sibling stores).
    // The INSERT + prune pair is one unit when the host supplied
    // the transaction-capable storage (ADR D-C).
    const runner = this.storage ? getTransactionRunner() : null;
    if (this.storage && runner) {
      await runner.run(
        this.storage,
        { operationName: "discoverySetupRuns.save", domain: "options-discovery" },
        () => {
          insert();
          this.pruneSync(new Date(input.createdAt));
        },
      );
    } else {
      insert();
      await this.prune(new Date(input.createdAt));
    }
    return run;
  }

  async list(
    options: { limit?: number; offset?: number; scopeKey?: string; userLogin?: string } = {},
  ): Promise<StoredDiscoverySetupRun[]> {
    this.ensure();
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    const rows = (
      options.scopeKey !== undefined
        ? Array.from(this.sql.exec(LIST_SCOPED_SQL, options.userLogin ?? null, options.scopeKey, limit, offset))
        : Array.from(this.sql.exec(LIST_SQL, options.userLogin ?? null, limit, offset))
    ) as Array<{ run_json: string }>;
    return rows.map((r) => JSON.parse(r.run_json) as StoredDiscoverySetupRun);
  }

  async get(id: string, options: { userLogin?: string } = {}): Promise<StoredDiscoverySetupRun | null> {
    this.ensure();
    const rows = Array.from(this.sql.exec(GET_SQL, id)) as Array<{ run_json: string }>;
    if (!rows[0]) return null;
    const run = JSON.parse(rows[0].run_json) as StoredDiscoverySetupRun;
    return discoverySetupRunVisibleToCaller(run, options.userLogin) ? run : null;
  }

  async latestForScope(
    scopeKey: string,
    options: { userLogin?: string } = {},
  ): Promise<StoredDiscoverySetupRun | null> {
    const [latest] = await this.list({ scopeKey, limit: 1, userLogin: options.userLogin });
    return latest ?? null;
  }

  private pruneSync(now: Date): number {
    this.ensure();
    const before = this.count();
    this.sql.exec(PRUNE_AGE_SQL, retentionCutoff(now, this.retentionDays));
    this.sql.exec(PRUNE_CAP_SQL, this.maxRows);
    return before - this.count();
  }

  async prune(now: Date): Promise<number> {
    return this.pruneSync(now);
  }
}
