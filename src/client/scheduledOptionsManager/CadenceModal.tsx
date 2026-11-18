import React from "react";
import { Badge, Button, CardHeader, Checkbox, Modal, Notice, TextInput } from "../components/ui";
import type { ScheduledTaskItem } from "./types";
import { FREQUENCY_PRESETS, cadenceNeedsOptIn, cadenceText } from "./format";
import { scheduleTitle } from "./scheduleDetail";

export interface CadenceModalProps {
  item: ScheduledTaskItem | null;
  busy: boolean;
  error: string | null;
  onApply: (
    item: ScheduledTaskItem,
    body: { scheduleType: "interval" | "cron"; intervalSeconds?: number; cron?: string; subDailyOptIn?: boolean }
  ) => Promise<void>;
  onClose: () => void;
}

/**
 * The one cadence editor (issue #2329). Before this dialog the generic
 * schedule rows expanded an inline preset grid under the card; the
 * screening rows had a second one. One dialog, one preset list, one
 * custom-cron field — opened by the row's Edit control.
 */
/** A live feed runs on an interval: it has no cron phase (issue #4389). */
function isIntervalOnly(item: ScheduledTaskItem): boolean {
  return item.kind === "ticker-push";
}

export function CadenceModal({ item, busy, error, onApply, onClose }: CadenceModalProps) {
  const [customCron, setCustomCron] = React.useState("");
  // Issue #4235 — the owner's explicit opt-in to a sub-daily
  // cadence. Hydrated from the schedule's current cadence (a
  // sub-daily schedule was already opted in); a picked preset or
  // custom cron applies with it when checked.
  const [subDailyOptIn, setSubDailyOptIn] = React.useState(false);

  React.useEffect(() => {
    if (item) {
      setCustomCron("");
      setSubDailyOptIn(
        cadenceNeedsOptIn(
          item.type,
          item.type === "interval" ? item.intervalSeconds : item.type === "cron" ? item.cron : undefined,
        ),
      );
    }
  }, [item?.id]);

  if (!item) return null;

  const optIn = subDailyOptIn ? { subDailyOptIn: true as const } : {};

  return (
    <Modal
      open
      onClose={onClose}
      size="none"
      panelClassName="sched-cadence-modal"
      ariaLabel={`Edit cadence for ${scheduleTitle(item)}`}
    >
      <header className="sched-dialog-header">
        <div>
          <CardHeader title="Edit cadence" />
          <p className="sched-dialog-subtitle">
            {scheduleTitle(item)} · <code>{item.id}</code>
          </p>
          <p className="sched-dialog-subtitle">
            Current: <Badge tone="accent" size="xs">{cadenceText(item)}</Badge>
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      </header>

      {error && (
        <Notice tone="danger" density="compact">
          {error}
        </Notice>
      )}

      {(item.type === "delayed" || item.type === "scheduled") && (
        <Notice tone="warning" density="compact">
          This schedule runs once — picking a cadence converts it to a
          recurring schedule.
        </Notice>
      )}

      <section className="sched-detail-section">
        <CardHeader title="Presets" />
        <div className="sched-cadence-presets">
          {FREQUENCY_PRESETS.filter(
            // Issue #4389 — a feed cannot run a cron, so its dialog offers only
            // the interval presets: no option here can be refused by the route.
            (preset) => !isIntervalOnly(item) || preset.body.scheduleType === "interval",
          ).map((preset) => (
            <Button
              key={preset.id}
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => onApply(item, { ...preset.body, ...optIn })}
              title={`Set cadence to ${preset.label}`}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </section>

      {isIntervalOnly(item) ? (
        // Issue #4389 — the feed's dialog says why cron is absent, instead of
        // offering a control the server refuses.
        <section className="sched-detail-section">
          <CardHeader title="Interval only" />
          <p className="sched-detail-note">
            The ticker push is a live feed: it runs on an interval, so there is no
            cron expression to set. Pick an interval above.
          </p>
        </section>
      ) : (
        <section className="sched-detail-section">
          <CardHeader title="Custom cron (UTC)" />
          <div className="sched-cadence-custom">
            <TextInput
              aria-label="Custom cron expression"
              type="text"
              placeholder="Custom cron, e.g. 0 9 * * 1-5"
              value={customCron}
              onChange={(event) => setCustomCron(event.target.value)}
            />
            <Button
              type="button"
              variant="primary"
              disabled={busy || !customCron.trim()}
              loading={busy}
              onClick={() => onApply(item, { scheduleType: "cron", cron: customCron.trim(), ...optIn })}
            >
              Apply cron
            </Button>
          </div>
          <p className="sched-detail-note">
            Cron runs in UTC. Presets above are the supported cadences; a custom
            expression replaces the current cadence on save.
          </p>
        </section>
      )}

      <section className="sched-detail-section">
        <CardHeader title="More than once per day" />
        <Checkbox
          id="sched-cadence-sub-daily-opt-in"
          label="Run more than once per day (explicit opt-in)"
          checked={subDailyOptIn}
          disabled={busy}
          onChange={(event) => setSubDailyOptIn(event.target.checked)}
        />
        <p className="sched-detail-note">
          Sub-daily cadences cost more compute and are off by default — check
          the box to opt this schedule in explicitly before picking a
          sub-daily preset or cron. The opt-in is recorded on the schedule.
        </p>
      </section>
    </Modal>
  );
}
