/** @vitest-environment jsdom */
/**
 * Issue #3650 — ledger rows render Job "undefined" as a clickable
 * button (jobId missing). Parent program #3121.
 *
 * RCA (recorded on #3650 and in the PR body):
 * - Render: the Job column in ScheduleRunLedgerPanel renders `r.jobId`
 *   inside a clickable Button with NO missing-id guard, unlike the
 *   Async-job column, which renders "—" for a null id. Any row whose
 *   jobId is missing — or the literal string "undefined" — renders a
 *   clickable "undefined" button, and clicking it navigates to
 *   `run=undefined` (URLSearchParams coerces the value verbatim).
 * - Builder: buildJobRunRecord rejects an empty jobId but accepts the
 *   literal strings "undefined"/"null" as non-empty ids, so a
 *   stringified-missing id passes the honesty gate.
 * - Read: the DO-SQLite adapter's rowToRecord does
 *   `jobId: String(row.job_id)` — the one String() coercion on the
 *   ledger read path, so a row whose job_id is missing at read time
 *   becomes the literal string "undefined"; normalizeJobRunRecord
 *   never touched jobId, so the literal reached the UI.
 * - Write paths on current main all stamp real ids
 *   (resolveScheduleRunJobId falls back to `callback:<name>`, goal
 *   runs use goal.id, pipeline runs use instance.jobId), so no
 *   current write path can emit a jobless row — the production
 *   "undefined" rows are legacy / read-coerced, and the fix closes
 *   every layer so no new row can carry the literal.
 *
 * Coverage:
 * - 3650-P01 Job cell: a missing / empty / literal-"undefined" /
 *   literal-"null" jobId renders "—" with no clickable element —
 *   never a button labeled "undefined".
 * - 3650-P02 Deep link: clicking a real job id navigates to
 *   run=<that id>; no run=undefined navigation exists (no button
 *   carries the poisoned label).
 * - 3650-P03 Cell helpers: ledgerLinkageCell / ledgerLinkageTitle
 *   treat the poisoned literals as missing, like null.
 * - 3650-P04 Builder: buildJobRunRecord rejects a literal
 *   "undefined"/"null" jobId and linkage id.
 * - 3650-P05 Read normalizer: normalizeJobRunRecord maps a literal
 *   "undefined"/"null" (or missing) jobId to missing, and
 *   normalizeLedgerLinkage maps poisoned linkage ids to null; real
 *   ids pass through unchanged.
 * - 3650-P06 Resolver: resolveScheduleRunJobId never returns the
 *   literal "undefined" — a poisoned schedule id / payload id falls
 *   through to the `callback:<name>` fallback; buildLedgerLinkage
 *   maps a poisoned schedule id to null.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import {
  ScheduleRunLedgerPanel,
  ledgerLinkageCell,
  ledgerLinkageTitle,
} from "../src/client/ScheduleRunLedgerPanel";
import {
  buildJobRunRecord,
  normalizeJobRunRecord,
  resolveScheduleRunJobId,
  type JobRunRecord,
} from "../src/services/jobRunRecords";
import {
  buildLedgerLinkage,
  isMissingIdLiteral,
  normalizeLedgerLinkage,
} from "../src/services/consolidatedScheduling";

const REAL_RUN = {
  system: "orchestrator-schedule",
  jobId: "sched-1",
  operation: "autonomousMarketScreen",
  started: "2026-11-05T10:00:00.000Z",
  finished: "2026-11-05T10:01:00.000Z",
  outcome: "success",
  triggeredBy: "scheduled",
  trigger: "scheduled",
  scheduleId: "sched-1",
  asyncJobId: "job-1",
  workflowId: "wf-1",
  descriptor: "Scanned 400 symbols",
};

const POISONED_RUN = {
  system: "orchestrator-schedule",
  jobId: "undefined",
  operation: "autonomousMarketScreen",
  started: "2026-11-05T09:00:00.000Z",
  finished: "2026-11-05T09:01:00.000Z",
  outcome: "success",
  triggeredBy: "scheduled",
  trigger: "unknown",
  scheduleId: null,
  asyncJobId: null,
  workflowId: null,
};

const NULL_RUN = {
  system: "orchestrator-schedule",
  jobId: "null",
  operation: "autonomousMarketScreen",
  started: "2026-11-05T08:00:00.000Z",
  finished: "2026-11-05T08:01:00.000Z",
  outcome: "success",
  triggeredBy: "scheduled",
  trigger: "unknown",
  scheduleId: null,
  asyncJobId: null,
  workflowId: null,
};

const EMPTY_RUN = {
  system: "orchestrator-schedule",
  jobId: "",
  operation: "autonomousMarketScreen",
  started: "2026-11-05T07:00:00.000Z",
  finished: "2026-11-05T07:01:00.000Z",
  outcome: "success",
  triggeredBy: "scheduled",
  trigger: "unknown",
  scheduleId: null,
  asyncJobId: null,
  workflowId: null,
};

// A stored legacy row with no jobId key at all (JSON drops undefined).
const MISSING_RUN = {
  system: "scheduled-agent-goal",
  operation: "qa.run_sweep",
  started: "2026-11-05T06:00:00.000Z",
  finished: "2026-11-05T06:01:00.000Z",
  outcome: "success",
  triggeredBy: "scheduled",
} as unknown as JobRunRecord;

let container: HTMLDivElement;
let root: Root | null = null;

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

async function settle(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  window.history.pushState(null, "", "/?tab=schedules");
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  vi.unstubAllGlobals();
});

function fetchStub(
  handler: (url: string) => { status: number; body: unknown } | null,
) {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (input: unknown) => {
      const url = String(input);
      const hit = handler(url);
      if (!hit) throw new Error(`unexpected fetch: ${url}`);
      return new Response(JSON.stringify(hit.body), { status: hit.status });
    },
  );
}

function ledgerStub() {
  fetchStub((url) => {
    // The one merged read (#3123): the server merges both halves,
    // so the stub serves all five rows on the one endpoint, in
    // newest-first order (the panel renders them as received).
    if (url.includes("/api/ledger/runs")) {
      return {
        status: 200,
        body: { runs: [REAL_RUN, POISONED_RUN, NULL_RUN, EMPTY_RUN, MISSING_RUN] },
      };
    }
    return null;
  });
}

function buttonWithLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;
}

/** First <td> of every body row, in render order (newest first). */
function jobCells(): string[] {
  return Array.from(container.querySelectorAll("tbody tr")).map(
    (tr) => (tr.querySelector("td")?.textContent ?? "").trim(),
  );
}

describe("3650-P01 Job cell — a missing or poisoned jobId renders '—', never a button (#3650)", () => {
  it("renders '—' in the Job cell for 'undefined', 'null', empty, and missing jobIds", async () => {
    ledgerStub();
    await render(<ScheduleRunLedgerPanel />);
    await settle();
    // Newest first: sched-1, undefined, null, "", missing.
    expect(jobCells()).toEqual(["sched-1", "—", "—", "—", "—"]);
  });

  it("renders no button labeled 'undefined', 'null', or '—'", async () => {
    ledgerStub();
    await render(<ScheduleRunLedgerPanel />);
    await settle();
    expect(buttonWithLabel("undefined")).toBeUndefined();
    expect(buttonWithLabel("null")).toBeUndefined();
    const dashButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => (b.textContent ?? "").trim() === "—",
    );
    expect(dashButtons).toHaveLength(0);
    // Exactly one clickable job id exists: the real row's.
    expect(buttonWithLabel("sched-1")).toBeDefined();
  });
});

describe("3650-P02 Deep link — no run=undefined navigation exists (#3650)", () => {
  it("clicking the real job id navigates to run=<that id>, never run=undefined", async () => {
    ledgerStub();
    await render(<ScheduleRunLedgerPanel />);
    await settle();
    const jobButton = buttonWithLabel("sched-1");
    expect(jobButton).toBeDefined();
    await act(async () => {
      jobButton!.click();
    });
    await settle();
    expect(window.location.search).toContain("run=sched-1");
    expect(window.location.search).not.toContain("run=undefined");
  });
});

describe("3650-P03 Cell helpers — the poisoned literals read as missing (#3650)", () => {
  it("ledgerLinkageCell renders '—' for the literals, ledgerLinkageTitle 'not applicable'", () => {
    expect(isMissingIdLiteral("undefined")).toBe(true);
    expect(isMissingIdLiteral("null")).toBe(true);
    expect(isMissingIdLiteral("sched-1")).toBe(false);
    expect(isMissingIdLiteral(undefined)).toBe(false);
    expect(ledgerLinkageCell("undefined")).toBe("—");
    expect(ledgerLinkageCell("null")).toBe("—");
    expect(ledgerLinkageCell("")).toBe("—");
    expect(ledgerLinkageCell(null)).toBe("—");
    expect(ledgerLinkageCell(undefined)).toBe("—");
    expect(ledgerLinkageCell("sched-1")).toBe("sched-1");
    expect(ledgerLinkageTitle("undefined")).toBe("not applicable");
    expect(ledgerLinkageTitle("sched-1")).toBe("sched-1");
  });
});

describe("3650-P04 Builder — a literal 'undefined'/'null' id is rejected at write time (#3650)", () => {
  function validInput(overrides: Record<string, unknown> = {}) {
    return {
      system: "orchestrator-schedule",
      jobId: "sched-1",
      operation: "autonomousMarketScreen",
      started: "2026-11-03T00:00:00.000Z",
      finished: "2026-11-03T00:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
      ...overrides,
    } as Parameters<typeof buildJobRunRecord>[0];
  }

  it("rejects jobId 'undefined' and 'null'", () => {
    expect(() => buildJobRunRecord(validInput({ jobId: "undefined" }))).toThrow(/undefined/);
    expect(() => buildJobRunRecord(validInput({ jobId: "null" }))).toThrow(/null/);
  });

  it("rejects a poisoned linkage id", () => {
    expect(() =>
      buildJobRunRecord(validInput({ scheduleId: "undefined" })),
    ).toThrow(/scheduleId/);
    expect(() =>
      buildJobRunRecord(validInput({ asyncJobId: "undefined" })),
    ).toThrow(/asyncJobId/);
    expect(() =>
      buildJobRunRecord(validInput({ workflowId: "null" })),
    ).toThrow(/workflowId/);
  });

  it("still builds a record with real ids", () => {
    const record = buildJobRunRecord(
      validInput({ scheduleId: "sched-1", asyncJobId: "job-1" }),
    );
    expect(record.jobId).toBe("sched-1");
    expect(record.scheduleId).toBe("sched-1");
    expect(record.asyncJobId).toBe("job-1");
  });
});

describe("3650-P05 Read normalizer — legacy poisoned rows read as jobless (#3650)", () => {
  function storedRecord(overrides: Record<string, unknown> = {}): JobRunRecord {
    return {
      system: "orchestrator-schedule",
      jobId: "sched-1",
      operation: "autonomousMarketScreen",
      started: "2026-11-05T09:00:00.000Z",
      finished: "2026-11-05T09:01:00.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
      trigger: "unknown",
      scheduleId: null,
      asyncJobId: null,
      workflowId: null,
      ...overrides,
    } as JobRunRecord;
  }

  it("maps a literal 'undefined'/'null' jobId to missing", () => {
    expect(normalizeJobRunRecord(storedRecord({ jobId: "undefined" })).jobId).toBe("");
    expect(normalizeJobRunRecord(storedRecord({ jobId: "null" })).jobId).toBe("");
    expect(
      normalizeJobRunRecord(storedRecord({ jobId: undefined as unknown as string })).jobId,
    ).toBe("");
  });

  it("maps poisoned linkage ids to null and keeps real ids", () => {
    const record = normalizeJobRunRecord(
      storedRecord({ scheduleId: "undefined", asyncJobId: "job-1" }),
    );
    expect(record.scheduleId).toBeNull();
    expect(record.asyncJobId).toBe("job-1");
    expect(normalizeLedgerLinkage({ scheduleId: "null", asyncJobId: "job-1" })).toEqual({
      trigger: "unknown",
      scheduleId: null,
      asyncJobId: "job-1",
      workflowId: null,
    });
  });

  it("passes a real jobId through unchanged", () => {
    expect(normalizeJobRunRecord(storedRecord()).jobId).toBe("sched-1");
  });
});

describe("3650-P06 Resolver — the job-id fallback never yields 'undefined' (#3650)", () => {
  it("falls through a poisoned schedule id / payload id to the callback fallback", () => {
    expect(
      resolveScheduleRunJobId("autonomousMarketScreen", {}, { id: "undefined" }),
    ).toBe("callback:autonomousMarketScreen");
    expect(
      resolveScheduleRunJobId(
        "autonomousMarketScreen",
        { scheduleId: "undefined" },
        undefined,
      ),
    ).toBe("callback:autonomousMarketScreen");
    expect(
      resolveScheduleRunJobId("autonomousMarketScreen", { scheduleId: "null" }, undefined),
    ).toBe("callback:autonomousMarketScreen");
    expect(
      resolveScheduleRunJobId("autonomousMarketScreen", { scheduleId: "sched-9" }, undefined),
    ).toBe("sched-9");
  });

  it("buildLedgerLinkage maps a poisoned schedule id to null", () => {
    expect(
      buildLedgerLinkage({
        payload: { scheduleId: "undefined" },
        triggeredBy: "scheduled",
      }).scheduleId,
    ).toBeNull();
    expect(
      buildLedgerLinkage({
        payload: { scheduleId: "sched-9" },
        triggeredBy: "scheduled",
      }).scheduleId,
    ).toBe("sched-9");
  });
});
