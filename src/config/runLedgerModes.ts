/**
 * Issue #4262 (S1) — the one run ledger's kind vocabulary and its filter set.
 *
 * Every row in the ledger (`job_run_records`) is classified into exactly
 * one kind by the recorded operation namespace, through the ordered rule
 * table below. The vocabulary itself is fixed here (a kind nothing can
 * produce would be a lie in the UI); the FILTER SET and the DEFAULT
 * FILTER are configuration, never literals in the read path:
 *
 *   RUN_LEDGER_FILTERS         comma-separated filter ids to show, e.g.
 *                              "all,options,goal" (order is the button order)
 *   RUN_LEDGER_DEFAULT_FILTER  the filter the runs view opens with
 *
 * Rules, applied in this order:
 *   - "all" always leads the resolved set and cannot be removed: it is the
 *     filter that shows every row, so removing it would hide runs.
 *   - Unknown ids are dropped; duplicates collapse to their first position.
 *   - A blank, empty or wholly-unknown value falls back to the built-in
 *     default set (an empty toolbar would be a worse answer than the default).
 *   - A default that is not in the resolved set falls back to "all".
 *
 * Issue #3121 S4/#3605 established the ledger and its linkage columns; this
 * module adds only the kind vocabulary and the configuration seam on top.
 */

/** The kinds a ledger row can be classified into. */
export const RUN_LEDGER_KIND_IDS = [
  "stock",
  "strategy",
  "options",
  "goal",
  "reports",
  "workflow",
  "pipeline",
  "ops",
  // Issue #6003 — the agent families: Autopilot rows arrive stamped
  // `ledgerKind: "autopilot"` by the outcome fold, Copilot cycle rows
  // classify by their `stock-copilot-` operation (see the rule table).
  "autopilot",
  "copilot",
  "other",
] as const;

export type RunLedgerKind = (typeof RUN_LEDGER_KIND_IDS)[number];

/** "all" is the pseudo-filter that shows every kind. */
export const RUN_LEDGER_ALL_FILTER = "all" as const;

export type RunLedgerFilter = typeof RUN_LEDGER_ALL_FILTER | RunLedgerKind;

/** The human label for each filter (UI text lives in one place). */
export const RUN_LEDGER_FILTER_LABELS: Record<RunLedgerFilter, string> = {
  all: "All",
  stock: "Stock",
  strategy: "Strategy",
  options: "Options",
  goal: "Goal",
  reports: "Reports",
  workflow: "Workflow",
  pipeline: "Pipeline",
  ops: "Operations",
  autopilot: "Autopilot",
  copilot: "Copilot",
  other: "Other",
};

export const RUN_LEDGER_FILTERS_ENV_VAR = "RUN_LEDGER_FILTERS";
export const RUN_LEDGER_DEFAULT_FILTER_ENV_VAR = "RUN_LEDGER_DEFAULT_FILTER";

/**
 * The built-in filter set: every kind the rule table can produce, in the
 * order the owner named them (stock, strategy, options, goal, reports,
 * workflow) followed by the two operational kinds, the two agent families
 * (Autopilot, Copilot — issue #6003), and the honest fallback last.
 */
export const DEFAULT_RUN_LEDGER_FILTERS: readonly RunLedgerFilter[] = [
  RUN_LEDGER_ALL_FILTER,
  "stock",
  "strategy",
  "options",
  "goal",
  "reports",
  "workflow",
  "pipeline",
  "ops",
  "autopilot",
  "copilot",
  "other",
];

/** The built-in default filter: the owner opens on everything. */
export const DEFAULT_RUN_LEDGER_FILTER: RunLedgerFilter = RUN_LEDGER_ALL_FILTER;

export interface RunLedgerFilterEnv {
  RUN_LEDGER_FILTERS?: string;
  RUN_LEDGER_DEFAULT_FILTER?: string;
}

const FILTER_IDS: readonly string[] = [RUN_LEDGER_ALL_FILTER, ...RUN_LEDGER_KIND_IDS];

export function isRunLedgerFilter(value: unknown): value is RunLedgerFilter {
  return typeof value === "string" && FILTER_IDS.includes(value);
}

function parseFilterList(raw: string | undefined): RunLedgerFilter[] {
  if (typeof raw !== "string") return [];
  const out: RunLedgerFilter[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (!id || !isRunLedgerFilter(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Resolve the filter set the runs view shows. Never returns an empty list
 * and always leads with "all".
 */
export function resolveRunLedgerFilters(env: RunLedgerFilterEnv = {}): RunLedgerFilter[] {
  const configured = parseFilterList(env[RUN_LEDGER_FILTERS_ENV_VAR]);
  if (configured.length === 0) return [...DEFAULT_RUN_LEDGER_FILTERS];
  return configured.includes(RUN_LEDGER_ALL_FILTER)
    ? configured
    : [RUN_LEDGER_ALL_FILTER, ...configured];
}

/**
 * Resolve the filter the view opens with. A default that is not shown in the
 * resolved set is unreachable, so it falls back to "all".
 */
export function resolveRunLedgerDefaultFilter(
  env: RunLedgerFilterEnv = {},
  filters: readonly RunLedgerFilter[] = resolveRunLedgerFilters(env),
): RunLedgerFilter {
  const raw = typeof env[RUN_LEDGER_DEFAULT_FILTER_ENV_VAR] === "string"
    ? env[RUN_LEDGER_DEFAULT_FILTER_ENV_VAR]!.trim().toLowerCase()
    : "";
  if (!raw || !isRunLedgerFilter(raw)) return DEFAULT_RUN_LEDGER_FILTER;
  return filters.includes(raw) ? raw : RUN_LEDGER_ALL_FILTER;
}

/** One classification rule: the first rule whose test matches wins. */
export interface RunLedgerKindRule {
  kind: RunLedgerKind;
  /** The operation begins with one of these namespaces. */
  operationPrefixes?: readonly string[];
  /** The operation IS one of these exact pipeline stage names. */
  operationEquals?: readonly string[];
  /** The recording system is one of these. */
  systems?: readonly string[];
}

/**
 * The ordered rule table. First match wins, so the most specific namespace
 * comes first. Extend it when a new operation namespace appears; an
 * unmatched operation is "other" — never guessed into a kind.
 *
 * Note on goals: a goal that screens options is an options run — the filter
 * answers *what ran*, and the Triggered by / Trigger columns already say it
 * was a goal. `goal` is therefore the kind for goal runs whose operation
 * carries no family namespace of its own.
 */
export const RUN_LEDGER_KIND_RULES: readonly RunLedgerKindRule[] = [
  // Issue #6003 — the Stock Copilot's own cycle rows: the loop's Think
  // task records them in the ledger with operation (and jobId)
  // `stock-copilot-paper-cycle` (#3788). First because it is the most
  // specific namespace here; the prefix is disjoint from every other
  // rule, so no existing classification changes. Rows the copilot
  // *dispatched* (triggeredBy "copilot") stay under their family kind —
  // kind answers what ran, the Triggered by column says who dispatched it.
  // No `autopilot.` backstop rule: operation `autopilot.evaluate` is a
  // goal operation (monthly evaluation) that today classifies as "other",
  // and a prefix rule would move it. Autopilot rows arrive stamped
  // `ledgerKind: "autopilot"` by the outcome fold instead.
  { kind: "copilot", operationPrefixes: ["stock-copilot-"] },
  // Issue #6160 — the orchestrator schedule callbacks record their
  // callback name as the operation, and the rule table never knew
  // that namespace: every callback row landed in "other", so a denied
  // Stock dispatch was invisible under kind=stock. The callback
  // operations classify by what ran (exact names, matched lowercase
  // by the classifier); the Triggered by / Trigger columns already
  // say it was a schedule. A denied dispatch records the same
  // callback operation with outcome "skipped", so it classifies
  // identically and shows under the family's filter.
  { kind: "options", operationPrefixes: ["trading.screen_options", "options."], operationEquals: ["autonomousoptionsanalysis", "collectivhistory"] },
  { kind: "stock", operationPrefixes: ["trading.screen_stocks", "screen.", "screener."], operationEquals: ["autonomousmarketscreen"] },
  { kind: "strategy", operationPrefixes: ["trading.strategy", "strategy."], operationEquals: ["autonomousstrategydiscovery"] },
  { kind: "reports", operationPrefixes: ["report.", "reports."] },
  { kind: "workflow", operationPrefixes: ["chain.", "workflow."], operationEquals: ["chain", "runworkflowstage"] },
  // Issue #6028 — the OODA research run records the definition's root kind
  // as its operation (`research`, jobPipelineEngine terminal record), which
  // matched no rule and landed in "other": the one job whose point is six
  // stages was invisible under the Pipeline filter. Reuses the existing kind
  // — no seventh kind, no second label — and the dotted prefix keeps a
  // future `researching.*` family out.
  {
    kind: "pipeline",
    operationPrefixes: ["research."],
    operationEquals: ["feed", "enrich", "analyze", "generate", "deliver", "research"],
  },
  {
    kind: "ops",
    operationPrefixes: [
      "index.",
      "social.",
      "qa.",
      "resource.",
      "schedule.",
      "payments.",
      "search.",
      "agent.schedule.",
      "memory.",
      "tasks.",
      "nlq.",
    ],
    operationEquals: [
      "autorenewetradetokens",
      "expirestaleorderdraft",
      "sendscheduledreminder",
      "sweepstaleledgertasks",
      "sweepstaleasyncjobs",
      "executeasyncjob",
    ],
  },
  { kind: "goal", systems: ["scheduled-agent-goal"], operationEquals: ["autonomousgoalscreen"] },
];
