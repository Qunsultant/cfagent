/**
 * #4282 P5 — production recreate runner.
 *
 * The operator surface for the recreate (route + client) runs through
 * this module. It is the production counterpart of the P4 test-side
 * harness (tests/schema_equality_harness.ts): it resolves the combined
 * catalogue to executable steps, selects only the steps that close a
 * non-empty diff against the store's probed schema, executes them per
 * leg, and verifies the run afterwards. The P4 harness stays the
 * independent double — this module must NOT import it. The runner
 * suite (tests/schema_recreate_runner.test.ts) cross-checks the runner
 * against the harness (same steps, same pairs, same expected model)
 * so a drift between the production runner and the pin is caught
 * there, not in CI.
 *
 * Order (P4 finding 1): steps execute in PHASED order — table
 * creations, then reconciliations (column adds, renames, drops), then
 * index creations, then seeds — with two corrections the P0
 * planner's catalogue order gets wrong:
 *  - a second table-creation for a table whose earlier creation was
 *    renamed away (the v58 rebuild) executes AFTER that rename: its
 *    effective phase is the rename's phase, so the rebuild cannot run
 *    against a table that already exists;
 *  - a seed that reads from a table a later step drops is hoisted to
 *    just before that drop (P4 finding 4).
 * Within a phase the catalogue order is preserved (stable sort).
 *
 * Selection (P4 finding 3): the runner probes the store's live schema
 * (sqlite_master, parsed through the P0 harness — no probe verb is
 * needed, so the same probe works on D1 and on a DO instance) and
 * walks the plan in order, maintaining a projected model of the
 * store after the steps selected so far. A step is selected only
 * when its effect is still missing at its position in the run — so
 * a re-run on a healthy store selects zero steps, and a column-add
 * whose column a selected creation already provides is never
 * executed (it would fail on real SQLite). A seed is selected only
 * when its table's creation is selected (the table is being built
 * or rebuilt) or when the last report names it as failed —
 * re-running a seed that already landed would collide on its keys,
 * so a column reconciliation never re-runs a seed.
 *
 * The DROP (P4 finding 2) is conditional on the probe: an index drop
 * runs only when the index exists AND its creation is also selected
 * (present with the wrong shape, or with no creation defining it).
 * The catalogue entry is untouched, so the P3 sha256 pin is untouched.
 *
 * Legs: a step's leg comes from its source catalogue (D1 and ORM
 * entries run on D1; DO entries run on a DO instance), except
 * remainder index entries, which resolve by their table's home. A
 * table that exists on both stores (the eight job tables) has its D1
 * copy and its DO copy recreated by their own legs, never by one
 * combined run against a single store.
 *
 * Execution: the D1 leg runs inside transactionAspect's D1 batch
 * backend — every statement is buffered and one batch applies them
 * atomically. Each statement is still executed through the P0
 * executor, so the structured log carries its catalogue code; the
 * log line records the buffering, and the TX_COMMITTED outcome is
 * the application truth. On failure the batch is discarded and the
 * report lists nothing as executed, the throwing step as failed, the
 * buffered steps as rolled back, and the rest as skipped. The DO leg
 * cannot use the aspect: the DO backend refuses async work, and the
 * executor is async, so the DO leg executes statement by statement
 * with stop-at-first-failure and an honest partial report — DO-leg
 * atomicity is explicitly NOT claimed.
 *
 * Verification: the run is verified per leg against the model that
 * leg's steps build. Missing or changed catalogue objects fail the
 * run; objects outside the catalogue's domain are listed, not
 * failed. P4 finding 4's rename blind spot needs no exception: the
 * harness does not model renames, but the rebuilt table reuses the
 * same name with the same final shape, so the expected model and
 * the real store agree on it (the probe test proves it against
 * real SQLite).
 */
import { D1_CATALOGUE_ENTRIES } from "./d1Catalogue";
import { DO_CATALOGUE_ENTRIES } from "./doCatalogue";
import { ORM_CATALOGUE_ENTRIES } from "./ormCatalogue";
import { REMAINDER_CATALOGUE_ENTRIES } from "./remainderCatalogue";
import { createCatalogue, type SchemaCatalogue } from "./catalogue";
import type { CatalogueEntry, StatementKind } from "./catalogueTypes";
import {
  executeStatement,
  resolveStatementText,
  type SqlExecutor,
} from "./executor";
import {
  diffSchema,
  emptySchemaModel,
  InMemorySchemaInstance,
  parseSchemaStatement,
  type SchemaDiff,
  type SchemaModel,
} from "./equalityHarness";
import type { UncreatableLayer } from "./recreatePlanner";
import {
  d1BatchTransactionBackend,
  withTransaction,
  type D1BatchDatabase,
  type TransactionOutcome,
} from "../../aspects/transactionAspect";

export type RecreateLeg = "d1" | "do";

export interface RecreateStep {
  code: string;
  params: Record<string, string>;
  /** Position in the resolved run (0-based). */
  order: number;
  /**
   * Execution phase: 0 table creation, 1 reconciliation (column adds,
   * renames, drops), 2 index creation, 3 seeds. This is the
   * EFFECTIVE phase — a rebuild creation carries its rename's phase,
   * and a hoisted seed carries its drop's phase.
   */
  phase: number;
  kind: StatementKind;
  table: string;
  leg: RecreateLeg;
  entry: CatalogueEntry;
  /**
   * For a rename step: the source table's shape just before the
   * rename (sorted columns as JSON), computed by executing the plan
   * prefix against a fresh model. The selection compares the live
   * table against it, so a rename runs only while the old-shaped
   * table is still there — never against the rebuilt table that
   * reuses the same name.
   */
  renameFromShape?: string | null;
}

export interface SkippedStep {
  code: string;
  reason: string;
}

export interface RecreatePlan {
  steps: RecreateStep[];
  skipped: SkippedStep[];
}

export interface SelectedSteps {
  schema: RecreateStep[];
  seeds: RecreateStep[];
  skipped: RecreateStep[];
}

export interface SchemaProbe {
  query(
    sql: string,
    ...params: unknown[]
  ): Promise<Array<Record<string, unknown>>>;
}

export interface VerificationResult {
  ok: boolean;
  diff: SchemaDiff;
  extras: {
    tables: string[];
    columns: { table: string; column: string }[];
    indexes: string[];
    constraints: { table: string; constraint: string }[];
  };
  knownDifferences: string[];
  failures: string[];
}

export interface LegReport {
  leg: RecreateLeg;
  /** One code per resolved step selected, in execution order. */
  selected: string[];
  /** One code per resolved step actually applied. */
  executed: string[];
  failed: { code: string; error: string }[];
  /** Selected but never attempted. */
  skipped: string[];
  /** D1 leg only: attempted, buffered, then discarded with the batch. */
  rolledBack: string[];
  outcome: "succeeded" | "failed";
}

export interface LegExecuteOptions {
  operationName?: string;
  emit?: (outcome: TransactionOutcome) => void;
}

/**
 * Layers the recreate cannot rebuild, with the reason and the remedy.
 * The first two entries are the P4 harness's list verbatim (the
 * runner suite pins the production list as a superset of it); the
 * last three are the operator-facing layers the phase file names.
 */
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
  {
    layer: "queues:deploy-time",
    reason:
      "Queues are provisioned at deploy time; a route can purge a queue, not provision one.",
    remedy:
      "Provision the queue via deployment (wrangler / Cloudflare dashboard), then re-run the recreate.",
  },
  {
    layer: "ai-search:index_source",
    reason:
      "AI Search is derived from the R2 source via the store-time hook; there is no rebuild entry point from a route.",
    remedy:
      "Re-index by re-storing the reports that feed the index, then re-run the recreate.",
  },
  {
    layer: "r2:screener:objects",
    reason:
      "R2 objects are re-put from their surviving sources; the bucket itself is deploy-time provisioning.",
    remedy:
      "Re-put the objects from their surviving sources (or restore from backup), then re-run the recreate.",
  },
];

/** The combined catalogue: D1, DO, ORM, remainder entries in plane order. */
export function buildCombinedCatalogue(): SchemaCatalogue {
  const catalogue = createCatalogue();
  for (const entry of [
    ...D1_CATALOGUE_ENTRIES,
    ...DO_CATALOGUE_ENTRIES,
    ...ORM_CATALOGUE_ENTRIES,
    ...REMAINDER_CATALOGUE_ENTRIES,
  ]) {
    catalogue.register(entry);
  }
  return catalogue;
}

/**
 * The (column, type) pairs a generic column-add reconciliation
 * expands to. The pairs exist nowhere in the catalogue as statements
 * — the table's creation lists only its original columns, and the
 * three columns added later live only in the adapter's ensure calls.
 * This table is the production home for that reconciliation set,
 * sourced from the adapter ensure calls (the same ground truth as
 * the P3 base captures); the runner suite pins it against the frozen
 * P3 fixture, so adding a column to the adapter without updating
 * this table fails the pin instead of silently skipping the column.
 */
const GENERIC_ALTER_PAIRS: Record<string, [string, string][]> = {
  "schema.do.mas_reports.alter_table_add_column": [
    ["id", "TEXT"],
    ["run_id", "TEXT"],
    ["title", "TEXT"],
    ["source", "TEXT"],
    ["summary", "TEXT"],
    ["body", "TEXT"],
    ["created_at", "TEXT"],
    ["generation_id", "TEXT"],
    ["user_login", "TEXT"],
    ["body_r2_key", "TEXT"],
    ["fanout_outcome", "TEXT"],
  ],
  "schema.do.mas_report_confirmations.alter_table_add_column": [
    ["report_id", "TEXT"],
    ["created_by", "TEXT"],
  ],
};

function basePhase(entry: CatalogueEntry): number {
  if (entry.kind === "seed") return 3;
  const sql = entry.statement.trim();
  if (/^CREATE TABLE/i.test(sql)) return 0;
  if (/^(ALTER TABLE|DROP TABLE|DROP INDEX)/i.test(sql)) return 1;
  if (/^CREATE (UNIQUE )?INDEX/i.test(sql)) return 2;
  throw new Error(
    `recreate runner: entry ${entry.code} matches no recreate phase`,
  );
}

function isCreateTable(entry: CatalogueEntry): boolean {
  return /^CREATE TABLE/i.test(entry.statement.trim());
}

function isCreateIndex(entry: CatalogueEntry): boolean {
  return /^CREATE (UNIQUE )?INDEX/i.test(entry.statement.trim());
}

function isDrop(entry: CatalogueEntry): boolean {
  return /^(DROP TABLE|DROP INDEX)/i.test(entry.statement.trim());
}

function renameTarget(entry: CatalogueEntry): string | null {
  const match = entry.statement.match(/RENAME\s+TO\s+["`]?([\w]+)/i);
  return match ? match[1] : null;
}

/** The plane of a table's creation entries across the catalogues, for remainder index entries. */
function tableHomePlanes(table: string): Set<string> {
  const planes = new Set<string>();
  for (const entries of [
    D1_CATALOGUE_ENTRIES,
    DO_CATALOGUE_ENTRIES,
    ORM_CATALOGUE_ENTRIES,
    REMAINDER_CATALOGUE_ENTRIES,
  ]) {
    for (const entry of entries) {
      if (entry.table === table && isCreateTable(entry)) {
        planes.add(entry.plane);
      }
    }
  }
  return planes;
}

function remainderLeg(entry: CatalogueEntry): RecreateLeg {
  if (entry.plane === "d1" || entry.plane === "orm") return "d1";
  if (entry.plane === "do") return "do";
  if (entry.plane === "index") {
    // The indexed table's home: the remainder's own creation first,
    // then the DO copy, then the D1 copy. Both remainder index tables
    // (mas_learnings, mas_reports) resolve to the DO leg this way.
    const planes = tableHomePlanes(entry.table);
    if (planes.has("do")) return "do";
    if (planes.has("d1") || planes.has("orm")) return "d1";
    return "do";
  }
  // "route": the only route entry is the seed-form, which is skipped
  // before any leg is consulted; the value here is never used.
  return "d1";
}

function legOfEntry(
  entry: CatalogueEntry,
  source: "d1" | "do" | "orm" | "remainder",
): RecreateLeg {
  if (source === "d1" || source === "orm") return "d1";
  if (source === "do") return "do";
  return remainderLeg(entry);
}

export function legOfStep(step: RecreateStep): RecreateLeg {
  return step.leg;
}

/** Parameter sets for one entry, or "skip" for the call-site seed form. */
function paramSets(
  entry: CatalogueEntry,
): Record<string, string>[] | "skip" {
  if (entry.form !== "parameterized") return [{}];
  if (entry.kind === "seed") {
    // A parameterized seed's values come from its migration call
    // site; the runner never invents them.
    return "skip";
  }
  if (/ADD COLUMN/i.test(entry.statement)) {
    const pairs = GENERIC_ALTER_PAIRS[entry.code];
    if (!pairs) {
      throw new Error(
        `recreate runner: no pinned pairs for generic column-add ${entry.code}`,
      );
    }
    return pairs.map(([column, type]) => {
      const params: Record<string, string> = { column, type };
      if (entry.parameters?.includes("TABLE")) {
        params.TABLE = entry.table;
      }
      return params;
    });
  }
  if (entry.parameters?.length === 1 && entry.parameters[0] === "TABLE") {
    return [{ TABLE: entry.table }];
  }
  throw new Error(
    `recreate runner: unknown parameterized form for entry ${entry.code}`,
  );
}

const SEED_FORM_SKIP_REASON =
  "seed parameters come from the migration call site; the recreate cannot invent them, so this entry is reported, never executed";

/**
 * Resolve the combined catalogue to its executable steps, in phased
 * order with the rebuild-creation and seed-hoist corrections. The
 * seed-form entry is reported in `skipped`, never executed.
 */
export function resolveRecreatePlan(): RecreatePlan {
  const tagged: { entry: CatalogueEntry; leg: RecreateLeg }[] = [];
  for (const entry of D1_CATALOGUE_ENTRIES) {
    tagged.push({ entry, leg: legOfEntry(entry, "d1") });
  }
  for (const entry of DO_CATALOGUE_ENTRIES) {
    tagged.push({ entry, leg: legOfEntry(entry, "do") });
  }
  for (const entry of ORM_CATALOGUE_ENTRIES) {
    tagged.push({ entry, leg: legOfEntry(entry, "orm") });
  }
  for (const entry of REMAINDER_CATALOGUE_ENTRIES) {
    tagged.push({ entry, leg: legOfEntry(entry, "remainder") });
  }

  // Effective phases, computed in catalogue order: a table-creation
  // that follows a rename-away or drop of the same table inherits
  // that step's phase, so it cannot run before the table is cleared.
  const clearedPhase = new Map<string, number>();
  const resolved: {
    entry: CatalogueEntry;
    leg: RecreateLeg;
    phase: number;
    params: Record<string, string>;
  }[] = [];
  const skipped: SkippedStep[] = [];
  for (const { entry, leg } of tagged) {
    const phase = basePhase(entry);
    let effective = phase;
    if (isCreateTable(entry)) {
      effective = Math.max(0, clearedPhase.get(entry.table) ?? 0);
    }
    const target = renameTarget(entry);
    if (target !== null) clearedPhase.set(entry.table, 1);
    if (/^DROP TABLE/i.test(entry.statement.trim())) {
      clearedPhase.set(entry.table, 1);
    }
    const sets = paramSets(entry);
    if (sets === "skip") {
      skipped.push({ code: entry.code, reason: SEED_FORM_SKIP_REASON });
      continue;
    }
    for (const params of sets) {
      resolved.push({ entry, leg, phase: effective, params });
    }
  }

  // Stable sort by effective phase; the catalogue order is preserved
  // within a phase.
  const phased = [...resolved].sort((a, b) => a.phase - b.phase);

  const steps: RecreateStep[] = phased.map((r, order) => ({
    code: r.entry.code,
    params: r.params,
    order,
    phase: r.phase,
    kind: r.entry.kind,
    table: r.entry.table,
    leg: r.leg,
    entry: r.entry,
  }));

  // Hoist a seed that reads from a table a later step drops to just
  // before that drop, so the seed runs while its source still exists.
  // The hoisted seed takes the drop's phase (it executes in the
  // reconciliation phase, after the table's creation).
  for (const seed of [...steps].filter((s) => s.kind === "seed")) {
    const sql = resolveStatementText(seed.entry, seed.params);
    const sources = new Set<string>();
    for (const match of sql.matchAll(/FROM\s+["`]?([\w]+)/gi)) {
      sources.add(match[1]);
    }
    if (sources.size === 0) continue;
    const seedAt = steps.indexOf(seed);
    // The drop may sit before the seed in the phased order (phase 1
    // vs phase 3) — the hoist moves the seed to just before it.
    const dropAt = steps.findIndex(
      (s) =>
        s.kind === "schema" &&
        /^DROP TABLE/i.test(s.entry.statement.trim()) &&
        sources.has(s.table),
    );
    if (dropAt === -1 || dropAt === seedAt - 1) continue;
    const [moved] = steps.splice(seedAt, 1);
    // The drop shifted one position earlier when the seed sat before it.
    const insertAt = dropAt > seedAt ? dropAt - 1 : dropAt;
    moved.phase = steps[insertAt].phase;
    steps.splice(insertAt, 0, moved);
    steps.forEach((s, i) => {
      s.order = i;
    });
  }

  // For each rename, record the source table's shape just before it
  // (the plan prefix, executed against a fresh model). The selection
  // uses this to tell the old-shaped table (rename pending) from the
  // rebuilt table that reuses the same name (rename done).
  for (const step of steps) {
    if (renameTarget(step.entry) === null) continue;
    const prefix = steps.slice(0, step.order);
    const instance = new InMemorySchemaInstance();
    for (const s of prefix) {
      instance.exec(resolveStatementText(s.entry, s.params));
    }
    const table = instance.introspect().tables[step.table];
    step.renameFromShape = table ? shapeKey(table.columns) : null;
  }

  return { steps, skipped };
}

function shapeKey(
  columns: { name: string; type: string; pk: number }[],
): string {
  return JSON.stringify(
    [...columns]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ name: c.name, type: c.type, pk: c.pk })),
  );
}

/** The plan's steps for one leg, for per-leg selection and execution. */
export function planForLeg(plan: RecreatePlan, leg: RecreateLeg): RecreatePlan {
  return { steps: plan.steps.filter((s) => s.leg === leg), skipped: [] };
}

function modelForSteps(steps: RecreateStep[]): SchemaModel {
  const instance = new InMemorySchemaInstance();
  for (const step of steps) {
    instance.exec(resolveStatementText(step.entry, step.params));
  }
  return instance.introspect();
}

/** The model the whole plan builds (the P4 combined fixture's shape). */
export function expectedModelForPlan(plan: RecreatePlan): SchemaModel {
  return modelForSteps(plan.steps);
}

/** The model one leg's steps build (the per-leg verification target). */
export function expectedModelForLeg(
  plan: RecreatePlan,
  leg: RecreateLeg,
): SchemaModel {
  return modelForSteps(plan.steps.filter((s) => s.leg === leg));
}

/**
 * Read a store's live schema from sqlite_master. The stored statement
 * text is parsed through the P0 harness, so the model is structural,
 * not textual. A row whose stored statement cannot be parsed fails
 * the probe by name — the operator learns which table broke it.
 */
export async function introspectSchema(
  probe: SchemaProbe,
): Promise<SchemaModel> {
  const rows = await probe.query(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index')",
  );
  const model = emptySchemaModel();
  for (const row of rows) {
    const sql = row.sql;
    if (typeof sql !== "string" || sql.trim() === "") continue;
    try {
      parseSchemaStatement(sql, model);
    } catch (err) {
      const name = typeof row.name === "string" ? row.name : "?";
      throw new Error(
        `recreate runner: cannot parse stored schema for ${name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return model;
}

function stepKey(step: RecreateStep): string {
  return `${step.code}|${JSON.stringify(step.params)}`;
}

function indexShape(
  step: RecreateStep,
): { table: string; columns: string[]; unique: boolean } | null {
  const model = emptySchemaModel();
  parseSchemaStatement(resolveStatementText(step.entry, step.params), model);
  const name = step.entry.index;
  if (!name) return null;
  return model.indexes[name] ?? null;
}

/**
 * Apply one selected step to the projected model (the model the store
 * will have after the steps selected so far). The P0 parser handles
 * every form except a rename, which is applied here by moving the
 * table entry — the parser's rename blind spot is a property of the
 * PIN's model, not of the selection.
 */
function applyToProjected(
  step: RecreateStep,
  projected: SchemaModel,
): void {
  const target = renameTarget(step.entry);
  if (target !== null) {
    const table = projected.tables[step.table];
    if (table !== undefined) {
      projected.tables[target] = table;
      delete projected.tables[step.table];
    }
    return;
  }
  parseSchemaStatement(
    resolveStatementText(step.entry, step.params),
    projected,
  );
}

function selectNonDrop(
  step: RecreateStep,
  projected: SchemaModel,
): boolean {
  const entry = step.entry;
  const sql = entry.statement.trim();
  if (/^ALTER TABLE/i.test(sql)) {
    // Column add: runs when the column is absent from the projected
    // model — a column a selected creation already provides (the
    // ORM's tenant_id, which its table creation already lists) is
    // not added again, so the step cannot fail on real SQLite.
    const column =
      step.params.column ??
      sql.match(/ADD\s+COLUMN\s+["`]?([\w]+)/i)?.[1];
    const table = projected.tables[step.table];
    return (
      table === undefined ||
      column === undefined ||
      !table.columns.some((c) => c.name === column)
    );
  }
  if (isCreateIndex(entry)) {
    const name = entry.index;
    if (!name) return false;
    const existing = projected.indexes[name];
    if (!existing) return true;
    const shape = indexShape(step);
    if (!shape) return true;
    return (
      shape.table !== existing.table ||
      shape.unique !== existing.unique ||
      JSON.stringify(shape.columns) !== JSON.stringify(existing.columns)
    );
  }
  throw new Error(
    `recreate runner: no selection rule for step ${step.code}`,
  );
}

/**
 * A table-creation before any rename of its table builds the old
 * table: it runs only on a fresh build (table absent from the
 * projected model, no legacy table yet). In the crash state — the old
 * table's data lives in the legacy table — creating an empty old
 * table would be wrong.
 */
function selectOriginalCreate(
  step: RecreateStep,
  projected: SchemaModel,
  renamesByTable: Map<string, RecreateStep[]>,
): boolean {
  if (projected.tables[step.table] !== undefined) return false;
  for (const rename of renamesByTable.get(step.table) ?? []) {
    const legacy = renameTarget(rename.entry);
    if (legacy !== null && projected.tables[legacy] !== undefined) {
      return false;
    }
  }
  return true;
}

/**
 * A table-creation after a rename of its table builds the new table:
 * it runs when the table is absent from the projected model. The
 * projected model already reflects a selected rename (the walk
 * applies it), so no separate rename check is needed here.
 */
function selectRebuildCreate(
  step: RecreateStep,
  projected: SchemaModel,
): boolean {
  return projected.tables[step.table] === undefined;
}

/**
 * A rename runs only while the old-shaped table is still there — the
 * live table's shape must match the shape the plan builds just
 * before the rename — or, on a fresh build, when the table is absent
 * and its original creation is selected (the creation below builds
 * the old table this rename clears). It never runs against the
 * rebuilt table that reuses the same name.
 */
function selectRename(
  step: RecreateStep,
  actual: SchemaModel,
  selectedKeys: Set<string>,
  createsByTable: Map<string, RecreateStep[]>,
): boolean {
  const actualTable = actual.tables[step.table];
  if (
    actualTable !== undefined &&
    step.renameFromShape !== undefined &&
    step.renameFromShape !== null &&
    shapeKey(actualTable.columns) === step.renameFromShape
  ) {
    return true;
  }
  if (actualTable === undefined) {
    const creates = createsByTable.get(step.table) ?? [];
    const original = creates.find((c) => c.order < step.order);
    if (original && selectedKeys.has(stepKey(original))) return true;
  }
  return false;
}

function selectDrop(
  step: RecreateStep,
  plan: RecreatePlan,
  projected: SchemaModel,
  actual: SchemaModel,
  selectedKeys: Set<string>,
  createsByTable: Map<string, RecreateStep[]>,
  renamesByTarget: Map<string, RecreateStep[]>,
): boolean {
  const entry = step.entry;
  if (/^DROP TABLE/i.test(entry.statement.trim())) {
    // Runs when the table exists in the projected model — which
    // includes a table a selected rename created earlier in the
    // walk — or when a rename targeting it will be selected (the
    // rename may follow the drop in the plan; its decision is
    // computed on demand from the live shape and the original
    // creation's selection, both already known at this point).
    if (projected.tables[step.table] !== undefined) return true;
    for (const rename of renamesByTarget.get(step.table) ?? []) {
      if (selectRename(rename, actual, selectedKeys, createsByTable)) {
        return true;
      }
    }
    return false;
  }
  if (/^DROP INDEX/i.test(entry.statement.trim())) {
    const name = entry.index;
    if (!name) return false;
    const existing = projected.indexes[name];
    if (!existing) return false;
    // The drop clears a wrong-shaped index so its creation can
    // rebuild it; an index with no creation defining it is stale
    // and is dropped outright. A correct index is never dropped
    // alone. The creation's shape comes from the plan, so the
    // decision is made at the drop's position in the walk — before
    // the creation runs — not against a model the creation already
    // updated.
    const create = plan.steps.find(
      (s) => s.entry.index === name && isCreateIndex(s.entry),
    );
    if (!create) return true;
    const shape = indexShape(create);
    if (!shape) return true;
    return (
      shape.table !== existing.table ||
      shape.unique !== existing.unique ||
      JSON.stringify(shape.columns) !== JSON.stringify(existing.columns)
    );
  }
  return false;
}

/**
 * Select the steps that close a non-empty diff against the probed
 * schema. The walk follows the plan order and maintains a projected
 * model — the model the store will have after the steps selected so
 * far — so a step is selected only when its effect is still missing
 * at its position in the run. That is what makes a re-run safe and
 * what keeps a redundant column-add (a column a selected creation
 * already provides) from failing on real SQLite. Renames are
 * decided inline, against the live shape, because the parser does
 * not model them; the walk then applies a selected rename to the
 * projected model before deciding the steps that follow it. A seed
 * is selected only when its table's creation is selected (the table
 * is being built or rebuilt) or when the last report names it as
 * failed.
 */
export function selectSteps(
  plan: RecreatePlan,
  actual: SchemaModel,
  failedCodes: string[] = [],
): SelectedSteps {
  const failed = new Set(failedCodes);
  const renamesByTable = new Map<string, RecreateStep[]>();
  const renamesByTarget = new Map<string, RecreateStep[]>();
  const createsByTable = new Map<string, RecreateStep[]>();
  for (const step of plan.steps) {
    if (step.kind !== "schema") continue;
    if (isCreateTable(step.entry)) {
      const list = createsByTable.get(step.table) ?? [];
      list.push(step);
      createsByTable.set(step.table, list);
    }
    const target = renameTarget(step.entry);
    if (target !== null) {
      const list = renamesByTable.get(step.table) ?? [];
      list.push(step);
      renamesByTable.set(step.table, list);
      const byTarget = renamesByTarget.get(target) ?? [];
      byTarget.push(step);
      renamesByTarget.set(target, byTarget);
    }
  }
  const isRebuildCreate = (step: RecreateStep): boolean =>
    (renamesByTable.get(step.table) ?? []).some(
      (r) => r.order < step.order,
    );

  // The walk follows the plan order and maintains a projected
  // model — the model the store will have after the steps selected
  // so far — and decides every step inline, against the projected
  // model as it stands at that step's position. Renames are decided
  // against the live shape (the parser cannot tell the old table
  // from the new), and the walk applies a selected rename to the
  // projected model before deciding the steps that follow it.
  // Original creations precede every rename in the plan, so their
  // decision is already made by the time a rename is reached; a
  // drop-table's rename link is computed on demand for the same
  // reason. Drops are decided inline too: a drop-index is judged
  // against the index shape before its creation runs, so a fresh
  // store (no index yet) never selects it.
  const projected: SchemaModel = JSON.parse(JSON.stringify(actual));
  const selectedKeys = new Set<string>();
  const selectedSchema: RecreateStep[] = [];
  const select = (step: RecreateStep) => {
    selectedSchema.push(step);
    selectedKeys.add(stepKey(step));
    applyToProjected(step, projected);
  };

  for (const step of plan.steps) {
    if (step.kind !== "schema") continue;
    if (renameTarget(step.entry) !== null) {
      if (selectRename(step, actual, selectedKeys, createsByTable)) {
        select(step);
      }
      continue;
    }
    if (isDrop(step.entry)) {
      if (
        selectDrop(
          step,
          plan,
          projected,
          actual,
          selectedKeys,
          createsByTable,
          renamesByTarget,
        )
      ) {
        select(step);
      }
      continue;
    }
    if (isCreateTable(step.entry)) {
      if (isRebuildCreate(step)) {
        if (selectRebuildCreate(step, projected)) select(step);
      } else if (selectOriginalCreate(step, projected, renamesByTable)) {
        select(step);
      }
      continue;
    }
    if (selectNonDrop(step, projected)) {
      select(step);
    }
  }
  selectedSchema.sort((a, b) => a.order - b.order);

  const selectedSeeds: RecreateStep[] = [];
  for (const step of plan.steps) {
    if (step.kind !== "seed") continue;
    const createSelected = (createsByTable.get(step.table) ?? []).some(
      (s) => selectedKeys.has(stepKey(s)),
    );
    if (createSelected || failed.has(step.code)) {
      selectedSeeds.push(step);
      selectedKeys.add(stepKey(step));
    }
  }

  const skipped = plan.steps.filter((s) => !selectedKeys.has(stepKey(s)));
  return { schema: selectedSchema, seeds: selectedSeeds, skipped };
}


/**
 * Verify a leg's store against the model its steps build. Missing or
 * changed catalogue objects fail the run; objects outside the
 * catalogue's domain are listed, not failed. (P4 finding 4's rename
 * blind spot needs no exception here: the harness does not model
 * renames, but the rebuilt table reuses the same name with the same
 * final shape, so the expected model and the real store agree on
 * this table — the probe test proves it against real SQLite.)
 */
export function verifyRecreate(
  expected: SchemaModel,
  actual: SchemaModel,
): VerificationResult {
  const diff = diffSchema(actual, expected);
  const knownDifferences: string[] = [];
  const failures: string[] = [];
  for (const t of diff.missingTables) failures.push(`missing table ${t}`);
  for (const c of diff.missingColumns) {
    failures.push(`missing column ${c.table}.${c.column}`);
  }
  for (const i of diff.missingIndexes) failures.push(`missing index ${i}`);
  for (const c of diff.missingConstraints) {
    failures.push(`missing constraint ${c.table}.${c.constraint}`);
  }
  for (const c of diff.changedColumns) {
    failures.push(
      `changed column ${c.table}.${c.column}: expected ${c.expectedType}, actual ${c.actualType}`,
    );
  }
  for (const c of diff.changedIndexes) {
    failures.push(`changed index ${c.name}`);
  }
  return {
    ok: failures.length === 0,
    diff,
    extras: {
      tables: diff.extraTables,
      columns: diff.extraColumns,
      indexes: diff.extraIndexes,
      constraints: diff.extraConstraints,
    },
    knownDifferences,
    failures,
  };
}

/**
 * Build the D1 probe over a bound D1 client (prepare/bind/all). The
 * probe lives in the data layer (this module) — a route must never
 * call prepare() itself (the D-D census pins prepare() outside
 * src/data/ to the aspect's own leg alone).
 */
export function d1SchemaProbe(d1: D1BatchDatabase): SchemaProbe {
  return {
    query: async (sql: string) => {
      const bound = d1.prepare(sql).bind() as {
        all(): Promise<{ results?: unknown }>;
      };
      const res = await bound.all();
      return (res.results ?? []) as Array<Record<string, unknown>>;
    },
  };
}

/**
 * Execute the D1 leg inside the transaction aspect's D1 batch
 * backend: every statement is buffered through the executor (so the
 * structured log carries its catalogue code) and one batch applies
 * them atomically. On failure the batch is discarded and the report
 * lists nothing as executed — the buffered steps are rolled back,
 * the throwing step failed, the rest skipped.
 */
export async function executeD1Leg(
  d1: D1BatchDatabase,
  catalogue: SchemaCatalogue,
  steps: RecreateStep[],
  options: LegExecuteOptions = {},
): Promise<LegReport> {
  const selected = steps.map((s) => s.code);
  const buffered: string[] = [];
  let failedIndex = -1;
  let thrown: unknown = null;
  const backend = d1BatchTransactionBackend(d1);
  try {
    await withTransaction(
      backend,
      {
        operationName: options.operationName ?? "schema.recreate.d1",
        emit: options.emit,
      },
      async (unit) => {
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          try {
            await executeStatement(
              catalogue,
              step.code,
              {
                exec: (sql: string) => {
                  unit.exec(sql);
                },
              },
              step.params,
            );
          } catch (err) {
            failedIndex = i;
            throw err;
          }
          buffered.push(step.code);
        }
      },
    );
  } catch (err) {
    thrown = err;
  }
  if (thrown !== null) {
    const code =
      failedIndex >= 0
        ? steps[failedIndex].code
        : "schema.recreate.d1";
    // A failure inside the wrapped call (failedIndex >= 0) means the
    // steps after it were never attempted; a failure at batch time
    // (failedIndex < 0) means every step was buffered and then
    // discarded with the batch — none of them was "never attempted",
    // so skipped is empty and rolledBack holds them all. The batch
    // as a whole is the failed unit (its error text carries the
    // cause); the runner cannot attribute a batch failure to one
    // step, so it does not pretend to.
    return {
      leg: "d1",
      selected,
      executed: [],
      failed: [
        {
          code,
          error: thrown instanceof Error ? thrown.message : String(thrown),
        },
      ],
      skipped:
        failedIndex >= 0
          ? steps.slice(failedIndex + 1).map((s) => s.code)
          : [],
      rolledBack: [...buffered],
      outcome: "failed",
    };
  }
  return {
    leg: "d1",
    selected,
    executed: [...buffered],
    failed: [],
    skipped: [],
    rolledBack: [],
    outcome: "succeeded",
  };
}

/**
 * Execute the DO leg statement by statement, stopping at the first
 * failure with an honest partial report. The DO leg cannot use the
 * transaction aspect: the DO backend refuses async work, and the
 * executor is async — so DO-leg atomicity is explicitly NOT claimed;
 * a failed run is re-run safely because selection is diff-based.
 */
export async function executeDoLeg(
  executor: SqlExecutor,
  catalogue: SchemaCatalogue,
  steps: RecreateStep[],
): Promise<LegReport> {
  const selected = steps.map((s) => s.code);
  const executed: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      await executeStatement(catalogue, step.code, executor, step.params);
      executed.push(step.code);
    } catch (err) {
      return {
        leg: "do",
        selected,
        executed,
        failed: [
          {
            code: step.code,
            error: err instanceof Error ? err.message : String(err),
          },
        ],
        skipped: steps.slice(i + 1).map((s) => s.code),
        rolledBack: [],
        outcome: "failed",
      };
    }
  }
  return {
    leg: "do",
    selected,
    executed,
    failed: [],
    skipped: [],
    rolledBack: [],
    outcome: "succeeded",
  };
}
