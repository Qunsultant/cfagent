/**
 * Issue #5605 (G-2) — the D1 batch runner factory (server-only).
 *
 * The runner is the D1-leg counterpart of the aspect-backed
 * TransactionRunner (src/data/transactionRunner.ts, DO leg):
 * one unit of work over the D1 `batch()` primitive, opened by
 * the service or route that composes a multi-write pair across
 * two D1 ports. The ports' D1 adapters buffer their statements
 * into the ambient unit the runner opens (bufferInAmbientUnit
 * in src/aspects/transactionAspect.ts); the batch applies them
 * atomically, or a throw discards the buffer and nothing was
 * ever sent.
 *
 * SERVER-ONLY module: it imports the transaction aspect
 * (node:async_hooks). Routes construct the runner from the
 * same bound D1 client the adapters use and pass it into the
 * services that need it; a service constructed without one
 * runs its writes sequentially, exactly as before.
 */
import {
  d1BatchTransactionBackend,
  withTransaction,
  type D1BatchDatabase,
  type TransactionContext,
} from "../aspects/transactionAspect";
import type { D1BatchRunner } from "./transactionRunnerProvider";

/** Build the D1 batch runner over a bound D1 database. */
export function createD1BatchRunner(d1: D1BatchDatabase): D1BatchRunner {
  return {
    runInBatch<T>(
      context: TransactionContext,
      fn: () => T | Promise<T>,
    ): Promise<T> {
      return withTransaction(d1BatchTransactionBackend(d1), context, () => fn());
    },
  };
}
