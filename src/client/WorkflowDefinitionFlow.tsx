/**
 * Issue #4366 — the UX workflow-definition + scheduling flow.
 *
 * Lists the externalized definition specs (GET /api/job-definitions) with
 * their stages and mode, and schedules one: define the engine job from the
 * spec (POST /api/job-definitions/:id/define), then arm a unified schedule
 * whose callback runs that job (`runPipelineJobSchedule`) through the
 * existing POST /api/schedules/create path — the same alarm machinery every
 * other schedule uses, no second scheduler.
 *
 * A definition is only scheduled after it validates; a failure names the
 * reason and leaves nothing armed. ui/ primitives only, tokens only.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Modal,
  Notice,
  Select,
  Stack,
  TextInput,
} from "./components/ui";
import { JOB_DEFINITION_SCHEDULE_CALLBACK, jobIdForSpec } from "../config/jobDefinitionScheduling";

interface DefinitionSpec {
  id: string;
  name: string;
  version: number;
  description?: string;
  stages: Array<{ kind: string; step: string }>;
  executionMode?: Record<string, string>;
}

const CADENCES: ReadonlyArray<{ id: string; label: string; intervalSeconds: number }> = [
  { id: "15m", label: "Every 15 minutes", intervalSeconds: 15 * 60 },
  { id: "1h", label: "Hourly", intervalSeconds: 60 * 60 },
  { id: "6h", label: "Every 6 hours", intervalSeconds: 6 * 60 * 60 },
  { id: "daily", label: "Daily", intervalSeconds: 24 * 60 * 60 },
];

export function WorkflowDefinitionFlow() {
  const [definitions, setDefinitions] = useState<DefinitionSpec[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<DefinitionSpec | null>(null);
  const [jobId, setJobId] = useState("");
  const [cadence, setCadence] = useState("1h");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<{ jobId: string; intervalSeconds: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/job-definitions", { headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        const payload = (await res.json()) as { definitions?: DefinitionSpec[] };
        if (!cancelled) setDefinitions(Array.isArray(payload.definitions) ? payload.definitions : []);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setDefinitions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const intervalSeconds = useMemo(
    () => CADENCES.find((c) => c.id === cadence)?.intervalSeconds ?? 60 * 60,
    [cadence],
  );

  const open = (spec: DefinitionSpec) => {
    setTarget(spec);
    setJobId(jobIdForSpec(spec.id));
    setCadence("1h");
    setActionError(null);
    setScheduled(null);
  };

  const schedule = async () => {
    if (!target) return;
    setBusy(true);
    setActionError(null);
    try {
      const defined = await fetch(
        `/api/job-definitions/${encodeURIComponent(target.id)}/define`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ jobId }),
        },
      );
      const definedBody = (await defined.json().catch(() => ({}))) as { error?: string };
      if (!defined.ok) {
        throw new Error(definedBody.error || `Defining the job failed (${defined.status}).`);
      }
      const armed = await fetch("/api/schedules/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          scheduleType: "interval",
          intervalSeconds,
          callback: JOB_DEFINITION_SCHEDULE_CALLBACK,
          payload: { jobId },
        }),
      });
      const armedBody = (await armed.json().catch(() => ({}))) as { error?: string };
      if (!armed.ok) {
        throw new Error(armedBody.error || `Arming the schedule failed (${armed.status}).`);
      }
      setScheduled({ jobId, intervalSeconds });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md">
      <Stack gap="3">
        <strong>Workflow definitions</strong>
        <span>Define a job from its spec and schedule it</span>
        <Notice tone="info" density="compact">
          Every definition is validated before it is defined: a spec with an unknown stage, a
          missing step or an invalid mode refuses by name, and nothing is scheduled.
        </Notice>
        {loadError && (
          <Notice tone="warning" density="compact" title="Definitions unavailable">
            {loadError}
          </Notice>
        )}
        {(definitions ?? []).map((spec) => (
          <Card key={spec.id} padding="sm">
            <Stack gap="2">
              <strong>{spec.name}</strong>
              <span>{`${spec.id} · v${spec.version}`}</span>
              <div>
                {spec.stages.map((stage) => (
                  <Badge key={`${spec.id}-${stage.kind}`} tone="neutral" size="sm">
                    {stage.kind}
                  </Badge>
                ))}
              </div>
              {spec.executionMode && (
                <span>
                  {Object.values(spec.executionMode).join(" · ")}
                </span>
              )}
              {spec.description && <span>{spec.description}</span>}
              <Button variant="secondary" size="sm" onClick={() => open(spec)}>
                Schedule this definition
              </Button>
            </Stack>
          </Card>
        ))}
        {definitions !== null && definitions.length === 0 && !loadError && (
          <Notice tone="warning" density="compact">
            No workflow definitions are configured in this deployment.
          </Notice>
        )}
      </Stack>

      {target && (
        <Modal open onClose={() => setTarget(null)} title={`Schedule ${target.name}`}>
          <Stack gap="3">
            <div>
              <span>Job id</span>
              <TextInput
                aria-label="Job id"
                value={jobId}
                onChange={(event) => setJobId(event.target.value)}
              />
            </div>
            <div>
              <span>Cadence</span>
              <Select aria-label="Cadence" value={cadence} onChange={(event) => setCadence(event.target.value)}>
                {CADENCES.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            {actionError && (
              <Notice tone="danger" density="compact">
                {actionError}
              </Notice>
            )}
            {scheduled && (
              <Notice tone="success" density="compact" title="Scheduled">
                Job <code>{scheduled.jobId}</code> is armed every{" "}
                {Math.round(scheduled.intervalSeconds / 60)} minutes. Its runs appear in Workflow
                Runs with per-stage status and times.
              </Notice>
            )}
            <Button variant="primary" onClick={() => void schedule()} loading={busy} disabled={busy || !jobId.trim()}>
              Define &amp; schedule
            </Button>
          </Stack>
        </Modal>
      )}
    </Card>
  );
}
