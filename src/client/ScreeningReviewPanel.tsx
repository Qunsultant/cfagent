/**
 * ScreeningReviewPanel — consolidation C2 (issue #1246, epic #1151),
 * challenger inbox since #1257.
 *
 * The hub's proposal review inbox: everything the autonomous
 * screening system proposes, in one place, with the decision actions
 * wired to the endpoints that already govern them —
 *
 *  - Challengers (the champion/challenger gate, #1140): evaluate on
 *    the frozen set (walk-forward, holdout decides), run the gate for
 *    its verdict, approve or reject directly (recording an approval
 *    IS the decision — there is no pending-request step), then
 *    promote or roll back. No action here bypasses that flow: the
 *    buttons call the same endpoints, with the same governance (no
 *    self-promotion; the promoter must be the approver of record;
 *    promotion applies only through the audited seam). Challengers
 *    are generated from re-selection proposals, never invented here.
 *  - Goal proposals (Phase 0 store): goals the discovery pass
 *    persisted as proposed-only. Activate / dismiss go through
 *    POST /api/screening/goals/decide, which moves only proposed
 *    goals, tenant-scoped, and logs the decision.
 *  - Strategy-bank re-selection proposals (Phase 3): the nightly
 *    transparency log — read-only here on purpose. Their governance
 *    is proposal_only_not_promoted: promotion runs through the
 *    champion/challenger gate above, never from this list.
 *  - Strategy weights (read path): the current weights and the
 *    policy evaluation behind them, shown for context.
 *
 * Fail-soft per section (the ScreeningActivityPanel idiom): a
 * section whose API is unavailable says so; nothing is fabricated.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./apiFetch";
import { Button, PageSection, PageShell } from "./components/ui";

interface ChallengerView {
  id: string;
  kind: string;
  title: string;
  regime: string | null;
  spec: {
    weights?: Record<string, number>;
    activeStrategies?: string[];
    ranking?: string[];
    retireStrategy?: string;
  };
  criteria: { minHoldoutEdge: number; minEvaluated: number };
  evalSetVersion: string;
  sourceProposalId: string | null;
  status: string;
  evaluation: {
    datasetVersion: string;
    evaluatedAt: string;
    selection: { championScore: number | null; challengerScore: number | null; evaluated: number };
    holdout: { championScore: number | null; challengerScore: number | null; evaluated: number };
    verdict: "pass" | "fail";
  } | null;
  createdBy: string;
  createdAt: string;
}

interface EvaluationView {
  datasetVersion: string;
  evaluatedAt: string;
  selection: { championScore: number | null; challengerScore: number | null; evaluated: number };
  holdout: { championScore: number | null; challengerScore: number | null; evaluated: number };
  verdict: "pass" | "fail";
  criteria: { minHoldoutEdge: number; minEvaluated: number };
}

interface ApprovalView {
  id: string;
  challengerId: string;
  approver: string;
  decision: "approved" | "rejected";
  createdAt: string;
}

interface VerdictView {
  id: string;
  challengerId: string;
  passed: boolean;
  reasons: string[];
  evaluatedAt: string;
}

interface PromotionView {
  action: string;
  prior: unknown;
  applied: unknown;
  actor: string;
  reason: string | null;
}

interface GoalView {
  id: string;
  kind: string;
  title: string;
  status: string;
  source: string;
  createdAt: string;
  scenarios: Array<{ id: string; status: string }>;
}

interface ReselectionView {
  id: string;
  regime: string;
  createdAt: string;
  proposal: {
    governance: string;
    overallWinRate: number | null;
    activeSet: Array<{ strategy: string }>;
    evaluatedCount: number;
    costUnitsUsed: number;
    costCapUnits: number;
  };
}

interface WeightsView {
  weights: Record<string, number>;
  evaluation: {
    unweightedWinRate: number | null;
    weightedWinRate: number | null;
    proposals: unknown[];
    lowSample: string[];
  } | null;
}

interface ChallengerDetail {
  evaluations: EvaluationView[];
  approvals: ApprovalView[];
  verdicts: VerdictView[];
  promotions: PromotionView[];
}

const boxStyle: React.CSSProperties = {
  margin: "0 0 1rem",
  padding: "var(--space-4) var(--space-5)",
  background: "var(--color-surface-sunken)",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "8px",
};

const muted: React.CSSProperties = { color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" };
const bodyText: React.CSSProperties = { color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)", lineHeight: 1.5 };

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function metric(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(3);
}

function specSummary(challenger: ChallengerView): string {
  const spec = challenger.spec;
  if (spec.weights && Object.keys(spec.weights).length > 0) {
    return `Target weights: ${Object.entries(spec.weights).map(([s, w]) => `${s} → ${w}`).join(", ")}.`;
  }
  if (spec.activeStrategies && spec.activeStrategies.length > 0) {
    return `Target active set: ${spec.activeStrategies.join(", ")}.`;
  }
  if (spec.ranking && spec.ranking.length > 0) {
    return `Target ranking: ${spec.ranking.join(" › ")}.`;
  }
  if (spec.retireStrategy) {
    return `Retire strategy: ${spec.retireStrategy}.`;
  }
  return "No spec recorded.";
}

export function ScreeningReviewPanel({ userLogin }: { userLogin?: string }) {
  const [candidates, setCandidates] = useState<ChallengerView[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [weights, setWeights] = useState<WeightsView | null>(null);
  const [weightsError, setWeightsError] = useState(false);
  const [goals, setGoals] = useState<GoalView[] | null>(null);
  const [goalsError, setGoalsError] = useState<string | null>(null);
  const [reselection, setReselection] = useState<ReselectionView[] | null>(null);
  const [reselectionError, setReselectionError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ChallengerDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const headers = useCallback((): Record<string, string> => {
    return {
      "Content-Type": "application/json",
      ...(userLogin ? { "x-user-login": userLogin } : {}),
    };
  }, [userLogin]);

  const loadCandidates = useCallback(async () => {
    try {
      const res = await apiFetch("/api/adaptation/candidates", { headers: headers() });
      if (!res.ok) throw new Error("candidates unavailable");
      const body = (await res.json()) as { candidates?: ChallengerView[] };
      setCandidates(Array.isArray(body.candidates) ? body.candidates : []);
      setCandidatesError(null);
    } catch {
      setCandidatesError("Challengers are unavailable right now.");
    }
  }, [headers]);

  const loadWeights = useCallback(async () => {
    try {
      const res = await apiFetch("/api/adaptation/weights", { headers: headers() });
      if (!res.ok) throw new Error("weights unavailable");
      const body = (await res.json()) as WeightsView;
      setWeights(body);
      setWeightsError(false);
    } catch {
      setWeightsError(true);
    }
  }, [headers]);

  const loadGoals = useCallback(async () => {
    try {
      const res = await apiFetch("/api/screening/goals?status=proposed", { headers: headers() });
      if (!res.ok) throw new Error("goals unavailable");
      const body = (await res.json()) as { goals?: GoalView[] };
      setGoals(Array.isArray(body.goals) ? body.goals : []);
      setGoalsError(null);
    } catch {
      setGoalsError("Goal proposals are unavailable right now.");
    }
  }, [headers]);

  const loadReselection = useCallback(async () => {
    try {
      const res = await apiFetch("/api/screening/reselection-proposals", { headers: headers() });
      if (!res.ok) throw new Error("reselection unavailable");
      const body = (await res.json()) as { proposals?: ReselectionView[] };
      setReselection(Array.isArray(body.proposals) ? body.proposals : []);
      setReselectionError(null);
    } catch {
      setReselectionError("Re-selection proposals are unavailable right now.");
    }
  }, [headers]);

  const loadDetail = useCallback(
    async (candidateId: string) => {
      const [evaluations, approvals, verdicts, promotions] = await Promise.all([
        apiFetch(`/api/adaptation/candidates/evaluations?candidateId=${encodeURIComponent(candidateId)}`, { headers: headers() })
          .then(async (r) => ((await r.json()) as { evaluations?: EvaluationView[] }).evaluations ?? [])
          .catch(() => [] as EvaluationView[]),
        apiFetch(`/api/adaptation/candidates/approvals?candidateId=${encodeURIComponent(candidateId)}`, { headers: headers() })
          .then(async (r) => ((await r.json()) as { approvals?: ApprovalView[] }).approvals ?? [])
          .catch(() => [] as ApprovalView[]),
        apiFetch(`/api/adaptation/candidates/verdicts?candidateId=${encodeURIComponent(candidateId)}`, { headers: headers() })
          .then(async (r) => ((await r.json()) as { verdicts?: VerdictView[] }).verdicts ?? [])
          .catch(() => [] as VerdictView[]),
        apiFetch(`/api/adaptation/promotions?candidateId=${encodeURIComponent(candidateId)}`, { headers: headers() })
          .then(async (r) => ((await r.json()) as { promotions?: PromotionView[] }).promotions ?? [])
          .catch(() => [] as PromotionView[]),
      ]);
      setDetail({ evaluations, approvals, verdicts, promotions });
    },
    [headers],
  );

  useEffect(() => {
    void loadCandidates();
    void loadWeights();
    void loadGoals();
    void loadReselection();
  }, [loadCandidates, loadWeights, loadGoals, loadReselection]);

  const post = useCallback(
    async (path: string, body: unknown): Promise<any> => {
      const res = await apiFetch(path, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : `Request failed (${res.status}).`);
      }
      return data;
    },
    [headers],
  );

  const runAction = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      if (busy) return;
      setBusy(true);
      setActionError(null);
      setActionMessage(null);
      try {
        setActionMessage(await fn());
      } catch (err) {
        setActionError(err instanceof Error ? err.message : `${label} failed.`);
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const openCandidate = async (candidateId: string) => {
    if (selectedId === candidateId) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    setSelectedId(candidateId);
    setDetail(null);
    setActionMessage(null);
    setActionError(null);
    await loadDetail(candidateId);
  };

  const latestVerdict = detail?.verdicts[0];
  const latestEvaluation = detail?.evaluations[0];

  return (
    <PageShell
      title="Proposal Review"
      scopeNote="Everything the screening system proposes — challengers, discovered goals, and strategy-bank re-selections — decided here, through the same governed endpoints that produced them. Nothing activates, promotes, or trades without a recorded human decision."
    >
      {actionMessage && (
        <p role="status" style={{ margin: "0 0 0.75rem", color: "var(--color-success)", fontSize: "var(--font-size-body)" }}>
          {actionMessage}
        </p>
      )}
      {actionError && (
        <p role="alert" style={{ margin: "0 0 0.75rem", color: "var(--color-danger)", fontSize: "var(--font-size-body)" }}>
          {actionError}
        </p>
      )}

      {/* ---------------- Challengers ---------------- */}
      <PageSection title="Challengers">
      <div style={boxStyle}>
        <p style={{ margin: "0 0 0.75rem", ...muted }}>
          Proposed changes to weights, the active set, or a ranking, each judged on a frozen
          evaluation set. The governed path: evaluate (walk-forward, holdout decides) → gate
          verdict → human approval → promote or roll back. Recording an approval IS the
          decision — there is no pending-request step — and the promoter must be the approver
          of record. Staged promotions are retired; in-flight ones drain via the API.
        </p>
        <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: "0.75rem" }}>
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void runAction("Generate challengers", async () => {
                const data = await post("/api/adaptation/candidates/generate", {});
                await loadCandidates();
                const created = Array.isArray(data.created) ? data.created.length : 0;
                const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
                return `Generated ${created} challenger${created === 1 ? "" : "s"} from re-selection proposals (${skipped} skipped).`;
              })
            }
          >
            Generate challengers from proposals
          </Button>
        </div>
        {candidatesError && (
          <p style={muted}>
            {candidatesError}{" "}
            <Button variant="secondary" size="sm" onClick={() => void loadCandidates()}>
              Retry
            </Button>
          </p>
        )}
        {candidates !== null && candidates.length === 0 && !candidatesError && (
          <p style={muted}>No challengers are waiting for review.</p>
        )}
        {candidates?.map((challenger) => (
          <div
            key={challenger.id}
            style={{
              padding: "var(--space-3) 0",
              borderTop: "1px solid var(--color-border-subtle)",
            }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "baseline" }}>
              <strong style={{ color: "var(--color-text-primary)", fontSize: "var(--font-size-body)" }}>
                {challenger.title}
              </strong>
              <span style={muted}>
                {challenger.kind} · {challenger.regime ?? "no regime"} · status: {challenger.status}
              </span>
            </div>
            <p style={{ margin: "0.35rem 0 0.5rem", ...bodyText }}>{specSummary(challenger)}</p>
            <p style={{ margin: "0 0 0.5rem", ...muted }}>
              Frozen set {challenger.evalSetVersion} · criteria: holdout edge ≥ {challenger.criteria.minHoldoutEdge},
              holdout evaluated ≥ {challenger.criteria.minEvaluated} · created by {challenger.createdBy} ·{" "}
              {new Date(challenger.createdAt).toLocaleString()}
            </p>
            <Button type="button" onClick={() => void openCandidate(challenger.id)} disabled={busy}>
              {selectedId === challenger.id ? "Close review" : "Review challenger"}
            </Button>

            {selectedId === challenger.id && detail && (
              <div style={{ marginTop: "0.75rem" }}>
                <p style={{ margin: "0 0 0.35rem", ...bodyText }}>
                  <strong>Latest evaluation:</strong>{" "}
                  {latestEvaluation
                    ? `frozen set ${latestEvaluation.datasetVersion} — selection champion ${metric(latestEvaluation.selection.championScore)} vs challenger ${metric(latestEvaluation.selection.challengerScore)}; holdout champion ${metric(latestEvaluation.holdout.championScore)} vs challenger ${metric(latestEvaluation.holdout.challengerScore)} (n=${latestEvaluation.holdout.evaluated}) → ${latestEvaluation.verdict}`
                    : "none recorded yet."}
                </p>
                <p style={{ margin: "0 0 0.5rem", ...bodyText }}>
                  <strong>Gate verdict:</strong>{" "}
                  {latestVerdict
                    ? `${latestVerdict.passed ? "PASSED" : "FAILED"} — ${latestVerdict.reasons.join("; ") || "no reasons recorded"}`
                    : "not run yet."}
                </p>

                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "0.5rem" }}>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runAction("Evaluation", async () => {
                        const data = await post("/api/adaptation/candidates/evaluate", { candidateId: challenger.id });
                        await loadDetail(challenger.id);
                        const ev = data.evaluation as EvaluationView;
                        return `Evaluation recorded: verdict ${ev.verdict} — holdout challenger ${metric(ev.holdout.challengerScore)} vs champion ${metric(ev.holdout.championScore)} (n=${ev.holdout.evaluated}).`;
                      })
                    }
                  >
                    Evaluate challenger
                  </Button>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runAction("Gate", async () => {
                        const data = await post("/api/adaptation/candidates/gate", { candidateId: challenger.id });
                        await loadDetail(challenger.id);
                        await loadCandidates();
                        return `Gate verdict: ${data.verdict?.passed ? "PASSED" : "FAILED"} — ${(data.verdict?.reasons ?? []).join("; ")}`;
                      })
                    }
                  >
                    Run promotion gate
                  </Button>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runAction("Decision", async () => {
                        const data = await post("/api/adaptation/candidates/approve", { candidateId: challenger.id, decision: "approved" });
                        await loadDetail(challenger.id);
                        if (data.success === false) {
                          throw new Error(typeof data.reason === "string" ? data.reason : "Approval could not be recorded.");
                        }
                        return "Approval recorded as approved.";
                      })
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runAction("Decision", async () => {
                        const data = await post("/api/adaptation/candidates/approve", { candidateId: challenger.id, decision: "rejected" });
                        await loadDetail(challenger.id);
                        if (data.success === false) {
                          throw new Error(typeof data.reason === "string" ? data.reason : "Approval could not be recorded.");
                        }
                        return "Approval recorded as rejected.";
                      })
                    }
                  >
                    Reject
                  </Button>
                  {challenger.status === "evaluated" && (
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void runAction("Promote", async () => {
                          const data = await post("/api/adaptation/promotions/promote", { candidateId: challenger.id });
                          await loadDetail(challenger.id);
                          await loadCandidates();
                          if (data.success === false) {
                            throw new Error(typeof data.reason === "string" ? data.reason : "Promotion could not be applied.");
                          }
                          return "Challenger promoted.";
                        })
                      }
                    >
                      Promote challenger
                    </Button>
                  )}
                  {challenger.status === "promoted" && (
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void runAction("Rollback", async () => {
                          const data = await post("/api/adaptation/promotions/rollback", { candidateId: challenger.id });
                          await loadDetail(challenger.id);
                          await loadCandidates();
                          if (data.success === false) {
                            throw new Error(typeof data.reason === "string" ? data.reason : "Rollback could not be applied.");
                          }
                          return "Promotion rolled back.";
                        })
                      }
                    >
                      Roll back promotion
                    </Button>
                  )}
                </div>

                {detail.approvals.length > 0 && (
                  <ul style={{ margin: "0 0 0.5rem", paddingLeft: "var(--space-4)" }}>
                    {detail.approvals.map((a) => (
                      <li key={a.id} style={muted}>
                        Approval {a.decision} by {a.approver}
                        {` · ${new Date(a.createdAt).toLocaleString()}`}
                      </li>
                    ))}
                  </ul>
                )}

                {detail.promotions.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: "var(--space-4)" }}>
                    {detail.promotions.map((promotion, i) => (
                      <li key={`${promotion.action}-${i}`} style={{ ...bodyText, marginBottom: "0.35rem" }}>
                        Promotion record: <strong>{promotion.action}</strong> by {promotion.actor}
                        {promotion.reason ? ` — ${promotion.reason}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      </PageSection>

      {/* ---------------- Goal proposals ---------------- */}
      <PageSection title="Goal proposals">
      <div style={boxStyle}>
        <p style={{ margin: "0 0 0.75rem", ...muted }}>
          Goals the discovery pass persisted as proposals. Activating one makes it a live goal for
          goal-driven screens; dismissing archives it. Only proposed goals can be decided, and the
          decision is written to the screening activity log.
        </p>
        {goalsError && (
          <p style={muted}>
            {goalsError}{" "}
            <Button variant="secondary" size="sm" onClick={() => void loadGoals()}>
              Retry
            </Button>
          </p>
        )}
        {goals !== null && goals.length === 0 && !goalsError && (
          <p style={muted}>No proposed goals are waiting.</p>
        )}
        {goals?.map((goal) => (
          <div key={goal.id} style={{ padding: "var(--space-3) 0", borderTop: "1px solid var(--color-border-subtle)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "baseline" }}>
              <strong style={{ color: "var(--color-text-primary)", fontSize: "var(--font-size-body)" }}>{goal.title}</strong>
              <span style={muted}>
                {goal.kind} · from {goal.source} · {goal.scenarios.length} scenario
                {goal.scenarios.length === 1 ? "" : "s"} · {new Date(goal.createdAt).toLocaleString()}
              </span>
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "0.5rem" }}>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void runAction("Goal decision", async () => {
                    await post("/api/screening/goals/decide", { id: goal.id, decision: "activate" });
                    await loadGoals();
                    return `Goal '${goal.title}' activated.`;
                  })
                }
              >
                Activate goal
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void runAction("Goal decision", async () => {
                    await post("/api/screening/goals/decide", { id: goal.id, decision: "dismiss" });
                    await loadGoals();
                    return `Goal '${goal.title}' dismissed (archived).`;
                  })
                }
              >
                Dismiss
              </Button>
            </div>
          </div>
        ))}
      </div>
      </PageSection>

      {/* ---------------- Re-selection proposals ---------------- */}
      <PageSection title="Strategy-bank re-selection proposals">
      <div style={boxStyle}>
        <p style={{ margin: "0 0 0.75rem", ...muted }}>
          Governance: proposal only — not promoted. The nightly re-selection records what it would
          run; promotion happens only through the champion/challenger gate above. There is
          deliberately no action on this list.
        </p>
        {reselectionError && (
          <p style={muted}>
            {reselectionError}{" "}
            <Button variant="secondary" size="sm" onClick={() => void loadReselection()}>
              Retry
            </Button>
          </p>
        )}
        {reselection !== null && reselection.length === 0 && !reselectionError && (
          <p style={muted}>No re-selection proposals recorded yet.</p>
        )}
        {reselection?.map((row) => (
          <div key={row.id} style={{ padding: "var(--space-3) 0", borderTop: "1px solid var(--color-border-subtle)" }}>
            <p style={{ margin: 0, ...bodyText }}>
              <strong>{row.regime}</strong> regime · overall win rate {pct(row.proposal.overallWinRate)} ·{" "}
              {row.proposal.evaluatedCount} evaluated · cost {row.proposal.costUnitsUsed}/
              {row.proposal.costCapUnits} units · {new Date(row.createdAt).toLocaleString()}
            </p>
            <p style={{ margin: "0.35rem 0 0", ...muted }}>
              Proposed active set:{" "}
              {row.proposal.activeSet.map((a) => a.strategy).join(", ") || "none"}
            </p>
          </div>
        ))}
      </div>
      </PageSection>

      {/* ---------------- Strategy weights ---------------- */}
      <PageSection title="Strategy weights">
      <div style={boxStyle}>
        {weightsError && (
          <>
            <p style={muted}>Strategy weights are unavailable right now (the research agent read path did not answer).</p>
            <Button variant="secondary" size="sm" onClick={() => void loadWeights()}>
              Retry
            </Button>
          </>
        )}
        {weights && (
          <>
            <p style={{ margin: "0 0 0.5rem", ...bodyText }}>
              Weighted win rate {pct(weights.evaluation?.weightedWinRate)} vs unweighted{" "}
              {pct(weights.evaluation?.unweightedWinRate)}.
              {weights.evaluation && weights.evaluation.lowSample.length > 0
                ? ` Low-sample (read with care): ${weights.evaluation.lowSample.join(", ")}.`
                : ""}
            </p>
            <ul style={{ margin: 0, paddingLeft: "var(--space-4)" }}>
              {Object.entries(weights.weights).map(([strategy, weight]) => (
                <li key={strategy} style={muted}>
                  {strategy}: {weight}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      </PageSection>
    </PageShell>
  );
}
