/**
 * ScreeningActivityPanel — issue #1162 (epic #1096 Phase 6).
 *
 * The public-style activity log for the autonomous screening system:
 * discovery runs, strategy-bank re-selections, weights-v2 adjustments,
 * challenger promotions, channel deliveries, and control changes —
 * one newest-first feed served by GET /api/screening/activity — plus
 * the rollout controls that gate the scheduled system (rollout stage,
 * channel delivery, v2-weight ranking, NLQ fit discovery, and the
 * scheduled pause) served by GET|POST /api/screening/controls.
 *
 * The panel is read-mostly and fail-soft: if the API is unreachable
 * the section says so instead of breaking the research panel around
 * it. Pausing here pauses ONLY the #1096 screening steps on the
 * scheduled tick; the underlying research run has its own controls.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, CardHeader } from "../components/ui";
import { apiFetch } from "../apiFetch";

export interface ScreeningActivityEntryView {
  id: string;
  kind: string;
  summary: string;
  actor: string | null;
  refId: string | null;
  createdAt: string;
}

export interface ScreeningControlsView {
  rolloutStage: "internal" | "paper" | "broader";
  channelsEnabled: boolean;
  nlqFitDiscovery: boolean;
  weightsV2Ranking: boolean;
  scheduledPaused: boolean;
}

export const SCREENING_ACTIVITY_KIND_LABELS: Record<string, string> = {
  discovery_run: "Discovery run",
  goal_screen: "Goal screen",
  goal_decision: "Goal decision",
  bundle: "Recommendation bundle",
  reselection: "Strategy re-selection",
  weights_adjustment: "Weights adjustment",
  promotion: "Promotion",
  delivery: "Channel delivery",
  schedule_control: "Schedule control",
  stage: "Pipeline stage",
};

interface ScreeningActivityPanelProps {
  userLogin?: string;
}

export function ScreeningActivityPanel({ userLogin }: ScreeningActivityPanelProps) {
  const [feed, setFeed] = useState<ScreeningActivityEntryView[]>([]);
  const [controls, setControls] = useState<ScreeningControlsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const headers = useCallback((): Record<string, string> => {
    return {
      "Content-Type": "application/json",
      ...(userLogin ? { "x-user-login": userLogin } : {}),
    };
  }, [userLogin]);

  const load = useCallback(async () => {
    try {
      const [activityResp, controlsResp] = await Promise.all([
        apiFetch("/api/screening/activity?limit=25", { headers: headers() }),
        apiFetch("/api/screening/controls", { headers: headers() }),
      ]);
      if (!activityResp.ok || !controlsResp.ok) {
        throw new Error("screening activity API unavailable");
      }
      const activity = (await activityResp.json()) as { feed?: ScreeningActivityEntryView[] };
      const controlsBody = (await controlsResp.json()) as ScreeningControlsView;
      setFeed(Array.isArray(activity.feed) ? activity.feed : []);
      setControls(controlsBody);
      setLoadError(null);
    } catch {
      setLoadError("Screening activity is unavailable right now.");
    }
  }, [headers]);

  useEffect(() => {
    void load();
  }, [load]);

  const togglePaused = useCallback(async () => {
    if (!controls || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const resp = await apiFetch("/api/screening/controls", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ scheduledPaused: !controls.scheduledPaused }),
      });
      if (!resp.ok) throw new Error("control update failed");
      const body = (await resp.json()) as ScreeningControlsView;
      setControls(body);
      await load();
    } catch {
      setActionError("The pause control could not be updated. Try again from a refreshed panel.");
    } finally {
      setBusy(false);
    }
  }, [controls, busy, headers, load]);

  return (
    <section
      aria-label="Screening activity"
      style={{
        margin: "1.5rem 0",
        padding: "var(--space-6)",
        background: "var(--color-surface-sunken)",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "8px",
      }}
    >
      <CardHeader title="🤖 Autonomous Screening Activity" />
      <p style={{ margin: "0 0 0.75rem", color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)", lineHeight: 1.5 }}>
        What the screening system did on its own: discovery runs, strategy re-selections, weight
        adjustments, promotions, and channel deliveries. Everything here is a proposal or a draft —
        nothing trades and nothing activates without a person.
      </p>

      {loadError && (
        <p style={{ margin: 0, color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" }}>{loadError}</p>
      )}

      {!loadError && controls && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "center", marginBottom: "0.75rem" }}>
          <span style={{ color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)" }}>
            Rollout stage: <strong>{controls.rolloutStage}</strong>
          </span>
          <span style={{ color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)" }}>
            Channels: <strong>{controls.channelsEnabled ? "on" : "off"}</strong>
          </span>
          <span style={{ color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)" }}>
            V2-weight ranking: <strong>{controls.weightsV2Ranking ? "on" : "off"}</strong>
          </span>
          <span style={{ color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)" }}>
            Scheduled screening: <strong>{controls.scheduledPaused ? "paused" : "running"}</strong>
          </span>
          <Button type="button" onClick={() => void togglePaused()} disabled={busy}>
            {controls.scheduledPaused ? "Resume scheduled screening" : "Pause scheduled screening"}
          </Button>
        </div>
      )}
      {actionError && (
        <p style={{ margin: "0 0 0.75rem", color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" }}>{actionError}</p>
      )}

      {!loadError && feed.length === 0 && (
        <p style={{ margin: 0, color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" }}>
          No screening activity recorded yet.
        </p>
      )}
      {feed.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: "var(--space-4)" }}>
          {feed.map((entry) => (
            <li key={entry.id} style={{ color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)", lineHeight: 1.55 }}>
              <strong>{SCREENING_ACTIVITY_KIND_LABELS[entry.kind] ?? entry.kind}</strong>
              {" — "}
              {entry.summary}
              {" "}
              <span style={{ color: "var(--color-text-muted)" }}>
                ({new Date(entry.createdAt).toLocaleString()}
                {entry.actor ? ` · ${entry.actor}` : ""})
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
