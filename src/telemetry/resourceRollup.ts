/**
 * Resource rollup / cap-alert / comparison pure logic (issue #1819).
 *
 * No bindings, no I/O — the same purity rule as ResourceUsagePort.
 *
 * Day boundary (VERIFIED, not assumed): Cloudflare's Workers pricing page
 * states D1 "Free limits reset daily at 00:00 UTC", and the Durable
 * Objects storage table footnotes that DO "Rows read and rows written
 * included limits and rates match D1 pricing". The rollup day is therefore
 * the UTC calendar day [00:00 UTC, 00:00 UTC next day). If the dashboard
 * ever shows otherwise, only utcDayOf/utcDayBounds change — every goal
 * reads the day through them.
 *
 * Budgets (same page, Workers Free plan): 5M rows read/day, 100k rows
 * written/day, 100k DO requests/day. Alert threshold: 70% of each.
 *
 * Scope honesty (also stated in the goal handlers and the doc): the
 * projection sees SessionStore ops only, so alert totals are a LOWER
 * BOUND on account-wide usage. A SessionStore-only breach at 70% implies
 * the account is at >=70%; no breach does NOT prove account safety,
 * because other DO namespaces are uncounted. The DO-requests figure
 * counts store ops (one stub.fetch per op) as the request proxy, under
 * the same lower-bound caveat.
 */
import type { ResourceBucketTotal } from "./resourceUsagePorts";

export const FREE_TIER_BUDGETS = {
  rowsRead: 5_000_000,
  rowsWritten: 100_000,
  doRequests: 100_000,
} as const;

export const ALERT_FRACTION = 0.7;

export function alertThresholds(): { rowsRead: number; rowsWritten: number; doRequests: number } {
  return {
    rowsRead: Math.floor(FREE_TIER_BUDGETS.rowsRead * ALERT_FRACTION),
    rowsWritten: Math.floor(FREE_TIER_BUDGETS.rowsWritten * ALERT_FRACTION),
    doRequests: Math.floor(FREE_TIER_BUDGETS.doRequests * ALERT_FRACTION),
  };
}

/** UTC calendar day (YYYY-MM-DD) of an instant. toISOString is UTC by construction. */
export function utcDayOf(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/** [startMs, endMs) of a UTC day. */
export function utcDayBounds(day: string): { startMs: number; endMs: number } {
  const startMs = Date.parse(`${day}T00:00:00Z`);
  return { startMs, endMs: startMs + 86_400_000 };
}

/** UTC day before the day containing nowMs. */
export function previousUtcDay(nowMs: number): string {
  return utcDayOf(nowMs - 86_400_000);
}

export interface CapCumulative {
  rowsRead: number;
  rowsWritten: number;
  /** Store ops; the DO-requests proxy (see scope note above). */
  ops: number;
}

export interface CapBreach {
  budget: "rowsRead" | "rowsWritten" | "doRequests";
  cumulative: number;
  limit: number;
  pct: number;
}

/**
 * Issue #2840 (Q3) — quota tiers on #1819's measurement base.
 * 70% stays the watch tier (the existing alert, unchanged);
 * 90% is the escalate tier (a second, distinct alert, because
 * the day's watch alert already fired and must not swallow it);
 * 100% is the critical tier (the provider limit itself: the
 * next SessionStore op throws, and the #2666 degradation —
 * breaker + cached-session serve + typed 503 for fresh logins
 * — is what the user actually experiences).
 *
 * Boundaries are AT the threshold, like the 70% rule: 90%
 * fires at exactly 90%, 100% at exactly 100%. Tiers are per
 * budget: rowsRead can be critical while rowsWritten is
 * still watch. The totals remain the SessionStore-only lower
 * bound, so every tier inherits #1819's caveat (a tier breach
 * proves the account is at least there; no breach proves
 * nothing about the uncounted namespaces).
 */
export type CapTier = "none" | "watch" | "escalate" | "critical";

export const CAP_TIER_FRACTIONS = {
  watch: 0.7,
  escalate: 0.9,
  critical: 1.0,
} as const;

export interface CapTierAssessment {
  budget: CapBreach["budget"];
  cumulative: number;
  limit: number;
  pct: number;
  tier: CapTier;
}

export function tierForPct(pct: number): CapTier {
  if (pct >= CAP_TIER_FRACTIONS.critical) return "critical";
  if (pct >= CAP_TIER_FRACTIONS.escalate) return "escalate";
  if (pct >= CAP_TIER_FRACTIONS.watch) return "watch";
  return "none";
}

export function evaluateCapTiers(cumulative: CapCumulative): {
  rowsRead: CapTierAssessment;
  rowsWritten: CapTierAssessment;
  doRequests: CapTierAssessment;
} {
  const candidates: Array<{ budget: CapBreach["budget"]; cumulative: number; limit: number }> = [
    { budget: "rowsRead", cumulative: cumulative.rowsRead, limit: FREE_TIER_BUDGETS.rowsRead },
    { budget: "rowsWritten", cumulative: cumulative.rowsWritten, limit: FREE_TIER_BUDGETS.rowsWritten },
    { budget: "doRequests", cumulative: cumulative.ops, limit: FREE_TIER_BUDGETS.doRequests },
  ];
  const out = {} as Record<CapBreach["budget"], CapTierAssessment>;
  for (const c of candidates) {
    const pct = c.cumulative / c.limit;
    out[c.budget] = { budget: c.budget, cumulative: c.cumulative, limit: c.limit, pct, tier: tierForPct(pct) };
  }
  return out;
}

/**
 * Alert-state key for a tier. The watch tier keeps the
 * historical bare budget key (`rowsRead`) so the existing
 * 70% dedup is untouched; escalate/critical suffix their
 * tier (`rowsRead:90`, `rowsRead:100`) so a higher-tier alert
 * is never swallowed by the already-marked watch alert for
 * the same budget-day, and never re-posts for its own tier-day.
 */
export function tierAlertKey(budget: CapBreach["budget"], tier: CapTier, _day: string): string {
  if (tier === "escalate") return `${budget}:90`;
  if (tier === "critical") return `${budget}:100`;
  return budget;
}

/**
 * Plain-text body for a tier alert. The escalation names the
 * action (act on the alert: nothing sheds automatically — see
 * the #2840 doc for why auto-shedding on a lower-bound
 * projection would drop real work on a false signal); the
 * critical text names the degradation the user experiences
 * (breaker + cached serve + typed 503 for fresh logins).
 * Delivered through the same Slack route as the watch alert.
 */
export function buildTierAlertText(
  day: string,
  tier: "escalate" | "critical",
  breaches: CapBreach[],
): string {
  const lines = breaches.map(
    (b) => `- ${b.budget}: ${b.cumulative.toLocaleString("en-US")} of ${b.limit.toLocaleString("en-US")} (${Math.round(b.pct * 100)}%)`,
  );
  if (tier === "critical") {
    return [
      `CRITICAL: SessionStore free-tier quota at 100% for ${day} (SessionStore-only lower bound).`,
      ...lines,
      "The provider limit is hit: further SessionStore ops throw. Degradation in force: the session-store breaker suppresses store reads, cached sessions keep serving degraded, and fresh logins without a cached session answer a typed 503. No work is shed automatically; act on this alert.",
    ].join("\n");
  }
  return [
    `ESCALATION: SessionStore free-tier quota at 90% for ${day} (SessionStore-only lower bound).`,
    ...lines,
    "Act on this alert: at 100% the provider limit throws and the #2666 degradation (breaker + cached serve + typed 503 for fresh logins) takes over. Nothing sheds automatically before then.",
  ].join("\n");
}

/** Breach AT the threshold, not past it: at 70% the alert fires. */
export function evaluateCapAlert(cumulative: CapCumulative): {
  breached: boolean;
  breaches: CapBreach[];
} {
  const thresholds = alertThresholds();
  const candidates: Array<{ budget: CapBreach["budget"]; cumulative: number; limit: number }> = [
    { budget: "rowsRead", cumulative: cumulative.rowsRead, limit: FREE_TIER_BUDGETS.rowsRead },
    { budget: "rowsWritten", cumulative: cumulative.rowsWritten, limit: FREE_TIER_BUDGETS.rowsWritten },
    { budget: "doRequests", cumulative: cumulative.ops, limit: FREE_TIER_BUDGETS.doRequests },
  ];
  const breaches: CapBreach[] = [];
  for (const c of candidates) {
    const threshold =
      c.budget === "rowsRead"
        ? thresholds.rowsRead
        : c.budget === "rowsWritten"
          ? thresholds.rowsWritten
          : thresholds.doRequests;
    if (c.cumulative >= threshold) {
      breaches.push({ budget: c.budget, cumulative: c.cumulative, limit: c.limit, pct: c.cumulative / c.limit });
    }
  }
  return { breached: breaches.length > 0, breaches };
}

export interface DailyRollupRow {
  day: string;
  ns: string;
  op: string;
  caller: string;
  trigger: string;
  ops: number;
  rowsRead: number;
  rowsWritten: number;
}

/** Bucketed totals for one day become day-keyed rollup rows. */
export function rollupRowsFromTotals(
  totals: readonly ResourceBucketTotal[],
  day: string
): DailyRollupRow[] {
  return totals.map((t) => ({
    day,
    ns: t.ns,
    op: t.op,
    caller: t.caller,
    trigger: t.trigger,
    ops: t.ops,
    rowsRead: t.rowsRead,
    rowsWritten: t.rowsWritten,
  }));
}

export interface ComparisonReport {
  day: string;
  grandTotals: { ops: number; rowsRead: number; rowsWritten: number };
  byCaller: Array<{ caller: string; ops: number; rowsRead: number; rowsWritten: number }>;
  byTrigger: Array<{ trigger: string; ops: number; rowsRead: number; rowsWritten: number }>;
  budgets: typeof FREE_TIER_BUDGETS;
  pctOfBudget: { rowsRead: number; rowsWritten: number; doRequests: number };
  scopeNote: string;
  /** Dashboard numbers are NEVER invented: null until the owner lines them up. */
  dashboard: null;
  dashboardSeriesToCompare: string[];
  agreementCriteria: string[];
}

const SCOPE_NOTE =
  "SessionStore projection only: these totals are a lower bound on account-wide usage. " +
  "A SessionStore-only breach at 70% implies the account is at >=70%; no breach does not " +
  "prove account safety, because other DO namespaces are uncounted. DO requests are " +
  "counted as SessionStore store ops (one stub.fetch per op).";

/** Stable report shape: scheduled and forced evaluations produce identical JSON. */
export function buildComparisonReport(input: {
  day: string;
  rows: readonly DailyRollupRow[];
}): ComparisonReport {
  const grandTotals = input.rows.reduce(
    (acc, r) => ({
      ops: acc.ops + r.ops,
      rowsRead: acc.rowsRead + r.rowsRead,
      rowsWritten: acc.rowsWritten + r.rowsWritten,
    }),
    { ops: 0, rowsRead: 0, rowsWritten: 0 }
  );
function aggregateRows(
  rows: readonly DailyRollupRow[],
  pick: (r: DailyRollupRow) => string
): Array<{ key: string; ops: number; rowsRead: number; rowsWritten: number }> {
  const grouped = new Map<string, { ops: number; rowsRead: number; rowsWritten: number }>();
  for (const r of rows) {
    const k = pick(r);
    const existing = grouped.get(k) ?? { ops: 0, rowsRead: 0, rowsWritten: 0 };
    existing.ops += r.ops;
    existing.rowsRead += r.rowsRead;
    existing.rowsWritten += r.rowsWritten;
    grouped.set(k, existing);
  }
  return [...grouped.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.rowsRead - a.rowsRead);
}
  return {
    day: input.day,
    grandTotals,
    byCaller: aggregateRows(input.rows, (r) => r.caller).map(({ key, ...v }) => ({
      caller: key,
      ...v,
    })),
    byTrigger: aggregateRows(input.rows, (r) => r.trigger).map(({ key, ...v }) => ({
      trigger: key,
      ...v,
    })),
    budgets: FREE_TIER_BUDGETS,
    pctOfBudget: {
      rowsRead: grandTotals.rowsRead / FREE_TIER_BUDGETS.rowsRead,
      rowsWritten: grandTotals.rowsWritten / FREE_TIER_BUDGETS.rowsWritten,
      doRequests: grandTotals.ops / FREE_TIER_BUDGETS.doRequests,
    },
    scopeNote: SCOPE_NOTE,
    dashboard: null,
    dashboardSeriesToCompare: [
      "Cloudflare Dashboard → Durable Objects → Metrics, rows read per DO namespace, hourly",
      "Cloudflare Dashboard → Durable Objects → Metrics, rows written per DO namespace, hourly",
      "Cloudflare Dashboard → Durable Objects → Metrics, requests per DO namespace, hourly",
    ],
    agreementCriteria: [
      "same order of magnitude between instrumented SessionStore rows and the dashboard SessionStore-namespace rows",
      "same top caller (by rows) on both sides",
      "same hourly shape: steady burn vs spike at a specific job",
      "dashboard >> instrumented means the burner is outside SessionStore or in unattributed callers — do not fix a caller on that evidence",
      "instrumented >> dashboard means an emitter bug — do not fix a caller on that evidence",
    ],
  };
}
