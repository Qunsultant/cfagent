/**
 * Issue #6003 — the Autopilot outcome rows folded into the one ledger.
 *
 * Pins:
 *  - 6003-P01 attachment by linkage: an outcome row whose id a ledger row
 *    already carries (asyncJobId / workflowId / jobId) is the same run —
 *    the ledger row wins and no second row appears. A folded workflow or
 *    report row counts as a ledger row for this purpose.
 *  - 6003-P02 a twin-less outcome row becomes one ledger row stamped
 *    `system: "autopilot-jobs"` and `ledgerKind: "autopilot"` — including
 *    the kinds with no `/api/runs` twin (corpus-sync, reports-index-backfill,
 *    trading-order, feed). Nothing Autopilot shows today is dropped.
 *  - 6003-P03 the status → outcome mapping is honest: completed success,
 *    failed/partial failure, with the coded error carried when recorded
 *    and no invented text when it is not.
 *  - 6003-P04 the attached row classifies as "autopilot" and counts under
 *    it; the operation it carries never guesses another family.
 *  - 6003-P05 the same outcome row is never listed twice, and a row with
 *    no id mints no ledger row.
 */
import { describe, it, expect } from "vitest";
import {
  attachAutopilotOutcomes,
  AUTOPILOT_JOBS_LEDGER_SYSTEM,
} from "../src/client/runLedgerAutopilotOutcomes";
import { classifyRunKind, countRunsByKind } from "../src/services/runLedgerKinds";
import type { JobOutcomeRow } from "../src/data/jobOutcomePorts";
import type { JobRunRecord } from "../src/data/jobRunRecordPorts";

function outcome(overrides: Partial<JobOutcomeRow> = {}): JobOutcomeRow {
  return {
    id: "screener:2026-11-21T10:00:00.000Z",
    kind: "stock",
    trigger: "scheduled",
    status: "completed",
    scanned: 120,
    matched: 3,
    codedError: null,
    reportUrl: null,
    pdfKey: null,
    xlsxKey: null,
    csvKey: null,
    deliveryStates: {},
    origin: "job-tree",
    createdAt: "2026-11-21T10:00:00.000Z",
    ...(overrides as object),
  } as JobOutcomeRow;
}

function ledgerRow(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    system: "orchestrator-schedule",
    jobId: "sched-1",
    operation: "trading.screen_stocks",
    started: "2026-11-21T09:00:00.000Z",
    finished: "2026-11-21T09:01:00.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    trigger: "scheduled",
    ...(overrides as object),
  } as JobRunRecord;
}

describe("6003-P01 linkage attachment", () => {
  it("drops an outcome row the ledger already carries by asyncJobId", () => {
    const entries = attachAutopilotOutcomes(
      [ledgerRow({ asyncJobId: "screener:2026-11-21T10:00:00.000Z" })],
      [outcome()],
    );
    expect(entries).toHaveLength(0);
  });

  it("drops it by workflowId or jobId too", () => {
    const id = "screener:2026-11-21T10:00:00.000Z";
    expect(
      attachAutopilotOutcomes([ledgerRow({ workflowId: id })], [outcome()]),
    ).toHaveLength(0);
    expect(attachAutopilotOutcomes([ledgerRow({ jobId: id })], [outcome()])).toHaveLength(0);
  });

  it("drops it when a folded report row already carries the run", () => {
    const reportRow = ledgerRow({
      jobId: "options:2026-11-21T10:00:00.000Z",
      operation: "report.generate",
    });
    const entries = attachAutopilotOutcomes(
      [reportRow],
      [outcome({ id: "options:2026-11-21T10:00:00.000Z", kind: "options" })],
    );
    expect(entries).toHaveLength(0);
  });

  it("keeps an outcome row with no ledger twin", () => {
    const entries = attachAutopilotOutcomes([ledgerRow()], [outcome()]);
    expect(entries).toHaveLength(1);
    expect(entries[0].row.jobId).toBe("screener:2026-11-21T10:00:00.000Z");
    expect(entries[0].row.system).toBe(AUTOPILOT_JOBS_LEDGER_SYSTEM);
    expect(entries[0].outcome).toBeDefined();
  });
});

describe("6003-P02 twin-less kinds are included, not dropped", () => {
  it("attaches corpus, reports, trading, and feed outcome rows", () => {
    const jobs = [
      outcome({ id: "corpus-sync:2026-11-21T10:00:00.000Z", kind: "corpus", origin: "corpus-sync" }),
      outcome({
        id: "reports-index-backfill:2026-11-21T10:00:00.000Z",
        kind: "reports",
        origin: "reports-index-backfill",
      }),
      outcome({ id: "order:ord-1", kind: "trading", origin: "job-tree" }),
      outcome({ id: "feed:2026-11-21T10:00:00.000Z", kind: "feed", origin: "job-tree" }),
    ];
    const entries = attachAutopilotOutcomes([], jobs);
    expect(entries.map((e) => e.row.jobId)).toEqual([
      "corpus-sync:2026-11-21T10:00:00.000Z",
      "reports-index-backfill:2026-11-21T10:00:00.000Z",
      "order:ord-1",
      "feed:2026-11-21T10:00:00.000Z",
    ]);
    for (const entry of entries) {
      expect(entry.row.ledgerKind).toBe("autopilot");
      expect(entry.row.system).toBe(AUTOPILOT_JOBS_LEDGER_SYSTEM);
    }
  });

  it("stamps the operation under the autopilot namespace, never a family", () => {
    const entries = attachAutopilotOutcomes(
      [],
      [outcome({ id: "corpus-sync:2026-11-21T10:00:00.000Z", kind: "corpus" })],
    );
    expect(entries[0].row.operation).toBe("autopilot.corpus");
    // The stamp, not the operation, is the classification: without it the
    // namespaced operation falls to "other", never a guessed family.
    expect(classifyRunKind({ operation: entries[0].row.operation })).toBe("other");
    expect(classifyRunKind(entries[0].row)).toBe("autopilot");
  });
});

describe("6003-P03 honest status mapping", () => {
  it("maps the recorded status without inventing one", () => {
    const row = (status: JobOutcomeRow["status"], extra: Partial<JobOutcomeRow> = {}) =>
      attachAutopilotOutcomes([], [outcome({ status, ...extra })])[0].row;
    expect(row("completed").outcome).toBe("success");
    expect(row("failed").outcome).toBe("failure");
    expect(row("partial").outcome).toBe("failure");
  });

  it("carries a recorded coded error and invents none", () => {
    const failed = attachAutopilotOutcomes(
      [],
      [outcome({ status: "failed", codedError: "FAILURE_SCREEN_RUN_FAILED" })],
    )[0].row;
    expect(failed.error).toBe("FAILURE_SCREEN_RUN_FAILED");
    const failedNoCode = attachAutopilotOutcomes([], [outcome({ status: "failed" })])[0].row;
    expect(failedNoCode.outcome).toBe("failure");
    expect(failedNoCode.error).toBeUndefined();
  });

  it("summarises the counts Autopilot renders, with the producer", () => {
    const row = attachAutopilotOutcomes([], [outcome({ scanned: 120, matched: 3 })])[0].row;
    expect(row.descriptor).toBe("120 scanned, 3 matched via job-tree");
    const noCounts = attachAutopilotOutcomes(
      [],
      [outcome({ scanned: null, matched: null, kind: "goal", origin: "goal-screen-direct" })],
    )[0].row;
    expect(noCounts.descriptor).toBe("Autopilot goal run via goal-screen-direct");
  });

  it("carries no invented linkage: schedule, async job, and workflow stay null", () => {
    const row = attachAutopilotOutcomes([], [outcome()])[0].row;
    expect(row.scheduleId).toBeNull();
    expect(row.asyncJobId).toBeNull();
    expect(row.workflowId).toBeNull();
    expect(row.triggeredBy).toBe("scheduled");
  });
});

describe("6003-P04 classification and counts", () => {
  it("counts attached rows under autopilot", () => {
    const entries = attachAutopilotOutcomes(
      [],
      [
        outcome({ id: "corpus-sync:2026-11-21T10:00:00.000Z", kind: "corpus" }),
        outcome({ id: "order:ord-1", kind: "trading" }),
      ],
    );
    const counts = countRunsByKind(entries.map((e) => e.row));
    expect(counts.autopilot).toBe(2);
    expect(counts.other).toBe(0);
  });
});

describe("6003-P05 no duplicates, no id-less rows", () => {
  it("never lists the same outcome row twice", () => {
    const entries = attachAutopilotOutcomes([], [outcome(), outcome()]);
    expect(entries).toHaveLength(1);
  });

  it("mints no ledger row from an outcome with no id", () => {
    const entries = attachAutopilotOutcomes([], [outcome({ id: "   " })]);
    expect(entries).toHaveLength(0);
  });
});
