/**
 * Issue #2337 (#1976 step 2) — the DO-SQLite implementation of
 * the discovery-run port: the legacy SqlDiscoveryRunStore
 * (issue #126), moved into the data layer.
 * src/trading/options/discoveryRunStore.ts is now a re-export
 * shim over this module and discoveryRunPorts.ts.
 *
 * Mirrors the scan-run adapter statement-for-statement: same
 * lazy table ensure, same per-user visibility rule (issue
 * #103), same retention discipline. Unlike the scan table this
 * one is born with its user_login column (it postdates issue
 * #103), so no migration probe is needed.
 *
 * TRANSACTION SEAM (ADR D-C, step-2 audit §4): save()'s INSERT
 * + retention prune runs through withTransaction (DO leg)
 * when the host supplies the transaction-capable storage
 * object; sequential over a bare sql handle, exactly the
 * legacy behaviour.
 */
import type { DoTransactionStorage } from "../aspects/transactionAspect";
import { getTransactionRunner } from "./transactionRunnerProvider";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";
import {
  DISCOVERY_RUN_MAX_ROWS,
  DISCOVERY_RUN_RETENTION_DAYS,
  discoveryRunVisibleToCaller,
  type DiscoveryRunInput,
  type DiscoveryRunBroker,
  normalizeDiscoveryRunBroker,
  type DiscoveryRunStore,
  type DiscoveryRunStoreOptions,
  type DiscoveryRunSummary,
  type DiscoverySymbolOutcome,
  type DiscoverySqlExecutor,
  type StoredDiscoveryRun,
} from "./discoveryRunPorts";

const TABLE = "mas_discovery_runs";

const CREATE_TABLE_SQL = doTableSql("mas_discovery_runs");
const CREATE_INDEX_SQL = doIndexSql("idx_mas_discovery_runs_created_at");
const INSERT_SQL =
  `INSERT INTO ${TABLE} (id, created_at, status, user_login, summary_json, run_json) VALUES (?, ?, ?, ?, ?, ?)`;
// The visibility predicate lives in the list statement itself (issue
// #103), exactly as in the scan store: pagination walks only rows the
// caller may see, and a NULL scope parameter matches only NULL-login
// rows because `user_login = NULL` is never true in SQLite.
const LIST_SQL =
  `SELECT summary_json FROM ${TABLE} WHERE (user_login IS NULL OR user_login = ?) ` +
  `ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
const GET_SQL = `SELECT summary_json, run_json FROM ${TABLE} WHERE id = ?`;
const COUNT_SQL = `SELECT COUNT(*) AS count FROM ${TABLE}`;
const PRUNE_AGE_SQL = `DELETE FROM ${TABLE} WHERE created_at < ?`;
const PRUNE_CAP_SQL =
  `DELETE FROM ${TABLE} WHERE id NOT IN (SELECT id FROM ${TABLE} ORDER BY created_at DESC, id DESC LIMIT ?)`;

function summarize(input: DiscoveryRunInput, id: string): DiscoveryRunSummary {
  // An outcome counts as an abstention either by status (the
  // profile-derived model, where no request ever ran) or by the
  // abstained flag on a completed outcome (the no-view model, where
  // the chain loaded and the gates rejected everything). Abstentions
  // never count as completions or failures. Neither marker exists on
  // saved-request outcomes, so their counts are unchanged.
  const isAbstention = (o: DiscoverySymbolOutcome) => o.status === "abstained" || o.abstained === true;
  const completedCount = input.outcomes.filter((o) => o.status === "completed" && !isAbstention(o)).length;
  const abstainedCount = input.outcomes.filter(isAbstention).length;
  return {
    id,
    createdAt: input.createdAt,
    // Issue #3388: provenance lives in the summary (no column migration).
    broker: normalizeDiscoveryRunBroker(input.broker),
    // Issue #3655: mode provenance rides the same summary.
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    // Issue #3655 (effective mode): the resolver source rides the summary with the mode.
    ...(input.modeSource !== undefined ? { modeSource: input.modeSource } : {}),
    ...(input.userLogin !== undefined ? { userLogin: input.userLogin } : {}),
    trigger: input.trigger,
    ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
    inputModel: input.inputModel,
    ...(input.profileRef !== undefined ? { profileRef: input.profileRef } : {}),
    status: input.status,
    requestCount:
      input.inputModel === "no-view" ? (input.constraintSets?.length ?? 0) : input.requests.length,
    completedCount,
    failedCount: input.outcomes.length - completedCount - abstainedCount,
    abstainedCount,
    // Every attempted symbol, in order: the outcomes are the attempt
    // record (for saved runs their symbols are the requests' own,
    // normalized identically by the service).
    symbols:
      input.outcomes.length > 0
        ? input.outcomes.map((o) => o.symbol)
        : input.requests.map((r) => r.symbol.toUpperCase().trim()),
  };
}

function retentionCutoff(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

/** Newest-first ordering shared by both stores: createdAt descending,
 *  id descending on ties (matches the SQL ORDER BY exactly). */
function byNewestFirst(a: DiscoveryRunSummary, b: DiscoveryRunSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * DiscoveryRunStore over Durable Object SQLite. The table is ensured
 * lazily on first use, mirroring SqlScanRunStore. Unlike the scan
 * table this one is born with its user_login column (it postdates
 * issue #103), so no migration probe is needed.
 */
export class SqlDiscoveryRunStore implements DiscoveryRunStore {
  private ensured = false;
  private readonly idFactory: () => string;
  private readonly retentionDays: number;
  private readonly maxRows: number;

  constructor(
    private readonly sql: DiscoverySqlExecutor,
    options: DiscoveryRunStoreOptions = {},
    /** The transaction-capable storage object (ctx.storage) and the process registered the transaction runner (src/server.ts; see transactionRunnerProvider.ts),
     *  when the host supplies it — enables the withTransaction
     *  wrap on save (see the module header). */
    private readonly storage?: DoTransactionStorage,
  ) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.retentionDays = options.retentionDays ?? DISCOVERY_RUN_RETENTION_DAYS;
    this.maxRows = options.maxRows ?? DISCOVERY_RUN_MAX_ROWS;
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

  async save(input: DiscoveryRunInput): Promise<StoredDiscoveryRun> {
    this.ensure();
    const id = this.idFactory();
    const summary = summarize(input, id);
    const run: StoredDiscoveryRun = {
      ...summary,
      requests: input.requests,
      ...(input.constraintSets !== undefined ? { constraintSets: input.constraintSets } : {}),
      outcomes: input.outcomes,
    };
    const insert = () => {
      this.sql.exec(
        INSERT_SQL,
        id,
        input.createdAt,
        input.status,
        summary.userLogin ?? null,
        JSON.stringify(summary),
        JSON.stringify({
          requests: input.requests,
          ...(input.constraintSets !== undefined ? { constraintSets: input.constraintSets } : {}),
          outcomes: input.outcomes,
        }),
      );
    };
    // Retention is enforced on the write path, relative to the run's
    // own timestamp (same discipline as the scan store). The INSERT
    // + prune pair is one unit when the host supplied the
    // transaction-capable storage (ADR D-C).
    const runner = this.storage ? getTransactionRunner() : null;
    if (this.storage && runner) {
      await runner.run(
        this.storage,
        { operationName: "discoveryRuns.save", domain: "options-discovery" },
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

  async list(options: { limit?: number; offset?: number; userLogin?: string; broker?: DiscoveryRunBroker } = {}): Promise<DiscoveryRunSummary[]> {
    this.ensure();
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    // Issue #3388: provenance lives inside summary_json, so a broker-scoped
    // read filters after parsing. It reads the bounded window (the table is
    // capped by maxRows) and slices here, which keeps pagination honest instead
    // of returning short pages from a filtered LIMIT — and keeps this adapter
    // at the same number of SQL statements the D-D census pins.
    const brokerScoped = Boolean(options.broker);
    const rows = Array.from(
      this.sql.exec(
        LIST_SQL,
        options.userLogin ?? null,
        brokerScoped ? this.maxRows : limit,
        brokerScoped ? 0 : offset,
      ),
    ) as Array<{ summary_json: string }>;
    const summaries = rows.map((r) => JSON.parse(r.summary_json) as DiscoveryRunSummary);
    if (!options.broker) return summaries;
    return summaries
      .filter((summary) => normalizeDiscoveryRunBroker(summary.broker) === options.broker)
      .slice(offset, offset + limit);
  }

  async get(id: string, options: { userLogin?: string; broker?: DiscoveryRunBroker } = {}): Promise<StoredDiscoveryRun | null> {
    this.ensure();
    const rows = Array.from(this.sql.exec(GET_SQL, id)) as Array<{ summary_json: string; run_json: string }>;
    if (!rows.length) return null;
    const summary = JSON.parse(rows[0].summary_json) as DiscoveryRunSummary;
    // The summary is the scoping authority; an invisible run reads as absent.
    if (!discoveryRunVisibleToCaller(summary, options.userLogin)) return null;
    // Issue #3388: another broker's run reads exactly like a missing one.
    if (options.broker && normalizeDiscoveryRunBroker(summary.broker) !== options.broker) return null;
    const body = JSON.parse(rows[0].run_json) as Pick<
      StoredDiscoveryRun,
      "requests" | "outcomes" | "constraintSets"
    >;
    return {
      ...summary,
      requests: body.requests,
      ...(body.constraintSets !== undefined ? { constraintSets: body.constraintSets } : {}),
      outcomes: body.outcomes,
    };
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
