/**
 * Issue #223: autonomous options-analysis runs, surfaced in the UI.
 *
 * The scheduler persists its last 20 runs (DO storage, `options:last_runs`)
 * and serves them at GET /api/options/latest; until now they were only
 * visible in the live WebSocket broadcast. This section renders the
 * persisted record — what ran, when, which trigger, whether it succeeded,
 * and its top opportunities — and polls while mounted so a scheduled run
 * appears without a page reload.
 */
import { useEffect, useState } from "react";
import { Badge, Button, CardHeader, EmptyState } from "../components/ui";
import { subscribeOptionsLatest, refreshOptionsLatest } from "../optionsLatestShared";

interface OptionsRunOpportunity {
  symbol?: string;
  pick?: { best?: { candidate?: { type?: string } } };
  directionTags?: string[];
}

interface OptionsRun {
  timestamp: string;
  success: boolean;
  trigger: "manual" | "scheduled";
  thesis: string;
  symbols: string[];
  withTrades: number;
  summary: string;
  opportunities: OptionsRunOpportunity[];
  error?: string;
}

export function AutonomousOptionsRuns() {
  const [runs, setRuns] = useState<OptionsRun[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Issue #2470 S4: latest runs via the shared subscription, so this
  // panel and ScheduledOptionsManager produce one network poll per
  // cadence when both are mounted. Cadence, hidden-pause, and
  // externalized tuning live in the shared module, unchanged from
  // #2422. Failure is reported, never faked.
  useEffect(() => {
    return subscribeOptionsLatest((snap) => {
      if (snap.ok) {
        setRuns(snap.runs as OptionsRun[]);
        setLoadError(null);
      } else {
        setLoadError(snap.error || "Failed to load options runs");
      }
    });
  }, []);

  return (
    <section className="autonomous-runs" aria-label="Autonomous options runs">
      <div className="autonomous-runs-head">
        <CardHeader title="🤖 Autonomous Options Runs" />
        <Button variant="secondary" tone="subtle" onClick={() => refreshOptionsLatest()}>
          ↻ Refresh
        </Button>
      </div>
      {loadError && <p className="autonomous-runs-error">Could not load runs: {loadError}</p>}
      {runs === null && !loadError && <p className="autonomous-runs-loading">Loading runs…</p>}
      {runs !== null && runs.length === 0 && (
        <EmptyState
          title="No autonomous options runs yet"
          description="Scheduled scans (the hourly Strategy/Symbol Scanner) and manual options runs will appear here once they complete."
        />
      )}
      {runs !== null && runs.length > 0 && (
        <ul className="autonomous-runs-list">
          {runs.map((run, i) => (
            <li key={`${run.timestamp}-${i}`} className="autonomous-run">
              <div className="autonomous-run-head">
                <Badge tone={run.success ? "success" : "danger"}>
                  {run.success ? "Completed" : "Failed"}
                </Badge>
                <Badge tone="neutral">{run.trigger === "manual" ? "Manual" : "Scheduled"}</Badge>
                <span className="autonomous-run-thesis">{run.thesis}</span>
                <span className="autonomous-run-time">
                  {new Date(run.timestamp).toLocaleString()}
                </span>
              </div>
              <div className="autonomous-run-meta">
                {run.symbols.length} symbols · {run.withTrades} with trades
              </div>
              {run.summary && <p className="autonomous-run-summary">{run.summary}</p>}
              {run.error && <p className="autonomous-runs-error">{run.error}</p>}
              {run.opportunities.length > 0 && (
                <div className="autonomous-run-opps">
                  {run.opportunities.slice(0, 10).map((opp, j) => (
                    <span key={j} className="autonomous-run-opp">
                      {opp.symbol || "?"}
                      {opp.pick?.best?.candidate?.type ? ` · ${opp.pick.best.candidate.type}` : ""}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
