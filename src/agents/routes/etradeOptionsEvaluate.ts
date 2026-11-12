/**
 * Issue #995: E*TRADE options route sub-domain module, split out of
 * src/agents/routes/etradeOptions.ts to restore the #359 <50 KB route
 * module target. Pure move — no behavior change.
 *
 * The dispatcher in etradeOptions.ts owns every route condition (the
 * #359 extraction pins and the thin-router inventory anchor the
 * conditions, the schema-parse calls, and the ETradeService
 * construction sites to that file); this module owns the LLM evaluation of quant-pipeline candidates (llm-ideas tail, compare ranking)
 * handler bodies it delegates to. Each function is invoked only after
 * its route condition has matched, and returns the Response the
 * original inline block returned.
 */

import { recordStrategyCandidates } from "../../services/strategyReviews";
import {
  generateSyntheticOptionChains,
  rankCandidatesWithLlm,
  type StrategyRequest,
} from "../../trading";
import { runOptionsPanelViaEngine } from "../../workflows/optionsScreenEngine";
import { DEFAULT_AI_MODEL } from "../model";
import type { ETradeService } from "../../services/etrade";
import type { DatabaseORM } from "../../orm";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../../types";
import type { EtradeOptionsRouteContext } from "./etradeOptions";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/etradeOptionsEvaluate",
});

/** Mutable llm-ideas retrieval state shared with the dispatcher's catch. */
export interface LlmIdeasRetrievalState {
  retrievedExpirations: ETradeOptionExpireDate[];
  usedSyntheticChains: boolean;
}

export async function executeLlmIdeasEvaluation(args: {
  ctx: EtradeOptionsRouteContext;
  orm: DatabaseORM;
  etrade: ETradeService;
  userLogin: string;
  symbol: string;
  question: string;
  cached: ReturnType<DatabaseORM["getOptionsChain"]>;
  retrievedChains: ETradeOptionChain[];
  state: LlmIdeasRetrievalState;
}): Promise<Response> {
  const { ctx, orm, etrade, userLogin, symbol, question, cached, retrievedChains, state } = args;

  if (cached && cached.expirations.length > 0 && cached.chains.length > 0) {
    state.retrievedExpirations = cached.expirations;
    for (const c of cached.chains) {
      retrievedChains.push(c);
    }
  } else {
    let expirations = await etrade.client.getOptionExpireDates(symbol);
    if (expirations.length === 0) {
      // Fall back to unscoped option chain request if expiration calendar endpoint was empty
      const fallbackChain = await etrade.client.getOptionChains({
        symbol,
        includeWeekly: true,
        chainType: "CALLPUT",
        includeRawResponse: true,
      }).catch(() => null);
      if (fallbackChain && fallbackChain.selectedExpiry && fallbackChain.pairs.length > 0) {
        expirations = [fallbackChain.selectedExpiry];
        retrievedChains.push(fallbackChain);
      }
    }

    if (expirations.length > 0 && retrievedChains.length === 0) {
      state.retrievedExpirations = expirations;

      // Target up to 18 most active expirations across near, mid, and long term to prevent unconstrained latency
      const targetExpirations = expirations.length > 18
        ? [...expirations.slice(0, 10), ...expirations.slice(10, 16), ...expirations.slice(-2)]
        : expirations;

      // Fetch option chains with concurrency chunking (4 parallel requests at a time)
      const chunkSize = 4;
      for (let i = 0; i < targetExpirations.length; i += chunkSize) {
        const chunk = targetExpirations.slice(i, i + chunkSize);
        const chunkChains = await Promise.all(
          chunk.map((expiry) =>
            etrade.client.getOptionChains({
              symbol,
              expiryYear: expiry.year,
              expiryMonth: expiry.month,
              expiryDay: expiry.day,
              includeWeekly: true,
              chainType: "CALLPUT",
              includeRawResponse: true,
            })
          )
        );
        for (const chain of chunkChains) {
          if (chain) retrievedChains.push(chain);
        }
      }
    } else if (expirations.length > 0) {
      state.retrievedExpirations = expirations;
    }

    if (retrievedChains.length > 0) {
      // Persist into durable SQLite table (10-minute TTL)
      orm.setOptionsChain(symbol, state.retrievedExpirations, retrievedChains, 600);
    }
  }

  let contractCount = retrievedChains.reduce(
    (count, chain) => count + chain.pairs.reduce((pairCount, pair) => pairCount + Number(Boolean(pair.call)) + Number(Boolean(pair.put)), 0),
    0,
  );

  if (contractCount === 0) {
    const isTestEnv = ctx.requestedEnv === "TEST" || !etrade.client.getEnvConfig().isLive;
    if (isTestEnv) {
      state.usedSyntheticChains = true;
      const synthetic = generateSyntheticOptionChains(symbol);
      state.retrievedExpirations = synthetic.expirations;
      retrievedChains.length = 0;
      for (const sc of synthetic.chains) {
        retrievedChains.push(sc);
      }
      contractCount = retrievedChains.reduce(
        (count, chain) => count + chain.pairs.reduce((pairCount, pair) => pairCount + Number(Boolean(pair.call)) + Number(Boolean(pair.put)), 0),
        0,
      );
    } else {
      throw new Error(etrade.client.lastError || `E*TRADE returned no option contracts for ${symbol} in PROD environment; no LLM request was sent.`);
    }
  }

  if (contractCount === 0) {
    throw new Error(`E*TRADE returned no option contracts for ${symbol}; no LLM request was sent.`);
  }

  const rawData = {
    symbol,
    question,
    // Provenance (issue #29): synthetic chains are TEST-only and must never be
    // indistinguishable from live E*TRADE chains downstream.
    dataSource: state.usedSyntheticChains ? "synthetic option chains (TEST environment)" : "E*TRADE option chains",
    expirations: state.retrievedExpirations,
    optionChains: retrievedChains.map((chain) => chain.raw ?? chain),
  };
  // Issue #47 (follow-up to #29): this endpoint no longer runs the
  // llm_ideas map-reduce (horizon groups over raw chains, existence-only
  // verification, no risk constraints). Following the compare pattern —
  // and the unified service's llm_ideas disposition in slice 4 — the
  // quant pipeline runs first and the LLM evaluates its verified
  // candidates, never overwriting the quant ranking. The response keeps
  // the panel's shape: a single "pipeline" group carries the evaluation
  // so rendering, exports, and provenance badges keep working.
  const spot = retrievedChains.find((chain) => Number.isFinite(chain.underlyingPrice) && chain.underlyingPrice > 0)?.underlyingPrice ?? 100;
  const questionLower = question.toLowerCase();
  const thesis: StrategyRequest["thesis"] = /bear|downside|\bshort\b/.test(questionLower)
    ? "bearish"
    : /range|sideways|neutral|income|theta/.test(questionLower)
      ? "range_bound"
      : /volatil|big move|large move|breakout/.test(questionLower)
        ? "large_move"
        : "bullish";
  const strategyRequest: StrategyRequest = {
    symbol,
    thesis,
    targetPrice: Math.round(spot * (thesis === "bullish" ? 1.05 : thesis === "bearish" ? 0.95 : 1) * 100) / 100,
    targetDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 100000,
    minRewardRisk: 0,
    allowedStrategies: ["all"],
  };
  // Issue #4068: the evaluation runs through the one engine-routed panel
  // (runOptionsPanelViaEngine) instead of the direct runPanelPipelineRetired4068 call.
  // The universe deps ride the helper's fifth parameter, exactly as the
  // direct call passed them to the screener's constructor.
  const pipelineResult = await runOptionsPanelViaEngine(etrade.client, strategyRequest, { riskProfile: "balanced" }, userLogin, await etrade.getUniverseDeps?.(ctx.agentCtx?.storage));
  const topRanked = pipelineResult.ranked.slice(0, 10);
  const candidates = topRanked.map((r) => r.candidate);
  let llmJudgment: Awaited<ReturnType<typeof rankCandidatesWithLlm>> | null = null;
  let llmError: string | null = null;
  if (candidates.length > 0) {
    try {
      // Issue #707: inject recent human review decisions as ranking context.
      let humanFeedback: string | undefined;
      try {
        const { listStrategyReviews } = await import("../../services/strategyReviews");
        const { buildHumanFeedbackContext, buildReflectionFeedbackContext } = await import("../../trading");
        const { getActiveLearnings } = await import("../../services/learnings");
        const recent = listStrategyReviews(ctx.getOrm()).slice(0, 20);
        humanFeedback = buildHumanFeedbackContext(recent) || undefined;
        // Issue #775: append reflection adjustments so the Act step acts.
        try {
          const learnings = getActiveLearnings(ctx.getOrm() as any, "screener");
          const reflectionCtx = buildReflectionFeedbackContext(
            learnings.map((l) => ({ observation: l.observation, confidence: l.confidence }))
          );
          if (reflectionCtx) {
            humanFeedback = humanFeedback
              ? `${humanFeedback}\n\n${reflectionCtx}`
              : reflectionCtx;
            structuredLog.info("etradeOptionsEvaluate.ranking_reflection_adjustments_applied", {
              message: `[Options] Ranking with reflection adjustments (${learnings.length} learnings)`,
              learnings: learnings.length,
            });
          }
        } catch {}
        if (humanFeedback) {
          structuredLog.info("etradeOptionsEvaluate.ranking_human_feedback_context_applied", {
            message: `[Options] Ranking with human feedback context (${recent.length} recent decisions)`,
            recentDecisions: recent.length,
          });
        }
      } catch {}
      llmJudgment = await rankCandidatesWithLlm(ctx.env, strategyRequest, "balanced", pipelineResult.snapshot.contracts, candidates, humanFeedback);
    } catch (err) {
      llmError = err instanceof Error ? err.message : "LLM evaluation failed.";
    }
  }
  const llmStatus = llmJudgment ? "complete" as const : "error" as const;
  const llmModel = llmJudgment?.model || ctx.env.AI_MODEL || DEFAULT_AI_MODEL;
  const llmErrorText = llmError ?? "The quant pipeline produced no candidates for this symbol.";
  // Issue #1640 (doc §2): the rankings field is the quant order with
  // LLM judgments attached as annotations only — annotateQuantRanking
  // cannot reorder, drop, or invent a candidate. The `answer` prose
  // below remains the LLM's own top-3 list, labeled as the LLM
  // evaluation; it is not the ranking.
  const { annotateQuantRanking } = await import("../../services/rankingCore");
  const annotatedRanked = annotateQuantRanking(topRanked, llmJudgment?.ranked ?? []);
  const rationaleByCandidate = new Map(
    annotatedRanked.map(({ ranked, annotation }) => [ranked.candidate.id, annotation?.rationale ?? ""])
  );
  const answer = llmJudgment
    ? llmJudgment.ranked.slice(0, 3).map((judgment, idx) => {
        const candidate = candidates.find((c) => c.id === judgment.candidateId);
        return `${idx + 1}. ${candidate ? candidate.label : judgment.candidateId} — ${judgment.rationale}`;
      }).join("\n")
    : llmErrorText;
  const candidateContractSymbols = [...new Set(candidates.flatMap((c) => c.legs.map((leg) => leg.symbol)))];
  const groupResults = [{
    id: "pipeline",
    label: "Quant pipeline candidates",
    status: llmStatus,
    model: llmModel,
    answer,
    error: llmStatus === "error" ? llmErrorText : undefined,
    contractSymbols: candidateContractSymbols,
    contractWarnings: [] as string[],
    contractDetails: [] as unknown[],
    expirationCount: state.retrievedExpirations.length,
    contractCount,
    sentContractCount: candidates.length,
    estimatedInputTokens: 0,
    inputTruncated: false,
  }];
  const finalAnalysis = {
    status: llmStatus,
    model: llmModel,
    answer: llmStatus === "complete" ? answer : undefined,
    error: llmStatus === "error" ? llmErrorText : undefined,
    rankings: topRanked.map((r, idx) => ({
      rank: idx + 1,
      groupId: "pipeline",
      strategy: r.candidate.label,
      rationale: rationaleByCandidate.get(r.candidate.id) ?? "",
    })),
    systemPrompt: "",
    userPrompt: question,
    isFallback: false,
  };
  const llmInputExport = {
    id: "pipeline",
    label: "Quant pipeline candidates",
    symbol,
    question,
    expirations: state.retrievedExpirations,
    optionChains: retrievedChains.map((chain) => chain.raw ?? chain),
    systemPrompt: "Quant pipeline candidate evaluation (issue #47): the LLM evaluates verified candidates; it does not generate strategies.",
    userPrompt: question,
    selection: { contractCount, candidateCount: candidates.length },
    groupInputs: [] as unknown[],
    finalRanking: { systemPrompt: "", userPrompt: question },
  };
  // Issue #653: record candidates for the review UI (best-effort).
  try {
    recordStrategyCandidates(ctx.getOrm(), symbol, topRanked.map((r, idx) => ({
      id: r.candidate.id,
      label: r.candidate.label,
      rank: idx + 1,
      rationale: rationaleByCandidate.get(r.candidate.id) ?? "",
      quantStatus: "verified",
    })));
  } catch {}
  const dataCoverage = {
    expirationCount: state.retrievedExpirations.length,
    chainCount: retrievedChains.length,
    contractCount,
    sentContractCount: contractCount,
    estimatedInputTokens: 0,
    inputTruncated: false,
    cached: Boolean(cached),
    fetchedAt: cached?.fetchedAt || Date.now(),
  };
  return Response.json({
    mode: "llm_evaluation_of_quant_candidates",
    isSynthetic: state.usedSyntheticChains,
    notice: state.usedSyntheticChains
      ? "Synthetic option chains preview (TEST environment). Not verified live market data."
      : "Quant-verified candidates evaluated by the LLM (compare pattern, issue #47); the quant pipeline's ranking stands.",
    llm: {
      status: llmStatus,
      model: llmModel,
      answer: llmStatus === "complete" ? answer : undefined,
      error: llmStatus === "error" ? llmErrorText : undefined,
      contractSymbols: candidateContractSymbols,
    },
    quant: {
      ranked: topRanked,
      scoreWeights: pipelineResult.strategies.scoreWeights,
      candidateCount: candidates.length,
    },
    groups: groupResults,
    finalAnalysis,
    llmInput: llmInputExport,
    retrievedData: rawData,
    dataCoverage,
  });
}

type ComparePipelineResult = Awaited<ReturnType<typeof runOptionsPanelViaEngine>>;

export async function rankOptionsCompareCandidates(ctx: EtradeOptionsRouteContext, strategyRequest: StrategyRequest, body: any, result: ComparePipelineResult, common: { llmInput: unknown; quantStrategyPool: unknown; screen: unknown; contracts: unknown; contractRejections: unknown }): Promise<Response> {
  const candidates = result.ranked.slice(0, 20);
  try {
    const llm = await rankCandidatesWithLlm(
      ctx.env,
      strategyRequest,
      body.riskProfile || "balanced",
      result.snapshot.contracts,
      candidates.map((ranked) => ranked.candidate),
    );
    return Response.json({
      mode: "same_candidate_ranking",
      quant: {
        ranked: candidates,
        scoreWeights: result.strategies.scoreWeights,
        candidateCount: candidates.length,
      },
      llm: { status: "complete", ...llm },
      ...common,
    });
  } catch (err) {
    return Response.json({
      mode: "same_candidate_ranking",
      quant: {
        ranked: candidates,
        scoreWeights: result.strategies.scoreWeights,
        candidateCount: candidates.length,
      },
      llm: {
        status: "error",
        model: ctx.env.AI_MODEL || DEFAULT_AI_MODEL,
        error: err instanceof Error ? err.message : "LLM ranking failed.",
      },
      ...common,
    });
  }
}
