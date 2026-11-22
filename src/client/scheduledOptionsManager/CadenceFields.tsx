import React from "react";
import { etToUtcCron } from "../options/cronTime";
import { Checkbox, Select, TextInput, Button, Grid } from "../components/ui";
import type { ScheduleMode } from "./types";
import { CRON_PRESETS, INTERVAL_PRESETS, cadenceNeedsOptIn } from "./format";

export interface CadenceFieldsProps {
  scheduleType: ScheduleMode;
  setScheduleType: React.Dispatch<React.SetStateAction<ScheduleMode>>;
  intervalSeconds: number;
  setIntervalSeconds: React.Dispatch<React.SetStateAction<number>>;
  cronExpression: string;
  setCronExpression: React.Dispatch<React.SetStateAction<string>>;
  delaySeconds: number;
  setDelaySeconds: React.Dispatch<React.SetStateAction<number>>;
  scheduledDate: string;
  setScheduledDate: React.Dispatch<React.SetStateAction<string>>;
  /**
   * Issue #4235 — the owner's explicit opt-in to a sub-daily
   * cadence for this schedule. The checkbox below offers it exactly
   * when the current cadence needs it; the form submits it only
   * when checked.
   */
  subDailyOptIn: boolean;
  setSubDailyOptIn: React.Dispatch<React.SetStateAction<boolean>>;
}

export function CadenceFields(props: CadenceFieldsProps) {
  const {
    scheduleType,
    setScheduleType,
    intervalSeconds,
    setIntervalSeconds,
    cronExpression,
    setCronExpression,
    delaySeconds,
    setDelaySeconds,
    scheduledDate,
    setScheduledDate,
    subDailyOptIn,
    setSubDailyOptIn,
  } = props;
  // Issue #4235 — the opt-in control appears exactly when the
  // current cadence runs more than once per day; daily-or-less
  // cadences need no opt-in and show none.
  const needsOptIn = cadenceNeedsOptIn(
    scheduleType,
    scheduleType === "interval"
      ? intervalSeconds
      : scheduleType === "cron"
        ? cronExpression
        : undefined,
  );
  return (
              <Grid columns={2} gap="4">
                <div className="sched-form-group">
                  <Select label="Cadence Type" id="sched-cadence-type"
                    value={scheduleType}
                    onChange={(e) => setScheduleType(e.target.value as ScheduleMode)}
                  >
                    <option value="interval">Interval (Every X Minutes/Hours)</option>
                    <option value="cron">Cron Expression (Specific Time/Days)</option>
                    <option value="delayed">Delayed (Once, After a Delay)</option>
                    <option value="scheduled">One-Shot (Specific Date &amp; Time)</option>
                  </Select>
                </div>

                {scheduleType === "interval" && (
                  <div className="sched-form-group">
                    <TextInput label="Interval Seconds" id="sched-interval-seconds"
                      type="number"
                      value={intervalSeconds}
                      onChange={(e) => setIntervalSeconds(Number(e.target.value))}
                      min={60}
                      step={60}
                      required
                    />
                    <div className="preset-chips-row">
                      {INTERVAL_PRESETS.map((p) => (
                        <Button
                          key={p.label}
                          type="button"
                          className="preset-chip"
                          onClick={() => setIntervalSeconds(p.seconds)}
                        >
                          {p.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                {scheduleType === "cron" && (
                  <div className="sched-form-group">
                    <TextInput label="Cron Expression" id="sched-cron-expression"
                      type="text"
                      value={cronExpression}
                      onChange={(e) => setCronExpression(e.target.value)}
                      placeholder="e.g. 30 9 * * 1-5"
                      required
                    />
                    <div className="preset-chips-row">
                      {CRON_PRESETS.map((p) => (
                        <Button
                          key={p.label}
                          type="button"
                          className="preset-chip"
                          onClick={() =>
                            setCronExpression(
                              etToUtcCron({
                                hour: p.etHour,
                                minute: p.etMinute,
                                ...(p.daysOfWeek !== undefined ? { daysOfWeek: p.daysOfWeek } : {}),
                                ...(p.dayOfMonth !== undefined ? { dayOfMonth: p.dayOfMonth } : {}),
                                ...(p.month !== undefined ? { month: p.month } : {}),
                              })
                            )
                          }
                        >
                          {p.label}
                        </Button>
                      ))}
                    </div>
                    <p className="sched-preset-note">
                      Preset times are Eastern (ET) and are converted to UTC when picked, because
                      schedules run in UTC. After the spring or autumn clock change, a saved schedule
                      will fire one hour off its ET label until you re-save it.
                    </p>
                  </div>
                )}

                {scheduleType === "delayed" && (
                  <div className="sched-form-group">
                    <TextInput label="Delay Seconds" id="sched-delay-seconds"
                      type="number"
                      value={delaySeconds}
                      onChange={(e) => setDelaySeconds(Number(e.target.value))}
                      min={1}
                      step={60}
                      required
                    />
                    <p className="sched-preset-note">
                      Runs once, this many seconds after the schedule is saved.
                    </p>
                  </div>
                )}

                {scheduleType === "scheduled" && (
                  <div className="sched-form-group">
                    <TextInput label="Run At (One-Shot)" id="sched-run-at"
                      type="datetime-local"
                      value={scheduledDate}
                      onChange={(e) => setScheduledDate(e.target.value)}
                      required
                    />
                    <p className="sched-preset-note">
                      Runs once at the chosen date and time (your local time).
                    </p>
                  </div>
                )}

                {needsOptIn && (
                  <div className="sched-form-group">
                    <Checkbox
                      id="sched-sub-daily-opt-in"
                      label="Run more than once per day (explicit opt-in)"
                      checked={subDailyOptIn}
                      onChange={(e) => setSubDailyOptIn(e.target.checked)}
                    />
                    <p className="sched-preset-note">
                      This cadence runs more than once per day, which costs
                      more compute. It is off by default — check the box to
                      opt this schedule in explicitly. The opt-in is recorded
                      on the schedule.
                    </p>
                  </div>
                )}
              </Grid>
  );
}
