/**
 * #4751 (#4282 P6c follow-on) — browse SELECT on the shared where-language.
 *
 * The where language gains `$or` (an array of where objects,
 * OR-joined) and `$like` (case-insensitive LIKE), on BOTH legs:
 * the DO Repository (src/data/ormRepositoryCore.ts) and the
 * in-memory twin (src/data/inMemoryOrmAdapters.ts). Every
 * scenario below runs against both legs with identical
 * expectations — the same conformance shape as the #4385
 * predicate tests (tests/orm_repository_extensions_4385.test.ts).
 *
 * The browse section pins byte-identical behaviour: the expected
 * rows below were captured from the pre-#4751 inline SELECT on
 * base a31ce54d (tests/__browse_before_4751.test.ts, since
 * deleted) — same rows, same order, same paging, including
 * numeric is_* values (raw: true keeps them numbers; the record
 * mapping would coerce them to booleans).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Repository } from "../src/data/ormRepositoryCore";
import { InMemoryRepository } from "../src/data/inMemoryOrmAdapters";
import type { RepositoryPort, SqlStorage } from "../src/data/repositoryPorts";
import { DatabaseORM } from "../src/orm";

/** Real-SQLite SqlStorage (the conformance files' shape). */
class SqliteTestStorage implements SqlStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

interface WidgetRow {
  id: string;
  name: string;
  note: string;
  score: number;
  created_at: string;
}

const CREATE_WIDGETS =
  "CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT, note TEXT, score INTEGER, created_at TEXT)";

function widget(id: string, name: string, note: string, score: number, createdAt: string): WidgetRow {
  return { id, name, note, score, created_at: createdAt };
}

function makeDoRepo(storage: SqlStorage): Repository<WidgetRow> {
  storage.exec(CREATE_WIDGETS);
  return new Repository<WidgetRow>(storage, "widgets", "id", {});
}

function makeTwinRepo(): InMemoryRepository<WidgetRow> {
  return new InMemoryRepository<WidgetRow>("widgets", "id");
}

type Leg = [string, () => RepositoryPort<WidgetRow>];

function legs(): Leg[] {
  return [
    ["DO Repository", () => makeDoRepo(new SqliteTestStorage())],
    ["InMemoryRepository", () => makeTwinRepo()],
  ];
}

function seed(repo: RepositoryPort<WidgetRow>): void {
  repo.create(widget("a", "Alpha Cloud", "first note", 10, "2026-01-01T00:00:00.000Z"));
  repo.create(widget("b", "beta CLOUD", "second note", 20, "2026-02-01T00:00:00.000Z"));
  repo.create(widget("c", "Gamma", "cloudy day", 30, "2026-03-01T00:00:00.000Z"));
}

describe("where-language $or / $like (#4751)", () => {
  for (const [label, makeRepo] of legs()) {
    describe(label, () => {
      it("$like matches case-insensitively", () => {
        const repo = makeRepo();
        seed(repo);
        expect(repo.findMany({ where: { name: { $like: "%cloud%" } } }).map((r) => r.id)).toEqual([
          "a",
          "b",
        ]);
        expect(repo.findMany({ where: { note: { $like: "%cloud%" } } }).map((r) => r.id)).toEqual([
          "c",
        ]);
      });

      it("$like lowercases the pattern too (an uppercase pattern still matches)", () => {
        const repo = makeRepo();
        seed(repo);
        expect(repo.findMany({ where: { name: { $like: "%CLOUD%" } } }).map((r) => r.id)).toEqual([
          "a",
          "b",
        ]);
      });

      it("$like honours % and _ wildcards", () => {
        const repo = makeRepo();
        seed(repo);
        expect(repo.findMany({ where: { name: { $like: "alp_a%" } } }).map((r) => r.id)).toEqual([
          "a",
        ]);
        expect(repo.findMany({ where: { name: { $like: "%a%cloud%" } } }).map((r) => r.id)).toEqual([
          "a",
          "b",
        ]);
        expect(repo.findMany({ where: { name: { $like: "%zzz%" } } })).toEqual([]);
      });

      it("$or OR-joins groups across columns", () => {
        const repo = makeRepo();
        seed(repo);
        expect(
          repo
            .findMany({
              where: {
                $or: [{ name: { $like: "%cloud%" } }, { note: { $like: "%cloud%" } }],
              },
            })
            .map((r) => r.id),
        ).toEqual(["a", "b", "c"]);
      });

      it("$or ANDs with the other top-level conditions", () => {
        const repo = makeRepo();
        seed(repo);
        expect(
          repo
            .findMany({
              where: {
                score: { $gte: 20 },
                $or: [{ name: { $like: "%cloud%" } }, { note: { $like: "%cloud%" } }],
              },
            })
            .map((r) => r.id),
        ).toEqual(["b", "c"]);
      });

      it("$like combines with comparison operators", () => {
        const repo = makeRepo();
        seed(repo);
        expect(
          repo.findMany({ where: { name: { $like: "%a%" }, score: { $gt: 15 } } }).map((r) => r.id),
        ).toEqual(["b", "c"]);
        expect(repo.count({ $or: [{ name: { $like: "%cloud%" } }, { note: { $like: "%cloud%" } }] })).toBe(
          3,
        );
        expect(repo.count({ name: { $like: "%cloud%" } })).toBe(2);
      });

      it("$or nests (a branch may itself hold $or)", () => {
        const repo = makeRepo();
        seed(repo);
        expect(
          repo
            .findMany({
              where: {
                $or: [{ $or: [{ name: { $like: "%alpha%" } }] }, { score: 30 }],
              },
            })
            .map((r) => r.id),
        ).toEqual(["a", "c"]);
      });

      it("an empty $or constrains nothing; an empty branch is skipped", () => {
        const repo = makeRepo();
        seed(repo);
        expect(repo.count({ $or: [] })).toBe(3);
        expect(repo.findMany({ where: { $or: [{}, { score: 10 }] } }).map((r) => r.id)).toEqual([
          "a",
        ]);
      });

      it("a null $like constrains nothing", () => {
        const repo = makeRepo();
        seed(repo);
        expect(repo.count({ name: { $like: null } })).toBe(3);
      });

      it("updateWhere / deleteWhere share the language", () => {
        const repo = makeRepo();
        seed(repo);
        expect(
          repo.updateWhere({ $or: [{ name: { $like: "%cloud%" } }] }, { note: "tagged" }),
        ).toBe(2);
        expect(repo.findMany({ where: { note: "tagged" } }).map((r) => r.id)).toEqual(["a", "b"]);
        expect(repo.deleteWhere({ note: { $like: "%cloud%" } })).toBe(1);
        expect(repo.findMany({}).map((r) => r.id)).toEqual(["a", "b"]);
      });

      it("a malformed $or or a non-string $like throws on both legs", () => {
        const repo = makeRepo();
        seed(repo);
        expect(() => repo.findMany({ where: { $or: { name: "a" } as never } })).toThrow();
        expect(() => repo.findMany({ where: { $or: [null] as never } })).toThrow();
        expect(() => repo.findMany({ where: { name: { $like: 5 as never } } })).toThrow();
      });
    });
  }

  describe("DO Repository raw reads", () => {
    it("raw: true returns storage rows unmapped (numeric is_* stays numeric)", () => {
      const storage = new SqliteTestStorage();
      storage.exec("CREATE TABLE raw_widgets (id TEXT PRIMARY KEY, name TEXT, is_active INTEGER)");
      const repo = new Repository<Record<string, any>>(storage, "raw_widgets", "id", {});
      repo.create({ id: "x", name: "X", is_active: 1 });
      repo.create({ id: "y", name: "Y", is_active: 0 });
      expect(repo.findMany({}).map((r) => r.is_active)).toEqual([true, false]);
      expect(repo.findMany({ raw: true }).map((r) => r.is_active)).toEqual([1, 0]);
    });
  });
});

describe("browse SELECT on the shared where-language (#4751)", () => {
  function makeOrm(): DatabaseORM {
    const storage = new SqliteTestStorage();
    storage.exec(
      "CREATE TABLE browse_with_created (id TEXT PRIMARY KEY, name TEXT, note TEXT, is_active INTEGER, created_at TEXT)",
    );
    storage.exec("CREATE TABLE browse_no_created (id TEXT PRIMARY KEY, name TEXT, note TEXT, is_active INTEGER)");
    const insert = (t: string, id: string, name: string, note: string, active: number, created?: string) => {
      if (created !== undefined) {
        storage.exec(`INSERT INTO ${t} VALUES (?, ?, ?, ?, ?)`, id, name, note, active, created);
      } else {
        storage.exec(`INSERT INTO ${t} VALUES (?, ?, ?, ?)`, id, name, note, active);
      }
    };
    insert("browse_with_created", "r1", "Alpha Cloud", "first note", 1, "2026-01-01T00:00:00.000Z");
    insert("browse_with_created", "r2", "beta CLOUD", "second note", 0, "2026-02-01T00:00:00.000Z");
    insert("browse_with_created", "r3", "Gamma", "cloudy day", 1, "2026-03-01T00:00:00.000Z");
    insert("browse_with_created", "r4", "Delta", "plain", 0, "2026-04-01T00:00:00.000Z");
    insert("browse_no_created", "n1", "Alpha Cloud", "first note", 1);
    insert("browse_no_created", "n2", "beta CLOUD", "second note", 0);
    insert("browse_no_created", "n3", "Gamma", "plain", 1);
    return new DatabaseORM(storage);
  }

  it("a table with created_at reads newest-first, byte-identical to the inline SELECT", () => {
    const orm = makeOrm();
    expect(orm.getTableData("browse_with_created", {})).toEqual({
      tableName: "browse_with_created",
      total: 4,
      rows: [
        { id: "r4", name: "Delta", note: "plain", is_active: 0, created_at: "2026-04-01T00:00:00.000Z" },
        { id: "r3", name: "Gamma", note: "cloudy day", is_active: 1, created_at: "2026-03-01T00:00:00.000Z" },
        { id: "r2", name: "beta CLOUD", note: "second note", is_active: 0, created_at: "2026-02-01T00:00:00.000Z" },
        { id: "r1", name: "Alpha Cloud", note: "first note", is_active: 1, created_at: "2026-01-01T00:00:00.000Z" },
      ],
    });
    expect(orm.getTableData("browse_with_created", { limit: 2, offset: 1 })).toEqual({
      tableName: "browse_with_created",
      total: 4,
      rows: [
        { id: "r3", name: "Gamma", note: "cloudy day", is_active: 1, created_at: "2026-03-01T00:00:00.000Z" },
        { id: "r2", name: "beta CLOUD", note: "second note", is_active: 0, created_at: "2026-02-01T00:00:00.000Z" },
      ],
    });
  });

  it("search is case-insensitive across TEXT columns, newest-first within matches", () => {
    const orm = makeOrm();
    expect(orm.getTableData("browse_with_created", { search: "CLOUD" })).toEqual({
      tableName: "browse_with_created",
      total: 4,
      rows: [
        { id: "r3", name: "Gamma", note: "cloudy day", is_active: 1, created_at: "2026-03-01T00:00:00.000Z" },
        { id: "r2", name: "beta CLOUD", note: "second note", is_active: 0, created_at: "2026-02-01T00:00:00.000Z" },
        { id: "r1", name: "Alpha Cloud", note: "first note", is_active: 1, created_at: "2026-01-01T00:00:00.000Z" },
      ],
    });
    expect(orm.getTableData("browse_with_created", { search: "zzz" })).toEqual({
      tableName: "browse_with_created",
      total: 4,
      rows: [],
    });
  });

  it("a table without created_at keeps insertion order", () => {
    const orm = makeOrm();
    expect(orm.getTableData("browse_no_created", {})).toEqual({
      tableName: "browse_no_created",
      total: 3,
      rows: [
        { id: "n1", name: "Alpha Cloud", note: "first note", is_active: 1 },
        { id: "n2", name: "beta CLOUD", note: "second note", is_active: 0 },
        { id: "n3", name: "Gamma", note: "plain", is_active: 1 },
      ],
    });
    expect(orm.getTableData("browse_no_created", { search: "cloud" })).toEqual({
      tableName: "browse_no_created",
      total: 3,
      rows: [
        { id: "n1", name: "Alpha Cloud", note: "first note", is_active: 1 },
        { id: "n2", name: "beta CLOUD", note: "second note", is_active: 0 },
      ],
    });
    expect(orm.getTableData("browse_no_created", { search: "zzz" })).toEqual({
      tableName: "browse_no_created",
      total: 3,
      rows: [],
    });
    expect(orm.getTableData("browse_no_created", { limit: 2, offset: 1 })).toEqual({
      tableName: "browse_no_created",
      total: 3,
      rows: [
        { id: "n2", name: "beta CLOUD", note: "second note", is_active: 0 },
        { id: "n3", name: "Gamma", note: "plain", is_active: 1 },
      ],
    });
  });
});
