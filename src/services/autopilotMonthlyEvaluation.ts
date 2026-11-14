/**
 * Issue #4411 — the monthly Autopilot evaluation's production path.
 *
 * The monthly schedule (DEFAULT_SCHEDULES `autopilot-monthly-evaluation`,
 * operation `autopilot.evaluate`) calls the existing
 * POST /api/autopilot/evaluate path on the OrchestratorAgent — the same
 * endpoint the manual Run Policy Check button calls — with the same
 * representative dry-run intent the button sends when no universe symbol
 * is configured (first universe symbol, SPY fallback, BUY 10 MARKET,
 * dryRun); see AutopilotControlCenter.tsx:696. The evaluation only
 * checks the live policy envelope against live limits and live account
 * state; it never places orders (dryRun: true, and the endpoint itself
 * only evaluates).
 *
 * Fail-visible contract (the feed-job rule): every failure mode returns
 * `{ ok: false, error }` and the goal stays due for its next monthly
 * tick — no silent no-op, no substituted identity, no invented verdict.
 * The caller (ScheduledAgent.onCron) records the error as a tick error
 * and a skipped run.
 */

/** The caller id the scheduled run stamps on its evaluate request. */
export const AUTOPILOT_MONTHLY_EVALUATION_REQUESTED_BY =
  "autopilot-monthly-schedule";

/**
 * The representative dry-run intent the monthly check evaluates — the
 * button's fallback shape (SPY, BUY 10, MARKET, dryRun), so the
 * scheduled verdict is directly comparable to a manual Run Policy Check.
 */
export const AUTOPILOT_MONTHLY_EVALUATION_INTENT = {
  symbol: "SPY",
  action: "BUY",
  quantity: 10,
  orderType: "MARKET",
  dryRun: true,
} as const;

/** The OrchestratorAgent evaluate endpoint, reached via its DO stub fetch. */
export const AUTOPILOT_EVALUATE_URL =
  "https://agent.internal/api/autopilot/evaluate";

export interface AutopilotMonthlyEvaluationResult {
  ok: boolean;
  /** Verdict id from the orchestrator, when the evaluation ran. */
  verdictId?: string;
  /** Whether the live envelope passed the dry-run check. */
  passed?: boolean;
  /** Binding rule when the check blocked, null when it passed. */
  bindingRule?: string | null;
  /** Human-readable success descriptor for the run record. */
  descriptor?: string;
  /** Failure reason when ok is false. */
  error?: string;
}

export async function runAutopilotMonthlyEvaluation(input: {
  /** The configured service identity, or null when none is configured. */
  serviceLogin: string | null;
  /** The OrchestratorAgent stub fetch, or null when the binding is absent. */
  evaluateFetch: ((req: Request) => Promise<Response>) | null;
}): Promise<AutopilotMonthlyEvaluationResult> {
  if (!input.serviceLogin) {
    return {
      ok: false,
      error:
        "no service identity configured (SERVICE_USER_LOGIN) — monthly Autopilot evaluation skipped, goal left due",
    };
  }
  if (!input.evaluateFetch) {
    return {
      ok: false,
      error:
        "ORCHESTRATOR_AGENT binding unavailable — monthly Autopilot evaluation skipped, goal left due",
    };
  }
  let response: Response;
  try {
    response = await input.evaluateFetch(
      new Request(AUTOPILOT_EVALUATE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-login": input.serviceLogin,
        },
        body: JSON.stringify({
          ...AUTOPILOT_MONTHLY_EVALUATION_INTENT,
          requestedBy: AUTOPILOT_MONTHLY_EVALUATION_REQUESTED_BY,
        }),
      }),
    );
  } catch (err) {
    return {
      ok: false,
      error: `evaluate endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: `evaluate endpoint refused: HTTP ${response.status}`,
    };
  }
  const body = (await response.json().catch(() => ({}))) as {
    verdict?: { id?: unknown; passed?: unknown; bindingRule?: unknown };
  };
  const verdict = body.verdict;
  if (!verdict || typeof verdict.id !== "string") {
    return { ok: false, error: "evaluate endpoint returned no verdict" };
  }
  const passed = verdict.passed === true;
  const bindingRule =
    typeof verdict.bindingRule === "string" ? verdict.bindingRule : null;
  return {
    ok: true,
    verdictId: verdict.id,
    passed,
    bindingRule,
    descriptor: `monthly policy check: verdict ${verdict.id} — ${passed ? "passed" : "blocked"}${bindingRule ? ` (${bindingRule})` : ""}`,
  };
}
