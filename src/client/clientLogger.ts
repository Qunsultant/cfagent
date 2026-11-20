/**
 * Issue #3515 S3 batch 10 — the sanctioned client-side logger.
 *
 * The browser has no Cloudflare env in scope, so no client module can
 * build an env-constructed sink — and the #5587 ruling (Venus
 * 2026-11-18) forbids new empty-env module loggers anywhere. This
 * factory is the one honest construction for client code: a structured
 * logger over the EXPLICIT console sink, so events emit as one
 * structured JSON line on `console.info` — the same shape the
 * server-side fallback emits, queryable by operation, level, and
 * fields instead of grepped text. When a composition root can pass an
 * env-constructed sink (the #5587 follow-up), this is the one place
 * to wire it.
 */
import { ConsoleObservabilitySink } from "../observability/observabilityPorts";
import {
  createStructuredLogger,
  type StructuredLogger,
} from "../observability/structuredLogger";

/** Build a module logger for one client component. */
export function createClientLogger(component: string): StructuredLogger {
  return createStructuredLogger(new ConsoleObservabilitySink(), { component });
}
