/**
 * The string-valued entries of a Worker env, as a plain record.
 *
 * Issue #4782 S3 — this was three identical 5-line loops (the
 * scheduled host, the workflow residency, the async-job feed
 * resolver), each the resolver's knob source. One implementation
 * behind a stable interface: an operator's env tuning must read
 * the same way everywhere it is resolved from.
 *
 * Non-string bindings (D1, R2, DO namespaces, workflow
 * bindings) are not env knobs and are dropped, never stringified.
 */
import type { Env } from "../types";

export function envStrings(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
