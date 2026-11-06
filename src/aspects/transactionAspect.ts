/**
 * Issue #2288 (#1976 step 0) — the transaction aspect (ADR 0022 D-C).
 *
 * An AOP aspect in the established shape of this directory: a
 * higher-order wrapper around a call (context object + wrapped
 * function, cf. withAspects in loggingAspect.ts and the #817
 * wrappers in src/outcomes/outcomeAspects.ts), with every outcome —
 * commit, rollback, cannot-honour — emitted from the catalog
 * (src/aspects/errorCodes.ts, DATA_FOUNDATION_CATALOG) per the
 * #1969 rule. No inline outcome strings exist at call sites.
 *
 * THE CONTRACT (ADR 0022 D-C.3) is the least-common unit of work
 * every store can honour: the writes in one wrapped call are
 * applied atomically, or the call fails honestly. A store that
 * cannot honour the scope refuses BEFORE any write runs
 * (DataFoundationError, DATA_TX_CANNOT_HONOUR) — the screener
 * claim's silent degrade-to-racy-fallback (survey §3.1) is the
 * named anti-pattern and is never copied here. Cross-store
 * atomicity is NOT claimed: a unit spans exactly one backend.
 *
 * THE TWO LEGS differ, and the difference is part of the
 * contract, not an accident:
 *  - DO leg (DoSqlTransactionBackend): the unit runs INSIDE
 *    `storage.transactionSync`. That primitive is synchronous,
 *    so the wrapped call MUST be synchronous on this leg; an
 *    async wrapped call is refused with TX_CANNOT_HONOUR from
 *    inside the closure, which rolls the transaction back.
 *    Statements execute immediately; results of a statement are
 *    not part of the unit contract (see TransactionUnit.exec).
 *  - D1 leg (D1BatchTransactionBackend): D1's atomic primitive
 *    is `batch()` — statements are prepared and BUFFERED while
 *    the wrapped call runs, then applied by ONE batch() call
 *    when the wrapped call succeeds. If the wrapped call throws,
 *    the buffer is discarded and nothing was ever sent. A D1
 *    unit is therefore write-only: a statement's result cannot
 *    be read inside the unit (D1 batch semantics return results
 *    only after the batch applies). `db.transaction()` is never
 *    used (sequential BEGIN/COMMIT, not atomic — migrationRunner
 *    header, ADR 0002).
 *
 * NESTED CALLS join the ambient unit (AsyncLocalStorage; the
 * repo runs with nodejs_compat): a withTransaction call whose
 * backend already has an ambient unit runs its function against
 * that unit and emits NO outcome of its own — only the outermost
 * unit commits/rolls back and emits. An AWAITED nested failure
 * propagates to the outermost unit and rolls back everything.
 * One leg-shaped caveat, stated rather than hidden: on the DO
 * leg the wrapped call is synchronous (transactionSync), so a
 * nested call inside it executes synchronously and its writes
 * join the transaction, but its failure can surface only
 * through the returned promise — which a synchronous wrapped
 * call cannot await. A DO-leg wrapped call that needs a nested
 * failure to roll back the unit must let its own synchronous
 * throw carry it; nested-failure propagation by await is a
 * D1-leg (and any future async-leg) property. A nested call
 * naming a DIFFERENT backend is a cross-store unit, which the
 * contract does not claim: it is refused with TX_CANNOT_HONOUR
 * rather than silently split.
 *
 * PROOF STATUS (issue #2288): this module is exercised only by
 * the proof pins in tests/transaction_proof_2288.test.ts. No
 * production surface consumes it yet; D-I step 1 is the first
 * planned consumer.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DataFoundationCode,
  DataFoundationError,
} from "./errorCodes";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "aspects/transactionAspect",
});

/** Context for one wrapped call (mirrors loggingAspect's AspectContext shape). */
export interface TransactionContext {
  operationName: string;
  domain?: string;
  /** Outcome sink (audit/trace wiring lands with D-F2 publication). */
  emit?: (outcome: TransactionOutcome) => void;
}

/** One catalog-emitted transaction outcome. */
export interface TransactionOutcome {
  code: DataFoundationCode;
  operationName: string;
  domain?: string;
  durationMs: number;
}

export type TransactionBackendKind = "do-sql" | "d1-batch";

/**
 * The write surface a wrapped call sees. `exec` is deliberately
 * void: on the D1 leg a statement's result does not exist until
 * the batch applies, so the shared contract covers WRITES only.
 * A flow that must read-then-write reads before opening the
 * unit, or uses the DO leg's interactive store outside a unit.
 */
export interface TransactionUnit {
  readonly backendKind: TransactionBackendKind;
  exec(query: string, ...params: unknown[]): void;
}

/** A store leg that can run one atomic unit. */
export interface TransactionBackend {
  readonly kind: TransactionBackendKind;
  createUnit(): TransactionUnit;
  execute<T>(
    unit: TransactionUnit,
    fn: (unit: TransactionUnit) => T | Promise<T>,
  ): Promise<T>;
}

interface AmbientUnit {
  backend: TransactionBackend;
  unit: TransactionUnit;
}

const ambientUnit = new AsyncLocalStorage<AmbientUnit>();

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function emitOutcome(
  context: TransactionContext,
  code: DataFoundationCode,
  startedAtMs: number,
): void {
  const outcome: TransactionOutcome = {
    code,
    operationName: context.operationName,
    domain: context.domain,
    durationMs: Date.now() - startedAtMs,
  };
  if (context.emit) {
    try {
      context.emit(outcome);
    } catch (err) {
      // Emission must never break the unit it describes.
      structuredLog.error("aspect.tx_outcome_emission_failed", {
        message: "[Aspect][tx] outcome emission failed",
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.slice(0, 1000) : undefined,
      });
    }
    return;
  }
  structuredLog.info("aspect.tx_outcome", {
    message: `[Aspect][tx:${context.operationName}] ${code} in ${outcome.durationMs}ms`,
    operationName: context.operationName,
    code,
    durationMs: outcome.durationMs,
  });
}

/**
 * Wrap a call as one unit of work on `backend`. See the module
 * header for the contract, the two legs' shapes, and the nested
 * join rule.
 */
export async function withTransaction<T>(
  backend: TransactionBackend,
  context: TransactionContext,
  fn: (unit: TransactionUnit) => T | Promise<T>,
): Promise<T> {
  const ambient = ambientUnit.getStore();
  if (ambient) {
    if (ambient.backend !== backend) {
      throw new DataFoundationError(
        DataFoundationCode.TX_CANNOT_HONOUR,
        `Nested transaction names a different backend (${backend.kind}) inside an ambient ${ambient.unit.backendKind} unit; cross-store units are not claimed by the contract.`,
      );
    }
    // Join the ambient unit: no outcome at this level; a throw
    // propagates to the outermost unit and rolls back all of it.
    return fn(ambient.unit);
  }

  const startedAtMs = Date.now();
  const unit = backend.createUnit();
  return ambientUnit.run({ backend, unit }, async () => {
    try {
      const result = await backend.execute(unit, fn);
      emitOutcome(context, DataFoundationCode.TX_COMMITTED, startedAtMs);
      return result;
    } catch (err) {
      if (
        err instanceof DataFoundationError &&
        err.code === DataFoundationCode.TX_CANNOT_HONOUR
      ) {
        emitOutcome(context, DataFoundationCode.TX_CANNOT_HONOUR, startedAtMs);
      } else {
        emitOutcome(context, DataFoundationCode.TX_ROLLED_BACK, startedAtMs);
      }
      throw err;
    }
  });
}

/* ------------------------------------------------------------------ */
/* DO leg — storage.transactionSync                                    */
/* ------------------------------------------------------------------ */

/**
 * Structural shape of the DO storage surface the leg needs —
 * the real DurableObjectStorage shape, as observed under
 * workerd by #2348 (divergence D-1): `transactionSync` invokes
 * its closure with NO argument, and the storage's own `sql`
 * handle, used inside the closure, is the transaction-scoped
 * handle. (Step 0 modelled a `txn` argument carrying sql; the
 * real facade has no such argument — see #2455.)
 */
export interface DoTransactionStorage {
  sql: {
    exec(query: string, ...params: unknown[]): unknown;
  };
  transactionSync?: <T>(closure: () => T) => T;
}

class DoSqlUnit implements TransactionUnit {
  readonly backendKind = "do-sql" as const;
  private handle: {
    exec(query: string, ...params: unknown[]): unknown;
  } | null = null;

  open(handle: { exec(query: string, ...params: unknown[]): unknown }): void {
    this.handle = handle;
  }

  close(): void {
    this.handle = null;
  }

  exec(query: string, ...params: unknown[]): void {
    if (!this.handle) {
      throw new DataFoundationError(
        DataFoundationCode.TX_CANNOT_HONOUR,
        "DO transaction unit used outside its transactionSync closure.",
      );
    }
    this.handle.exec(query, ...params);
  }
}

export class DoSqlTransactionBackend implements TransactionBackend {
  readonly kind = "do-sql" as const;

  constructor(private readonly storage: DoTransactionStorage) {}

  createUnit(): TransactionUnit {
    return new DoSqlUnit();
  }

  async execute<T>(
    unit: TransactionUnit,
    fn: (unit: TransactionUnit) => T | Promise<T>,
  ): Promise<T> {
    const sqlUnit = unit as DoSqlUnit;
    if (typeof this.storage.transactionSync !== "function") {
      throw new DataFoundationError(
        DataFoundationCode.TX_CANNOT_HONOUR,
        "DO storage exposes no transactionSync primitive; the unit was refused before any write ran.",
      );
    }
    const sql = this.storage.sql;
    if (!sql || typeof sql.exec !== "function") {
      throw new DataFoundationError(
        DataFoundationCode.TX_CANNOT_HONOUR,
        "DO storage exposes no sql surface; the unit was refused before any write ran.",
      );
    }
    let result!: T;
    let closureRan = false;
    // transactionSync executes the closure synchronously and
    // rolls back if it throws — including the cannot-honour
    // throw for an async wrapped call below. The facade invokes
    // the closure with no argument (#2348 D-1): the unit is
    // opened on the storage's own sql, which inside the closure
    // is the transaction-scoped handle.
    try {
      this.storage.transactionSync(() => {
        closureRan = true;
        sqlUnit.open(sql);
        try {
          const value = fn(sqlUnit);
          if (isThenable(value)) {
            throw new DataFoundationError(
              DataFoundationCode.TX_CANNOT_HONOUR,
              "The wrapped call returned a promise on the DO leg; transactionSync closures must be synchronous, so the unit was rolled back and refused.",
            );
          }
          result = value;
        } finally {
          sqlUnit.close();
        }
      });
    } catch (err) {
      if (!closureRan && !(err instanceof DataFoundationError)) {
        // The primitive itself failed before the closure ran —
        // a transactionSync that throws without ever invoking
        // the unit. No write ran, so this is a refusal, not a
        // rollback: surface the typed catalog error rather than
        // the primitive's bare error. (A catalog error thrown by
        // the primitive, and any error thrown from inside the
        // closure, propagate unchanged.)
        throw new DataFoundationError(
          DataFoundationCode.TX_CANNOT_HONOUR,
          `DO storage transactionSync failed before the unit's closure ran (${err instanceof Error ? err.message : String(err)}); the unit was refused before any write ran.`,
        );
      }
      throw err;
    }
    return result;
  }
}

/** Build the DO leg over a Durable Object storage object. */
export function doSqlTransactionBackend(
  storage: DoTransactionStorage,
): DoSqlTransactionBackend {
  return new DoSqlTransactionBackend(storage);
}

/* ------------------------------------------------------------------ */
/* D1 leg — batch()                                                    */
/* ------------------------------------------------------------------ */

/** Structural shape of the raw D1 client surface the leg needs. */
export interface D1BatchDatabase {
  prepare(query: string): { bind(...params: unknown[]): unknown };
  batch(statements: unknown[]): Promise<unknown[]>;
}

class D1BatchUnit implements TransactionUnit {
  readonly backendKind = "d1-batch" as const;
  readonly statements: unknown[] = [];

  constructor(private readonly d1: D1BatchDatabase) {}

  exec(query: string, ...params: unknown[]): void {
    this.statements.push(this.d1.prepare(query).bind(...params));
  }
}

export class D1BatchTransactionBackend implements TransactionBackend {
  readonly kind = "d1-batch" as const;

  constructor(private readonly d1: D1BatchDatabase) {}

  createUnit(): TransactionUnit {
    return new D1BatchUnit(this.d1);
  }

  async execute<T>(
    unit: TransactionUnit,
    fn: (unit: TransactionUnit) => T | Promise<T>,
  ): Promise<T> {
    const batchUnit = unit as D1BatchUnit;
    if (
      typeof this.d1.prepare !== "function" ||
      typeof this.d1.batch !== "function"
    ) {
      throw new DataFoundationError(
        DataFoundationCode.TX_CANNOT_HONOUR,
        "The D1 client exposes no batch() primitive; the unit was refused before any write ran.",
      );
    }
    // If fn throws, the buffered statements are discarded with
    // the unit — nothing was ever sent to the store. If batch()
    // itself throws, D1's batch contract is all-or-nothing, so
    // nothing was applied; the error propagates as the rollback.
    const result = await fn(batchUnit);
    if (batchUnit.statements.length > 0) {
      await this.d1.batch(batchUnit.statements);
    }
    return result;
  }
}

/** Build the D1 leg over a bound D1 database. */
export function d1BatchTransactionBackend(
  d1: D1BatchDatabase,
): D1BatchTransactionBackend {
  return new D1BatchTransactionBackend(d1);
}
