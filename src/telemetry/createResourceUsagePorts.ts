/**
 * ResourceUsagePort composition root (issue #1819).
 *
 * Precedence is durability-first, and it returns null — never a sink that
 * silently drops data — when no durable sink is bound:
 *   1. OBSERVABILITY bound → #1743's Analytics Engine stream (production).
 *   2. AGENT_DB bound → D1 `resource_sql_ops` table (also bound in
 *      production wrangler config; the fallback when AE is unavailable).
 *   3. Neither bound → null. Callers then rely on the store_op v2 log lines
 *      alone (Workers Logs), which carry rows by ns/op even with no sink.
 *
 * Deliberately NOT in this root: the in-memory adapter. A per-isolate array
 * is a test double, not a measurement store; constructing one per request
 * would look like instrumentation while measuring nothing.
 *
 * Projection fan-out (#1819 rollup slice): with `withProjection: true`
 * and BOTH bindings present, the port fans out to AE and D1, because the
 * ScheduledAgent rollup/alert/comparison goals can only query the D1
 * projection from inside the Worker (there is no in-Worker Analytics
 * Engine read path). Cost, stated plainly: fan-out adds one D1 INSERT
 * per store op. At the measurement slice's plausible single-tab volume
 * (~30k ops/day) that fits the 100k D1 writes/day free cap with headroom
 * shared with all other app D1 writes; aggressive/multi-tab volumes can
 * exceed it — in which case the D1 adapter degrades best-effort (warns,
 * op unaffected), so measurement degrades but the app does not. Rollup
 * op counts make a dead projection visible (ops ≈ 0 while store_op v2
 * log volume is high), rather than silently certifying zero usage.
 */
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import {
  createD1ResourceDb,
  D1ResourceUsageAdapter,
} from "./d1ResourceUsageAdapter";
import { FanOutResourceUsageAdapter } from "./fanOutResourceUsageAdapter";
import { ObservabilityResourceUsageAdapter } from "./resourceUsageObservabilityAdapter";
import type { ResourceUsagePort } from "./resourceUsagePorts";

export function createResourceUsagePort(
  env: {
    OBSERVABILITY?: unknown;
    AGENT_DB?: D1Database | null;
  },
  opts?: { withProjection?: boolean }
): ResourceUsagePort | null {
  const ae = env.OBSERVABILITY
    ? new ObservabilityResourceUsageAdapter(createObservabilitySink(env))
    : null;
  const d1 = env.AGENT_DB
    ? new D1ResourceUsageAdapter(createD1ResourceDb(env.AGENT_DB))
    : null;
  if (opts?.withProjection && ae && d1) {
    return new FanOutResourceUsageAdapter([ae, d1]);
  }
  return ae ?? d1;
}
