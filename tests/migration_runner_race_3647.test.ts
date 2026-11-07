// @vitest-environment node
/**
 * Issue #3647 — the migration runner's `_migrations` marker insert
 * must survive concurrent schema ensures.
 *
 * The double below is backed by a real in-memory SQLite database, so
 * the `_migrations.version` PRIMARY KEY constraint is enforced by
 * SQLite itself. Its read barrier computes both callers' initial
 * "is this version recorded?" results before releasing either
 * caller, reproducing the production interleaving: both observes
 * "not applied", both run the idempotent DDL, and both reach the
 * marker insert.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
  applyMigrations,
  MIGRATION_0054_APPROVED_FREE_QUOTA,
  type MigrationDb,
} from "../src/data/migrationRunner";

const dialect = new SQLiteSyncDialect();
const MIGRATION = MIGRATION_0054_APPROVED_FREE_QUOTA;
const FIRST_NOW_MS = 1_793_923_200_000;
const SECOND_NOW_MS = FIRST_NOW_MS + 1_000;

interface MigrationMarkerRow {
  version: number;
  name: string;
  applied_at_ms: number;
}

class SqliteMigrationDb implements MigrationDb {
  readonly sqlite = new DatabaseSync(":memory:");

  private racedMigrationReads = 0;
  private releaseRacedReads!: () => void;
  private readonly racedReadsReleased = new Promise<void>((resolve) => {
    this.releaseRacedReads = resolve;
  });

  constructor(private readonly initialReadsToRace = 0) {}

  async all<T>(query: SQL): Promise<T[]> {
    const built = dialect.sqlToQuery(query);
    const rows = this.sqlite
      .prepare(built.sql)
      .all(...(built.params as any[])) as T[];

    // Hold each of the first N `_migrations` reads after its result
    // has been computed. The first caller therefore cannot advance
    // to its DDL or marker insert until the second caller has also
    // observed the same unrecorded state.
    if (
      this.initialReadsToRace > 0 &&
      /FROM\s+_migrations\b/i.test(built.sql) &&
      this.racedMigrationReads < this.initialReadsToRace
    ) {
      this.racedMigrationReads += 1;
      if (this.racedMigrationReads === this.initialReadsToRace) {
        this.releaseRacedReads();
      }
      await this.racedReadsReleased;
    }

    return rows;
  }

  async run(query: SQL): Promise<unknown> {
    const built = dialect.sqlToQuery(query);
    return this.sqlite.prepare(built.sql).run(...(built.params as any[]));
  }

  seedMarker(row: MigrationMarkerRow): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      )
    `);
    this.sqlite
      .prepare(
        "INSERT INTO _migrations (version, name, applied_at_ms) VALUES (?, ?, ?)",
      )
      .run(row.version, row.name, row.applied_at_ms);
  }

  markerRows(): MigrationMarkerRow[] {
    return this.sqlite
      .prepare(
        "SELECT version, name, applied_at_ms FROM _migrations ORDER BY version",
      )
      .all() as unknown as MigrationMarkerRow[];
  }
}

describe("migration runner concurrent ensures (#3647)", () => {
  it("races two ensures over one unapplied migration: both resolve and exactly one reports it applied", async () => {
    const db = new SqliteMigrationDb(2);

    const results = await Promise.allSettled([
      applyMigrations(db, [MIGRATION], FIRST_NOW_MS),
      applyMigrations(db, [MIGRATION], SECOND_NOW_MS),
    ]);

    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected.map((result) => String(result.reason))).toEqual([]);
    const applied = results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    expect(applied).toEqual([MIGRATION.version]);

    const rows = db.markerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      version: MIGRATION.version,
      name: MIGRATION.name,
    });
    expect([FIRST_NOW_MS, SECOND_NOW_MS]).toContain(rows[0].applied_at_ms);
  });

  it("does not bless a marker recorded under a different migration name", async () => {
    const db = new SqliteMigrationDb();
    db.seedMarker({
      version: MIGRATION.version,
      name: "9999_not_the_approved_free_quota_migration",
      applied_at_ms: FIRST_NOW_MS,
    });

    await expect(
      applyMigrations(db, [MIGRATION], SECOND_NOW_MS),
    ).rejects.toThrow(
      new RegExp(
        `Migration ${MIGRATION.version}.*_migrations.*different name`,
      ),
    );
    expect(db.markerRows()).toEqual([
      {
        version: MIGRATION.version,
        name: "9999_not_the_approved_free_quota_migration",
        applied_at_ms: FIRST_NOW_MS,
      },
    ]);
  });
});
