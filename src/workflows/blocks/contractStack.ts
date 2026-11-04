/**
 * Issue #2991 (#2770 Phase A) — one layered contract stack:
 *
 *   intent -> plan -> execution command -> stage messages ->
 *   persisted results -> reports
 *
 * The historical contracts are mapped onto it exactly once each.
 * Dispositions: canonical (the layer's form), thin-view (survives
 * as a view over the canonical form), retire-follow-up (competes;
 * retirement is its own slice with its own deprecation path —
 * never a silent deletion, per Policy Gate), retired (retired by
 * this slice, named).
 *
 * Old shapes survive as thin views where they survive, and are
 * retired where they compete — the retirement itself, where it
 * is not this slice, is a named follow-up, not a claim.
 */

export type ContractLayer =
  | "intent"
  | "plan"
  | "executionCommand"
  | "stageMessages"
  | "persistedResults"
  | "reports";

export type ContractDisposition =
  | "canonical"
  | "thin-view"
  | "retire-follow-up"
  | "retired";

export interface ContractMapping {
  contract: string;
  layer: ContractLayer;
  disposition: ContractDisposition;
  notes: string;
}

export const CONTRACT_STACK: ContractMapping[] = [
  {
    contract: "parseStockScreenRequest",
    layer: "intent",
    disposition: "canonical",
    notes: "REST intent parser for stock screens; parses into the stock plan input.",
  },
  {
    contract: "parseOptionsScreenRequest",
    layer: "intent",
    disposition: "canonical",
    notes: "REST intent parser for options screens; parses into the options plan input.",
  },
  {
    contract: "GoalScreenPlan",
    layer: "intent",
    disposition: "thin-view",
    notes: "Goal intent (buildGoalScreenPlan) — a view over planner-port plan input; survives as the goal intent shape.",
  },
  {
    contract: "StockScreenRunSpec",
    layer: "plan",
    disposition: "canonical",
    notes: "The stock plan record; the stock plan Block's input.",
  },
  {
    contract: "StockScreenPlan",
    layer: "plan",
    disposition: "canonical",
    notes: "The stock planner output (planFromSpec / planGoalStockLeg).",
  },
  {
    contract: "optionsPlanBlock",
    layer: "plan",
    disposition: "canonical",
    notes: "NEW in #2991: the options plan Block behind the one planner port.",
  },
  {
    contract: "ScreenerRunRequest",
    layer: "executionCommand",
    disposition: "thin-view",
    notes: "Sync-path command view; the canonical execution command is WorkflowJobCommand.",
  },
  {
    contract: "WorkflowJobCommand",
    layer: "executionCommand",
    disposition: "canonical",
    notes: "The execution command, carried by workflow start and queue messages alike.",
  },
  {
    contract: "StageMessage",
    layer: "stageMessages",
    disposition: "canonical",
    notes: "#2869 persist-then-publish stage contract; stock stages named once.",
  },
  {
    contract: "AsyncJob",
    layer: "stageMessages",
    disposition: "canonical",
    notes: "Carrier + capability set (mas_async_jobs); stages ride it where queues do not.",
  },
  {
    contract: "ScreeningProviderRegistry",
    layer: "executionCommand",
    disposition: "canonical",
    notes: "The provider seam goal legs execute through today; survives as the execution seam.",
  },
  {
    contract: "ScreenerAgent.runScreen",
    layer: "executionCommand",
    disposition: "thin-view",
    notes: "Monolithic sync executor; survives as the stock executor. Its missing per-boundary stage emission is #2869 follow-up, not a second pipeline.",
  },
  {
    contract: "DynamicOptionsScreener",
    layer: "executionCommand",
    disposition: "canonical",
    notes: "The options execution seam, wrapped by the options leg Block — not replaced.",
  },
  {
    contract: "mas_reports+mas_data_captures+ledger",
    layer: "persistedResults",
    disposition: "canonical",
    notes: "Canonical persisted results + the screener task ledger (#607).",
  },
  {
    contract: "mas_events saga audit rows",
    layer: "persistedResults",
    disposition: "canonical",
    notes: "The saga's evidence; the only audit system (no second audit system).",
  },
  {
    contract: "outcomeCatalog+channelTemplates",
    layer: "reports",
    disposition: "canonical",
    notes: "Outcome codes + renderable channel templates; the reporting vocabulary.",
  },
  {
    contract: "goal reports+Docs+delivery",
    layer: "reports",
    disposition: "canonical",
    notes: "Reports UI + Docs tab + email/PDF + Slack/PDF delivery (the delivery contract).",
  },
  {
    contract: "broker goal guard",
    layer: "plan",
    disposition: "retired",
    notes: "RETIRED by #2991: spec.source === 'goal' -> null is removed; goal specs route like any spec when async is requested.",
  },
  {
    contract: "goal-dispatch parallel execution",
    layer: "executionCommand",
    disposition: "retire-follow-up",
    notes: "FOLLOW-UP (goal-dispatch migration slice): goal dispatch becomes a caller of the one pipeline; its executor role retires into the pipeline.",
  },
  {
    contract: "sync-only options path",
    layer: "executionCommand",
    disposition: "retire-follow-up",
    notes: "FOLLOW-UP (options funneling slice): the route -> DynamicOptionsScreener -> persist + delivery path funnels through the planner port + leg composition.",
  },
];

export function contractLayer(contract: string): ContractMapping | undefined {
  return CONTRACT_STACK.find((r) => r.contract === contract);
}

/**
 * Validate a stack table: no contract twice, every layer keeps a
 * canonical form, and every retire-follow-up names its follow-up.
 */
export function validateContractStack(mappings: ContractMapping[]): void {
  const seen = new Set<string>();
  for (const row of mappings) {
    if (seen.has(row.contract)) {
      throw new Error(`Contract stack: duplicate contract ${row.contract}`);
    }
    seen.add(row.contract);
    if (row.disposition === "retire-follow-up" && !row.notes.trim()) {
      throw new Error(
        `Contract stack: retire-follow-up ${row.contract} must name its follow-up`,
      );
    }
    if (row.disposition === "retired" && !row.notes.trim()) {
      throw new Error(
        `Contract stack: retired ${row.contract} must name the retiring change`,
      );
    }
  }
  const layers: ContractLayer[] = [
    "intent",
    "plan",
    "executionCommand",
    "stageMessages",
    "persistedResults",
    "reports",
  ];
  for (const layer of layers) {
    const canonical = mappings.filter(
      (r) => r.layer === layer && r.disposition === "canonical",
    );
    if (canonical.length === 0) {
      throw new Error(`Contract stack: layer ${layer} has no canonical contract`);
    }
  }
}
