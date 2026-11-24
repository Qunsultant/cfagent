/**
 * #4282 P6a (#4384) — DML catalogue entries for the D1 family.
 *
 * Every migrated D1 operation is one entry here, keyed by its code
 * (dml.d1.<table>.<action>). The three forms:
 *
 * - "builder": the thunk runs the operation via Drizzle (a single
 *   statement, or a db.batch of several for the atomic multi-row
 *   writes). The adapter delegates and keeps its port mapping,
 *   error semantics, and control flow (re-checks, applied-checks).
 * - "fragment": the thunk returns a Drizzle SQL fragment the builder
 *   cannot express (an atomic counter increment/decrement, an
 *   excluded.* reference). The adapter resolves it by code and
 *   passes it into its own builder call.
 * - "build": the thunk assembles a whole Drizzle SQL object for a
 *   dynamically-shaped query (the marketplace repository, whose
 *   table and columns vary per port). The executor runs it through
 *   db.all (read shapes) or db.run (write shapes).
 *
 * Two deliberate shapes inside this file:
 * - A run thunk may use sql`` itself (the resource totals bucket:
 *   CAST(ts_ms / ? AS INTEGER)). That SQL is catalogued under the
 *   entry's own code — it is catalogue content, not an inline
 *   escape. The fragment ENTRY form is for fragments an ADAPTER
 *   needs (outside this file).
 * - The marketplace build thunks share one implementation per
 *   shape, bound per table (table name + column map closed over
 *   at registration). The column validation the adapter used to
 *   do (columnMap lookup + IDENT test) moves with the assembly.
 *
 * Parameter contract: every thunk validates the params it needs
 * (reqString / reqNumber / reqRecord / reqValues) and fails closed
 * on a missing or mistyped one — a caller passing the wrong shape
 * gets a typed EXECUTION_FAILED, never a malformed statement.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  max,
  ne,
  sql,
  sum,
  type SQL,
} from "drizzle-orm";
import type { DmlCatalogueEntry, DmlParams } from "./dmlCatalogue";
import {
  AD_COLUMN_MAP,
  CATEGORY_COLUMN_MAP,
  EXTERNAL_AD_COLUMN_MAP,
  REFERRAL_COLUMN_MAP,
} from "../doSqliteOrmAdapters";
import {
  agentApprovedFreeQuotaCounts,
  agentAsyncJobs,
  agentBundleEntitlements,
  agentBundlePurchases,
  agentCodeRedemptionCounts,
  agentCodeRunBalances,
  agentFreeRunCounts,
  agentIdentityAttributeIndex,
  agentProfileIdempotencyKeys,
  agentProposalTransitions,
  agentProposals,
  agentReferralCodeRules,
  agentReferralCodes,
  agentRunsPackBalances,
  agentUserProfiles,
  masFeedDatasets,
  masIndexLists,
  quoteSourceSetting,
  resourceAlertState,
  resourceComparisonReports,
  resourceDailyRollups,
  resourceSqlOps,
} from "../drizzleSchema";

/* Parameter validation — fail closed on a missing or mistyped param. */

function reqString(params: DmlParams, name: string): string {
  const value = params[name];
  if (typeof value !== "string") {
    throw new Error(`DML param "${name}" must be a string`);
  }
  return value;
}

function reqNumber(params: DmlParams, name: string): number {
  const value = params[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`DML param "${name}" must be a finite number`);
  }
  return value;
}

function reqRecord(params: DmlParams, name: string): Record<string, unknown> {
  const value = params[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`DML param "${name}" must be an object`);
  }
  return value as Record<string, unknown>;
}

function reqValues(params: DmlParams): Record<string, unknown> {
  return reqRecord(params, "values");
}

/** The lookup-index rows for a profile save: an array (possibly empty) of index-row records. */
function reqIndexRows(params: DmlParams): (typeof agentIdentityAttributeIndex.$inferInsert)[] {
  const value = params["indexRows"];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`DML param "indexRows" must be an array`);
  }
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`DML param "indexRows" must contain only objects`);
    }
    const r = row as Record<string, unknown>;
    for (const key of ["tenantId", "attributeName", "attributeValueNormalized", "internalUserId", "source"]) {
      if (typeof r[key] !== "string") {
        throw new Error(`DML param "indexRows" row field "${key}" must be a string`);
      }
    }
    if (typeof r["updatedAtMs"] !== "number" || !Number.isFinite(r["updatedAtMs"])) {
      throw new Error(`DML param "indexRows" row field "updatedAtMs" must be a finite number`);
    }
  }
  return value as (typeof agentIdentityAttributeIndex.$inferInsert)[];
}

/* ------------------------------------------------------------------ */
/* mas_feed_datasets — D1FeedDatasetStore (#3530 S1)                   */
/* ------------------------------------------------------------------ */

const FEED_DATASET_ENTRIES: DmlCatalogueEntry[] = [
  {
    code: "dml.d1.mas_feed_datasets.insert",
    table: "mas_feed_datasets",
    operation: "insert",
    form: "builder",
    run: async (db, params) => {
      const values = reqValues(params);
      return db.insert(masFeedDatasets).values(
        values as typeof masFeedDatasets.$inferInsert,
      );
    },
  },
  {
    code: "dml.d1.mas_feed_datasets.list_ids",
    table: "mas_feed_datasets",
    operation: "read",
    form: "builder",
    run: async (db, params) => {
      return db
        .select({ id: masFeedDatasets.id })
        .from(masFeedDatasets)
        .where(
          and(
            eq(masFeedDatasets.sourceId, reqString(params, "sourceId")),
            eq(masFeedDatasets.dataset, reqString(params, "dataset")),
          ),
        )
        .orderBy(desc(masFeedDatasets.createdAt), desc(masFeedDatasets.id));
    },
  },
  {
    code: "dml.d1.mas_feed_datasets.prune_delete",
    table: "mas_feed_datasets",
    operation: "delete",
    form: "builder",
    // #4930: delete by primary key — re-deleting a missing row is a
    // no-op, so the entry is safe to retry under redelivery.
    idempotent: true,
    run: async (db, params) => {
      return db
        .delete(masFeedDatasets)
        .where(eq(masFeedDatasets.id, reqString(params, "id")));
    },
  },
  {
    code: "dml.d1.mas_feed_datasets.read_latest",
    table: "mas_feed_datasets",
    operation: "read",
    form: "builder",
    run: async (db, params) => {
      return db
        .select({ artifact_json: masFeedDatasets.artifactJson })
        .from(masFeedDatasets)
        .where(
          and(
            eq(masFeedDatasets.sourceId, reqString(params, "sourceId")),
            eq(masFeedDatasets.dataset, reqString(params, "dataset")),
          ),
        )
        .orderBy(desc(masFeedDatasets.createdAt), desc(masFeedDatasets.id))
        .limit(1);
    },
  },
  {
    code: "dml.d1.mas_feed_datasets.read_latest_usable",
    table: "mas_feed_datasets",
    operation: "read",
    form: "builder",
    run: async (db, params) => {
      return db
        .select({ artifact_json: masFeedDatasets.artifactJson })
        .from(masFeedDatasets)
        .where(
          and(
            eq(masFeedDatasets.sourceId, reqString(params, "sourceId")),
            eq(masFeedDatasets.dataset, reqString(params, "dataset")),
            ne(masFeedDatasets.status, "failed"),
            gt(masFeedDatasets.rowsPersisted, 0),
          ),
        )
        .orderBy(desc(masFeedDatasets.createdAt), desc(masFeedDatasets.id))
        .limit(1);
    },
  },
  {
    code: "dml.d1.mas_feed_datasets.read_list",
    table: "mas_feed_datasets",
    operation: "read",
    form: "builder",
    run: async (db, params) => {
      return db
        .select({ artifact_json: masFeedDatasets.artifactJson })
        .from(masFeedDatasets)
        .where(
          and(
            eq(masFeedDatasets.sourceId, reqString(params, "sourceId")),
            eq(masFeedDatasets.dataset, reqString(params, "dataset")),
          ),
        )
        .orderBy(desc(masFeedDatasets.createdAt), desc(masFeedDatasets.id))
        .limit(reqNumber(params, "limit"));
    },
  },
];

/* ------------------------------------------------------------------ */
/* mas_index_lists — D1IndexListStore (#1980)                          */
/* ------------------------------------------------------------------ */

const INDEX_LIST_ENTRIES: DmlCatalogueEntry[] = [
  {
    code: "dml.d1.mas_index_lists.insert",
    table: "mas_index_lists",
    operation: "insert",
    form: "builder",
    run: async (db, params) => {
      const values = reqValues(params);
      return db.insert(masIndexLists).values(
        values as typeof masIndexLists.$inferInsert,
      );
    },
  },
  {
    code: "dml.d1.mas_index_lists.list_ids",
    table: "mas_index_lists",
    operation: "read",
    form: "builder",
    run: async (db, params) => {
      return db
        .select({ id: masIndexLists.id })
        .from(masIndexLists)
        .where(eq(masIndexLists.indexId, reqString(params, "indexId")))
        .orderBy(desc(masIndexLists.createdAt), desc(masIndexLists.id));
    },
  },
  {
    code: "dml.d1.mas_index_lists.prune_delete",
    table: "mas_index_lists",
    operation: "delete",
    form: "builder",
    // #4930: delete by primary key — re-deleting a missing row is a
    // no-op, so the entry is safe to retry under redelivery.
    idempotent: true,
    run: async (db, params) => {
      return db
        .delete(masIndexLists)
        .where(eq(masIndexLists.id, reqString(params, "id")));
    },
  },
  {
    code: "dml.d1.mas_index_lists.read_latest",
    table: "mas_index_lists",
    operation: "read",
    form: "builder",
    run: async (db, params) => {
      // Snake-case aliases: the adapter's parseRow reads the raw
      // column names (snapshot_date, members_json, ...).
      return db
        .select({
          id: masIndexLists.id,
          snapshot_date: masIndexLists.snapshotDate,
          source: masIndexLists.source,
          source_label: masIndexLists.sourceLabel,
          derived_from_holdings: masIndexLists.derivedFromHoldings,
          members_json: masIndexLists.membersJson,
          created_at: masIndexLists.createdAt,
        })
        .from(masIndexLists)
        .where(eq(masIndexLists.indexId, reqString(params, "indexId")))
        .orderBy(desc(masIndexLists.createdAt), desc(masIndexLists.id))
        .limit(1);
    },
  },
];

/* ------------------------------------------------------------------ */
/* quote_source_setting — D1QuoteSourceAdapter (#2362 step 4f)         */
/* ------------------------------------------------------------------ */

const QUOTE_SOURCE_ENTRIES: DmlCatalogueEntry[] = [
  {
    code: "dml.d1.quote_source_setting.read",
    table: "quote_source_setting",
    operation: "read",
    form: "builder",
    run: async (db) => {
      return db
        .select({ source: quoteSourceSetting.source })
        .from(quoteSourceSetting)
        .where(eq(quoteSourceSetting.id, 1));
    },
  },
  {
    code: "dml.d1.quote_source_setting.upsert",
    table: "quote_source_setting",
    operation: "upsert",
    form: "builder",
    run: async (db, params) => {
      const source = reqString(params, "source");
      const updatedAt = reqNumber(params, "updatedAt");
      return db
        .insert(quoteSourceSetting)
        .values({ id: 1, source, updatedAt })
        .onConflictDoUpdate({
          target: quoteSourceSetting.id,
          set: { source, updatedAt },
        });
    },
  },
];

/* ------------------------------------------------------------------ */
/* resource_sql_ops — D1ResourceUsageAdapter (#1819)                   */
/* ------------------------------------------------------------------ */

const RESOURCE_USAGE_ENTRIES: DmlCatalogueEntry[] = [
  {
    code: "dml.d1.resource_sql_ops.insert",
    table: "resource_sql_ops",
    operation: "insert",
    form: "builder",
    run: async (db, params) => {
      const values = reqValues(params);
      return db.insert(resourceSqlOps).values(
        values as typeof resourceSqlOps.$inferInsert,
      );
    },
  },
  {
    code: "dml.d1.resource_sql_ops.read_totals",
    table: "resource_sql_ops",
    operation: "read",
    form: "builder",
    run: async (db, params) => {
      const bucketMs = reqNumber(params, "bucketMs");
      const fromMs = reqNumber(params, "fromMs");
      const toMs = reqNumber(params, "toMs");
      // The CAST bucket is the one SQL shape the builder cannot
      // express; it lives here, catalogued under this entry's
      // code, built once and reused in select/group/order so all
      // three positions render identically.
      const bucket =
        sql<number>`CAST(${resourceSqlOps.tsMs} / ${bucketMs} AS INTEGER)`;
      return db
        .select({
          bucket,
          ns: resourceSqlOps.ns,
          op: resourceSqlOps.op,
          caller: resourceSqlOps.caller,
          trigger: resourceSqlOps.trigger,
          ops: count(),
          rows_read: sum(resourceSqlOps.rowsRead),
          rows_written: sum(resourceSqlOps.rowsWritten),
        })
        .from(resourceSqlOps)
        .where(
          and(
            gte(resourceSqlOps.tsMs, fromMs),
            lt(resourceSqlOps.tsMs, toMs),
          ),
        )
        .groupBy(
          bucket,
          resourceSqlOps.ns,
          resourceSqlOps.op,
          resourceSqlOps.caller,
          resourceSqlOps.trigger,
        )
        .orderBy(
          bucket,
          resourceSqlOps.ns,
          resourceSqlOps.op,
          resourceSqlOps.caller,
          resourceSqlOps.trigger,
        );
    },
  },
];

/* ------------------------------------------------------------------ */
/* resource rollups — D1ResourceRollupStore (#2362 step 4f)            */
/* INSERT OR REPLACE becomes insert().onConflictDoUpdate() setting    */
/* every column (row content identical).                              */
/* ------------------------------------------------------------------ */

const RESOURCE_ROLLUP_ENTRIES: DmlCatalogueEntry[] = [
  {
    code: "dml.d1.resource_daily_rollups.upsert",
    table: "resource_daily_rollups",
    operation: "upsert",
    form: "builder",
    run: async (db, params) => {
      const values = reqValues(params) as typeof resourceDailyRollups.$inferInsert;
      return db
        .insert(resourceDailyRollups)
        .values(values)
        .onConflictDoUpdate({
          target: [
            resourceDailyRollups.day,
            resourceDailyRollups.ns,
            resourceDailyRollups.op,
            resourceDailyRollups.caller,
            resourceDailyRollups.trigger,
          ],
          set: {
            day: values.day,
            ns: values.ns,
            op: values.op,
            caller: values.caller,
            trigger: values.trigger,
            ops: values.ops,
            rowsRead: values.rowsRead,
            rowsWritten: values.rowsWritten,
          },
        });
    },
  },
  {
    code: "dml.d1.resource_daily_rollups.read_day",
    table: "resource_daily_rollups",
    operation: "read",
    form: "builder",
    run: async (db, params) => {
      return db
        .select({
          day: resourceDailyRollups.day,
          ns: resourceDailyRollups.ns,
          op: resourceDailyRollups.op,
          caller: resourceDailyRollups.caller,
          trigger: resourceDailyRollups.trigger,
          ops: resourceDailyRollups.ops,
          rows_read: resourceDailyRollups.rowsRead,
          rows_written: resourceDailyRollups.rowsWritten,
        })
        .from(resourceDailyRollups)
        .where(eq(resourceDailyRollups.day, reqString(params, "day")))
        .orderBy(
          resourceDailyRollups.ns,
          resourceDailyRollups.op,
          resourceDailyRollups.caller,
          resourceDailyRollups.trigger,
        );
    },
  },
  {
    code: "dml.d1.resource_daily_rollups.latest_day",
    table: "resource_daily_rollups",
    operation: "read",
    form: "builder",
    run: async (db) => {
      return db
        .select({ day: max(resourceDailyRollups.day) })
        .from(resourceDailyRollups);
    },
  },
  {
    code: "dml.d1.resource_alert_state.read",
    table: "resource_alert_state",
    operation: "read",
    form: "builder",
    run: async (db, params) => {
      return db
        .select({
          budget: resourceAlertState.budget,
          day: resourceAlertState.day,
          alerted_at: resourceAlertState.alertedAt,
          delivered: resourceAlertState.delivered,
          note: resourceAlertState.note,
        })
        .from(resourceAlertState)
        .where(
          and(
            eq(resourceAlertState.budget, reqString(params, "budget")),
            eq(resourceAlertState.day, reqString(params, "day")),
          ),
        );
    },
  },
  {
    code: "dml.d1.resource_alert_state.upsert",
    table: "resource_alert_state",
    operation: "upsert",
    form: "builder",
    run: async (db, params) => {
      const values = reqValues(params) as typeof resourceAlertState.$inferInsert;
      return db
        .insert(resourceAlertState)
        .values(values)
        .onConflictDoUpdate({
          target: [resourceAlertState.budget, resourceAlertState.day],
          set: {
            budget: values.budget,
            day: values.day,
            alertedAt: values.alertedAt,
            delivered: values.delivered,
            note: values.note,
          },
        });
    },
  },
  {
    code: "dml.d1.resource_comparison_reports.read",
    table: "resource_comparison_reports",
    operation: "read",
    form: "builder",
    run: async (db, params) => {
      return db
        .select({ report_json: resourceComparisonReports.reportJson })
        .from(resourceComparisonReports)
        .where(eq(resourceComparisonReports.day, reqString(params, "day")));
    },
  },
  {
    code: "dml.d1.resource_comparison_reports.upsert",
    table: "resource_comparison_reports",
    operation: "upsert",
    form: "builder",
    run: async (db, params) => {
      const values = reqValues(params) as typeof resourceComparisonReports.$inferInsert;
      return db
        .insert(resourceComparisonReports)
        .values(values)
        .onConflictDoUpdate({
          target: resourceComparisonReports.day,
          set: {
            day: values.day,
            generatedAt: values.generatedAt,
            reportJson: values.reportJson,
          },
        });
    },
  },
];

/* ------------------------------------------------------------------ */
/* Batch adapters — one db.batch per entry, atomic or not at all       */
/* (the D1 batch contract). The adapter keeps its race re-checks.     */
/* ------------------------------------------------------------------ */

const BATCH_ENTRIES: DmlCatalogueEntry[] = [
  {
    code: "dml.d1.agent_bundle_purchases.record_purchase",
    table: "agent_bundle_purchases",
    operation: "insert",
    form: "builder",
    run: async (db, params) => {
      // The purchase row + its full entitlement set land in ONE
      // batch (the #2781 atomicity rule); the entry is keyed on
      // the purchase table, the batch's primary row.
      const purchase = reqValues(params) as typeof agentBundlePurchases.$inferInsert;
      const entitlements = params.entitlements;
      if (!Array.isArray(entitlements) || entitlements.length === 0) {
        throw new Error('DML param "entitlements" must be a non-empty array');
      }
      return db.batch([
        db.insert(agentBundlePurchases).values(purchase),
        ...entitlements.map((e) =>
          db.insert(agentBundleEntitlements).values(
            e as typeof agentBundleEntitlements.$inferInsert,
          ),
        ),
      ]);
    },
  },
  {
    code: "dml.d1.agent_user_profiles.save_once",
    table: "agent_user_profiles",
    operation: "insert",
    form: "builder",
    run: async (db, params) => {
      // The profile upsert + the idempotency-key insert land in
      // ONE batch (the #3261 Idempotent Receiver rule); the entry
      // is keyed on the profile table, the batch's primary row.
      // #5160 — the lookup-index rewrite rides the same batch:
      // a user save that changes a contact value must re-index
      // it, or the lookup would keep resolving the old value.
      const profile = reqValues(params) as typeof agentUserProfiles.$inferInsert;
      const idempotencyKey = reqString(params, "idempotencyKey");
      const createdAtMs = reqNumber(params, "createdAtMs");
      const indexRows = reqIndexRows(params);
      type BatchStatement = Parameters<typeof db.batch>[0][number];
      const statements: BatchStatement[] = [
        // #5160 — a keyed save supersedes the legacy login row
        // for the same login (a save after the refresh re-keyed
        // the identity must not leave two rows behind). The
        // delete runs first in the same batch; it deletes 0 rows
        // when no legacy row exists.
        db
          .delete(agentUserProfiles)
          .where(
            and(
              eq(agentUserProfiles.userLogin, profile.userLogin),
              isNull(agentUserProfiles.internalUserId),
            ),
          ),
        db
          .insert(agentUserProfiles)
          .values(profile)
          .onConflictDoUpdate({
            // #5160 — the upsert target is the (internalUserId,
            // tenantId) key. The save carries the FULL merged
            // row (the route reads the stored row first), so the
            // set writes the IDP columns too: a user save that
            // dropped them would silently un-record the
            // provenance a later refresh relies on. The route —
            // not the upsert — owns which columns a user edit
            // may change.
            target: [agentUserProfiles.internalUserId, agentUserProfiles.tenantId],
            set: {
              userLogin: profile.userLogin,
              displayName: profile.displayName,
              phone: profile.phone,
              email: profile.email,
              updatedAtMs: profile.updatedAtMs,
              idpIssuer: profile.idpIssuer,
              idpAttributes: profile.idpAttributes,
              provenance: profile.provenance,
              idpUpdatedAtMs: profile.idpUpdatedAtMs,
            },
          }),
        db.insert(agentProfileIdempotencyKeys).values({
          idempotencyKey,
          userLogin: profile.userLogin,
          createdAtMs,
        }),
      ];
      if (profile.internalUserId && profile.tenantId) {
        statements.push(
          db
            .delete(agentIdentityAttributeIndex)
            .where(
              and(
                eq(agentIdentityAttributeIndex.tenantId, profile.tenantId),
                eq(agentIdentityAttributeIndex.internalUserId, profile.internalUserId),
              ),
            ),
        );
        if (indexRows.length > 0) {
          statements.push(db.insert(agentIdentityAttributeIndex).values(indexRows));
        }
      }
      return db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
    },
  },
  {
    code: "dml.d1.agent_proposals.propose",
    table: "agent_proposals",
    operation: "insert",
    form: "builder",
    run: async (db, params) => {
      // The proposal row + its creation transition land in ONE
      // batch; the entry is keyed on the proposal table.
      const id = reqString(params, "id");
      const title = reqString(params, "title");
      const summary = reqString(params, "summary");
      const proposerAgent = reqString(params, "proposerAgent");
      const principal = reqString(params, "principal");
      const atMs = reqNumber(params, "atMs");
      return db.batch([
        db.insert(agentProposals).values({
          id,
          title,
          summary,
          proposerAgent,
          principal,
          state: "proposed",
          createdAtMs: atMs,
          updatedAtMs: atMs,
        }),
        db.insert(agentProposalTransitions).values({
          id: `${id}:created`,
          proposalId: id,
          fromState: null,
          toState: "proposed",
          actor: proposerAgent,
          gateRef: null,
          createdAtMs: atMs,
        }),
      ]);
    },
  },
  {
    code: "dml.d1.agent_proposals.transition",
    table: "agent_proposals",
    operation: "update",
    form: "builder",
    run: async (db, params) => {
      // The state update + the transition row land in ONE batch.
      const proposalId = reqString(params, "proposalId");
      const fromState = reqString(params, "fromState");
      const toState = reqString(params, "toState");
      const actor = reqString(params, "actor");
      const atMs = reqNumber(params, "atMs");
      const transitionId = reqString(params, "transitionId");
      const gateRef = params.gateRef;
      if (gateRef !== null && gateRef !== undefined && typeof gateRef !== "string") {
        throw new Error('DML param "gateRef" must be a string or null');
      }
      return db.batch([
        db
          .update(agentProposals)
          .set({ state: toState, updatedAtMs: atMs })
          .where(eq(agentProposals.id, proposalId)),
        db.insert(agentProposalTransitions).values({
          id: transitionId,
          proposalId,
          fromState,
          toState,
          actor,
          gateRef: (gateRef as string | null) ?? null,
          createdAtMs: atMs,
        }),
      ]);
    },
  },
];

/* ------------------------------------------------------------------ */
/* Marketplace — D1MarketplaceRepository (#2345 step 3a)               */
/* The assembly moves here verbatim (columnMap lookup with prop      */
/* fallback + IDENT test, null/undefined skipping in WHERE, boolean  */
/* 0/1 mapping, orderBy allow-list of map keys AND values). The      */
/* adapter keeps row mapping (fromRow), the D-E.2 verification, and   */
/* the existed/post-delete orchestration.                             */
/* ------------------------------------------------------------------ */

const MARKETPLACE_IDENT = /^[a-z][a-z0-9_]*$/;
type MarketplaceColumnMap = Record<string, string>;

function marketplaceCol(
  table: string,
  columnMap: MarketplaceColumnMap,
  prop: string,
): string {
  const col = columnMap[prop] || prop;
  if (!MARKETPLACE_IDENT.test(col)) {
    throw new Error(`Invalid column for ${table}: ${prop}`);
  }
  return col;
}

function marketplaceWhere(
  table: string,
  columnMap: MarketplaceColumnMap,
  where?: Record<string, unknown>,
): SQL | null {
  if (!where) return null;
  const clauses: SQL[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined || value === null) continue;
    const bound = typeof value === "boolean" ? (value ? 1 : 0) : value;
    clauses.push(
      sql`${sql.identifier(marketplaceCol(table, columnMap, key))} = ${bound}`,
    );
  }
  return clauses.length > 0 ? sql.join(clauses, sql` AND `) : null;
}

function marketplaceOrder(
  table: string,
  columnMap: MarketplaceColumnMap,
  orderBy?: string,
): SQL | null {
  if (!orderBy) return null;
  const allowed = new Set([
    ...Object.values(columnMap),
    ...Object.keys(columnMap),
  ]);
  const terms: SQL[] = [];
  for (const part of orderBy.split(",")) {
    const m = part.trim().match(/^([a-z][a-z0-9_]*)(?:\s+(ASC|DESC))?$/i);
    if (!m || !allowed.has(m[1])) {
      throw new Error(`Invalid orderBy for ${table}: ${orderBy}`);
    }
    terms.push(
      sql`${sql.identifier(m[1])} ${sql.raw((m[2] || "ASC").toUpperCase())}`,
    );
  }
  return sql.join(terms, sql`, `);
}

function marketplaceFindMany(
  table: string,
  columnMap: MarketplaceColumnMap,
): (params: DmlParams) => SQL {
  return (params) => {
    let query = sql`SELECT * FROM ${sql.identifier(table)}`;
    const where = marketplaceWhere(
      table,
      columnMap,
      params.where as Record<string, unknown> | undefined,
    );
    if (where) query = sql`${query} WHERE ${where}`;
    const order = marketplaceOrder(
      table,
      columnMap,
      params.orderBy as string | undefined,
    );
    if (order) query = sql`${query} ORDER BY ${order}`;
    const limit = params.limit as number | undefined;
    if (limit) query = sql`${query} LIMIT ${limit}`;
    const offset = params.offset as number | undefined;
    if (offset) query = sql`${query} OFFSET ${offset}`;
    return query;
  };
}

function marketplaceFindById(
  table: string,
  columnMap: MarketplaceColumnMap,
  idField: string,
): (params: DmlParams) => SQL {
  return (params) =>
    sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.identifier(marketplaceCol(table, columnMap, idField))} = ${reqString(params, "id")} LIMIT 1`;
}

function marketplaceCreate(
  table: string,
  columnMap: MarketplaceColumnMap,
): (params: DmlParams) => SQL {
  return (params) => {
    const record = reqRecord(params, "record");
    const cols: string[] = [];
    const values: unknown[] = [];
    for (const [prop, val] of Object.entries(record)) {
      cols.push(marketplaceCol(table, columnMap, prop));
      values.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
    }
    const placeholders = sql.join(
      values.map((v) => sql`${v}`),
      sql`, `,
    );
    return sql`INSERT INTO ${sql.identifier(table)} (${sql.raw(cols.join(", "))}) VALUES (${placeholders})`;
  };
}

function marketplaceUpdate(
  table: string,
  columnMap: MarketplaceColumnMap,
  idField: string,
): (params: DmlParams) => SQL {
  return (params) => {
    const id = reqString(params, "id");
    const updates = reqRecord(params, "updates");
    const sets: SQL[] = [];
    for (const [prop, val] of Object.entries(updates)) {
      if (prop === idField || val === undefined) continue;
      const bound = typeof val === "boolean" ? (val ? 1 : 0) : val;
      sets.push(
        sql`${sql.identifier(marketplaceCol(table, columnMap, prop))} = ${bound}`,
      );
    }
    // The adapter refuses an empty set before calling (returns
    // findById); an empty set reaching the thunk is a caller error.
    if (sets.length === 0) {
      throw new Error(`No updatable fields for ${table}`);
    }
    return sql`UPDATE ${sql.identifier(table)} SET ${sql.join(sets, sql`, `)} WHERE ${sql.identifier(marketplaceCol(table, columnMap, idField))} = ${id}`;
  };
}

function marketplaceDelete(
  table: string,
  columnMap: MarketplaceColumnMap,
  idField: string,
): (params: DmlParams) => SQL {
  return (params) =>
    sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.identifier(marketplaceCol(table, columnMap, idField))} = ${reqString(params, "id")}`;
}

function marketplaceCount(
  table: string,
  columnMap: MarketplaceColumnMap,
): (params: DmlParams) => SQL {
  return (params) => {
    let query = sql`SELECT COUNT(*) AS count FROM ${sql.identifier(table)}`;
    const where = marketplaceWhere(
      table,
      columnMap,
      params.where as Record<string, unknown> | undefined,
    );
    if (where) query = sql`${query} WHERE ${where}`;
    return query;
  };
}

function marketplaceTableEntries(
  table: string,
  columnMap: MarketplaceColumnMap,
  idField: string,
): DmlCatalogueEntry[] {
  return [
    {
      code: `dml.d1.${table}.find_many`,
      table,
      operation: "read",
      form: "build",
      mode: "all",
      build: marketplaceFindMany(table, columnMap),
    },
    {
      code: `dml.d1.${table}.find_one`,
      table,
      operation: "read",
      form: "build",
      mode: "all",
      build: marketplaceFindById(table, columnMap, idField),
    },
    {
      code: `dml.d1.${table}.create`,
      table,
      operation: "insert",
      form: "build",
      mode: "run",
      build: marketplaceCreate(table, columnMap),
    },
    {
      code: `dml.d1.${table}.update`,
      table,
      operation: "update",
      form: "build",
      mode: "run",
      // #4930: pure-assignment SET (column = bound literal) by id —
      // re-setting the same values is a no-op, so the entry is safe
      // to retry under redelivery. (The counter step below is NOT
      // flagged: col = col + delta double-counts on re-execution.)
      idempotent: true,
      build: marketplaceUpdate(table, columnMap, idField),
    },
    {
      code: `dml.d1.${table}.delete`,
      table,
      operation: "delete",
      form: "build",
      mode: "run",
      // #4930: delete by id — re-deleting a missing row is a no-op,
      // so the entry is safe to retry under redelivery.
      idempotent: true,
      build: marketplaceDelete(table, columnMap, idField),
    },
    {
      code: `dml.d1.${table}.count`,
      table,
      operation: "read",
      form: "build",
      mode: "all",
      build: marketplaceCount(table, columnMap),
    },
    {
      // The generic counter step the old adapter performed with a
      // raw UPDATE (one mechanism for every counter column, on
      // every marketplace table). The counter name is validated
      // through the table's column map (prop fallback + IDENT
      // test) exactly as the old col() lookup did, so an unknown
      // counter is rejected fail-closed instead of interpolated.
      code: `dml.d1.${table}.increment_counter`,
      table,
      operation: "update",
      form: "build",
      mode: "run",
      build: (params) => {
        const col = marketplaceCol(table, columnMap, reqString(params, "counter"));
        const idCol = marketplaceCol(table, columnMap, idField);
        return sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(col)} = ${sql.identifier(col)} + ${reqNumber(params, "delta")} WHERE ${sql.identifier(idCol)} = ${reqString(params, "id")}`;
      },
    },
  ];
}

const MARKETPLACE_ENTRIES: DmlCatalogueEntry[] = [
  ...marketplaceTableEntries("agent_categories", CATEGORY_COLUMN_MAP, "id"),
  ...marketplaceTableEntries("agent_external_ads", EXTERNAL_AD_COLUMN_MAP, "id"),
  ...marketplaceTableEntries("agent_ads", AD_COLUMN_MAP, "id"),
  {
    code: "dml.d1.agent_ads.increment_all_impressions",
    table: "agent_ads",
    operation: "update",
    form: "build",
    mode: "run",
    build: (params) =>
      sql`UPDATE ${sql.identifier("agent_ads")} SET ${sql.identifier("impressions")} = ${sql.identifier("impressions")} + ${reqNumber(params, "delta")}`,
  },
  ...marketplaceTableEntries("agent_referrals", REFERRAL_COLUMN_MAP, "id"),
];

/* ------------------------------------------------------------------ */
/* Fragments — SQL shapes the builder cannot express, resolved by     */
/* code and passed into the adapter's own builder call.               */
/* ------------------------------------------------------------------ */

const FRAGMENT_ENTRIES: DmlCatalogueEntry[] = [
  {
    code: "dml.d1.agent_code_redemption_counts.increment_redemption_count",
    table: "agent_code_redemption_counts",
    operation: "update",
    form: "fragment",
    fragment: () => sql`${agentCodeRedemptionCounts.redemptionCount} + 1`,
  },
  {
    code: "dml.d1.agent_referral_codes.increment_redemption_count",
    table: "agent_referral_codes",
    operation: "update",
    form: "fragment",
    fragment: () => sql`${agentReferralCodes.redemptionCount} + 1`,
  },
  {
    code: "dml.d1.agent_referral_code_rules.increment_redemption_count",
    table: "agent_referral_code_rules",
    operation: "update",
    form: "fragment",
    fragment: () => sql`${agentReferralCodeRules.redemptionCount} + 1`,
  },
  {
    code: "dml.d1.agent_code_run_balances.increment_runs",
    table: "agent_code_run_balances",
    operation: "update",
    form: "fragment",
    fragment: (params) =>
      sql`${agentCodeRunBalances.runsRemaining} + ${reqNumber(params, "delta")}`,
  },
  {
    code: "dml.d1.agent_code_run_balances.decrement_run",
    table: "agent_code_run_balances",
    operation: "update",
    form: "fragment",
    fragment: () => sql`${agentCodeRunBalances.runsRemaining} - 1`,
  },
  {
    code: "dml.d1.agent_approved_free_quota_counts.increment_used",
    table: "agent_approved_free_quota_counts",
    operation: "update",
    form: "fragment",
    fragment: () => sql`${agentApprovedFreeQuotaCounts.used} + 1`,
  },
  {
    code: "dml.d1.agent_free_run_counts.increment_used",
    table: "agent_free_run_counts",
    operation: "update",
    form: "fragment",
    fragment: () => sql`${agentFreeRunCounts.used} + 1`,
  },
  {
    code: "dml.d1.agent_runs_pack_balances.increment_runs",
    table: "agent_runs_pack_balances",
    operation: "update",
    form: "fragment",
    fragment: (params) =>
      sql`${agentRunsPackBalances.runsRemaining} + ${reqNumber(params, "delta")}`,
  },
  {
    code: "dml.d1.agent_runs_pack_balances.decrement_run",
    table: "agent_runs_pack_balances",
    operation: "update",
    form: "fragment",
    fragment: () => sql`${agentRunsPackBalances.runsRemaining} - 1`,
  },
  {
    code: "dml.d1.agent_async_jobs.stale_guard",
    table: "agent_async_jobs",
    operation: "read",
    form: "fragment",
    // The conditional-upsert staleness guard: the stored row wins
    // unless the incoming row is newer. The builder cannot name
    // the excluded.* row; this fragment is the only place that
    // reference lives.
    fragment: () => sql.raw("excluded.updated_at"),
  },
];

/** Every D1 builder-DML entry, in registration order. */
export const DML_CATALOGUE_ENTRIES: DmlCatalogueEntry[] = [
  ...FEED_DATASET_ENTRIES,
  ...INDEX_LIST_ENTRIES,
  ...QUOTE_SOURCE_ENTRIES,
  ...RESOURCE_USAGE_ENTRIES,
  ...RESOURCE_ROLLUP_ENTRIES,
  ...BATCH_ENTRIES,
  ...MARKETPLACE_ENTRIES,
  ...FRAGMENT_ENTRIES,
];
