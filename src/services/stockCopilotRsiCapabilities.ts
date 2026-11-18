/**
 * Issue #5056 (AG-2) — the single statement of what the Stock Copilot's
 * Recursive Self-Improvement machinery can actually do.
 *
 * `docs/architecture/agentic/stockcopilot-RSI.md` §7 specifies a Self-RSI
 * pipeline: BrowserAgent research → SandboxAgent code synthesis →
 * ThinkWorkflow backtest → StrategyCard → 1-click activation. None of it
 * exists in code: there is no `synthesizeStrategy`, no `StrategyCard`, no
 * strategy-code synthesis in the SandboxAgent (a container-command runner),
 * and no activation seam for a synthesized card. The `patternCatalog.ts`
 * the doc cited was never a module; the real strategy module is
 * `patternSignals.ts` (pure functions, code-only).
 *
 * The RSI mode switch is persisted and audited per login. Before this
 * module it offered `self` as a working mode that enabled nothing. The
 * registry below is the one home for implementation state; the mode
 * resolver consults it, so flipping `self_rsi_pipeline` to `implemented`
 * (when the pipeline lands) is the single change that re-enables the mode
 * instead of leaving a switch wired to nothing.
 *
 * This is a decision record, not a feature: #5056's outcome allowed either
 * implementing the pipeline or correcting the doc and the switch. The
 * pipeline's own issue carries the build.
 */

/** Implementation state of one self-improvement capability. */
export type StockCopilotRsiCapabilityStatus = "implemented" | "specified_only";

export interface StockCopilotRsiCapability {
  id: string;
  status: StockCopilotRsiCapabilityStatus;
  /** Where the capability is specified (doc anchor) or implemented (symbol). */
  evidence: string;
  /** For `specified_only`: the symbols/paths that are missing today. */
  missing?: readonly string[];
}

/** Registry id of the §7 sandbox-synthesis pipeline. */
export const SELF_RSI_PIPELINE_CAPABILITY = "self_rsi_pipeline";

/**
 * The registry. One entry per self-improvement capability the RSI doc
 * promises; the mode switch is offered only when its entry is
 * `implemented`.
 */
export const STOCK_COPILOT_RSI_CAPABILITIES: Readonly<
  Record<string, StockCopilotRsiCapability>
> = {
  [SELF_RSI_PIPELINE_CAPABILITY]: {
    id: SELF_RSI_PIPELINE_CAPABILITY,
    status: "specified_only",
    evidence: "docs/architecture/agentic/stockcopilot-RSI.md §7",
    missing: [
      "synthesizeStrategy (no symbol in src/)",
      "StrategyCard (no symbol in src/)",
      "strategy-code synthesis in SandboxAgent (container-command runner only, src/agents/sandbox-agent.ts)",
      "backtest-to-card seam (ThinkWorkflow backtest produces no card)",
      "1-click activation seam for a synthesized card",
    ],
  },
  governed_proposal_pathway: {
    id: "governed_proposal_pathway",
    status: "implemented",
    evidence:
      "synthesizeCapabilityProposals (src/services/stockCopilotIntrospection.ts) drafts a GitHub-issue-shaped proposal with title, lane, and actionable plan",
  },
};

/** True when the §7 sandbox-synthesis pipeline can actually run. */
export function isSelfRsiPipelineImplemented(): boolean {
  return (
    STOCK_COPILOT_RSI_CAPABILITIES[SELF_RSI_PIPELINE_CAPABILITY]?.status ===
    "implemented"
  );
}

/**
 * The notice rendered wherever a user selected `self` while the pipeline
 * is specified-only. One sentence, one source, so the chat surface, the
 * door, and the docs cannot drift apart.
 */
export function selfRsiModeNotice(): string {
  const capability =
    STOCK_COPILOT_RSI_CAPABILITIES[SELF_RSI_PIPELINE_CAPABILITY];
  const missing = capability?.missing?.length
    ? ` Missing: ${capability.missing.join("; ")}.`
    : "";
  return (
    "Self-RSI mode is specified but not implemented (docs/architecture/agentic/stockcopilot-RSI.md §7); " +
    "governed mode is in effect, and proposals are filed as governed GitHub issues." +
    missing
  );
}
