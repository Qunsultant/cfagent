/**
 * Issue #2620 (Options Screener product programme, slice 7) — the
 * product-mix review loop.
 *
 * Human-approved review loop ONLY. This module is PURE COMPUTATION
 * over existing records: it reads run summaries (mas_reports /
 * scan / discovery / screener feed, via src/services/runSummaries)
 * and mas_job_outcomes rows (via src/data/jobOutcomePorts) and
 * returns metrics, proposals, and a proposal document. It never
 * flips a flag, never changes a price, never deletes a product,
 * never invents data, and never opens a store, session, table,
 * cron, or queue. An approved change lands as its own issue/PR
 * through the Merge Queue with its own §15 — never from here.
 *
 * COST-PROXY DEFINITION (recorded here because no cost field
 * exists on any run record — verified: zero `cost` hits in
 * runSummaries.ts, runDetails.ts, and optionsServeRecord.ts):
 * the cost proxy is volume + wasted share ONLY, computed from
 * existing records:
 *   - runs: run count in the window (proxy for provider-call volume),
 *   - failedRuns / wastedRunShare: failed runs are spend with no
 *     delivered value,
 *   - partialRuns / partialShare: degraded value per run.
 * There is NO money amount anywhere in this module: no price is
 * applied, no price is multiplied, and pricing is out of scope
 * for the loop (a proposal containing a pricing change is
 * rejected as a whole, per #2620). Durations are not recorded on
 * run summaries either, so duration is not part of the proxy.
 *
 * Two stores, two denominators (never merged): success/failure/
 * coverage rates come from RunSummary rows; failure-code rates
 * come from mas_job_outcomes rows (codedError, alias-normalized
 * through the single outcome resolver — #2608). The stores
 * overlap (one run can appear in both), so merging them into one
 * denominator would double-count. Free-text RunSummary error
 * fields (pdfError / xlsxError / csvError) are NOT failure codes
 * and never enter the code rates.
 *
 * Dependencies (stated, not duplicated): #2608 outcome codes
 * (normalizeOutcomeCode / resolveOutcome — used as-is) and #2611
 * lineage (run records already carry their lineage; this module
 * reads it, it does not rebuild it).
 *
 * Bonds: the bonds guard holds by absence (available: false).
 * Nothing here adds bonds data, routes, or flags.
 */

import type { RunSummary } from "./runSummaries";
import type { JobOutcomeRow } from "../data/jobOutcomePorts";
import { normalizeOutcomeCode } from "../outcomes/outcomeAspects";

/** The four product families a run record can belong to. */
export const PRODUCT_MIX_PRODUCTS = ["stock", "goal", "options", "strategy"] as const;
export type ProductMixProduct = (typeof PRODUCT_MIX_PRODUCTS)[number];

export interface ProductMixWindow {
  startIso: string;
  endIso: string;
}

/**
 * Cost proxy, from existing records only. NOT money: no cost field
 * exists on any run record, so this is run volume + wasted share.
 * Never multiply by a price; never present as spend.
 */
export interface ProductMixCostProxy {
  /** Runs in the window — proxy for provider-call volume. */
  runs: number;
  /** Failed runs — spend with no delivered value. */
  failedRuns: number;
  /** failedRuns / status-known runs; null when no run in the
   *  group records a status, never 0/0. */
  wastedRunShare: number | null;
  /** Runs that completed only partially. */
  partialRuns: number;
  /** partialRuns / status-known runs; null when no run records a status. */
  partialShare: number | null;
}

export interface ProductMixFailureCodeRate {
  /** Canonical outcome code (legacy aliases normalized, #2608). */
  code: string;
  /** Failed outcome rows carrying this code. */
  count: number;
  /** count / failed outcome rows in the group (codeless failures
   *  stay in the denominator, so rates sum to <= 1). */
  rate: number;
}

export interface ProductMixCoverage {
  evaluated: number;
  considered: number;
  /** evaluated / considered; null when considered === 0. */
  rate: number | null;
}

export interface ProductMixMetrics {
  /** Product family (stock | goal | options | strategy), a bundle
   *  id when the caller groups by bundle, or a kind name for rows
   *  no product family claims (e.g. "report") — never silently
   *  reassigned to a product. */
  product: string;
  window: ProductMixWindow;
  /** Run-summary rows in the window. */
  runs: number;
  completed: number;
  failed: number;
  partial: number;
  /** Rows whose store records no status — counted, never invented. */
  unknown: number;
  /** Runs whose store records a status (completed + failed +
   *  partial). Rates below are over this denominator: a run with
   *  no recorded status is counted in `runs`/`unknown` but never
   *  in a rate denominator, so a rate is null — never 0/0 — when
   *  no run in the group records a status. */
  knownStatusRuns: number;
  /** completed / knownStatusRuns; null when no run records a status. */
  successRate: number | null;
  /** failed / knownStatusRuns; null when no run records a status. */
  failureRate: number | null;
  /** partial / knownStatusRuns; null when no run records a status. */
  partialRate: number | null;
  /** Partial-coverage sums from RunSummary.partial; null when no
   *  run in the group records a partial qualification. */
  coverage: ProductMixCoverage | null;
  /** Failure-code rates from mas_job_outcomes codedError only. */
  failureCodes: ProductMixFailureCodeRate[];
  /** Failed mas_job_outcomes rows in the group (the code-rate denominator). */
  failedOutcomeRows: number;
  /** Failed outcome rows carrying a codedError. */
  codedFailureRows: number;
  costProxy: ProductMixCostProxy;
}

/** The grouping input: a run summary's kind/runSource, or a job
 *  outcome row's kind. Discovery maps to "strategy" (the
 *  runSource the discovery family records, runSummaries.ts). */
export interface ProductMixGroupInput {
  kind: string;
  runSource?: string | null;
}

const KIND_TO_PRODUCT: Record<string, string> = {
  screener: "stock",
  options_scanner: "options",
  goal: "goal",
  discovery: "strategy",
};

const KNOWN_PRODUCTS = new Set<string>(PRODUCT_MIX_PRODUCTS);

/** Default grouping: runSource when it names a product family,
 *  else the kind mapping; unmapped kinds group under their own
 *  kind name so nothing is silently dropped or misattributed. */
export function defaultProductMixGroupKey(input: ProductMixGroupInput): string {
  if (input.runSource && KNOWN_PRODUCTS.has(input.runSource)) return input.runSource;
  return KIND_TO_PRODUCT[input.kind] ?? input.kind;
}

function rateOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function inWindow(createdAt: string, window: ProductMixWindow): boolean {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) return false;
  return ms >= Date.parse(window.startIso) && ms < Date.parse(window.endIso);
}

interface MutableGroup {
  summaries: RunSummary[];
  outcomes: JobOutcomeRow[];
}

function newMetrics(product: string, window: ProductMixWindow, group: MutableGroup): ProductMixMetrics {
  let completed = 0;
  let failed = 0;
  let partial = 0;
  let unknown = 0;
  let evaluated = 0;
  let considered = 0;
  let hasPartial = false;
  for (const s of group.summaries) {
    if (s.status === "completed") completed += 1;
    else if (s.status === "failed") failed += 1;
    else if (s.status === "partial") partial += 1;
    else unknown += 1;
    if (s.partial) {
      hasPartial = true;
      evaluated += s.partial.evaluatedCount;
      considered += s.partial.consideredCount;
    }
  }
  const runs = group.summaries.length;
  const knownStatusRuns = completed + failed + partial;
  const failedOutcomes = group.outcomes.filter((o) => o.status === "failed");
  const codeCounts = new Map<string, number>();
  let coded = 0;
  for (const o of failedOutcomes) {
    if (o.codedError) {
      coded += 1;
      const code = normalizeOutcomeCode(o.codedError);
      codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
    }
  }
  const failureCodes: ProductMixFailureCodeRate[] = [...codeCounts.entries()]
    .map(([code, count]) => ({
      code,
      count,
      rate: failedOutcomes.length === 0 ? 0 : count / failedOutcomes.length,
    }))
    .sort((a, b) => (b.count === a.count ? (a.code < b.code ? -1 : 1) : b.count - a.count));
  return {
    product,
    window,
    runs,
    completed,
    failed,
    partial,
    unknown,
    knownStatusRuns,
    successRate: rateOrNull(completed, knownStatusRuns),
    failureRate: rateOrNull(failed, knownStatusRuns),
    partialRate: rateOrNull(partial, knownStatusRuns),
    coverage: hasPartial
      ? { evaluated, considered, rate: considered === 0 ? null : evaluated / considered }
      : null,
    failureCodes,
    failedOutcomeRows: failedOutcomes.length,
    codedFailureRows: coded,
    costProxy: {
      runs,
      failedRuns: failed,
      wastedRunShare: rateOrNull(failed, knownStatusRuns),
      partialRuns: partial,
      partialShare: rateOrNull(partial, knownStatusRuns),
    },
  };
}

/**
 * Aggregate per-product metrics from existing records only.
 * `groupKey` defaults to the product-family mapping; pass a
 * caller key (e.g. run -> bundle id) for per-bundle metrics —
 * the same aggregator, the same denominators, no second path.
 * Groups with no rows in the window produce no row.
 */
export function aggregateProductMixMetrics(
  summaries: readonly RunSummary[],
  outcomes: readonly JobOutcomeRow[],
  window: ProductMixWindow,
  groupKey: (input: ProductMixGroupInput) => string = defaultProductMixGroupKey,
): ProductMixMetrics[] {
  const groups = new Map<string, MutableGroup>();
  const at = (key: string): MutableGroup => {
    let g = groups.get(key);
    if (!g) {
      g = { summaries: [], outcomes: [] };
      groups.set(key, g);
    }
    return g;
  };
  for (const s of summaries) {
    if (!inWindow(s.createdAt, window)) continue;
    at(groupKey({ kind: s.kind, runSource: s.runSource ?? null })).summaries.push(s);
  }
  for (const o of outcomes) {
    if (!inWindow(o.createdAt, window)) continue;
    at(groupKey({ kind: o.kind })).outcomes.push(o);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([product, group]) => newMetrics(product, window, group));
}

export interface ProductMixRollup {
  products: ProductMixMetrics[];
  /** Worst sub-product by failure rate (ties: more runs, then
   *  product id); null when no product has run records. */
  worstProduct: string | null;
  worstFailureRate: number | null;
  reason: string;
}

/** Parent roll-up: the per-product rows plus the worst
 *  sub-product reported alongside them (#2620 scope). */
export function rollupProductMix(metrics: readonly ProductMixMetrics[]): ProductMixRollup {
  const withData = metrics.filter((m) => m.runs > 0 && m.failureRate !== null);
  if (withData.length === 0) {
    return { products: [...metrics], worstProduct: null, worstFailureRate: null, reason: "no run records in window" };
  }
  const sorted = [...withData].sort((a, b) => {
    const fa = a.failureRate ?? -1;
    const fb = b.failureRate ?? -1;
    if (fb !== fa) return fb - fa;
    if (b.runs !== a.runs) return b.runs - a.runs;
    return a.product < b.product ? -1 : 1;
  });
  const worst = sorted[0];
  return {
    products: [...metrics],
    worstProduct: worst.product,
    worstFailureRate: worst.failureRate,
    reason: `worst sub-product by failure rate: ${worst.product} (${worst.failed}/${worst.runs} failed)`,
  };
}

/** One day of per-product outcomes for the emergency detector. */
export interface DailyProductOutcome {
  product: string;
  /** Calendar date, YYYY-MM-DD. */
  date: string;
  runs: number;
  failed: number;
}

export interface ProductMixEmergencyProposal {
  product: string;
  windowStartDate: string;
  windowEndDate: string;
  consecutiveDays: number;
  runs: number;
  failed: number;
  /** The only action this detector ever proposes. It is a
   *  proposal: nothing here flips anything. */
  proposedAction: "propose-temporary-kill-switch-flip";
  requiresHumanApproval: true;
  evidence: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateMs(date: string): number {
  if (!DATE_RE.test(date)) throw new Error(`invalid date (expected YYYY-MM-DD): ${date}`);
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) throw new Error(`invalid date: ${date}`);
  return ms;
}

/**
 * Emergency detector: a product failing 100% on its action route
 * for `consecutiveDays` consecutive days (default 7) may be
 * proposed for a temporary kill-switch flip out of cadence — still
 * requiring human approval. The loop surfaces it early; it never
 * flips it. A day with zero runs is not a failing day and breaks
 * the run; a day with any success breaks the run. Same
 * product+date rows are summed into one daily total.
 */
export function detectProductMixEmergencies(
  daily: readonly DailyProductOutcome[],
  consecutiveDays = 7,
): ProductMixEmergencyProposal[] {
  if (!Number.isInteger(consecutiveDays) || consecutiveDays < 1) {
    throw new Error(`consecutiveDays must be a positive integer, got ${consecutiveDays}`);
  }
  const byProduct = new Map<string, Map<string, { runs: number; failed: number }>>();
  for (const d of daily) {
    if (!Number.isInteger(d.runs) || d.runs < 0 || !Number.isInteger(d.failed) || d.failed < 0 || d.failed > d.runs) {
      throw new Error(`invalid daily outcome for ${d.product} on ${d.date}: runs=${d.runs} failed=${d.failed}`);
    }
    const ms = dateMs(d.date);
    void ms;
    let days = byProduct.get(d.product);
    if (!days) {
      days = new Map();
      byProduct.set(d.product, days);
    }
    const prev = days.get(d.date) ?? { runs: 0, failed: 0 };
    days.set(d.date, { runs: prev.runs + d.runs, failed: prev.failed + d.failed });
  }
  const proposals: ProductMixEmergencyProposal[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  for (const [product, days] of [...byProduct.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const sorted = [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    let run: Array<{ date: string; runs: number; failed: number }> = [];
    const flush = () => {
      if (run.length >= consecutiveDays) {
        const windowDays = run.slice(0, consecutiveDays);
        const runs = windowDays.reduce((n, d) => n + d.runs, 0);
        const failed = windowDays.reduce((n, d) => n + d.failed, 0);
        proposals.push({
          product,
          windowStartDate: windowDays[0].date,
          windowEndDate: windowDays[windowDays.length - 1].date,
          consecutiveDays,
          runs,
          failed,
          proposedAction: "propose-temporary-kill-switch-flip",
          requiresHumanApproval: true,
          evidence:
            `${product} failed ${failed}/${runs} runs on each of ${consecutiveDays} consecutive days ` +
            `(${windowDays[0].date} to ${windowDays[windowDays.length - 1].date}) — 100% failure on its action route.`,
        });
      }
      run = [];
    };
    for (const [date, counts] of sorted) {
      const failing = counts.runs > 0 && counts.failed === counts.runs;
      const continues =
        failing &&
        run.length > 0 &&
        dateMs(date) - dateMs(run[run.length - 1].date) === dayMs;
      if (failing && (run.length === 0 || continues)) {
        run.push({ date, ...counts });
      } else {
        flush();
        if (failing) run.push({ date, ...counts });
      }
    }
    flush();
  }
  return proposals;
}

export type ProductMixProposedAction = "none" | "flag-flip" | "bundle-change" | "deprecation-proposal";

/** A human reviewer's proposal, recorded verbatim — the producer
 *  never invents a flag-flip, bundle change, or deprecation. */
export interface ProductMixHumanProposal {
  product: string;
  proposedAction: Exclude<ProductMixProposedAction, "none">;
  evidence: string;
  proposedBy: string;
}

export interface ProductMixProposalItem {
  product: string;
  metrics: ProductMixMetrics | null;
  proposedAction: ProductMixProposedAction;
  evidence: string[];
  requiresHumanApproval: boolean;
}

export interface ProductMixMonthlyProposal {
  month: string;
  generatedAtIso: string;
  window: ProductMixWindow;
  items: ProductMixProposalItem[];
  emergencies: ProductMixEmergencyProposal[];
  rollup: ProductMixRollup;
  bundles: import("../data/productCatalogue").ProductBundleConfig[];
  bundleMetrics: ProductMixMetrics[];
  notes: string[];
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Build the monthly proposal. Default action is "none" — valid
 * when evidence is thin or mixed. An emergency turns its product
 * into a "flag-flip" proposal (temporary kill-switch flip, human
 * approval required). A human-supplied proposal is recorded
 * verbatim and takes precedence for the action; the emergency
 * evidence is kept alongside it. Nothing here is applied.
 */
export function buildMonthlyProductMixProposal(input: {
  month: string;
  generatedAtIso: string;
  window: ProductMixWindow;
  metrics: readonly ProductMixMetrics[];
  emergencies: readonly ProductMixEmergencyProposal[];
  bundles: import("../data/productCatalogue").ProductBundleConfig[];
  bundleMetrics?: readonly ProductMixMetrics[];
  humanProposals?: readonly ProductMixHumanProposal[];
}): ProductMixMonthlyProposal {
  if (!MONTH_RE.test(input.month)) {
    throw new Error(`invalid month (expected YYYY-MM): ${input.month}`);
  }
  if (Date.parse(input.window.endIso) <= Date.parse(input.window.startIso)) {
    throw new Error("proposal window end must be after window start");
  }
  const byProduct = new Map<string, ProductMixMetrics>();
  for (const m of input.metrics) byProduct.set(m.product, m);
  const emergencyByProduct = new Map<string, ProductMixEmergencyProposal>();
  for (const e of input.emergencies) emergencyByProduct.set(e.product, e);
  const humanByProduct = new Map<string, ProductMixHumanProposal>();
  for (const h of input.humanProposals ?? []) {
    if (h.evidence.trim() === "") throw new Error(`human proposal for ${h.product} must state evidence`);
    humanByProduct.set(h.product, h);
  }
  const products = new Set<string>([...byProduct.keys(), ...emergencyByProduct.keys(), ...humanByProduct.keys()]);
  const items: ProductMixProposalItem[] = [...products].sort().map((product) => {
    const metrics = byProduct.get(product) ?? null;
    const emergency = emergencyByProduct.get(product);
    const human = humanByProduct.get(product);
    const evidence: string[] = [];
    if (metrics) {
      evidence.push(
        metrics.runs === 0
          ? "no run records in window"
          : `${metrics.runs} runs: ${metrics.completed} completed, ${metrics.failed} failed, ${metrics.partial} partial` +
              (metrics.failureRate !== null ? ` (failure rate ${(metrics.failureRate * 100).toFixed(1)}%)` : "") +
              (metrics.coverage ? `, coverage ${metrics.coverage.evaluated}/${metrics.coverage.considered}` : "") +
              `. Cost proxy (existing records only): ${metrics.costProxy.runs} runs, wasted share ` +
              `${metrics.costProxy.wastedRunShare === null ? "n/a" : `${(metrics.costProxy.wastedRunShare * 100).toFixed(1)}%`}.`,
      );
    }
    if (emergency) evidence.push(emergency.evidence);
    if (human) evidence.push(human.evidence);
    if (human) evidence.push(`Proposed by ${human.proposedBy} (human-supplied proposal; recorded verbatim).`);
    if (human) {
      return { product, metrics, proposedAction: human.proposedAction, evidence, requiresHumanApproval: true };
    }
    if (emergency) {
      evidence.push("Proposed action: temporary kill-switch flip, out of cadence — human approval required; the loop never flips it.");
      return { product, metrics, proposedAction: "flag-flip", evidence, requiresHumanApproval: true };
    }
    evidence.push(
      metrics === null || metrics.runs === 0
        ? "No action proposed: no run records in window."
        : "No action proposed: evidence thin or mixed — no 7-day 100% failure and no human proposal.",
    );
    return { product, metrics, proposedAction: "none", evidence, requiresHumanApproval: false };
  });
  const notes = [
    "Cost proxy definition (existing records only; no cost field exists on any run record): run volume + failed-run wasted share + partial share. No money amount, no price applied, no duration (not recorded).",
    "Sources: run summaries (mas_reports / scan / discovery / screener feed) and mas_job_outcomes codedError (outcome codes, #2608). No new telemetry; no invented data.",
    "User satisfaction, revenue, and pricing experiments are NOT loop inputs.",
    input.bundles.length === 0
      ? "No bundles exist yet — per-bundle metrics apply once bundles exist."
      : `${input.bundles.length} bundle(s) configured; per-bundle metrics are in the bundle section.`,
  ];
  return {
    month: input.month,
    generatedAtIso: input.generatedAtIso,
    window: input.window,
    items,
    emergencies: [...input.emergencies],
    rollup: rollupProductMix(input.metrics),
    bundles: [...input.bundles],
    bundleMetrics: [...(input.bundleMetrics ?? [])],
    notes,
  };
}

/** Render the monthly proposal as Markdown. The document itself
 *  is NOT a code change to flags: it is a proposal for human
 *  review, and an approved change lands as its own issue/PR. */
export function renderMonthlyProductMixProposal(proposal: ProductMixMonthlyProposal): string {
  const lines: string[] = [];
  lines.push(`# Product-mix review proposal — ${proposal.month}`);
  lines.push("");
  lines.push("Status: proposal only — this document changes no flag, price, bundle, or product.");
  lines.push(`Generated: ${proposal.generatedAtIso}`);
  lines.push(`Window: ${proposal.window.startIso} to ${proposal.window.endIso}`);
  lines.push("");
  lines.push("## Roll-up");
  lines.push("");
  if (proposal.rollup.worstProduct === null) {
    lines.push("no run records in window — no per-product metrics.");
  } else {
    lines.push(`Worst sub-product by failure rate: **${proposal.rollup.worstProduct}** (${proposal.rollup.reason}).`);
  }
  lines.push("");
  lines.push("## Per-product proposals");
  lines.push("");
  if (proposal.items.length === 0) {
    lines.push("No products had run records or proposals in this window — no action proposed.");
    lines.push("");
  }
  for (const item of proposal.items) {
    lines.push(`### ${item.product} — ${item.proposedAction}`);
    lines.push("");
    for (const e of item.evidence) lines.push(`- ${e}`);
    lines.push(`- Human approval required: ${item.requiresHumanApproval ? "yes" : "no (no action proposed)"}.`);
    lines.push("");
  }
  lines.push("## Emergencies (7-day 100% failure)");
  lines.push("");
  if (proposal.emergencies.length === 0) {
    lines.push("None detected in this window.");
  }
  for (const e of proposal.emergencies) {
    lines.push(`- ${e.product}: ${e.evidence} Proposed: ${e.proposedAction} (human approval required).`);
  }
  lines.push("");
  lines.push("## Bundles");
  lines.push("");
  if (proposal.bundles.length === 0) {
    lines.push("No bundles exist yet — per-bundle metrics apply once bundles exist.");
  }
  for (const b of proposal.bundles) {
    const m = proposal.bundleMetrics.find((x) => x.product === b.id);
    lines.push(
      `- **${b.id}** (${b.name}): flags ${b.flags.join(", ")}; status ${b.status}` +
        (b.approvedBy ? `; approved by ${b.approvedBy} at ${b.approvedAt}` : "; not approved") +
        (m ? `; ${m.runs} runs, failure rate ${m.failureRate === null ? "n/a" : `${(m.failureRate * 100).toFixed(1)}%`}` : "; no metrics in window"),
    );
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  for (const n of proposal.notes) lines.push(`- ${n}`);
  lines.push("");
  lines.push("Any approved change lands as its own issue/PR through the Merge Queue with its own §15.");
  return lines.join("\n") + "\n";
}
