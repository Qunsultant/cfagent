/**
 * Issue #5057 (AG-3) — the governed RSI pathway's filing leg.
 *
 * `synthesizeCapabilityProposals` has always produced a complete governed
 * pathway — issue title, lane, actionable plan — and nothing filed it. The
 * pathway terminated in markdown, so "how can you improve yourself?" got a
 * draft, not a dispatch.
 *
 * This module is the missing leg, and it reuses the one GitHub filer the
 * repo already has (`createGitHubProposalFiler`, the mesh proposal
 * pipeline's adapter, #2460) rather than adding a second REST client:
 *
 *  - `resolveCopilotProposalFiler(env)` composes it from `GITHUB_ISSUE_TOKEN`
 *    and `GITHUB_ISSUE_REPO`. Absent a token, the filer is null and filing
 *    refuses with a coded error — a draft that cannot be dispatched says so
 *    instead of pretending.
 *  - `buildGovernedProposalIssue` renders the repo's §5 task shape from the
 *    proposal's own fields (title, lane, diagnosis, plan, gap evidence).
 *  - `fileGovernedProposal` requires an explicit human approver: the same
 *    HITL posture as every other autonomous filing (the agent proposes, the
 *    human disposes). No approver, no call to GitHub. Every attempt is
 *    audited by the caller's audit sink.
 */
import type { Env } from "../types";
import { createGitHubProposalFiler } from "./meshProposalFiler";
import type { MeshProposalFiler } from "./meshProposalPipeline";
import type { CapabilityImprovementProposal } from "./stockCopilotIntrospection";

/** The pathway cannot file without an explicit human approval. */
export const COPILOT_PROPOSAL_APPROVAL_REQUIRED = "COPILOT_PROPOSAL_APPROVAL_REQUIRED";
/** No GitHub token is configured, so the draft cannot be dispatched. */
export const COPILOT_PROPOSAL_FILER_UNAVAILABLE = "COPILOT_PROPOSAL_FILER_UNAVAILABLE";
/** The requested gap id is not among the current proposals. */
export const COPILOT_PROPOSAL_NOT_FOUND = "COPILOT_PROPOSAL_NOT_FOUND";

/** A coded filing refusal; callers match on `code`. */
export class CopilotProposalFilingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CopilotProposalFilingError";
    this.code = code;
  }
}

/**
 * The repository proposals are filed against when `GITHUB_ISSUE_REPO` is
 * absent. One constant, one place; an operator overrides it by env.
 */
export const COPILOT_PROPOSAL_DEFAULT_REPO = "Qunsultant/cfagent";

/**
 * Compose the GitHub filer from the deployment env. Null when no token is
 * configured: the governed pathway then reports itself as undispatchable
 * rather than failing at an arbitrary later moment.
 */
export function resolveCopilotProposalFiler(
  env: Env | undefined | null,
): MeshProposalFiler | null {
  const token = env?.GITHUB_ISSUE_TOKEN?.trim();
  if (!token) return null;
  const repo = env?.GITHUB_ISSUE_REPO?.trim() || COPILOT_PROPOSAL_DEFAULT_REPO;
  return createGitHubProposalFiler({ token, repo });
}

export interface GovernedProposalIssue {
  title: string;
  body: string;
  labels: string[];
}

/**
 * Render the §5 task issue for one proposal. Pure: same proposal + approver,
 * same issue. The proposal's own words are carried verbatim, with the
 * evidence a reviewer needs to judge it, so the filed issue is not a
 * second-hand retelling.
 */
export function buildGovernedProposalIssue(
  proposal: CapabilityImprovementProposal,
  options: { approvedBy: string; approvedAt?: string },
): GovernedProposalIssue {
  const approvedAt = options.approvedAt ?? new Date().toISOString();
  const title = proposal.governedPathway.targetIssueTitle.startsWith("[")
    ? proposal.governedPathway.targetIssueTitle
    : `[Enhancement] - ${proposal.governedPathway.targetIssueTitle}`;

  const body = [
    "## Agent",
    "#clo-arsi",
    "",
    "## Type",
    "Enhancement",
    "",
    "## Size",
    "- [x] Medium — one focused slice, no migration",
    "",
    "## Priority",
    "- [x] Low — capability gain, not a live defect",
    "",
    "## Parent",
    "Filed from the Stock Copilot's governed RSI pathway (#5057); portfolio parent #5023.",
    "",
    "## Problem",
    proposal.diagnosis,
    "",
    "## Outcome",
    proposal.governedPathway.actionablePlan,
    "",
    "## Scope",
    `Included: ${proposal.synthesisPath}`,
    `Excluded: anything beyond this capability gap (${proposal.gapId}).`,
    "",
    "## Needed capabilities",
    ...proposal.neededCapabilities.map((c) => `- ${c}`),
    "",
    "## Leveraged tools",
    `- Domain: ${proposal.leveragedTools.domain.join(", ") || "none"}`,
    `- Platform: ${proposal.leveragedTools.platform.join(", ") || "none"}`,
    "",
    "## Evidence",
    `- Gap: \`${proposal.gapId}\` (${proposal.readiness})`,
    `- Source: Stock Copilot introspection, proposal "${proposal.title}"`,
    `- Lane: \`${proposal.governedPathway.lane}\``,
    `- Approved for filing by: \`${options.approvedBy}\` at ${approvedAt}`,
    "",
    "## Test plan",
    "TDD per gitops §7: a failing test for the acceptance criterion above, then the implementation, then the pins this change touches.",
    "",
    "## Approval posture",
    "The agent proposed this issue; the named human approved filing it. Implementation follows gitops (branch, PR, CI, review, merge) like any lane's work — filing is the pathway's maximum reach.",
  ].join("\n");

  return {
    title,
    body,
    labels: [proposal.governedPathway.lane, "enhancement"],
  };
}

export type CopilotProposalAudit = (
  type: string,
  agent: "orchestrator",
  payload: Record<string, unknown>,
) => void;

/**
 * File one approved proposal. Refusals are coded and happen before any
 * network call: no approver, no filer, no filing.
 */
export async function fileGovernedProposal(params: {
  proposal: CapabilityImprovementProposal;
  /** The human who approved filing; blank refuses. */
  approvedBy: string | null | undefined;
  filer: MeshProposalFiler | null | undefined;
  audit?: CopilotProposalAudit;
  now?: () => Date;
}): Promise<{ number: number; url: string }> {
  const approvedBy = params.approvedBy?.trim();
  if (!approvedBy) {
    throw new CopilotProposalFilingError(
      COPILOT_PROPOSAL_APPROVAL_REQUIRED,
      "filing a governed proposal requires an explicit human approval — the agent proposes, the human disposes",
    );
  }
  if (!params.filer) {
    throw new CopilotProposalFilingError(
      COPILOT_PROPOSAL_FILER_UNAVAILABLE,
      "no GitHub issue token is configured (GITHUB_ISSUE_TOKEN) — the proposal is a complete draft but cannot be dispatched from here",
    );
  }

  const issue = buildGovernedProposalIssue(params.proposal, {
    approvedBy,
    approvedAt: (params.now ?? (() => new Date()))().toISOString(),
  });

  try {
    const filed = await params.filer.file(issue);
    params.audit?.("stock_copilot.proposal_filed", "orchestrator", {
      gapId: params.proposal.gapId,
      approvedBy,
      issueNumber: filed.number,
      issueUrl: filed.url,
    });
    return filed;
  } catch (err) {
    params.audit?.("stock_copilot.proposal_filing_failed", "orchestrator", {
      gapId: params.proposal.gapId,
      approvedBy,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
