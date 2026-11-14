/**
 * #4282 P4 — test-side harness for the all-planes equality pin and the
 * recreate + tenant-isolation suite.
 *
 * This is TEST code, not a production module: it composes the P0
 * substrate (catalogue, executor, equality harness, recreate planner)
 * into the recreate-runner contract P5 will wire into production.
 * Nothing here executes against a real database — the clean instance
 * is a fresh InMemorySchemaInstance per run (the P0 harness; the repo
 * test harness has no real SQLite).
 *
 * Combined catalogue: D1 + DO + ORM + remainder entries in plane
 * order, 401 entries, resolving to 412 statements (the mas_reports
 * generic ALTER expands to 11 pairs, the confirmations generic ALTER
 * to 2 — the pairs come from the frozen P3 base captures, the same
 * ground truth the P3 suite uses).
 *
 * Combined-run order (proven by the P4 probe; the P3 rule applied
 * across planes): base CREATEs first, then ALTER reconciliation /
 * DROPs, then indexes, then seeds. The order is load-bearing: the
 * P0 planner's catalogue order runs the remainder DROP after the DO
 * CREATE UNIQUE INDEX and silently loses idx_mas_reports_generation
 * (characterized in schema_equality_all_planes.test.ts; P5 must adopt
 * this phased order in the production planner).
 *
 * Report counting: the P0 RecreateReport is code-level, but a
 * parameterized entry expanded to N pairs executes N statements. The
 * runner's report keeps the P0 shape and counts RESOLVED statements
 * (a code appears once per pair it executed), so "zero statements
 * executed" is literal. P5's production runner must adopt the
 * resolved-statement report (or expand parameterized entries into
 * distinct steps at plan time).
 *
 * Uncreatable layers: the caller supplies them (P0 rule — the list
 * stays a deployment fact, not a component constant). The two layers
 * here are the survey's: the Vectorize index (no re-index flow) and
 * the R2 corpus (seed documents, not SQL).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { D1_CATALOGUE_ENTRIES } from "../src/data/schemaComponent/d1Catalogue";
import { DO_CATALOGUE_ENTRIES } from "../src/data/schemaComponent/doCatalogue";
import { ORM_CATALOGUE_ENTRIES } from "../src/data/schemaComponent/ormCatalogue";
import { REMAINDER_CATALOGUE_ENTRIES } from "../src/data/schemaComponent/remainderCatalogue";
import { createCatalogue } from "../src/data/schemaComponent/catalogue";
import type { SchemaCatalogue } from "../src/data/schemaComponent/catalogue";
import type { CatalogueEntry } from "../src/data/schemaComponent/catalogueTypes";
import {
  executeStatement,
  resolveStatementText,
  type SqlExecutor,
} from "../src/data/schemaComponent/executor";
import {
  createSchemaError,
  SchemaErrorCode,
} from "../src/data/schemaComponent/schemaErrors";
import {
  diffSchema,
  InMemorySchemaInstance,
  isEmptyDiff,
  type SchemaModel,
} from "../src/data/schemaComponent/equalityHarness";
import type { UncreatableLayer } from "../src/data/schemaComponent/recreatePlanner";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** sha256 of tests/schema_component_combined_expected_model.json as seeded. */
export const COMBINED_FIXTURE_SHA256 =
  "15bb7e54d4059ed818c284d1d2363dc9a60907943ef0a394ff77750f83f0be11";

/** All four planes' entries in plane order: D1, DO, ORM, remainder. */
export const COMBINED_CATALOGUE_ENTRIES: CatalogueEntry[] = [
  ...D1_CATALOGUE_ENTRIES,
  ...DO_CATALOGUE_ENTRIES,
  ...ORM_CATALOGUE_ENTRIES,
  ...REMAINDER_CATALOGUE_ENTRIES,
];

export function buildCombinedCatalogue(): SchemaCatalogue {
  const catalogue = createCatalogue();
  for (const entry of COMBINED_CATALOGUE_ENTRIES) {
    catalogue.register(entry);
  }
  return catalogue;
}

export function combinedExpectedModel(): SchemaModel {
  return JSON.parse(
    readFileSync(
      path.join(HERE, "schema_component_combined_expected_model.json"),
      "utf8",
    ),
  ) as SchemaModel;
}

export type PlaneName = "d1" | "do" | "orm" | "remainder";

export function perPlaneExpectedModel(plane: PlaneName): SchemaModel {
  return JSON.parse(
    readFileSync(
      path.join(HERE, `schema_component_${plane}_expected_model.json`),
      "utf8",
    ),
  ) as SchemaModel;
}

interface BaseCapture {
  adapter: string;
  queries: string[];
}

function baseCaptures(): BaseCapture[] {
  return (
    JSON.parse(
      readFileSync(
        path.join(HERE, "schema_component_p3_base_sql.json"),
        "utf8",
      ),
    ) as { captures: BaseCapture[] }
  ).captures;
}

/**
 * The (column, type) pairs a generic ALTER reconciles, read from the
 * frozen P3 base captures — the same ground truth the P3 suite uses.
 * (Pair-parsing logic copied from the P3 suite; this helper is its
 * single home for the P4 suites.)
 */
function parsePairs(adapter: string): [string, string][] {
  const capture = baseCaptures().find((c) => c.adapter === adapter)!;
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  for (const q of capture.queries) {
    if (!q.trim().startsWith("ALTER TABLE")) continue;
    const m = q.match(/ADD COLUMN\s+([a-z0-9_]+)\s+(.+)$/i);
    if (!m) continue;
    const key = `${m[1]}|${m[2].trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([m[1], m[2].trim()]);
  }
  return pairs;
}

export interface ResolvedStep {
  code: string;
  params: Record<string, string>;
  /** Position in the resolved run (0-based). */
  order: number;
}

/**
 * Resolve the combined catalogue to its executed statements, in the
 * phased order: CREATEs, then ALTERs/DROPs, then indexes, then seeds.
 * A parameterized entry resolves to one step per parameter set (the
 * two generic ALTERs expand to their reconciled pairs). Fail-closed:
 * an unclassified schema entry or an unknown parameterized form
 * throws instead of being silently skipped.
 */
export function resolveCombinedSteps(): ResolvedStep[] {
  const reportPairs = parsePairs("CanonicalReportEnsure");
  const confirmPairs = parsePairs("ReportConfirmationEnsure");
  const phaseOf = (entry: CatalogueEntry): number => {
    if (entry.kind === "seed") return 3;
    const sql = entry.statement.trim();
    if (/^CREATE TABLE/i.test(sql)) return 0;
    if (/^(ALTER TABLE|DROP TABLE|DROP INDEX)/i.test(sql)) return 1;
    if (/^CREATE (UNIQUE )?INDEX/i.test(sql)) return 2;
    throw new Error(
      `P4 harness: entry ${entry.code} matches no recreate phase: ${sql.slice(0, 80)}`,
    );
  };
  const paramSets = (entry: CatalogueEntry): Record<string, string>[] => {
    if (entry.form !== "parameterized") return [{}];
    if (entry.code === "seed.route.orchestrator_migration.insert_or_replace") {
      // DML seed: model-inert in the harness. Resolved with the
      // representative call-site values the P3 suite pins
      // (routes/orchestratorMigration assembles table/cols/placeholders
      // per migration payload); the values cannot change the model.
      return [
        { table: "mas_reports", cols: "id, title", placeholders: "?, ?" },
      ];
    }
    if (entry.code === "schema.do.mas_report_confirmations.alter_table_add_column") {
      return confirmPairs.map(([column, type]) => ({ column, type }));
    }
    if (entry.code === "schema.do.mas_reports.alter_table_add_column") {
      return reportPairs.map(([column, type]) => ({
        TABLE: "mas_reports",
        column,
        type,
      }));
    }
    if (
      entry.parameters?.length === 1 &&
      entry.parameters[0] === "TABLE"
    ) {
      return [{ TABLE: entry.table }];
    }
    throw new Error(
      `P4 harness: unknown parameterized form for entry ${entry.code} (parameters: ${entry.parameters?.join(",")})`,
    );
  };
  const phased = [...COMBINED_CATALOGUE_ENTRIES].sort(
    (a, b) => phaseOf(a) - phaseOf(b),
  );
  const steps: ResolvedStep[] = [];
  for (const entry of phased) {
    for (const params of paramSets(entry)) {
      steps.push({ code: entry.code, params, order: steps.length });
    }
  }
  return steps;
}

/**
 * The phased driver (P3 per-plane pattern: resolve + instance.exec).
 * Returns the executed codes (one per resolved statement) and the
 * resolved-statement count.
 */
export async function executeCombinedPhased(
  instance: InMemorySchemaInstance,
): Promise<{ executedCodes: string[]; executedStatements: number }> {
  const catalogue = buildCombinedCatalogue();
  const executedCodes: string[] = [];
  for (const step of resolveCombinedSteps()) {
    const entry = catalogue.get(step.code);
    instance.exec(resolveStatementText(entry, step.params));
    executedCodes.push(step.code);
  }
  return { executedCodes, executedStatements: executedCodes.length };
}

/**
 * The P0 planner's order (schema entries in catalogue order, then
 * seeds) — characterization driver only. It loses
 * idx_mas_reports_generation (the remainder DROP runs after the DO
 * CREATE); see the ordering test. Never the production order.
 */
export async function executeCombinedInPlanOrder(
  instance: InMemorySchemaInstance,
): Promise<{ executedCodes: string[]; executedStatements: number }> {
  const catalogue = buildCombinedCatalogue();
  const ordered = [
    ...COMBINED_CATALOGUE_ENTRIES.filter((e) => e.kind === "schema"),
    ...COMBINED_CATALOGUE_ENTRIES.filter((e) => e.kind === "seed"),
  ];
  const reportPairs = parsePairs("CanonicalReportEnsure");
  const confirmPairs = parsePairs("ReportConfirmationEnsure");
  const executedCodes: string[] = [];
  const execOne = (entry: CatalogueEntry, params: Record<string, string>) => {
    instance.exec(resolveStatementText(entry, params));
    executedCodes.push(entry.code);
  };
  for (const entry of ordered) {
    if (entry.code === "seed.route.orchestrator_migration.insert_or_replace") {
      execOne(entry, {
        table: "mas_reports",
        cols: "id, title",
        placeholders: "?, ?",
      });
      continue;
    }
    if (
      entry.code === "schema.do.mas_report_confirmations.alter_table_add_column"
    ) {
      for (const [column, type] of confirmPairs) execOne(entry, { column, type });
      continue;
    }
    if (entry.code === "schema.do.mas_reports.alter_table_add_column") {
      for (const [column, type] of reportPairs) {
        execOne(entry, { TABLE: "mas_reports", column, type });
      }
      continue;
    }
    execOne(entry, entry.form === "parameterized" ? { TABLE: entry.table } : {});
  }
  return { executedCodes, executedStatements: executedCodes.length };
}

/**
 * Recompute the combined union from the four per-plane fixtures.
 * Returns the union, any cross-plane disagreements (the seed fails
 * loudly on any), and the overlap counts.
 */
export function computeCombinedUnion(): {
  union: SchemaModel;
  disagreements: string[];
  overlapTables: number;
  overlapIndexes: number;
} {
  const planes: PlaneName[] = ["d1", "do", "orm", "remainder"];
  const union: SchemaModel = { tables: {}, indexes: {} };
  const disagreements: string[] = [];
  const overlappingTables = new Set<string>();
  const overlappingIndexes = new Set<string>();
  for (const plane of planes) {
    const model = perPlaneExpectedModel(plane);
    for (const [name, table] of Object.entries(model.tables)) {
      const existing = union.tables[name];
      if (!existing) {
        union.tables[name] = JSON.parse(JSON.stringify(table));
        continue;
      }
      // Distinct tables appearing in more than one plane (a table in
      // three planes counts once, not twice).
      overlappingTables.add(name);
      for (const col of table.columns) {
        const prev = existing.columns.find((c) => c.name === col.name);
        if (!prev) {
          existing.columns.push(col);
        } else if (prev.type !== col.type) {
          disagreements.push(
            `table ${name} column ${col.name}: ${plane} says ${col.type}, earlier says ${prev.type}`,
          );
        } else if (prev.pk !== col.pk) {
          disagreements.push(
            `table ${name} column ${col.name}: ${plane} says pk=${col.pk}, earlier says pk=${prev.pk}`,
          );
        }
      }
      for (const [key, constraint] of Object.entries(table.constraints)) {
        const prev = existing.constraints[key];
        if (!prev) {
          existing.constraints[key] = constraint;
        } else if (JSON.stringify(prev) !== JSON.stringify(constraint)) {
          disagreements.push(`table ${name} constraint ${key}: ${plane} disagrees`);
        }
      }
    }
    for (const [name, index] of Object.entries(model.indexes)) {
      const existing = union.indexes[name];
      if (!existing) {
        union.indexes[name] = JSON.parse(JSON.stringify(index));
        continue;
      }
      overlappingIndexes.add(name);
      if (
        JSON.stringify(existing.columns) !== JSON.stringify(index.columns) ||
        existing.unique !== index.unique ||
        existing.table !== index.table
      ) {
        disagreements.push(`index ${name}: ${plane} disagrees`);
      }
    }
  }
  return {
    union,
    disagreements,
    overlapTables: overlappingTables.size,
    overlapIndexes: overlappingIndexes.size,
  };
}

/** Layers the SQL recreate cannot create (survey §4; caller-supplied). */
export const UNCREATABLE_LAYERS: UncreatableLayer[] = [
  {
    layer: "vectorize:vector-memory",
    reason:
      "The recreate rebuilds SQL schema only; the Vectorize index has no re-index flow from a route.",
    remedy:
      "Provision and re-index via deployment (wrangler / Cloudflare dashboard), then re-run the recreate.",
  },
  {
    layer: "r2:screener:knowledge/",
    reason:
      "The corpus lives in R2 as seed documents, not in SQL; the recreate cannot re-upload them.",
    remedy:
      "Owner uploads the three seed documents from the Corpus tab, then re-run the recreate.",
  },
];

/** Thrown when a recreate's tenant scope does not match its executor. */
export class TenantScopeError extends Error {
  constructor(scopeTenant: string, executorTenant: string) {
    super(
      `recreate scope tenant "${scopeTenant}" does not match executor tenant "${executorTenant}": refusing to execute`,
    );
    this.name = "TenantScopeError";
  }
}

/**
 * One tenant's executor: bound to exactly one instance. An optional
 * failOn predicate simulates an executor failure at a chosen
 * statement (the sabotage tests use it for the duplicate-values
 * unique-index failure); without it the executor is faithful.
 */
export class TenantExecutor implements SqlExecutor {
  readonly tenant: string;
  readonly instance: InMemorySchemaInstance;
  private readonly failOn?: (sql: string) => boolean;

  constructor(
    tenant: string,
    instance: InMemorySchemaInstance,
    failOn?: (sql: string) => boolean,
  ) {
    this.tenant = tenant;
    this.instance = instance;
    this.failOn = failOn;
  }

  exec(sql: string): void {
    if (this.failOn?.(sql)) {
      throw new Error(
        `simulated executor failure for tenant ${this.tenant}: ${sql.slice(0, 100)}`,
      );
    }
    this.instance.exec(sql);
  }
}

export interface ResolvedRecreateReport {
  executed: string[];
  failed: { code: string; error: string }[];
  skipped: string[];
  uncreatable: UncreatableLayer[];
  summary: {
    totalSteps: number;
    executed: number;
    failed: number;
    skipped: number;
    uncreatableLayers: number;
  };
}

export interface TenantRecreateOptions {
  catalogue: SchemaCatalogue;
  expected: SchemaModel;
  tenant: string;
  executor: TenantExecutor;
  uncreatable: UncreatableLayer[];
  /**
   * Extra resolved steps appended to the plan (the sabotage tests use
   * this to smuggle an unregistered code into the plan). Every step —
   * planned or extra — is validated against the catalogue before
   * anything executes.
   */
  extraSteps?: ResolvedStep[];
}

/**
 * The recreate-runner contract (test-side; P5 wires it into
 * production). Diff-gated at the run level: introspect first, and an
 * empty diff plans zero steps — the second run is a provable no-op
 * report (zero statements executed, report lists zero changes).
 * Scope and code validation happen BEFORE any execution: a
 * tenant-scope mismatch throws TenantScopeError, an unregistered code
 * throws SCHEMA_UNKNOWN_CODE, both with zero statements executed.
 * An executor failure mid-run stops the run and returns the truthful
 * partial report (executed / failed / skipped as resolved statements);
 * it never throws the report away.
 *
 * Known limits (P5 follow-ups, see the P4 build report): the runner
 * executes the full plan whenever the diff is non-empty — it does not
 * yet select only the steps that close the diff (delta-to-steps
 * mapping); and seed execution order relative to schema steps is not
 * proven here (the harness treats DML as a no-op — the D1 legacy seed
 * reads a table a later schema step drops, which only real SQLite
 * would feel).
 */
export async function runTenantRecreate(
  options: TenantRecreateOptions,
): Promise<ResolvedRecreateReport> {
  const { catalogue, expected, tenant, executor, uncreatable } = options;
  if (executor.tenant !== tenant) {
    throw new TenantScopeError(tenant, executor.tenant);
  }
  const current = executor.instance.introspect();
  if (isEmptyDiff(diffSchema(current, expected))) {
    return {
      executed: [],
      failed: [],
      skipped: [],
      uncreatable,
      summary: {
        totalSteps: 0,
        executed: 0,
        failed: 0,
        skipped: 0,
        uncreatableLayers: uncreatable.length,
      },
    };
  }
  const steps = [...resolveCombinedSteps(), ...(options.extraSteps ?? [])];
  // Validate every code before executing anything: an uncoded
  // statement cannot execute (P0 enforcement point: executeStatement).
  for (const step of steps) {
    if (!catalogue.has(step.code)) {
      throw createSchemaError(
        SchemaErrorCode.UNKNOWN_CODE,
        `code ${step.code} is not registered in the schema catalogue`,
      );
    }
  }
  const executed: string[] = [];
  const failed: { code: string; error: string }[] = [];
  let stoppedAt = steps.length;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      await executeStatement(catalogue, step.code, executor, step.params);
      executed.push(step.code);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ code: step.code, error: message });
      stoppedAt = i;
      break;
    }
  }
  const skipped = steps.slice(stoppedAt + (failed.length > 0 ? 1 : 0)).map((s) => s.code);
  return {
    executed,
    failed,
    skipped,
    uncreatable,
    summary: {
      totalSteps: steps.length,
      executed: executed.length,
      failed: failed.length,
      skipped: skipped.length,
      uncreatableLayers: uncreatable.length,
    },
  };
}
