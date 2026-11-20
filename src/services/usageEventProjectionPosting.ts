/**
 * Issue #3185 (bridge slice) — best-effort D1 post for the
 * usage-events projection (the ORM carrier's write helper,
 * mirroring postRunLedgerBestEffort).
 *
 * The DO table stays authoritative; D1 is the projection. A post
 * failure must NEVER fail the DO write, the submission, or the
 * run: this helper catches every projection error, logs it loudly,
 * and resolves. Callers pass the DO row; the helper is
 * flag-agnostic — unlike the run ledger, the usage projection has
 * no per-tenant carrier config: the mirror is the tenant reader,
 * so a tenant that never configures carriers still gets its rows
 * projected (the carrier table gates the run ledger only).
 *
 * "posted" means the D1 row is current after this call — a fresh
 * projection OR an already-current row both count. Only unbound
 * AGENT_DB and store errors report posted:false.
 */
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import {
  createUsageEventMirrorAdapter,
  ensureUsageEventMirrorTables,
} from "../data/createUsageEventMirrorPorts";
import {
  createUsageEventProjector,
  type ProjectUsageEventResult,
  type UsageEventProjectionInput,
} from "../data/usageEventProjection";
import type { Env } from "../types";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/usageEventProjectionPosting",
});

export interface PostUsageEventResult extends ProjectUsageEventResult {
  posted: boolean;
}

export async function postUsageEventBestEffort(
  env: Partial<Env> | undefined | null,
  input: UsageEventProjectionInput,
  nowMs: number,
): Promise<PostUsageEventResult> {
  const adapter = createUsageEventMirrorAdapter(env);
  const d1 = (env as { AGENT_DB?: unknown } | undefined | null)?.AGENT_DB;
  if (!adapter || !d1) {
    structuredLog.error("usageEvent.post_skipped", {
      message: "[usage-event] projection post skipped (AGENT_DB unbound); DO write unaffected.",
    });
    return { posted: false, projected: false, skipped: "unbound" };
  }
  try {
    await ensureUsageEventMirrorTables(adapter);
    const projector = createUsageEventProjector({ mirror: adapter });
    const result = await projector.projectUsageEvent(input, nowMs);
    return {
      ...result,
      posted: result.projected || result.skipped === "already-current",
    };
  } catch (err) {
    structuredLog.error("usageEvent.post_failed", {
      message: "[usage-event] projection post failed — DO write unaffected",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      posted: false,
      projected: false,
      skipped: err instanceof Error ? err.message : String(err),
    };
  }
}
