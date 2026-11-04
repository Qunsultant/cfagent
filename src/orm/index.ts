/**
 * §22 re-export shim — #2345 (#1976 step 3a, ADR 0022 D-A).
 *
 * The ORM core moved to the data layer: the composition
 * facade lives in src/data/ormFacade.ts, the repository
 * implementation in src/data/ormRepositoryCore.ts, and the
 * port contracts in src/data/repositoryPorts.ts (+ the
 * per-aggregate *Ports.ts modules). This module stays as the
 * import path the existing call sites use; it defines
 * nothing. New code imports from src/data directly.
 *
 * @deprecated Superseded by src/data/ormFacade.ts (the
 * composition facade), src/data/ormRepositoryCore.ts, and the
 * src/data/*Ports.ts contracts (#2345).
 */
export {
  DatabaseORM,
  MissingOrmError,
  requireOrm,
  diagnoseStoredAuditChain,
  verifyStoredAuditChain,
  type TableMetadata,
} from "../data/ormFacade";
export {
  ChainedAuditRepository,
  Repository,
  type QueryOptions,
} from "../data/ormRepositoryCore";
export type { SqlStorage } from "../data/repositoryPorts";
