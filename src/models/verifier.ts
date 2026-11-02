/**
 * PR #5 (cont.) — Verifier: evidence check for agent outputs.
 *
 * Split from judge.ts: the router picks the model, the verifier
 * checks that the output is grounded in evidence. Used by the
 * orchestrator's supervise mode after each wave.
 */

import type { Env } from "../types";

export interface VerificationResult {
  /** Whether the output passes verification */
  pass: boolean;
  /** Confidence 0-1 */
  confidence: number;
  /** Issues found, if any */
  issues: string[];
}

export interface Evidence {
  /** The claim being verified */
  claim: string;
  /** Sources that should support it */
  sources: string[];
}

/**
 * Verify that an agent's output is supported by the provided evidence.
 * Heuristic checks (no LLM): non-empty, sources referenced, no
 * obvious hallucination markers.
 */
export function verifyOutput(output: string, evidence: Evidence[]): VerificationResult {
  const issues: string[] = [];

  if (!output || output.trim().length === 0) {
    return { pass: false, confidence: 1.0, issues: ["empty output"] };
  }

  // Check for hallucination markers
  const lower = output.toLowerCase();
  const markers = ["as an ai", "i don't have access", "i cannot verify"];
  for (const m of markers) {
    if (lower.includes(m)) {
      issues.push(`hallucination marker: "${m}"`);
    }
  }

  // Check that evidence sources are referenced (when evidence provided)
  if (evidence.length > 0) {
    const referenced = evidence.filter((e) =>
      e.sources.some((s) => output.includes(s.slice(0, 20)))
    );
    if (referenced.length === 0) {
      issues.push("no evidence sources referenced in output");
    }
  }

  const pass = issues.length === 0;
  return {
    pass,
    confidence: pass ? 0.9 : Math.max(0.1, 1 - issues.length * 0.3),
    issues,
  };
}

/**
 * LLM-based verification for high-stakes outputs.
 * Uses the judge model chain via runWithRouting.
 *
 * Qunsultant/cfagent#1775 (Adapter S1): the model call routes
 * through the Workers AI adapter (getWorkersAIModel) and the
 * gateway port's shared call (executeModelCall) instead of
 * calling the AI binding directly. The chain, the prompts, and
 * the fail contract are unchanged: a model failure still throws
 * past the router (fail-loud, after cheap -> primary -> fallback
 * on retryable errors); only an unparseable reply fails soft
 * below. When AI_GATEWAY_ID is unset the adapter path is
 * byte-identical to the direct path; when set, calls now route
 * through the gateway per #1741 instead of bypassing it.
 * This also resolves the #1741 coverage pin's recorded
 * exemption ("verifier.ts uses env.AI.run ... and is #1717 S1
 * territory"): the verifier no longer calls the binding, and
 * no new generateText call site is added — the AI SDK call
 * lives only in the gateway module, as the pin requires.
 */
export async function verifyWithLLM(
  env: { AI: any },
  output: string,
  criteria: string
): Promise<VerificationResult> {
  const { runWithRouting } = await import("./router");
  const { getWorkersAIModel } = await import("../agents/model");
  const { executeModelCall } = await import("../gateway/gatewayModelCall");
  const { result } = await runWithRouting("judge", async (model) => {
    const { text } = await executeModelCall(
      getWorkersAIModel(env as unknown as Env, model),
      {
        model,
        messages: [
          {
            role: "system",
            content: "You verify agent outputs. Reply with ONLY JSON: {\"pass\": true|false, \"confidence\": 0-1, \"issues\": [...]}",
          },
          {
            role: "user",
            content: `Criteria: ${criteria}\n\nOutput to verify:\n${output.slice(0, 4000)}`,
          },
        ],
      }
    );
    return text;
  });

  try {
    const text = typeof result === "string" ? result : JSON.stringify(result);
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return {
      pass: !!parsed.pass,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    };
  } catch {
    return { pass: false, confidence: 0.3, issues: ["unparseable verifier response"] };
  }
}
