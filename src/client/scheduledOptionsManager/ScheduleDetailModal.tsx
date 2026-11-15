import React from "react";
import { Badge, Button, Modal, Notice, Spinner } from "../components/ui";
import type { StrategyProfile } from "../../trading";
import type { ScheduledTaskItem } from "./types";
import { buildScheduleDetail, type PresetRef } from "./scheduleDetail";

export interface ScheduleDetailModalProps {
  item: ScheduledTaskItem | null;
  /** The server record from GET /api/schedules/:id, or null while unread. */
  detail: any | null;
  loading: boolean;
  error: string | null;
  profiles: StrategyProfile[];
  activeEnv: string;
  userLogin: string;
  /** Issue #3655 S4b: the caller's stocks presets, for resolving a
   *  stock schedule's presetId to its name (and its current
   *  criteria). Absent, the Preset field falls back to the raw id. */
  presets?: PresetRef[];
  onRetry: () => void;
  onClose: () => void;
}

/**
 * The one Details dialog (issue #2329). Everything the old schedule
 * card printed inline — plus the server's run definition and the raw
 * payload — rendered from a single canonical model, so the labels and
 * their order are identical for every schedule kind
 * (./scheduleDetail.ts).
 */
export function ScheduleDetailModal({
  item,
  detail,
  loading,
  error,
  profiles,
  activeEnv,
  userLogin,
  presets,
  onRetry,
  onClose,
}: ScheduleDetailModalProps) {
  if (!item) return null;
  const model = buildScheduleDetail(item, { profiles, activeEnv, userLogin, detail, presets });

  return (
    <Modal
      open
      onClose={onClose}
      size="none"
      panelClassName="sched-detail-modal"
      ariaLabel={`Details for ${model.title}`}
    >
      <header className="sched-dialog-header">
        <div className="sched-dialog-heading">
          <h2 className="sched-dialog-title">{model.title}</h2>
          <div className="schedule-row-badges">
            <Badge
              tone={
                model.kind === "options"
                  ? "accent"
                  : model.kind === "stock"
                    ? "success"
                    : model.kind === "discovery"
                      ? "purple"
                      : "neutral"
              }
              size="xs"
            >
              {model.kindLabel}
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
          </div>
          <code className="sched-dialog-id">{item.id}</code>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </header>

      {model.note && <p className="sched-detail-note">{model.note}</p>}

      {loading && (
        <p className="sched-detail-status">
          <Spinner size="sm" label="Loading run definition" /> Loading run definition…
        </p>
      )}
      {error && (
        <Notice tone="danger" density="compact" title="Schedule details unavailable">
          {error}{" "}
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </Notice>
      )}

      {model.sections.map((section) => (
        <section key={section.id} className="sched-detail-section" aria-label={section.title}>
          <h3 className="sched-detail-section-title">{section.title}</h3>
          <dl className="sched-detail-list">
            {section.fields.map((field) => (
              <div className="sched-detail-row" key={`${section.id}-${field.label}`}>
                <dt className="sched-detail-label">{field.label}</dt>
                <dd className={field.mono ? "sched-detail-value is-mono" : "sched-detail-value"}>
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}

      <details className="sched-detail-raw">
        <summary>Raw payload</summary>
        <pre className="sched-detail-payload">{JSON.stringify(model.payload ?? null, null, 2)}</pre>
      </details>
    </Modal>
  );
}
