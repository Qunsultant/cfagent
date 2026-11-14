/**
 * Issue #2362 (#1976 step 4f) — the D1 adapter for the
 * quote-source setting port.
 *
 * The statements are the legacy module's, verbatim
 * (src/services/quoteSourceSetting.ts before this slice; the
 * module is now a delegate over this adapter). The CREATE is
 * migration 0022's DDL: where the runner has applied 0022 the
 * ensure is a no-op, and where it has not (an environment
 * whose migrations have not run) the declared
 * ensure-on-first-use on the write path keeps the setting
 * writable — characterization pins that the read path does
 * NOT create the table and fails open instead.
 */
import {
  normalizeQuoteSource,
  type QuoteSource,
  type QuoteSourceD1Db,
  type QuoteSourcePort,
} from "./quoteSourcePorts";
import { d1TableSql } from "./schemaComponent/d1Catalogue";

const CREATE_SQL = d1TableSql("quote_source_setting");

const SELECT_SQL = "SELECT source FROM quote_source_setting WHERE id = 1";

const UPSERT_SQL = `INSERT INTO quote_source_setting (id, source, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET source = excluded.source, updated_at = excluded.updated_at`;

export class D1QuoteSourceAdapter implements QuoteSourcePort {
  constructor(private readonly db: QuoteSourceD1Db) {}

  async ensureSchema(): Promise<void> {
    await this.db.prepare(CREATE_SQL).run();
  }

  async get(): Promise<QuoteSource> {
    try {
      const row = await this.db
        .prepare(SELECT_SQL)
        .bind()
        .first<{ source?: unknown }>();
      return normalizeQuoteSource(row?.source);
    } catch {
      // Declared fail-open (see the port contract): missing
      // table, unbound store, or any read failure resolves to
      // the legacy env-driven behaviour, never to an error.
      return "auto";
    }
  }

  async set(source: QuoteSource): Promise<QuoteSource> {
    const normalized = normalizeQuoteSource(source);
    await this.ensureSchema();
    await this.db.prepare(UPSERT_SQL).bind(normalized, Date.now()).run();
    return normalized;
  }
}
