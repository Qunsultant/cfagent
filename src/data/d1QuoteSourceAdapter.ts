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
 *
 * #4282 P6a (#4384): the read + upsert are catalogue entries
 * (dml.d1.quote_source_setting.read / .upsert), executed
 * through the DML executor. The CREATE stays the DDL
 * catalogue's text, issued via db.run(sql.raw(...)).
 */
import { sql } from "drizzle-orm";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { quoteSourceSetting } from "./drizzleSchema";
import {
  normalizeQuoteSource,
  type QuoteSource,
  type QuoteSourceD1Db,
  type QuoteSourcePort,
} from "./quoteSourcePorts";
import { d1TableSql } from "./schemaComponent/d1Catalogue";
import { DML_CATALOGUE } from "./schemaComponent/dmlCatalogue";
import { executeDml } from "./schemaComponent/dmlExecutor";

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1QuoteSourceDb(d1: D1Database): QuoteSourceD1Db {
  return createDrizzleD1Db(d1, {
    schema: { quoteSourceSetting },
  });
}

const CREATE_SQL = d1TableSql("quote_source_setting");

export class D1QuoteSourceAdapter implements QuoteSourcePort {
  constructor(private readonly db: QuoteSourceD1Db) {}

  async ensureSchema(): Promise<void> {
    await this.db.run(sql.raw(CREATE_SQL));
  }

  async get(): Promise<QuoteSource> {
    try {
      // The result type is asserted here: the entry's thunk
      // returns the select rows, and TDb must be inferred from
      // this.db (an explicit result type argument would pin TDb
      // to its default and break the inference).
      const rows = (await executeDml(
        DML_CATALOGUE,
        this.db,
        "dml.d1.quote_source_setting.read",
      )) as Array<{ source: string }>;
      return normalizeQuoteSource(rows[0]?.source);
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
    await executeDml(
      DML_CATALOGUE,
      this.db,
      "dml.d1.quote_source_setting.upsert",
      { source: normalized, updatedAt: Date.now() },
    );
    return normalized;
  }
}
