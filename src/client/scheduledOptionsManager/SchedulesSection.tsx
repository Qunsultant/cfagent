import React from "react";
import { Button, EmptyState, Table } from "../components/ui";
import type { ScheduledTaskItem } from "./types";
import {
  buildScheduleRowColumns,
  scheduleRowClassName,
  scheduleRowLabel,
  type ScheduleRowContext,
  type ScheduleRowHandlers,
} from "./ScheduleCard";

export interface SchedulesSectionProps extends ScheduleRowContext, ScheduleRowHandlers {
  schedules: ScheduledTaskItem[];
  loading: boolean;
  openCreateModal: () => void;
}

/**
 * Active durable schedules as one table (issue #2329): one row per
 * schedule, every action on that row. The section owns no data — the
 * manager fetches the list, and the Details/Edit/Cancel dialogs live
 * beside this table so a row stays a row.
 */
export function SchedulesSection({
  schedules,
  loading,
  openCreateModal,
  profiles,
  activeEnv,
  userLogin,
  presets,
  busyKey,
  onShowDetails,
  onEdit,
  onTrigger,
  onTogglePause,
  onCancel,
}: SchedulesSectionProps) {
  const columns = buildScheduleRowColumns(
    { profiles, activeEnv, userLogin, presets },
    { busyKey, onShowDetails, onEdit, onTrigger, onTogglePause, onCancel }
  );

  return (
    <section className="sched-section-card">
      <header className="sched-section-header">
        <h4>
          <span aria-hidden="true">⏱️</span> Active Durable Schedules
          <span className="sched-count-pill">{schedules.length} Active</span>
        </h4>
        {loading && schedules.length > 0 && (
          <span className="schedule-row-muted">Refreshing…</span>
        )}
      </header>

      {loading && schedules.length === 0 ? (
        <p className="sched-table-status">Refreshing schedules…</p>
      ) : (
        <Table
          columns={columns}
          rows={schedules}
          rowKey={(item) => item.id}
          rowClassName={scheduleRowClassName}
          rowTitle={scheduleRowLabel}
          caption="Active durable schedules, one row per schedule"
          containerClassName="sched-table-scroll"
          empty={
            <EmptyState
              icon="📅"
              title="No active schedules"
              description="Create a stock screen, options analysis, or saved-view discovery schedule to see it here; legacy app-created jobs are not recreated automatically."
              action={
                <Button type="button" variant="accent" onClick={openCreateModal}>
                  + Create First Schedule
                </Button>
              }
            />
          }
        />
      )}
    </section>
  );
}
