/**
 * #4386 (P6c, #4282) — Repository createOrReplace conformance.
 *
 * INSERT OR REPLACE as a first-class Repository method, on BOTH
 * legs (DO Repository + InMemoryRepository, ADR 0032 Decision 6's
 * "use the mini-ORM wherever possible"). Every scenario below runs
 * against both legs with identical expectations, except the one
 * disclosed leg difference:
 *
 *  - the DO leg binds an absent optional map field as NULL (the
 *    legacy replace() semantics, #3182: the column map drives the
 *    INSERT column order, absent means NULL);
 *  - the twin has no column map (it stores records as-is), so an
 *    absent field stays absent (undefined on re-read).
 *
 * The ledger adapters' replace() rides this method: the DO leg
 * through the dml.do.mas_transactions.replace catalogue entry,
 * the twin by delegation. The payments conformance suite
 * (payments_step4d2_conformance_2360.test.ts) pins replace()
 * itself on both legs.
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

interface WidgetRow {
  id: string;
  name: string;
  score: number;
  note?: string | null;
  created_at: string;
}

const WIDGET_COLUMN_MAP = {
  id: "id",
  name: "name",
  score: "score",
  note: "note",
  created_at: "created_at",
} as const;

const CREATE_WIDGETS =
  "CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT, score INTEGER, note TEXT, created_at TEXT)";

function widget(id: string, score: number, note: string | null = "n"): WidgetRow {
  return { id, name: `w-${id}`, score, note, created_at: "2026-01-01T00:00:00.000Z" };
}

function makeDoRepo(storage: SqlStorage): Repository<WidgetRow> {
  storage.exec(CREATE_WIDGETS);
  return new Repository<WidgetRow>(storage, "widgets", "id", WIDGET_COLUMN_MAP);
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

describe("Repository createOrReplace (#4386)", () => {
  for (const [label, makeRepo] of legs()) {
    describe(label, () => {
      it("inserts a new row and returns the record", () => {
        const repo = makeRepo();
        const record = widget("a", 10);
        expect(repo.createOrReplace(record)).toEqual(record);
        expect(repo.findById("a")).toEqual(record);
        expect(repo.count()).toBe(1);
      });

      it("replaces an existing row wholesale — old fields gone, count unchanged", () => {
        const repo = makeRepo();
        repo.create(widget("a", 10, "old note"));
        const replacement = widget("a", 99, "new note");
        expect(repo.createOrReplace(replacement)).toEqual(replacement);
        expect(repo.findById("a")).toEqual(replacement);
        expect(repo.count()).toBe(1);
      });

      it("does not throw on a primary-key conflict (unlike create)", () => {
        const repo = makeRepo();
        repo.create(widget("a", 10));
        expect(() => repo.createOrReplace(widget("a", 20))).not.toThrow();
        expect(repo.findById("a")!.score).toBe(20);
        expect(() => repo.create(widget("a", 30))).toThrow();
      });
    });
  }

  it("DO leg: an absent optional map field binds NULL (the replace() semantics)", () => {
    const repo = makeDoRepo(new SqliteTestStorage());
    const partial = widget("a", 10);
    delete (partial as Partial<WidgetRow>).note;
    repo.createOrReplace(partial);
    expect(repo.findById("a")!.note).toBeNull();
  });

  it("twin leg: an absent optional field stays absent (no column map to normalize against)", () => {
    const repo = makeTwinRepo();
    const partial = widget("a", 10);
    delete (partial as Partial<WidgetRow>).note;
    repo.createOrReplace(partial);
    expect(repo.findById("a")!.note).toBeUndefined();
  });
});
