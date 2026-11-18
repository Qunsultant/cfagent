/**
 * Issue #5058 (AG-4) — the LLM judge's scores get a consumer.
 *
 * Before this: every turn was scored, the score reached `response.evaluated`
 * and a VectorMemory row, and nothing read past scores. Now a low score
 * becomes a `judge` learning and the weekly reflection job aggregates the
 * recent ones into a review finding — the score is evidence that reaches a
 * human, not a log line.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  JUDGE_SCORE_DOMAIN,
  JUDGE_SCORE_FEEDBACK_DEFAULTS,
  buildJudgeScoreFinding,
  judgeScoreLearning,
  recordJudgeScoreLearning,
  resolveJudgeScoreFeedbackPolicy,
  summarizeJudgeScoreLearnings,
} from "../src/services/judgeScoreFeedback";
import { runReflection } from "../src/services/reflection";

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]) {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

const policy = { ...JUDGE_SCORE_FEEDBACK_DEFAULTS };

function score(overrides: Partial<Parameters<typeof judgeScoreLearning>[0]> = {}) {
  return {
    score: 42,
    grounded: true,
    safe: true,
    issues: ["answer cited no evidence"],
    agent: "search",
    requestId: "req-1",
    now: () => new Date("2026-11-18T12:00:00Z"),
    ...overrides,
  };
}

describe("Issue #5058 — judge score feedback", () => {
  describe("1. Thresholds are externalized", () => {
    it("defaults and env overrides", () => {
      expect(policy.threshold).toBeGreaterThan(0);
      const resolved = resolveJudgeScoreFeedbackPolicy({
        JUDGE_LEARNING_THRESHOLD: "75",
        JUDGE_LEARNING_MIN_COUNT: "5",
        JUDGE_LEARNING_WINDOW_DAYS: "14",
        JUDGE_LEARNING_ENABLED: "false",
      } as any);
      expect(resolved).toEqual({
        enabled: false,
        threshold: 75,
        minCount: 5,
        windowDays: 14,
      });
      expect(
        resolveJudgeScoreFeedbackPolicy({ JUDGE_LEARNING_THRESHOLD: "x" } as any),
      ).toEqual(JUDGE_SCORE_FEEDBACK_DEFAULTS);
    });
  });

  describe("2. A low score becomes a learning", () => {
    it("records the agent, issues, and request id", () => {
      const learning = judgeScoreLearning(score(), policy);
      expect(learning).not.toBeNull();
      expect(learning!.domain).toBe(JUDGE_SCORE_DOMAIN);
      expect(learning!.observation).toContain("search");
      expect(learning!.observation).toContain("42/100");
      expect(learning!.observation).toContain("answer cited no evidence");
      expect(learning!.evidenceRefs).toEqual(["chat:req-1"]);
      expect(learning!.confidence).toBeCloseTo(0.42);
    });

    it("records nothing at or above the threshold, or when disabled", () => {
      expect(judgeScoreLearning(score({ score: policy.threshold }), policy)).toBeNull();
      expect(
        judgeScoreLearning(score(), { ...policy, enabled: false }),
      ).toBeNull();
    });

    it("writes one row per request, never a duplicate", () => {
      const sql = new SqliteTestStorage();
      const first = recordJudgeScoreLearning(sql, score(), policy);
      const second = recordJudgeScoreLearning(sql, score(), policy);
      expect(first).toBeTruthy();
      expect(second).toBeNull();
      expect(summarizeJudgeScoreLearnings(sql, { windowDays: 7 }).count).toBe(1);
    });

    it("never throws on a broken store", () => {
      const broken = {
        exec() {
          throw new Error("storage unavailable");
        },
      };
      expect(recordJudgeScoreLearning(broken, score(), policy)).toBeNull();
    });
  });

  describe("3. The aggregate the reflection job reads", () => {
    it("counts the window, the agents, and the mean score", () => {
      const sql = new SqliteTestStorage();
      recordJudgeScoreLearning(sql, score({ requestId: "a", score: 40 }), policy);
      recordJudgeScoreLearning(
        sql,
        score({ requestId: "b", score: 50, agent: "trading" }),
        policy,
      );
      recordJudgeScoreLearning(sql, score({ requestId: "c", score: 30 }), policy);

      const summary = summarizeJudgeScoreLearnings(sql, { windowDays: 7 });
      expect(summary.count).toBe(3);
      expect(summary.agents).toEqual(["search", "trading"]);
      expect(summary.meanScore).toBe(40);
    });

    it("does not turn a single bad turn into a finding", () => {
      const summary = { count: 1, agents: ["search"], meanScore: 40 };
      expect(buildJudgeScoreFinding(summary, policy)).toBeNull();
    });

    it("turns a repeat pattern into a finding with the agents named", () => {
      const finding = buildJudgeScoreFinding(
        { count: 3, agents: ["search", "trading"], meanScore: 40 },
        policy,
      );
      expect(finding).not.toBeNull();
      expect(finding!.domain).toBe(JUDGE_SCORE_DOMAIN);
      expect(finding!.observation).toContain("search, trading");
      expect(finding!.observation).toContain("mean score 40");
      expect(finding!.proposedAdjustment).toContain("review");
    });
  });

  describe("4. The reflection job consumes it", () => {
    it("emits the judge finding on the weekly run", () => {
      const sql = new SqliteTestStorage();
      for (const [id, agent] of [
        ["a", "search"],
        ["b", "trading"],
        ["c", "search"],
      ] as const) {
        recordJudgeScoreLearning(sql, score({ requestId: id, agent }), policy);
      }

      const result = runReflection(sql, new Date("2026-11-15T12:00:00Z"));

      expect(result.skipped).toBeUndefined();
      const judgeFindings = result.findings.filter(
        (f) => f.domain === JUDGE_SCORE_DOMAIN,
      );
      expect(judgeFindings).toHaveLength(1);
      expect(judgeFindings[0].observation).toContain("scored below");
      expect(judgeFindings[0].evidenceRefs).toContain(
        `mas_learnings:${JUDGE_SCORE_DOMAIN}`,
      );
    });
  });
});
