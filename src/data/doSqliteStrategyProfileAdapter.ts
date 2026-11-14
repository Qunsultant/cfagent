/**
 * Issue #2337 (#1976 step 2) — the DO-SQLite implementation of
 * the strategy-profile port: the legacy
 * SqlStrategyProfileStore (issue #28), moved into the data
 * layer. src/trading/options/strategyProfileStore.ts is now a
 * re-export shim over this module and strategyProfilePorts.ts.
 *
 * R-3 (ruling on #2337): the per-user name-uniqueness check and
 * the write it guards run INSIDE the transaction aspect when
 * the host supplies the transaction-capable storage object —
 * the check-then-write is one unit, not merely serialized —
 * and update/delete verify their effect by read-back (ADR
 * D-E.2): a write that lands on no row, or leaves the row in a
 * state other than the one written, throws instead of
 * reporting success. Over a
 * bare sql handle (no transaction capability) the methods keep
 * the legacy sequential shape; the read-back verification
 * still applies. Behaviour changes are confined to
 * silently-wrong cases and are disclosed on #2337.
 */
import type { DoTransactionStorage } from "../aspects/transactionAspect";
import { getTransactionRunner } from "./transactionRunnerProvider";
import type {
  StrategyProfile,
  StrategyProfileSpec,
} from "../trading";
import type { ScanSqlExecutor } from "./scanRunPorts";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";
import type {
  StrategyProfileStore,
  StrategyProfileStoreOptions,
} from "./strategyProfilePorts";

const TABLE = "mas_strategy_profiles";

const CREATE_TABLE_SQL = doTableSql("mas_strategy_profiles");
const CREATE_INDEX_SQL = doIndexSql("idx_mas_strategy_profiles_user_name");
const INSERT_SQL = `INSERT INTO ${TABLE} (id, user_login, name, version, spec_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const SELECT_BY_USER_SQL = `SELECT id, user_login, name, version, spec_json, created_at, updated_at FROM ${TABLE} WHERE user_login = ?`;
const SELECT_BY_ID_SQL = `SELECT id, user_login, name, version, spec_json, created_at, updated_at FROM ${TABLE} WHERE user_login = ? AND id = ?`;
const UPDATE_SQL = `UPDATE ${TABLE} SET name = ?, version = ?, spec_json = ?, updated_at = ? WHERE user_login = ? AND id = ?`;
const DELETE_SQL = `DELETE FROM ${TABLE} WHERE user_login = ? AND id = ?`;

interface ProfileRow {
  id: string;
  user_login: string;
  name: string;
  version: number;
  spec_json: string;
  created_at: string;
  updated_at: string;
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function duplicateNameError(name: string): Error {
  return new Error(`A profile named "${name.trim()}" already exists`);
}

function compareByName(a: StrategyProfile, b: StrategyProfile): number {
  const keyA = a.name.toLowerCase();
  const keyB = b.name.toLowerCase();
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function rowToProfile(row: ProfileRow): StrategyProfile {
  const spec = JSON.parse(row.spec_json) as StrategyProfileSpec;
  return {
    ...spec,
    id: row.id,
    userLogin: row.user_login,
    name: row.name,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqlStrategyProfileStore implements StrategyProfileStore {
  private readonly sql: ScanSqlExecutor;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private ensured = false;

  constructor(
    sql: ScanSqlExecutor,
    options: StrategyProfileStoreOptions = {},
    /** The transaction-capable storage object (ctx.storage) and the process registered the transaction runner (src/server.ts; see transactionRunnerProvider.ts),
     *  when the host supplies it — the uniqueness check-then-
     *  write runs inside the transaction aspect (R-3). */
    private readonly storage?: DoTransactionStorage,
  ) {
    this.sql = sql;
    this.idFactory = options.idFactory ?? (() => `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
    this.now = options.now ?? (() => new Date());
  }

  /** Run a check-then-write unit inside the transaction aspect
   *  when the host supplied the transaction-capable storage;
   *  sequentially otherwise (legacy shape). */
  private async unit<T>(operationName: string, fn: () => T): Promise<T> {
    const runner = this.storage ? getTransactionRunner() : null;
    if (this.storage && runner) {
      return runner.run(
        this.storage,
        { operationName, domain: "options-discovery" },
        fn,
      );
    }
    return fn();
  }

  /** ADR D-E.2: after a write, the row must read back in exactly
   *  the state written — anything else is a silently-wrong write
   *  and throws instead of reporting success. */
  private verifyWrittenRow(
    userLogin: string,
    id: string,
    expected: { name: string; version: number; specJson: string; updatedAt: string },
  ): void {
    const row = this.getRow(userLogin, id);
    if (
      !row ||
      row.name !== expected.name ||
      row.version !== expected.version ||
      row.spec_json !== expected.specJson ||
      row.updated_at !== expected.updatedAt
    ) {
      throw new Error(
        `strategy profile write verification failed for ${id}: the stored row does not match the written state (ADR D-E.2)`,
      );
    }
  }

  private ensure(): void {
    if (this.ensured) return;
    this.sql.exec(CREATE_TABLE_SQL);
    this.sql.exec(CREATE_INDEX_SQL);
    this.ensured = true;
  }

  private listRows(userLogin: string): ProfileRow[] {
    this.ensure();
    return Array.from(this.sql.exec(SELECT_BY_USER_SQL, userLogin) as Iterable<ProfileRow>);
  }

  private getRow(userLogin: string, id: string): ProfileRow | null {
    this.ensure();
    const rows = Array.from(this.sql.exec(SELECT_BY_ID_SQL, userLogin, id) as Iterable<ProfileRow>);
    return rows[0] ?? null;
  }

  async create(userLogin: string, name: string, spec: StrategyProfileSpec): Promise<StrategyProfile> {
    const trimmed = name.trim();
    const key = nameKey(trimmed);
    // R-3: the uniqueness check and the INSERT are one unit.
    return this.unit("strategyProfiles.create", () => {
      if (this.listRows(userLogin).some((row) => nameKey(row.name) === key)) {
        throw duplicateNameError(trimmed);
      }
      const id = this.idFactory();
      const stamp = this.now().toISOString();
      this.sql.exec(INSERT_SQL, id, userLogin, trimmed, 1, JSON.stringify(spec), stamp, stamp);
      return { ...spec, id, userLogin, name: trimmed, version: 1, createdAt: stamp, updatedAt: stamp };
    });
  }

  async list(userLogin: string): Promise<StrategyProfile[]> {
    return this.listRows(userLogin).map(rowToProfile).sort(compareByName);
  }

  async get(userLogin: string, id: string): Promise<StrategyProfile | null> {
    const row = this.getRow(userLogin, id);
    return row ? rowToProfile(row) : null;
  }

  async getByName(userLogin: string, name: string): Promise<StrategyProfile | null> {
    const key = nameKey(name);
    const profiles = await this.list(userLogin);
    return profiles.find((profile) => nameKey(profile.name) === key) ?? null;
  }

  async update(userLogin: string, id: string, spec: StrategyProfileSpec, name?: string): Promise<StrategyProfile | null> {
    const probe = this.getRow(userLogin, id);
    if (!probe) return null;
    // R-3: existence + uniqueness check and the UPDATE are one
    // unit; the written row is verified by read-back (D-E.2).
    return this.unit("strategyProfiles.update", () => {
      const existing = this.getRow(userLogin, id);
      if (!existing) return null;
      const nextName = name !== undefined ? name.trim() : existing.name;
      const key = nameKey(nextName);
      const clash = this.listRows(userLogin).some((row) => row.id !== id && nameKey(row.name) === key);
      if (clash) throw duplicateNameError(nextName);
      const stamp = this.now().toISOString();
      const version = existing.version + 1;
      const specJson = JSON.stringify(spec);
      this.sql.exec(UPDATE_SQL, nextName, version, specJson, stamp, userLogin, id);
      this.verifyWrittenRow(userLogin, id, { name: nextName, version, specJson, updatedAt: stamp });
      return { ...spec, id, userLogin, name: nextName, version, createdAt: existing.created_at, updatedAt: stamp };
    });
  }

  async delete(userLogin: string, id: string): Promise<boolean> {
    if (!this.getRow(userLogin, id)) return false;
    this.sql.exec(DELETE_SQL, userLogin, id);
    // D-E.2: a delete that leaves the row behind is a
    // silently-wrong write — verify by read-back.
    if (this.getRow(userLogin, id)) {
      throw new Error(
        `strategy profile delete verification failed for ${id}: the row is still present after DELETE (ADR D-E.2)`,
      );
    }
    return true;
  }
}
