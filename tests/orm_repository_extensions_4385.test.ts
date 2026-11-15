/**
 * #4385 (#4282 P6b) — Repository predicate-extension conformance.
 *
 * The P6b extensions (updateWhere / deleteWhere / createOrIgnore +
 * the $lt/$lte/$gt/$gte operator where) must agree on BOTH legs:
 * the DO Repository (src/data/ormRepositoryCore.ts) and the
 * in-memory twin (src/data/inMemoryOrmAdapters.ts). Every scenario
 * below runs against both legs with identical expectations.
 *
 * RowsWritten has two paths: the store reports it (production
 * SqlStorage) or it does not (the test doubles return [] for
 * writes). The fallback paths — verified count for updateWhere,
 * before-minus-after for deleteWhere, total-count delta for
 * createOrIgnore — are what the conformance suites exercise; the
 * rowsWritten path is covered here by a reporting fake over
 * node:sqlite (changes).
 *
 * The updateWhere fallback returns the VERIFIED count (rows whose
 * re-read carries every set field) and does not throw on divergence:
 * the caller — not this method — decides whether that is an error
 * (the adapter keeps its own read-back verification, whose message
 * the port's contract pins). A swallowed UPDATE therefore reports
 * 0, and the adapter's verification throws with its own message.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Repository } from "../src/data/ormRepositoryCore";
import { InMemoryRepository } from "../src/data/inMemoryOrmAdapters";
import type { RepositoryPort, SqlStorage } from "../src/data/repositoryPorts";

/** Real-SQLite SqlStorage (the conformance file's shape). */
class SqliteTestStorage implements SqlStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

/** A SqlStorage that reports rowsWritten from node:sqlite's changes. */
class ReportingSqlStorage implements SqlStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): Iterable<unknown> & { rowsWritten?: number } {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const rows: unknown[] & { rowsWritten?: number } = [];
    rows.rowsWritten = info.changes;
    return rows;
  }
}

interface WidgetRow {
  id: string;
  name: string;
  score: number;
  created_at: string;
}

const CREATE_WIDGETS =
  "CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT, score INTEGER, created_at TEXT)";

function widget(id: string, score: number, createdAt: string): WidgetRow {
  return { id, name: `w-${id}`, score, created_at: createdAt };
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
  repo.create(widget("a", 10, "2026-01-01T00:00:00.000Z"));
  repo.create(widget("b", 20, "2026-02-01T00:00:00.000Z"));
  repo.create(widget("c", 30, "2026-03-01T00:00:00.000Z"));
}

describe("Repository operator where (#4385)", () => {
  for (const [label, makeRepo] of legs()) {
    describe(label, () => {
      it("plain equality is unchanged (same SQL shape, same results)", () => {
        const repo = makeRepo();
        seed(repo);
        expect(repo.findMany({ where: { score: 20 } }).map((r) => r.id)).toEqual(["b"]);
        expect(repo.count({ score: 20 })).toBe(1);
        expect(repo.count({})).toBe(3);
      });

      it("$lt / $lte / $gt / $gte filter numerically and as text", () => {
        const repo = makeRepo();
        seed(repo);
        expect(repo.findMany({ where: { score: { $lt: 20 } } }).map((r) => r.id)).toEqual(["a"]);
        expect(repo.findMany({ where: { score: { $lte: 20 } } }).map((r) => r.id)).toEqual(["a", "b"]);
        expect(repo.findMany({ where: { score: { $gt: 20 } } }).map((r) => r.id)).toEqual(["c"]);
        expect(repo.findMany({ where: { score: { $gte: 20 } } }).map((r) => r.id)).toEqual(["b", "c"]);
        expect(
          repo.findMany({ where: { created_at: { $lt: "2026-02-15T00:00:00.000Z" } } }).map((r) => r.id),
        ).toEqual(["a", "b"]);
        expect(repo.count({ score: { $gt: 99 } })).toBe(0);
      });

      it("multiple operators on one column combine with AND (a range)", () => {
        const repo = makeRepo();
        seed(repo);
        expect(
          repo.findMany({ where: { score: { $gte: 15, $lt: 30 } } }).map((r) => r.id),
        ).toEqual(["b"]);
        expect(repo.count({ created_at: { $gte: "2026-01-15T00:00:00.000Z", $lt: "2026-03-01T00:00:00.000Z" } })).toBe(1);
      });

      it("null/undefined where values are skipped, as before", () => {
        const repo = makeRepo();
        seed(repo);
        expect(repo.findMany({ where: { score: undefined, name: "w-b" } }).map((r) => r.id)).toEqual(["b"]);
        expect(repo.findMany({ where: { score: null } })).toHaveLength(3);
      });
    });
  }
});

describe("Repository updateWhere / deleteWhere (#4385)", () => {
  for (const [label, makeRepo] of legs()) {
    describe(label, () => {
      it("updateWhere updates every matching row and returns the rows written", () => {
        const repo = makeRepo();
        seed(repo);
        const written = repo.updateWhere({ score: { $lt: 25 } }, { name: "bulk" });
        expect(written).toBe(2);
        expect(repo.findMany({ where: { name: "bulk" } }).map((r) => r.id).sort()).toEqual(["a", "b"]);
        expect(repo.findById("c")?.name).toBe("w-c");
      });

      it("updateWhere with no match writes 0", () => {
        const repo = makeRepo();
        seed(repo);
        expect(repo.updateWhere({ score: { $gt: 99 } }, { name: "none" })).toBe(0);
        expect(repo.count()).toBe(3);
      });

      it("updateWhere with an empty predicate refuses (never updates every row)", () => {
        const repo = makeRepo();
        seed(repo);
        expect(() => repo.updateWhere({}, { name: "all" })).toThrow(/empty predicate/);
        expect(repo.count({ name: "all" })).toBe(0);
      });

      it("updateWhere with no set fields writes 0", () => {
        const repo = makeRepo();
        seed(repo);
        expect(repo.updateWhere({ score: 10 }, {})).toBe(0);
      });

      it("deleteWhere removes every matching row and returns the rows written", () => {
        const repo = makeRepo();
        seed(repo);
        expect(repo.deleteWhere({ created_at: { $lt: "2026-02-15T00:00:00.000Z" } })).toBe(2);
        expect(repo.findMany({}).map((r) => r.id)).toEqual(["c"]);
      });

      it("deleteWhere with no match writes 0", () => {
        const repo = makeRepo();
        seed(repo);
        expect(repo.deleteWhere({ score: { $gt: 99 } })).toBe(0);
        expect(repo.count()).toBe(3);
      });

      it("deleteWhere with an empty predicate refuses (never deletes every row)", () => {
        const repo = makeRepo();
        seed(repo);
        expect(() => repo.deleteWhere({})).toThrow(/empty predicate/);
        expect(repo.count()).toBe(3);
      });

      it("deleteWhere with an equality predicate removes the one row", () => {
        const repo = makeRepo();
        seed(repo);
        expect(repo.deleteWhere({ score: 20 })).toBe(1);
        expect(repo.findById("b")).toBeNull();
      });
    });
  }
});

describe("Repository createOrIgnore (#4385)", () => {
  for (const [label, makeRepo] of legs()) {
    describe(label, () => {
      it("inserts the first write and reports true; a repeat reports false and keeps the first row", () => {
        const repo = makeRepo();
        expect(repo.createOrIgnore(widget("a", 10, "2026-01-01T00:00:00.000Z"))).toBe(true);
        expect(
          repo.createOrIgnore(widget("a", 99, "2026-01-02T00:00:00.000Z")),
        ).toBe(false);
        expect(repo.count()).toBe(1);
        expect(repo.findById("a")?.score).toBe(10);
        expect(repo.createOrIgnore(widget("b", 20, "2026-02-01T00:00:00.000Z"))).toBe(true);
        expect(repo.count()).toBe(2);
      });
    });
  }
});

describe("Repository rowsWritten path (#4385)", () => {
  it("updateWhere / deleteWhere / createOrIgnore return the store's rowsWritten when reported", () => {
    const repo = makeDoRepo(new ReportingSqlStorage());
    seed(repo);
    expect(repo.updateWhere({ score: { $lt: 25 } }, { name: "bulk" })).toBe(2);
    expect(repo.deleteWhere({ score: { $gte: 30 } })).toBe(1);
    expect(repo.createOrIgnore(widget("d", 40, "2026-04-01T00:00:00.000Z"))).toBe(true);
    expect(repo.createOrIgnore(widget("d", 41, "2026-04-02T00:00:00.000Z"))).toBe(false);
  });

  it("updateWhere on a swallowing store reports 0 verified — it does not throw, and the caller decides", () => {
    const backing = new SqliteTestStorage();
    const repo = makeDoRepo(backing);
    seed(repo);
    const swallowing: SqlStorage = {
      exec(query: string, ...params: unknown[]) {
        if (/^\s*UPDATE/i.test(query)) return [];
        return backing.exec(query, ...params);
      },
    };
    const swallowed = new Repository<WidgetRow>(swallowing, "widgets", "id", {});
    expect(swallowed.updateWhere({ score: 10 }, { name: "ghost" })).toBe(0);
    expect(repo.findById("a")?.name).toBe("w-a");
  });
});
