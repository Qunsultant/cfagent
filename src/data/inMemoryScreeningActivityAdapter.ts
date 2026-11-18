/**
 * Issue #2356 (#1976 step 4c) — the in-memory implementation
 * of the screening-activity port, with semantics identical
 * to the DO-SQLite adapter (never-throws record/list, tenant
 * scoping, newest-first, corrupt detail reads as { raw } —
 * the in-memory store keeps detail verbatim, so the corrupt
 * case is DO-only). The promotion read-through has no
 * in-memory source (the promotions table is step 4b's DO
 * family) and reads empty.
 */
import type {
  PromotionFeedRow,
  RecordScreeningActivityInput,
  ScreeningActivityEntry,
  ScreeningActivityStore,
} from "./screeningActivityPorts";

import {
  createStructuredLogger,
  type StructuredLogger,
} from "../observability/structuredLogger";
import {
  ConsoleObservabilitySink,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

function activityId(): string {
  return `sact_${
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  }`;
}

export class InMemoryScreeningActivityStore implements ScreeningActivityStore {
  private entries: ScreeningActivityEntry[] = [];
  // #3515 S3 batch 7 — optional sink injection (d1QueryLogger precedent);
  // env-constructed sink from the composition root when it holds env,
  // else the structured console fallback (never a `{}` sink, #5587).
  private readonly log: StructuredLogger;
  constructor(options?: { sink?: ObservabilitySink }) {
    this.log = createStructuredLogger(
      options?.sink ?? new ConsoleObservabilitySink(),
      { component: "data/inMemoryScreeningActivityAdapter" },
    );
  }

  ensureTable(): void {
    // In-memory: nothing to ensure.
  }

  record(input: RecordScreeningActivityInput): string | null {
    try {
      if (!input?.userLogin || !input?.kind || !input?.summary) return null;
      const id = activityId();
      this.entries.push({
        id,
        userLogin: input.userLogin,
        kind: input.kind,
        summary: input.summary,
        detail: input.detail === undefined ? null : structuredClone(input.detail),
        refId: input.refId ?? null,
        actor: input.actor ?? null,
        createdAt: input.createdAt ?? new Date().toISOString(),
      });
      return id;
    } catch (err) {
      this.log.error("inMemoryScreeningActivityAdapter.record_failed", {
        message: `[screeningActivity] record failed for ${input?.userLogin ?? "?"}: ${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err.message : String(err),
        userLogin: input?.userLogin ?? null,
        kind: input?.kind,
      });
      return null;
    }
  }

  list(userLogin: string, limit = 100): ScreeningActivityEntry[] {
    try {
      if (!userLogin) return [];
      const capped = Math.max(1, Math.min(Math.floor(limit) || 100, 500));
      return this.entries
        .filter((e) => e.userLogin === userLogin)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, capped)
        .map((e) => structuredClone(e));
    } catch (err) {
      this.log.error("inMemoryScreeningActivityAdapter.list_failed", {
        message: `[screeningActivity] list failed for ${userLogin}: ${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err.message : String(err),
        userLogin,
      });
      return [];
    }
  }

  listPromotionRows(): PromotionFeedRow[] {
    return [];
  }
}
