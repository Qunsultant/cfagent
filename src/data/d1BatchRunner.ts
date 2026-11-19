/**
 * Issue #5605 (G-2) — the D1 batch runner factory (server-only).
 *
 * The runner is the D1-leg counterpart of the aspect-backed
 * TransactionRunner (src/data/transactionRunner.ts, DO leg):
 * one unit of work over the D1 `batch()` primitive, opened by
 * the service or route that composes a multi-write pair across
 * two D1 ports. The ports' D1 adapters buffer their statements
 * into the ambient unit the runner opens (through the
 * client-safe `bufferD1Statement` seam in
 * transactionRunnerProvider.ts, registered here — the adapters
 * must never import the aspect themselves, #2303 lesson); the
 * batch applies them atomically, or a throw discards the
 * buffer and nothing was ever sent.
 *
 * SERVER-ONLY module: it imports the transaction aspect
 * (node:async_hooks). Routes construct the runner from the
 * same bound D1 client the adapters use and pass it into the
 * services that need it; a service constructed without one
 * runs its writes sequentially, exactly as before.
 */
import {
  bufferInAmbientUnit,
  d1BatchTransactionBackend,
  withTransaction,
  type D1BatchDatabase,
  type TransactionContext,
} from "../aspects/transactionAspect";
import type { D1BatchRunner } from "./transactionRunnerProvider";
import { registerD1BatchBuffer } from "./transactionRunnerProvider";

/**
 * The one delegate the client-safe buffer seam calls: ask the
 * aspect whether an ambient `d1-batch` unit is open and buffer
 * into it. Defined once at module level so registration is
 * idempotent across runner constructions.
 */
const ambientBufferDelegate = (query: string, ...params: unknown[]): boolean =>
  bufferInAmbientUnit(query, ...params);

/** Build the D1 batch runner over a bound D1 database. */
export function createD1BatchRunner(d1: D1BatchDatabase): D1BatchRunner {
  // Issue #5605 (G-2): installing the buffer delegate is what
  // lets the D1 adapters buffer through the client-safe seam
  // (bufferD1Statement in transactionRunnerProvider) without
  // importing the server-only aspect themselves. The delegate
  // checks the aspect's ambient store at call time, so a unit
  // must still be open for anything to buffer — construction
  // alone never reroutes a statement.
  registerD1BatchBuffer(ambientBufferDelegate);
  return {
    runInBatch<T>(
      context: TransactionContext,
      fn: () => T | Promise<T>,
    ): Promise<T> {
      return withTransaction(d1BatchTransactionBackend(d1), context, () => fn());
    },
  };
}
