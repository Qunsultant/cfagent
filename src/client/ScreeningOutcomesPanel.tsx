/**
 * ScreeningOutcomesPanel — Consolidation C2 (issue #1246, epic #1151).
 *
 * The recommendation track record: per-recommendation outcomes from
 * the outcomeTracking ledger (GET /api/screening/outcomes), rendered
 * honestly — a recommendation whose terminal P&L was never recorded
 * stays "Unverified" with P&L "Not recorded"; nothing is estimated,
 * interpolated, or back-filled here.
 *
 * This is the #1096 outcome ledger, NOT the #340 research track
 * record (served by /research/track-record and shown in the Research
 * tab): the two stores are deliberately separate — this one tracks
 * what happened to specific screening recommendations after they were
 * issued; that one tracks research-agent ideas.
 *
 * The panel is read-only and fail-soft: if the API is unreachable the
 * section says so instead of breaking the hub around it.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./apiFetch";
import { Button, CardHeader } from "./components/ui";

export interface ScreeningOutcomeView {
  recommendationRef: string;
  status: string;
  quality: "verified" | "unverified" | "pending" | string;
  provenance: {
    screenRunRef: string | null;
    goalId: string | null;
    scenarioId: string | null;
    weightsVersion: number | null;
    evalSetVersion: string | null;
    expiryDate: string | null;
  };
  pnlAfterCost: number | null;
  trackedAt: string;
  terminalAt: string | null;
}

const QUALITY_LABELS: Record<string, string> = {
  verified: "Verified",
  unverified: "Unverified",
  pending: "Pending",
};

interface ScreeningOutcomesPanelProps {
  userLogin?: string;
}

export function ScreeningOutcomesPanel({ userLogin }: ScreeningOutcomesPanelProps) {
  const [outcomes, setOutcomes] = useState<ScreeningOutcomeView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const resp = await apiFetch("/api/screening/outcomes", {
        headers: {
          "Content-Type": "application/json",
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
      });
      if (!resp.ok) throw new Error("screening outcomes API unavailable");
      const body = (await resp.json()) as { outcomes?: ScreeningOutcomeView[] };
      setOutcomes(Array.isArray(body.outcomes) ? body.outcomes : []);
      setLoadError(null);
    } catch {
      setLoadError("Recommendation outcomes are unavailable right now.");
    }
  }, [userLogin]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      aria-label="Recommendation track record"
      style={{
        margin: "1.5rem 0",
        padding: "var(--space-6)",
        background: "var(--color-surface-sunken)",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "8px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)" }}>
        <CardHeader title="📈 Recommendation Track Record" />
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          ↻ Refresh
        </Button>
      </div>
      <p style={{ margin: "0 0 0.75rem", color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)", lineHeight: 1.5 }}>
        What actually happened to the screening system's recommendations after they were issued,
        from the outcome ledger. A recommendation is <strong>Verified</strong> only when its
        terminal after-cost P&amp;L was recorded; otherwise it stays <strong>Unverified</strong> —
        the ledger never estimates a result it does not have. This is the recommendation outcome
        ledger, distinct from the research track record in the Research tab.
      </p>

      {loadError && (
        <p style={{ margin: 0, color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" }}>
          {loadError}{" "}
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </p>
      )}

      {!loadError && outcomes.length === 0 && (
        <p style={{ margin: 0, color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" }}>
          No recommendation outcomes recorded yet. Outcomes appear here once issued
          recommendations are tracked to a terminal state.
        </p>
      )}

      {outcomes.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: "var(--space-4)" }}>
          {outcomes.map((outcome) => (
            <li
              key={outcome.recommendationRef}
              style={{ color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)", lineHeight: 1.55, marginBottom: "0.5rem" }}
            >
              <strong>{outcome.recommendationRef}</strong>
              {" — "}
              {QUALITY_LABELS[outcome.quality] ?? outcome.quality}
              {" · status: "}
              {outcome.status}
              {" · after-cost P&L: "}
              {typeof outcome.pnlAfterCost === "number" ? outcome.pnlAfterCost.toFixed(2) : "Not recorded"}
              <br />
              <span style={{ color: "var(--color-text-muted)" }}>
                {outcome.provenance.screenRunRef ? `run ${outcome.provenance.screenRunRef} · ` : ""}
                {outcome.provenance.goalId ? `goal ${outcome.provenance.goalId} · ` : ""}
                {outcome.provenance.scenarioId ? `scenario ${outcome.provenance.scenarioId} · ` : ""}
                {outcome.provenance.weightsVersion != null ? `weights v${outcome.provenance.weightsVersion} · ` : ""}
                {outcome.provenance.evalSetVersion ? `eval set ${outcome.provenance.evalSetVersion} · ` : ""}
                {outcome.provenance.expiryDate ? `expiry ${outcome.provenance.expiryDate} · ` : ""}
                tracked {new Date(outcome.trackedAt).toLocaleString()}
                {outcome.terminalAt ? ` · terminal ${new Date(outcome.terminalAt).toLocaleString()}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
