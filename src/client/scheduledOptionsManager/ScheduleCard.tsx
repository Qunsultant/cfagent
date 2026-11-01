import React from "react";
import { Badge, Button, type TableColumn } from "../components/ui";
import type { StrategyProfile } from "../../trading";
import type { ScheduledTaskItem } from "./types";
import { cadenceText, formatNextRun, payloadOf } from "./format";
import { buildScheduleDetail, scheduleKind } from "./scheduleDetail";

/**
 * One schedule = one table row (issue #2329).
 *
 * The card this module used to render stacked badges, title, note,
 * payload rows and a six-button footer — six buttons because cadence
 * had two editors. The row keeps what a reader scans for (name, full
 * id, cadence, scope) and moves everything else into the Details
 * dialog; the actions cell carries one control per action, including
 * the single Edit control (the form already edits cadence).
 *
 * The module path and exported component name are unchanged so the
 * section, barrel and primitive-coverage pins keep resolving; what
 * changed is the render (a row, not a card) and the prop contract.
 */

export interface ScheduleRowHandlers {
  /** The id of the schedule whose trigger is in flight, or null. */
  busyKey: string | null;
  onShowDetails: (item: ScheduledTaskItem) => void;
  onEdit: (item: ScheduledTaskItem) => void;
  onTrigger: (item: ScheduledTaskItem) => void | Promise<void>;
  onTogglePause: (item: ScheduledTaskItem) => void | Promise<void>;
  onCancel: (item: ScheduledTaskItem) => void;
}

export interface ScheduleRowContext {
  profiles: StrategyProfile[];
  activeEnv: string;
  userLogin: string;
}

const KIND_TONE = { options: "accent", stock: "success", discovery: "purple", system: "neutral" } as const;

function kindLabel(item: ScheduledTaskItem): string {
  const kind = scheduleKind(item);
  if (kind === "options") return "Options";
  if (kind === "stock") return "Stock";
  if (kind === "discovery") return "Discovery";
  return "System";
}

/** Row class: keeps the historical hook and carries the kind tone. */
export function scheduleRowClassName(item: ScheduledTaskItem): string {
  return `schedule-item-card is-${scheduleKind(item)}${item.paused ? " is-paused" : ""}`;
}

/** Whole-row tooltip: what the row is, without duplicating the cells. */
export function scheduleRowLabel(item: ScheduledTaskItem): string {
  return `${item.id} · ${item.callback} · ${cadenceText(item)}${item.paused ? " · paused" : ""}`;
}

export function buildScheduleRowColumns(
  ctx: ScheduleRowContext,
  handlers: ScheduleRowHandlers
): TableColumn<ScheduledTaskItem>[] {
  return [
    {
      key: "job",
      header: "Schedule",
      render: (item) => {
        const model = buildScheduleDetail(item, ctx);
        return (
          <div className="schedule-row-job">
            <span className="schedule-row-name">{model.title}</span>
            <span className="schedule-row-badges">
              <Badge tone={KIND_TONE[model.kind]} size="xs">
                {kindLabel(item)}
              </Badge>
              {model.modelLabel && (
                <Badge tone="info" size="xs">
                  {model.modelLabel}
                </Badge>
              )}
              <Badge tone={item.paused ? "warning" : "success"} size="xs" dot>
                {model.statusLabel}
              </Badge>
              <Badge tone="neutral" size="xs" uppercase>
                {item.type}
              </Badge>
            </span>
          </div>
        );
      },
    },
    {
      key: "id",
      header: "Schedule ID",
      render: (item) => (
        <code className="schedule-row-id" title={item.id}>
          {item.id}
        </code>
      ),
    },
    {
      key: "cadence",
      header: "Cadence",
      render: (item) => (
        <div className="schedule-row-stack">
          <span className="schedule-row-value">{cadenceText(item)}</span>
          <span className="schedule-row-muted">
            Next run: {item.paused ? "paused" : formatNextRun(item)}
          </span>
        </div>
      ),
    },
    {
      key: "scope",
      header: "Scope",
      render: (item) => {
        const model = buildScheduleDetail(item, ctx);
        const payload = payloadOf(item);
        const owner =
          typeof payload.userLogin === "string" && payload.userLogin ? payload.userLogin : ctx.userLogin;
        const environment =
          (typeof payload.environment === "string" && payload.environment) ||
          (typeof payload.env === "string" && payload.env) ||
          ctx.activeEnv;
        return (
          <div className="schedule-row-stack">
            <span className="schedule-row-value">{model.scope}</span>
            <span className="schedule-row-muted">
              {owner} · {environment}
            </span>
          </div>
        );
      },
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      headerClassName: "schedule-row-actions-head",
      render: (item) => {
        const model = buildScheduleDetail(item, ctx);
        const name = `${model.title} (${item.id})`;
        return (
          <div className="schedule-row-actions">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => handlers.onShowDetails(item)}
              title="Open every stored detail for this schedule"
              aria-label={`Details for ${name}`}
            >
              Details
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => handlers.onEdit(item)}
              title="Edit this schedule in the full form (cadence included)"
              aria-label={`Edit ${name}`}
            >
              Edit
            </Button>
            <Button
              type="button"
              variant="accent"
              tone="subtle"
              size="sm"
              onClick={() => handlers.onTrigger(item)}
              disabled={handlers.busyKey !== null || !!item.paused}
              title={item.paused ? "Resume before triggering" : `Run ${model.title} now`}
              aria-label={`Trigger now: ${name}`}
             loading={handlers.busyKey === item.id}>
              {"Trigger Now"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => handlers.onTogglePause(item)}
              title={item.paused ? "Resume this schedule" : "Pause this schedule"}
              aria-label={`${item.paused ? "Resume" : "Pause"} ${name}`}
            >
              {item.paused ? "Resume" : "Pause"}
            </Button>
            <Button
              type="button"
              variant="danger"
              tone="subtle"
              size="sm"
              onClick={() => handlers.onCancel(item)}
              title="Cancel this durable schedule"
              aria-label={`Cancel ${name}`}
            >
              Cancel
            </Button>
          </div>
        );
      },
    },
  ];
}
