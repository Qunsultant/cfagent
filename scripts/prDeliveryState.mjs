/**
 * Issue #5569 — the delivery-state check for one pull request.
 *
 * Two states look healthy in `mergeStateStatus` and are not:
 *
 *  - a **dead auto-merge request**: `gh pr merge <n>` on a PR whose checks are
 *    still running falls back to `enablePullRequestAutoMerge` with the repo's
 *    default method (SQUASH), which a rebase-only ruleset can never honour
 *    (#5569). The request is recorded, the queue does not have the PR, and
 *    nothing reports it;
 *  - **queued vs not-queued**: a queued PR reads `BEHIND`/`UNKNOWN` exactly
 *    like an un-enrolled one, so "waiting" is indistinguishable from "stuck"
 *    and the predictable reaction is a rebase that loses the queue position
 *    (#5570).
 *
 * `isInMergeQueue` and `autoMergeRequest.mergeMethod` are the honest signals.
 * This module is the pure classifier; `scripts/pr-delivery-state.mjs` is the
 * CLI wrapper.
 */

/** @typedef {{
 *   number?: number,
 *   state?: string,
 *   isDraft?: boolean,
 *   mergeStateStatus?: string,
 *   isInMergeQueue?: boolean,
 *   checksGreen?: boolean,
 *   autoMergeRequest?: { mergeMethod?: string } | null,
 * }} PullRequestState */

export const DELIVERY_STATES = {
  CLOSED: "closed",
  DRAFT: "draft",
  QUEUED: "queued",
  DEAD_AUTO_MERGE: "dead-auto-merge",
  RED: "red",
  NOT_QUEUED: "not-queued",
};

/**
 * Classify one PR. Pure: the caller owns the API read.
 *
 * Order matters: a draft that is somehow queued is still a draft (the queue
 * will reject it), and a queued PR's auto-merge field is irrelevant — the
 * queue is already carrying it.
 */
export function classifyDeliveryState(pr) {
  if (!pr || typeof pr !== "object") return DELIVERY_STATES.RED;
  if ((pr.state ?? "OPEN") !== "OPEN") return DELIVERY_STATES.CLOSED;
  if (pr.isDraft === true) return DELIVERY_STATES.DRAFT;
  if (pr.isInMergeQueue === true) return DELIVERY_STATES.QUEUED;
  const method = pr.autoMergeRequest?.mergeMethod;
  if (typeof method === "string" && method !== "REBASE") {
    return DELIVERY_STATES.DEAD_AUTO_MERGE;
  }
  if (pr.checksGreen === false) return DELIVERY_STATES.RED;
  return DELIVERY_STATES.NOT_QUEUED;
}

/**
 * Parse a payload from `gh pr view --json …` or the GraphQL
 * `pullRequest` object. Tolerates a UTF-8 BOM (PowerShell's default
 * `Out-File -Encoding utf8` writes one) and returns null when the text
 * is not an object rather than throwing.
 */
export function parseDeliveryPayload(text) {
  const clean = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (clean.length === 0) return null;
  try {
    const parsed = JSON.parse(clean);
    const pr = parsed?.data?.repository?.pullRequest ?? parsed;
    return pr && typeof pr === "object" ? pr : null;
  } catch {
    return null;
  }
}

/**
 * The one-line advice for a state. Kept here (not in the CLI) so a test pins
 * the wording an agent is expected to follow.
 */
export function deliveryAdvice(state, number) {
  const pr = number ? `#${number}` : "this PR";
  switch (state) {
    case DELIVERY_STATES.CLOSED:
      return `${pr} is closed — nothing to do.`;
    case DELIVERY_STATES.DRAFT:
      return `${pr} is a draft — mark it ready; a draft is never enrolled.`;
    case DELIVERY_STATES.QUEUED:
      return `${pr} is in the merge queue — wait, and do not push to its branch (a push dequeues it).`;
    case DELIVERY_STATES.DEAD_AUTO_MERGE:
      return `${pr} carries an auto-merge request with a non-REBASE method — it can never merge here. Enqueue with the enqueuePullRequest mutation; do not re-run \`gh pr merge\`.`;
    case DELIVERY_STATES.RED:
      return `${pr} is not green or not readable — fix the failing check, then re-check.`;
    default:
      return `${pr} is green but not queued — enqueue it with the enqueuePullRequest GraphQL mutation.`;
  }
}

/** Exit code contract: 0 = nothing to fix now, 1 = action required. */
export function deliveryExitCode(state) {
  return state === DELIVERY_STATES.QUEUED || state === DELIVERY_STATES.CLOSED
    ? 0
    : 1;
}
