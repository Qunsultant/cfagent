/**
 * Issue #6298 (#6029 (a)) — the OODA run is reachable from a stored schedule.
 *
 * Why this pin exists: #6029's plan routes the stored schedule to
 * `runPipelineJobSchedule`. That callback lands on the ScheduledAgent door,
 * whose research deps are the fail-closed defaults
 * (`createDefaultResearchStepDeps` → `FAILURE_RESEARCH_DEPS_MISSING` at
 * analyze), so a scheduled OODA run would be a hollow one. The bridge is its
 * own callback that calls `runResearchAndPublish` — the same path a manual run
 * uses, and the one place the six stage deps are wired.
 *
 * Pinned here: the callback is creatable through the one schedule API, the
 * inventory mirror cannot drift from it, the ledger job id stays the one an
 * operator already reads (`nightly-research`), and the orchestrator exposes the
 * method that does the dispatch.
 */
import { describe, it, expect } from "vitest";
import {
  CREATABLE_SCHEDULE_CALLBACKS,
  ACCOUNT_SCOPED_SCHEDULE_CALLBACKS,
} from "../src/agents/orchestrator/scheduleCallbacks";
import { CREATABLE_SCHEDULE_CALLBACKS_INVENTORY } from "../src/services/scheduleSystems";
import { resolveScheduleRunJobId } from "../src/services/jobRunRecords";
import { NIGHTLY_RESEARCH_RECORD_ID } from "../src/services/researchScheduleGuard";
import { OrchestratorAgent } from "../src/agents/orchestrator";

describe("#6298 — the research schedule callback", () => {
  it("is creatable through the one schedule API, and the inventory mirror matches", () => {
    expect(CREATABLE_SCHEDULE_CALLBACKS).toContain("runResearchSchedule");
    // The mirror is test-pinned against the real list, in order.
    expect([...CREATABLE_SCHEDULE_CALLBACKS_INVENTORY]).toEqual([
      ...CREATABLE_SCHEDULE_CALLBACKS,
    ]);
  });

  it("is not account-scoped — the run resolves its venue from the tenant binding", () => {
    // A per-schedule broker tuple would be a second binding declaration; the
    // run resolves broker/mode through resolveResearchVenue and refuses an
    // unsupported pair by name (#6036). Same reasoning as runPipelineJobSchedule.
    expect(ACCOUNT_SCOPED_SCHEDULE_CALLBACKS.has("runResearchSchedule")).toBe(false);
  });

  it("keeps the run ledger join an operator already reads — the record id IS the join", () => {
    // `resolveScheduleRunJobId` stamps the schedule id on the run row, so the
    // OODA record must be created WITH the nightly id: that is what makes the
    // scheduled run join the ledger rows an operator already reads.
    expect(
      resolveScheduleRunJobId(
        "runResearchSchedule",
        { jobId: NIGHTLY_RESEARCH_RECORD_ID },
        { id: NIGHTLY_RESEARCH_RECORD_ID },
      ),
    ).toBe("nightly-research");
    // A schedule with no id never claims the nightly name: the fallback names
    // the callback instead of inventing an id.
    expect(resolveScheduleRunJobId("runResearchSchedule", {}, undefined)).toBe(
      "callback:runResearchSchedule",
    );
    expect(NIGHTLY_RESEARCH_RECORD_ID).toBe("nightly-research");
  });

  it("exposes the dispatch method on the orchestrator (the bridge to runResearchAndPublish)", () => {
    expect(typeof OrchestratorAgent.prototype.runResearchSchedule).toBe("function");
  });
});
