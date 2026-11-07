import { getActiveLearnings, recordLearning } from "./learnings";
import { createEvidenceSatellitePorts } from "../data/createEvidenceSatellitePorts";
import type { StrategyCandidateReview } from "../data/strategyReviewPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/reflection",
});

/** Step 4c (#2356): reflection's strategy-review reads/writes go
 *  through the evidence-satellite port (composition root), not
 *  the legacy store functions. Its learnings calls are NOT
 *  ported — mas_learnings is gated on audit R-1 and stays on
 *  the legacy seam until that question is answered. */
function listStrategyReviews(sql: any, decision?: string): StrategyCandidateReview[] {
  return createEvidenceSatellitePorts(sql).strategyReviews.list(decision);
}

function recordStrategyCandidates(
  sql: any,
  symbol: string,
  candidates: Array<{ id: string; label: string; rank: number; rationale: string; quantStatus: string }>,
): void {
  createEvidenceSatellitePorts(sql).strategyReviews.recordCandidates(symbol, candidates);
}

/**
 * Issue #705: scheduled reflection job — the agent reads its own track record.
 *
 * Runs weekly (or on demand). Reads outcomes + calibration + review decisions,
 * computes per-domain performance deltas, and writes reflection records as
 * learnings. Proposed behavioral adjustments go through HITL before taking
 * effect — the agent proposes, the human disposes.
 *
 * Failure handling (issue #784): persistence failures are never silent.
 * Every store operation that fails is logged via console.error with
 * context, and failures are counted onto the run result — failed learning
 * writes in `learningsFailed`, failed analysis sections in
 * `analysisFailures` (both present only when > 0, so the happy-path
 * result shape is unchanged). The already-ran guard fails OPEN by
 * deliberate choice: if the guard read fails we log it and run anyway —
 * failing closed would silently disable the learning loop for as long as
 * the read is broken, the same silent-loss class this handling exists to
 * prevent. A genuinely broken store still surfaces, because the run's
 * own writes then fail and are counted.
 */

export interface ReflectionFinding {
  domain: string;
  observation: string;
  evidenceRefs: string[];
  confidence: number;
  proposedAdjustment: string;
}

/** Reserved pseudo-symbol for reflection-proposed review candidates (#753). */
export const REFLECTION_REVIEW_SYMBOL = "REFLECTION";

/**
 * Issue #753: a finding is actionable for the strategy-review queue iff
 * one of its evidence refs names a concrete strategy family
 * (`mas_strategy_reviews:<family>`, not `:all`) — i.e. the boost /
 * down-weight findings. The overall-rate diagnostic and stale-learning
 * housekeeping propose process follow-ups, not strategy candidates,
 * and never enter the queue. Returns the family, or null.
 */
export function reflectionFindingFamily(f: ReflectionFinding): string | null {
  for (const ref of f.evidenceRefs) {
    const m = /^mas_strategy_reviews:(.+)$/.exec(ref);
    if (m && m[1] !== "all") return m[1];
  }
  return null;
}

/**
 * Issue #753: route actionable reflection findings into the #653 review
 * store as pending candidates, so the human gate sees them (the agent
 * proposes, the human disposes — nothing is auto-approved). Candidates
 * sit under the REFLECTION pseudo-symbol with their real family in the
 * label, so decision feedback aggregates under the family per #653's
 * design. The rationale carries the observation, the proposed
 * adjustment, the evidence refs, and the reflection confidence;
 * quant_status is honestly "unverified". Dedup: a still-pending
 * candidate for the same family is not duplicated. Best-effort per
 * finding — a store failure is logged and skipped, never thrown.
 * Returns the number of candidates created.
 */
export function createReflectionReviewCandidates(
  sql: any,
  findings: ReflectionFinding[]
): number {
  let created = 0;
  let pending: ReturnType<typeof listStrategyReviews> | null = null;
  for (const f of findings) {
    const family = reflectionFindingFamily(f);
    if (!family) continue;
    const candidateId = `reflection:${f.domain}:${family}`;
    try {
      if (pending === null) pending = listStrategyReviews(sql, "pending");
      if (
        pending.some(
          (r) => r.symbol === REFLECTION_REVIEW_SYMBOL && r.candidateId === candidateId
        )
      ) {
        continue;
      }
      recordStrategyCandidates(sql, REFLECTION_REVIEW_SYMBOL, [
        {
          id: candidateId,
          label: `${family} (reflection proposal)`,
          rank: 0,
          rationale:
            `${f.observation} Proposed: ${f.proposedAdjustment} | ` +
            `Evidence: ${f.evidenceRefs.join(", ")} | ` +
            `Reflection confidence: ${f.confidence.toFixed(2)}`,
          quantStatus: "unverified",
        },
      ]);
      created++;
      pending.push({
        id: "",
        symbol: REFLECTION_REVIEW_SYMBOL,
        candidateId,
        label: "",
        rank: 0,
        rationale: "",
        quantStatus: "unverified",
        decision: "pending",
        decidedAt: null,
        createdAt: "",
      });
    } catch (err) {
      structuredLog.error("reflection.review_candidate_create_failed", {
        message: `[Reflection] Failed to create review candidate for family "${family}"; finding remains recorded as a learning: ${err instanceof Error ? err.message : String(err)}`,
        family,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return created;
}

export function runReflection(
  sql: any,
  now: Date = new Date()
): {
  findings: ReflectionFinding[];
  learningsRecorded: number;
  learningsFailed?: number;
  analysisFailures?: number;
  reviewCandidatesCreated?: number;
  skipped?: string;
} {
  // Weekly guard: only fire on Sunday, and not if a reflection learning
  // was already recorded this week.
  if (now.getUTCDay() !== 0) {
    return { findings: [], learningsRecorded: 0, skipped: "not Sunday" };
  }
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - now.getUTCDay());
  weekStart.setUTCHours(0, 0, 0, 0);
  try {
    const recent = getActiveLearnings(sql, "reflection_meta");
    if (recent.length > 0 && new Date(recent[0].createdAt) >= weekStart) {
      return { findings: [], learningsRecorded: 0, skipped: "already ran this week" };
    }
  } catch (err) {
    // Deliberate fail-open (see header): proceed, but never silently.
    structuredLog.error("reflection.already_ran_guard_check_failed", {
      message: `[Reflection] Already-ran guard check failed; proceeding (fail-open by design, #784): ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const findings: ReflectionFinding[] = [];
  let analysisFailures = 0;

  // 1. Strategy review decisions → approval patterns.
  try {
    const reviews = listStrategyReviews(sql);
    const approved = reviews.filter((r) => r.decision === "approved");
    const rejected = reviews.filter((r) => r.decision === "rejected");
    if (approved.length + rejected.length >= 5) {
      const approvalRate = approved.length / (approved.length + rejected.length);
      // Group by label prefix (strategy family).
      const byFamily: Record<string, { a: number; r: number }> = {};
      for (const rev of reviews) {
        if (rev.decision !== "approved" && rev.decision !== "rejected") continue;
        const family = rev.label.split(" ")[0] || "unknown";
        byFamily[family] = byFamily[family] || { a: 0, r: 0 };
        if (rev.decision === "approved") byFamily[family].a++;
        else byFamily[family].r++;
      }
      for (const [family, counts] of Object.entries(byFamily)) {
        const total = counts.a + counts.r;
        if (total >= 3) {
          const rate = counts.a / total;
          if (rate >= 0.8) {
            findings.push({
              domain: "strategy_ranking",
              observation: `Strategy family "${family}" approved ${counts.a}/${total} times — consistently favored by human review.`,
              evidenceRefs: [`mas_strategy_reviews:${family}`],
              confidence: Math.min(0.9, 0.5 + total * 0.1),
              proposedAdjustment: `Boost "${family}" in LLM ranking priors.`,
            });
          } else if (rate <= 0.2) {
            findings.push({
              domain: "strategy_ranking",
              observation: `Strategy family "${family}" rejected ${counts.r}/${total} times — consistently disfavored by human review.`,
              evidenceRefs: [`mas_strategy_reviews:${family}`],
              confidence: Math.min(0.9, 0.5 + total * 0.1),
              proposedAdjustment: `Down-weight "${family}" in LLM ranking priors.`,
            });
          }
        }
      }
      if (approvalRate < 0.3 && approved.length + rejected.length >= 10) {
        findings.push({
          domain: "strategy_ranking",
          observation: `Overall approval rate ${(approvalRate * 100).toFixed(0)}% across ${approved.length + rejected.length} reviewed candidates — the quant pipeline may be misaligned with human judgment.`,
          evidenceRefs: ["mas_strategy_reviews:all"],
          confidence: 0.7,
          proposedAdjustment: "Review quant pipeline filters against rejected candidate characteristics.",
        });
      }
    }
  } catch (err) {
    analysisFailures++;
    structuredLog.error("reflection.strategy_review_analysis_failed", {
      message: `[Reflection] Strategy-review analysis failed; continuing without review findings: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Check for stale learnings that may need re-validation.
  try {
    const learnings = getActiveLearnings(sql);
    const now = Date.now();
    for (const l of learnings) {
      const ageDays = (now - new Date(l.createdAt).getTime()) / 86_400_000;
      if (ageDays > 90 && l.confidence < 0.6) {
        findings.push({
          domain: l.domain,
          observation: `Learning "${l.observation.slice(0, 60)}..." is ${Math.round(ageDays)} days old with low confidence (${l.confidence.toFixed(2)}) — may need re-validation or supersession.`,
          evidenceRefs: [`mas_learnings:${l.id}`],
          confidence: 0.6,
          proposedAdjustment: "Re-validate against recent outcomes or supersede.",
        });
      }
    }
  } catch (err) {
    analysisFailures++;
    structuredLog.error("reflection.stale_learning_analysis_failed", {
      message: `[Reflection] Stale-learning analysis failed; continuing without staleness findings: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Record findings as learnings (source: reflection).
  let learningsRecorded = 0;
  let learningsFailed = 0;
  for (const f of findings) {
    try {
      recordLearning(sql, {
        domain: f.domain,
        observation: `${f.observation} Proposed: ${f.proposedAdjustment}`,
        evidenceRefs: f.evidenceRefs,
        confidence: f.confidence,
        source: "reflection",
      });
      learningsRecorded++;
    } catch (err) {
      learningsFailed++;
      structuredLog.error("reflection.persist_learning_failed", {
        message: `[Reflection] Failed to persist learning (domain "${f.domain}", evidence ${f.evidenceRefs.join(", ") || "none"}): ${err instanceof Error ? err.message : String(err)}`,
        domain: f.domain,
        evidenceRefs: f.evidenceRefs,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3.5. Issue #753: route actionable findings into the strategy-review
  // queue so the human gate sees them. Best-effort by design (per-finding
  // failures are logged inside the wiring); a wiring-level failure is
  // logged here and never breaks the run — findings remain recorded as
  // learnings either way.
  let reviewCandidatesCreated = 0;
  try {
    reviewCandidatesCreated = createReflectionReviewCandidates(sql, findings);
  } catch (err) {
    structuredLog.error("reflection.review_candidate_wiring_failed", {
      message: `[Reflection] Review-candidate wiring failed; findings remain recorded as learnings: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 4. Record the run itself so next week's guard sees it. The persisted
  // summary counts only what landed; failures are named in it too when
  // any occurred, so the record itself never overclaims.
  let metaObservation = `Weekly reflection completed: ${findings.length} findings, ${learningsRecorded} learnings recorded.`;
  if (learningsFailed > 0 || analysisFailures > 0) {
    const parts: string[] = [];
    if (learningsFailed > 0) parts.push(`${learningsFailed} learning write(s) failed`);
    if (analysisFailures > 0) parts.push(`${analysisFailures} analysis section(s) failed`);
    metaObservation = `Weekly reflection completed: ${findings.length} findings, ${learningsRecorded} learnings recorded, ${parts.join(", ")}.`;
  }
  try {
    recordLearning(sql, {
      domain: "reflection_meta",
      observation: metaObservation,
      confidence: 1.0,
      source: "reflection",
    });
  } catch (err) {
    learningsFailed++;
    structuredLog.error("reflection.persist_run_meta_failed", {
      message: `[Reflection] Failed to persist the reflection run-meta learning; the already-ran guard will not see this run: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    findings,
    learningsRecorded,
    ...(learningsFailed > 0 ? { learningsFailed } : {}),
    ...(analysisFailures > 0 ? { analysisFailures } : {}),
    ...(reviewCandidatesCreated > 0 ? { reviewCandidatesCreated } : {}),
  };
}
