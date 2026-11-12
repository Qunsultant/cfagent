/**
 * Unified Jobs panel: one management surface for all three schedule
 * systems, beside the existing panels (which all stay). Goals and
 * durable schedules are listed with their per-run history; Worker
 * cron triggers are listed read-only and labelled deployment-only.
 * Creation and triggering go through the EXISTING endpoints only —
 * no duplicated creation logic lives here.
 *
 * UX rules followed: ui primitives only, token styling via the
 * primitives and ui-* utility classes (no new stylesheet, no inline
 * styles), and no issue-number patterns in rendered text.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState, Modal, Notice, Select, Table, TextInput } from "./components/ui";
import {
  addGoal,
  createSchedule,
  deleteSchedule,
  listAllRuns,
  listGoals,
  listOperations,
  listScheduleCallbacks,
  listSchedules,
  listSystems,
  pauseSchedule,
  removeGoal,
  resumeSchedule,
  setGoalEnabled,
  triggerGoal,
  triggerSchedule,
  type CatalogOperation,
  type ScheduleListItem,
  type ScheduledGoal,
  type SystemsResponse,
} from "./jobsApi";
import type { JobRunRecord } from "../services/jobRunRecords";

export interface JobsPanelProps {
  embedded?: boolean;
}

function outcomeTone(outcome: JobRunRecord["outcome"]): "success" | "danger" | "warning" {
  if (outcome === "success") return "success";
  if (outcome === "failure") return "danger";
  return "warning";
}

function runSummary(run: JobRunRecord): string {
  if (run.outcome === "failure") return run.error ?? "failed";
  if (run.outcome === "skipped") return run.detail ?? "skipped";
  return run.descriptor ?? "ok";
}

function fmtTime(iso?: string): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function scheduleCadence(s: ScheduleListItem): string {
  if (s.type === "cron" && s.cron) return s.cron;
  if (s.type === "interval" && s.intervalSeconds) return `every ${s.intervalSeconds}s`;
  if ((s.type === "scheduled" || s.type === "delayed") && s.time) {
    return new Date(s.time * 1000).toLocaleString();
  }
  return s.type ?? "";
}

export function JobsPanel({ embedded = false }: JobsPanelProps = {}) {
  const [goals, setGoals] = useState<ScheduledGoal[]>([]);
  const [goalRuns, setGoalRuns] = useState<JobRunRecord[]>([]);
  const [schedules, setSchedules] = useState<ScheduleListItem[]>([]);
  const [scheduleRuns, setScheduleRuns] = useState<JobRunRecord[]>([]);
  const [systems, setSystems] = useState<SystemsResponse | null>(null);
  const [operations, setOperations] = useState<CatalogOperation[]>([]);
  const [callbacks, setCallbacks] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [goalDeleteTarget, setGoalDeleteTarget] = useState<ScheduledGoal | null>(null);
  const [scheduleDeleteTarget, setScheduleDeleteTarget] = useState<ScheduleListItem | null>(null);
  const [goalForm, setGoalForm] = useState({ id: "", name: "", cron: "", operation: "", budgetCents: "1", timeZone: "" });
  const [goalFormError, setGoalFormError] = useState<string | null>(null);
  const [scheduleForm, setScheduleForm] = useState({ callback: "", scheduleType: "cron" as "cron" | "interval", cron: "", intervalSeconds: "", payloadJson: "{}" });
  const [scheduleFormError, setScheduleFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [g, all, s, sys, ops, cbs] = await Promise.all([
        listGoals(),
        listAllRuns(undefined, 200),
        listSchedules(),
        listSystems(),
        listOperations(),
        listScheduleCallbacks(),
      ]);
      setGoals(g.goals);
      // The one merged list, split back by system: goal rows carry
      // system "scheduled-agent-goal" (wherever they were written);
      // every other system is a schedule row. The split reproduces
      // the old two-reads shape for the per-kind lookups below.
      setGoalRuns(all.runs.filter((r) => r.system === "scheduled-agent-goal"));
      setSchedules(s);
      setScheduleRuns(all.runs.filter((r) => r.system !== "scheduled-agent-goal"));
      setSystems(sys);
      setOperations(ops.operations);
      setCallbacks(cbs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load jobs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const latestGoalRun = (id: string) => goalRuns.find((r) => r.jobId === id);
  const latestScheduleRun = (id: string) => scheduleRuns.find((r) => r.jobId === id);

  const submitGoalForm = async () => {
    setGoalFormError(null);
    if (!goalForm.id.trim() || !goalForm.name.trim() || !goalForm.cron.trim() || !goalForm.operation) {
      setGoalFormError("Id, name, cron, and operation are required.");
      return;
    }
    if (goalForm.timeZone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: goalForm.timeZone });
      } catch {
        setGoalFormError(`Invalid timeZone: ${goalForm.timeZone}`);
        return;
      }
    }
    await withBusy("add-goal", () =>
      addGoal({
        id: goalForm.id.trim(),
        name: goalForm.name.trim(),
        cron: goalForm.cron.trim(),
        operation: goalForm.operation,
        budgetCents: Number(goalForm.budgetCents) || 1,
        ...(goalForm.timeZone ? { timeZone: goalForm.timeZone } : {}),
      }).then(() => {
        setGoalForm({ id: "", name: "", cron: "", operation: "", budgetCents: "1", timeZone: "" });
      }),
    );
  };

  const submitScheduleForm = async () => {
    setScheduleFormError(null);
    if (!scheduleForm.callback) {
      setScheduleFormError("Choose a callback.");
      return;
    }
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = scheduleForm.payloadJson.trim() ? JSON.parse(scheduleForm.payloadJson) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("payload must be a JSON object");
      }
      payload = parsed as Record<string, unknown>;
    } catch (err) {
      setScheduleFormError(err instanceof Error ? err.message : "Invalid payload JSON.");
      return;
    }
    if (scheduleForm.scheduleType === "cron" && !scheduleForm.cron.trim()) {
      setScheduleFormError("A cron expression is required for cron schedules.");
      return;
    }
    if (scheduleForm.scheduleType === "interval" && !(Number(scheduleForm.intervalSeconds) > 0)) {
      setScheduleFormError("Interval seconds must be a positive number.");
      return;
    }
    await withBusy("add-schedule", () =>
      createSchedule({
        scheduleType: scheduleForm.scheduleType,
        callback: scheduleForm.callback,
        payload,
        ...(scheduleForm.scheduleType === "cron" ? { cron: scheduleForm.cron.trim() } : {}),
        ...(scheduleForm.scheduleType === "interval" ? { intervalSeconds: Number(scheduleForm.intervalSeconds) } : {}),
      }).then(() => {
        setScheduleForm({ callback: "", scheduleType: "cron", cron: "", intervalSeconds: "", payloadJson: "{}" });
      }),
    );
  };

  const runColumns = [
    { key: "started", header: "Started", render: (r: JobRunRecord) => fmtTime(r.started) },
    {
      key: "outcome",
      header: "Outcome",
      render: (r: JobRunRecord) => <Badge tone={outcomeTone(r.outcome)}>{r.outcome}</Badge>,
    },
    { key: "triggeredBy", header: "Trigger", render: (r: JobRunRecord) => r.triggeredBy },
    { key: "summary", header: "Result", render: (r: JobRunRecord) => runSummary(r) },
  ];

  return (
    <div className={embedded ? "" : "jobs-panel"}>
      <div className="ui-mb-1">
        <Button size="sm" variant="secondary" disabled={loading} onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>
      {error && (
        <Notice tone="danger" title="Jobs failed to load or update">
          {error}
        </Notice>
      )}

      <h3 className="ui-mt-2">Scheduled goals</h3>
      <p className="ui-meta">Budget-checked operations evaluated on the worker tick. Run history comes from per-run records, not just the last run.</p>
      <Table
        columns={[
          { key: "name", header: "Goal", render: (g: ScheduledGoal) => <span>{g.name} <span className="ui-meta-sm">{g.id}</span></span> },
          { key: "cron", header: "Cron", render: (g: ScheduledGoal) => g.cron },
          { key: "operation", header: "Operation", render: (g: ScheduledGoal) => g.operation },
          {
            key: "enabled",
            header: "Status",
            render: (g: ScheduledGoal) => <Badge tone={g.enabled ? "success" : "neutral"}>{g.enabled ? "ENABLED" : "DISABLED"}</Badge>,
          },
          { key: "lastRun", header: "Last run", render: (g: ScheduledGoal) => fmtTime(g.lastRun) },
          {
            key: "latest",
            header: "Latest result",
            render: (g: ScheduledGoal) => {
              const run = latestGoalRun(g.id);
              if (!run) return "No runs yet";
              return <span><Badge tone={outcomeTone(run.outcome)}>{run.outcome}</Badge> {runSummary(run)}</span>;
            },
          },
          {
            key: "actions",
            header: "Actions",
            render: (g: ScheduledGoal) => (
              <span>
                <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void withBusy(`toggle-${g.id}`, () => setGoalEnabled(g.id, !g.enabled).then(() => {}))}>
                  {g.enabled ? "Disable" : "Enable"}
                </Button>{" "}
                <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void withBusy(`trigger-${g.id}`, () => triggerGoal(g.id).then(() => {}))}>
                  Run now
                </Button>{" "}
                <Button size="sm" variant="ghost" onClick={() => setSelectedGoalId(selectedGoalId === g.id ? null : g.id)}>
                  History
                </Button>{" "}
                <Button size="sm" variant="danger" tone="subtle" onClick={() => setGoalDeleteTarget(g)}>
                  Remove
                </Button>
              </span>
            ),
          },
        ]}
        rows={goals}
        rowKey={(g) => g.id}
        empty={<EmptyState title="No goals" />}
      />
      {selectedGoalId && (
        <div className="ui-mt-2">
          <h4>Run history: {selectedGoalId}</h4>
          <Table
            columns={runColumns}
            rows={goalRuns.filter((r) => r.jobId === selectedGoalId)}
            rowKey={(r) => `${r.jobId}-${r.started}-${r.outcome}`}
            empty={<EmptyState title="No runs yet" />}
          />
        </div>
      )}

      <h3 className="ui-mt-2">Add a goal</h3>
      {goalFormError && <Notice tone="danger">{goalFormError}</Notice>}
      <div className="ui-form-row">
        <TextInput label="Id" value={goalForm.id} onChange={(e) => setGoalForm({ ...goalForm, id: e.target.value })} />
        <TextInput label="Name" value={goalForm.name} onChange={(e) => setGoalForm({ ...goalForm, name: e.target.value })} />
      </div>
      <div className="ui-form-row">
        <TextInput label="Cron" value={goalForm.cron} onChange={(e) => setGoalForm({ ...goalForm, cron: e.target.value })} />
        <Select label="Operation" aria-label="operation" value={goalForm.operation} disabled={operations.length === 0} onChange={(e) => setGoalForm({ ...goalForm, operation: e.target.value })}>
          <option value="">{operations.length === 0 ? "Could not load operations" : "Select an operation…"}</option>
          {operations.map((op) => (
            <option key={op.operation} value={op.operation}>
              {op.operation}
            </option>
          ))}
        </Select>
      </div>
      <div className="ui-form-row">
        <TextInput label="Budget (cents)" value={goalForm.budgetCents} onChange={(e) => setGoalForm({ ...goalForm, budgetCents: e.target.value })} />
        <TextInput label="Time zone (optional)" value={goalForm.timeZone} onChange={(e) => setGoalForm({ ...goalForm, timeZone: e.target.value })} />
      </div>
      <div className="ui-mt-2">
        <Button variant="primary" disabled={!!busy} onClick={() => void submitGoalForm()}>
          Add goal
        </Button>
      </div>

      <h3 className="ui-mt-2">Durable schedules</h3>
      <p className="ui-meta">Orchestrator schedules woken directly by the platform. Paused schedules show no next run; resume them before triggering.</p>
      <Table
        columns={[
          { key: "callback", header: "Callback", render: (s: ScheduleListItem) => <span>{s.callback} <span className="ui-meta-sm">{s.id}</span></span> },
          { key: "cadence", header: "Cadence", render: (s: ScheduleListItem) => scheduleCadence(s) },
          {
            key: "status",
            header: "Status",
            render: (s: ScheduleListItem) => (s.paused ? <Badge tone="warning">PAUSED</Badge> : <Badge tone="success">ACTIVE</Badge>),
          },
          {
            key: "nextRun",
            header: "Next run",
            render: (s: ScheduleListItem) => (s.paused ? "Paused" : s.time ? new Date(s.time * 1000).toLocaleString() : "—"),
          },
          {
            key: "latest",
            header: "Latest result",
            render: (s: ScheduleListItem) => {
              const run = latestScheduleRun(s.id);
              if (!run) return "No runs yet";
              return <span><Badge tone={outcomeTone(run.outcome)}>{run.outcome}</Badge> {runSummary(run)}</span>;
            },
          },
          {
            key: "actions",
            header: "Actions",
            render: (s: ScheduleListItem) => (
              <span>
                <Button size="sm" variant="secondary" disabled={!!busy || !!s.paused} onClick={() => void withBusy(`trigger-${s.id}`, () => triggerSchedule(s.id))}>
                  Run now
                </Button>{" "}
                <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void withBusy(`pause-${s.id}`, () => (s.paused ? resumeSchedule(s.id) : pauseSchedule(s.id)))}>
                  {s.paused ? "Resume" : "Pause"}
                </Button>{" "}
                <Button size="sm" variant="ghost" onClick={() => setSelectedScheduleId(selectedScheduleId === s.id ? null : s.id)}>
                  History
                </Button>{" "}
                <Button size="sm" variant="danger" tone="subtle" onClick={() => setScheduleDeleteTarget(s)}>
                  Delete
                </Button>
              </span>
            ),
          },
        ]}
        rows={schedules}
        rowKey={(s) => s.id}
        empty={<EmptyState title="No schedules" />}
      />
      {selectedScheduleId && (
        <div className="ui-mt-2">
          <h4>Run history: {selectedScheduleId}</h4>
          <Table
            columns={runColumns}
            rows={scheduleRuns.filter((r) => r.jobId === selectedScheduleId)}
            rowKey={(r) => `${r.jobId}-${r.started}-${r.outcome}`}
            empty={<EmptyState title="No runs yet" />}
          />
        </div>
      )}

      <h3 className="ui-mt-2">Create a schedule</h3>
      <p className="ui-meta">Only the gated callbacks can be armed from here. Screening schedules need a connected account; the server reports that plainly.</p>
      {scheduleFormError && <Notice tone="danger">{scheduleFormError}</Notice>}
      <div className="ui-form-row">
        <Select label="Callback" aria-label="callback" value={scheduleForm.callback} disabled={callbacks.length === 0} onChange={(e) => setScheduleForm({ ...scheduleForm, callback: e.target.value })}>
          <option value="">{callbacks.length === 0 ? "Could not load callbacks" : "Select a callback…"}</option>
          {callbacks.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <Select label="Type" aria-label="schedule type" value={scheduleForm.scheduleType} onChange={(e) => setScheduleForm({ ...scheduleForm, scheduleType: e.target.value as "cron" | "interval" })}>
          <option value="cron">Cron</option>
          <option value="interval">Interval</option>
        </Select>
      </div>
      <div className="ui-form-row">
        {scheduleForm.scheduleType === "cron" ? (
          <TextInput label="Cron" value={scheduleForm.cron} onChange={(e) => setScheduleForm({ ...scheduleForm, cron: e.target.value })} />
        ) : (
          <TextInput label="Interval seconds" value={scheduleForm.intervalSeconds} onChange={(e) => setScheduleForm({ ...scheduleForm, intervalSeconds: e.target.value })} />
        )}
        <TextInput label="Payload (JSON object)" multiline rows={3} value={scheduleForm.payloadJson} onChange={(e) => setScheduleForm({ ...scheduleForm, payloadJson: e.target.value })} />
      </div>
      <div className="ui-mt-2">
        <Button variant="primary" disabled={!!busy} onClick={() => void submitScheduleForm()}>
          Create schedule
        </Button>
      </div>

      <h3 className="ui-mt-2">Worker cron triggers</h3>
      <p className="ui-meta">Platform triggers declared in deployment config. They are read-only here: changing one is a deployment action, never a UI edit.</p>
      <Table
        columns={[
          { key: "cron", header: "Cron", render: (cron: string) => cron },
          { key: "note", header: "Note", render: () => "Deployment-only" },
        ]}
        rows={systems?.cronTriggers ?? []}
        rowKey={(cron) => cron}
        empty={<EmptyState title="No cron triggers" />}
      />

      <div className="ui-mt-2">
        <Notice tone="info" title="Coverage note">
          Platform firings of internal-only callbacks (async-job plumbing, draft expiry, IV collection, token renewal) have no per-run record in this slice; their outcomes stay visible through their own feeds. Manual triggers of those callbacks from this panel are recorded. Paused schedules refuse Run now until resumed.
        </Notice>
      </div>

      <Modal open={goalDeleteTarget !== null} onClose={() => setGoalDeleteTarget(null)} title="Remove goal?">
        <p>Removing {goalDeleteTarget?.id} deletes the goal. Past run records stay readable.</p>
        <div className="ui-mt-2">
          <Button variant="danger" disabled={!!busy} onClick={() => { const t = goalDeleteTarget; setGoalDeleteTarget(null); if (t) void withBusy(`remove-${t.id}`, () => removeGoal(t.id).then(() => {})); }}>
            Remove
          </Button>{" "}
          <Button variant="secondary" onClick={() => setGoalDeleteTarget(null)}>
            Keep
          </Button>
        </div>
      </Modal>
      <Modal open={scheduleDeleteTarget !== null} onClose={() => setScheduleDeleteTarget(null)} title="Delete schedule?">
        <p>Deleting {scheduleDeleteTarget?.id} cancels the schedule. Past run records stay readable.</p>
        <div className="ui-mt-2">
          <Button variant="danger" disabled={!!busy} onClick={() => { const t = scheduleDeleteTarget; setScheduleDeleteTarget(null); if (t) void withBusy(`delete-${t.id}`, () => deleteSchedule(t.id)); }}>
            Delete
          </Button>{" "}
          <Button variant="secondary" onClick={() => setScheduleDeleteTarget(null)}>
            Keep
          </Button>
        </div>
      </Modal>
    </div>
  );
}
