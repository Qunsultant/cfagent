/**
 * Issue #3185 (bridge slice) — the write-site hook for the
 * usage-events projection (the run-ledger projection hooks are deleted with #6101;
 * projectAsyncJobBestEffort, minus the carrier gate: the mirror
 * has no per-tenant carrier config — see
 * usageEventProjectionPosting).
 *
 * Never throws: a hook failure must never fail the DO write, the
 * submission, or the run (ADR 0002 / #1546). Every failure is
 * logged by name; the reconcile sweep is the backstop for a row
 * whose live projection missed it.
 *
 * The hook projects the row in hand — it does NOT re-read the
 * stored row. The DO insert just landed (or was a duplicate
 * retry, in which case the mirror's INSERT OR IGNORE makes the
 * re-projection a no-op), so the in-hand row IS what landed.
 */
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { postUsageEventBestEffort, type PostUsageEventResult } from "./usageEventProjectionPosting";
import type { UsageEventProjectionInput } from "../data/usageEventProjection";
import type { Env } from "../types";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/usageEventProjectionHooks",
});

/**
 * Project one meter row that just landed. Returns the ORM post
 * result — including the named "unbound" skip when AGENT_DB is
 * not bound — or null only when the hook itself throws (which
 * it never does for a projection failure: the post catches
 * those). The synchronous recordUsageEvent sites (research
 * run/evaluation rows, which carry no env) do NOT call this
 * hook — the reconcile sweep projects them.
 */
export async function projectUsageEventBestEffort(args: {
  env: Partial<Env> | undefined | null;
  row: UsageEventProjectionInput;
  nowMs?: number;
}): Promise<PostUsageEventResult | null> {
  try {
    return await postUsageEventBestEffort(args.env, args.row, args.nowMs ?? Date.now());
  } catch (err) {
    // Never fails the write; the hook logs its own failures.
    structuredLog.error("usageEvent.hook_failed", {
      message: `[usage-event] projection hook failed for ${args.row.id}; DO write unaffected, sweep backstops.`,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
