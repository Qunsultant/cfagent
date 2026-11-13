/**
 * #2173 admin-panel Queue tab — wipe surface for the own instance.
 *
 * Reads and mutates ONLY through existing routes (see adminQueueApi):
 * GET /api/schedules (dump), POST /api/schedules/cancel-all
 * (preview + confirm), POST /api/maintenance/clear-table (preview +
 * confirm), POST /api/maintenance/kv-wipe (preview + confirm),
 * GET /api/maintenance/events-export, POST /api/clear (purge),
 * POST /api/schedules/create (Track 1 recreation).
 *
 * Scope honesty, stated on the tab itself: SQL rows wipe the OWN
 * instance only. KV rows (#2489 selective wipe) are PLATFORM-WIDE —
 * SessionStore is one shared DO — so wiping memberships, tokens,
 * bindings, sessions, or the genesis marker affects all users, not
 * just this instance. The selective section states the scope per row.
 * This tab loads under the panel's platform-admin gate; a
 * tenant-admin-gated wipe surface does not exist yet, so tenant
 * scope is not offered here either. Cross-tenant selective wipe rides
 * the #2457 tab UI slice, not this one.
 *
 * Flow for every destructive action: preview first (fail-closed,
 * nothing cancelled), modal confirm, confirmed action, then a
 * re-fetched dump shown as the verify step. Paused records are
 * preserved by the cancel-all route and are never deleted by it.
 * Track 1 recreation is a separate explicit action, never automatic.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./components/ui/Button";
import { Checkbox } from "./components/ui/Checkbox";
import { Modal } from "./components/ui/Modal";
import { Notice } from "./components/ui/Notice";
import { Spinner } from "./components/ui/Spinner";
import { Table, type TableColumn } from "./components/ui/Table";
import { Badge } from "./components/ui/Badge";
import { Flex } from "./components/ui/Flex";
import { Stack } from "./components/ui/Stack";
import { TabPanel, Tabs } from "./components/ui/Tabs";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
// Issue #4334 (parent #4329 S5) — the queue's sections are configuration, and
// its rows present like the schedules tab: the same column vocabulary, the
// same naming and cadence sentences. Reuse, not a second shape.
import {
  SCHEDULE_SECTION_PARAM,
  QUEUE_SCHEDULE_SECTION_LABELS,
  isQueueScheduleSection,
  resolveQueueScheduleDefaultSection,
  resolveQueueScheduleSections,
  type QueueScheduleSection,
} from "../config/scheduleSections";
import {
  SCHEDULE_ROW_COLUMN_LABELS,
  resolveScheduleRowColumns,
} from "../config/scheduleRowModes";
import { cronToEnglish, scheduleDisplayName, type ScheduleItem } from "./SchedulesPanel";
import { downloadTextFile } from "./runExport";
import {
  type CancelAllPreview,
  type CancelAllResult,
  type ClearableTable,
  type ClearTablePreview,
  type ClearTableResult,
  type KvWipeRowResult,
  type QueueDump,
  type QueueScheduleView,
  type RecreateResultItem,
  type SelectiveKvRow,
  confirmCancelAll,
  confirmClearTable,
  confirmClearTableWithAudit,
  confirmKvWipe,
  exportAuditEvents,
  fetchQueueDump,
  previewCancelAll,
  previewClearTable,
  previewKvWipe,
  purgeSessionMessages,
  recreateTrack1,
  track1RecreatePlan,
} from "./adminQueueApi";

const CLEARABLE_TABLES: ClearableTable[] = ["mas_async_jobs", "mas_job_outcomes", "unified_schedules"];

type SelectiveKind = "framework" | "sql" | "messages" | "kv";

interface SelectiveRowDef {
  id: string;
  label: string;
  scope: "Own instance" | "Platform-wide";
  note: string;
  kind: SelectiveKind;
}

const SELECTIVE_ROWS: SelectiveRowDef[] = [
  { id: "framework", label: "Framework queue (cf_agents_jobs)", scope: "Own instance", note: "Via cancel-all; paused schedules preserved.", kind: "framework" },
  { id: "mas_async_jobs", label: "Async jobs (mas_async_jobs)", scope: "Own instance", note: "Running rows never deleted.", kind: "sql" },
  { id: "mas_job_outcomes", label: "Job outcomes (mas_job_outcomes)", scope: "Own instance", note: "History only; the prune watermark is a separate row.", kind: "sql" },
  { id: "mas_job_outcomes_meta", label: "Outcome prune watermark (mas_job_outcomes_meta)", scope: "Own instance", note: "Clearing resets the pruning cursor; the next prune recomputes it.", kind: "sql" },
  { id: "mas_messages", label: "Messages (mas_messages)", scope: "Own instance", note: "Per-session purge: only this session's messages, not all sessions'. No preview count.", kind: "messages" },
  { id: "mas_events", label: "Audit history (mas_events)", scope: "Own instance", note: "Destroys audit history, irreversibly. Needs a second confirmation, and an export is offered first.", kind: "sql" },
  { id: "unified_schedules", label: "Paused schedules (unified_schedules)", scope: "Own instance", note: "Paused records only; active schedules are never wiped here.", kind: "sql" },
  { id: "kv:memberships", label: "Memberships (iaaa-membership:*)", scope: "Platform-wide", note: "All users, all tenants. Always clears the genesis marker with it.", kind: "kv" },
  { id: "kv:tokens", label: "Broker tokens (etrade:token:*)", scope: "Platform-wide", note: "Every user reconnects their broker after.", kind: "kv" },
  { id: "kv:bindings", label: "Identity bindings + aliases (iaaa-binding:*, iaaa-alias:*)", scope: "Platform-wide", note: "Re-created on next sign-in; required for re-bootstrap.", kind: "kv" },
  { id: "kv:marker", label: "Bootstrap genesis marker (iaaa-bootstrap:platform-genesis:*)", scope: "Platform-wide", note: "Must be cleared with memberships or platform-admin cannot re-bootstrap. Locked on while memberships is checked.", kind: "kv" },
  { id: "kv:sessions", label: "Sessions", scope: "Platform-wide", note: "Logs everyone out, including you. Executed last; sign in again after.", kind: "kv" },
];

interface SelectivePreviewRow {
  id: string;
  count: number | null;
  error?: string;
}

interface SelectiveResultRow {
  id: string;
  ok: boolean;
  detail: string;
}

function cadenceOf(row: { cron?: string; intervalSeconds?: number }): string {
  if (row.cron) return row.cron;
  if (typeof row.intervalSeconds === "number") return `Every ${row.intervalSeconds / 60} min`;
  return "—";
}

function deliveryOf(payload: Record<string, unknown>): string {
  const slack = typeof payload.slackChannel === "string" ? payload.slackChannel : undefined;
  const email = typeof payload.emailTo === "string" ? payload.emailTo : undefined;
  if (slack && email) return `${slack} + ${email}`;
  if (slack) return slack;
  if (email) return email;
  return "Env channel (no explicit delivery)";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One Track 1 plan row, as the recreate plan returns it. */
type TrackRow = ReturnType<typeof track1RecreatePlan>[number];

/** A plan row's cadence sentence — the same words the queue dump uses. */
function trackCadenceOf(row: TrackRow): string {
  return String(
    row.requestBody.cron ?? `Every ${(row.requestBody.intervalSeconds ?? 0) / 60} min`,
  );
}

export function AdminQueueWipePanel() {
  const [dump, setDump] = useState<QueueDump | null>(null);
  const [dumpError, setDumpError] = useState<string | null>(null);
  const [dumpBusy, setDumpBusy] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  const [cancelPreview, setCancelPreview] = useState<CancelAllPreview | null>(null);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelResult, setCancelResult] = useState<CancelAllResult | null>(null);
  const [cancelVerified, setCancelVerified] = useState(false);

  const [clearTable, setClearTable] = useState<ClearableTable | null>(null);
  const [clearPreview, setClearPreview] = useState<ClearTablePreview | null>(null);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearResult, setClearResult] = useState<ClearTableResult | null>(null);

  const [recreateModalOpen, setRecreateModalOpen] = useState(false);
  const [recreateBusy, setRecreateBusy] = useState(false);
  const [recreateResults, setRecreateResults] = useState<RecreateResultItem[] | null>(null);

  // Issue #2489 selective wipe: every row checked by default.
  // Unchecking skips that row entirely (no preview call, no delete,
  // no audit for it). The marker checkbox locks on while memberships
  // is checked — the server couples them the same way, so the UI
  // cannot express a memberships-without-marker wipe.
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SELECTIVE_ROWS.map((row) => [row.id, true])),
  );
  const [selPreview, setSelPreview] = useState<SelectivePreviewRow[] | null>(null);
  const [selModalOpen, setSelModalOpen] = useState(false);
  const [selEventsModalOpen, setSelEventsModalOpen] = useState(false);
  const [selBusy, setSelBusy] = useState(false);
  const [selResults, setSelResults] = useState<SelectiveResultRow[] | null>(null);
  const [selExported, setSelExported] = useState<string | null>(null);
  const [selSignedOut, setSelSignedOut] = useState(false);

  const markerLocked = selected["kv:memberships"] === true;

  // Issue #4334 — the queue's sections: each is a sub-tab with a stable
  // `?section=` deep link (the schedules home's one section param), and the
  // panels are retained so a previewed result survives a section switch.
  const queueSections = useMemo<QueueScheduleSection[]>(() => resolveQueueScheduleSections(), []);
  const { activeTab: section, handleTabChange } = useUrlSyncedTabs<QueueScheduleSection>({
    param: SCHEDULE_SECTION_PARAM,
    isValid: isQueueScheduleSection,
    defaultTab: resolveQueueScheduleDefaultSection({}, queueSections),
  });

  // Issue #4334 — the dump's rows use the shared column vocabulary
  // (schedule · id · cadence · scope · status) and the schedules list's own
  // naming/cadence sentences, so the queue reads like every other row list.
  const dumpRowCells: Record<string, TableColumn<QueueScheduleView>> = {
    schedule: {
      key: "schedule",
      header: SCHEDULE_ROW_COLUMN_LABELS.schedule,
      render: (row) => (
        <Stack gap="1">
          <span>
            {scheduleDisplayName({ callback: row.callback, type: row.type } as ScheduleItem)}
          </span>
          <Flex gap="1" wrap inline as="span">
            <Badge tone={row.paused ? "warning" : "success"} size="xs" dot>
              {row.paused ? "Paused" : "Active"}
            </Badge>
            {row.type ? (
              <Badge tone="neutral" size="xs" uppercase>
                {row.type}
              </Badge>
            ) : null}
          </Flex>
        </Stack>
      ),
    },
    id: {
      key: "id",
      header: SCHEDULE_ROW_COLUMN_LABELS.id,
      render: (row) => <code title={row.id}>{row.id}</code>,
    },
    cadence: {
      key: "cadence",
      header: SCHEDULE_ROW_COLUMN_LABELS.cadence,
      render: (row) => (
        <Stack gap="0-5">
          <span>{row.cron ? cronToEnglish(row.cron) : cadenceOf(row)}</span>
          <span className="ui-meta-sm">
            {row.cron ? row.cron : "interval"}
            {row.nextRun ? ` · next ${row.nextRun}` : ""}
          </span>
        </Stack>
      ),
    },
    scope: {
      key: "scope",
      header: SCHEDULE_ROW_COLUMN_LABELS.scope,
      render: (row) => <span>{row.universe ?? "—"}</span>,
    },
    status: {
      key: "status",
      header: SCHEDULE_ROW_COLUMN_LABELS.status,
      render: (row) => (
        <Badge tone={row.paused ? "warning" : "success"} size="xs">
          {row.paused ? "Paused" : "Active"}
        </Badge>
      ),
    },
  };
  const dumpColumns: TableColumn<QueueScheduleView>[] = resolveScheduleRowColumns("queue")
    .map((key) => dumpRowCells[key])
    .filter((column): column is TableColumn<QueueScheduleView> => Boolean(column));

  // The Track 1 plan table presents the same way: the schedule's name and id
  // on the row, its cadence, its scope and its delivery.
  const planRowCells: Record<string, TableColumn<TrackRow>> = {
    schedule: {
      key: "schedule",
      header: SCHEDULE_ROW_COLUMN_LABELS.schedule,
      render: (row) => (
        <Stack gap="1">
          <span>{row.label}</span>
          <code>{String(row.requestBody.callback)}</code>
        </Stack>
      ),
    },
    cadence: {
      key: "cadence",
      header: SCHEDULE_ROW_COLUMN_LABELS.cadence,
      render: (row) => <span>{trackCadenceOf(row)}</span>,
    },
    scope: {
      key: "scope",
      header: SCHEDULE_ROW_COLUMN_LABELS.scope,
      render: (row) => (
        <span>{String((row.requestBody.payload as Record<string, unknown>).universe ?? "—")}</span>
      ),
    },
    status: {
      key: "status",
      header: "Delivery",
      render: (row) => (
        <span>{deliveryOf(row.requestBody.payload as Record<string, unknown>)}</span>
      ),
    },
  };
  const planColumns: TableColumn<TrackRow>[] = [
    planRowCells.schedule,
    planRowCells.cadence,
    planRowCells.scope,
    planRowCells.status,
  ].filter((column): column is TableColumn<TrackRow> => Boolean(column));

  const toggleSelective = useCallback((id: string) => {
    if (id === "kv:marker" && markerLocked) return;
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }, [markerLocked]);

  const track1Plan = useMemo(() => {
    try {
      return { items: track1RecreatePlan(), error: null as string | null };
    } catch (err) {
      return { items: [], error: messageOf(err) };
    }
  }, []);

  const loadDump = useCallback(async () => {
    setDumpBusy(true);
    setDumpError(null);
    try {
      setDump(await fetchQueueDump());
    } catch (err) {
      setDumpError(messageOf(err));
    } finally {
      setDumpBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadDump();
  }, [loadDump]);

  const activeCount = dump ? dump.schedules.filter((row) => !row.paused).length : 0;
  const pausedCount = dump ? dump.schedules.filter((row) => row.paused).length : 0;

  const onPreviewCancel = useCallback(async () => {
    setActionError(null);
    setCancelResult(null);
    setCancelVerified(false);
    setCancelBusy(true);
    try {
      setCancelPreview(await previewCancelAll());
      setCancelModalOpen(true);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setCancelBusy(false);
    }
  }, []);

  const onConfirmCancel = useCallback(async () => {
    setCancelBusy(true);
    try {
      const result = await confirmCancelAll();
      setCancelResult(result);
      setCancelModalOpen(false);
      setCancelPreview(null);
      await loadDump();
      setCancelVerified(true);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setCancelBusy(false);
    }
  }, [loadDump]);

  const onPreviewClear = useCallback(async (table: ClearableTable) => {
    setActionError(null);
    setClearResult(null);
    setClearBusy(true);
    try {
      setClearTable(table);
      setClearPreview(await previewClearTable(table));
      setClearModalOpen(true);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setClearBusy(false);
    }
  }, []);

  const onConfirmClear = useCallback(async () => {
    if (!clearTable) return;
    setClearBusy(true);
    try {
      setClearResult(await confirmClearTable(clearTable));
      setClearModalOpen(false);
      setClearPreview(null);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setClearBusy(false);
    }
  }, [clearTable]);

  const onRecreate = useCallback(async () => {
    setActionError(null);
    setRecreateBusy(true);
    try {
      setRecreateResults(await recreateTrack1());
      setRecreateModalOpen(false);
      await loadDump();
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setRecreateBusy(false);
    }
  }, [loadDump]);

  const selectedKvRows = useCallback((): SelectiveKvRow[] => {
    return SELECTIVE_ROWS.filter((row) => row.kind === "kv" && selected[row.id]).map(
      (row) => row.id.slice(3) as SelectiveKvRow,
    );
  }, [selected]);

  const onPreviewSelective = useCallback(async () => {
    setActionError(null);
    setSelResults(null);
    setSelSignedOut(false);
    setSelExported(null);
    setSelBusy(true);
    try {
      const counts: SelectivePreviewRow[] = [];
      const kvRows = selectedKvRows();
      let kvPreview: KvWipeRowResult[] = [];
      if (kvRows.length > 0) {
        try {
          kvPreview = await previewKvWipe(kvRows);
        } catch (err) {
          for (const row of kvRows) {
            counts.push({ id: `kv:${row}`, count: 0, error: messageOf(err) });
          }
        }
      }
      for (const row of SELECTIVE_ROWS) {
        if (!selected[row.id]) continue;
        if (row.kind === "kv") {
          const found = kvPreview.find((r) => `kv:${r.row}` === row.id);
          if (found) {
            counts.push({
              id: row.id,
              count: found.count,
              ...(found.error ? { error: found.error } : {}),
            });
          } else if (!counts.some((c) => c.id === row.id)) {
            // Coupled marker row added by the server even when the
            // marker checkbox itself was not the source of the call.
            counts.push({ id: row.id, count: 0, error: "No preview returned for this row" });
          }
          continue;
        }
        if (row.kind === "messages") {
          counts.push({ id: row.id, count: null });
          continue;
        }
        try {
          if (row.kind === "framework") {
            const preview = await previewCancelAll();
            counts.push({ id: row.id, count: preview.wouldCancelCount });
          } else {
            const preview = await previewClearTable(row.id as ClearableTable);
            counts.push({ id: row.id, count: preview.wouldDelete });
          }
        } catch (err) {
          counts.push({ id: row.id, count: 0, error: messageOf(err) });
        }
      }
      // Surface a server-coupled marker preview row even when the
      // marker checkbox was unchecked: memberships implies it.
      for (const kv of kvPreview) {
        if (kv.coupled && !counts.some((c) => c.id === `kv:${kv.row}`)) {
          counts.push({ id: `kv:${kv.row}`, count: kv.count, error: undefined });
        }
      }
      setSelPreview(counts);
      setSelModalOpen(true);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setSelBusy(false);
    }
  }, [selected, selectedKvRows]);

  const onExportAudit = useCallback(async () => {
    setActionError(null);
    try {
      const data = await exportAuditEvents();
      downloadTextFile(
        `audit-export-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify({ exportedAt: new Date().toISOString(), count: data.count, truncated: data.truncated, events: data.events }, null, 2),
        "application/json",
      );
      setSelExported(
        `Exported ${data.count} audit event(s)${data.truncated ? " (truncated at 5000 — earliest events first)" : ""}.`,
      );
    } catch (err) {
      setActionError(messageOf(err));
    }
  }, []);

  const runSelective = useCallback(async () => {
    setSelModalOpen(false);
    setSelEventsModalOpen(false);
    setSelBusy(true);
    const results: SelectiveResultRow[] = [];
    const sel = selected;
    try {
      if (sel.framework) {
        try {
          const result = await confirmCancelAll();
          results.push({
            id: "framework",
            ok: result.failed.length === 0,
            detail: `Cancelled ${result.cancelled} schedule(s); ${result.pausedPreserved} paused preserved${result.failed.length > 0 ? `; failed: ${result.failed.map((f) => `${f.id} (${f.error})`).join(", ")}` : ""}.`,
          });
        } catch (err) {
          results.push({ id: "framework", ok: false, detail: messageOf(err) });
        }
      }
      for (const table of ["mas_async_jobs", "mas_job_outcomes", "mas_job_outcomes_meta", "mas_events", "unified_schedules"] as const) {
        if (!sel[table]) continue;
        try {
          const result =
            table === "mas_events"
              ? await confirmClearTableWithAudit("mas_events")
              : await confirmClearTable(table as ClearableTable);
          results.push({ id: table, ok: true, detail: `Deleted ${result.deleted} row(s)${typeof result.skippedRunning === "number" ? `; ${result.skippedRunning} running skipped` : ""}.` });
        } catch (err) {
          results.push({ id: table, ok: false, detail: messageOf(err) });
        }
      }
      if (sel.mas_messages) {
        try {
          await purgeSessionMessages();
          results.push({ id: "mas_messages", ok: true, detail: "Session messages purged." });
        } catch (err) {
          results.push({ id: "mas_messages", ok: false, detail: messageOf(err) });
        }
      }
      const kvRows = selectedKvRows();
      if (kvRows.length > 0) {
        try {
          const rows = await confirmKvWipe(kvRows);
          for (const row of rows) {
            results.push({
              id: `kv:${row.row}`,
              ok: !row.error,
              detail: row.error ?? `Deleted ${row.count} key(s)${row.coupled ? " (coupled with memberships)" : ""}.`,
            });
          }
        } catch (err) {
          for (const row of kvRows) {
            results.push({ id: `kv:${row}`, ok: false, detail: messageOf(err) });
          }
        }
      }
    } finally {
      setSelBusy(false);
    }
    setSelResults(results);
    const sessionsWiped = results.some((r) => r.id === "kv:sessions" && r.ok);
    setSelSignedOut(sessionsWiped);
    // After a sessions wipe the admin is signed out, so a dump
    // refresh would only report a failed fetch; skip it then.
    if (!sessionsWiped) {
      await loadDump();
    }
  }, [selected, selectedKvRows, loadDump]);

  const onConfirmSelective = useCallback(() => {
    // Audit history needs its own second confirmation step, with the
    // export offered, before the aggregate wipe runs.
    if (selected.mas_events) {
      setSelModalOpen(false);
      setSelEventsModalOpen(true);
      return;
    }
    void runSelective();
  }, [selected, runSelective]);

  return (
    <div>
      <p className="iaaa-admin-note">
        SQL rows below wipe this instance only. KV rows in the selective wipe are
        platform-wide: SessionStore is one shared store, so wiping memberships, tokens,
        bindings, sessions, or the genesis marker affects all users, not just this instance.
        Tenant-scoped wipe is not offered here: this tab loads under the panel&apos;s
        platform-admin gate, and no tenant-admin-gated wipe surface exists yet.
      </p>

      {actionError && (
        <Notice tone="danger" title="Action failed">
          {actionError}
        </Notice>
      )}

      <Tabs<QueueScheduleSection>
        idBase="schedules-queue"
        ariaLabel="Admin queue sections"
        tabs={queueSections.map((id) => ({
          id,
          label: QUEUE_SCHEDULE_SECTION_LABELS[id],
          ...(id === "queue" && dump ? { badge: dump.count } : {}),
        }))}
        value={section}
        onChange={handleTabChange}
        size="sm"
      />

      <TabPanel idBase="schedules-queue" tabId="queue" active={section === "queue"} retain>
      <h3>Queue dump</h3>
      <p className="iaaa-admin-note">
        Read before any destructive action. Refresh after a wipe to verify the queue is empty.
      </p>
      <Button onClick={() => void loadDump()} disabled={dumpBusy}>
        Refresh dump
      </Button>
      {dumpBusy && !dump ? (
        <Spinner />
      ) : dumpError ? (
        <Notice tone="danger" title="Queue dump failed">
          {dumpError}
        </Notice>
      ) : dump ? (
        <>
          <p className="iaaa-admin-note">
            {dump.count} schedule(s) · {activeCount} active · {pausedCount} paused (paused records are preserved, never deleted, by a queue wipe)
          </p>
          <Table
            columns={dumpColumns}
            rows={dump.schedules}
            rowKey={(row) => row.id}
            empty={<p>No schedules in this instance queue.</p>}
          />
        </>
      ) : null}

      </TabPanel>

      <TabPanel idBase="schedules-queue" tabId="cancel" active={section === "cancel"} retain>
      <h3>Cancel all schedules (queue wipe)</h3>
      <p className="iaaa-admin-note">
        Preview first: the preview lists exactly what would be cancelled and how many paused
        records would be preserved, and cancels nothing. Confirm in the dialog to wipe.
        Paused records are preserved, never deleted. Every wipe writes the
        schedules.cancelled.all audit event.
      </p>
      <Button onClick={() => void onPreviewCancel()} disabled={cancelBusy} variant="danger">
        Preview queue wipe
      </Button>
      {cancelResult && (
        <Notice tone={cancelResult.failed.length > 0 ? "warning" : "success"} title="Queue wipe result">
          Cancelled {cancelResult.cancelled} schedule(s); {cancelResult.pausedPreserved} paused record(s) preserved.
          {cancelResult.failed.length > 0 &&
            ` Failed: ${cancelResult.failed.map((f) => `${f.id} (${f.error})`).join(", ")}.`}
        </Notice>
      )}
      {cancelVerified && activeCount === 0 && (
        <Notice tone="success" title="Verify empty">
          Queue verified empty — {pausedCount} paused record(s) preserved, no active schedules remain.
        </Notice>
      )}
      {cancelVerified && activeCount > 0 && (
        <Notice tone="warning" title="Verify: schedules remain">
          {activeCount} active schedule(s) remain after the wipe — see the refreshed dump above.
        </Notice>
      )}
      <Modal
        open={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        title="Confirm queue wipe"
        footer={
          <>
            <Button onClick={() => setCancelModalOpen(false)} disabled={cancelBusy}>
              Keep schedules
            </Button>
            <Button onClick={() => void onConfirmCancel()} disabled={cancelBusy} variant="danger">
              Cancel schedules
            </Button>
          </>
        }
      >
        {cancelPreview && (
          <p>
            {cancelPreview.wouldCancelCount} schedule(s) would be cancelled:{" "}
            {cancelPreview.wouldCancel.map((row) => `${row.callback} (${row.id})`).join(", ") || "none"}.
            {" "}{cancelPreview.pausedPreserved} paused record(s) preserved.
          </p>
        )}
      </Modal>

      </TabPanel>

      <TabPanel idBase="schedules-queue" tabId="wipe" active={section === "wipe"} retain>
      <h3>Clear a table</h3>
      <p className="iaaa-admin-note">
        Only the allowlisted tables are offered. Running jobs are never deleted (counted as
        skipped). Audit history (mas_events) and the outcome watermark are clearable through
        the selective wipe below (audit history needs a second confirmation and an export);
        messages are cleared via POST /clear, and the framework queue via the cancel-all action above.
      </p>
      {CLEARABLE_TABLES.map((table) => (
        <div key={table}>
          <Button onClick={() => void onPreviewClear(table)} disabled={clearBusy}>
            Preview {table}
          </Button>
        </div>
      ))}
      {clearResult && (
        <Notice tone="success" title="Table cleared">
          Deleted {clearResult.deleted} row(s) from {clearResult.table}
          {typeof clearResult.skippedRunning === "number" ? `; ${clearResult.skippedRunning} running row(s) skipped, never deleted.` : "."}
        </Notice>
      )}
      <Modal
        open={clearModalOpen}
        onClose={() => setClearModalOpen(false)}
        title="Confirm table clear"
        footer={
          <>
            <Button onClick={() => setClearModalOpen(false)} disabled={clearBusy}>
              Keep table
            </Button>
            {clearTable && (
              <Button onClick={() => void onConfirmClear()} disabled={clearBusy} variant="danger">
                Clear {clearTable}
              </Button>
            )}
          </>
        }
      >
        {clearPreview && (
          <p>
            {clearPreview.wouldDelete} row(s) would be deleted from {clearPreview.table} ({clearPreview.scope} scope)
            {clearPreview.breakdown ? ` — ${Object.entries(clearPreview.breakdown).map(([k, v]) => `${k}: ${v}`).join(", ")}` : ""}
            {typeof clearPreview.skippedRunning === "number" ? `. ${clearPreview.skippedRunning} running row(s) would be skipped, never deleted.` : "."}
          </p>
        )}
      </Modal>

      <h3>Selective wipe (all tables, by default)</h3>
      <p className="iaaa-admin-note">
        Every row is checked by default. Uncheck a row to keep it: unchecked rows are skipped
        entirely — no preview call, no delete, no audit for that row. SQL rows wipe this
        instance; KV rows are platform-wide (all users). A failure on one row never hides the
        others. After a full wipe including sessions, sign in again as the owner: the
        platform-admin re-bootstraps from committed config. Note: that sign-in restores
        platform-admin, not tenant-admin primary — tenant-admin restoration is a follow-up
        decision tracked on issue 2489, not part of this wipe.
      </p>
      {SELECTIVE_ROWS.map((row) => (
        <div key={row.id}>
          <Checkbox
            checked={selected[row.id] === true}
            disabled={row.id === "kv:marker" && markerLocked}
            onChange={() => toggleSelective(row.id)}
          />{" "}
          {row.label} — {row.scope}
          {row.note ? ` (${row.note})` : ""}
        </div>
      ))}
      <Button onClick={() => void onPreviewSelective()} disabled={selBusy} variant="danger">
        Preview selective wipe
      </Button>
      {selResults && (
        <Notice tone={selResults.some((r) => !r.ok) ? "warning" : "success"} title="Selective wipe result">
          {selResults.map((r) => `${r.id}: ${r.ok ? r.detail : `failed — ${r.detail}`}`).join("; ")}
        </Notice>
      )}
      {selSignedOut && (
        <Notice tone="warning" title="Sessions wiped — sign in again">
          Sessions were wiped, so this session is signed out. Sign in again as the owner to
          re-bootstrap platform-admin, then provision the service tier and recreate Track 1.
        </Notice>
      )}
      <Modal
        open={selModalOpen}
        onClose={() => setSelModalOpen(false)}
        title="Confirm selective wipe"
        footer={
          <>
            <Button onClick={() => setSelModalOpen(false)} disabled={selBusy}>
              Keep everything
            </Button>
            <Button onClick={() => onConfirmSelective()} disabled={selBusy} variant="danger">
              Wipe selected
            </Button>
          </>
        }
      >
        {selPreview && (
          <div>
            {selPreview.map((row) => (
              <p key={row.id}>
                {row.id}:{" "}
                {row.error
                  ? `preview failed — ${row.error}`
                  : row.count === null
                    ? "no preview count (session purge)"
                    : `${row.count} row(s) would be deleted`}
              </p>
            ))}
            <p>Unchecked rows are skipped entirely.</p>
          </div>
        )}
      </Modal>
      <Modal
        open={selEventsModalOpen}
        onClose={() => setSelEventsModalOpen(false)}
        title="Audit history needs a second confirmation"
        footer={
          <>
            <Button onClick={() => setSelEventsModalOpen(false)} disabled={selBusy}>
              Keep audit history
            </Button>
            <Button onClick={() => void onExportAudit()} disabled={selBusy}>
              Export audit history first
            </Button>
            <Button onClick={() => void runSelective()} disabled={selBusy} variant="danger">
              Wipe including audit history
            </Button>
          </>
        }
      >
        <p>
          Wiping mas_events destroys audit history, irreversibly. Export it first (downloads
          a JSON bundle of this instance&apos;s audit events), or confirm to destroy it
          without an export. The wipe itself is recorded after the clear, so one audit row
          survives as the post-wipe record.
        </p>
        {selExported && <p>{selExported}</p>}
      </Modal>

      </TabPanel>

      <TabPanel idBase="schedules-queue" tabId="recreate" active={section === "recreate"} retain>
      <h3>Recreate Track 1</h3>
      <p className="iaaa-admin-note">
        A separate explicit action, never automatic after a wipe. Review the four schedules
        below; creating them is the recreate half of the wipe decision, and leaving schedules
        off is the alternative — do not press this button unless recreating is intended.
        Creating an account-scoped schedule requires a connected broker account for this
        environment (the tenant's selected broker — E*TRADE or Alpaca); a 409 for one leg is reported per schedule and does not hide the others.
      </p>
      {track1Plan.error ? (
        <Notice tone="danger" title="Track 1 plan failed">
          {track1Plan.error}
        </Notice>
      ) : (
        <>
          <Table
            columns={planColumns}
            rows={track1Plan.items}
            rowKey={(row) => row.label}
          />
          <Button onClick={() => setRecreateModalOpen(true)} disabled={recreateBusy}>
            Recreate Track 1
          </Button>
        </>
      )}
      {recreateResults && (
        <Notice tone={recreateResults.some((r) => !r.ok) ? "warning" : "success"} title="Track 1 recreation result">
          {recreateResults.map((r) => (r.ok ? `${r.label}: created${r.duplicate ? " (already existed)" : ""}${r.scheduleId ? ` (${r.scheduleId})` : ""}` : `${r.label}: failed — ${r.error}`)).join("; ")}
        </Notice>
      )}
      <Modal
        open={recreateModalOpen}
        onClose={() => setRecreateModalOpen(false)}
        title="Confirm Track 1 recreation"
        footer={
          <>
            <Button onClick={() => setRecreateModalOpen(false)} disabled={recreateBusy}>
              Leave schedules off
            </Button>
            <Button onClick={() => void onRecreate()} disabled={recreateBusy} variant="primary">
              Create 4 schedules
            </Button>
          </>
        }
      >
        <p>
          Create the four Track 1 schedules (2 stock crons, 2 hourly options legs) in this
          instance. This is a separate action from the wipe and only runs when you confirm here.
        </p>
      </Modal>
      </TabPanel>
    </div>
  );
}
