/**
 * #4384 (P6a, #4282) — D1 builder-DML pin.
 *
 * The D1 family's DML lives in exactly one place: the DML catalogue
 * (src/data/schemaComponent/dmlCatalogue.ts + dmlEntries.ts), executed
 * only through the DML executor. This test pins the family surface:
 *
 * 1. Grep pin — zero inline raw DML outside the catalogue for the
 *    D1 family: no `.prepare(` calls, no executable raw-DML string
 *    literals, and no `sql\`` template tags anywhere in src/data/d1*.ts.
 *    (The 9 comment-only raw-DML lines the survey counted are
 *    comments, not code — the scan strips comments first.)
 * 2. Red-team — an uncoded statement cannot execute (unknown code is
 *    rejected fail-closed), a duplicate registration is rejected, and
 *    a tampered entry fails validation.
 * 3. Coverage — every migrated operation has a catalogue entry, every
 *    code parses under the shared <kind>.<plane>.<table>.<action>
 *    format, and the per-table entry counts match the migration.
 *
 * Baseline on ce4e18b1 (2026-11-14, evidence-p6a/scan-dml-baseline.mjs):
 * 55 d1*.ts files; prepare=34, sql`=36, raw-DML strings=40, all in the
 * 15 migrated files. The pin is RED on that base by design.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildDmlCatalogue,
  createDmlCatalogue,
  DML_CATALOGUE,
  validateDmlEntry,
  type DmlCatalogueEntry,
} from "../src/data/schemaComponent/dmlCatalogue";
import { DML_CATALOGUE_ENTRIES } from "../src/data/schemaComponent/dmlEntries";
import {
  dmlFragment,
  executeDml,
  executeDmlSql,
} from "../src/data/schemaComponent/dmlExecutor";
import { isValidStatementCode } from "../src/data/schemaComponent/statementCodes";
import { SchemaErrorCode } from "../src/data/schemaComponent/schemaErrors";

const D1_DIR = "src/data";

function d1Files(): string[] {
  return readdirSync(D1_DIR)
    .filter((f) => f.startsWith("d1") && f.endsWith(".ts"))
    .sort()
    .map((f) => `${D1_DIR}/${f}`);
}

/** Strip block + line comments so comment-only SQL never trips the pin. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'A-Za-z0-9_])\/\/.*$/gm, "$1");
}

const PREPARE_PATTERN = /\.prepare\s*\(/g;
const SQL_TAG_PATTERN = /\bsql\s*`/g;
const RAW_DML_PATTERN = /[`'"]\s*(INSERT|UPDATE|DELETE|REPLACE|SELECT)\b/g;

function count(pattern: RegExp, source: string): number {
  return (source.match(pattern) ?? []).length;
}

describe("D1 family pin: zero inline raw DML outside the catalogue (#4384)", () => {
  /**
   * #4933 — the query-logger wrapper is the ONE exception to the
   * .prepare( ban: d1QueryLogger.ts forwards the binding's prepare()
   * so drizzle's own prepared statements can be timed. It issues no
   * DML itself (no statement text of its own, no params of its own) —
   * the forwarded call is the adapter's query, executed through the
   * catalogue path exactly as before. The exception is exactly one
   * forwarding call; a second .prepare( in this file still fails.
   */
  const PREPARE_ALLOW_LIST = new Map([["src/data/d1QueryLogger.ts", 1]]);
  it("no .prepare( calls in src/data/d1*.ts", () => {
    const hits: string[] = [];
    for (const file of d1Files()) {
      const n = count(PREPARE_PATTERN, stripComments(readFileSync(file, "utf8")));
      const allowed = PREPARE_ALLOW_LIST.get(file) ?? 0;
      if (n !== allowed) hits.push(`${file}: ${n} (allowed ${allowed})`);
    }
    expect(hits, "raw .prepare( survives outside the catalogue").toEqual([]);
  });

  it("no executable raw-DML strings in src/data/d1*.ts", () => {
    const hits: string[] = [];
    for (const file of d1Files()) {
      const n = count(RAW_DML_PATTERN, stripComments(readFileSync(file, "utf8")));
      if (n > 0) hits.push(`${file}: ${n}`);
    }
    expect(hits, "raw DML string survives outside the catalogue").toEqual([]);
  });

  it("no sql` template tags in src/data/d1*.ts", () => {
    const hits: string[] = [];
    for (const file of d1Files()) {
      const n = count(SQL_TAG_PATTERN, stripComments(readFileSync(file, "utf8")));
      if (n > 0) hits.push(`${file}: ${n}`);
    }
    expect(hits, "sql` template tag survives outside the catalogue").toEqual([]);
  });
});

describe("DML catalogue red-team (#4384)", () => {
  it("rejects an unregistered code — an uncoded statement cannot execute", async () => {
    const catalogue = createDmlCatalogue();
    await expect(
      executeDml(catalogue, {} as never, "dml.d1.nope.nope", {}),
    ).rejects.toThrowError(/not registered/);
    await expect(
      executeDmlSql(catalogue, {} as never, "dml.d1.nope.nope", undefined as never),
    ).rejects.toThrowError(/not registered/);
    expect(() => dmlFragment(catalogue, "dml.d1.nope.nope")).toThrowError(
      /not registered/,
    );
  });

  it("rejects a duplicate registration", () => {
    const catalogue = createDmlCatalogue();
    const entry = DML_CATALOGUE_ENTRIES[0];
    catalogue.register(entry);
    let caught: unknown;
    try {
      catalogue.register(entry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe(
      SchemaErrorCode.DUPLICATE_CODE,
    );
  });

  it("rejects a tampered entry at validation (code/table/form disagreement)", () => {
    const entry = DML_CATALOGUE_ENTRIES[0];
    const wrongTable = { ...entry, table: "some_other_table" };
    expect(validateDmlEntry(wrongTable).valid).toBe(false);
    const wrongForm = { ...entry, form: "builder" as const, run: undefined };
    expect(validateDmlEntry(wrongForm).valid).toBe(false);
    const wrongCode = { ...entry, code: "not-a-code" };
    expect(validateDmlEntry(wrongCode).valid).toBe(false);
  });

  it("freezes registered entries so a registered entry cannot be mutated in place", () => {
    const catalogue = createDmlCatalogue();
    const entry: DmlCatalogueEntry = {
      code: "dml.d1.freeze_probe.probe",
      table: "freeze_probe",
      operation: "read",
      form: "fragment",
      fragment: () => undefined as never,
    };
    catalogue.register(entry);
    expect(Object.isFrozen(catalogue.get(entry.code))).toBe(true);
    expect(() => {
      (catalogue.get(entry.code) as { table: string }).table = "mutated";
    }).toThrow();
  });
});

describe("DML catalogue coverage (#4384)", () => {
  it("every entry code parses under the shared format and agrees with its table", () => {
    for (const entry of DML_CATALOGUE_ENTRIES) {
      expect(isValidStatementCode(entry.code), entry.code).toBe(true);
      expect(validateDmlEntry(entry).valid, entry.code).toBe(true);
    }
  });

  it("the built catalogue holds exactly the declared entries, no more", () => {
    const built = buildDmlCatalogue();
    expect(built.size()).toBe(DML_CATALOGUE_ENTRIES.length);
    expect(DML_CATALOGUE.size()).toBe(DML_CATALOGUE_ENTRIES.length);
    expect(new Set(DML_CATALOGUE_ENTRIES.map((e) => e.code)).size).toBe(
      DML_CATALOGUE_ENTRIES.length,
    );
  });

  it("per-table entry counts match the migration", () => {
    const counts: Record<string, number> = {
      mas_feed_datasets: 6,
      mas_index_lists: 4,
      quote_source_setting: 2,
      resource_sql_ops: 2,
      resource_daily_rollups: 3,
      resource_alert_state: 2,
      resource_comparison_reports: 2,
      agent_bundle_purchases: 1,
      agent_user_profiles: 1,
      agent_proposals: 2,
      agent_categories: 7,
      agent_external_ads: 7,
      agent_ads: 8,
      agent_referrals: 7,
      agent_code_redemption_counts: 1,
      agent_referral_codes: 1,
      agent_referral_code_rules: 1,
      agent_code_run_balances: 2,
      agent_approved_free_quota_counts: 1,
      agent_free_run_counts: 1,
      agent_runs_pack_balances: 2,
      agent_async_jobs: 1,
      mas_events: 3,
    };
    for (const [table, expected] of Object.entries(counts)) {
      expect(DML_CATALOGUE.findByTable(table).length, table).toBe(expected);
    }
  });

  it("one key code per migrated family is registered", () => {
    for (const code of [
      "dml.d1.mas_feed_datasets.insert",
      "dml.d1.mas_index_lists.insert",
      "dml.d1.quote_source_setting.upsert",
      "dml.d1.resource_sql_ops.insert",
      "dml.d1.resource_daily_rollups.upsert",
      "dml.d1.agent_bundle_purchases.record_purchase",
      "dml.d1.agent_user_profiles.save_once",
      "dml.d1.agent_proposals.propose",
      "dml.d1.agent_categories.find_many",
      "dml.d1.agent_referrals.find_many",
      "dml.d1.agent_external_ads.increment_counter",
      "dml.d1.agent_ads.increment_all_impressions",
      "dml.d1.agent_referral_codes.increment_redemption_count",
      "dml.d1.agent_free_run_counts.increment_used",
      "dml.d1.agent_async_jobs.stale_guard",
      "dml.d1.mas_events.insert_chained",
    ]) {
      expect(DML_CATALOGUE.has(code), code).toBe(true);
    }
  });
});
