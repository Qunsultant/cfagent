/**
 * #2620 (slice 7) — product-mix review loop: per-product metrics from
 * existing records only, bundle configuration, monthly proposal
 * document, and the 7-day 100%-failure emergency detector.
 *
 * RED first: src/services/productMixReview.ts does not exist yet, and
 * src/data/productCatalogue.ts has no bundle type.
 *
 * Human-approved review loop ONLY: nothing in this module flips a
 * flag, changes a price, deletes a product, or invents data. Every
 * output is a proposal; an approved change lands as its own
 * issue/PR with its own §15.
 */
import { describe, it, expect } from "vitest";
import type { RunSummary } from "../src/services/runSummaries";
import type { JobOutcomeRow } from "../src/data/jobOutcomePorts";
import {
  aggregateProductMixMetrics,
  buildMonthlyProductMixProposal,
  detectProductMixEmergencies,
  renderMonthlyProductMixProposal,
  rollupProductMix,
  type DailyProductOutcome,
  type ProductMixWindow,
} from "../src/services/productMixReview";
import {
  isBundleApproved,
  validateProductBundleConfig,
  type ProductBundleConfig,
} from "../src/data/productCatalogue";

const WINDOW: ProductMixWindow = {
  startIso: "2026-10-01T00:00:00.000Z",
  endIso: "2026-11-01T00:00:00.000Z",
};

function summary(overrides: Partial<RunSummary> & { runSource?: string | null }): RunSummary {
  return {
    kind: "screener",
    id: `id-${Math.random()}`,
    runId: `run-${Math.random()}`,
    title: "test run",
    summary: "test",
    trigger: "manual",
    createdAt: "2026-10-15T12:00:00.000Z",
    status: "completed",
    resultCount: 3,
    pdfKey: null,
    reportUrl: null,
    xlsxKey: null,
    xlsxUrl: null,
    csvKey: null,
    csvUrl: null,
    pdfStatus: null,
    pdfError: null,
    reportId: null,
    scanRunId: null,
    source: "screener",
    runSource: "stock",
    ...overrides,
    id: overrides.id ?? `id-${overrides.runId ?? "x"}`,
    runId: overrides.runId ?? `run-${overrides.id ?? "x"}`,
  };
}

function outcome(overrides: Partial<JobOutcomeRow>): JobOutcomeRow {
  return {
    id: "outcome-1",
    kind: "stock",
    trigger: "manual",
    status: "completed",
    scanned: null,
    matched: null,
    codedError: null,
    reportUrl: null,
    pdfKey: null,
    xlsxKey: null,
    csvKey: null,
    deliveryStates: {},
    origin: "test",
    createdAt: "2026-10-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("product-mix metrics (#2620)", () => {
  it("aggregates per-product success/failure rates from run summaries only", () => {
    const metrics = aggregateProductMixMetrics(
      [
        summary({ runId: "s1", runSource: "stock", status: "completed" }),
        summary({ runId: "s2", runSource: "stock", status: "failed" }),
        summary({ runId: "o1", runSource: "options", status: "completed" }),
      ],
      [],
      WINDOW,
    );
    const stock = metrics.find((m) => m.product === "stock");
    const options = metrics.find((m) => m.product === "options");
    expect(stock?.runs).toBe(2);
    expect(stock?.failureRate).toBe(0.5);
    expect(stock?.successRate).toBe(0.5);
    expect(options?.runs).toBe(1);
    expect(options?.failureRate).toBe(0);
    expect(options?.successRate).toBe(1);
  });

  it("defines the cost proxy from existing records only (no cost field exists)", () => {
    const metrics = aggregateProductMixMetrics(
      [
        summary({ runId: "s1", runSource: "stock", status: "completed" }),
        summary({ runId: "s2", runSource: "stock", status: "failed" }),
        summary({
          runId: "s3",
          runSource: "stock",
          status: "partial",
          partial: {
            evaluatedCount: 8,
            consideredCount: 10,
            coverageErrors: 2,
            truncatedCount: 0,
          },
        }),
      ],
      [],
      WINDOW,
    );
    const stock = metrics.find((m) => m.product === "stock");
    // Cost proxy = run counts, durations unavailable, failure rates.
    // There is NO money amount anywhere: no cost field exists on any
    // run record, so the proxy is volume + wasted-share only.
    expect(stock?.costProxy).toEqual({
      runs: 3,
      failedRuns: 1,
      wastedRunShare: 1 / 3,
      partialRuns: 1,
      partialShare: 1 / 3,
    });
    expect(stock?.coverage).toEqual({ evaluated: 8, considered: 10, rate: 0.8 });
    expect("costUSD" in (stock?.costProxy ?? {})).toBe(false);
  });

  it("reports null rates and null coverage on zero runs, never 0/0", () => {
    const metrics = aggregateProductMixMetrics([], [], WINDOW);
    expect(metrics).toEqual([]);
    const [only] = aggregateProductMixMetrics(
      [summary({ runId: "g1", runSource: "goal", status: null })],
      [],
      WINDOW,
    );
    expect(only.runs).toBe(1);
    expect(only.unknown).toBe(1);
    expect(only.successRate).toBeNull();
    expect(only.failureRate).toBeNull();
    expect(only.coverage).toBeNull();
    expect(only.costProxy.wastedRunShare).toBeNull();
  });

  it("excludes runs outside the window", () => {
    const metrics = aggregateProductMixMetrics(
      [
        summary({ runId: "in", runSource: "stock", createdAt: "2026-10-15T00:00:00.000Z" }),
        summary({ runId: "out", runSource: "stock", createdAt: "2026-09-30T23:59:59.999Z" }),
      ],
      [],
      WINDOW,
    );
    expect(metrics.find((m) => m.product === "stock")?.runs).toBe(1);
  });

  it("rates failure codes from mas_job_outcomes codedError, alias-normalized", () => {
    const metrics = aggregateProductMixMetrics(
      [],
      [
        outcome({ id: "f1", kind: "options", status: "failed", codedError: "SCREEN_001" }),
        outcome({ id: "f2", kind: "options", status: "failed", codedError: "FAILURE_SCREEN_RUN_FAILED" }),
        outcome({ id: "f3", kind: "options", status: "failed", codedError: "FAILURE_DATA_PROVIDER_UNAVAILABLE" }),
        outcome({ id: "f4", kind: "options", status: "failed", codedError: null }),
        outcome({ id: "c1", kind: "options", status: "completed" }),
      ],
      WINDOW,
    );
    const options = metrics.find((m) => m.product === "options");
    expect(options?.failedOutcomeRows).toBe(4);
    expect(options?.codedFailureRows).toBe(3);
    // SCREEN_001 is the pre-rename alias of FAILURE_SCREEN_RUN_FAILED:
    // the two rows group under one canonical code, never two.
    expect(options?.failureCodes).toEqual([
      { code: "FAILURE_SCREEN_RUN_FAILED", count: 2, rate: 0.5 },
      { code: "FAILURE_DATA_PROVIDER_UNAVAILABLE", count: 1, rate: 0.25 },
    ]);
  });

  it("does not treat free-text RunSummary errors as failure codes", () => {
    const metrics = aggregateProductMixMetrics(
      [summary({ runId: "s1", runSource: "stock", status: "failed", pdfError: "boom" })],
      [],
      WINDOW,
    );
    const stock = metrics.find((m) => m.product === "stock");
    expect(stock?.failureCodes).toEqual([]);
    expect(stock?.failed).toBe(1);
  });

  it("rolls up to the worst sub-product alongside the per-product rows", () => {
    const metrics = aggregateProductMixMetrics(
      [
        summary({ runId: "s1", runSource: "stock", status: "completed" }),
        summary({ runId: "o1", runSource: "options", status: "failed" }),
        summary({ runId: "o2", runSource: "options", status: "failed" }),
      ],
      [],
      WINDOW,
    );
    const rollup = rollupProductMix(metrics);
    expect(rollup.worstProduct).toBe("options");
    expect(rollup.worstFailureRate).toBe(1);
    expect(rollup.products).toHaveLength(2);
    expect(rollupProductMix([]).worstProduct).toBeNull();
  });

  it("supports caller-supplied grouping, so bundles aggregate the same way", () => {
    const metrics = aggregateProductMixMetrics(
      [
        summary({ runId: "s1", runSource: "stock", status: "completed" }),
        summary({ runId: "o1", runSource: "options", status: "failed" }),
      ],
      [],
      WINDOW,
      (input) => (input.runSource === "options" ? "bundle:core-options" : "bundle:core-stock"),
    );
    expect(metrics.map((m) => m.product).sort()).toEqual([
      "bundle:core-options",
      "bundle:core-stock",
    ]);
    expect(metrics.find((m) => m.product === "bundle:core-options")?.failureRate).toBe(1);
  });
});

describe("7-day 100%-failure emergency detector (#2620)", () => {
  function daily(product: string, startDay: number, days: number, failedPerDay: number, runsPerDay = 1): DailyProductOutcome[] {
    return Array.from({ length: days }, (_, i) => ({
      product,
      date: `2026-10-${String(startDay + i).padStart(2, "0")}`,
      runs: runsPerDay,
      failed: failedPerDay,
    }));
  }

  it("proposes a temporary kill-switch flip after 7 consecutive 100%-failure days", () => {
    const found = detectProductMixEmergencies(daily("options", 1, 7, 1));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      product: "options",
      windowStartDate: "2026-10-01",
      windowEndDate: "2026-10-07",
      consecutiveDays: 7,
      runs: 7,
      failed: 7,
      proposedAction: "propose-temporary-kill-switch-flip",
      requiresHumanApproval: true,
    });
  });

  it("proposes nothing at 6 days, on a partial-failure day, or on a zero-run day", () => {
    expect(detectProductMixEmergencies(daily("options", 1, 6, 1))).toEqual([]);
    const partial = [...daily("options", 1, 6, 1), { product: "options", date: "2026-10-07", runs: 2, failed: 1 }];
    expect(detectProductMixEmergencies(partial)).toEqual([]);
    const gap = [...daily("options", 1, 3, 1), { product: "options", date: "2026-10-04", runs: 0, failed: 0 }, ...daily("options", 5, 3, 1)];
    expect(detectProductMixEmergencies(gap)).toEqual([]);
  });
});

describe("monthly proposal document (#2620)", () => {
  it("defaults every product to no action when evidence is thin", () => {
    const metrics = aggregateProductMixMetrics(
      [summary({ runId: "s1", runSource: "stock", status: "completed" })],
      [],
      WINDOW,
    );
    const proposal = buildMonthlyProductMixProposal({
      month: "2026-10",
      generatedAtIso: "2026-11-06T12:00:00.000Z",
      window: WINDOW,
      metrics,
      emergencies: [],
      bundles: [],
    });
    expect(proposal.items).toHaveLength(1);
    expect(proposal.items[0].proposedAction).toBe("none");
    expect(proposal.items[0].requiresHumanApproval).toBe(false);
    expect(proposal.rollup.worstProduct).toBe("stock");
  });

  it("turns an emergency into a flag-flip proposal, still requiring human approval", () => {
    const metrics = aggregateProductMixMetrics(
      [summary({ runId: "o1", runSource: "options", status: "failed" })],
      [],
      WINDOW,
    );
    const emergencies = detectProductMixEmergencies(
      Array.from({ length: 7 }, (_, i) => ({
        product: "options",
        date: `2026-10-${String(i + 1).padStart(2, "0")}`,
        runs: 1,
        failed: 1,
      })),
    );
    const proposal = buildMonthlyProductMixProposal({
      month: "2026-10",
      generatedAtIso: "2026-11-06T12:00:00.000Z",
      window: WINDOW,
      metrics,
      emergencies,
      bundles: [],
    });
    const item = proposal.items.find((i) => i.product === "options");
    expect(item?.proposedAction).toBe("flag-flip");
    expect(item?.requiresHumanApproval).toBe(true);
    expect(item?.evidence.join(" ")).toContain("7 consecutive days");
  });

  it("records a human-supplied proposal verbatim and never invents one", () => {
    const proposal = buildMonthlyProductMixProposal({
      month: "2026-10",
      generatedAtIso: "2026-11-06T12:00:00.000Z",
      window: WINDOW,
      metrics: [],
      emergencies: [],
      bundles: [],
      humanProposals: [
        {
          product: "options",
          proposedAction: "deprecation-proposal",
          evidence: "Owner review 2026-11-05: usage fell below the agreed floor.",
          proposedBy: "owner",
        },
      ],
    });
    expect(proposal.items).toHaveLength(1);
    expect(proposal.items[0].proposedAction).toBe("deprecation-proposal");
    expect(proposal.items[0].metrics).toBeNull();
    expect(proposal.items[0].evidence).toContain(
      "Owner review 2026-11-05: usage fell below the agreed floor.",
    );
  });

  it("refuses an invalid month", () => {
    expect(() =>
      buildMonthlyProductMixProposal({
        month: "Oct 2026",
        generatedAtIso: "2026-11-06T12:00:00.000Z",
        window: WINDOW,
        metrics: [],
        emergencies: [],
        bundles: [],
      }),
    ).toThrow(/month/i);
  });

  it("renders markdown that states the proposal-only rule", () => {
    const proposal = buildMonthlyProductMixProposal({
      month: "2026-10",
      generatedAtIso: "2026-11-06T12:00:00.000Z",
      window: WINDOW,
      metrics: [],
      emergencies: [],
      bundles: [],
    });
    const md = renderMonthlyProductMixProposal(proposal);
    expect(md).toContain("# Product-mix review proposal — 2026-10");
    expect(md).toContain("no run records in window");
    expect(md).toContain("proposal only");
    expect(md).toContain("No bundles exist yet");
  });
});

describe("bundle configuration (#2620)", () => {
  const valid: ProductBundleConfig = {
    id: "core-options",
    name: "Core options",
    flags: ["options_screener", "options_contract_screen"],
    showWhen: { allFlagsOn: ["options_screener"], note: "Shown when the options product line is on." },
    approvedBy: "owner",
    approvedAt: "2026-11-06T12:00:00.000Z",
    status: "approved",
  };

  it("accepts a fully approved bundle config", () => {
    expect(validateProductBundleConfig(valid)).toEqual([]);
    expect(isBundleApproved(valid)).toBe(true);
  });

  it("refuses unknown flags, empty flag lists, and approval without an approver", () => {
    expect(
      validateProductBundleConfig({ ...valid, flags: ["options_screener", "no_such_flag" as never] }),
    ).toContain("unknown flag: no_such_flag");
    expect(validateProductBundleConfig({ ...valid, flags: [] })).toContain(
      "bundle must list at least one flag",
    );
    expect(validateProductBundleConfig({ ...valid, approvedBy: null })).toEqual(
      expect.arrayContaining([expect.stringMatching(/approvedBy/) ]),
    );
    expect(
      validateProductBundleConfig({ ...valid, status: "proposed", approvedBy: null, approvedAt: null }),
    ).toEqual([]);
    expect(isBundleApproved({ ...valid, status: "proposed", approvedBy: null, approvedAt: null })).toBe(false);
  });

  it("refuses a showWhen that states no condition", () => {
    expect(validateProductBundleConfig({ ...valid, showWhen: {} })).toContain(
      "showWhen must state a condition",
    );
  });
});
