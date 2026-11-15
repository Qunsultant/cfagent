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
import { DO_DML_CATALOGUE } from "./schemaComponent/doDmlCatalogue";
import { executeDoDml } from "./schemaComponent/doDmlExecutor";
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

const CREATE_TABLE_SQL = doTableSql("mas_discovery_setup_runs");
const CREATE_INDEX_SQL = doIndexSql("idx_mas_discovery_setup_runs_created_at");

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
    return executeDoDml<number>(DO_DML_CATALOGUE, this.sql, "dml.do.mas_discovery_setup_runs.count", {});
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
      executeDoDml(DO_DML_CATALOGUE, this.sql, "dml.do.mas_discovery_setup_runs.insert", {
        record: {
          id: run.id,
          created_at: run.createdAt,
          scope_key: run.scopeKey,
          user_login: run.userLogin ?? null,
          run_json: JSON.stringify(run),
        },
      });
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
    const rows = executeDoDml<Array<{ run_json: string }>>(
      DO_DML_CATALOGUE,
      this.sql,
      options.scopeKey !== undefined
        ? "dml.do.mas_discovery_setup_runs.list_scoped"
        : "dml.do.mas_discovery_setup_runs.list",
      options.scopeKey !== undefined
        ? { userLogin: options.userLogin ?? null, scopeKey: options.scopeKey, limit, offset }
        : { userLogin: options.userLogin ?? null, limit, offset },
    );
    return rows.map((r) => JSON.parse(r.run_json) as StoredDiscoverySetupRun);
  }

  async get(id: string, options: { userLogin?: string } = {}): Promise<StoredDiscoverySetupRun | null> {
    this.ensure();
    const row = executeDoDml<{ run_json: string } | null>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_discovery_setup_runs.get",
      { id },
    );
    if (!row) return null;
    const run = JSON.parse(row.run_json) as StoredDiscoverySetupRun;
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
    executeDoDml(DO_DML_CATALOGUE, this.sql, "dml.do.mas_discovery_setup_runs.prune_age", {
      where: { created_at: { $lt: retentionCutoff(now, this.retentionDays) } },
    });
    executeDoDml(DO_DML_CATALOGUE, this.sql, "dml.do.mas_discovery_setup_runs.prune_cap", {
      maxRows: this.maxRows,
    });
    return before - this.count();
  }

  async prune(now: Date): Promise<number> {
    return this.pruneSync(now);
  }
}
