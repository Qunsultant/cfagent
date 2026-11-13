/**
 * Issue #159: ScheduledAgent dashboard — goals, tick history, and add-goal form.
 *
 * Issue #4329 S4 (#4333) — parity with the schedules tab, organised as
 * sub-tabs. The page used to be six stacked sections (goal cards, Add goal,
 * SessionStore resource goals, Seed all built-in goals, Recent ticks, Recent
 * goal runs). It is now one sub-tabbed page:
 *
 *   Goals · Add goal · Resource goals · Seed built-in goals · Ticks · Goal runs
 *
 * - The section vocabulary lives in `src/config/scheduleSections.ts`, the tab
 *   writes `?section=<id>` (a stable deep link), and the panels are retained
 *   so an in-flight form or a loaded result survives a section switch.
 * - Goals render as ONE TABLE — one row per goal, the actions on the row —
 *   with the schedules list's identity columns (schedule · id · cadence) plus
 *   the goal's own (operation · budget · last run · provenance). Both lists
 *   resolve their columns from `src/config/scheduleRowModes.ts`, so "the same
 *   columns, plus its own" is configured once, not restated here.
 * - The action set is the schedules tab's: Trigger Now · Pause/Resume ·
 *   Delete (the destructive action is Delete, matching the list).
 * - The Add-goal form follows the schedules editor's presentation: labelled
 *   fields with hints, the catalog-driven operation select, the delegation
 *   contract preview, and the submit as the form's last row. The built-in
 *   goal picker pre-fills it; nothing it could do before is dropped.
 * - Goal runs are a FILTERED VIEW of the one ledger (`kind=goal`): the section
 *   reports what is recorded and hands the reader to the ledger, instead of
 *   keeping a second run list on this page.
 *
 * Layout comes from the shared `Stack`/`Flex` primitives (#3048), never from
 * call-site spacing classes: the interior gate (#3991) treats a className
 * token that is not a `ui-` class as bespoke.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
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
  listAllRuns,
  RESOURCE_GOALS_PRESET,
  type ScheduledGoal,
  type ScheduleTick,
  type CatalogOperation,
  type PresetGoalResult,
} from "./jobsApi";
// Issue #3121 S3 — the goals view's run facts come from the one
// consolidated ledger (`listAllRuns`, the same read the runs view uses).
// Issue #4333 — the section no longer lists those runs: the ledger is the
// one run list, and this section hands the reader to it (`kind=goal`).
import { normalizeJobRunRecord } from "../services/jobRunRecords";
import {
  Badge,
  Button,
  Checkbox,
  Flex,
  Modal,
  Notice,
  Select,
  Stack,
  Table,
  Tabs,
  TabPanel,
  TextInput,
  type TableColumn,
} from "./components/ui";
import { DelegationContractPreview } from "./DelegationContractPreview";
import { buildDelegationContract } from "./delegationContract";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import { navigateToTab } from "./router";
import {
  SCHEDULE_SECTION_PARAM,
  GOAL_SCHEDULE_SECTION_LABELS,
  isGoalScheduleSection,
  resolveGoalScheduleDefaultSection,
  resolveGoalScheduleSections,
  type GoalScheduleSection,
} from "../config/scheduleSections";
import {
  SCHEDULE_ROW_COLUMN_LABELS,
  resolveScheduleRowColumns,
  type ScheduleRowColumn,
} from "../config/scheduleRowModes";
import { cronToEnglish } from "./SchedulesPanel";

export interface ScheduledGoalsPanelProps {
  embedded?: boolean;
}

function fmtTime(value?: string | null): string {
  if (!value) return "never";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "never";
}

function budgetLabel(budgetCents: number): string {
  return `$${(budgetCents / 100).toFixed(2)}`;
}

function provenanceLabel(goal: ScheduledGoal): string {
  if (!goal.provenance) return "provenance not recorded";
  const parts = [
    `provenance ${goal.provenance.origin}`,
    goal.provenance.createdBy ?? "no creator recorded",
    fmtTime(goal.provenance.createdAt),
  ];
  if (goal.provenance.reason) parts.push(goal.provenance.reason);
  return parts.join(" · ");
}

/** One applied/skipped/failed result row, rendered the same for both presets. */
function ResultRows({ results }: { results: PresetGoalResult[] | null }) {
  if (!results) return null;
  return (
    <Stack gap="1">
      {results.map((r) => (
        <div key={r.id} className="ui-meta">
          <code>{r.id}</code> —{" "}
          {r.status === "added"
            ? "Added"
            : r.status === "skipped"
              ? `already exists (skipped): ${r.reason}`
              : `Failed: ${r.error}`}
        </div>
      ))}
    </Stack>
  );
}

export function ScheduledGoalsPanel({ embedded = false }: ScheduledGoalsPanelProps = {}) {
  const [goals, setGoals] = useState<ScheduledGoal[]>([]);
  const [ticks, setTicks] = useState<ScheduleTick[]>([]);
  const [operations, setOperations] = useState<CatalogOperation[]>([]);
  const [runCount, setRunCount] = useState<number | null>(null);
  const [newestRun, setNewestRun] = useState<string | null>(null);
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

  // Issue #4333 — the sections are configuration, and the open one is a URL
  // state (`?section=`), the home's own deep-link contract.
  const sections = useMemo<GoalScheduleSection[]>(() => resolveGoalScheduleSections(), []);
  const { activeTab: section, handleTabChange } = useUrlSyncedTabs<GoalScheduleSection>({
    param: SCHEDULE_SECTION_PARAM,
    isValid: isGoalScheduleSection,
    defaultTab: resolveGoalScheduleDefaultSection({}, sections),
  });

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
  // mutation refreshes both. Issue #4333 — it now feeds the section's
  // summary (how many goal runs are recorded, and the newest one); the
  // rows themselves are the ledger's.
  const refreshRuns = useCallback(async () => {
    try {
      const { runs } = await listAllRuns(undefined, 20);
      // Goal rows only: the merged list also carries schedule rows
      // (system "orchestrator-schedule" and friends).
      const goalRuns = runs
        .filter((r) => r.system === "scheduled-agent-goal")
        .map(normalizeJobRunRecord);
      setRunCount(goalRuns.length);
      setNewestRun(goalRuns.length > 0 ? goalRuns[0].started : null);
      setRunsError("");
    } catch (cause) {
      setRunCount(null);
      setNewestRun(null);
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

  // Issue #4333 — one table, the schedules list's columns first. The column
  // set is configuration (`src/config/scheduleRowModes.ts`); this map only
  // supplies a renderer per column the goals surface can carry.
  const goalRowCells = useMemo<Record<string, TableColumn<ScheduledGoal>>>(() => {
    return {
      schedule: {
        key: "schedule",
        header: SCHEDULE_ROW_COLUMN_LABELS.schedule,
        render: (g) => (
          <Stack gap="1">
            <span>{g.name}</span>
            <Flex gap="1" wrap inline as="span">
              {/* Issue #3122 — agent-created goals carry an Agent badge
                  (provenance origin agent); user- and system-created
                  goals show no badge. */}
              {g.provenance?.origin === "agent" ? (
                <Badge
                  tone="info"
                  size="xs"
                  title={
                    g.provenance.agentId
                      ? `Created by agent ${g.provenance.agentId}`
                      : "Created by an agent"
                  }
                >
                  Agent
                </Badge>
              ) : null}
              <Badge tone={g.enabled ? "success" : "warning"} size="xs" dot>
                {g.enabled ? "Enabled" : "Disabled"}
              </Badge>
              <Badge tone="neutral" size="xs" uppercase>
                goal
              </Badge>
            </Flex>
          </Stack>
        ),
      },
      id: {
        key: "id",
        header: SCHEDULE_ROW_COLUMN_LABELS.id,
        render: (g) => <code title={g.id}>{g.id}</code>,
      },
      cadence: {
        key: "cadence",
        header: SCHEDULE_ROW_COLUMN_LABELS.cadence,
        render: (g) => (
          <Stack gap="0-5">
            <span>{cronToEnglish(g.cron)}</span>
            <span className="ui-meta-sm">
              {g.cron}
              {g.timeZone ? ` · ${g.timeZone}` : ""}
            </span>
          </Stack>
        ),
      },
      operation: {
        key: "operation",
        header: SCHEDULE_ROW_COLUMN_LABELS.operation,
        render: (g) => <code>{g.operation}</code>,
      },
      budget: {
        key: "budget",
        header: SCHEDULE_ROW_COLUMN_LABELS.budget,
        render: (g) => <>{budgetLabel(g.budgetCents)}</>,
      },
      lastRun: {
        key: "lastRun",
        header: SCHEDULE_ROW_COLUMN_LABELS.lastRun,
        render: (g) => <>{fmtTime(g.lastRun)}</>,
      },
      provenance: {
        key: "provenance",
        header: SCHEDULE_ROW_COLUMN_LABELS.provenance,
        render: (g) => <span className="ui-meta">{provenanceLabel(g)}</span>,
      },
      actions: {
        key: "actions",
        header: SCHEDULE_ROW_COLUMN_LABELS.actions,
        align: "right",
        render: (g) => (
          <Flex gap="1" justify="end" wrap>
            <Button
              type="button"
              variant="accent"
              tone="subtle"
              size="sm"
              disabled={!!busy || !g.enabled}
              title={g.enabled ? "Run this goal now" : "Enable the goal before triggering it"}
              onClick={() => void withBusy(`trigger-${g.id}`, () => triggerGoal(g.id).then(() => {}))}
            >
              Trigger Now
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!!busy}
              title={g.enabled ? "Pause this goal" : "Resume this goal"}
              onClick={() =>
                void withBusy(`toggle-${g.id}`, () => setGoalEnabled(g.id, !g.enabled).then(() => {}))
              }
            >
              {g.enabled ? "Pause" : "Resume"}
            </Button>
            <Button
              type="button"
              variant="danger"
              tone="subtle"
              size="sm"
              disabled={!!busy}
              title="Delete this goal"
              onClick={() => setRemoveTarget(g)}
            >
              Delete
            </Button>
          </Flex>
        ),
      },
    };
  }, [busy]);

  const goalColumns = useMemo(
    () =>
      resolveScheduleRowColumns("goals")
        .map((key: ScheduleRowColumn) => goalRowCells[key])
        .filter((column): column is TableColumn<ScheduledGoal> => Boolean(column)),
    [goalRowCells],
  );

  const tabs = sections.map((id) => ({
    id,
    label: GOAL_SCHEDULE_SECTION_LABELS[id],
    ...(id === "goals" ? { badge: goals.length } : {}),
  }));

  return (
    <div className={embedded ? "" : "scheduled-goals-panel"}>
      <Modal
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title="Delete this goal?"
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
              Delete goal
            </Button>{" "}
            <Button type="button" variant="secondary" onClick={() => setRemoveTarget(null)}>
              Keep goal
            </Button>
          </>
        }
      >
        <p>
          Delete goal &quot;{removeTarget?.name}&quot;? It stops firing and is removed from the goal
          store. This cannot be undone.
        </p>
      </Modal>

      <Tabs<GoalScheduleSection>
        idBase="schedules-goals"
        ariaLabel="Goal schedule sections"
        tabs={tabs}
        value={section}
        onChange={handleTabChange}
        size="sm"
      />

      {error && (
        <Notice tone="danger" title="Scheduled goals">
          {error}
        </Notice>
      )}

      {/* ------------------------------------------------ Goals (the list) */}
      <TabPanel idBase="schedules-goals" tabId="goals" active={section === "goals"} retain>
        <Stack gap="3">
          <Flex gap="2" wrap>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void refresh();
                void refreshRuns();
              }}
              loading={loading}
              title="Reload the goals, their ticks and the goal-run summary"
            >
              ↻ Refresh
            </Button>
          </Flex>
          {loading && goals.length === 0 ? (
            <p className="ui-meta">Loading goals…</p>
          ) : (
            <Table
              columns={goalColumns}
              rows={goals}
              rowKey={(g) => g.id}
              rowTitle={(g) => `${g.id} · ${g.operation}`}
              caption="Every scheduled goal, one row each"
              empty={<p className="ui-meta">No scheduled goals.</p>}
            />
          )}
        </Stack>
      </TabPanel>

      {/* ----------------------------------------------------- Add goal */}
      <TabPanel idBase="schedules-goals" tabId="add" active={section === "add"} retain>
        <Stack gap="3" className="ui-narrow">
          <h3>Add goal</h3>
          {formError && (
            <Notice tone="danger" title="The goal was not added">
              {formError}
            </Notice>
          )}
          {/* Issue #3996: built-in goal dropdown — pre-fills the form
              below from the server-read canonical definitions; the
              operator reviews and submits via the existing Add goal
              button. */}
          <Select
            label="Built-in goal"
            aria-label="Built-in goal"
            hint="Pre-fills the form from the canonical definition; nothing is added until you submit."
            id="goal-builtin"
            value={builtinSelection}
            disabled={builtinGoals.length === 0}
            onChange={(e) => selectBuiltin(e.target.value)}
          >
            <option value="">
              {builtinGoals.length === 0 ? "Could not load built-in goals" : "Select a built-in goal…"}
            </option>
            {builtinGoals.map((goal) => {
              const exists = goals.some((g) => g.id === goal.id);
              return (
                <option key={goal.id} value={goal.id}>
                  {`${goal.name} (${goal.id})${exists ? " — already added" : ""}${!goal.enabled ? " — disabled by design" : ""}`}
                </option>
              );
            })}
          </Select>
          {builtinNotice && <div className="ui-meta">{builtinNotice}</div>}
          {builtinLoadError && <div className="ui-meta">{builtinLoadError}</div>}
          <TextInput
            label="Goal id"
            hint="Stable id for this goal; the run ledger links by it."
            id="goal-id"
            placeholder="id (e.g. weekly-report)"
            value={form.id}
            onChange={(e) => setForm({ ...form, id: e.target.value })}
          />
          <TextInput
            label="Name"
            id="goal-name"
            placeholder="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextInput
            label="Cadence (cron)"
            hint="Five-field cron, UTC unless a time zone is given below."
            id="goal-cron"
            placeholder='cron (e.g. "0 6 * * *")'
            value={form.cron}
            onChange={(e) => setForm({ ...form, cron: e.target.value })}
          />
          {/* Issue #1922: new form controls use the ui primitives
              (ux-architecture §20), not raw controls — the primitive
              freeze test pins this file's raw-control count. */}
          <Select
            label="Operation"
            aria-label="operation"
            hint="The catalog operation this goal runs."
            id="goal-operation"
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
          <TextInput
            label="Budget (cents)"
            hint="Positive number of cents per run; the run is refused above it."
            id="goal-budget"
            placeholder="budget in cents (e.g. 500)"
            value={form.budgetCents}
            onChange={(e) => setForm({ ...form, budgetCents: e.target.value })}
          />
          <TextInput
            label="Time zone"
            hint="IANA zone; empty keeps the server default."
            id="goal-timezone"
            placeholder="timeZone (IANA, e.g. UTC)"
            value={form.timeZone}
            onChange={(e) => setForm({ ...form, timeZone: e.target.value })}
          />
          {/* Issue #3996: the enabled state is part of the form, so a
              pre-filled disabled-by-design goal is visibly disabled
              before submit and the submit carries it to the server
              (addGoal honors `enabled`; the server-side default used
              to be enabled, so a form without this toggle could never
              add a disabled goal). */}
          <Checkbox
            aria-label="Enabled"
            label="Enabled"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
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
              budgetCents:
                form.budgetCents.trim() === "" || !Number.isFinite(Number(form.budgetCents))
                  ? null
                  : Number(form.budgetCents),
              timeZone: form.timeZone,
            })}
          />
          {/* The schedules editor's footer placement: the submit closes the
              form, as the one create action on this page. */}
          <Flex gap="2" justify="end">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => handleTabChange("goals")}
              disabled={busy === "add"}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy === "add"}
              onClick={() => void submitGoal()}
              loading={busy === "add"}
            >
              {"Add goal"}
            </Button>
          </Flex>
        </Stack>
      </TabPanel>

      {/* ---------------------------------------- SessionStore resource goals */}
      <TabPanel idBase="schedules-goals" tabId="resources" active={section === "resources"} retain>
        <Stack gap="3">
          <h3>SessionStore resource goals</h3>
          <div className="ui-meta">
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
          <ResultRows results={presetResults} />
          <div>
            <Button disabled={!!busy} onClick={() => void submitPreset()} loading={busy === "preset"}>
              {"Add SessionStore resource goals"}
            </Button>
          </div>
        </Stack>
      </TabPanel>

      {/* --------------------------------------------------- Seed built-ins */}
      <TabPanel idBase="schedules-goals" tabId="seed" active={section === "seed"} retain>
        <Stack gap="3">
          <h3>Seed all built-in goals</h3>
          {/* Issue #3996: seed all built-in goals — adds every missing
              built-in goal in DEFAULT_SCHEDULES order, skipping ones
              that already exist, and reports per-goal results. The
              disabled-by-design goals seed as disabled; the operator
              enables them later once their prerequisites are in place. */}
          <div className="ui-meta">
            Adds every missing built-in goal (daily QA sweep, opportunity hunt, daily social post,
            the three SessionStore resource goals, and the two index-list refresh goals). Goals
            that already exist are skipped, not duplicated. The daily social post and the
            ETF-holdings refresh seed as disabled.
          </div>
          <ResultRows results={seedResults} />
          <div>
            <Button
              disabled={!!busy || builtinGoals.length === 0}
              onClick={() => void submitSeedAll()}
              loading={busy === "seed"}
            >
              {"Seed all built-in goals"}
            </Button>
          </div>
        </Stack>
      </TabPanel>

      {/* ------------------------------------------------------------ Ticks */}
      <TabPanel idBase="schedules-goals" tabId="ticks" active={section === "ticks"} retain>
        <Stack gap="2">
          <h3>Recent ticks</h3>
          {ticks.length === 0 && <div className="ui-meta">No ticks recorded yet.</div>}
          {ticks.map((t, i) => (
            <div
              key={`${t.timestamp}-${i}`}
              style={{ borderBottom: "1px solid var(--color-border-subtle)", paddingBottom: "var(--space-2)" }}
            >
              <Stack gap="1">
                <div>
                  <strong>{fmtTime(t.timestamp)}</strong> — evaluated {t.goalsEvaluated}, created{" "}
                  {t.jobsCreated}, skipped {t.jobsSkipped}
                </div>
                {t.errors.length > 0 && (
                  <Stack gap="1">
                    {t.errors.map((e, j) => (
                      <Notice key={j} tone="danger">
                        {e}
                      </Notice>
                    ))}
                  </Stack>
                )}
              </Stack>
            </div>
          ))}
        </Stack>
      </TabPanel>

      {/* ------------------------------------------------------- Goal runs */}
      <TabPanel idBase="schedules-goals" tabId="runs" active={section === "runs"} retain>
        <Stack gap="3">
          {/* Issue #3121 S3 — recent goal runs come from the one consolidated
              ledger (the same `listAllRuns` read the runs view uses), not a
              second run-history path. Issue #4333 — the ledger IS the run
              list: this section reports what is recorded and hands the reader
              to `kind=goal`, instead of repeating the rows here. */}
          <h3>Recent goal runs</h3>
          {runsError ? (
            <Notice tone="danger" title="Goal runs could not be loaded">
              {runsError}
            </Notice>
          ) : (
            <div className="ui-meta">
              {runCount === null
                ? "Reading the run ledger…"
                : runCount === 0
                  ? "No goal run is recorded in the run ledger yet."
                  : `${runCount} goal run(s) recorded in the run ledger — newest ${fmtTime(newestRun)}.`}
            </div>
          )}
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => navigateToTab("schedules", "runs", { kind: "goal" })}
              title="Open the one run ledger filtered to goal runs"
            >
              Open goal runs in the run ledger
            </Button>
          </div>
        </Stack>
      </TabPanel>
    </div>
  );
}
