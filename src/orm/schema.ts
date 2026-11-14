/**
 * §22 re-export shim — #2345 (#1976 step 3a, ADR 0022 D-A).
 *
 * The canonical shared-table DDL moved to
 * src/data/ormSchema.ts (the data layer is its home now);
 * this module re-exports it so the existing import path
 * keeps working. The DDL strings are unchanged — the drift
 * pin in tests/schema_single_source.test.ts now targets the
 * canonical module (disclosed §7 pin update, #2345).
 *
 * @deprecated Superseded by src/data/ormSchema.ts (#2345).
 */
export {
  SHARED_MAS_TABLES,
  SHARED_TABLE_DDL,
  ensureAuditChainColumns,
  ensurePromotionsIndex,
  ensureSharedTable,
  ensureSharedTables,
  ensureTransactionTenantColumn,
  type SharedMasTable,
} from "../data/ormSchema";
