/**
 * Issue #753 — reflection → strategy-review wiring pins.
 *
 * runReflection (#705) computed findings and recorded them as learnings,
 * but nothing routed them into the strategy-review queue (#653): the
 * remember → reflect → review loop was open. These pins hold the wiring:
 *
 *  - A finding is actionable iff one of its evidence refs names a
 *    concrete strategy family (`mas_strategy_reviews:<family>`, not
 *    `:all`). Boost/down-weight findings qualify; the overall-rate
 *    diagnostic and stale-learning housekeeping do not.
 *  - Each actionable finding creates exactly one PENDING review in
 *    mas_strategy_reviews under the reserved REFLECTION pseudo-symbol,
 *    labelled with its real family (so decision feedback aggregates
 *    under the family, per #653's design), rationale carrying the
 *    observation, the proposed adjustment, the evidence refs, and the
 *    reflection confidence. quant_status is honestly "unverified".
 *  - Dedup: a still-pending candidate for the same family is not
 *    duplicated by a later reflection run.
 *  - The run result gains `reviewCandidatesCreated` only when > 0
 *    (the #784 optional-field convention); wiring failures are logged
 *    via console.error and never break the reflection run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runReflection,
  createReflectionReviewCandidates,
  type ReflectionFinding,
} from "../src/services/reflection";

const SUNDAY = new Date("2026-10-18T12:00:00.000Z");

function makeFakeSql(fail?: (text: string) => boolean) {
  const learnings: any[] = [];
  const reviews: any[] = [];
  const sql = {
    exec(text: string, ...params: any[]) {
      if (fail && fail(text)) throw new Error("injected store failure");
      if (/^\s*CREATE/i.test(text)) return [];
      if (/INSERT INTO mas_learnings/i.test(text)) {
        const [id, domain, observation, evidence_refs, confidence, source] = params;
        learnings.push({
          id, domain, observation, evidence_refs, confidence, source,
          created_at: new Date().toISOString(), superseded_by: null,
        });
        return [];
      }
      if (/FROM mas_learnings/i.test(text)) {
        let rows = learnings.filter((r) => r.superseded_by === null);
        const m = text.match(/domain = '([^']*)'/);
        if (m) rows = rows.filter((r) => r.domain === m[1]);
        rows = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return rows.map((r) => ({ ...r }));
      }
      if (/INSERT OR REPLACE INTO mas_strategy_reviews/i.test(text)) {
        const [id, symbol, candidate_id, label, rank, rationale, quant_status, created_at] = params;
        const row = {
          id, symbol, candidate_id, label, rank, rationale, quant_status,
          decision: "pending", decided_at: null, created_at,
        };
        const idx = reviews.findIndex((r) => r.id === id);
        if (idx >= 0) reviews[idx] = row;
        else reviews.push(row);
        return [];
      }
      if (/FROM mas_strategy_reviews/i.test(text)) {
        let rows = [...reviews];
        if (/decision = 'pending'/.test(text)) rows = rows.filter((r) => r.decision === "pending");
        return rows.map((r) => ({ ...r }));
      }
      return [];
    },
  };
  return { sql, learnings, reviews };
}

function seedApprovedReviews(reviews: any[], n: number, label = "Momentum breakout") {
  for (let i = 0; i < n; i++) {
    reviews.push({
      id: `rev_${i}`, symbol: "AAPL", candidate_id: `cand_${i}`, label,
      rank: i + 1, rationale: "test", quant_status: "verified",
      decision: "approved", decided_at: "2026-10-17T00:00:00.000Z",
      created_at: "2026-10-17T00:00:00.000Z",
    });
  }
}

const boostFinding: ReflectionFinding = {
  domain: "strategy_ranking",
  observation: 'Strategy family "Momentum" approved 4/5 times — consistently favored by human review.',
  evidenceRefs: ["mas_strategy_reviews:Momentum"],
  confidence: 0.9,
  proposedAdjustment: 'Boost "Momentum" in LLM ranking priors.',
};

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe("createReflectionReviewCandidates (#753)", () => {
  it("creates exactly one pending REFLECTION candidate for an actionable finding, evidence attached", () => {
    const { sql, reviews } = makeFakeSql();
    const created = createReflectionReviewCandidates(sql, [boostFinding]);
    expect(created).toBe(1);
    const pending = reviews.filter((r) => r.decision === "pending");
    expect(pending).toHaveLength(1);
    const row = pending[0];
    expect(row.symbol).toBe("REFLECTION");
    expect(row.candidate_id).toBe("reflection:strategy_ranking:Momentum");
    expect(row.label).toBe("Momentum (reflection proposal)");
    expect(row.quant_status).toBe("unverified");
    expect(row.rationale).toContain("approved 4/5 times");
    expect(row.rationale).toContain('Boost "Momentum" in LLM ranking priors.');
    expect(row.rationale).toContain("mas_strategy_reviews:Momentum");
    expect(row.rationale).toContain("0.90");
  });

  it("dedups against a still-pending candidate for the same family", () => {
    const { sql, reviews } = makeFakeSql();
    expect(createReflectionReviewCandidates(sql, [boostFinding])).toBe(1);
    expect(createReflectionReviewCandidates(sql, [boostFinding])).toBe(0);
    expect(reviews.filter((r) => r.symbol === "REFLECTION")).toHaveLength(1);
  });

  it("ignores non-actionable findings (overall-rate diagnostic, stale learnings)", () => {
    const { sql, reviews } = makeFakeSql();
    const diagnostic: ReflectionFinding = {
      domain: "strategy_ranking",
      observation: "Overall approval rate 20% across 12 reviewed candidates.",
      evidenceRefs: ["mas_strategy_reviews:all"],
      confidence: 0.7,
      proposedAdjustment: "Review quant pipeline filters against rejected candidate characteristics.",
    };
    const stale: ReflectionFinding = {
      domain: "screener",
      observation: 'Learning "x..." is 120 days old with low confidence (0.40).',
      evidenceRefs: ["mas_learnings:learn_1"],
      confidence: 0.6,
      proposedAdjustment: "Re-validate against recent outcomes or supersede.",
    };
    expect(createReflectionReviewCandidates(sql, [diagnostic, stale])).toBe(0);
    expect(reviews).toHaveLength(0);
  });
});

describe("runReflection wiring (#753)", () => {
  it("a Sunday run with an approved family creates the candidate and reports the count", () => {
    const { sql, learnings, reviews } = makeFakeSql();
    seedApprovedReviews(reviews, 5);
    const result = runReflection(sql, SUNDAY);
    expect(result.findings).toHaveLength(1);
    expect(result.reviewCandidatesCreated).toBe(1);
    const wired = reviews.filter((r) => r.symbol === "REFLECTION" && r.decision === "pending");
    expect(wired).toHaveLength(1);
    expect(wired[0].label).toBe("Momentum (reflection proposal)");
    // The learning path is untouched: finding + run-meta still recorded.
    expect(learnings).toHaveLength(2);
    expect(result.learningsRecorded).toBe(1);
  });

  it("wiring failure is logged and never breaks the run", () => {
    const { sql, reviews } = makeFakeSql(
      (text) => /INSERT OR REPLACE INTO mas_strategy_reviews/i.test(text)
    );
    seedApprovedReviews(reviews, 5);
    // #3515 S3: the wiring failure now travels as a structured
    // reflection.review_candidate_create_failed event (level error) on
    // the console-info JSON fallback, not a console.error line. The
    // failure is per-finding: createReflectionReviewCandidates catches
    // the failed candidate insert itself and returns 0, so the
    // wiring-level event never fires on this path — the per-finding
    // event is the log the run produces.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const result = runReflection(sql, SUNDAY);
    expect(result.findings).toHaveLength(1);
    expect(result.learningsRecorded).toBe(1);
    expect("reviewCandidatesCreated" in result).toBe(false);
    const events: Array<{ operation: string; level: string; fields: Record<string, unknown> }> = [];
    for (const call of infoSpy.mock.calls) {
      try {
        const parsed = JSON.parse(String(call[0])) as {
          operation?: unknown;
          level?: unknown;
          fields?: unknown;
        };
        if (parsed && typeof parsed.operation === "string") {
          events.push({
            operation: parsed.operation,
            level: typeof parsed.level === "string" ? parsed.level : "",
            fields:
              parsed.fields && typeof parsed.fields === "object"
                ? (parsed.fields as Record<string, unknown>)
                : {},
          });
        }
      } catch {
        // Non-JSON console.info lines are not structured events.
      }
    }
    const failed = events.find((e) => e.operation === "reflection.review_candidate_create_failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("error");
    expect(failed?.fields.family).toBe("Momentum");
    expect(String(failed?.fields.message ?? "")).toContain("Failed to create review candidate");
    infoSpy.mockRestore();
  });
});
