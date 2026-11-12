/** @vitest-environment jsdom */
/**
 * Issue #4262 (S1) — the one run ledger's kind filters.
 *
 * Pins:
 *  - 4262-P01 the kind vocabulary classifies every recorded operation family
 *    (stock, strategy, options, goal, reports, workflow, pipeline, ops) and
 *    an unmatched operation lands in "other" — never dropped, never guessed.
 *  - 4262-P02 the filter set and the default filter come from configuration:
 *    defaults, env override, unknown ids dropped, "all" always first, a
 *    default outside the set falls back to "all".
 *  - 4262-P03 "All" returns every row; each kind filter returns only its kind.
 *  - 4262-P04 the panel renders one filter button per configured kind with the
 *    live count, and selecting a filter shows only that kind's rows.
 *  - 4262-P05 the row's kind is visible in the table (a Kind column), and an
 *    unknown `kind` deep link falls back to the configured default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { ScheduleRunLedgerPanel } from "../src/client/ScheduleRunLedgerPanel";
import {
  DEFAULT_RUN_LEDGER_FILTER,
  DEFAULT_RUN_LEDGER_FILTERS,
  resolveRunLedgerDefaultFilter,
  resolveRunLedgerFilters,
} from "../src/config/runLedgerModes";
import {
  classifyRunKind,
  countRunsByKind,
  filterRunsByKind,
} from "../src/services/runLedgerKinds";

const RUNS = {
  options: {
    system: "orchestrator-schedule",
    jobId: "opt-1",
    operation: "trading.screen_options",
    started: "2026-11-12T10:00:00.000Z",
    finished: "2026-11-12T10:05:00.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    trigger: "scheduled",
    scheduleId: "opt-1",
    asyncJobId: null,
    workflowId: null,
    descriptor: "Scanned 120 option contracts",
  },
  stock: {
    system: "orchestrator-schedule",
    jobId: "stock-1",
    operation: "trading.screen_stocks",
    started: "2026-11-12T09:00:00.000Z",
    finished: "2026-11-12T09:02:00.000Z",
    outcome: "success",
    triggeredBy: "manual",
    trigger: "manual",
    scheduleId: null,
    asyncJobId: null,
    workflowId: null,
    descriptor: "Scanned 400 symbols",
  },
  goal: {
    system: "scheduled-agent-goal",
    jobId: "goal-1",
    operation: "goal.run",
    started: "2026-11-12T08:00:00.000Z",
    finished: "2026-11-12T08:01:00.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    trigger: "scheduled",
    scheduleId: null,
    asyncJobId: null,
    workflowId: null,
    descriptor: "Goal evaluated",
  },
  feed: {
    system: "job-pipeline",
    jobId: "yahoo-sp500-quotes",
    operation: "feed",
    started: "2026-11-12T07:00:00.000Z",
    finished: "2026-11-12T07:03:00.000Z",
    outcome: "failure",
    triggeredBy: "scheduled",
    trigger: "scheduled",
    scheduleId: null,
    asyncJobId: "job-9",
    workflowId: "wf-9",
    descriptor: "feed failed",
    error: "provider 503",
  },
} as const;

const ALL_ROWS = [RUNS.options, RUNS.stock, RUNS.goal, RUNS.feed];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal("fetch", vi.fn());
  window.history.replaceState({}, "", "/?tab=schedules&view=runs");
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
}

function ledgerStub(rows: readonly unknown[]): void {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/ledger/runs")) {
        return new Response(JSON.stringify({ runs: rows }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  );
}

function radio(label: string): HTMLButtonElement | undefined {
  return Array.from(container!.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
    (b) => (b.textContent ?? "").trim().startsWith(label),
  );
}

function bodyText(): string {
  return (container!.textContent ?? "").replace(/\s+/g, " ");
}

describe("4262-P01 kind classification", () => {
  it("classifies each recorded operation family", () => {
    expect(classifyRunKind({ operation: "trading.screen_options" })).toBe("options");
    expect(classifyRunKind({ operation: "trading.screen_stocks" })).toBe("stock");
    expect(classifyRunKind({ operation: "trading.strategy_scan" })).toBe("strategy");
    expect(classifyRunKind({ operation: "report.generate" })).toBe("reports");
    expect(classifyRunKind({ operation: "chain" })).toBe("workflow");
    expect(classifyRunKind({ operation: "feed" })).toBe("pipeline");
    expect(classifyRunKind({ operation: "index.refresh_wikipedia" })).toBe("ops");
    expect(classifyRunKind({ system: "scheduled-agent-goal", operation: "goal.run" })).toBe("goal");
  });

  it("never guesses: an unmatched operation is 'other'", () => {
    expect(classifyRunKind({ operation: "autonomousMarketScreen" })).toBe("other");
    expect(classifyRunKind({ operation: null })).toBe("other");
    expect(classifyRunKind({})).toBe("other");
  });

  it("a goal that screens options is an options run (what ran wins)", () => {
    expect(
      classifyRunKind({ system: "scheduled-agent-goal", operation: "trading.screen_options" }),
    ).toBe("options");
  });
});

describe("4262-P02 configured filter set and default", () => {
  it("defaults to every kind, all first, default all", () => {
    expect(resolveRunLedgerFilters()).toEqual([...DEFAULT_RUN_LEDGER_FILTERS]);
    expect(resolveRunLedgerDefaultFilter()).toBe(DEFAULT_RUN_LEDGER_FILTER);
  });

  it("honours the environment, drops unknown ids, and always leads with all", () => {
    const filters = resolveRunLedgerFilters({ RUN_LEDGER_FILTERS: "options,bogus,goal" });
    expect(filters).toEqual(["all", "options", "goal"]);
    expect(resolveRunLedgerDefaultFilter({ RUN_LEDGER_DEFAULT_FILTER: "goal" }, filters)).toBe("goal");
  });

  it("falls back rather than emptying the toolbar", () => {
    expect(resolveRunLedgerFilters({ RUN_LEDGER_FILTERS: " , " })).toEqual([
      ...DEFAULT_RUN_LEDGER_FILTERS,
    ]);
    const filters = resolveRunLedgerFilters({ RUN_LEDGER_FILTERS: "options" });
    // A default the set does not show would be unreachable.
    expect(resolveRunLedgerDefaultFilter({ RUN_LEDGER_DEFAULT_FILTER: "reports" }, filters)).toBe("all");
  });
});

describe("4262-P03 filtering", () => {
  it("All returns every row and each kind returns only its kind", () => {
    expect(filterRunsByKind(ALL_ROWS, "all")).toHaveLength(4);
    expect(filterRunsByKind(ALL_ROWS, "options").map((r) => r.jobId)).toEqual(["opt-1"]);
    expect(filterRunsByKind(ALL_ROWS, "stock").map((r) => r.jobId)).toEqual(["stock-1"]);
    expect(filterRunsByKind(ALL_ROWS, "goal").map((r) => r.jobId)).toEqual(["goal-1"]);
    expect(filterRunsByKind(ALL_ROWS, "pipeline").map((r) => r.jobId)).toEqual([
      "yahoo-sp500-quotes",
    ]);
  });

  it("counts every kind for the filter badges", () => {
    const counts = countRunsByKind(ALL_ROWS);
    expect(counts.options).toBe(1);
    expect(counts.stock).toBe(1);
    expect(counts.goal).toBe(1);
    expect(counts.pipeline).toBe(1);
    expect(counts.reports).toBe(0);
  });
});

describe("4262-P04/P05 the panel's filter buttons and Kind column", () => {
  it("renders one filter button per configured kind with live counts", async () => {
    ledgerStub(ALL_ROWS);
    await render(<ScheduleRunLedgerPanel />);
    await settle();
    expect(radio("All")).toBeDefined();
    expect(radio("Stock")).toBeDefined();
    expect(radio("Options")).toBeDefined();
    expect((radio("All")!.textContent ?? "").replace(/\s+/g, "")).toBe("All4");
  });

  it("an options filter shows only options runs", async () => {
    ledgerStub(ALL_ROWS);
    await render(<ScheduleRunLedgerPanel kind="options" />);
    await settle();
    const text = bodyText();
    expect(text).toContain("opt-1");
    expect(text).not.toContain("stock-1");
    expect(text).not.toContain("goal-1");
  });

  it("All shows every kind and the row's kind is visible", async () => {
    ledgerStub(ALL_ROWS);
    await render(<ScheduleRunLedgerPanel kind="all" />);
    await settle();
    const text = bodyText();
    for (const id of ["opt-1", "stock-1", "goal-1", "yahoo-sp500-quotes"]) {
      expect(text).toContain(id);
    }
    expect(text).toContain("Options");
    expect(text).toContain("Pipeline");
  });

  it("an unknown kind falls back to the configured default", async () => {
    ledgerStub(ALL_ROWS);
    await render(<ScheduleRunLedgerPanel kind={"nonsense" as never} />);
    await settle();
    const text = bodyText();
    expect(text).toContain("opt-1");
    expect(text).toContain("stock-1");
  });

  it("selecting a filter writes kind= into the URL", async () => {
    ledgerStub(ALL_ROWS);
    await render(<ScheduleRunLedgerPanel kind="all" />);
    await settle();
    const target = radio("Options");
    expect(target).toBeDefined();
    await act(async () => {
      target!.click();
    });
    await settle();
    expect(window.location.search).toContain("kind=options");
  });
});
