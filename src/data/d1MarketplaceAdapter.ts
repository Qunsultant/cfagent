/**
 * src/data/d1MarketplaceAdapter.ts — #2345 (#1976 step 3a,
 * ADR 0022 D-A/D-B): the D1 implementation of the marketplace
 * ports — Drizzle over agent_categories / agent_referrals /
 * agent_ads / agent_external_ads (migration 0021).
 *
 * Semantics identical to the DO-SQLite adapters (the ports'
 * contract): create = insert-or-throw; update returns the
 * re-read row or null with the D-E.2 verification; delete
 * returns true only when a row was removed; counters step
 * atomically in SQL. Boolean record fields map to 0/1 is_*
 * columns exactly as the DO core maps them.
 *
 * ensureD1Marketplace applies pending migrations and seeds
 * each table iff empty with the canonical seed data (the
 * same marketplaceSeedData the DO facade seeds from), so a
 * fresh D1 starts with the same fleet reference data every
 * instance used to seed privately.
 *
 * #4282 P6a (#4384): the query assembly (WHERE / ORDER BY /
 * INSERT / UPDATE / DELETE / COUNT / counter steps) lives in
 * the DML catalogue (dml.d1.<table>.* build entries); this
 * adapter keeps row mapping (fromRow), the D-E.2 verification,
 * and the existed/post-delete orchestration. No sql template tag
 * remains in this file.
 *
 * #CDO-mha7
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";

import {
  AD_COLUMN_MAP,
  CATEGORY_COLUMN_MAP,
  EXTERNAL_AD_COLUMN_MAP,
  REFERRAL_COLUMN_MAP,
} from "./doSqliteOrmAdapters";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import type {
  AdRecord,
  CategoryRecord,
  ExternalAdRecord,
  ReferralRecord,
} from "../types";
import {
  marketplaceSeedData,
  type AdPort,
  type AsyncRepositoryPort,
  type ExternalAdPort,
  type MarketplacePorts,
} from "./marketplacePorts";
import type { RepositoryQueryOptions } from "./repositoryPorts";
import { DML_CATALOGUE } from "./schemaComponent/dmlCatalogue";
import { executeDmlSql } from "./schemaComponent/dmlExecutor";

/** Drizzle D1 database object for the marketplace tables. */
export type MarketplaceDb = DrizzleD1Database<Record<string, never>>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1MarketplaceDb(d1: D1Database): MarketplaceDb {
  return createDrizzleD1Db(d1) as unknown as MarketplaceDb;
}

interface D1TableConfig {
  table: string;
  idField: string;
  columnMap: Record<string, string>;
}

class D1MarketplaceRepository<T extends Record<string, any>>
  implements AsyncRepositoryPort<T>
{
  readonly tableName: string;

  constructor(
    protected readonly db: MarketplaceDb,
    protected readonly config: D1TableConfig,
  ) {
    this.tableName = config.table;
  }

  private fromRow(row: Record<string, unknown>): T {
    const obj: Record<string, unknown> = {};
    const reverse: Record<string, string> = {};
    for (const [prop, col] of Object.entries(this.config.columnMap)) {
      reverse[col] = prop;
    }
    for (const [key, val] of Object.entries(row)) {
      const prop = reverse[key] || key;
      if (typeof val === "number" && (key.startsWith("is_") || key === "is_active")) {
        obj[prop] = Boolean(val);
      } else {
        obj[prop] = val;
      }
    }
    return obj as T;
  }

  async findMany(options: RepositoryQueryOptions = {}): Promise<T[]> {
    const rows = (await executeDmlSql(
      DML_CATALOGUE,
      this.db,
      `dml.d1.${this.tableName}.find_many`,
      {
        where: options.where,
        orderBy: options.orderBy,
        limit: options.limit,
        offset: options.offset,
      },
    )) as Record<string, unknown>[];
    return rows.map((r) => this.fromRow(r));
  }

  async findById(id: string): Promise<T | null> {
    const rows = (await executeDmlSql(
      DML_CATALOGUE,
      this.db,
      `dml.d1.${this.tableName}.find_one`,
      { id },
    )) as Record<string, unknown>[];
    return rows.length > 0 ? this.fromRow(rows[0]) : null;
  }

  async findOne(where: Record<string, unknown>): Promise<T | null> {
    const results = await this.findMany({ where, limit: 1 });
    return results.length > 0 ? results[0] : null;
  }

  async create(record: T): Promise<T> {
    await executeDmlSql(
      DML_CATALOGUE,
      this.db,
      `dml.d1.${this.tableName}.create`,
      { record: record as Record<string, unknown> },
    );
    return record;
  }

  async update(id: string, updates: Partial<T>): Promise<T | null> {
    // No updatable fields: the read-back, same as before.
    const updatable = Object.entries(updates).filter(
      ([prop, val]) => prop !== this.config.idField && val !== undefined,
    );
    if (updatable.length === 0) return this.findById(id);
    await executeDmlSql(
      DML_CATALOGUE,
      this.db,
      `dml.d1.${this.tableName}.update`,
      { id, updates: updates as Record<string, unknown> },
    );
    const after = await this.findById(id);
    if (!after) return null;
    // D-E.2 verification, same rule as the DO core (#2345).
    for (const [prop, val] of Object.entries(updates)) {
      if (prop === this.config.idField || val === undefined) continue;
      if ((after as Record<string, unknown>)[prop] !== val) {
        throw new Error(
          `Repository.update verification failed on ${this.tableName}: field ${prop} did not read back as written`,
        );
      }
    }
    return after;
  }

  async upsert(record: T): Promise<T> {
    const id = record[this.config.idField];
    if (id && (await this.findById(id))) {
      await this.update(id, record);
      return record;
    }
    return this.create(record);
  }

  async delete(id: string): Promise<boolean> {
    // D-E.2: report the change count when the store gives one;
    // otherwise verify by existence probe + post-delete re-read
    // (the DO core's fallback rule).
    const existed = (await this.findById(id)) !== null;
    const result = (await executeDmlSql(
      DML_CATALOGUE,
      this.db,
      `dml.d1.${this.tableName}.delete`,
      { id },
    )) as { meta?: { changes?: number } };
    const changes = result?.meta?.changes;
    if (typeof changes === "number") return changes > 0;
    if (!existed) return false;
    return (await this.findById(id)) === null;
  }

  async count(where?: Record<string, unknown>): Promise<number> {
    const rows = (await executeDmlSql(
      DML_CATALOGUE,
      this.db,
      `dml.d1.${this.tableName}.count`,
      { where },
    )) as Array<{ count: number }>;
    return Number(rows[0]?.count || 0);
  }

  async incrementCounter(
    id: string,
    counter: string,
    delta: number,
  ): Promise<number | null> {
    // One catalogued entry per table (increment_counter); the
    // counter name is validated against the table's column map
    // inside the entry's thunk, so an uncatalogued counter is
    // rejected fail-closed instead of interpolated.
    await executeDmlSql(
      DML_CATALOGUE,
      this.db,
      `dml.d1.${this.tableName}.increment_counter`,
      { id, counter, delta },
    );
    const row = await this.findById(id);
    return row ? Number((row as Record<string, unknown>)[counter] ?? 0) : null;
  }
}

class D1ExternalAdRepository
  extends D1MarketplaceRepository<ExternalAdRecord>
  implements ExternalAdPort
{
  async incrementEarnings(id: string, delta: number): Promise<number | null> {
    return this.incrementCounter(id, "earnings", delta);
  }
}

class D1AdRepository
  extends D1MarketplaceRepository<AdRecord>
  implements AdPort
{
  async incrementAllImpressions(delta: number): Promise<void> {
    await executeDmlSql(
      DML_CATALOGUE,
      this.db,
      "dml.d1.agent_ads.increment_all_impressions",
      { delta },
    );
  }
}

/** The four D1 marketplace adapters over one Drizzle handle. */
export function createD1MarketplacePorts(db: MarketplaceDb): MarketplacePorts {
  return {
    categories: new D1MarketplaceRepository<CategoryRecord>(db, {
      table: "agent_categories",
      idField: "id",
      columnMap: CATEGORY_COLUMN_MAP,
    }),
    externalAds: new D1ExternalAdRepository(db, {
      table: "agent_external_ads",
      idField: "id",
      columnMap: EXTERNAL_AD_COLUMN_MAP,
    }),
    ads: new D1AdRepository(db, {
      table: "agent_ads",
      idField: "id",
      columnMap: AD_COLUMN_MAP,
    }),
    referrals: new D1MarketplaceRepository<ReferralRecord>(db, {
      table: "agent_referrals",
      idField: "id",
      columnMap: REFERRAL_COLUMN_MAP,
    }),
  };
}

/**
 * Idempotent schema-ensure + seed: applies pending migrations
 * (0021 creates the tables), then seeds each marketplace
 * table iff it is empty, from the canonical seed data.
 */
export async function ensureD1Marketplace(db: MarketplaceDb): Promise<void> {
  await applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
  const ports = createD1MarketplacePorts(db);
  const seeds = marketplaceSeedData(new Date().toISOString());
  if ((await ports.categories.count()) === 0) {
    for (const cat of seeds.categories) await ports.categories.create(cat);
  }
  if ((await ports.externalAds.count()) === 0) {
    for (const ad of seeds.externalAds) await ports.externalAds.create(ad);
  }
  if ((await ports.ads.count()) === 0) {
    for (const ad of seeds.ads) await ports.ads.create(ad);
  }
}
