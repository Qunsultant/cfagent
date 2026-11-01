/**
 * Issue #2566 (programme #2494): durable chat-turn submission —
 * extracted from OrchestratorAgent (src/agents/orchestrator.ts) in
 * the #992 pattern: the class keeps state/lifecycle ownership and
 * composes these functions through its durableTurnContext() builder;
 * each function receives its dependencies explicitly via
 * DurableTurnContext.
 *
 * What this replaces: the HTTP/programmatic chat-turn driver used to
 * drive the actor-port turn facet in wait mode — a blocking,
 * in-memory drive whose only record of the turn was the in-memory
 * pendingTurn stash (issue #1738: no durable turn sealing on
 * eviction; ADR 0005 follow-up D2). The driver now submits the turn
 * through Think's durable submission queue (submitMessages): the
 * submission is persisted before it runs, executes FIFO behind any
 * active turn, and a pending submission is recovered and completed
 * by a fresh instance after a restart/hibernation (ADR 0024).
 *
 * What the SDK mechanism does not carry, kept here deliberately:
 *  - the synchronous {result, route} return the routes consume: the
 *    route is decided inside the executed turn (portBeforeTurn), so
 *    the driver correlates by the request id it stamps into the
 *    user message's metadata and reads the recorded route back from
 *    the shared submittedTurnRoutes map after the submission
 *    settles;
 *  - port-transcript parity: the port session stays the canonical
 *    transcript the routes read, so the user message is appended
 *    before submitting and the assistant message is mirrored back
 *    on completion (both upsert-by-id, never duplicated);
 *  - the epoch abort: if a memory reset landed mid-turn (the epoch
 *    moved), a completed turn still lands the retired facet drive's
 *    aborted shape — empty text, route kept, nothing mirrored.
 */

// The submission types arrive via the foundation adapter, not the
// Think package directly (the agent-conformance pin's boundary).
import type { SubmitMessagesResult, ThinkSubmissionInspection } from "../../actors/thinkAdapter";
import type { UiChatMessage } from "../../actors/actorPorts";
import type { RouteDecision } from "../../types";

/** Ports the durable-turn functions receive from the class. */
export interface DurableTurnContext {
  /** Canonical transcript reads/writes (the actor port session). */
  getPortMessages: () => Promise<UiChatMessage[]>;
  addPortMessages: (messages: UiChatMessage[]) => Promise<void>;
  extractMessageText: (message: unknown) => string;
  /** Think's durable submission surface (the SDK mechanism). */
  submitMessages: (messages: unknown[], options?: Record<string, unknown>) => Promise<SubmitMessagesResult>;
  waitForSubmission: (submissionId: string) => Promise<ThinkSubmissionInspection | null>;
  inspectSubmission: (submissionId: string) => Promise<ThinkSubmissionInspection | null>;
  /** Think's own session (where a submitted turn persists its reply). */
  getThinkMessages: () => Promise<unknown[]>;
  /** The class's reset epoch (#1738): bumped by abortAllRequests. */
  turnEpoch: () => number;
  /** Route outcomes of submitted turns, keyed by turn request id;
   *  written by the class's portBeforeTurn when a submitted turn
   *  executes, read back here once the submission settles. */
  submittedTurnRoutes: Map<string, RouteDecision>;
  /** Tracks the in-flight submission so the class's
   *  abortAllRequests can cancel it on a memory reset. Settling
   *  clears the marker only when it still names that submission,
   *  so overlapping waits cannot clear each other's marker. */
  markSubmittedTurnActive: (active: { submissionId: string; epoch: number }) => void;
  markSubmittedTurnSettled: (submissionId: string) => void;
}

export interface SubmitChatTurnOptions {
  userText: string;
  userLogin: string;
  /** Recent-turns context for the Judge, when the caller carries
   *  one the session cannot supply (the HTTP route builds it from
   *  the re-POSTed history). Stamped into the message metadata and
   *  adopted by portBeforeTurn, so it survives the same restart
   *  the submission does; absent, the executed turn derives its
   *  recent turns from its model messages (the direct-turn path). */
  recentTurns?: Array<{ role?: string; content: string }>;
  /** The caller's auto-options-research determination. The
   *  executed turn also derives this from the source tab; the
   *  explicit flag is carried (same metadata adoption) so a caller
   *  that determined it out-of-band is honored exactly as the
   *  facet drive honored it. */
  isAutoOptionsResearchRequest?: boolean;
  /** The originating UI tab, for options-research audit context. */
  sourceTab?: string;
  /**
   * Explicit idempotency key: a re-submission with the same key
   * returns the original submission's outcome instead of executing
   * a second turn. Absent, every call is a fresh submission (the
   * historical re-send behavior: a re-POSTed history tail runs a
   * fresh turn without duplicating the user message or record).
   */
  submissionKey?: string;
}

export interface SubmittedTurnHandle {
  submissionId: string;
  /** The request id the route outcome is recorded under — for a
   *  deduped submission this is the ORIGINAL turn's request id,
   *  read back from the submission's own metadata. */
  requestId: string;
  epoch: number;
}

/**
 * The submit half of the driver: persist the user message into the
 * canonical port transcript and the turn into Think's durable
 * submission queue. Split from the wait half so the durability is
 * usable (and testable) on its own: once this resolves, the turn
 * survives the instance.
 *
 * Identity carriage: the user message's metadata carries the
 * verified acting login and source tab — the executed turn's
 * portBeforeTurn derives its stash from exactly that metadata (the
 * deriveTurn path direct Think turns already use), so the mesh
 * identity stamping that reads the stash keeps working unchanged.
 */
export async function submitChatTurn(
  ctx: DurableTurnContext,
  opts: SubmitChatTurnOptions
): Promise<SubmittedTurnHandle> {
  const epoch = ctx.turnEpoch();
  const existing = await ctx.getPortMessages();
  const tailUser = [...existing].reverse().find((m: any) => m?.role === "user");
  const isResend = !!tailUser && ctx.extractMessageText(tailUser) === opts.userText;
  const requestId = crypto.randomUUID();
  const userMessage = {
    id: isResend ? (tailUser as any).id : crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: opts.userText }],
    metadata: {
      userLogin: opts.userLogin,
      ...(opts.sourceTab ? { sourceTab: opts.sourceTab } : {}),
      ...(opts.recentTurns && opts.recentTurns.length > 0 ? { recentTurns: opts.recentTurns } : {}),
      ...(opts.isAutoOptionsResearchRequest ? { autoOptionsResearch: true } : {}),
      turnRequestId: requestId,
      ...(isResend ? { suppressUserRecord: true } : {}),
    },
  };
  // Upsert-by-id: a fresh message joins the tail; a re-send
  // refreshes the tail message's metadata in place (the new
  // turnRequestId + record suppression), never a second copy.
  await ctx.addPortMessages([userMessage as any]);
  const submission = await ctx.submitMessages([userMessage], {
    ...(opts.submissionKey ? { idempotencyKey: opts.submissionKey } : {}),
    metadata: { turnRequestId: requestId },
  });
  ctx.markSubmittedTurnActive({ submissionId: submission.submissionId, epoch });
  const correlatedRequestId =
    typeof (submission.metadata as { turnRequestId?: unknown } | undefined)?.turnRequestId === "string"
      ? ((submission.metadata as { turnRequestId: string }).turnRequestId as string)
      : requestId;
  return { submissionId: submission.submissionId, requestId: correlatedRequestId, epoch };
}

/**
 * The wait half of the driver: block on the submission until it
 * settles, then shape the {result, route} the routes have always
 * returned. The SDK wait is memory-bound (it rejects if the object
 * restarts); the submission is not — on a rejected wait the driver
 * re-inspects and re-waits a bounded number of times, since calling
 * waitForSubmission again is the SDK's documented recovery.
 */
export async function awaitChatTurnSubmission(
  ctx: DurableTurnContext,
  handle: SubmittedTurnHandle
): Promise<{ result: { text: string }; route: RouteDecision }> {
  const fallbackRoute: RouteDecision = {
    agent: "search",
    confidence: 0,
    reason: "Turn completed without a recorded route decision.",
    needsConfirmation: false,
  };
  try {
    let inspection: ThinkSubmissionInspection | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        inspection = await ctx.waitForSubmission(handle.submissionId);
      } catch {
        inspection = await ctx.inspectSubmission(handle.submissionId).catch(() => null);
      }
      if (!inspection) break;
      if (inspection.status !== "pending" && inspection.status !== "running") break;
    }
    const route = ctx.submittedTurnRoutes.get(handle.requestId) ?? fallbackRoute;
    if (!inspection) {
      throw new Error("Submitted chat turn could not be inspected after submission.");
    }
    if (inspection.status === "error") {
      throw new Error(inspection.error ?? "Submitted chat turn failed.");
    }
    if (inspection.status !== "completed") {
      // Aborted (memory reset / cancellation) or skipped (no model
      // run): the retired facet drive's shape for a turn that
      // produced no message — empty text, route kept. The route's
      // caller maps a thrown error to the degraded fallback; a
      // settled-but-empty turn is not an error.
      return { result: { text: "" }, route };
    }
    let text = "";
    if (inspection.messageId) {
      const thinkMessages = await ctx.getThinkMessages();
      const assistant = thinkMessages.find(
        (m: any) => m && typeof m === "object" && m.id === inspection.messageId
      );
      if (assistant) {
        text = ctx.extractMessageText(assistant);
        // Mirror into the canonical port transcript (upsert-by-id)
        // — unless a memory reset landed mid-turn: a stale turn's
        // message must not reappear in the cleared transcript (the
        // #1738 epoch rule the facet wrapper enforced).
        if (ctx.turnEpoch() === handle.epoch) {
          await ctx.addPortMessages([assistant as UiChatMessage]);
        } else {
          return { result: { text: "" }, route };
        }
      }
    }
    return { result: { text }, route };
  } finally {
    ctx.markSubmittedTurnSettled(handle.submissionId);
  }
}
