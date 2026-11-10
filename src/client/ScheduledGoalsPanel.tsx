/**
 * Issue #159: ScheduledAgent dashboard — goals, tick history, and add-goal form.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  listGoals,
  getTickHistory,
  addGoal,
  setGoalEnabled,
  triggerGoal,
  removeGoal,
  listOperations,
  listBuiltinGoals,
  addBuiltinGoals,
  addResourceGoals,
  RESOURCE_GOALS_PRESET,
  type ScheduledGoal,
  type ScheduleTick,
  type CatalogOperation,
  type PresetGoalResult,
} from "./scheduleApi";
// Issue #3121 S3 — the goals view reads run history from the one
// consolidated ledger (`listGoalRuns`, the same read the runs view
// uses), normalized with the S1 normalizer — no second read path.
// The linkage cells are the ledger view's own rule (null renders
// as "— / not applicable"), reused, not re-implemented.
import { listGoalRuns, type JobRunRecord } from "./jobsApi";
import { normalizeJobRunRecord } from "../services/jobRunRecords";
import { ledgerLinkageCell, ledgerLinkageTitle } from "./ScheduleRunLedgerPanel";
import { TextInput, Select, Button, Checkbox, Modal } from "./components/ui";
import { DelegationContractPreview } from "./DelegationContractPreview";
import { buildDelegationContract } from "./delegationContract";

export interface ScheduledGoalsPanelProps {
  embedded?: boolean;
}

const inputStyle: React.CSSProperties = { padding: "var(--space-2) var(--space-3)", width: "100%" };

export function ScheduledGoalsPanel({ embedded = false }: ScheduledGoalsPanelProps = {}) {
  const [goals, setGoals] = useState<ScheduledGoal[]>([]);
  const [ticks, setTicks] = useState<ScheduleTick[]>([]);
  const [operations, setOperations] = useState<CatalogOperation[]>([]);
  const [runs, setRuns] = useState<JobRunRecord[]>([]);
  const [runsError, setRunsError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    id: "",
    name: "",
    cron: "",
    operation: "",
    budgetCents: "",
    timeZone: "UTC",
    enabled: true,
  });
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState("");
  const [presetResults, setPresetResults] = useState<PresetGoalResult[] | null>(null);
  // Issue #3996 — built-in goals read from the server (single
  // source of truth: src/schedule.ts DEFAULT_SCHEDULES via GET
  // /api/schedule/builtin-goals, never a client-side copy).
  const [builtinGoals, setBuiltinGoals] = useState<ScheduledGoal[]>([]);
  const [builtinLoadError, setBuiltinLoadError] = useState("");
  const [builtinSelection, setBuiltinSelection] = useState("");
  const [builtinNotice, setBuiltinNotice] = useState("");
  const [seedResults, setSeedResults] = useState<PresetGoalResult[] | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ScheduledGoal | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [g, t, ops] = await Promise.all([listGoals(), getTickHistory(20), listOperations()]);
      setGoals(g.goals);
      setTicks(t.ticks);
      setOperations(ops.operations);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load schedules.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Issue #3121 S3 — the runs read is separate from the goals read
  // on purpose: the ledger read must never fail the goals list (a
  // runs-read failure shows in the runs section only), and a
  // mutation refreshes both.
  const refreshRuns = useCallback(async () => {
    try {
      const goalRuns = await listGoalRuns(undefined, 20);
      setRuns(goalRuns.map(normalizeJobRunRecord));
      setRunsError("");
    } catch (cause) {
      setRunsError(cause instanceof Error ? cause.message : "Could not load goal runs.");
    }
  }, []);

  // Issue #3996 — the built-in read is separate from the goals
  // read on purpose, like the runs read above: a built-in-read
  // failure must never fail the goals list (the dropdown and the
  // seed-all button simply stay empty, with a note in their
  // section).
  const refreshBuiltin = useCallback(async () => {
    try {
      const builtins = await listBuiltinGoals();
      setBuiltinGoals(builtins.goals);
      setBuiltinLoadError("");
    } catch (cause) {
      setBuiltinGoals([]);
      setBuiltinLoadError(cause instanceof Error ? cause.message : "Could not load built-in goals.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshRuns();
    void refreshBuiltin();
  }, [refresh, refreshRuns, refreshBuiltin]);

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await refresh();
      await refreshRuns();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed.");
    } finally {
      setBusy("");
    }
  };

  const submitGoal = async () => {
    setFormError("");
    const budgetCents = Number(form.budgetCents);
    if (!form.id.trim() || !form.name.trim() || !form.cron.trim() || !form.operation.trim()) {
      setFormError("id, name, cron, and operation are required.");
      return;
    }
    if (!Number.isFinite(budgetCents) || budgetCents <= 0) {
      setFormError("budget must be a positive number of cents.");
      return;
    }
    // Issue #1922: timeZone is validated client-side with the same
    // check the server applies (Intl.DateTimeFormat throws on an
    // unknown IANA zone). An empty timeZone is omitted, preserving
    // the historical server fallback; a present one is sent as-is.
    const timeZone = form.timeZone.trim();
    if (timeZone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone });
      } catch {
        setFormError(`Invalid timeZone: ${timeZone}`);
        return;
      }
    }
    await withBusy("add", async () => {
      await addGoal({
        id: form.id,
        name: form.name,
        cron: form.cron,
        operation: form.operation,
        budgetCents: Math.floor(budgetCents),
        enabled: form.enabled,
        ...(timeZone ? { timeZone } : {}),
      });
      setForm({ id: "", name: "", cron: "", operation: "", budgetCents: "", timeZone: "UTC", enabled: true });
      setBuiltinSelection("");
      setBuiltinNotice("");
    });
  };

  // Issue #3996 — picking a built-in goal pre-fills the Add-goal
  // form from its canonical definition. A definition without a
  // timeZone leaves the form's current value (UTC by default) —
  // none is invented. A goal that already exists is surfaced, not
  // filled in: the operator cannot submit a duplicate from here.
  const selectBuiltin = (id: string) => {
    setBuiltinSelection(id);
    if (!id) {
      setBuiltinNotice("");
      return;
    }
    const goal = builtinGoals.find((g) => g.id === id);
    if (!goal) return;
    if (goals.some((g) => g.id === id)) {
      setBuiltinNotice(`"${goal.name}" (${goal.id}) already exists — it will not be added again.`);
      return;
    }
    setBuiltinNotice("");
    setForm({
      id: goal.id,
      name: goal.name,
      cron: goal.cron,
      operation: goal.operation,
      budgetCents: String(goal.budgetCents),
      timeZone: goal.timeZone ?? form.timeZone,
      enabled: goal.enabled,
    });
  };

  const submitSeedAll = async () => {
    setSeedResults(null);
    await withBusy("seed", async () => {
      setSeedResults(await addBuiltinGoals(builtinGoals, goals.map((g) => g.id)));
    });
  };

  const submitPreset = async () => {
    setPresetResults(null);
    await withBusy("preset", async () => {
      setPresetResults(await addResourceGoals());
    });
  };

  return (
    <div className={embedded ? "" : "scheduled-goals-panel"}>
      <Modal
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title="Remove scheduled goal?"
        footer={
          <>
            <Button
              type="button"
              variant="danger"
              disabled={!!busy}
              onClick={() => {
                const target = removeTarget;
                setRemoveTarget(null);
                if (target) void withBusy(`remove-${target.id}`, () => removeGoal(target.id).then(() => {}));
              }}
            >
              Remove
            </Button>{" "}
            <Button type="button" variant="secondary" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
          </>
        }
      >
        <p>
          Remove scheduled goal &quot;{removeTarget?.name}&quot;? This cannot be undone.
        </p>
      </Modal>
      <h3 style={{ margin: "0 0 12px" }}>Scheduled goals</h3>
      {error && <div style={{ color: "var(--color-danger)", marginBottom: 12 }}>{error}</div>}
      {loading && <div>Loading…</div>}

      {!loading && goals.length === 0 && <div style={{ opacity: 0.7 }}>No scheduled goals.</div>}
      {goals.map((g) => (
        <div
          key={g.id}
          style={{ border: "1px solid var(--color-border-medium)", borderRadius: 8, padding: "var(--space-2-5) var(--space-3)", marginBottom: 10 }}
        >
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
            <strong>{g.name}</strong>
            <code style={{ fontSize: 12 }}>{g.id}</code>
            <span style={{ fontSize: 12, opacity: 0.7 }}>{g.cron}</span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: 12,
                fontWeight: 700,
                color: g.enabled ? "var(--color-success)" : "var(--color-text-muted)",
              }}
            >
              {g.enabled ? "ENABLED" : "DISABLED"}
            </span>
          </div>
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
            operation <code>{g.operation}</code> · budget ${(g.budgetCents / 100).toFixed(2)} · last
            run {g.lastRun ? new Date(g.lastRun).toLocaleString() : "never"}
            {g.timeZone ? ` · timeZone ${g.timeZone}` : ""}
          </div>
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
            {/* Issue #3121 S3 — creation provenance (S1) travels with
                the goal: origin, creator, creation time. A legacy
                goal without one reads "not recorded", never
                backfilled. */}
            {g.provenance
              ? `provenance ${g.provenance.origin} · ${g.provenance.createdBy ?? "no creator recorded"} · ${new Date(g.provenance.createdAt).toLocaleString()}${g.provenance.reason ? ` · ${g.provenance.reason}` : ""}`
              : "provenance not recorded"}
          </div>
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: 8 }}>
            <Button
              disabled={!!busy}
              onClick={() =>
                void withBusy(`toggle-${g.id}`, () => setGoalEnabled(g.id, !g.enabled).then(() => {}))
              }
            >
              {g.enabled ? "Disable" : "Enable"}
            </Button>
            <Button disabled={!!busy} onClick={() => void withBusy(`trigger-${g.id}`, () => triggerGoal(g.id).then(() => {}))}>
              Run now
            </Button>
            <Button
              disabled={!!busy}
              onClick={() => {
                setRemoveTarget(g);
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      ))}

      <h3 style={{ margin: "20px 0 12px" }}>Add goal</h3>
      {formError && <div style={{ color: "var(--color-danger)", marginBottom: 8 }}>{formError}</div>}
      <div style={{ display: "grid", gap: "var(--space-2)", maxWidth: 520 }}>
        {/* Issue #3996: built-in goal dropdown — pre-fills the form
            below from the server-read canonical definitions; the
            operator reviews and submits via the existing Add goal
            button. */}
        <Select
          label="Built-in goal"
          aria-label="Built-in goal"
          value={builtinSelection}
          disabled={builtinGoals.length === 0}
          onChange={(e) => selectBuiltin(e.target.value)}
        >
          <option value="">{builtinGoals.length === 0 ? "Could not load built-in goals" : "Select a built-in goal…"}</option>
          {builtinGoals.map((goal) => {
            const exists = goals.some((g) => g.id === goal.id);
            return (
              <option key={goal.id} value={goal.id}>
                {`${goal.name} (${goal.id})${exists ? " — already added" : ""}${!goal.enabled ? " — disabled by design" : ""}`}
              </option>
            );
          })}
        </Select>
        {builtinNotice && <div style={{ fontSize: 13, opacity: 0.8 }}>{builtinNotice}</div>}
        {builtinLoadError && <div style={{ fontSize: 13, opacity: 0.8 }}>{builtinLoadError}</div>}
        <TextInput style={inputStyle} placeholder="id (e.g. weekly-report)" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
        <TextInput style={inputStyle} placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextInput style={inputStyle} placeholder='cron (e.g. "0 6 * * *")' value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
        {/* Issue #1922: new form controls use the ui primitives
            (ux-architecture §20), not raw controls — the primitive
            freeze test pins this file's raw-control count. */}
        <Select
          aria-label="operation"
          value={form.operation}
          disabled={operations.length === 0}
          onChange={(e) => setForm({ ...form, operation: e.target.value })}
        >
          <option value="">{operations.length === 0 ? "Could not load operations" : "Select an operation…"}</option>
          {operations.map((op) => (
            <option key={op.operation} value={op.operation}>
              {op.operation} ({op.agent})
            </option>
          ))}
        </Select>
        <TextInput style={inputStyle} placeholder="budget in cents (e.g. 500)" value={form.budgetCents} onChange={(e) => setForm({ ...form, budgetCents: e.target.value })} />
        <TextInput placeholder="timeZone (IANA, e.g. UTC)" value={form.timeZone} onChange={(e) => setForm({ ...form, timeZone: e.target.value })} />
        {/* Issue #3996: the enabled state is part of the form, so a
            pre-filled disabled-by-design goal is visibly disabled
            before submit and the submit carries it to the server
            (addGoal honors `enabled`; the server-side default used
            to be enabled, so a form without this toggle could never
            add a disabled goal). */}
        <Checkbox aria-label="Enabled" label="Enabled" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        {/* Issue #1773 (HAX #1 scope disclosure): the Delegation
            Contract preview for exactly what adding this goal
            authorizes, built from the form + the loaded catalog
            entry — nothing invented when a field is still blank. */}
        <DelegationContractPreview
          contract={buildDelegationContract({
            goalId: form.id,
            goalName: form.name,
            cron: form.cron,
            operation: form.operation,
            operationAgent: operations.find((op) => op.operation === form.operation)?.agent,
            operationBlurb: operations.find((op) => op.operation === form.operation)?.blurb,
            budgetCents: form.budgetCents.trim() === "" || !Number.isFinite(Number(form.budgetCents)) ? null : Number(form.budgetCents),
            timeZone: form.timeZone,
          })}
        />
        <div>
          <Button disabled={busy === "add"} onClick={() => void submitGoal()} loading={busy === "add"}>
            {"Add goal"}
          </Button>
        </div>
      </div>

      {/* Issue #1922 preset: the three SessionStore resource goals. The
          issue number lives in this comment, not in rendered text: the
          UX token gate treats a "#NNNN" pattern in JSX text as a hex
          color literal. */}
      <h3 style={{ margin: "20px 0 12px" }}>SessionStore resource goals</h3>
      <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 8 }}>
        Adds the three SessionStore resource goals (daily rollup, 70% cap alert, dashboard
        comparison) with timeZone UTC. Goals that already exist are skipped, not duplicated.
      </div>
      {/* Issue #1773 (HAX #1): the same Delegation Contract preview
          for the preset's three fixed goals, from their documented
          payloads — the preset authorizes only these three runs. */}
      <details>
        <summary>Delegation contract for these three goals</summary>
        {RESOURCE_GOALS_PRESET.map((preset) => (
          <DelegationContractPreview
            key={preset.id}
            title={`Delegation contract — ${preset.name}`}
            contract={buildDelegationContract({
              goalId: preset.id,
              goalName: preset.name,
              cron: preset.cron,
              operation: preset.operation,
              budgetCents: preset.budgetCents,
              timeZone: preset.timeZone,
            })}
          />
        ))}
      </details>
      {presetResults && (
        <div style={{ marginBottom: 8 }}>
          {presetResults.map((r) => (
            <div key={r.id} style={{ fontSize: 13, marginBottom: 4 }}>
              <code>{r.id}</code> —{" "}
              {r.status === "added"
                ? "Added"
                : r.status === "skipped"
                  ? `already exists (skipped): ${r.reason}`
                  : `Failed: ${r.error}`}
            </div>
          ))}
        </div>
      )}
      <div>
        <Button disabled={!!busy} onClick={() => void submitPreset()} loading={busy === "preset"}>
          {"Add SessionStore resource goals"}
        </Button>
      </div>

      {/* Issue #3996: seed all built-in goals — adds every missing
          built-in goal in DEFAULT_SCHEDULES order, skipping ones
          that already exist, and reports per-goal results. The
          disabled-by-design goals seed as disabled; the operator
          enables them later once their prerequisites are in place. */}
      <h3 style={{ margin: "20px 0 12px" }}>Seed all built-in goals</h3>
      <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 8 }}>
        Adds every missing built-in goal (daily QA sweep, opportunity hunt, daily social post,
        the three SessionStore resource goals, the two index-list refresh goals, and feed
        refresh). Goals that already exist are skipped, not duplicated. The daily social post
        and the ETF-holdings refresh seed as disabled.
      </div>
      {seedResults && (
        <div style={{ marginBottom: 8 }}>
          {seedResults.map((r) => (
            <div key={r.id} style={{ fontSize: 13, marginBottom: 4 }}>
              <code>{r.id}</code> —{" "}
              {r.status === "added"
                ? "Added"
                : r.status === "skipped"
                  ? `already exists (skipped): ${r.reason}`
                  : `Failed: ${r.error}`}
            </div>
          ))}
        </div>
      )}
      <div>
        <Button disabled={!!busy || builtinGoals.length === 0} onClick={() => void submitSeedAll()} loading={busy === "seed"}>
          {"Seed all built-in goals"}
        </Button>
      </div>

      <h3 style={{ margin: "20px 0 12px" }}>Recent ticks</h3>
      {ticks.length === 0 && <div style={{ opacity: 0.7 }}>No ticks recorded yet.</div>}
      {ticks.map((t, i) => (
        <div key={`${t.timestamp}-${i}`} style={{ fontSize: 13, marginBottom: 8, borderBottom: "1px solid var(--color-border-subtle)", paddingBottom: "var(--space-2)" }}>
          <div>
            <strong>{new Date(t.timestamp).toLocaleString()}</strong> — evaluated {t.goalsEvaluated},
            created {t.jobsCreated}, skipped {t.jobsSkipped}
          </div>
          {t.errors.length > 0 && (
            <div style={{ color: "var(--color-danger)", marginTop: 4 }}>
              {t.errors.map((e, j) => (
                <div key={j}>{e}</div>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Issue #3121 S3 — recent goal runs from the one consolidated
          ledger (the same `listGoalRuns` read the runs view uses),
          not a second run-history path. The ticks above stay the
          aggregate per-tick view; these rows are the per-run view,
          with the §4 linkage (trigger, schedule, async job,
          workflow) rendered the same way the ledger renders it — a
          null id is "— / not applicable", never a dropped row. */}
      <h3 style={{ margin: "20px 0 12px" }}>Recent goal runs</h3>
      {runsError && <div style={{ color: "var(--color-danger)", marginBottom: 8 }}>{runsError}</div>}
      {runs.length === 0 && !runsError && <div style={{ opacity: 0.7 }}>No goal runs recorded yet.</div>}
      {runs.map((r, i) => (
        <div key={`${r.jobId}:${r.started}:${i}`} style={{ fontSize: 13, marginBottom: 8, borderBottom: "1px solid var(--color-border-subtle)", paddingBottom: "var(--space-2)" }}>
          <div>
            <strong>{r.jobId}</strong> · {r.operation} · {new Date(r.started).toLocaleString()} — {r.outcome}
          </div>
          <div style={{ opacity: 0.8, marginTop: 2 }}>
            trigger {r.trigger ?? "unknown"} · schedule{" "}
            <span title={ledgerLinkageTitle(r.scheduleId)}>{ledgerLinkageCell(r.scheduleId)}</span>
            {" · "}async job{" "}
            <span title={ledgerLinkageTitle(r.asyncJobId)}>{ledgerLinkageCell(r.asyncJobId)}</span>
            {" · "}workflow{" "}
            <span title={ledgerLinkageTitle(r.workflowId)}>{ledgerLinkageCell(r.workflowId)}</span>
          </div>
          <div style={{ opacity: 0.8, marginTop: 2 }}>
            {r.outcome === "failure"
              ? r.error ?? "failed"
              : r.outcome === "skipped"
                ? r.detail ?? "skipped"
                : r.descriptor ?? "ok"}
          </div>
        </div>
      ))}
    </div>
  );
}
