/**
 * Issue #6482 (stop the runaway 1–2s SCREENER_AGENT alarm loop through
 * configuration): the runaway controls section of the schedules home.
 * It reads the live controls from GET /api/schedules/controls and lets
 * a platform admin change them through POST /api/schedules/controls:
 * the minimum schedule interval (the floor — no arm may fire more
 * often; default monthly (2,592,000s), fail-closed), the firing kill-switch (OFF
 * halts every scheduled firing at the one choke point; manual triggers
 * are never halted), the start-paused control (new schedules start
 * paused unless an operator configures otherwise; default paused),
 * the firing-rate alert thresholds (firings per window; default 120 /
 * 60 minutes), the missed-schedule grace (minutes past an expected
 * tick before the watchdog flags a missed fire; default 60, 0
 * disables), and the armed-schedule inventory (callback +
 * interval/cron + owner + state). The firing-rate line shows the
 * firings in the alert window against the configured threshold; the
 * alert itself is an emitted observation (`schedule.firing_rate_exceeded`)
 * through the existing audit + structured-log seam, not a new
 * notification mechanism. Precedence everywhere: managed setting >
 * env carrier > default; the source of the effective value is shown.
 * Non-admins see the state read-only. Primitives only (CardHeader,
 * Badge, Button, Notice, Spinner, TextInput, Table) with token
 * styling — no raw HTML controls.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, CardHeader, EmptyState, Flex, Notice, Spinner, Stack, Table, TextInput } from "./components/ui";
import type { ArmedScheduleInventoryItem, ScheduleControlsView } from "../services/scheduleControls";

export interface ScheduleControlsViewResponse extends ScheduleControlsView {
  canToggle: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  managed: "managed setting (set here)",
  env: "environment variable",
  default: "built-in default",
};

/**
 * Issue #6482 — the floor is a monthly 2,592,000s, so the panel
 * shows the human value ("30 days") with the raw seconds kept for
 * precision. Largest exact unit wins; anything else stays seconds.
 */
function formatSeconds(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

export async function fetchScheduleControls(
  fetchImpl: typeof fetch = fetch,
): Promise<ScheduleControlsViewResponse> {
  const res = await fetchImpl("/api/schedules/controls");
  if (!res.ok) {
    throw new Error(`Reading the schedule controls failed (HTTP ${res.status}).`);
  }
  return (await res.json()) as ScheduleControlsViewResponse;
}

export interface ScheduleControlsPanelProps {
  /**
   * Test/SSR seam: a preloaded view. When absent the panel fetches
   * GET /api/schedules/controls on mount.
   */
  initialView?: ScheduleControlsViewResponse | null;
}

export function ScheduleControlsPanel({ initialView = null }: ScheduleControlsPanelProps = {}) {
  const [view, setView] = useState<ScheduleControlsViewResponse | null>(initialView);
  const [loading, setLoading] = useState(initialView === null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [floorDraft, setFloorDraft] = useState<string>("");
  const [rateThresholdDraft, setRateThresholdDraft] = useState<string>("");
  const [rateWindowDraft, setRateWindowDraft] = useState<string>("");
  const [graceDraft, setGraceDraft] = useState<string>("");

  useEffect(() => {
    if (initialView !== null) return;
    let cancelled = false;
    setLoading(true);
    fetchScheduleControls()
      .then((loaded) => {
        if (!cancelled) {
          setView(loaded);
          setFloorDraft(String(loaded.minIntervalSeconds));
          setRateThresholdDraft(String(loaded.firingRate.threshold));
          setRateWindowDraft(String(loaded.firingRate.windowMinutes));
          setGraceDraft(String(loaded.missedScheduleGraceMinutes));
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialView]);

  const postControls = useCallback(
    async (
      key: string,
      patch: {
        minIntervalSeconds?: number | null;
        firingEnabled?: boolean | null;
        startPaused?: boolean | null;
        firingRateAlertThreshold?: number | null;
        firingRateAlertWindowMinutes?: number | null;
        missedScheduleGraceMinutes?: number | null;
      },
    ) => {
      setBusy(key);
      setError(null);
      try {
        const res = await fetch("/api/schedules/controls", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const body = (await res.json().catch(() => null)) as
          | (ScheduleControlsViewResponse & { error?: string; code?: string })
          | null;
        if (!res.ok || !body) {
          throw new Error(
            (body && body.error) || `Changing the schedule controls failed (HTTP ${res.status}).`,
          );
        }
        setView(body);
        setFloorDraft(String(body.minIntervalSeconds));
        setRateThresholdDraft(String(body.firingRate.threshold));
        setRateWindowDraft(String(body.firingRate.windowMinutes));
        setGraceDraft(String(body.missedScheduleGraceMinutes));
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  if (loading) {
    return <Spinner label="Loading schedule controls…" />;
  }
  if (!view) {
    return (
      <Notice tone="danger" title="Schedule controls unavailable">
        {error ?? "The controls could not be read."}
      </Notice>
    );
  }

  const canToggle = view.canToggle;
  const floorInvalid =
    floorDraft.trim() !== "" && (!/^\d+$/.test(floorDraft.trim()) || Number(floorDraft.trim()) <= 0);
  const rateThresholdInvalid =
    rateThresholdDraft.trim() !== "" && !/^\d+$/.test(rateThresholdDraft.trim());
  const rateWindowInvalid =
    rateWindowDraft.trim() !== "" &&
    (!/^\d+$/.test(rateWindowDraft.trim()) || Number(rateWindowDraft.trim()) <= 0);
  const graceInvalid =
    graceDraft.trim() !== "" && !/^\d+(\.\d+)?$/.test(graceDraft.trim());

  return (
    <div>
      <CardHeader
        title="Runaway controls"
        meta={
          <span className="ui-meta-sm">
            The floor, the firing kill-switch, the start-paused control, the
            firing-rate alert thresholds, the missed-schedule grace, and the armed inventory — the
            stop for a runaway alarm loop. Managed here; the env carrier
            (AGENT_SCHEDULE_MIN_INTERVAL_SECONDS / SCHEDULE_FIRING_ENABLED /
            AGENT_SCHEDULE_START_PAUSED / SCHEDULE_FIRING_RATE_ALERT_THRESHOLD /
            SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES / MISSED_SCHEDULE_GRACE_MINUTES)
            only applies when no managed value is set.
          </span>
        }
      />
      {error && (
        <Notice tone="danger" title="Controls change refused" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      {!canToggle && (
        <Notice tone="neutral" title="Read-only">
          These controls are read-only for your session — only a platform admin can change
          them.
        </Notice>
      )}
      <Stack gap="3">
        <Flex justify="between" align="center" gap="2">
          <Stack gap="1" className="ui-grow">
            <div>
              Minimum schedule interval{" "}
              <span className="ui-meta-sm">schedule.minIntervalSeconds</span>
            </div>
            <div className="ui-meta-sm">
              Effective {formatSeconds(view.minIntervalSeconds)} ({view.minIntervalSeconds}s) — from {SOURCE_LABEL[view.minIntervalSource] ?? view.minIntervalSource}
              {view.managedMinIntervalSeconds !== null && ` (managed ${view.managedMinIntervalSeconds}s)`}
              {view.envMinIntervalSeconds !== null && `, env ${view.envMinIntervalSeconds}s`}
              {`, default ${view.defaultMinIntervalSeconds}s`}. No arm may fire more often.
            </div>
          </Stack>
          <Badge tone="success" dot>
            {formatSeconds(view.minIntervalSeconds)} floor
          </Badge>
        </Flex>
        {canToggle && (
          <Flex align="end" gap="2">
            <TextInput
              label="Set the floor (seconds)"
              value={floorDraft}
              inputMode="numeric"
              disabled={busy === "floor"}
              onChange={(event) => setFloorDraft(event.target.value)}
              aria-invalid={floorInvalid}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy === "floor" || floorInvalid || floorDraft.trim() === ""}
              onClick={() => void postControls("floor", { minIntervalSeconds: Number(floorDraft.trim()) })}
            >
              Set floor
            </Button>
            {view.managedMinIntervalSeconds !== null && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy === "floor"}
                onClick={() => void postControls("floor", { minIntervalSeconds: null })}
              >
                Clear managed floor
              </Button>
            )}
          </Flex>
        )}
        {floorInvalid && (
          <Notice tone="warning" title="Invalid floor">
            The floor is a whole number of seconds greater than zero.
          </Notice>
        )}
        <Flex justify="between" align="center" gap="2">
          <Stack gap="1" className="ui-grow">
            <div>
              Schedule firing{" "}
              <span className="ui-meta-sm">schedule.firingEnabled</span>
            </div>
            <div className="ui-meta-sm">
              {view.firingEnabled
                ? `Firing is ON — from ${SOURCE_LABEL[view.firingEnabledSource] ?? view.firingEnabledSource}.`
                : "Firing is OFF — scheduled firings are halted at the one choke point; manual triggers still run."}
              {view.managedFiringEnabled !== null && ` Managed ${view.managedFiringEnabled ? "ON" : "OFF"}`}
              {view.envFiringEnabled !== null && `, env ${view.envFiringEnabled ? "ON" : "OFF"}`}
              {`, default ${view.defaultFiringEnabled ? "ON" : "OFF"}`}.
            </div>
          </Stack>
          <Badge tone={view.firingEnabled ? "success" : "danger"} dot>
            {view.firingEnabled ? "ON" : "OFF"}
          </Badge>
          <Button
            variant="secondary"
            size="sm"
            tone={view.firingEnabled ? "solid" : "subtle"}
            aria-pressed={view.firingEnabled}
            disabled={!canToggle || busy === "firing"}
            onClick={() => void postControls("firing", { firingEnabled: !view.firingEnabled })}
          >
            {view.firingEnabled ? "Halt firing" : "Resume firing"}
          </Button>
        </Flex>
        <Flex justify="between" align="center" gap="2">
          <Stack gap="1">
            <div>
              New schedules start paused{" "}
              <span className="ui-meta-sm">schedule.startPaused</span>
            </div>
            <div className="ui-meta-sm">
              {view.startPaused
                ? `New schedules start paused — from ${SOURCE_LABEL[view.startPausedSource] ?? view.startPausedSource}.`
                : "New schedules start active — they run on their next schedule."}
              {view.managedStartPaused !== null && ` Managed ${view.managedStartPaused ? "paused" : "active"}`}
              {view.envStartPaused !== null && `, env ${view.envStartPaused ? "paused" : "active"}`}
              {`, default ${view.defaultStartPaused ? "paused" : "active"}`}. A paused
              schedule never fires until an operator resumes it.
            </div>
          </Stack>
          <Badge tone={view.startPaused ? "success" : "danger"} dot>
            {view.startPaused ? "Paused" : "Active"}
          </Badge>
          <Button
            variant="secondary"
            size="sm"
            tone={view.startPaused ? "solid" : "subtle"}
            aria-pressed={view.startPaused}
            disabled={!canToggle || busy === "startPaused"}
            onClick={() => void postControls("startPaused", { startPaused: !view.startPaused })}
          >
            {view.startPaused ? "Start active" : "Start paused"}
          </Button>
        </Flex>
        <Flex justify="between" align="center" gap="2">
          <Stack gap="1" className="ui-grow">
            <div>Firing rate</div>
            <div className="ui-meta-sm">
              {view.firingRate.count} firings in the last {view.firingRate.windowMinutes} minutes
              {" "}(alert threshold {view.firingRate.threshold} — from{" "}
              {SOURCE_LABEL[view.firingRate.thresholdSource] ?? view.firingRate.thresholdSource}).
            </div>
          </Stack>
          <Badge tone={view.firingRate.exceeded ? "danger" : "success"} dot>
            {view.firingRate.exceeded ? "Rate exceeded" : "Within rate"}
          </Badge>
        </Flex>
        {canToggle && (
          <Flex align="end" gap="2">
            <TextInput
              label="Alert threshold (firings, 0 disables)"
              value={rateThresholdDraft}
              inputMode="numeric"
              disabled={busy === "rate"}
              onChange={(event) => setRateThresholdDraft(event.target.value)}
              aria-invalid={rateThresholdInvalid}
            />
            <TextInput
              label="Alert window (minutes)"
              value={rateWindowDraft}
              inputMode="numeric"
              disabled={busy === "rate"}
              onChange={(event) => setRateWindowDraft(event.target.value)}
              aria-invalid={rateWindowInvalid}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={
                busy === "rate" ||
                rateThresholdInvalid ||
                rateWindowInvalid ||
                rateThresholdDraft.trim() === "" ||
                rateWindowDraft.trim() === ""
              }
              onClick={() =>
                void postControls("rate", {
                  firingRateAlertThreshold: Number(rateThresholdDraft.trim()),
                  firingRateAlertWindowMinutes: Number(rateWindowDraft.trim()),
                })
              }
            >
              Set rate alert
            </Button>
            {(view.firingRate.managedThreshold !== null ||
              view.firingRate.managedWindowMinutes !== null) && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy === "rate"}
                onClick={() =>
                  void postControls("rate", {
                    firingRateAlertThreshold: null,
                    firingRateAlertWindowMinutes: null,
                  })
                }
              >
                Clear managed rate
              </Button>
            )}
          </Flex>
        )}
        {rateThresholdInvalid && (
          <Notice tone="warning" title="Invalid threshold">
            The alert threshold is a whole number of firings; 0 disables the alert.
          </Notice>
        )}
        {rateWindowInvalid && (
          <Notice tone="warning" title="Invalid window">
            The alert window is a whole number of minutes greater than zero.
          </Notice>
        )}
        <Flex justify="between" align="center" gap="2">
          <Stack gap="1" className="ui-grow">
            <div>
              Missed-schedule grace{" "}
              <span className="ui-meta-sm">schedule.missedScheduleGraceMinutes</span>
            </div>
            <div className="ui-meta-sm">
              {view.missedScheduleGraceMinutes === 0
                ? "The watchdog is disabled — no missed-fire findings."
                : `A schedule is flagged as missed ${view.missedScheduleGraceMinutes} minutes past its expected tick — from ${SOURCE_LABEL[view.missedScheduleGraceSource] ?? view.missedScheduleGraceSource}.`}
              {view.managedMissedScheduleGraceMinutes !== null && ` Managed ${view.managedMissedScheduleGraceMinutes} minutes`}
              {view.envMissedScheduleGraceMinutes !== null && `, env ${view.envMissedScheduleGraceMinutes} minutes`}
              {`, default ${view.defaultMissedScheduleGraceMinutes} minutes`}. 0 disables the watchdog.
            </div>
          </Stack>
          <Badge tone={view.missedScheduleGraceMinutes === 0 ? "danger" : "success"} dot>
            {view.missedScheduleGraceMinutes === 0 ? "Disabled" : `${view.missedScheduleGraceMinutes} min grace`}
          </Badge>
        </Flex>
        {canToggle && (
          <Flex align="end" gap="2">
            <TextInput
              label="Grace (minutes, 0 disables)"
              value={graceDraft}
              inputMode="decimal"
              disabled={busy === "grace"}
              onChange={(event) => setGraceDraft(event.target.value)}
              aria-invalid={graceInvalid}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy === "grace" || graceInvalid || graceDraft.trim() === ""}
              onClick={() => void postControls("grace", { missedScheduleGraceMinutes: Number(graceDraft.trim()) })}
            >
              Set grace
            </Button>
            {view.managedMissedScheduleGraceMinutes !== null && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy === "grace"}
                onClick={() => void postControls("grace", { missedScheduleGraceMinutes: null })}
              >
                Clear managed grace
              </Button>
            )}
          </Flex>
        )}
        {graceInvalid && (
          <Notice tone="warning" title="Invalid grace">
            The grace is a number of minutes; 0 disables the watchdog.
          </Notice>
        )}
        <div>
          <div className="ui-meta-sm">Armed schedules — {view.inventory.length} row(s)</div>
          <Table<ArmedScheduleInventoryItem>
            columns={[
              { key: "callback", header: "Callback", render: (row) => row.callback },
              {
                key: "timing",
                header: "Interval / cron",
                render: (row) =>
                  row.intervalSeconds !== null
                    ? formatSeconds(row.intervalSeconds)
                    : row.cron !== null
                      ? row.cron
                      : "one-shot",
              },
              { key: "owner", header: "Owner", render: (row) => row.owner ?? "Unknown" },
              { key: "state", header: "State", render: (row) => row.state },
            ]}
            rows={view.inventory}
            rowKey={(row) => row.id}
            empty={<EmptyState title="No armed schedules" description="Nothing is armed." />}
          />
        </div>
      </Stack>
    </div>
  );
}
