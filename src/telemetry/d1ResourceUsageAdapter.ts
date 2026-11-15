/**
 * DELEGATE since issue #2362 (#1976 step 4f): the D1
 * ResourceUsagePort adapter is superseded by its data-layer
 * home at src/data/d1ResourceUsageAdapter.ts (the table's
 * DDL authority is migration 0022). This module re-exports
 * it so the telemetry composition root and the agent goal
 * modules keep their import paths; new code should import
 * from the data layer.
 */
export {
  createD1ResourceDb,
  D1ResourceUsageAdapter,
  type ResourceD1Db,
} from "../data/d1ResourceUsageAdapter";
