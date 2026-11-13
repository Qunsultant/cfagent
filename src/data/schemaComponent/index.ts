/**
 * #4282 P0 — schema component barrel.
 *
 * One schema-creation component owns all DDL and all DML, externalized
 * and catalogued. This phase (P0) is the substrate: catalogue format +
 * registry, statement codes, AOP-logged executor, recreate planner /
 * report, and the schema-equality harness. No callers are wired yet —
 * P1–P3 fill the catalogue one family at a time, P4 proves
 * reproduction, P5 adds the operator surface.
 */
export * from "./catalogueTypes";
export * from "./statementCodes";
export * from "./schemaErrors";
export * from "./catalogue";
export * from "./executor";
export * from "./recreatePlanner";
export * from "./equalityHarness";
