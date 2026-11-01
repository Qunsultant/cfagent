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
  addResourceGoals,
  type ScheduledGoal,
  type ScheduleTick,
  type CatalogOperation,
  type PresetGoalResult,
} from "./scheduleApi";
import { TextInput, Select, Button, Modal } from "./components/ui";

export interface ScheduledGoalsPanelProps {
  embedded?: boolean;
}

const inputStyle: React.CSSProperties = { padding: "var(--space-2) var(--space-3)", width: "100%" };

export function ScheduledGoalsPanel({ embedded = false }: ScheduledGoalsPanelProps = {}) {
  const [goals, setGoals] = useState<ScheduledGoal[]>([]);
  const [ticks, setTicks] = useState<ScheduleTick[]>([]);
  const [operations, setOperations] = useState<CatalogOperation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    id: "",
    name: "",
    cron: "",
    operation: "",
    budgetCents: "",
    timeZone: "UTC",
  });
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState("");
  const [presetResults, setPresetResults] = useState<PresetGoalResult[] | null>(null);
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await refresh();
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
        ...(timeZone ? { timeZone } : {}),
      });
      setForm({ id: "", name: "", cron: "", operation: "", budgetCents: "", timeZone: "UTC" });
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
    </div>
  );
}
