/**
 * PR #6 — VectorMemory: long-term memory for cfagent.
 *
 * Extends the memory.ts pattern with vector-backed recall:
 *   recallForPlan(goal) → up to 8 chunks injected into the
 *   orchestrator prompt, so planning is grounded in past outcomes.
 *
 * Uses Vectorize; an aiSearch client may be injected but every
 * production construction passes none (the recall path is
 * Vectorize-only). (Issue #278: the AI Search HTTP endpoint var
 * this header once named was retired by #3342 — AI Search is
 * reached through the ai_search_namespaces binding, not an
 * endpoint, and this module never used it.)
 */

export interface MemoryOutcome {
  jobId: string;
  operation: string;
  summary: string;
  success: boolean;
  timestamp: string;
}

export interface RecalledChunk {
  summary: string;
  operation: string;
  success: boolean;
  score: number;
}

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const RECALL_TOP_K = 8;

async function embed(ai: any, text: string): Promise<number[]> {
  const res = await ai.run(EMBEDDING_MODEL, { text });
  return (res as { data: number[][] }).data[0];
}

export class VectorMemory {
  constructor(
    private ai: any,
    private vectorize: any,
    private aiSearch: any
  ) {}

  /**
   * Qunsultant/cfagent#1775 (Adapter S1): the Vectorize port for
   * callers that own their own vector id/metadata shape (the
   * report semantic index). Same embedding model and same index
   * as remember/recallForPlan — these are passthroughs over the
   * one embed() above, not a second embedding implementation.
   * Callers keep their own truncation and fail-soft mapping; a
   * throw here means the caller's contract decides (the report
   * index maps it to null/false/[]).
   */
  async embedText(text: string): Promise<number[]> {
    return embed(this.ai, text);
  }

  async upsertVectors(
    vectors: Array<{
      id: string;
      values: number[];
      metadata: Record<string, unknown>;
    }>
  ): Promise<void> {
    await this.vectorize.upsert(vectors);
  }

  async queryVectors(
    values: number[],
    opts: {
      topK: number;
      filter?: Record<string, unknown>;
      returnMetadata?: boolean;
    }
  ): Promise<any> {
    return this.vectorize.query(values, opts);
  }

  /** Store a job outcome. Called after every orchestrator job. */
  async remember(outcome: MemoryOutcome): Promise<void> {
    const text = `Operation: ${outcome.operation}\nSuccess: ${outcome.success}\nSummary: ${outcome.summary}`;
    const values = await embed(this.ai, text);
    await this.vectorize.upsert([
      {
        id: outcome.jobId,
        values,
        metadata: {
          operation: outcome.operation,
          success: String(outcome.success),
          timestamp: outcome.timestamp,
          summary: outcome.summary.slice(0, 500),
        },
      },
    ]);
  }

  /**
   * Recall relevant past outcomes for a goal.
   * Returns up to 8 chunks for injection into the planner prompt.
   */
  async recallForPlan(goal: string, operationFilter?: string, topK: number = RECALL_TOP_K): Promise<RecalledChunk[]> {
    const values = await embed(this.ai, goal);
    const results = await this.vectorize.query(values, {
      topK: Math.max(1, Math.min(50, Math.floor(topK) || RECALL_TOP_K)),
      filter: operationFilter ? { operation: { $eq: operationFilter } } : undefined,
      returnMetadata: true,
    });
    return (results.matches ?? []).map((m: any) => ({
      summary: String(m.metadata?.summary ?? ""),
      operation: String(m.metadata?.operation ?? ""),
      success: m.metadata?.success === "true",
      score: m.score,
    }));
  }

  /**
   * Generic dense search over the same index (#1740 hybrid RAG).
   * EXTENSION of the existing path, not a second model: same
   * embed(), same model, same index as recallForPlan/recallPlans.
   * Returns raw hits (id, score, text, metadata) so the retrieval
   * port can fuse them with graph context; text prefers the
   * summary field, then goal, then "".
   */
  async searchDense(
    query: string,
    topK: number = RECALL_TOP_K,
    filter?: Record<string, unknown>,
  ): Promise<
    Array<{
      id: string;
      score: number;
      text: string;
      metadata: Record<string, unknown>;
    }>
  > {
    const values = await embed(this.ai, query);
    const results = await this.vectorize.query(values, {
      topK: Math.max(1, Math.min(50, Math.floor(topK) || RECALL_TOP_K)),
      filter,
      returnMetadata: true,
    });
    return (results.matches ?? []).map((m: any) => ({
      id: String(m.id ?? ""),
      score: typeof m.score === "number" ? m.score : 0,
      text: String(m.metadata?.summary ?? m.metadata?.goal ?? ""),
      metadata: (m.metadata ?? {}) as Record<string, unknown>,
    }));
  }

  /** Format recalled chunks as a planner-prompt brief. */
  static brief(chunks: RecalledChunk[]): string {
    if (chunks.length === 0) return "No relevant past outcomes.";
    return [
      "Relevant past outcomes:",
      ...chunks.map(
        (c, i) => `${i + 1}. [${c.success ? "OK" : "FAIL"}] ${c.operation}: ${c.summary}`
      ),
    ].join("\n");
  }

  /**
   * Store a compiled chain's outcome as plan memory (issue #1461,
   * #1362 Phase 4). Same embedding model, same Vectorize index as
   * `remember` — the record is distinguished only by its `plan:`
   * id prefix and `kind: "plan"` metadata, so plan records stay
   * separable from outcome records and #337 report records in the
   * shared index. Returns the record id. Errors propagate, matching
   * the `remember` convention (callers wrap in try/catch).
   */
  async rememberPlan(input: PlanMemoryInput): Promise<string> {
    const id = `plan:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    const text = [
      `Goal: ${input.goal}`,
      `Plan: ${input.capabilityIds.join(", ")}`,
      `Success: ${input.success}`,
      `Summary: ${input.summary}`,
    ].join("\n");
    const values = await embed(this.ai, text);
    await this.vectorize.upsert([
      {
        id,
        values,
        metadata: {
          kind: "plan",
          goal: input.goal.slice(0, 500),
          normalizedGoal: input.normalizedGoal.slice(0, 500),
          steps: JSON.stringify(input.capabilityIds),
          budgetCents: input.budgetCents,
          recurrence: input.recurrence,
          reusesStoredReport: String(input.reusesStoredReport),
          success: String(input.success),
          summary: input.summary.slice(0, 500),
          timestamp: input.timestamp,
        },
      },
    ]);
    return id;
  }

  /**
   * Recall prior plans for a goal, most similar first. Only
   * `kind: "plan"` matches are returned; a match whose stored steps
   * do not parse is dropped, never trusted.
   */
  async recallPlans(goal: string, topK: number = RECALL_TOP_K): Promise<RecalledPlan[]> {
    const values = await embed(this.ai, goal);
    const results = await this.vectorize.query(values, {
      topK: Math.max(1, Math.min(50, Math.floor(topK) || RECALL_TOP_K)),
      filter: { kind: "plan" },
      returnMetadata: true,
    });
    const plans: RecalledPlan[] = [];
    for (const m of results.matches ?? []) {
      const md = (m as any).metadata ?? {};
      let capabilityIds: string[];
      try {
        const parsed = JSON.parse(String(md.steps ?? ""));
        if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === "string")) continue;
        capabilityIds = parsed;
      } catch {
        continue;
      }
      plans.push({
        id: String((m as any).id ?? ""),
        goal: String(md.goal ?? ""),
        normalizedGoal: String(md.normalizedGoal ?? ""),
        capabilityIds,
        budgetCents: typeof md.budgetCents === "number" ? md.budgetCents : Number(md.budgetCents ?? 0),
        recurrence: md.recurrence === "recurring" ? "recurring" : "one-shot",
        reusesStoredReport: md.reusesStoredReport === "true",
        success: md.success === "true",
        summary: String(md.summary ?? ""),
        timestamp: String(md.timestamp ?? ""),
        score: typeof (m as any).score === "number" ? (m as any).score : 0,
      });
    }
    return plans;
  }
}

/**
 * Plan-level composition memory input (issue #1461, #1362 Phase 4):
 * goal text → compiled chain → outcome, for reuse.
 */
export interface PlanMemoryInput {
  goal: string;
  normalizedGoal: string;
  capabilityIds: string[];
  budgetCents: number;
  recurrence: "recurring" | "one-shot";
  reusesStoredReport: boolean;
  success: boolean;
  summary: string;
  timestamp: string;
}

export interface RecalledPlan {
  id: string;
  goal: string;
  normalizedGoal: string;
  capabilityIds: string[];
  budgetCents: number;
  recurrence: "recurring" | "one-shot";
  reusesStoredReport: boolean;
  success: boolean;
  summary: string;
  timestamp: string;
  score: number;
}
