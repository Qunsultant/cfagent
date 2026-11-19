/**
 * Issue #1548 ([AGENTIC] Slice 0) — in-memory governance store.
 *
 * A test double with the same port semantics as the D1 adapter:
 * the port/dialect suite runs unchanged against both. It is NOT a
 * production store and NOT a second source of truth — it exists so
 * the port contract is testable without any store at all, and so
 * the dialect suite can prove a behavior is adapter-independent.
 * No migration concept applies here (there is no SQL to migrate).
 */
import type {
  GovernanceHaltRow,
  GovernanceStore,
  HaltReadOptions,
} from "./governancePorts";

import {
  createStructuredLogger,
  type StructuredLogger,
} from "../observability/structuredLogger";
import {
  ConsoleObservabilitySink,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

export class InMemoryGovernanceAdapter implements GovernanceStore {
  private rows: GovernanceHaltRow[] = [];
  // #3515 S3 batch 7 — optional sink injection (d1QueryLogger precedent);
  // env-constructed sink from the composition root when it holds env,
  // else the structured console fallback (never a `{}` sink, #5587).
  private readonly log: StructuredLogger;
  constructor(options?: { sink?: ObservabilitySink }) {
    this.log = createStructuredLogger(
      options?.sink ?? new ConsoleObservabilitySink(),
      { component: "data/inMemoryGovernanceAdapter" },
    );
  }

  async recordHalt(row: GovernanceHaltRow): Promise<void> {
    if (this.rows.some((r) => r.eventId === row.eventId)) return;
    this.rows.push({ ...row });
  }

  async latestHalt(
    tenantId: string,
    opts: HaltReadOptions = {},
  ): Promise<GovernanceHaltRow | null> {
    const scope = opts.scope ?? "global";
    const scopeId = opts.scopeId ?? null;
    const matches = this.rows.filter(
      (r) =>
        r.tenantId === tenantId &&
        r.scope === scope &&
        r.scopeId === scopeId,
    );
    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      if (a.setAtMs !== b.setAtMs) return b.setAtMs - a.setAtMs;
      return a.eventId < b.eventId ? 1 : a.eventId > b.eventId ? -1 : 0;
    });
    return { ...matches[0] };
  }

  async isHalted(
    tenantId: string,
    opts: HaltReadOptions = {},
  ): Promise<boolean> {
    try {
      const latest = await this.latestHalt(tenantId, opts);
      return latest !== null && latest.state === "halted";
    } catch (err) {
      this.log.error("inMemoryGovernanceAdapter.halt_read_failed", {
        message: "[data-foundation] Governance halt read failed; failing closed:",
        error: err instanceof Error ? err.message : String(err),
        tenantId,
      });
      return true;
    }
  }
}
