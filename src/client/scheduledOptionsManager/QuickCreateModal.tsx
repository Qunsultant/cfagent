/**
 * Issue #5895 — the quick-create modal.
 *
 * Lists the quick-create plan (the catalogue's form jobs with their
 * defaults) with one tick box per job — all creatable jobs ticked by
 * default — and creates the ticked jobs in one action. A blocked job
 * (strategy discovery: it needs a saved view) renders unticked and
 * disabled, with its reason. After the action, each job reports its
 * own outcome in the dialog; the created rows are ordinary rows in
 * the one list, editable with the existing Edit control.
 *
 * UX conformance: ui/ primitives only (Modal, Button, CardHeader,
 * Checkbox, Notice, Stack) and the existing sched-modal-* classes
 * the create form already uses — no raw controls, no inline styles,
 * no new styling.
 */
import React, { useState } from "react";
import { Button, CardHeader, Checkbox, Modal, Notice, Stack } from "../components/ui";
import type {
  QuickCreateJob,
  QuickCreateResultItem,
} from "./quickCreate";

export interface QuickCreateModalProps {
  jobs: QuickCreateJob[];
  submitting: boolean;
  results: QuickCreateResultItem[] | null;
  onClose: () => void;
  onSubmit: (selected: QuickCreateJob[]) => Promise<void>;
}

export function QuickCreateModal({
  jobs,
  submitting,
  results,
  onClose,
  onSubmit,
}: QuickCreateModalProps) {
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(jobs.map((job) => [job.formJob, job.selected])),
  );
  const selectedJobs = jobs.filter((job) => selected[job.formJob]);
  const done = results !== null;

  const toggle = (job: QuickCreateJob) => {
    if (job.blockedReason) return;
    setSelected((prev) => ({ ...prev, [job.formJob]: !prev[job.formJob] }));
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="none"
      panelClassName="sched-modal-card sched-quick-create-modal"
      ariaLabel="Quick create schedules"
    >
      <header className="sched-modal-header">
        <div>
          <CardHeader title="Quick create schedules" />
          <p>
            Create schedules for each job with its catalogue defaults, in one action. Untick
            any job to skip it. Created rows can then be edited like any other row.
          </p>
        </div>
        <Button type="button" variant="secondary" className="btn-modal-close" onClick={onClose}>
          ✕
        </Button>
      </header>

      <Stack gap="3">
        {jobs.map((job) => (
          <Checkbox
            key={job.formJob}
            label={
              <>
                <strong>{job.entry.label}</strong>{" "}
                <span className="hint">
                  {job.blockedReason ??
                    `Cron ${job.defaultCron} · Universe ${job.defaultUniverse} · Slack ${job.defaultSlackChannel}`}
                </span>
              </>
            }
            checked={selected[job.formJob] === true}
            disabled={job.blockedReason !== undefined || submitting || done}
            onChange={() => toggle(job)}
          />
        ))}
      </Stack>

      {done && (
        <Stack gap="2">
          <Notice tone="info" variant="box" density="compact">
            {results.filter((r) => r.ok).length} of {results.length} created
            {results.some((r) => !r.ok) ? " — the failures below were not created." : "."}
          </Notice>
          <ul>
            {results.map((result) => (
              <li key={result.label}>
                {result.ok
                  ? `✓ ${result.label} — ${
                      result.duplicate ? "Already exists" : "Created"
                    }${result.scheduleId ? ` (${result.scheduleId})` : ""}`
                  : `✗ ${result.label} — ${result.error ?? "Create failed"}`}
              </li>
            ))}
          </ul>
        </Stack>
      )}

      <footer className="sched-modal-footer">
        <Button type="button" onClick={onClose} disabled={submitting}>
          {done ? "Close" : "Cancel"}
        </Button>
        {!done && (
          <Button
            type="button"
            variant="primary"
            disabled={submitting || selectedJobs.length === 0}
            loading={submitting}
            onClick={() => void onSubmit(selectedJobs)}
          >
            {`Create selected (${selectedJobs.length})`}
          </Button>
        )}
      </footer>
    </Modal>
  );
}
