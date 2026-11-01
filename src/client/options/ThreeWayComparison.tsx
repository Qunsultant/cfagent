/**
 * #1257 comparison surfacing — the three-way generator comparison
 * renderer for the hub options-tab panel. Distinct from the
 * existing RecommendationComparison (the #47 quant-vs-LLM
 * annotation compare): this renders the C5 3-way artifact — llm /
 * quant / hybrid arms over one snapshot, per-arm attrition, arm
 * overlap, and generation notes — plus a ledger read-back by run
 * id. Read-only: it never reorders production rankings, and it
 * declares no winner (arms accumulate ledger track records).
 */
import { useState } from "react";
import { Button } from "../components/ui";

export interface ThreeWayArmCandidate {
  id: string;
  structure: string;
  label: string;
  status: string;
  score?: number | null;
  provenance?: string;
}

export interface ThreeWayArm {
  attrition: { generated: number; gatePassed: number; priced: number; falsified: number; ranked: number };
  ranked: ThreeWayArmCandidate[];
}

export interface ThreeWayComparisonData {
  status: string;
  artifact: {
    runId: string;
    arms: Record<"llm" | "quant" | "hybrid", ThreeWayArm>;
    overlap: { sharedStructures: string[]; armUnique: Record<string, string[]> };
    stats: { armRankedCounts: Record<string, number>; sharedStructureCount: number };
  };
  generationNotes: {
    model: string | null;
    citedCount: number;
    droppedCount: number;
    llmGenerated: number;
    llmBuilderLimitations: string[];
    skippedReason: string | null;
  };
  symbol?: string;
  reason?: string;
}

export interface ThreeWayOutcomeRow {
  id: string;
  run_id: string;
  arm: string;
  candidate_id: string;
  structure: string;
  symbol: string;
  status: string;
  provenance: string;
}

const ARMS = ["llm", "quant", "hybrid"] as const;

export function ThreeWayComparison({ data, activeEnv, userLogin }: {
  data: ThreeWayComparisonData;
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
}) {
  const [outcomes, setOutcomes] = useState<ThreeWayOutcomeRow[] | null>(null);
  const [outcomesError, setOutcomesError] = useState("");
  const [outcomesLoading, setOutcomesLoading] = useState(false);

  const loadOutcomes = async () => {
    setOutcomesLoading(true);
    setOutcomesError("");
    try {
      const response = await fetch(`/api/trading/options/comparison/outcomes?runId=${encodeURIComponent(data.artifact.runId)}`, {
        headers: {
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
      });
      const payload = await response.json() as { outcomes?: ThreeWayOutcomeRow[]; error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error || "Ledger read-back failed");
      setOutcomes(payload.outcomes || []);
    } catch (cause) {
      setOutcomesError(cause instanceof Error ? cause.message : "Ledger read-back failed");
    } finally {
      setOutcomesLoading(false);
    }
  };

  const attritionLine = (arm: ThreeWayArm) =>
    `generated ${arm.attrition.generated} → gate-passed ${arm.attrition.gatePassed} → priced ${arm.attrition.priced} → falsified ${arm.attrition.falsified} → ranked ${arm.attrition.ranked}`;

  return (
    <section className="options-three-way-comparison" aria-label="Generator comparison">
      <h2>Generator comparison (LLM / Quant / Hybrid)</h2>
      <p className="options-comparison-note">
        Run {data.artifact.runId} for {data.symbol ?? "the requested symbol"}. No winner is declared — arms
        accumulate ledger track records over time. The hybrid arm&apos;s LLM ordering lives only on this
        surface; production rankings are never reordered by it.
      </p>
      {ARMS.map((arm) => (
        <div key={arm}>
          <h3>{arm} — {data.artifact.arms[arm].ranked.length} ranked ({attritionLine(data.artifact.arms[arm])})</h3>
          {data.artifact.arms[arm].ranked.length === 0 ? (
            <p>No ranked candidates in this arm.</p>
          ) : (
            <ul>
              {data.artifact.arms[arm].ranked.slice(0, 5).map((candidate, index) => (
                <li key={candidate.id}>
                  #{index + 1} {candidate.label} ({candidate.structure}) — {candidate.status}
                  {typeof candidate.score === "number" ? ` — score ${candidate.score.toFixed(1)}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <p>
        Shared structures: {data.artifact.overlap.sharedStructures.length ? data.artifact.overlap.sharedStructures.join(", ") : "none"}.
      </p>
      <p>
        Model: {data.generationNotes.model ?? "none"}; cited {data.generationNotes.citedCount}, dropped {data.generationNotes.droppedCount}.
        {data.generationNotes.llmBuilderLimitations.length ? ` Limitations: ${data.generationNotes.llmBuilderLimitations.join("; ")}.` : ""}
        {data.generationNotes.skippedReason ? ` Skipped: ${data.generationNotes.skippedReason}.` : ""}
      </p>
      <Button variant="secondary" size="sm" loading={outcomesLoading} onClick={() => void loadOutcomes()}>
        {"Load ledger outcomes"}
      </Button>
      {outcomesError && <div className="options-error" role="alert">{outcomesError}</div>}
      {outcomes !== null && (
        outcomes.length === 0 ? (
          <p>No ledger outcomes recorded for this run.</p>
        ) : (
          <ul>
            {outcomes.map((row) => (
              <li key={row.id}>{row.arm}: {row.candidate_id} ({row.structure}) — {row.status} [{row.provenance}]</li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}
