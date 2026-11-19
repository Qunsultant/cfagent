/**
 * src/data/transactionRunnerProvider.ts — #2337 (#1976 step 2):
 * the registered transaction runner.
 *
 * Why this exists (the step-1 lesson, #2303): the options/
 * discovery adapters live behind modules reachable from the
 * CLIENT bundle through the trading barrel, and the
 * transaction aspect's module graph (node:async_hooks) is
 * server-only — a static OR dynamic import of it from those
 * modules breaks the client build. So the aspect-backed
 * runner is registered once by the worker entry (src/server
 * .ts, the server composition root) and the adapters resolve
 * it through here.
 *
 * Absence discipline (same as the step-1 provider): an
 * unregistered context (tests that do not register, the
 * client bundle) resolves to NO runner, and an adapter
 * constructed with a transaction-capable storage object then
 * applies its units sequentially — exactly the legacy
 * behaviour. Registration is what turns the wraps on; the
 * conformance suite registers the runner explicitly to pin
 * the wrapped semantics.
 *
 * This module imports TYPES only and is client-safe.
 */
import type {
  DoTransactionStorage,
  TransactionContext,
} from "../aspects/transactionAspect";

/**
 * The transaction seam the step-2 adapters consume. `run` is
 * the async surface (withTransaction over the DO backend);
 * `runSyncUnit` is for the one synchronous surface (the feed
 * store): it executes the closure synchronously inside
 * transactionSync and rethrows a unit failure synchronously,
 * preserving that surface's throw contract.
 */
export interface TransactionRunner {
  run<T>(
    storage: DoTransactionStorage,
    context: TransactionContext,
    fn: () => T | Promise<T>,
  ): Promise<T>;
  runSyncUnit<T>(
    storage: DoTransactionStorage,
    context: TransactionContext,
    fn: () => T,
  ): T;
}

/**
 * Issue #5605 (G-2) — the D1 batch runner seam, the D1-leg
 * counterpart of TransactionRunner. A service that composes a
 * multi-write pair across two D1 ports opens one unit through
 * this runner; the ports' D1 adapters buffer their statements
 * into the ambient unit (see bufferInAmbientUnit in the
 * aspect). The runner is created from the same bound D1
 * client the adapters use (src/data/d1BatchRunner.ts); a
 * service constructed without one runs its writes
 * sequentially, exactly as before — the same absence
 * discipline as the DO runner above. The runner carries no
 * store client and no Drizzle import, so this module stays
 * client-safe: only the server-only factory imports the
 * aspect.
 */
export interface D1BatchRunner {
  runInBatch<T>(
    context: TransactionContext,
    fn: () => T | Promise<T>,
  ): Promise<T>;
}

let registeredRunner: TransactionRunner | null = null;

/** Register the production runner (server entry only). */
export function registerTransactionRunner(runner: TransactionRunner): void {
  registeredRunner = runner;
}

/** The registered runner, or null when unregistered. */
export function getTransactionRunner(): TransactionRunner | null {
  return registeredRunner;
}
